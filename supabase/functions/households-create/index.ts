/**
 * households-create — POST /households.
 *
 * Creates a household and atomically makes the caller its first admin member.
 *
 * Why an Edge Function (and not a client-side RLS insert)? The `members` write
 * policy (`members_admin_write`) requires the caller to ALREADY be a household
 * admin — so a freshly-created household has a chicken-and-egg problem: its
 * creator cannot insert their own admin row under RLS. This function runs with
 * the service-role key to bootstrap that first member, then everything else
 * (listing, switching, inviting) goes through normal RLS.
 *
 * Ref:  T-516, spec §8.5 onboarding, §5.1 members/households, §5.10 (Approach A)
 * Date: 2026-06-13
 *
 * Flow:
 *   1. Method gate (POST only)            → 405
 *   2. JWT → caller { id, email }         → 401 if missing/invalid
 *   3. Body parse + validation { name }   → 400 invalid_json / 422 validation_failed
 *   4. INSERT households (created_by=caller) → 500 household_insert_failed on error
 *   5. INSERT members (role='admin', the creator) → on error, COMPENSATE by
 *      deleting the just-created household (best-effort) → 500 member_insert_failed
 *   6. Emit `household.created` (best-effort; never unwinds success)
 *   7. 200 { household_id, name, role:'admin' }
 *
 * PostgREST has no cross-statement transaction, so steps 4–5 are serialized and
 * step 5's failure is compensated by rolling back step 4. The window is tiny and
 * an orphaned household (created_by set, zero members) is invisible via the
 * members RLS, so a failed compensation is harmless.
 *
 * Test-injection seams (buildHandler({...})):
 *   - getCallerUser — stub { id, email } without a real JWT
 *   - client        — service-role client (default buildServiceClient)
 *   - emitEvent     — defaults to events.ts emitDomainEvent
 */

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { withCorrelation } from '../_shared/correlation.ts';
import { buildServiceClient } from '../_shared/lockout.ts';
import { redactSecrets } from '../_shared/redact.ts';
import { type DomainEventInput, emitDomainEvent } from '../_shared/events.ts';
import { createHouseholdBodySchema } from '../_shared/schemas/households.ts';
import { zodIssuesToErrors } from '../_shared/zodError.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateHouseholdRequest = { name: string };

export type CreateHouseholdResponse = {
  household_id: string;
  name: string;
  role: 'admin';
};

export type CallerUser = { id: string; email: string };
export type CallerUserResolver = (req: Request) => Promise<CallerUser | null>;
export type EmitEventFn = (e: DomainEventInput) => Promise<void>;

export type HandlerDeps = {
  getCallerUser: CallerUserResolver;
  client?: SupabaseClient;
  emitEvent?: EmitEventFn;
};

/**
 * `NAME_MAX` now lives with `createHouseholdBodySchema` (single source — issue
 * #265 / ADR-0006); re-exported here for existing importers. Matches the mobile
 * form validator.
 */
export { NAME_MAX } from '../_shared/schemas/households.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Valida `{ name }` contra `createHouseholdBodySchema` (Zod — fonte única, #265
 * / ADR-0006). Mantém a mesma união discriminada do validator hand-written; o
 * payload `422 details` é idêntico para bodies escalares/objeto (array cai na
 * mensagem whole-body, mais correto). No success `data.name` já vem trimado.
 */
export function validateCreateBody(value: unknown): {
  ok: true;
  data: { name: string };
} | {
  ok: false;
  errors: Array<{ field: string; message: string }>;
} {
  const parsed = createHouseholdBodySchema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, errors: zodIssuesToErrors(parsed.error) };
}

// ---------------------------------------------------------------------------
// Default resolvers (production)
// ---------------------------------------------------------------------------

/** Default JWT → user resolver (mirrors invitations-redeem / emails-connect). */
export const defaultGetCallerUser: CallerUserResolver = async (req) => {
  const auth = req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) return null;
  const jwt = auth.slice(7).trim();
  if (!jwt) return null;

  const client = buildServiceClient();
  try {
    const { data, error } = await client.auth.getUser(jwt);
    if (error || !data?.user) return null;
    if (!data.user.email) return null;
    return { id: data.user.id, email: data.user.email };
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function buildHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const emitEvent = deps.emitEvent ?? emitDomainEvent;

  return withCorrelation(async (ctx, req) => {
    if (req.method !== 'POST') {
      return jsonResponse(405, { error: 'method_not_allowed' });
    }

    // 1) JWT → caller
    const caller = await deps.getCallerUser(req);
    if (!caller) {
      return jsonResponse(401, { error: 'unauthorized', detail: 'missing or invalid JWT' });
    }

    // 2) Body parse + validation
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return jsonResponse(400, { error: 'invalid_json' });
    }
    const parsed = validateCreateBody(raw);
    if (!parsed.ok) {
      return jsonResponse(422, { error: 'validation_failed', details: parsed.errors });
    }
    const { name } = parsed.data;

    const client = deps.client ?? buildServiceClient();

    // 3) INSERT household (created_by = caller)
    const { data: household, error: householdErr } = await client
      .from('households')
      .insert({ name, created_by: caller.id })
      .select('id, name')
      .single();

    if (householdErr || !household) {
      console.error(JSON.stringify({
        level: 'error',
        correlation_id: ctx.correlation_id,
        msg: 'household insert failed',
        error: redactSecrets(householdErr?.message ?? 'no row returned'),
      }));
      return jsonResponse(500, { error: 'internal_error', code: 'households_insert_failed' });
    }

    // Defensive shape check: the service-role select should always return both
    // columns, but never return a malformed success (or emit an event with a
    // bad aggregate_id) if the projection ever drifts — narrow at runtime
    // instead of an unchecked `as string`.
    const householdId: unknown = household.id;
    const householdName: unknown = household.name;
    if (typeof householdId !== 'string' || typeof householdName !== 'string') {
      console.error(JSON.stringify({
        level: 'error',
        correlation_id: ctx.correlation_id,
        msg: 'household insert returned an unexpected shape',
      }));
      return jsonResponse(500, { error: 'internal_error', code: 'households_insert_failed' });
    }

    // 4) INSERT the creator as admin member (service-role bootstraps the first
    //    admin, which RLS cannot). On failure, compensate by deleting the
    //    orphaned household so a retry starts clean.
    //
    //    Unlike invitations-redeem (which treats a 23505 as the idempotent
    //    "already a member" case), this household is brand-new, so the caller
    //    CANNOT already be a member — any error here, including a 23505, is a
    //    genuine anomaly and rolls the household back.
    const { error: memberErr } = await client
      .from('members')
      .insert({
        household_id: householdId,
        user_id: caller.id,
        role: 'admin',
        invited_by: null,
      });

    if (memberErr) {
      console.error(JSON.stringify({
        level: 'error',
        correlation_id: ctx.correlation_id,
        msg: 'member insert failed; compensating household',
        error: redactSecrets(memberErr.message),
      }));
      try {
        await client.from('households').delete().eq('id', householdId);
      } catch (e) {
        console.error(JSON.stringify({
          level: 'warn',
          correlation_id: ctx.correlation_id,
          msg: 'household compensation delete failed (orphan left behind)',
          error: redactSecrets(e instanceof Error ? e.message : String(e)),
        }));
      }
      return jsonResponse(500, { error: 'internal_error', code: 'members_insert_failed' });
    }

    // 4.5) Seed the household's default invoice categories (T-119). Best-effort:
    //       a failure must NOT unwind the just-created household — categories can
    //       be re-seeded and the user can add their own. Runs after the member
    //       insert so a failed household never seeds an orphan.
    try {
      const { error: seedErr } = await client.rpc('seed_household_categories', {
        p_household_id: householdId,
      });
      if (seedErr) {
        console.error(JSON.stringify({
          level: 'warn',
          correlation_id: ctx.correlation_id,
          msg: 'seed_household_categories failed (non-fatal)',
          household_id: householdId,
          error: redactSecrets(seedErr.message),
        }));
      }
    } catch (e) {
      console.error(JSON.stringify({
        level: 'warn',
        correlation_id: ctx.correlation_id,
        msg: 'seed_household_categories threw (non-fatal)',
        household_id: householdId,
        error: redactSecrets(e instanceof Error ? e.message : String(e)),
      }));
    }

    // 5) Emit household.created (best-effort)
    try {
      await emitEvent({
        type: 'household.created',
        aggregate_type: 'household',
        aggregate_id: householdId,
        household_id: householdId,
        correlation_id: ctx.correlation_id,
        actor_type: 'user',
        actor_user_id: caller.id,
        payload: {
          version: 1,
          data: { name: householdName, created_by: caller.id },
        },
      });
    } catch (e) {
      console.error(JSON.stringify({
        level: 'warn',
        correlation_id: ctx.correlation_id,
        msg: 'household.created emit failed (non-fatal)',
        error: redactSecrets(e instanceof Error ? e.message : String(e)),
      }));
    }

    const response: CreateHouseholdResponse = {
      household_id: householdId,
      name: householdName,
      role: 'admin',
    };
    return jsonResponse(200, response);
  });
}

// ---------------------------------------------------------------------------
// Bootstrap (production)
// ---------------------------------------------------------------------------

export const handler = buildHandler({
  getCallerUser: defaultGetCallerUser,
});

if (import.meta.main) {
  Deno.serve(handler);
}
