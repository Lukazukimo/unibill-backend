/**
 * vault.ts — read provider API keys (and any app secret) from Supabase Vault.
 *
 * Ref:  T-403 (#49), spec §7.3 (Vault) + §9.3 + §6.5
 * Date: 2026-06-24
 *
 * `getVaultSecret(secretId)` decrypts a vault secret by uuid via the
 * SECURITY DEFINER wrapper `app.decrypt_app_password(secret_id)` (generic
 * despite the name) and caches the plaintext IN-PROCESS with a short TTL — so
 * the extraction worker doesn't round-trip the vault on every provider call.
 *
 * The plaintext lives only in this module's memory (never logged — pair with
 * redactSecrets at the call sites). The RPC / clock / TTL are injectable so the
 * helper is unit-tested without a DB; `clearVaultCache()` resets state per test.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';

const DEFAULT_TTL_MS = 5 * 60_000; // 5 min — provider keys rotate rarely

type CacheEntry = { value: string; expiresAt: number };
const cache = new Map<string, CacheEntry>();

export interface GetVaultSecretDeps {
  client?: SupabaseClient;
  /** Override the decrypt call (default: rpc app.decrypt_app_password). */
  decrypt?: (secretId: string) => Promise<string | null>;
  now?: () => number;
  ttlMs?: number;
}

function buildServiceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Returns the decrypted plaintext for `secretId`, cached for `ttlMs`. Throws if
 * the secret does not exist / decrypts to null. Callers that want a soft miss
 * (e.g. vault-first with an env fallback) should catch and fall back.
 */
export async function getVaultSecret(
  secretId: string,
  deps: GetVaultSecretDeps = {},
): Promise<string> {
  const now = deps.now ?? (() => Date.now());
  const hit = cache.get(secretId);
  if (hit && hit.expiresAt > now()) return hit.value;

  const decrypt = deps.decrypt ??
    (async (id: string) => {
      const { data, error } = await (deps.client ?? buildServiceClient())
        .rpc('decrypt_app_password', { secret_id: id });
      if (error) throw new Error(`getVaultSecret: decrypt failed: ${error.message}`);
      return data as string | null;
    });

  const value = await decrypt(secretId);
  if (value === null || value === undefined) {
    throw new Error(`getVaultSecret: secret ${secretId} not found`);
  }
  cache.set(secretId, { value, expiresAt: now() + (deps.ttlMs ?? DEFAULT_TTL_MS) });
  return value;
}

/** Clears the in-process plaintext cache (tests; or after a rotation). */
export function clearVaultCache(): void {
  cache.clear();
}
