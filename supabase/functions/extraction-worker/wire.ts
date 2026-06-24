/**
 * wire.ts — production wiring for the extraction-worker (T-418).
 *
 * Assembles the real OCR + AI provider chains from env secrets, the parser
 * loader and the Storage download. Kept out of index.ts so the worker loop can
 * be unit-tested with these collaborators injected as fakes.
 *
 * Provider chains (spec §7.3 / §7.5): OCR = [ocr_space, google_vision];
 * AI = [gemini, groq]. A provider whose API key is absent is dropped from the
 * chain (so a single configured provider still works); an empty chain simply
 * surfaces NoProviderAvailableError at call time. Models / endpoints / daily
 * limits use env overrides with sensible defaults (TODO: migrate the knobs to
 * extraction.* app_settings, like the layer1/confidence thresholds).
 */

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
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

/** Build the OCR provider chain from env (ocr_space → google_vision). */
export function buildOcrClient(client: SupabaseClient) {
  const chain: OcrChainEntry[] = [];
  const ocrSpaceKey = env('OCR_SPACE_API_KEY');
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
  const visionKey = env('GOOGLE_VISION_API_KEY');
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

/** Build the AI provider chain from env (gemini → groq). */
export function buildAiClient(client: SupabaseClient) {
  const chain: AiChainEntry[] = [];
  const prompt = getPrompt(INVOICE_PROMPT_KEY);
  const geminiKey = env('GEMINI_API_KEY');
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
  const groqKey = env('GROQ_API_KEY');
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
export function defaultRunExtraction(
  input: OrchestrateInput,
  client: SupabaseClient,
): Promise<ExtractionOutcome> {
  return orchestrate(input, {
    ocrClient: buildOcrClient(client),
    aiClient: buildAiClient(client),
  });
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
