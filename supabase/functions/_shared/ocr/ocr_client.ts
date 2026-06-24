/**
 * ocr/ocr_client.ts — the OCR provider chain (T-409).
 *
 * Ref:  T-409, spec §7.3 (OCR chain) + §7.5 (per-provider breaker, rate limit)
 * Date: 2026-06-24
 *
 * Tries the providers in chain order; each attempt is gated by a daily rate
 * limit (OUTER — our own throttle, must NOT trip the breaker) and a per-provider
 * circuit breaker (INNER — only the real provider HTTP call counts), and is
 * logged to ai_calls (purpose='ocr', one row per attempt). On a failure the next
 * provider is tried; if all fail, NoProviderAvailableError is thrown.
 *
 * Orchestrated via INJECTED primitives (withRateLimit / withCircuitBreaker /
 * logAiCall / now) so it is fully unit-testable without faking SQL RPCs; the
 * defaults wire to the real _shared/rateLimit.ts, circuit.ts and ai_calls.ts.
 *
 * NOTE (MVP): the per-provider breaker (circuit.ts) trips on ANY provider-side
 * throw. classifyOcrError's tripsProvider/tripsChain flags are preserved in the
 * logged status and will gate the chain-level breaker in T-415; the finer
 * "invalid_response does not trip the provider" refinement lands with it.
 */

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { withCircuitBreaker, type WithCircuitBreakerDeps } from '../circuit.ts';
import { withRateLimit } from '../rateLimit.ts';
import { type AiCallRow, insertAiCall } from '../ai_calls.ts';
import { wrapRedaction } from '../redact.ts';
import { NoProviderAvailableError } from '../errors.ts';
import { classifyOcrError } from './classify_error.ts';
import type { CallContext, OcrProvider, OcrResult } from './types.ts';

/** A provider plus its daily call budget (from extraction.<provider>.daily_limit). */
export interface OcrChainEntry {
  provider: OcrProvider;
  dailyLimit: number;
}

export interface OcrClientDeps {
  /** Providers in chain order (e.g. [ocr_space, google_vision]). */
  chain: OcrChainEntry[];
  /** Service-role client for the real breaker/rate-limit/ai_calls primitives. */
  client?: SupabaseClient;
  /** Per-provider breaker tuning (passed to withCircuitBreaker). */
  breaker?: Omit<WithCircuitBreakerDeps, 'client'>;
  /** Override the daily rate-limit gate (default: withRateLimit '1day'). */
  withRateLimitFn?: <T>(name: string, limit: number, fn: () => Promise<T>) => Promise<T>;
  /** Override the per-provider breaker (default: withCircuitBreaker 'ocr_provider'). */
  withBreakerFn?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  /** Override the ai_calls writer (default: insertAiCall). */
  logAiCall?: (row: AiCallRow) => Promise<void>;
  /** Clock for latency (default Date.now). */
  now?: () => number;
}

export interface OcrClient {
  /** OCR a single page through the chain. Returns the first success. */
  ocrPage(pdfPage: Uint8Array, ctx: CallContext): Promise<OcrResult>;
  /** Provider names in chain order. */
  readonly chain: string[];
}

export function createOcrClient(deps: OcrClientDeps): OcrClient {
  const client = deps.client;
  const now = deps.now ?? (() => Date.now());

  const withRate = deps.withRateLimitFn ??
    (<T>(name: string, limit: number, fn: () => Promise<T>) =>
      withRateLimit('ocr_provider_daily', name, { window: '1day', limit }, fn, { client }));

  const withBreaker = deps.withBreakerFn ??
    (<T>(name: string, fn: () => Promise<T>) =>
      withCircuitBreaker('ocr_provider', name, fn, { client, ...deps.breaker }));

  const logAiCall = deps.logAiCall ?? ((row: AiCallRow) => insertAiCall(row, { client }));

  return {
    chain: deps.chain.map((e) => e.provider.name),

    async ocrPage(pdfPage: Uint8Array, ctx: CallContext): Promise<OcrResult> {
      let lastErr: Error | null = null;

      for (const { provider, dailyLimit } of deps.chain) {
        const started = now();
        try {
          // Rate limit OUTER (our throttle skips the provider before the breaker
          // is ever touched); breaker INNER (only the real HTTP call counts).
          const result = await withRate(
            provider.name,
            dailyLimit,
            () => withBreaker(provider.name, () => provider.ocrPdfPage(pdfPage, ctx)),
          );
          await logAiCall({
            provider: provider.name,
            purpose: 'ocr',
            invoice_id: ctx.invoice_id,
            household_id: ctx.household_id,
            correlation_id: ctx.correlation_id,
            pages_processed: 1,
            latency_ms: now() - started,
            status: 'success',
          });
          return result;
        } catch (err) {
          const cls = classifyOcrError(err);
          await logAiCall({
            provider: provider.name,
            purpose: 'ocr',
            invoice_id: ctx.invoice_id,
            household_id: ctx.household_id,
            correlation_id: ctx.correlation_id,
            pages_processed: 1,
            latency_ms: now() - started,
            status: cls.status,
            error_summary: wrapRedaction(err),
          });
          lastErr = err instanceof Error ? err : new Error(String(err));
        }
      }

      throw new NoProviderAvailableError(deps.chain.map((e) => e.provider.name), lastErr);
    },
  };
}
