/**
 * ai_calls.ts — best-effort writer for the public.ai_calls observability table.
 *
 * Ref:  T-409, spec §5.6 / §7.3 (ai_calls reused for OCR, purpose='ocr')
 * Date: 2026-06-24
 *
 * One row per IA/OCR provider attempt. Best-effort: a logging failure is warned,
 * never thrown — observability must not break the extraction path. Shared by the
 * OCR chain (T-409) and, later, the AI chain (T-416).
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { log } from './logging.ts';

/** A row to insert into public.ai_calls. status must be in chk_ai_calls_status. */
export interface AiCallRow {
  provider: string;
  model?: string | null;
  purpose: 'extraction' | 'categorization' | 'chat' | 'ocr';
  invoice_id?: string | null;
  household_id?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  pages_processed?: number | null;
  latency_ms?: number | null;
  status: string;
  error_summary?: string | null;
  chain_state_at_call?: string | null;
  is_probe?: boolean;
  synthetic?: boolean;
  correlation_id?: string | null;
}

export interface AiCallWriterDeps {
  /** Service-role client override (tests inject a fake). */
  client?: SupabaseClient;
}

function buildServiceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Insert one ai_calls row. Best-effort — warns and swallows on failure. */
export async function insertAiCall(row: AiCallRow, deps?: AiCallWriterDeps): Promise<void> {
  const client = deps?.client ?? buildServiceClient();
  try {
    const { error } = await client.from('ai_calls').insert(
      row as unknown as Record<string, unknown>,
    );
    if (error) {
      log.warn('insertAiCall failed', {
        provider: row.provider,
        status: row.status,
        err: error.message,
      });
    }
  } catch (err) {
    log.warn('insertAiCall threw', {
      provider: row.provider,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
