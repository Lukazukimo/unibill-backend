/**
 * telemetry-ingest — POST /telemetry/ingest: batched client telemetry sink.
 *
 * Accepts up to 50 telemetry events from an authenticated user, gates on active
 * telemetry consent, deep-redacts each payload, and inserts into
 * public.client_telemetry (user_id = caller). Per-user rate limited by event
 * count (100 events / minute).
 *
 * Ref:  T-513 (#85), spec §8.9 / Appendix E /telemetry/ingest, BR-018.
 * Date: 2026-07-10
 *
 * Flow (per request):
 *   1. Method gate (POST only)                                       → 405
 *   2. JWT → caller                                                  → 401
 *   3. Parse JSON body                                               → 400 invalid_json
 *   4. Validate shape + batch size (<=50 events)                     → 422 validation_failed
 *   5. Per-event byte cap (<=8 KB)                                   → 413 payload_too_large
 *   6. Active telemetry consent (consent_log, purpose='telemetry',
 *      revoked_at IS NULL)                                           → 403 consent_required
 *   7. Per-user rate limit (increment by event count; > 100/min)     → 429 rate_limited
 *   8. Deep-redact payloads + INSERT into client_telemetry           → 500 on failure
 *   9. 200 { ingested: N }
 *
 * Consent is checked BEFORE the rate limit so an un-consented caller is rejected
 * outright and never counts against the bucket. The rate limit is the last guard
 * before the insert; it increments by the batch size (the limit counts events,
 * not requests).
 *
 * Test-injection seams (handler exported as buildHandler({...})):
 *   - getCallerUser — stub to inject { id } without a JWT
 *   - client        — Supabase service-role client (injectable)
 *   - now           — clock stub for deterministic rate-limit windows
 */

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { type CallerUser, getCallerUser } from '../_shared/auth.ts';
import { withCorrelation } from '../_shared/correlation.ts';
import { buildServiceClient, floorToWindow } from '../_shared/lockout.ts';
import { redactDeep, redactSecrets } from '../_shared/redact.ts';
import { type FieldError, zodIssuesToErrors } from '../_shared/zodError.ts';
import { telemetryIngestBodySchema } from '../_shared/schemas/telemetry.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Per-event serialized byte cap. Over → 413. */
const MAX_EVENT_BYTES = 8 * 1024;

const CONSENT_PURPOSE_TELEMETRY = 'telemetry';

const RL_RESOURCE_TELEMETRY = 'telemetry_ingest';
const RL_LIMIT_EVENTS = 100;
const RL_WINDOW_MINUTES = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IngestResponse = { ingested: number };

export type CallerUserResolver = (req: Request) => Promise<CallerUser | null>;

export type HandlerDeps = {
  getCallerUser: CallerUserResolver;
  client?: SupabaseClient;
  /** Clock injection for deterministic rate-limit windows in tests. */
  now?: () => Date;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function validateBody(
  value: unknown,
): { ok: true; data: { events: unknown[] } } | { ok: false; errors: FieldError[] } {
  const parsed = telemetryIngestBodySchema.safeParse(value);
  if (!parsed.success) return { ok: false, errors: zodIssuesToErrors(parsed.error) };
  return { ok: true, data: parsed.data };
}

/**
 * Reads-then-upserts the rate-limit bucket, incrementing by `amount`. Mirrors
 * invitations-redeem's incrementBucket but adds a whole batch at once (the limit
 * counts events, not requests). Returns the post-increment count + over_limit.
 */
async function incrementBucketBy(
  client: SupabaseClient,
  resourceKey: string,
  amount: number,
  limit: number,
  now: Date,
): Promise<{ count: number; over_limit: boolean }> {
  const windowStart = floorToWindow(now, RL_WINDOW_MINUTES);

  const { data: existing, error: readErr } = await client
    .from('rate_limit_buckets')
    .select('count')
    .eq('resource_type', RL_RESOURCE_TELEMETRY)
    .eq('resource_key', resourceKey)
    .eq('window_start', windowStart.toISOString())
    .maybeSingle();
  if (readErr) throw readErr;

  const nextCount = ((existing?.count as number | undefined) ?? 0) + amount;

  const { error: upsertErr } = await client
    .from('rate_limit_buckets')
    .upsert(
      {
        resource_type: RL_RESOURCE_TELEMETRY,
        resource_key: resourceKey,
        window_start: windowStart.toISOString(),
        window_size: `${RL_WINDOW_MINUTES} minutes`,
        count: nextCount,
      },
      { onConflict: 'resource_type,resource_key,window_start,window_size' },
    );
  if (upsertErr) throw upsertErr;

  return { count: nextCount, over_limit: nextCount > limit };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function buildHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());

  return withCorrelation(async (ctx, req) => {
    if (req.method !== 'POST') {
      return jsonResponse(405, { error: 'method_not_allowed' });
    }

    // 1) JWT → caller.
    const caller = await deps.getCallerUser(req);
    if (!caller) {
      return jsonResponse(401, { error: 'unauthorized', detail: 'missing or invalid JWT' });
    }

    // 2) Parse body.
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return jsonResponse(400, { error: 'invalid_json' });
    }

    // 3) Validate shape + batch size (<=50).
    const parsed = validateBody(raw);
    if (!parsed.ok) {
      return jsonResponse(422, { error: 'validation_failed', details: parsed.errors });
    }
    const events = parsed.data.events as Array<{
      event_type: string;
      severity: string;
      payload: Record<string, unknown>;
      screen?: string;
      occurred_at: string;
    }>;

    // 4) Per-event byte cap → 413 (measured on the incoming event, pre-redaction).
    for (const ev of events) {
      if (new TextEncoder().encode(JSON.stringify(ev)).length > MAX_EVENT_BYTES) {
        return jsonResponse(413, {
          error: 'payload_too_large',
          detail: `an event exceeds ${MAX_EVENT_BYTES} bytes`,
        });
      }
    }

    const client = deps.client ?? buildServiceClient();

    // 5) Active telemetry consent (BR-018). No active row → 403.
    const { data: consent, error: consentErr } = await client
      .from('consent_log')
      .select('id')
      .eq('user_id', caller.id)
      .eq('purpose', CONSENT_PURPOSE_TELEMETRY)
      .is('revoked_at', null)
      .maybeSingle();
    if (consentErr) {
      console.error(JSON.stringify({
        level: 'error',
        correlation_id: ctx.correlation_id,
        msg: 'consent check failed',
        error: redactSecrets(consentErr.message),
      }));
      return jsonResponse(500, { error: 'internal_error', code: 'consent_check_failed' });
    }
    if (!consent) {
      return jsonResponse(403, {
        error: 'consent_required',
        detail: 'no active telemetry consent',
      });
    }

    // 6) Per-user rate limit (by event count). Over → 429.
    let rl: { count: number; over_limit: boolean };
    try {
      rl = await incrementBucketBy(
        client,
        `user:${caller.id}`,
        events.length,
        RL_LIMIT_EVENTS,
        clock(),
      );
    } catch (e) {
      console.error(JSON.stringify({
        level: 'error',
        correlation_id: ctx.correlation_id,
        msg: 'telemetry rate-limit bucket failed',
        error: redactSecrets(e instanceof Error ? e.message : String(e)),
      }));
      return jsonResponse(500, { error: 'internal_error', code: 'rate_limit_failed' });
    }
    if (rl.over_limit) {
      return jsonResponse(429, {
        error: 'rate_limited',
        detail: 'too many telemetry events',
        scope: 'user',
      });
    }

    // 7) Deep-redact each payload (folding the optional screen in) + INSERT.
    const rows = events.map((ev) => ({
      user_id: caller.id,
      event_type: ev.event_type,
      severity: ev.severity,
      payload: redactDeep(
        ev.screen === undefined ? ev.payload : { ...ev.payload, screen: ev.screen },
      ),
      occurred_at: ev.occurred_at,
    }));

    const { error: insertErr } = await client.from('client_telemetry').insert(rows);
    if (insertErr) {
      console.error(JSON.stringify({
        level: 'error',
        correlation_id: ctx.correlation_id,
        msg: 'client_telemetry insert failed',
        error: redactSecrets(insertErr.message),
      }));
      return jsonResponse(500, { error: 'internal_error', code: 'insert_failed' });
    }

    return jsonResponse(200, { ingested: rows.length } satisfies IngestResponse);
  });
}

// ---------------------------------------------------------------------------
// Bootstrap (production)
// ---------------------------------------------------------------------------

export const handler = buildHandler({ getCallerUser });

if (import.meta.main) {
  Deno.serve(handler);
}
