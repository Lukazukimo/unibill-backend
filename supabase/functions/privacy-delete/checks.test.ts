/**
 * privacy-delete checks tests — the two pre-flight gates of §9.4 account
 * deletion: the confirmation-email match (400 on mismatch) and the sole-admin
 * block (422 + household list). Mirrors the enforce_min_one_admin trigger: a
 * household where the caller is the ONLY active admin must block.
 *
 * Ref: T-609 (#119), spec §9.4 / §E (privacy/my-account), BR-021.
 */

import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import { confirmationMatches, findSoleAdminHouseholds } from './checks.ts';

const ME = 'u-me';

// deno-lint-ignore no-explicit-any
function membersClient(members: Record<string, unknown>[]): any {
  return {
    from(_table: string) {
      const preds: Array<(r: Record<string, unknown>) => boolean> = [];
      // deno-lint-ignore no-explicit-any
      const builder: any = {
        select: () => builder,
        eq(col: string, val: unknown) {
          preds.push((r) => r[col] === val);
          return builder;
        },
        is(col: string, val: unknown) {
          preds.push((r) => r[col] === val);
          return builder;
        },
        in(col: string, vals: unknown[]) {
          preds.push((r) => vals.includes(r[col]));
          return builder;
        },
        then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
          const data = members.filter((r) => preds.every((p) => p(r)));
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

// --- confirmationMatches ----------------------------------------------------

Deno.test('confirmationMatches accepts an exact match', () => {
  assertEquals(confirmationMatches('me@x.co', 'me@x.co'), true);
});

Deno.test('confirmationMatches is case- and whitespace-insensitive', () => {
  assertEquals(confirmationMatches('  ME@X.CO ', 'me@x.co'), true);
});

Deno.test('confirmationMatches rejects a different email', () => {
  assertEquals(confirmationMatches('other@x.co', 'me@x.co'), false);
});

Deno.test('confirmationMatches rejects a non-string', () => {
  assertEquals(confirmationMatches(undefined, 'me@x.co'), false);
});

// --- findSoleAdminHouseholds ------------------------------------------------

Deno.test('findSoleAdminHouseholds flags households where the caller is the only active admin', async () => {
  const members = [
    // h1: caller is the ONLY admin → sole-admin → blocked
    { household_id: 'h1', user_id: ME, role: 'admin', deleted_at: null },
    { household_id: 'h1', user_id: 'u2', role: 'member', deleted_at: null },
    // h2: caller is admin but there is a co-admin → NOT blocked
    { household_id: 'h2', user_id: ME, role: 'admin', deleted_at: null },
    { household_id: 'h2', user_id: 'u3', role: 'admin', deleted_at: null },
  ];
  const blocked = await findSoleAdminHouseholds(ME, membersClient(members));
  assertEquals(blocked, ['h1']);
});

Deno.test('findSoleAdminHouseholds ignores a soft-deleted co-admin (still blocked)', async () => {
  const members = [
    { household_id: 'h1', user_id: ME, role: 'admin', deleted_at: null },
    { household_id: 'h1', user_id: 'u2', role: 'admin', deleted_at: '2026-01-01T00:00:00Z' },
  ];
  const blocked = await findSoleAdminHouseholds(ME, membersClient(members));
  assertEquals(blocked, ['h1']);
});

Deno.test('findSoleAdminHouseholds returns [] when the caller admins nothing', async () => {
  const members = [
    { household_id: 'h1', user_id: ME, role: 'member', deleted_at: null },
    { household_id: 'h2', user_id: 'u3', role: 'admin', deleted_at: null },
  ];
  const blocked = await findSoleAdminHouseholds(ME, membersClient(members));
  assertEquals(blocked, []);
});
