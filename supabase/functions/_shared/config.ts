/**
 * config.ts — runtime config (app_settings) reader for Edge Functions.
 *
 * Ref: T-324, spec §5.5 (app_settings cascade) / §B (key catalogue)
 * Date: 2026-06-21
 *
 * MVP reads the GLOBAL scope only (the cascade user→household→global→default is
 * out of scope until per-household/user overrides exist). Values are stored
 * wrapped as `{"v": <typed>}` (spec §B); `getGlobalConfig` unwraps to the bare
 * value and `readConfig` applies a code default for missing/null entries.
 */

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { buildServiceClient } from './lockout.ts';

export type ConfigDeps = {
  /** Service-role client override (tests inject a fake). */
  client?: SupabaseClient;
};

/** Loads the given global `keys` → Map of key → unwrapped value (`value.v`). */
export async function getGlobalConfig(
  keys: string[],
  deps?: ConfigDeps,
): Promise<Map<string, unknown>> {
  const client = deps?.client ?? buildServiceClient();
  const { data, error } = await client
    .from('app_settings')
    .select('key, value')
    .eq('scope', 'global')
    .is('scope_id', null)
    .in('key', keys);
  if (error) {
    throw new Error(`getGlobalConfig failed: ${error.message}`);
  }
  const out = new Map<string, unknown>();
  for (const row of (data ?? []) as Array<{ key: string; value: unknown }>) {
    const v = (row.value as { v?: unknown } | null)?.v;
    out.set(row.key, v);
  }
  return out;
}

/** Reads `key` from a loaded config map, falling back when absent or null. */
export function readConfig<T>(cfg: Map<string, unknown>, key: string, fallback: T): T {
  const v = cfg.get(key);
  return v === undefined || v === null ? fallback : (v as T);
}

/**
 * Reads `key` as a number, coercing string-wrapped values and falling back on
 * absent/null/non-finite. Guards against a mis-seeded `{"v": "60"}` silently
 * flowing through as a string (the bare `readConfig` cast would not catch it).
 */
export function readNumberConfig(cfg: Map<string, unknown>, key: string, fallback: number): number {
  const v = cfg.get(key);
  if (v === undefined || v === null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Reads `key` as a boolean, coercing 'true'/'1'/non-zero; falls back otherwise. */
export function readBoolConfig(cfg: Map<string, unknown>, key: string, fallback: boolean): boolean {
  const v = cfg.get(key);
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === 'true' || v === '1';
  if (typeof v === 'number') return v !== 0;
  return fallback;
}
