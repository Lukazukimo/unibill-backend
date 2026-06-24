/**
 * ai/providers/openai_compat.ts — Groq (T-413) + OpenRouter (T-414) providers.
 *
 * Ref:  T-413 / T-414, spec §7.5 (Groq, OpenRouter — OpenAI-compatible chat)
 * Date: 2026-06-24
 *
 * Both speak the OpenAI /chat/completions shape with json_object response
 * format, so they share one factory. OpenRouter is DISABLED by default — its
 * provider exists but the chain only includes it when ai.openrouter.enabled is
 * true (the chain config decides; the provider itself is always constructible).
 * Bearer auth (key in the Authorization header, never URL/logs).
 */

import type { AiCallContext, AiExtractResult, AiProvider, AiProviderName } from '../types.ts';
import { parseAiExtraction } from '../extract_schema.ts';
import { buildExtractionPrompt } from '../prompt_registry.ts';
import { OcrHttpError, OcrInvalidResponseError } from '../../ocr/classify_error.ts';
import { redactSecrets } from '../../redact.ts';

export const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export interface OpenAiCompatConfig {
  endpoint: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  /** Extra headers (OpenRouter uses HTTP-Referer / X-Title). */
  extraHeaders?: Record<string, string>;
}

export interface OpenAiCompatDeps {
  fetch: typeof fetch;
  apiKey: string;
}

function truncate(s: string, n = 500): string {
  return s.length > n ? s.slice(0, n) : s;
}

/** Pull the JSON text out of an OpenAI-style chat completion. */
export function extractOpenAiText(json: unknown): string {
  // deno-lint-ignore no-explicit-any
  const content = (json as any)?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new OcrInvalidResponseError('OpenAI-compat: no choice content in response');
  }
  return content;
}

function createOpenAiCompatProvider(
  name: AiProviderName,
  cfg: OpenAiCompatConfig,
  deps: OpenAiCompatDeps,
): AiProvider {
  return {
    name,
    model: cfg.model,
    async extractStructured(text: string, _ctx: AiCallContext): Promise<AiExtractResult> {
      const body = {
        model: cfg.model,
        messages: [
          {
            role: 'system',
            content: 'You are a strict JSON invoice-field extractor. Reply with JSON only.',
          },
          { role: 'user', content: buildExtractionPrompt(cfg.prompt, text) },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
      };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
      try {
        const res = await deps.fetch(cfg.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${deps.apiKey}`,
            ...cfg.extraHeaders,
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          let snippet = '';
          try {
            snippet = redactSecrets(truncate(await res.text()));
          } catch { /* ignore */ }
          throw new OcrHttpError(res.status, `${name} HTTP ${res.status}`, snippet);
        }
        let json: unknown;
        try {
          json = await res.json();
        } catch {
          throw new OcrInvalidResponseError(`${name}: response was not valid JSON`);
        }
        return parseAiExtraction(extractOpenAiText(json));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface GroqConfig {
  model: string;
  prompt: string;
  timeoutMs: number;
  endpoint?: string;
}

export function createGroqProvider(cfg: GroqConfig, deps: OpenAiCompatDeps): AiProvider {
  return createOpenAiCompatProvider(
    'groq',
    {
      endpoint: cfg.endpoint ?? GROQ_ENDPOINT,
      model: cfg.model,
      prompt: cfg.prompt,
      timeoutMs: cfg.timeoutMs,
    },
    deps,
  );
}

export interface OpenRouterConfig {
  model: string;
  prompt: string;
  timeoutMs: number;
  endpoint?: string;
  referer?: string;
  title?: string;
}

export function createOpenRouterProvider(
  cfg: OpenRouterConfig,
  deps: OpenAiCompatDeps,
): AiProvider {
  const extraHeaders: Record<string, string> = {};
  if (cfg.referer) extraHeaders['HTTP-Referer'] = cfg.referer;
  if (cfg.title) extraHeaders['X-Title'] = cfg.title;
  return createOpenAiCompatProvider(
    'openrouter',
    {
      endpoint: cfg.endpoint ?? OPENROUTER_ENDPOINT,
      model: cfg.model,
      prompt: cfg.prompt,
      timeoutMs: cfg.timeoutMs,
      extraHeaders,
    },
    deps,
  );
}
