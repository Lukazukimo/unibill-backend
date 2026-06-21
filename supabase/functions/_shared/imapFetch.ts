/**
 * imapFetch.ts — the real IMAP fetch → capture step for the sync-worker (T-326).
 *
 * Ref: spec §6.4 (IMAP fetch, dedupe, transactional capture) + §6.5 (redaction).
 * Date: 2026-06-21
 *
 * `doImapFetch({connectedEmailId, emailAddress, correlationId, client})` opens the
 * mailbox and selects messages to process: a FIRST sync (no cursor) is bounded to
 * the `sync.first_sync_lookback_days` window via a date SEARCH; incremental syncs
 * fetch UID > `last_processed_uid`. For each PDF attachment it downloads,
 * verifies the `%PDF` magic, hashes it, dedupes by content (file_hash per
 * household), uploads to Storage, and captures the invoice atomically via
 * `app.ingest_invoice`. `last_processed_uid` advances per message.
 *
 * Dedupe is CONTENT-based only (household + file_hash): one email can carry
 * several distinct invoice PDFs, so we do NOT dedupe on Message-ID (it is stored
 * for observability). Re-processing a redelivered message is therefore safe —
 * already-captured PDFs are skipped by their file_hash.
 *
 * Security (spec §6.5): the decrypted app password lives in one local binding
 * dropped in `finally`; `client.logout()` always runs; every surfaced error
 * string is `redactSecrets()`'d.
 *
 * Test seam: inject `{ imapFactory }` (like imap.ts) so unit tests never touch
 * `npm:imapflow`; the supabase `client` is faked for DB/rpc/storage.
 */

import { redactSecrets } from './redact.ts';
import { type BodyStructureNode, findPdfParts, isPdfMagic, sha256, streamToBuffer } from './pdf.ts';
import { resolveTargetHousehold } from './household.ts';
import { getGlobalConfig, readNumberConfig } from './config.ts';
import { log } from './logging.ts';
import { type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';

export const STORAGE_BUCKET = 'invoices';

export type ImapFetchResult = {
  messages_seen: number;
  invoices_created: number;
  duplicates_skipped: number;
};

export type ImapFetchInput = {
  connectedEmailId: string;
  emailAddress: string;
  correlationId: string;
  client: SupabaseClient;
};

/** Minimal envelope/message surface we rely on from imapflow's fetch(). */
export type FetchMessage = {
  uid: number;
  envelope?: {
    date?: string | Date | null;
    subject?: string | null;
    messageId?: string | null;
    from?: Array<{ address?: string | null; name?: string | null }> | null;
  } | null;
  bodyStructure?: BodyStructureNode | null;
};

/** Narrow duck-type of `npm:imapflow`'s ImapFlow used here (easy to fake). */
export interface ImapFetchClientLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  mailboxOpen(path: string): Promise<unknown>;
  search(
    query: Record<string, unknown>,
    opts: { uid: boolean },
  ): Promise<number[] | false>;
  fetch(
    range: string,
    opts: { uid: boolean; envelope: boolean; bodyStructure: boolean },
  ): AsyncIterable<FetchMessage>;
  download(
    uid: number,
    part: string,
    opts: { uid: boolean },
  ): Promise<{ content: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> }>;
}

export type ImapFetchClientFactory = (opts: {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  logger: false;
  emitLogs: false;
  tls: { rejectUnauthorized: boolean };
}) => ImapFetchClientLike;

export type DoImapFetchDeps = {
  imapFactory?: ImapFetchClientFactory;
  now?: () => number;
  newId?: () => string;
};

async function defaultImapFactory(): Promise<ImapFetchClientFactory> {
  // deno-lint-ignore no-explicit-any
  const mod: any = await import('npm:imapflow@^1.0.166');
  const ImapFlow = mod.ImapFlow ?? mod.default?.ImapFlow ?? mod.default;
  if (typeof ImapFlow !== 'function') {
    throw new Error('imapflow: ImapFlow constructor not found');
  }
  return (opts) => new ImapFlow(opts) as ImapFetchClientLike;
}

type Mailbox = {
  id: string;
  email_address: string;
  app_password_secret: string;
  imap_host: string;
  imap_port: number;
  imap_use_tls: boolean;
  last_processed_uid: number | null;
};

export async function doImapFetch(
  input: ImapFetchInput,
  deps: DoImapFetchDeps = {},
): Promise<ImapFetchResult> {
  const { client, connectedEmailId, correlationId } = input;
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? (() => crypto.randomUUID());

  // 1) Load the mailbox (IMAP coords + cursor + Vault secret ref).
  const { data: mbRaw, error: mbErr } = await client
    .from('connected_emails')
    .select(
      'id, email_address, app_password_secret, imap_host, imap_port, imap_use_tls, last_processed_uid',
    )
    .eq('id', connectedEmailId)
    .single();
  if (mbErr || !mbRaw) {
    throw new Error(
      `doImapFetch: mailbox load failed: ${redactSecrets(mbErr?.message ?? 'not found')}`,
    );
  }
  const mb = mbRaw as Mailbox;

  // 2) Config (sizes / attachment cap / first-sync window).
  const cfg = await getGlobalConfig([
    'sync.pdf_min_size_bytes',
    'sync.pdf_max_size_bytes',
    'sync.attachment_max_per_message',
    'sync.first_sync_lookback_days',
  ], { client });
  const minSize = readNumberConfig(cfg, 'sync.pdf_min_size_bytes', 10_240);
  const maxSize = readNumberConfig(cfg, 'sync.pdf_max_size_bytes', 10_485_760);
  const attachMax = readNumberConfig(cfg, 'sync.attachment_max_per_message', 5);
  const firstSyncDays = readNumberConfig(cfg, 'sync.first_sync_lookback_days', 90);

  // 3) Decrypt the app password (single local binding, dropped in finally).
  let pass: string | null;
  {
    const { data, error } = await client.rpc('decrypt_app_password', {
      secret_id: mb.app_password_secret,
    });
    if (error || typeof data !== 'string') {
      throw new Error(
        `doImapFetch: password decrypt failed: ${redactSecrets(error?.message ?? 'no secret')}`,
      );
    }
    pass = data;
  }

  const factory = deps.imapFactory ?? (await defaultImapFactory());
  let imap: ImapFetchClientLike | null = null;
  let messagesSeen = 0;
  let invoicesCreated = 0;
  let duplicatesSkipped = 0;
  let maxUid = mb.last_processed_uid ?? 0;

  try {
    imap = factory({
      host: mb.imap_host,
      port: mb.imap_port,
      secure: mb.imap_use_tls,
      auth: { user: mb.email_address, pass: pass! },
      logger: false,
      emitLogs: false,
      tls: { rejectUnauthorized: true },
    });
    await imap.connect();
    await imap.mailboxOpen('INBOX');

    // First sync → bound to the lookback window via a date SEARCH; incremental →
    // open-ended UID range above the cursor.
    let range: string;
    if (mb.last_processed_uid === null) {
      const since = new Date(now() - firstSyncDays * 86_400_000);
      const uids = await imap.search({ since }, { uid: true });
      if (!uids || uids.length === 0) {
        return { messages_seen: 0, invoices_created: 0, duplicates_skipped: 0 };
      }
      range = uids.join(',');
    } else {
      range = `${mb.last_processed_uid + 1}:*`;
    }

    for await (
      const msg of imap.fetch(range, { uid: true, envelope: true, bodyStructure: true })
    ) {
      // imapflow's open-ended `n:*` returns at least the last message even when
      // none are newer — guard so we never reprocess <= the cursor.
      if (mb.last_processed_uid !== null && msg.uid <= mb.last_processed_uid) continue;
      messagesSeen++;

      const env = msg.envelope ?? {};
      const messageId = env.messageId ?? null;
      const sender = env.from?.[0]?.address ?? null;
      const subject = env.subject ?? null;
      const parsedDate = env.date ? new Date(env.date) : null;
      const receivedAt = parsedDate && !isNaN(parsedDate.getTime())
        ? parsedDate.toISOString()
        : new Date(now()).toISOString();

      // Content-based dedupe only: collect ALL PDF parts (an email can bundle
      // several distinct invoices). Oversized parts are skipped + logged, not
      // captured and not counted as duplicates.
      const parts = findPdfParts(msg.bodyStructure ?? undefined, {
        min_size_bytes: minSize,
        max_size_bytes: maxSize,
      }).slice(0, attachMax);

      for (const part of parts) {
        if (part.oversize) {
          log.warn('doImapFetch: oversize PDF skipped', {
            correlation_id: correlationId,
            connected_email_id: connectedEmailId,
            uid: msg.uid,
            size: part.size,
          });
          continue;
        }
        const dl = await imap.download(msg.uid, part.part, { uid: true });
        const bytes = await streamToBuffer(dl.content);
        if (!isPdfMagic(bytes)) continue; // not a real PDF — ignore

        const fileHash = await sha256(bytes);

        let householdId: string;
        try {
          householdId = await resolveTargetHousehold(connectedEmailId, { client });
        } catch (e) {
          throw new Error(
            `doImapFetch: household routing failed: ${
              redactSecrets(e instanceof Error ? e.message : String(e))
            }`,
          );
        }

        // File-level dedupe within the household (avoids an orphan upload).
        if (await fileHashSeen(client, householdId, fileHash)) {
          duplicatesSkipped++;
          continue;
        }

        const storagePath = `household-${householdId}/${receivedAt.slice(0, 7)}/${newId()}.pdf`;
        const up = await client.storage.from(STORAGE_BUCKET).upload(storagePath, bytes, {
          contentType: 'application/pdf',
          upsert: false,
        });
        if (up.error) {
          throw new Error(`doImapFetch: storage upload failed: ${redactSecrets(up.error.message)}`);
        }

        const idempotencyKey = await sha256(
          new TextEncoder().encode(`${connectedEmailId}:${messageId ?? msg.uid}:${fileHash}`),
        );
        const { data: invoiceId, error: ingErr } = await client.rpc('ingest_invoice', {
          p_household_id: householdId,
          p_connected_email_id: connectedEmailId,
          p_correlation_id: correlationId,
          p_idempotency_key: idempotencyKey,
          p_source_message_id: messageId,
          p_source_uid: msg.uid,
          p_source_received_at: receivedAt,
          p_source_sender: sender,
          p_source_subject: subject,
          p_storage_path: storagePath,
          p_file_hash: fileHash,
          p_file_size_bytes: bytes.length,
          p_mime_type: 'application/pdf',
        });
        if (ingErr || invoiceId === null) {
          // No invoice row will reference the just-uploaded object → remove it
          // (best-effort) so failures/races don't leak orphan PDFs into Storage.
          await client.storage.from(STORAGE_BUCKET).remove([storagePath]).catch(() => {});
          if (ingErr) {
            throw new Error(`doImapFetch: ingest failed: ${redactSecrets(ingErr.message)}`);
          }
          duplicatesSkipped++; // lost the ON CONFLICT race (file_hash already captured)
          continue;
        }
        invoicesCreated++;
      }

      maxUid = Math.max(maxUid, msg.uid);
      await bumpCursor(client, connectedEmailId, maxUid);
    }
  } finally {
    pass = null; // drop the only reference to the decrypted password
    if (imap) {
      try {
        await imap.logout();
      } catch (_e) {
        /* ignore */
      }
    }
  }

  return {
    messages_seen: messagesSeen,
    invoices_created: invoicesCreated,
    duplicates_skipped: duplicatesSkipped,
  };
}

async function fileHashSeen(
  client: SupabaseClient,
  householdId: string,
  fileHash: string,
): Promise<boolean> {
  const { data } = await client
    .from('invoices')
    .select('id')
    .eq('household_id', householdId)
    .eq('file_hash', fileHash)
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle();
  return !!data;
}

async function bumpCursor(
  client: SupabaseClient,
  connectedEmailId: string,
  uid: number,
): Promise<void> {
  await client.from('connected_emails').update({ last_processed_uid: uid }).eq(
    'id',
    connectedEmailId,
  );
}
