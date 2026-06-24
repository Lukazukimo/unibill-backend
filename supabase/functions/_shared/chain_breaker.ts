/**
 * chain_breaker.ts — the chain-LEVEL circuit breaker, shared by the OCR and AI
 * provider chains (T-415).
 *
 * Ref:  T-415, spec §7.6 (chain breaker state machine: Trigger A/B, backoff)
 * Date: 2026-06-24
 *
 * Distinct from the per-provider breaker (circuit.ts): this one gates the WHOLE
 * chain attempt (all providers) so a systemic failure (every provider down,
 * deprecated models, broken prompts) auto-disables the chain and stops burning
 * quota. It REUSES the circuit_breakers table + RPCs (spec §7.6 / the
 * withCircuitBreaker('ai_chain', …) pattern) with a chain resource_type
 * ('ai_chain' | 'ocr_chain') — no new table.
 *
 *   - Trigger A (sustained failure): minSamples consecutive chain failures →
 *     open (the SQL keeps the count; a chain success resets it). NOTE: this
 *     approximates the spec's "ratio over a window" — exact only at the MVP
 *     default failure_ratio=1.0 (any success resets, so consecutive == 100%);
 *     the windowed ratio + the 6h absolute backoff cap are a documented follow-up.
 *   - Trigger B (explicit quota): a quota_exceeded failure (classifyOcrError
 *     chainImmediate) opens the chain immediately (threshold 1) — cost protection.
 *   - Recovery: half-open probe; probeSuccessRequired successes close it;
 *     exponential backoff on re-opens (handled by circuit_record_failure).
 *
 * Orchestrated via INJECTED primitives (begin / recordSuccess / recordFailure)
 * so it is unit-testable without SQL RPCs; defaults wire to client.rpc.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { ChainOpenError } from './errors.ts';
import { classifyOcrError } from './ocr/classify_error.ts';

export type ChainResourceType = 'ai_chain' | 'ocr_chain';
export type CircuitDecision = 'open' | 'closed' | 'half_open';

export interface ChainBreakerConfig {
  minSamples: number; // *.chain.min_samples — consecutive failures → open
  cooldownSec: number; // *.chain.cooldown_sec — base cool-down (backoff grows it)
  probeSuccessRequired: number; // *.chain.probe_success_required — probes to close
}

export const DEFAULT_CHAIN_BREAKER: ChainBreakerConfig = {
  minSamples: 6,
  cooldownSec: 900,
  probeSuccessRequired: 2,
};

export interface ChainBreakerDeps {
  client?: SupabaseClient;
  config?: Partial<ChainBreakerConfig>;
  /** Test overrides (default wire to client.rpc circuit_* functions). */
  begin?: (type: ChainResourceType, key: string) => Promise<CircuitDecision>;
  recordSuccess?: (type: ChainResourceType, key: string) => Promise<void>;
  recordFailure?: (
    type: ChainResourceType,
    key: string,
    opts: { threshold: number; cooldownSec: number; reason: string },
  ) => Promise<void>;
}

function buildServiceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Run `fn` (one whole chain attempt) behind the chain-level breaker. Throws
 * ChainOpenError when the chain is open (fn is NOT run); on a quota failure the
 * chain opens immediately (Trigger B).
 */
export async function withChainBreaker<T>(
  chainType: ChainResourceType,
  chainKey: string,
  /** Receives the live chain state ('closed' | 'half_open') for ai_calls logging. */
  fn: (chainState: CircuitDecision) => Promise<T>,
  deps?: ChainBreakerDeps,
): Promise<T> {
  const cfg = { ...DEFAULT_CHAIN_BREAKER, ...deps?.config };
  const client = deps?.client;

  const begin = deps?.begin ??
    (async (type: ChainResourceType, key: string) => {
      const { data, error } = await (client ?? buildServiceClient()).rpc('circuit_begin', {
        p_resource_type: type,
        p_resource_key: key,
      });
      if (error) throw new Error(`withChainBreaker: begin failed: ${error.message}`);
      return data as CircuitDecision;
    });

  const recordSuccess = deps?.recordSuccess ??
    (async (type: ChainResourceType, key: string) => {
      await (client ?? buildServiceClient()).rpc('circuit_record_success', {
        p_resource_type: type,
        p_resource_key: key,
        p_close_after: cfg.probeSuccessRequired,
      });
    });

  const recordFailure = deps?.recordFailure ??
    (async (
      type: ChainResourceType,
      key: string,
      opts: { threshold: number; cooldownSec: number; reason: string },
    ) => {
      await (client ?? buildServiceClient()).rpc('circuit_record_failure', {
        p_resource_type: type,
        p_resource_key: key,
        p_threshold: opts.threshold,
        p_cooldown_seconds: opts.cooldownSec,
        p_reason: opts.reason,
      });
    });

  const decision = await begin(chainType, chainKey);
  if (decision === 'open') {
    throw new ChainOpenError(chainKey);
  }

  try {
    const result = await fn(decision);
    await recordSuccess(chainType, chainKey);
    return result;
  } catch (err) {
    const cls = classifyOcrError(err);
    // Trigger B: a quota failure opens the chain on the first occurrence.
    const threshold = cls.chainImmediate ? 1 : cfg.minSamples;
    await recordFailure(chainType, chainKey, {
      threshold,
      cooldownSec: cfg.cooldownSec,
      reason: cls.status,
    });
    throw err;
  }
}
