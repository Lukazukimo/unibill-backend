/**
 * ai/providers/gemini.ts — GeminiProvider (primary AI extraction provider).
 *
 * Ref:  T-412, spec §7.5 (Gemini 2.0 Flash, structured output)
 * Date: 2026-06-24
 *
 * Calls Gemini generateContent with responseSchema for strict JSON output.
 * PURE-ish/DI: model + prompt + decrypted key + fetch injected; no DB/vault/
 * network in unit tests. Key via the x-goog-api-key header (never URL/logs).
 */

import type { AiCallContext, AiExtractResult, AiProvider } from '../types.ts';
import { EXTRACTION_RESPONSE_SCHEMA, parseAiExtraction } from '../extract_schema.ts';
import { buildExtractionPrompt } from '../prompt_registry.ts';
import { OcrHttpError, OcrInvalidResponseError } from '../../ocr/classify_error.ts';
import { redactSecrets } from '../../redact.ts';

export const GEMINI_NAME = 'gemini' as const;
const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiConfig {
  model: string; // e.g. 'gemini-2.0-flash-001'
  prompt: string; // resolved invoice prompt template
  timeoutMs: number;
  baseUrl?: string;
}

export interface GeminiDeps {
  fetch: typeof fetch;
  apiKey: string;
}

function truncate(s: string, n = 500): string {
  return s.length > n ? s.slice(0, n) : s;
}

/** Pull the JSON text out of a Gemini generateContent response. */
export function extractGeminiText(json: unknown): string {
  // deno-lint-ignore no-explicit-any
  const j = json as any;
  if (j?.promptFeedback?.blockReason) {
    throw new OcrInvalidResponseError(`Gemini blocked: ${j.promptFeedback.blockReason}`);
  }
  const text = j?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new OcrInvalidResponseError('Gemini: no candidate text in response');
  }
  return text;
}

export function createGeminiProvider(cfg: GeminiConfig, deps: GeminiDeps): AiProvider {
  const base = cfg.baseUrl ?? DEFAULT_BASE;
  const url = `${base}/models/${cfg.model}:generateContent`;
  return {
    name: GEMINI_NAME,
    model: cfg.model,
    async extractStructured(text: string, _ctx: AiCallContext): Promise<AiExtractResult> {
      const body = {
        contents: [{ parts: [{ text: buildExtractionPrompt(cfg.prompt, text) }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: EXTRACTION_RESPONSE_SCHEMA,
          temperature: 0,
        },
      };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
      try {
        const res = await deps.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': deps.apiKey },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          let snippet = '';
          try {
            snippet = redactSecrets(truncate(await res.text()));
          } catch { /* ignore */ }
          throw new OcrHttpError(res.status, `Gemini HTTP ${res.status}`, snippet);
        }
        let json: unknown;
        try {
          json = await res.json();
        } catch {
          throw new OcrInvalidResponseError('Gemini: response was not valid JSON');
        }
        return parseAiExtraction(extractGeminiText(json));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
