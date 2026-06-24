/**
 * admin-replay-chain — POST /admin/replay-chain. After a chain breaker recovers
 * (OPEN→CLOSED, announced by ai.chain.replay_available, T-415), re-enqueues the
 * invoices that were parked in needs_review because the chain was open, paced so
 * the recovered chain isn't immediately re-saturated. System-admin only.
 *
 * Ref:  T-421 (#68), spec §7.6 (replay) + §7.3 (ocr chain replay)
 * Date: 2026-06-24
 *
 * Flow:
 *   1. POST only → 405; JWT caller → 401; caller.is_system_admin → 403.
 *   2. Body { chain_name: 'ai_chain' | 'ocr_chain' } → 422 otherwise.
 *   3. Find invoices WHERE needs_review_reason = '<chain_name>_open' AND
 *      deleted_at IS NULL.
 *   4. For invoice i: enqueue { invoice_id, correlation_id, force:true } onto
 *      invoice_queue with a visibility delay of floor(i / rate) * 60s (paced at
 *      `ai.chain.replay_batch_rate_per_minute`, default 10/min), then clear
 *      needs_review_reason. force=true makes the worker re-run the now-terminal
 *      invoice; the delay spreads the batch across the recovered chain.
 *   5. 200 { chain_name, replayed, rate_per_minute }.
 *
 * Pacing uses pgmq's per-message visibility delay rather than a replay_pending
 * table + cron tick — simpler, no new infra, and the queue IS the pacing
 * primitive. (The table+cron variant is the documented scale-up path.)
 */

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { withCorrelation } from '../_shared/correlation.ts';
import { buildServiceClient } from '../_shared/lockout.ts';
import { type CallerUser, getCallerUser } from '../_shared/auth.ts';
import { getGlobalConfig, readNumberConfig } from '../_shared/config.ts';
import { queueSend } from '../_shared/queue.ts';
import { redactSecrets } from '../_shared/redact.ts';
import { log } from '../_shared/logging.ts';

export const INVOICE_QUEUE = 'invoice_queue';
export const CFG_REPLAY_RATE = 'ai.chain.replay_batch_rate_per_minute';
export const DEFAULT_REPLAY_RATE = 10;

export type ChainName = 'ai_chain' | 'ocr_chain';
const CHAIN_NAMES: ChainName[] = ['ai_chain', 'ocr_chain'];

export type ReplayResponse = { chain_name: ChainName; replayed: number; rate_per_minute: number };
export type CallerResolver = (req: Request) => Promise<CallerUser | null>;

export type HandlerDeps = {
  client?: SupabaseClient;
  getCallerUser?: CallerResolver;
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function parseChainName(raw: unknown): ChainName | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = (raw as Record<string, unknown>).chain_name;
  return typeof v === 'string' && (CHAIN_NAMES as string[]).includes(v) ? (v as ChainName) : null;
}

export function buildHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const getCaller = deps.getCallerUser ?? ((req: Request) => getCallerUser(req));

  return withCorrelation(async (ctx, req) => {
    if (req.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' });

    const caller = await getCaller(req);
    if (!caller) {
      return jsonResponse(401, { error: 'unauthorized', detail: 'missing or invalid JWT' });
    }
    if (!caller.is_system_admin) {
      return jsonResponse(403, { error: 'forbidden', detail: 'system_admin required' });
    }

    let raw: unknown = undefined;
    const text = await req.text();
    if (text.trim().length > 0) {
      try {
        raw = JSON.parse(text);
      } catch {
        return jsonResponse(400, { error: 'invalid_json' });
      }
    }
    const chainName = parseChainName(raw);
    if (!chainName) {
      return jsonResponse(422, {
        error: 'validation_failed',
        detail: `chain_name must be one of ${CHAIN_NAMES.join(', ')}`,
      });
    }
    const reason = `${chainName}_open`;

    const client = deps.client ?? buildServiceClient();

    let rate = DEFAULT_REPLAY_RATE;
    try {
      const cfg = await getGlobalConfig([CFG_REPLAY_RATE], { client });
      rate = readNumberConfig(cfg, CFG_REPLAY_RATE, DEFAULT_REPLAY_RATE);
    } catch (e) {
      log.warn('admin-replay-chain: config read failed, using default rate', {
        correlation_id: ctx.correlation_id,
        err: e instanceof Error ? e.message : String(e),
      });
    }
    rate = rate > 0 ? Math.floor(rate) : DEFAULT_REPLAY_RATE;

    // Eligible invoices: parked in needs_review because THIS chain was open.
    const { data: rows, error: loadErr } = await client
      .from('invoices')
      .select('id')
      .eq('needs_review_reason', reason)
      .is('deleted_at', null);
    if (loadErr) {
      log.error('admin-replay-chain: invoice scan failed', {
        correlation_id: ctx.correlation_id,
        err: redactSecrets(loadErr.message),
      });
      return jsonResponse(500, { error: 'internal_error', code: 'scan_failed' });
    }
    const eligible = (rows as Array<{ id: string }> | null) ?? [];

    let replayed = 0;
    for (let i = 0; i < eligible.length; i++) {
      const invoiceId = eligible[i].id;
      const delaySeconds = Math.floor(i / rate) * 60;
      try {
        await queueSend(INVOICE_QUEUE, {
          invoice_id: invoiceId,
          correlation_id: ctx.correlation_id,
          force: true,
        }, { client, delaySeconds });
        // Clear the parked reason only AFTER a successful enqueue — a failed
        // send leaves the invoice eligible for the next replay.
        await client.from('invoices').update({ needs_review_reason: null }).eq('id', invoiceId);
        replayed++;
      } catch (e) {
        log.warn('admin-replay-chain: enqueue failed for invoice', {
          correlation_id: ctx.correlation_id,
          invoice_id: invoiceId,
          err: redactSecrets(e instanceof Error ? e.message : String(e)),
        });
      }
    }

    const response: ReplayResponse = { chain_name: chainName, replayed, rate_per_minute: rate };
    return jsonResponse(200, response);
  });
}

export const handler = buildHandler({});

if (import.meta.main) {
  Deno.serve(handler);
}
