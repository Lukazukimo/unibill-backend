/**
 * ai/prompt_registry.ts — hot-swappable registry of prompt templates.
 *
 * Ref:  T-414, spec §7.5 (prompt template registry)
 * Date: 2026-06-24
 *
 * Prompt text is operational config, not code: the worker loads
 * `extraction.invoice_prompt` from app_settings and registers it here at
 * startup (hot-swap — change the prompt via config, no redeploy). Providers are
 * given the RESOLVED template string (DI), so they never read this global; the
 * registry is the worker's resolution + default-fallback utility.
 */

/** Conservative built-in fallback (prod overrides via app_settings). */
export const DEFAULT_INVOICE_PROMPT =
  'Extraia os seguintes campos desta fatura brasileira e retorne JSON estrito ' +
  '(sem comentarios): {amount_cents: int (valor total em centavos), due_date: ' +
  'ISO-8601 (YYYY-MM-DD), barcode: string (linha digitavel, somente digitos), ' +
  'pix_payload: string (BR Code copia-e-cola), issuer_name: string, ' +
  'customer_name: string, customer_document: string, confidence: float [0..1] ' +
  '(sua confianca na extracao)}. Use null para campos ausentes.';

export const INVOICE_PROMPT_KEY = 'invoice';

const registry = new Map<string, string>([[INVOICE_PROMPT_KEY, DEFAULT_INVOICE_PROMPT]]);

/** Register/replace a prompt template (hot-swap). Empty templates are ignored. */
export function registerPrompt(key: string, template: string): void {
  if (typeof template === 'string' && template.trim().length > 0) {
    registry.set(key, template);
  }
}

/** Resolve a prompt template; falls back to the built-in invoice prompt. */
export function getPrompt(key: string): string {
  return registry.get(key) ?? DEFAULT_INVOICE_PROMPT;
}

export function hasPrompt(key: string): boolean {
  return registry.has(key);
}

/** Combine a template with the invoice text into the final model input. */
export function buildExtractionPrompt(template: string, invoiceText: string): string {
  return `${template}\n\n---\nTEXTO DA FATURA:\n${invoiceText}`;
}
