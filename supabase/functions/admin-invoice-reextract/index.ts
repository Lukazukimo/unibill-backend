/**
 * admin-invoice-reextract — POST /admin/invoices/:id/reextract. Re-enqueues an
 * invoice onto invoice_queue for the extraction-worker, optionally forcing a
 * re-run even when the invoice is already terminal. System-admin only.
 *
 * Ref:  T-420 (#67), spec §7.9 (manual re-extraction)
 * Date: 2026-06-24
 *
 * Flow (per request):
 *   1. Method gate (POST only) → 405.
 *   2. Path → invoice_id (uuid); invalid → 404 (don't leak route topology).
 *   3. JWT → caller; missing/invalid → 401.
 *   4. caller.is_system_admin !== true → 403.
 *   5. Body `{ force?: boolean = true }`; malformed JSON → 400, wrong type → 422.
 *   6. Load the invoice — missing → 404.
 *   7. Rate-limit 30/hour per admin (admin_reextract) → 429 when exhausted; the
 *      enqueue (queueSend invoice_queue) runs inside the limiter.
 *   8. Emit invoice.reextract_requested (actor_user_id = caller, best-effort).
 *   9. 200 { queued: true, msg_id }.
 *
 * All collaborators (client / getCallerUser / emitEvent) are injected → the
 * handler is unit-tested with a fake client + stubbed identity, no JWT network.
 */

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { withCorrelation } from '../_shared/correlation.ts';
import { buildServiceClient } from '../_shared/lockout.ts';
import { type CallerUser, getCallerUser } from '../_shared/auth.ts';
import { withRateLimit } from '../_shared/rateLimit.ts';
import { RateLimitError } from '../_shared/errors.ts';
import { queueSend } from '../_shared/queue.ts';
import { type DomainEventInput, emitDomainEvent } from '../_shared/events.ts';
import { redactSecrets } from '../_shared/redact.ts';
import { log } from '../_shared/logging.ts';

export const INVOICE_QUEUE = 'invoice_queue';
export const REEXTRACT_LIMIT_PER_HOUR = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReextractResponse = { queued: true; msg_id: number };
export type EmitEventFn = (e: DomainEventInput) => Promise<void>;
export type CallerResolver = (req: Request) => Promise<CallerUser | null>;

export type HandlerDeps = {
  client?: SupabaseClient;
  getCallerUser?: CallerResolver;
  emitEvent?: EmitEventFn;
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Extracts the invoice id from a `/admin/invoices/:id/reextract`-shaped path.
 * Also accepts the deployed `/<prefix>/admin-invoice-reextract/:id` form and a
 * `?id=` fallback. Returns null (→ 404) when nothing matches.
 */
export function extractInvoiceId(url: URL): string | null {
  const queryId = url.searchParams.get('id');
  if (queryId && UUID_RE.test(queryId)) return queryId.toLowerCase();

  const m1 = url.pathname.match(/\/admin\/invoices\/([0-9a-f-]{36})\/reextract\/?$/i);
  if (m1 && UUID_RE.test(m1[1])) return m1[1].toLowerCase();

  const m2 = url.pathname.match(/\/admin-invoice-reextract\/([0-9a-f-]{36})\/?$/i);
  if (m2 && UUID_RE.test(m2[1])) return m2[1].toLowerCase();

  return null;
}

/** Body `{ force?: boolean }` — defaults to true (the §7.9 manual re-extract). */
export function parseBody(raw: unknown): { ok: true; force: boolean } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, force: true };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false };
  const v = raw as Record<string, unknown>;
  if (v.force === undefined) return { ok: true, force: true };
  if (typeof v.force !== 'boolean') return { ok: false };
  return { ok: true, force: v.force };
}

export function buildHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const emitEvent = deps.emitEvent ?? emitDomainEvent;
  const getCaller = deps.getCallerUser ?? ((req: Request) => getCallerUser(req));

  return withCorrelation(async (ctx, req) => {
    if (req.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' });

    const invoiceId = extractInvoiceId(new URL(req.url));
    if (!invoiceId) return jsonResponse(404, { error: 'not_found' });

    const caller = await getCaller(req);
    if (!caller) {
      return jsonResponse(401, { error: 'unauthorized', detail: 'missing or invalid JWT' });
    }
    if (!caller.is_system_admin) {
      return jsonResponse(403, { error: 'forbidden', detail: 'system_admin required' });
    }

    // Body: empty → {force:true}; malformed JSON → 400; wrong type → 422.
    let raw: unknown = undefined;
    const text = await req.text();
    if (text.trim().length > 0) {
      try {
        raw = JSON.parse(text);
      } catch {
        return jsonResponse(400, { error: 'invalid_json' });
      }
    }
    const parsed = parseBody(raw);
    if (!parsed.ok) {
      return jsonResponse(422, { error: 'validation_failed', detail: 'force must be a boolean' });
    }
    const force = parsed.force;

    const client = deps.client ?? buildServiceClient();

    // Confirm the invoice exists (a missing one would only ACK as an orphan).
    const { data: inv, error: loadErr } = await client
      .from('invoices')
      .select('id, household_id')
      .eq('id', invoiceId)
      .maybeSingle();
    if (loadErr) {
      log.error('admin-invoice-reextract: invoice load failed', {
        correlation_id: ctx.correlation_id,
        err: redactSecrets(loadErr.message),
      });
      return jsonResponse(500, { error: 'internal_error', code: 'load_failed' });
    }
    if (!inv) return jsonResponse(404, { error: 'not_found' });
    const householdId = (inv as { household_id: string | null }).household_id;

    // Rate-limit the enqueue: 30/hour per admin.
    let msgId: number;
    try {
      msgId = await withRateLimit(
        'admin_reextract',
        caller.id,
        { window: '1hour', limit: REEXTRACT_LIMIT_PER_HOUR },
        () =>
          queueSend(INVOICE_QUEUE, {
            invoice_id: invoiceId,
            correlation_id: ctx.correlation_id,
            force,
          }, { client }),
        { client },
      );
    } catch (e) {
      if (e instanceof RateLimitError) {
        return jsonResponse(429, {
          error: 'rate_limited',
          detail: `re-extract limited to ${REEXTRACT_LIMIT_PER_HOUR}/hour`,
        });
      }
      log.error('admin-invoice-reextract: enqueue failed', {
        correlation_id: ctx.correlation_id,
        err: redactSecrets(e instanceof Error ? e.message : String(e)),
      });
      return jsonResponse(500, { error: 'internal_error', code: 'enqueue_failed' });
    }

    // Best-effort audit event (never unwinds the enqueue).
    await emitEvent({
      type: 'invoice.reextract_requested',
      aggregate_type: 'invoice',
      aggregate_id: invoiceId,
      household_id: householdId ?? undefined,
      correlation_id: ctx.correlation_id,
      actor_type: 'user',
      actor_user_id: caller.id,
      payload: { version: 1, data: { force, msg_id: msgId } },
    }).catch((e) =>
      log.warn('admin-invoice-reextract: reextract_requested event failed', {
        correlation_id: ctx.correlation_id,
        err: redactSecrets(e instanceof Error ? e.message : String(e)),
      })
    );

    const response: ReextractResponse = { queued: true, msg_id: msgId };
    return jsonResponse(200, response);
  });
}

export const handler = buildHandler({});

if (import.meta.main) {
  Deno.serve(handler);
}
