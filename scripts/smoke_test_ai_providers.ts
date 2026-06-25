#!/usr/bin/env -S deno run --allow-env --allow-net
/**
 * smoke_test_ai_providers.ts — deploy gate (T-419, #66).
 *
 * Pings every provider in ai.providers.extraction.chain (read from the target
 * project's app_settings) with a 1-token 'ping' and exits non-zero on any
 * non-200 — catching deprecated models (404) and the TBD_SET_AT_DEPLOY sentinel
 * BEFORE Edge Functions are promoted. Each ping is recorded in ai_calls with
 * synthetic=true. Wire-up in .github/workflows/deploy-dev.yml gates the deploy.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (target project),
 *      GEMINI_API_KEY, GROQ_API_KEY[, OPENROUTER_API_KEY].
 *
 * Usage: deno run --allow-env --allow-net scripts/smoke_test_ai_providers.ts
 */

import { createClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { getGlobalConfig } from '../supabase/functions/_shared/config.ts';
import { defaultPing, formatResults, runSmoke, type SmokeCallRow } from './lib/smoke.ts';

const API_KEY_ENV: Record<string, string> = {
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

function main(): Promise<void> {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) {
    console.error('smoke: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    Deno.exit(2);
  }
  const client = createClient(url, serviceKey, { auth: { persistSession: false } });

  return runSmoke({
    getConfig: (keys) => getGlobalConfig(keys, { client }),
    ping: defaultPing,
    apiKeyFor: (provider) => {
      const envName = API_KEY_ENV[provider];
      return envName ? Deno.env.get(envName) : undefined;
    },
    recordCall: async (row: SmokeCallRow) => {
      await client.from('ai_calls').insert({
        provider: row.provider,
        model: row.model,
        purpose: 'extraction',
        status: row.status,
        latency_ms: row.latencyMs,
        synthetic: true,
        is_probe: false,
      });
    },
    now: () => Date.now(),
  }).then((result) => {
    console.log('AI provider smoke test:');
    for (const line of formatResults(result)) console.log(line);
    if (!result.ok) {
      console.error('\nsmoke: FAILED — not promoting Edge Functions.');
      Deno.exit(1);
    }
    console.log('\nsmoke: all providers OK.');
  });
}

if (import.meta.main) {
  await main();
}
