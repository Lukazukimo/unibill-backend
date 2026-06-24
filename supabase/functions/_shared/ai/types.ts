/**
 * ai/types.ts — shared contract for the Layer 4 AI extraction providers.
 *
 * Ref:  T-412, spec §7.5 (Layer 4 — AI provider chain)
 * Date: 2026-06-24
 *
 * Layer 4 is the AI fallback: when the deterministic layers (pdfjs/OCR text +
 * regex) don't capture the required fields, an LLM extracts them as strict JSON.
 * Each provider (Gemini → Groq → OpenRouter) is built by a factory that bakes in
 * the model + prompt + decrypted key + injected fetch; the chain/breaker/ai_calls
 * logging live in the AiClient (T-416) and the shared chain breaker (T-415).
 */

export type AiProviderName = 'gemini' | 'groq' | 'openrouter';

export const AI_PROVIDER_NAMES: readonly AiProviderName[] = [
  'gemini',
  'groq',
  'openrouter',
] as const;

/** The structured invoice fields an AI provider returns (spec §7.5 prompt). */
export interface AiExtractedFields {
  /** Total amount in integer cents. */
  amount_cents?: number;
  /** ISO-8601 yyyy-mm-dd. */
  due_date?: string;
  /** Boleto "linha digitável" (digits only). */
  barcode?: string;
  /** PIX BR-Code copia-e-cola. */
  pix_payload?: string;
  issuer_name?: string;
  customer_name?: string;
  customer_document?: string;
}

export interface AiExtractResult {
  fields: AiExtractedFields;
  /** The model's self-reported confidence [0,1] (its JSON "confidence" field). */
  selfReported: number;
  /** Raw parsed JSON, for debugging only — redactDeep before any log. */
  raw?: unknown;
}

/** Per-call routing/logging context. */
export interface AiCallContext {
  correlation_id: string;
  invoice_id: string | null;
  household_id: string | null;
}

/** The contract each provider (T-412/T-413/T-414) implements. */
export interface AiProvider {
  readonly name: AiProviderName;
  readonly model: string;
  /**
   * Extract structured invoice fields from `text`. Resolves with the fields +
   * the model's self-reported confidence, or THROWS a value classifyOcrError()
   * (the shared §7.5.1 classifier) maps to a provider status.
   */
  extractStructured(text: string, ctx: AiCallContext): Promise<AiExtractResult>;
}
