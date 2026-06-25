/**
 * tier.ts — the capacity eviction tier-escalation engine (T-603, spec §10.3).
 *
 * Runs eviction tiers in order, RE-MEASURING the resource between each, and
 * stops as soon as usage drops to target_pct (converged) or the per-run runtime
 * cap is hit (resumes next tick). If tiers 1..N-1 don't converge, the terminal
 * tier (default 5) fires onCritical (emit capacity.critical + pause ingestion).
 *
 * §10.3 ladder (the concrete per-tier eviction is the INJECTED `runTier` — db:
 * Tier1 trim logs at adaptive_floor, Tier2 floor/2, Tier3 floor/4, Tier4 evict
 * old invoices). PURE of I/O via injected measurePct / runTier / onCritical /
 * now → unit-tested with synthetic usage curves.
 */

export type TierStep = { tier: number; action: string; detail: Record<string, unknown> };

export interface EscalateDeps {
  /** Re-measures the resource's usage percent (0..100). */
  measurePct: () => Promise<number>;
  /** Executes tier `n`'s eviction; returns what it did (appended to steps). */
  runTier: (tier: number) => Promise<{ action: string; detail: Record<string, unknown> }>;
  /** Terminal tier: emit capacity.critical + pause ingestion. */
  onCritical: () => Promise<void>;
  targetPct: number; // capacity.target_pct (60)
  maxRuntimeMs: number; // capacity.eviction_max_runtime_ms (45000)
  now: () => number;
  /** Terminal tier number (default 5). Tiers 1..maxTier-1 run runTier. */
  maxTier?: number;
}

export type EscalateReason = 'already_under' | 'converged' | 'runtime' | 'exhausted';

export interface EscalateResult {
  steps: TierStep[];
  finalPct: number;
  converged: boolean;
  reachedTier: number;
  reason: EscalateReason;
}

export async function escalate(deps: EscalateDeps): Promise<EscalateResult> {
  const maxTier = deps.maxTier ?? 5;
  const start = deps.now();
  const steps: TierStep[] = [];

  let pct = await deps.measurePct();
  if (pct <= deps.targetPct) {
    return { steps, finalPct: pct, converged: true, reachedTier: 0, reason: 'already_under' };
  }

  for (let tier = 1; tier < maxTier; tier++) {
    if (deps.now() - start > deps.maxRuntimeMs) {
      return { steps, finalPct: pct, converged: false, reachedTier: tier - 1, reason: 'runtime' };
    }
    const r = await deps.runTier(tier);
    steps.push({ tier, action: r.action, detail: r.detail });
    pct = await deps.measurePct();
    if (pct <= deps.targetPct) {
      return { steps, finalPct: pct, converged: true, reachedTier: tier, reason: 'converged' };
    }
  }

  // Tiers 1..maxTier-1 exhausted and still over target → terminal tier.
  await deps.onCritical();
  steps.push({ tier: maxTier, action: 'critical', detail: { pct } });
  return { steps, finalPct: pct, converged: false, reachedTier: maxTier, reason: 'exhausted' };
}
