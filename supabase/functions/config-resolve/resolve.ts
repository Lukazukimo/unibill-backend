// =============================================================================
// config-resolve/resolve.ts
// -----------------------------------------------------------------------------
// Pure precedence logic for GET /config/resolve (issue #278, spec §E, §5).
// Resolves an app_settings key through the scope cascade
//   user (scope_id = caller) > household (scope_id = caller's current household)
//   > global (scope_id NULL) > (none).
// The caller only ever sees rows RLS permits (own user row, own households'
// rows, global), so this just picks the highest-precedence match.
// =============================================================================

// deno-lint-ignore no-explicit-any
type Json = any;

export type SettingScope = 'user' | 'household' | 'global';
export type SettingRow = { value: Json; scope: SettingScope; scope_id: string | null };
export type Resolved = { value: Json; scope_resolved_from: SettingScope };

/**
 * `app_settings.value` is always stored wrapped as `{"v": <typed>}` (seed
 * convention, spec §B — read via `value->'v'`). Unwrap it to the bare typed
 * value the client expects; anything not shaped that way passes through.
 */
function unwrap(value: Json): Json {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'v' in value) {
    return value.v;
  }
  return value;
}

/**
 * Picks the effective value for a key. `currentHousehold` disambiguates which
 * household-scoped row applies (a user can belong to several); when `null` the
 * household tier is skipped. `userId` is a defensive belt-and-braces on top of
 * RLS (which already guarantees the only user-scoped row visible is the
 * caller's). Returns the UNWRAPPED value, or `null` when nothing matches (→ 404).
 */
export function resolveCascade(
  rows: SettingRow[],
  currentHousehold: string | null,
  userId: string,
): Resolved | null {
  const user = rows.find((r) => r.scope === 'user' && r.scope_id === userId);
  if (user) return { value: unwrap(user.value), scope_resolved_from: 'user' };

  if (currentHousehold !== null) {
    const household = rows.find(
      (r) => r.scope === 'household' && r.scope_id === currentHousehold,
    );
    if (household) return { value: unwrap(household.value), scope_resolved_from: 'household' };
  }

  const global = rows.find((r) => r.scope === 'global');
  if (global) return { value: unwrap(global.value), scope_resolved_from: 'global' };

  return null;
}
