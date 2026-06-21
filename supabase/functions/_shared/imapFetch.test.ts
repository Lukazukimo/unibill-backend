import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { doImapFetch, type FetchMessage, type ImapFetchClientLike } from './imapFetch.ts';

const PDF_A = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x41]); // "%PDFA"
const PDF_B = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x42]); // "%PDFB"
const NOT_PDF = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function pdfMessage(
  uid: number,
  over: Partial<NonNullable<FetchMessage['envelope']>> = {},
): FetchMessage {
  return {
    uid,
    envelope: {
      date: '2026-06-10T09:00:00.000Z',
      subject: 'Fatura',
      messageId: `<msg-${uid}>`,
      from: [{ address: 'enel@x.com', name: 'Enel' }],
      ...over,
    },
    bodyStructure: {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 100 },
        {
          part: '2',
          type: 'application/pdf',
          size: 50_000,
          dispositionParameters: { filename: 'a.pdf' },
        },
      ],
    },
  };
}

function fakeImap(
  messages: FetchMessage[],
  opts: { bytes?: Record<string, Uint8Array>; searchUids?: number[]; openThrows?: boolean } = {},
) {
  const calls = { connected: 0, loggedOut: 0, opened: [] as string[], downloads: [] as string[] };
  const factory = () =>
    ({
      connect: () => {
        calls.connected++;
        return Promise.resolve();
      },
      logout: () => {
        calls.loggedOut++;
        return Promise.resolve();
      },
      mailboxOpen: (p: string) => {
        if (opts.openThrows) return Promise.reject(new Error('boom'));
        calls.opened.push(p);
        return Promise.resolve({});
      },
      search: (_q: Record<string, unknown>) =>
        Promise.resolve(opts.searchUids ?? messages.map((m) => m.uid)),
      fetch: (_range: string) =>
        (async function* () {
          for (const m of messages) yield m;
        })(),
      download: (uid: number, part: string) => {
        calls.downloads.push(`${uid}:${part}`);
        const bytes = opts.bytes?.[`${uid}:${part}`] ?? PDF_A;
        return Promise.resolve({
          content: (async function* () {
            yield bytes;
          })(),
        });
      },
    }) as ImapFetchClientLike;
  return { factory, calls };
}

type Scn = {
  mailbox?: Record<string, unknown>;
  fileSeen?: boolean;
  bindings?: Array<{ household_id: string; is_default: boolean }>;
  ingest?: string | null;
  ingestError?: { message: string };
  uploadError?: { message: string };
  decryptError?: boolean;
  settings?: Array<{ key: string; value: unknown }>;
};

function fakeClient(scn: Scn = {}) {
  const cap = {
    ingests: [] as Record<string, unknown>[],
    uploads: [] as string[],
    removes: [] as string[][],
    cursor: [] as number[],
  };
  const settled = (data: unknown, error: { message: string } | null = null) => ({ data, error });
  const mailbox = scn.mailbox ?? {
    id: 'ce1',
    email_address: 'o@x.com',
    app_password_secret: 'sec-1',
    imap_host: 'imap.gmail.com',
    imap_port: 993,
    imap_use_tls: true,
    last_processed_uid: null,
  };

  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      if (name === 'decrypt_app_password') {
        return Promise.resolve(
          scn.decryptError ? settled(null, { message: 'x' }) : settled('app-pw'),
        );
      }
      if (name === 'ingest_invoice') {
        cap.ingests.push(args);
        if (scn.ingestError) return Promise.resolve(settled(null, scn.ingestError));
        return Promise.resolve(settled(scn.ingest === undefined ? 'inv-1' : scn.ingest));
      }
      return Promise.resolve(settled(null));
    },
    storage: {
      from(_bucket: string) {
        return {
          upload: (path: string) => {
            cap.uploads.push(path);
            return Promise.resolve(
              scn.uploadError
                ? { data: null, error: scn.uploadError }
                : { data: { path }, error: null },
            );
          },
          remove: (paths: string[]) => {
            cap.removes.push(paths);
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
    },
    from(table: string) {
      if (table === 'connected_emails') {
        return {
          select: () => ({
            eq: () => ({ single: () => Promise.resolve(settled(mailbox)) }),
          }),
          update: (patch: Record<string, unknown>) => ({
            eq: () => {
              if (typeof patch.last_processed_uid === 'number') {
                cap.cursor.push(patch.last_processed_uid);
              }
              return Promise.resolve(settled(null));
            },
          }),
        };
      }
      if (table === 'app_settings') {
        const c: Record<string, unknown> = {
          eq: () => c,
          is: () => c,
          in: () => Promise.resolve(settled(scn.settings ?? [])),
        };
        return { select: () => c };
      }
      if (table === 'connected_email_households') {
        const c: Record<string, unknown> = {
          eq: () => c,
          is: () =>
            Promise.resolve(settled(scn.bindings ?? [{ household_id: 'hh1', is_default: false }])),
        };
        return { select: () => c };
      }
      if (table === 'invoices') {
        const c: Record<string, unknown> = {
          eq: () => c,
          is: () => c,
          limit: () => c,
          maybeSingle: () => Promise.resolve(settled(scn.fileSeen ? { id: 'dup' } : null)),
        };
        return { select: () => c };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
  return { client, cap };
}

const input = (client: SupabaseClient) => ({
  connectedEmailId: 'ce1',
  emailAddress: 'o@x.com',
  correlationId: 'corr1',
  client,
});
const NOW = Date.parse('2026-06-21T14:00:00.000Z');
function seqId() {
  let n = 0;
  return () => `uuid-${++n}`;
}

Deno.test('captures a new PDF (download → magic → hash → upload → ingest); first sync uses search', async () => {
  const { client, cap } = fakeClient({});
  const imap = fakeImap([pdfMessage(101)]);
  const r = await doImapFetch(input(client), {
    imapFactory: imap.factory,
    now: () => NOW,
    newId: seqId(),
  });
  assertEquals(r, { messages_seen: 1, invoices_created: 1, duplicates_skipped: 0 });
  assertEquals(imap.calls.opened, ['INBOX']);
  assertEquals(imap.calls.loggedOut, 1);
  assertEquals(cap.uploads, ['household-hh1/2026-06/uuid-1.pdf']);
  const ing = cap.ingests[0];
  assertEquals(ing.p_household_id, 'hh1');
  assertEquals(ing.p_correlation_id, 'corr1');
  assertEquals(ing.p_source_sender, 'enel@x.com');
  assertEquals(ing.p_source_subject, 'Fatura');
  assertEquals(ing.p_source_received_at, '2026-06-10T09:00:00.000Z');
  assert(/^[a-f0-9]{64}$/.test(ing.p_file_hash as string));
  assertEquals(cap.cursor.at(-1), 101);
});

Deno.test('CRITICAL: a single email with TWO distinct PDFs captures BOTH', async () => {
  const { client, cap } = fakeClient({});
  const msg: FetchMessage = {
    uid: 200,
    envelope: {
      date: '2026-06-10T09:00:00.000Z',
      subject: 'Duas',
      messageId: '<m200>',
      from: [{ address: 'a@b' }],
    },
    bodyStructure: {
      type: 'multipart/mixed',
      childNodes: [
        { part: '2', type: 'application/pdf', size: 50_000 },
        { part: '3', type: 'application/pdf', size: 60_000 },
      ],
    },
  };
  const imap = fakeImap([msg], { bytes: { '200:2': PDF_A, '200:3': PDF_B } });
  const r = await doImapFetch(input(client), {
    imapFactory: imap.factory,
    now: () => NOW,
    newId: seqId(),
  });
  assertEquals(r.invoices_created, 2);
  assertEquals(cap.uploads, [
    'household-hh1/2026-06/uuid-1.pdf',
    'household-hh1/2026-06/uuid-2.pdf',
  ]);
  assertEquals(cap.ingests.length, 2);
  // same message id, DIFFERENT file hashes
  assertEquals(cap.ingests[0].p_source_message_id, '<m200>');
  assertEquals(cap.ingests[1].p_source_message_id, '<m200>');
  assert(cap.ingests[0].p_file_hash !== cap.ingests[1].p_file_hash);
});

Deno.test('multi-message batch: cursor advances per message, monotonic, to the latest uid', async () => {
  const { client, cap } = fakeClient({});
  const imap = fakeImap([pdfMessage(310), pdfMessage(305), pdfMessage(320)], {
    bytes: {
      '310:2': PDF_A,
      '305:2': PDF_B,
      '320:2': new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x43]),
    },
  });
  const r = await doImapFetch(input(client), {
    imapFactory: imap.factory,
    now: () => NOW,
    newId: seqId(),
  });
  assertEquals(r.invoices_created, 3);
  // monotonic non-decreasing, final = max
  for (let i = 1; i < cap.cursor.length; i++) assert(cap.cursor[i] >= cap.cursor[i - 1]);
  assertEquals(cap.cursor.at(-1), 320);
});

Deno.test('file-hash already seen → skip the PDF, no orphan upload', async () => {
  const { client, cap } = fakeClient({ fileSeen: true });
  const imap = fakeImap([pdfMessage(103)]);
  const r = await doImapFetch(input(client), {
    imapFactory: imap.factory,
    now: () => NOW,
    newId: seqId(),
  });
  assertEquals(r.duplicates_skipped, 1);
  assertEquals(r.invoices_created, 0);
  assertEquals(cap.uploads.length, 0);
});

Deno.test('non-PDF bytes (bad magic) are ignored', async () => {
  const { client, cap } = fakeClient({});
  const imap = fakeImap([pdfMessage(104)], { bytes: { '104:2': NOT_PDF } });
  const r = await doImapFetch(input(client), {
    imapFactory: imap.factory,
    now: () => NOW,
    newId: seqId(),
  });
  assertEquals(r.invoices_created, 0);
  assertEquals(cap.uploads.length, 0);
});

Deno.test('ingest NULL (ON CONFLICT race) counts as duplicate AND removes the orphan upload', async () => {
  const { client, cap } = fakeClient({ ingest: null });
  const imap = fakeImap([pdfMessage(105)]);
  const r = await doImapFetch(input(client), {
    imapFactory: imap.factory,
    now: () => NOW,
    newId: seqId(),
  });
  assertEquals(r.duplicates_skipped, 1);
  assertEquals(r.invoices_created, 0);
  assertEquals(cap.uploads.length, 1);
  assertEquals(cap.removes, [['household-hh1/2026-06/uuid-1.pdf']]); // orphan cleaned up
});

Deno.test('oversize PDF is skipped (NOT counted as duplicate), no upload', async () => {
  const { client, cap } = fakeClient({
    settings: [{ key: 'sync.pdf_max_size_bytes', value: { v: 1000 } }],
  });
  const imap = fakeImap([pdfMessage(106)]); // part size 50_000 > 1000
  const r = await doImapFetch(input(client), {
    imapFactory: imap.factory,
    now: () => NOW,
    newId: seqId(),
  });
  assertEquals(r, { messages_seen: 1, invoices_created: 0, duplicates_skipped: 0 });
  assertEquals(cap.uploads.length, 0);
});

Deno.test('no PDF parts → cursor advances, no capture', async () => {
  const { client, cap } = fakeClient({});
  const noPdf: FetchMessage = {
    uid: 107,
    envelope: {
      date: '2026-06-10T09:00:00.000Z',
      subject: 's',
      messageId: '<m>',
      from: [{ address: 'a@b' }],
    },
    bodyStructure: { type: 'text/plain', part: '1', size: 10 },
  };
  const imap = fakeImap([noPdf]);
  const r = await doImapFetch(input(client), {
    imapFactory: imap.factory,
    now: () => NOW,
    newId: seqId(),
  });
  assertEquals(r, { messages_seen: 1, invoices_created: 0, duplicates_skipped: 0 });
  assertEquals(cap.cursor.at(-1), 107);
});

Deno.test('message without a Message-ID: captured, p_source_message_id null, idempotency from uid', async () => {
  const { client, cap } = fakeClient({});
  const imap = fakeImap([pdfMessage(108, { messageId: null })]);
  const r = await doImapFetch(input(client), {
    imapFactory: imap.factory,
    now: () => NOW,
    newId: seqId(),
  });
  assertEquals(r.invoices_created, 1);
  assertEquals(cap.ingests[0].p_source_message_id, null);
  assert(/^[a-f0-9]{64}$/.test(cap.ingests[0].p_idempotency_key as string));
});

Deno.test('incremental sync (cursor set) skips messages <= cursor', async () => {
  const { client } = fakeClient({
    mailbox: {
      id: 'ce1',
      email_address: 'o@x.com',
      app_password_secret: 'sec-1',
      imap_host: 'imap.gmail.com',
      imap_port: 993,
      imap_use_tls: true,
      last_processed_uid: 100,
    },
  });
  // imapflow's n:* can return the cursor message itself — must be skipped.
  const imap = fakeImap([pdfMessage(100), pdfMessage(101)], {
    bytes: { '100:2': PDF_A, '101:2': PDF_B },
  });
  const r = await doImapFetch(input(client), {
    imapFactory: imap.factory,
    now: () => NOW,
    newId: seqId(),
  });
  assertEquals(r.messages_seen, 1); // only uid 101
  assertEquals(r.invoices_created, 1);
});

Deno.test('first sync with empty lookback window returns early (still logs out)', async () => {
  const { client, cap } = fakeClient({});
  const imap = fakeImap([pdfMessage(101)], { searchUids: [] });
  const r = await doImapFetch(input(client), {
    imapFactory: imap.factory,
    now: () => NOW,
    newId: seqId(),
  });
  assertEquals(r, { messages_seen: 0, invoices_created: 0, duplicates_skipped: 0 });
  assertEquals(imap.calls.loggedOut, 1);
  assertEquals(cap.ingests.length, 0);
});

Deno.test('decrypt failure rejects before connecting', async () => {
  const { client } = fakeClient({ decryptError: true });
  const imap = fakeImap([pdfMessage(101)]);
  let threw = false;
  try {
    await doImapFetch(input(client), { imapFactory: imap.factory, now: () => NOW, newId: seqId() });
  } catch {
    threw = true;
  }
  assert(threw);
  assertEquals(imap.calls.connected, 0);
});

Deno.test('upload error rejects but logout still runs', async () => {
  const { client, cap } = fakeClient({ uploadError: { message: 'storage down' } });
  const imap = fakeImap([pdfMessage(101)]);
  let threw = false;
  try {
    await doImapFetch(input(client), { imapFactory: imap.factory, now: () => NOW, newId: seqId() });
  } catch {
    threw = true;
  }
  assert(threw);
  assertEquals(imap.calls.loggedOut, 1);
  assertEquals(cap.ingests.length, 0);
});

Deno.test('ambiguous household binding aborts the message', async () => {
  const { client } = fakeClient({
    bindings: [{ household_id: 'h1', is_default: false }, {
      household_id: 'h2',
      is_default: false,
    }],
  });
  const imap = fakeImap([pdfMessage(101)]);
  let threw = false;
  try {
    await doImapFetch(input(client), { imapFactory: imap.factory, now: () => NOW, newId: seqId() });
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test('logout runs even when mailboxOpen throws', async () => {
  const { client } = fakeClient({});
  const imap = fakeImap([], { openThrows: true });
  let threw = false;
  try {
    await doImapFetch(input(client), { imapFactory: imap.factory, now: () => NOW, newId: seqId() });
  } catch {
    threw = true;
  }
  assert(threw);
  assertEquals(imap.calls.loggedOut, 1);
});
