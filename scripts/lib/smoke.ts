/**
 * smoke.ts — deploy-time AI provider smoke test core (T-419).
 *
 * Ref:  T-419 (#66), spec §7.5 (smoke test deploy) + §11.5
 *
 * Reads the extraction provider chain from app_settings, pings each configured
 * provider with a 1-token 'ping', and fails LOUDLY on any non-200 (especially a
 * 404 for a deprecated model) so a bad model id is caught at deploy time instead
 * of silently failing every extraction in prod. Each real ping is recorded in
 * ai_calls with synthetic=true (cost attributable, excluded from quality metrics).
 *
 * The core (`runSmoke`) is PURE of I/O — config read, the per-provider ping and
 * the ai_calls write are all injected, so it is unit-tested without network or a
 * DB. `defaultPing` is the real HTTP wiring used by the entrypoint.
 */

import { readConfig } from '../../supabase/functions/_shared/config.ts';

/** Sentinel for ai.<provider>.model that MUST be overridden before deploy. */
export const SENTINEL = 'TBD_SET_AT_DEPLOY';

const PING_TIMEOUT_MS = 15_000;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export type PingResult = { httpStatus: number };
export type Ping = (provider: string, model: string, apiKey: string) => Promise<PingResult>;

export type SmokeCallRow = {
  provider: string;
  model: string;
  status: 'success' | 'error';
  httpStatus: number | null;
  latencyMs: number;
};

export interface SmokeDeps {
  /** Loads the given app_settings keys (global scope). */
  getConfig: (keys: string[]) => Promise<Map<string, unknown>>;
  /** Performs the 1-token liveness call against a provider. */
  ping: Ping;
  /** Records a synthetic ai_calls row (best-effort — never fails the smoke). */
  recordCall: (row: SmokeCallRow) => Promise<void>;
  /** Resolves the API key for a provider (from env in production). */
  apiKeyFor: (provider: string) => string | undefined;
  now: () => number;
}

export type ProviderResult = {
  provider: string;
  model: string | null;
  ok: boolean;
  httpStatus?: number;
  reason?: string;
};

export type SmokeResult = { ok: boolean; results: ProviderResult[] };

/**
 * Pings every provider in `ai.providers.extraction.chain`. A provider passes
 * only on HTTP 200. The sentinel model, a missing model and a missing API key
 * are immediate (no-call) failures. Returns ok=true only when the chain is
 * non-empty and every provider passed.
 */
export async function runSmoke(deps: SmokeDeps): Promise<SmokeResult> {
  const cfg = await deps.getConfig([
    'ai.providers.extraction.chain',
    'ai.gemini.model',
    'ai.groq.model',
    'ai.openrouter.model',
  ]);
  const chain = readConfig<string[]>(cfg, 'ai.providers.extraction.chain', []);
  const results: ProviderResult[] = [];

  for (const provider of chain) {
    const model = readConfig<string | null>(cfg, `ai.${provider}.model`, null);

    if (!model) {
      results.push({
        provider,
        model: null,
        ok: false,
        reason: `no ai.${provider}.model configured`,
      });
      continue;
    }
    if (model === SENTINEL) {
      results.push({
        provider,
        model,
        ok: false,
        reason:
          `ai.${provider}.model is the ${SENTINEL} sentinel — set the real model before deploy`,
      });
      continue;
    }
    const apiKey = deps.apiKeyFor(provider);
    if (!apiKey) {
      results.push({ provider, model, ok: false, reason: `no API key for provider ${provider}` });
      continue;
    }

    const started = deps.now();
    let result: ProviderResult;
    let httpStatus: number | null = null;
    try {
      const ping = await deps.ping(provider, model, apiKey);
      httpStatus = ping.httpStatus;
      if (ping.httpStatus === 200) {
        result = { provider, model, ok: true, httpStatus: 200 };
      } else if (ping.httpStatus === 404) {
        result = {
          provider,
          model,
          ok: false,
          httpStatus: 404,
          reason:
            `Provider ${provider} model ${model} not available (HTTP 404). Update ai.${provider}.model in app_settings.`,
        };
      } else {
        result = {
          provider,
          model,
          ok: false,
          httpStatus: ping.httpStatus,
          reason: `Provider ${provider} model ${model} returned HTTP ${ping.httpStatus}.`,
        };
      }
    } catch (e) {
      result = {
        provider,
        model,
        ok: false,
        reason: `Provider ${provider} model ${model} call failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      };
    }
    results.push(result);
    await deps.recordCall({
      provider,
      model,
      status: result.ok ? 'success' : 'error',
      httpStatus,
      latencyMs: deps.now() - started,
    }).catch(() => {});
  }

  const ok = results.length > 0 && results.every((r) => r.ok);
  return { ok, results };
}

/** Real per-provider 1-token ping (gemini generateContent / OpenAI-compat chat). */
export const defaultPing: Ping = async (provider, model, apiKey) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS);
  try {
    if (provider === 'gemini') {
      const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
        signal: ctrl.signal,
      });
      return { httpStatus: res.status };
    }
    if (provider === 'groq' || provider === 'openrouter') {
      const endpoint = provider === 'groq' ? GROQ_ENDPOINT : OPENROUTER_ENDPOINT;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
        signal: ctrl.signal,
      });
      return { httpStatus: res.status };
    }
    throw new Error(`unsupported provider '${provider}'`);
  } finally {
    clearTimeout(timer);
  }
};

/** Human-readable lines for the entrypoint's stdout. */
export function formatResults(result: SmokeResult): string[] {
  return result.results.map((r) =>
    r.ok
      ? `  ✓ ${r.provider} (${r.model}) — HTTP 200`
      : `  ✗ ${r.provider} (${r.model ?? 'no model'}) — ${r.reason}`
  );
}
