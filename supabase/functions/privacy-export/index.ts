/**
 * privacy-export — POST /privacy/export-my-data (JWT user).
 *
 * LGPD data portability (art.18 V). Builds a zip of strictly the caller's own
 * data (§9.4 / BR-020), uploads it to the private-exports bucket, and returns a
 * 24h signed URL. Rate-limited to 1/day/user (BR-019).
 *
 * Ref:  T-608 (#118), spec §9.4 + §E (export-my-data), BR-019, BR-020.
 * Date: 2026-06-25
 *
 * Flow (inside the rate-limit window — withRateLimit consumes the daily token
 * up front, then runs the body):
 *   1. method gate (POST)                         → 405
 *   2. JWT → caller { id, email }                 → 401
 *   3. rateLimit('export_my_data', 1/day)         → 429 on the 2nd call/day
 *   4. collect §9.4 data + owned-PDF refs (parallel)
 *   5. assemble entries: <category>.json × 8 + README.md + invoice_pdfs/*.pdf
 *      (a PDF that 404s in Storage is skipped, never fatal)
 *   6. buildZip(entries, { maxBytes: 500MB })     → 413 (ExportTooLargeError)
 *   7. upload exports/{userId}/{ts}.zip → createSignedUrl(86400s)
 *   8. emit privacy.export.completed (best-effort)
 *   9. 200 { download_url, expires_at }
 *
 * Every collaborator is injected (buildHandler) so the handler is unit-tested
 * with no real Storage / DB / Auth; production defaults are wired at the bottom.
 */

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { withCorrelation } from '../_shared/correlation.ts';
import { buildServiceClient } from '../_shared/lockout.ts';
import { getCallerUser } from '../_shared/auth.ts';
import { type RateLimitWindow, withRateLimit } from '../_shared/rateLimit.ts';
import { RateLimitError } from '../_shared/errors.ts';
import { type DomainEventInput, emitDomainEvent } from '../_shared/events.ts';
import { redactSecrets } from '../_shared/redact.ts';
import { log } from '../_shared/logging.ts';
import {
  type Caller,
  collectExportData,
  type ExportData,
  listOwnedPdfRefs,
  type PdfRef,
} from './scoped_queries.ts';
import { buildZip, DEFAULT_MAX_BYTES, ExportTooLargeError, type ZipEntry } from './zip_builder.ts';

export const EXPORTS_BUCKET = 'private-exports';
const SIGNED_URL_TTL_SEC = 86_400; // 24h (spec §9.4)

export const EXPORT_README = [
  '# Exportação de dados — Unibill',
  '',
  'Esta exportação contém apenas os SEUS dados pessoais. Dados de outros membros',
  'da sua família/household NÃO estão incluídos, conforme a LGPD.',
  '',
  '## Conteúdo',
  '',
  '- `profile.json` — seu perfil (id, email, display_name, preferências).',
  '- `households.json` — households em que você participa (nome, seu papel, data de entrada).',
  '- `members.json` — sua(s) linha(s) de participação.',
  '- `connected_emails.json` — emails que você conectou (sem a senha de app).',
  '- `invoices.json` — faturas com as quais você interagiu (pagou/criou/atualizou).',
  '- `consent_log.json` — seu histórico de consentimentos.',
  '- `domain_events.json` — eventos onde você foi o ator (últimos 90 dias).',
  '- `client_telemetry.json` — sua telemetria de cliente (últimos 30 dias).',
  '- `invoice_pdfs/` — PDFs das faturas vindas dos emails que você conectou.',
  '',
  'Link de download válido por 24 horas.',
  '',
].join('\n');

export type EmitEventFn = (e: DomainEventInput) => Promise<void>;

export type HandlerDeps = {
  getCallerUser: (req: Request) => Promise<Caller | null>;
  client?: SupabaseClient;
  /** Wraps the export body in the 1/day rate limit. Default: withRateLimit. */
  rateLimit?: <T>(userId: string, fn: () => Promise<T>) => Promise<T>;
  collect?: (caller: Caller, client: SupabaseClient, nowMs: number) => Promise<ExportData>;
  listPdfs?: (userId: string, client: SupabaseClient) => Promise<PdfRef[]>;
  /** Returns the PDF bytes, or null when the object is gone (skipped). */
  downloadPdf?: (client: SupabaseClient, ref: PdfRef) => Promise<Uint8Array | null>;
  upload?: (client: SupabaseClient, path: string, bytes: Uint8Array) => Promise<void>;
  sign?: (client: SupabaseClient, path: string, expiresInSec: number) => Promise<string>;
  emitEvent?: EmitEventFn;
  now?: () => number;
  maxBytes?: number;
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Two-digit zero-pad. */
function p2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `exports/{userId}/{YYYYMMDDHHMMSS}.zip` (UTC). */
export function exportObjectPath(userId: string, nowMs: number): string {
  const d = new Date(nowMs);
  const ts = `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}` +
    `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`;
  return `exports/${userId}/${ts}.zip`;
}

// --- production default collaborators ---------------------------------------

const defaultDownloadPdf = async (
  client: SupabaseClient,
  ref: PdfRef,
): Promise<Uint8Array | null> => {
  const { data, error } = await client.storage.from(ref.bucket).download(ref.path);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
};

const defaultUpload = async (
  client: SupabaseClient,
  path: string,
  bytes: Uint8Array,
): Promise<void> => {
  const { error } = await client.storage.from(EXPORTS_BUCKET).upload(path, bytes, {
    contentType: 'application/zip',
    upsert: false, // path carries a timestamp → never collides
  });
  if (error) throw new Error(`export upload failed: ${error.message}`);
};

const defaultSign = async (
  client: SupabaseClient,
  path: string,
  expiresInSec: number,
): Promise<string> => {
  const { data, error } = await client.storage
    .from(EXPORTS_BUCKET)
    .createSignedUrl(path, expiresInSec);
  if (error || !data?.signedUrl) {
    throw new Error(`export signed-url failed: ${error?.message ?? 'no url'}`);
  }
  return data.signedUrl;
};

// --- handler ----------------------------------------------------------------

export function buildHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const collect = deps.collect ?? collectExportData;
  const listPdfs = deps.listPdfs ?? listOwnedPdfRefs;
  const downloadPdf = deps.downloadPdf ?? defaultDownloadPdf;
  const upload = deps.upload ?? defaultUpload;
  const sign = deps.sign ?? defaultSign;
  const now = deps.now ?? (() => Date.now());
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;

  return withCorrelation(async (ctx, req) => {
    if (req.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' });

    const caller = await deps.getCallerUser(req);
    if (!caller) {
      return jsonResponse(401, { error: 'unauthorized', detail: 'missing or invalid JWT' });
    }

    const client = deps.client ?? buildServiceClient();
    // Client-dependent defaults are resolved here so the injected client (or the
    // service-role default) reaches the rate limiter and the event emitter.
    const rateLimit = deps.rateLimit ??
      (<T>(userId: string, fn: () => Promise<T>) =>
        withRateLimit(
          'export_my_data',
          userId,
          { window: '1day' as RateLimitWindow, limit: 1 },
          fn,
          { client },
        ));
    const emitEvent = deps.emitEvent ?? ((e: DomainEventInput) => emitDomainEvent(e, { client }));

    try {
      return await rateLimit(caller.id, async () => {
        const nowMs = now();
        const [data, pdfRefs] = await Promise.all([
          collect(caller, client, nowMs),
          listPdfs(caller.id, client),
        ]);

        const enc = new TextEncoder();
        const entries: ZipEntry[] = [];
        const addJson = (name: string, value: unknown) =>
          entries.push({ name, data: enc.encode(JSON.stringify(value, null, 2)) });
        addJson('profile.json', data.profile);
        addJson('households.json', data.households);
        addJson('members.json', data.members);
        addJson('connected_emails.json', data.connected_emails);
        addJson('invoices.json', data.invoices);
        addJson('consent_log.json', data.consent_log);
        addJson('domain_events.json', data.domain_events);
        addJson('client_telemetry.json', data.client_telemetry);
        entries.push({ name: 'README.md', data: enc.encode(EXPORT_README) });

        let pdfCount = 0;
        for (const ref of pdfRefs) {
          const bytes = await downloadPdf(client, ref);
          if (bytes) {
            entries.push({ name: ref.entryName, data: bytes });
            pdfCount++;
          }
        }

        const zip = await buildZip(entries, { maxBytes });
        const path = exportObjectPath(caller.id, nowMs);
        await upload(client, path, zip);
        const download_url = await sign(client, path, SIGNED_URL_TTL_SEC);
        const expires_at = new Date(nowMs + SIGNED_URL_TTL_SEC * 1000).toISOString();

        try {
          await emitEvent({
            type: 'privacy.export.completed',
            aggregate_type: 'user',
            aggregate_id: caller.id,
            correlation_id: ctx.correlation_id,
            actor_type: 'user',
            actor_user_id: caller.id,
            payload: {
              version: 1,
              data: { path, expires_at, bytes: zip.length, pdf_count: pdfCount },
            },
          });
        } catch (e) {
          log.warn('privacy-export: event emit failed (non-fatal)', {
            correlation_id: ctx.correlation_id,
            err: redactSecrets(e instanceof Error ? e.message : String(e)),
          });
        }

        log.info('privacy-export: export completed', {
          correlation_id: ctx.correlation_id,
          user_id: caller.id,
          bytes: zip.length,
          pdf_count: pdfCount,
        });
        return jsonResponse(200, { download_url, expires_at });
      });
    } catch (e) {
      if (e instanceof RateLimitError) {
        return jsonResponse(429, { error: 'rate_limited', detail: '1 export per day' });
      }
      if (e instanceof ExportTooLargeError) {
        return jsonResponse(413, { error: 'export_too_large', detail: 'export exceeds 500MB' });
      }
      log.error('privacy-export: export failed', {
        correlation_id: ctx.correlation_id,
        err: redactSecrets(e instanceof Error ? e.message : String(e)),
      });
      return jsonResponse(500, { error: 'internal_error', code: 'export_failed' });
    }
  });
}

// --- bootstrap (production) -------------------------------------------------

export const handler = buildHandler({
  getCallerUser: (req: Request) => getCallerUser(req),
});

if (import.meta.main) {
  Deno.serve(handler);
}
