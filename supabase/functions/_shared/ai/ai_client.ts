/**
 * ai/ai_client.ts — the AI extraction provider chain (T-416).
 *
 * Ref:  T-416, spec §7.5 (AI chain) + §7.6 (chain breaker)
 * Date: 2026-06-24
 *
 * Mirrors the OcrClient (T-409): tries the providers in chain order with a daily
 * rate limit (OUTER) + per-provider circuit breaker (INNER), logging each attempt
 * to ai_calls (purpose='extraction', with chain_state_at_call). The WHOLE chain
 * attempt is wrapped by the chain-level breaker (T-415) keyed 'ai_chain' — so a
 * systemic failure auto-disables the chain (and a quota failure opens it
 * immediately). All collaborators injected → unit-testable with no SQL RPCs.
 */

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { withCircuitBreaker, type WithCircuitBreakerDeps } from '../circuit.ts';
import { withRateLimit } from '../rateLimit.ts';
import { type AiCallRow, insertAiCall } from '../ai_calls.ts';
import { wrapRedaction } from '../redact.ts';
import { NoProviderAvailableError } from '../errors.ts';
import { classifyOcrError } from '../ocr/classify_error.ts';
import { type ChainBreakerDeps, type CircuitDecision, withChainBreaker } from '../chain_breaker.ts';
import type { AiCallContext, AiExtractResult, AiProvider } from './types.ts';

export interface AiChainEntry {
  provider: AiProvider;
  dailyLimit: number;
}

export interface AiClientDeps {
  /** Providers in chain order (e.g. [gemini, groq]). */
  chain: AiChainEntry[];
  /** Chain-breaker resource key (default 'extraction_default'). */
  chainKey?: string;
  client?: SupabaseClient;
  breaker?: Omit<WithCircuitBreakerDeps, 'client'>;
  chainBreaker?: ChainBreakerDeps;
  withRateLimitFn?: <T>(name: string, limit: number, fn: () => Promise<T>) => Promise<T>;
  withBreakerFn?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  withChainBreakerFn?: <T>(fn: (chainState: CircuitDecision) => Promise<T>) => Promise<T>;
  logAiCall?: (row: AiCallRow) => Promise<void>;
  now?: () => number;
}

export interface AiClient {
  extractStructured(text: string, ctx: AiCallContext): Promise<AiExtractResult>;
  readonly chain: string[];
}

export function createAiClient(deps: AiClientDeps): AiClient {
  const client = deps.client;
  const now = deps.now ?? (() => Date.now());
  const chainKey = deps.chainKey ?? 'extraction_default';

  const withRate = deps.withRateLimitFn ??
    (<T>(name: string, limit: number, fn: () => Promise<T>) =>
      withRateLimit('ai_provider_daily', name, { window: '1day', limit }, fn, { client }));

  const withBreaker = deps.withBreakerFn ??
    (<T>(name: string, fn: () => Promise<T>) =>
      withCircuitBreaker('ai_provider', name, fn, { client, ...deps.breaker }));

  const withChain = deps.withChainBreakerFn ??
    (<T>(fn: (chainState: CircuitDecision) => Promise<T>) =>
      withChainBreaker('ai_chain', chainKey, fn, { client, ...deps.chainBreaker }));

  const logAiCall = deps.logAiCall ?? ((row: AiCallRow) => insertAiCall(row, { client }));

  return {
    chain: deps.chain.map((e) => e.provider.name),

    extractStructured(text: string, ctx: AiCallContext): Promise<AiExtractResult> {
      return withChain(async (chainState) => {
        let lastErr: Error | null = null;
        for (const { provider, dailyLimit } of deps.chain) {
          const started = now();
          try {
            const result = await withRate(
              provider.name,
              dailyLimit,
              () => withBreaker(provider.name, () => provider.extractStructured(text, ctx)),
            );
            await logAiCall({
              provider: provider.name,
              model: provider.model,
              purpose: 'extraction',
              invoice_id: ctx.invoice_id,
              household_id: ctx.household_id,
              correlation_id: ctx.correlation_id,
              latency_ms: now() - started,
              status: 'success',
              chain_state_at_call: chainState,
            });
            return result;
          } catch (err) {
            const cls = classifyOcrError(err);
            await logAiCall({
              provider: provider.name,
              model: provider.model,
              purpose: 'extraction',
              invoice_id: ctx.invoice_id,
              household_id: ctx.household_id,
              correlation_id: ctx.correlation_id,
              latency_ms: now() - started,
              status: cls.status,
              error_summary: wrapRedaction(err),
              chain_state_at_call: chainState,
            });
            lastErr = err instanceof Error ? err : new Error(String(err));
          }
        }
        throw new NoProviderAvailableError(deps.chain.map((e) => e.provider.name), lastErr);
      });
    },
  };
}
