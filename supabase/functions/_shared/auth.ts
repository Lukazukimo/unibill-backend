/**
 * auth.ts — JWT extraction + household membership loading for Edge Functions.
 *
 * Ref:  T-230, spec §4.2.1 (helper contracts) + §5.11 (RLS helpers)
 * Date: 2026-06-10
 *
 * Two surfaces:
 *
 *   1. `getCallerUser(req)` — extracts the `Authorization: Bearer <jwt>` header
 *      and verifies it via Supabase Auth's `getUser(jwt)`. Returns
 *      `{ id, email, is_system_admin }` on success, or `null` on missing /
 *      invalid token. Edge Function handlers map `null` to HTTP 401.
 *
 *   2. `loadHouseholdMemberships(userId, client)` — returns the active
 *      memberships of `userId` as `[{ household_id, role }]`. Mirrors what
 *      the SQL helper `app.households_of_user()` does, but readable from
 *      service-role context (where `auth.uid()` is unset and the SQL helper
 *      would return an empty set).
 *
 *   3. `requireCallerWithMemberships(req, client)` — convenience wrapper that
 *      composes both. Returns a single `AuthenticatedCaller` or `null`.
 *
 *   4. `assertHouseholdAdmin(caller, householdIds)` — pure predicate that
 *      returns the subset of `householdIds` the caller is NOT an admin of.
 *      Callers use it to short-circuit with HTTP 403.
 *
 * The "load memberships" step is intentionally separate from JWT verification
 * so handlers that only need identity (consent-accept, profile updates) do not
 * pay a DB round-trip. Handlers that mutate household-scoped state (emails-*,
 * invitations-*) compose both.
 *
 * Test-injection seams:
 *   - `getCallerUser(req, { client })` accepts a Supabase client override.
 *   - `requireCallerWithMemberships(req, client, { getCaller })` accepts a
 *     custom `getCaller` to stub identity in tests without touching the
 *     Supabase Auth network call.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal identity surface returned by `getCallerUser`. */
export type CallerUser = {
  id: string;
  email: string;
  /** True when JWT carries `app_metadata.is_system_admin === true`. */
  is_system_admin: boolean;
};

/** Active household membership row, projection of `public.members`. */
export type HouseholdMembership = {
  household_id: string;
  role: 'admin' | 'member';
};

/** Identity + memberships in one bundle. */
export type AuthenticatedCaller = CallerUser & {
  memberships: HouseholdMembership[];
};

/** Override seams used by tests. */
export type GetCallerUserDeps = {
  /** Supabase client used to call auth.getUser(). Defaults to service-role. */
  client?: SupabaseClient;
};

export type RequireCallerWithMembershipsDeps = {
  getCaller?: (req: Request, deps?: GetCallerUserDeps) => Promise<CallerUser | null>;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Builds a service-role Supabase client. Centralized here so callers do not
 * each re-implement the env wiring. Mirrors `lockout.ts#buildServiceClient`
 * but kept duplicated to keep auth.ts free of lockout-specific imports.
 */
function buildServiceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Extracts the bearer JWT from the `Authorization` header. Returns null when
 * the header is missing, not a Bearer scheme, or empty after the prefix.
 */
export function extractBearerToken(req: Request): string | null {
  const auth = req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!auth) return null;
  if (!auth.toLowerCase().startsWith('bearer ')) return null;
  const jwt = auth.slice(7).trim();
  return jwt.length > 0 ? jwt : null;
}

/**
 * Reads `app_metadata.is_system_admin` from the verified user. Defaults to
 * `false` for missing / unparseable values — never throws.
 */
function readSystemAdminFlag(user: {
  app_metadata?: Record<string, unknown> | null;
}): boolean {
  const meta = user.app_metadata;
  if (!meta || typeof meta !== 'object') return false;
  const v = (meta as Record<string, unknown>).is_system_admin;
  // GoTrue stores booleans natively; the bootstrap script writes `true`.
  // Defensive coercion handles the legacy string form 'true' as well.
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  return false;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Verifies the inbound JWT and returns the caller identity. Returns `null`
 * when the header is missing/invalid OR when GoTrue rejects the token.
 *
 * On the happy path the caller MUST have a non-empty email (we filter out
 * service / system actors at this boundary — they should never reach an
 * authenticated Edge Function).
 */
export async function getCallerUser(
  req: Request,
  deps: GetCallerUserDeps = {},
): Promise<CallerUser | null> {
  const jwt = extractBearerToken(req);
  if (!jwt) return null;

  const client = deps.client ?? buildServiceClient();
  try {
    const { data, error } = await client.auth.getUser(jwt);
    if (error || !data?.user) return null;
    if (!data.user.email) return null;
    return {
      id: data.user.id,
      email: data.user.email,
      is_system_admin: readSystemAdminFlag(data.user),
    };
  } catch {
    // Any throw from the auth subsystem (network, parse) → treat as unauthenticated.
    return null;
  }
}

/**
 * Returns the active memberships (`deleted_at IS NULL`) of `userId`. Empty
 * array when the user has none. Throws on DB errors — callers should map
 * those to HTTP 500.
 *
 * Equivalent to `SELECT household_id, role FROM members WHERE user_id = $1
 * AND deleted_at IS NULL`. Runs under service_role so RLS is bypassed; the
 * filter on `user_id` is the authoritative tenancy gate.
 */
export async function loadHouseholdMemberships(
  userId: string,
  client?: SupabaseClient,
): Promise<HouseholdMembership[]> {
  const c = client ?? buildServiceClient();
  const { data, error } = await c
    .from('members')
    .select('household_id, role')
    .eq('user_id', userId)
    .is('deleted_at', null);

  if (error) throw error;
  // Coerce the role column to the narrow type. Postgres enforces the enum.
  return (data ?? []).map((r) => ({
    household_id: r.household_id as string,
    role: r.role as 'admin' | 'member',
  }));
}

/**
 * Composes identity + memberships into a single bundle. Returns `null` when
 * authentication fails (the membership query is skipped — no point doing a
 * DB round-trip for a request we are about to 401).
 */
export async function requireCallerWithMemberships(
  req: Request,
  client?: SupabaseClient,
  deps: RequireCallerWithMembershipsDeps = {},
): Promise<AuthenticatedCaller | null> {
  const getCaller = deps.getCaller ?? getCallerUser;
  const c = client ?? buildServiceClient();
  const caller = await getCaller(req, { client: c });
  if (!caller) return null;
  const memberships = await loadHouseholdMemberships(caller.id, c);
  return { ...caller, memberships };
}

/**
 * Returns the subset of `householdIds` that `caller` is NOT an active admin
 * of. Empty array means "caller is admin of every requested household_id" —
 * the success condition for write endpoints that mutate household-scoped state.
 *
 * Pure function — no DB access. Callers that need a check against fresh data
 * should pass an `AuthenticatedCaller` from `requireCallerWithMemberships()`.
 */
export function nonAdminHouseholds(
  caller: AuthenticatedCaller,
  householdIds: string[],
): string[] {
  const adminOf = new Set(
    caller.memberships
      .filter((m) => m.role === 'admin')
      .map((m) => m.household_id),
  );
  return householdIds.filter((h) => !adminOf.has(h));
}

/**
 * Returns the subset of `householdIds` that `caller` is NOT a member of
 * (admin or member). Used by read-only endpoints that scope by household
 * without requiring admin privileges.
 */
export function nonMemberHouseholds(
  caller: AuthenticatedCaller,
  householdIds: string[],
): string[] {
  const memberOf = new Set(caller.memberships.map((m) => m.household_id));
  return householdIds.filter((h) => !memberOf.has(h));
}
