/**
 * classify.test.ts — T-602. Pure classification (§10.2 thresholds).
 */

import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import { atLeast, type CapacityStatus, classify, usagePct, worst } from './classify.ts';

Deno.test('usagePct: bytes/limit*100 (2dp); non-positive limit → 0', () => {
  assertEquals(usagePct(500, 1000), 50);
  assertEquals(usagePct(820, 1000), 82);
  assertEquals(usagePct(1, 3), 33.33);
  assertEquals(usagePct(123, 0), 0);
  assertEquals(usagePct(123, -1), 0);
});

Deno.test('classify maps each band (§10.2): green/yellow/orange/red', () => {
  assertEquals(classify(0), 'green');
  assertEquals(classify(69.99), 'green');
  assertEquals(classify(70), 'yellow');
  assertEquals(classify(79.99), 'yellow');
  assertEquals(classify(80), 'orange');
  assertEquals(classify(89.99), 'orange');
  assertEquals(classify(90), 'red');
  assertEquals(classify(100), 'red');
});

Deno.test('classify honors custom thresholds', () => {
  const t = { yellowPct: 50, orangePct: 60, redPct: 75 };
  assertEquals(classify(49, t), 'green');
  assertEquals(classify(50, t), 'yellow');
  assertEquals(classify(74, t), 'orange');
  assertEquals(classify(75, t), 'red');
});

Deno.test('worst picks the more severe status', () => {
  assertEquals(worst('green', 'red'), 'red');
  assertEquals(worst('orange', 'yellow'), 'orange');
  assertEquals(worst('green', 'green'), 'green');
  assertEquals(worst('yellow', 'orange'), 'orange');
});

Deno.test('atLeast: severity-ordered comparison', () => {
  const cases: Array<[CapacityStatus, CapacityStatus, boolean]> = [
    ['orange', 'orange', true],
    ['red', 'orange', true],
    ['yellow', 'orange', false],
    ['green', 'green', true],
  ];
  for (const [s, min, want] of cases) assertEquals(atLeast(s, min), want, `${s} >= ${min}`);
});
