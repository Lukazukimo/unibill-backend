// =============================================================================
// config-resolve/index.ts  —  GET /config/resolve?key=<key>  (issue #278)
// -----------------------------------------------------------------------------
// Resolves an app_settings key through the scope cascade (user > household >
// global) and returns `{ value, scope_resolved_from }`, or 404 if the key
// resolves nowhere. Spec §E, §5. The mobile FeatureFlags client calls this.
//
// Reads run through a client bound to the CALLER's JWT, so RLS
// (`app_settings_select`) already limits visibility to the caller's own
// user-scoped rows, their households' rows, and global — no service_role /
// SECURITY DEFINER needed. verify_jwt defaults to true (no config.toml entry).
// =============================================================================

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { withCorrelation } from '../_shared/correlation.ts';
import { buildServiceClient } from '../_shared/lockout.ts';
import { resolveCascade, type SettingRow } from './resolve.ts';

export type CallerUser = { id: string };
export type CallerUserResolver = (req: Request) => Promise<CallerUser | null>;
export type SettingsLoader = (
  req: Request,
  userId: string,
  key: string,
) => Promise<{ rows: SettingRow[]; currentHousehold: string | null }>;

export type HandlerDeps = {
  getCallerUser?: CallerUserResolver;
  loadSettings?: SettingsLoader;
};

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers':
    'authorization, x-client-info, apikey, content-type, x-correlation-id',
  'access-control-allow-methods': 'GET, OPTIONS',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

/** Default JWT → user resolver (mirrors the other user-facing functions). */
export const defaultGetCallerUser: CallerUserResolver = async (req) => {
  const auth = req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) return null;
  const jwt = auth.slice(7).trim();
  if (!jwt) return null;
  try {
    const { data, error } = await buildServiceClient().auth.getUser(jwt);
    if (error || !data?.user) return null;
    return { id: data.user.id };
  } catch {
    return null;
  }
};

/** A Supabase client bound to the caller's JWT — every read is RLS-scoped. */
function callerClient(req: Request): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const anon = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const auth = req.headers.get('authorization') ?? req.headers.get('Authorization') ?? '';
  return createClient(url, anon, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
}

const CURRENT_HOUSEHOLD_KEY = 'ui.current_household_id';

export const defaultLoadSettings: SettingsLoader = async (req, _userId, key) => {
  const client = callerClient(req);
  const [rowsRes, curRes] = await Promise.all([
    client.from('app_settings').select('value, scope, scope_id').eq('key', key),
    client
      .from('app_settings')
      .select('value')
      .eq('key', CURRENT_HOUSEHOLD_KEY)
      .eq('scope', 'user')
      .maybeSingle(),
  ]);
  // Surface a real DB failure as 500 rather than masking it as "key not found".
  if (rowsRes.error) throw new Error(`app_settings read failed: ${rowsRes.error.message}`);
  const cur = curRes.data as { value?: { v?: string } } | null;
  return {
    rows: (rowsRes.data ?? []) as SettingRow[],
    currentHousehold: cur?.value?.v ?? null,
  };
};

export function buildHandler(deps: HandlerDeps = {}): (req: Request) => Promise<Response> {
  const getCallerUser = deps.getCallerUser ?? defaultGetCallerUser;
  const loadSettings = deps.loadSettings ?? defaultLoadSettings;

  return withCorrelation(async (_ctx, req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== 'GET') return jsonResponse(405, { error: 'method_not_allowed' });

    const user = await getCallerUser(req);
    if (!user) {
      return jsonResponse(401, { error: 'unauthorized', detail: 'missing or invalid JWT' });
    }

    const key = (new URL(req.url).searchParams.get('key') ?? '').trim();
    if (!key) {
      return jsonResponse(400, {
        error: 'invalid_request',
        detail: 'query param `key` is required',
      });
    }

    let loaded: { rows: SettingRow[]; currentHousehold: string | null };
    try {
      loaded = await loadSettings(req, user.id, key);
    } catch {
      return jsonResponse(500, { error: 'internal_error' });
    }
    const resolved = resolveCascade(loaded.rows, loaded.currentHousehold, user.id);
    if (!resolved) return jsonResponse(404, { error: 'key_not_found' });
    return jsonResponse(200, resolved);
  });
}

export const handler = buildHandler();

if (import.meta.main) Deno.serve(handler);
