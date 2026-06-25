/**
 * wire.ts — production wiring for the extraction-worker (T-418, T-403).
 *
 * Assembles the real OCR + AI provider chains, the parser loader and the Storage
 * download. Kept out of index.ts so the worker loop can be unit-tested with these
 * collaborators injected as fakes.
 *
 * Provider chains (spec §7.3 / §7.5): OCR = [ocr_space, google_vision];
 * AI = [gemini, groq]. API keys are resolved VAULT-FIRST, ENV-FALLBACK (T-403):
 * read app_settings.*.api_key_secret_id → getVaultSecret(); if the secret is
 * unset (placeholder uuid / placeholder value) or the read fails, fall back to
 * the provider env var. A provider with no key from either source is dropped
 * from the chain (a single configured provider still works). Models / endpoints
 * / daily limits use env overrides with sensible defaults.
 */

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { getGlobalConfig, readConfig } from '../_shared/config.ts';
import { getVaultSecret } from '../_shared/vault.ts';
import { createOcrClient, type OcrChainEntry } from '../_shared/ocr/ocr_client.ts';
import { createOcrSpaceProvider } from '../_shared/ocr/providers/ocr_space.ts';
import { createGoogleVisionProvider } from '../_shared/ocr/providers/google_vision.ts';
import { type AiChainEntry, createAiClient } from '../_shared/ai/ai_client.ts';
import { createGeminiProvider } from '../_shared/ai/providers/gemini.ts';
import { createGroqProvider } from '../_shared/ai/providers/openai_compat.ts';
import { getPrompt, INVOICE_PROMPT_KEY } from '../_shared/ai/prompt_registry.ts';
import { orchestrate, type OrchestrateInput } from './orchestrate.ts';
import type { ExtractionOutcome } from './payload.ts';
import type { UtilityParser } from './layers/layer3_regex.ts';

const env = (k: string): string | undefined => Deno.env.get(k);
const envNum = (k: string, d: number): number => {
  const v = Deno.env.get(k);
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
};

const OCR_TIMEOUT_MS = 30_000;
const AI_TIMEOUT_MS = 30_000;

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
// The placeholder VALUE the vault-setup migration stores until ops injects the
// real key (see 20260624130000_vault_setup_extraction_keys.sql) — treated as
// "unset" so resolution falls through to the env var.
const VAULT_PLACEHOLDER = 'SET_VIA_update_vault_secret_AT_DEPLOY';

/**
 * Resolve a provider API key VAULT-FIRST, ENV-FALLBACK: if app_settings holds a
 * real (non-placeholder) secret uuid, decrypt it; a placeholder/missing/failed
 * vault read falls through to the env var. Never throws.
 */
async function resolveApiKey(
  cfg: Map<string, unknown>,
  secretIdKey: string,
  envName: string,
  client: SupabaseClient,
): Promise<string | undefined> {
  const secretId = readConfig<string | null>(cfg, secretIdKey, null);
  if (secretId && secretId !== NIL_UUID) {
    try {
      const v = await getVaultSecret(secretId, { client });
      if (v && v !== VAULT_PLACEHOLDER) return v;
    } catch {
      // vault miss / decrypt failure → env fallback below
    }
  }
  return env(envName);
}

/** Build the OCR provider chain (ocr_space → google_vision). */
export async function buildOcrClient(client: SupabaseClient) {
  const cfg = await getGlobalConfig([
    'extraction.ocr_space.api_key_secret_id',
    'extraction.google_vision.api_key_secret_id',
  ], { client });

  const chain: OcrChainEntry[] = [];
  const ocrSpaceKey = await resolveApiKey(
    cfg,
    'extraction.ocr_space.api_key_secret_id',
    'OCR_SPACE_API_KEY',
    client,
  );
  if (ocrSpaceKey) {
    chain.push({
      provider: createOcrSpaceProvider({
        endpoint: env('OCR_SPACE_ENDPOINT') ?? 'https://api.ocr.space/parse/image',
        language: env('OCR_SPACE_LANGUAGE') ?? 'por',
        engine: envNum('OCR_SPACE_ENGINE', 2),
        timeoutMs: OCR_TIMEOUT_MS,
      }, { fetch, apiKey: ocrSpaceKey }),
      dailyLimit: envNum('OCR_SPACE_DAILY_LIMIT', 25_000),
    });
  }
  const visionKey = await resolveApiKey(
    cfg,
    'extraction.google_vision.api_key_secret_id',
    'GOOGLE_VISION_API_KEY',
    client,
  );
  if (visionKey) {
    chain.push({
      provider: createGoogleVisionProvider({
        endpoint: env('GOOGLE_VISION_ENDPOINT') ??
          'https://vision.googleapis.com/v1/images:annotate',
        languageHints: (env('GOOGLE_VISION_LANGS') ?? 'pt').split(','),
        feature: 'DOCUMENT_TEXT_DETECTION',
        timeoutMs: OCR_TIMEOUT_MS,
      }, { fetch, apiKey: visionKey }),
      dailyLimit: envNum('GOOGLE_VISION_DAILY_LIMIT', 1_000),
    });
  }
  return createOcrClient({ chain, client });
}

/** Build the AI provider chain (gemini → groq). */
export async function buildAiClient(client: SupabaseClient) {
  const cfg = await getGlobalConfig([
    'ai.gemini.api_key_secret_id',
    'ai.groq.api_key_secret_id',
  ], { client });
  const prompt = getPrompt(INVOICE_PROMPT_KEY);

  const chain: AiChainEntry[] = [];
  const geminiKey = await resolveApiKey(
    cfg,
    'ai.gemini.api_key_secret_id',
    'GEMINI_API_KEY',
    client,
  );
  if (geminiKey) {
    chain.push({
      provider: createGeminiProvider({
        model: env('GEMINI_MODEL') ?? 'gemini-2.0-flash-001',
        prompt,
        timeoutMs: AI_TIMEOUT_MS,
      }, { fetch, apiKey: geminiKey }),
      dailyLimit: envNum('GEMINI_DAILY_LIMIT', 1_500),
    });
  }
  const groqKey = await resolveApiKey(cfg, 'ai.groq.api_key_secret_id', 'GROQ_API_KEY', client);
  if (groqKey) {
    chain.push({
      provider: createGroqProvider({
        model: env('GROQ_MODEL') ?? 'llama-3.3-70b-versatile',
        prompt,
        timeoutMs: AI_TIMEOUT_MS,
      }, { fetch, apiKey: groqKey }),
      dailyLimit: envNum('GROQ_DAILY_LIMIT', 14_400),
    });
  }
  return createAiClient({ chain, client });
}

/** Default production cascade: real OCR + AI clients over orchestrate(). */
export async function defaultRunExtraction(
  input: OrchestrateInput,
  client: SupabaseClient,
): Promise<ExtractionOutcome> {
  const [ocrClient, aiClient] = await Promise.all([buildOcrClient(client), buildAiClient(client)]);
  return orchestrate(input, { ocrClient, aiClient });
}

/** Load the active utility parsers (the columns map 1:1 onto UtilityParser). */
export async function defaultLoadParsers(client: SupabaseClient): Promise<UtilityParser[]> {
  const { data, error } = await client
    .from('utility_parsers')
    .select(
      'utility_key, default_category, sender_patterns, subject_patterns, body_must_contain, ' +
        'amount_regex, due_date_regex, due_date_format, barcode_regex, pix_regex, reference_regex, ' +
        'installation_regex, customer_name_regex, service_address_regex',
    )
    .eq('active', true);
  if (error) throw new Error(`loadParsers failed: ${error.message}`);
  return (data ?? []) as unknown as UtilityParser[];
}

/** Download the invoice PDF bytes from Storage. */
export async function defaultDownloadPdf(
  client: SupabaseClient,
  bucket: string,
  path: string,
): Promise<Uint8Array> {
  const { data, error } = await client.storage.from(bucket).download(path);
  if (error || !data) {
    throw new Error(`downloadPdf failed (${bucket}/${path}): ${error?.message ?? 'no data'}`);
  }
  return new Uint8Array(await data.arrayBuffer());
}
