// Tests for the config-resolve cascade (issue #278). Pure precedence logic:
// user > household(current) > global > (none). Values are stored wrapped as
// {"v": <typed>} and returned unwrapped. Ref: spec §E, §B, §5 app_settings.

import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import { resolveCascade, type SettingRow } from './resolve.ts';

const ME = 'user-me';
const HH_A = '11111111-1111-4111-8111-111111111111';
const HH_B = '22222222-2222-4222-8222-222222222222';

Deno.test('user scope wins over household and global (value unwrapped)', () => {
  const rows: SettingRow[] = [
    { value: { v: 'g' }, scope: 'global', scope_id: null },
    { value: { v: 'h' }, scope: 'household', scope_id: HH_A },
    { value: { v: 'u' }, scope: 'user', scope_id: ME },
  ];
  assertEquals(resolveCascade(rows, HH_A, ME), { value: 'u', scope_resolved_from: 'user' });
});

Deno.test('household (current) wins over global when no user row', () => {
  const rows: SettingRow[] = [
    { value: { v: 'g' }, scope: 'global', scope_id: null },
    { value: { v: 'h' }, scope: 'household', scope_id: HH_A },
  ];
  assertEquals(resolveCascade(rows, HH_A, ME), { value: 'h', scope_resolved_from: 'household' });
});

Deno.test('a household row for a NON-current household is ignored', () => {
  const rows: SettingRow[] = [
    { value: { v: 'g' }, scope: 'global', scope_id: null },
    { value: { v: 'hB' }, scope: 'household', scope_id: HH_B },
  ];
  assertEquals(resolveCascade(rows, HH_A, ME), { value: 'g', scope_resolved_from: 'global' });
});

Deno.test('a user row for a DIFFERENT user is ignored (defensive RLS guard)', () => {
  const rows: SettingRow[] = [
    { value: { v: 'g' }, scope: 'global', scope_id: null },
    { value: { v: 'someone-else' }, scope: 'user', scope_id: 'other-user' },
  ];
  assertEquals(resolveCascade(rows, HH_A, ME), { value: 'g', scope_resolved_from: 'global' });
});

Deno.test('scalar and non-scalar wrapped values unwrap correctly', () => {
  assertEquals(
    resolveCascade([{ value: { v: true }, scope: 'global', scope_id: null }], null, ME),
    { value: true, scope_resolved_from: 'global' },
  );
  assertEquals(
    resolveCascade([{ value: { v: 42 }, scope: 'global', scope_id: null }], null, ME),
    { value: 42, scope_resolved_from: 'global' },
  );
  // an array value passes through (not shaped {v:...})
  assertEquals(
    resolveCascade([{ value: ['a', 'b'], scope: 'global', scope_id: null }], null, ME),
    { value: ['a', 'b'], scope_resolved_from: 'global' },
  );
});

Deno.test('no matching row → null (handler maps to 404)', () => {
  assertEquals(resolveCascade([], HH_A, ME), null);
  assertEquals(
    resolveCascade([{ value: { v: 'hB' }, scope: 'household', scope_id: HH_B }], HH_A, ME),
    null,
  );
});

Deno.test('household scope skipped when the caller has no current household', () => {
  const rows: SettingRow[] = [
    { value: { v: 'h' }, scope: 'household', scope_id: HH_A },
    { value: { v: 'g' }, scope: 'global', scope_id: null },
  ];
  assertEquals(resolveCascade(rows, null, ME), { value: 'g', scope_resolved_from: 'global' });
});
