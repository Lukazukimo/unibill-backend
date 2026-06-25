/**
 * health — GET /health (public + authenticated). §11.4 / §E.
 *
 * Public response:           { status: 'ok'|'degraded'|'down', timestamp }
 * With Bearer service_role:  + { db_ok, queue_depths, ai_chain_state,
 *                               capacity_status, last_sync_run_minutes_ago }
 *
 * Ref: T-613 (#124), spec §11.4 / §E. Date: 2026-06-25
 *
 * The function always reads with a service-role client (the signal tables are
 * RLS-protected); the caller's auth only decides whether the internal metrics
 * are EXPOSED. Capacity status + queue depths come from the latest
 * capacity_snapshot (one cheap indexed read) — no live capacity scan, keeping
 * the probe fast. Classification logic is in checks.ts.
 */

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { buildServiceClient } from '../_shared/lockout.ts';
import { requireServiceRole } from '../_shared/serviceAuth.ts';
import {
  type CapacityStatus,
  type CircuitRow,
  type CircuitState,
  classifyHealth,
  type HealthSignals,
  minutesSince,
  type QueueDepthSummary,
  reduceAiChain,
  summarizeQueueDepths,
  worstCapacity,
} from './checks.ts';

export type ExtendedDetail = {
  db_ok: boolean;
  queue_depths: QueueDepthSummary;
  ai_chain_state: CircuitState;
  capacity_status: CapacityStatus | null;
  last_sync_run_minutes_ago: number | null;
};

export type GatherResult = { signals: HealthSignals; detail: ExtendedDetail };
export type GatherFn = (client: SupabaseClient, nowMs: number) => Promise<GatherResult>;

export type HandlerDeps = {
  client?: SupabaseClient;
  gather?: GatherFn;
  isServiceRole?: (req: Request) => boolean;
  now?: () => number;
};

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

// --- default signal gathering (production) ---------------------------------

const DOWN_DETAIL: ExtendedDetail = {
  db_ok: false,
  queue_depths: { invoice: 0, email: 0, dlq: 0 },
  ai_chain_state: 'closed',
  capacity_status: null,
  last_sync_run_minutes_ago: null,
};

const defaultGather: GatherFn = async (client, nowMs) => {
  // db reachability ping — a trivial indexed read; any error ⇒ db down.
  let dbOk = true;
  try {
    const { error } = await client.from('system_actors').select('*').limit(1);
    dbOk = !error;
  } catch {
    dbOk = false;
  }
  if (!dbOk) {
    return {
      signals: {
        dbOk: false,
        lastSyncMinutesAgo: null,
        capacityStatus: null,
        aiChainState: 'closed',
        aiChainOpenMinutes: null,
      },
      detail: DOWN_DETAIL,
    };
  }

  // latest capacity snapshot → capacity status (worst of db/storage) + queue depths
  let capacityStatus: CapacityStatus | null = null;
  let queueDepths: QueueDepthSummary = { invoice: 0, email: 0, dlq: 0 };
  const snap = await client
    .from('capacity_snapshots')
    .select('db_status, storage_status, queue_depths')
    .order('checked_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!snap.error && snap.data) {
    const row = snap.data as {
      db_status: CapacityStatus;
      storage_status: CapacityStatus;
      queue_depths: Record<string, number> | null;
    };
    capacityStatus = worstCapacity(row.db_status, row.storage_status);
    queueDepths = summarizeQueueDepths(row.queue_depths ?? {});
  }

  // last sync_run
  const sync = await client
    .from('sync_runs')
    .select('started_at')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const lastSyncMinutesAgo = !sync.error && sync.data
    ? minutesSince((sync.data as { started_at: string }).started_at, nowMs)
    : null;

  // ai_chain breaker(s)
  const breakers = await client
    .from('circuit_breakers')
    .select('state, opened_at')
    .eq('resource_type', 'ai_chain');
  const rows: CircuitRow[] = (!breakers.error && Array.isArray(breakers.data))
    ? (breakers.data as CircuitRow[])
    : [];
  const ai = reduceAiChain(rows, nowMs);

  return {
    signals: {
      dbOk: true,
      lastSyncMinutesAgo,
      capacityStatus,
      aiChainState: ai.state,
      aiChainOpenMinutes: ai.openMinutes,
    },
    detail: {
      db_ok: true,
      queue_depths: queueDepths,
      ai_chain_state: ai.state,
      capacity_status: capacityStatus,
      last_sync_run_minutes_ago: lastSyncMinutesAgo,
    },
  };
};

// --- handler ----------------------------------------------------------------

export function buildHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const gather = deps.gather ?? defaultGather;
  const isServiceRole = deps.isServiceRole ?? ((req: Request) => requireServiceRole(req));
  const now = deps.now ?? (() => Date.now());

  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== 'GET') return jsonResponse(405, { error: 'method_not_allowed' });

    const nowMs = now();
    let result: GatherResult;
    try {
      result = await gather(deps.client ?? buildServiceClient(), nowMs);
    } catch {
      // Total gather failure ⇒ db unreachable.
      result = {
        signals: {
          dbOk: false,
          lastSyncMinutesAgo: null,
          capacityStatus: null,
          aiChainState: 'closed',
          aiChainOpenMinutes: null,
        },
        detail: DOWN_DETAIL,
      };
    }

    const { status, code } = classifyHealth(result.signals);
    const body: Record<string, unknown> = {
      status,
      timestamp: new Date(nowMs).toISOString(),
    };
    if (isServiceRole(req)) Object.assign(body, result.detail);

    return jsonResponse(code, body);
  };
}

export const handler = buildHandler({});

if (import.meta.main) {
  Deno.serve(handler);
}
