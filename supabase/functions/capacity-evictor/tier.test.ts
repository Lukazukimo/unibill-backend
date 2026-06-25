/**
 * tier.test.ts — T-603. The escalation engine over synthetic usage curves.
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { escalate, type EscalateDeps } from './tier.ts';

/** measurePct returns the given sequence in order (last value repeats). */
function seqMeasure(values: number[]): () => Promise<number> {
  let i = 0;
  return () => Promise.resolve(values[Math.min(i++, values.length - 1)]);
}

function harness(over: Partial<EscalateDeps> & { pcts: number[] }) {
  const calls = { tiers: [] as number[], critical: 0 };
  const deps: EscalateDeps = {
    measurePct: seqMeasure(over.pcts),
    runTier: (tier) => {
      calls.tiers.push(tier);
      return Promise.resolve({ action: `tier${tier}`, detail: {} });
    },
    onCritical: () => {
      calls.critical++;
      return Promise.resolve();
    },
    targetPct: 60,
    maxRuntimeMs: 45_000,
    now: () => 0,
    ...over,
  };
  return { deps, calls };
}

Deno.test('already under target → no tiers run, converged', async () => {
  const { deps, calls } = harness({ pcts: [50] });
  const r = await escalate(deps);
  assertEquals(r.reason, 'already_under');
  assert(r.converged);
  assertEquals(r.reachedTier, 0);
  assertEquals(calls.tiers, []);
});

Deno.test('converges mid-ladder (95→88→70→58) → stops at tier 3', async () => {
  const { deps, calls } = harness({ pcts: [95, 88, 70, 58] });
  const r = await escalate(deps);
  assertEquals(r.reason, 'converged');
  assert(r.converged);
  assertEquals(r.reachedTier, 3);
  assertEquals(calls.tiers, [1, 2, 3]);
  assertEquals(r.steps.length, 3);
  assertEquals(calls.critical, 0);
});

Deno.test('never converges → runs tiers 1-4 then critical (exhausted)', async () => {
  const { deps, calls } = harness({ pcts: [95] }); // always 95
  const r = await escalate(deps);
  assertEquals(r.reason, 'exhausted');
  assertEquals(r.converged, false);
  assertEquals(r.reachedTier, 5);
  assertEquals(calls.tiers, [1, 2, 3, 4]);
  assertEquals(calls.critical, 1);
  assertEquals(r.steps.length, 5); // 4 tiers + critical
  assertEquals(r.steps[4].action, 'critical');
});

Deno.test('runtime cap → stops early with reason runtime, no critical', async () => {
  let t = 0;
  const { deps, calls } = harness({
    pcts: [95],
    now: () => {
      const v = t;
      t += 25_000; // 0 (start), 25000 (before t1 ok), 50000 (before t2 > 45000 → stop)
      return v;
    },
  });
  const r = await escalate(deps);
  assertEquals(r.reason, 'runtime');
  assertEquals(r.converged, false);
  assertEquals(calls.tiers, [1]); // only tier 1 ran before the cap
  assertEquals(calls.critical, 0);
});
