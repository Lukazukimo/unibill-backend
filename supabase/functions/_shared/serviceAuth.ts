/**
 * serviceAuth.ts — defense-in-depth service-role gate for system Edge Functions.
 *
 * Ref: T-324, spec §9.1 (line 1703: "/sync-dispatcher etc devem verificar o
 *      Authorization header chega como Bearer <service_role>")
 * Date: 2026-06-21
 *
 * The cron wrapper `private.invoke_edge_function` calls these functions with
 * `Authorization: Bearer <service_role JWT>`. `requireServiceRole` confirms the
 * bearer equals the project service-role key (constant-time) so a leaked anon /
 * authenticated token cannot trigger the workers even if it passes the gateway.
 */

/** Length-checked constant-time string compare (avoids early-exit timing leak). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export type ServiceAuthDeps = {
  /** Override the expected key (tests / multi-env); defaults to the env var. */
  serviceRoleKey?: string;
};

/** True iff the request carries `Authorization: Bearer <service-role key>`. */
export function requireServiceRole(req: Request, deps?: ServiceAuthDeps): boolean {
  const auth = req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) return false;
  const token = auth.slice(7).trim();
  const key = deps?.serviceRoleKey ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!token || !key) return false;
  return timingSafeEqual(token, key);
}
