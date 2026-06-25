/**
 * privacy-export handler tests — method/auth gates, the happy export path
 * (zip uploaded, 24h signed URL, privacy.export.completed emitted), the
 * rate-limit (429) and oversize (413) branches, and best-effort PDF/emit.
 *
 * Every I/O collaborator is injected; no real Storage / DB / Auth is touched.
 *
 * Ref: T-608 (#118), spec §9.4 / §E, BR-019, BR-020.
 */

import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@^1.0.0';
import { buildHandler, exportObjectPath, type HandlerDeps } from './index.ts';
import type { ExportData, PdfRef } from './scoped_queries.ts';
import { RateLimitError } from '../_shared/errors.ts';
import type { DomainEventInput } from '../_shared/events.ts';
import { nonNull } from '../_shared/_test_utils.ts';

const UID = '11111111-1111-4111-8111-111111111111';
const NOW = Date.UTC(2026, 5, 25, 13, 45, 7); // fixed clock

function emptyData(): ExportData {
  return {
    profile: { user_id: UID, email: 'me@x.co' },
    households: [],
    members: [],
    connected_emails: [],
    invoices: [],
    consent_log: [],
    domain_events: [],
    client_telemetry: [],
  };
}

// deno-lint-ignore no-explicit-any
const fakeClient = {} as any;

function baseDeps(over: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    getCallerUser: () => Promise.resolve({ id: UID, email: 'me@x.co' }),
    client: fakeClient,
    rateLimit: (_uid, fn) => fn(),
    collect: () => Promise.resolve(emptyData()),
    listPdfs: () => Promise.resolve([]),
    downloadPdf: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    upload: () => Promise.resolve(),
    sign: () => Promise.resolve('https://signed.example/url'),
    emitEvent: () => Promise.resolve(),
    now: () => NOW,
    ...over,
  };
}

function req(method = 'POST'): Request {
  return new Request('https://x.test/privacy-export', { method });
}

// --- pure: object path ------------------------------------------------------

Deno.test('exportObjectPath formats exports/{userId}/{yyyymmddhhmmss}.zip (UTC)', () => {
  assertEquals(exportObjectPath(UID, NOW), `exports/${UID}/20260625134507.zip`);
});

// --- gates ------------------------------------------------------------------

Deno.test('non-POST method returns 405', async () => {
  const res = await buildHandler(baseDeps())(req('GET'));
  assertEquals(res.status, 405);
});

Deno.test('missing/invalid JWT returns 401', async () => {
  const res = await buildHandler(baseDeps({ getCallerUser: () => Promise.resolve(null) }))(req());
  assertEquals(res.status, 401);
});

// --- happy path -------------------------------------------------------------

Deno.test('happy path uploads a zip, signs 24h, emits privacy.export.completed, returns 200', async () => {
  let uploadedPath = '';
  let uploadedBytes: Uint8Array | null = null;
  let signExpires = 0;
  let emitted: DomainEventInput | null = null;

  const res = await buildHandler(baseDeps({
    upload: (_c, path, bytes) => {
      uploadedPath = path;
      uploadedBytes = bytes;
      return Promise.resolve();
    },
    sign: (_c, _path, expiresIn) => {
      signExpires = expiresIn;
      return Promise.resolve('https://signed.example/url');
    },
    emitEvent: (e) => {
      emitted = e;
      return Promise.resolve();
    },
  }))(req());

  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.download_url, 'https://signed.example/url');
  assertEquals(body.expires_at, new Date(NOW + 86400 * 1000).toISOString());

  assertMatch(uploadedPath, new RegExp(`^exports/${UID}/\\d{14}\\.zip$`));
  const bytes = nonNull<Uint8Array>(uploadedBytes);
  assert(bytes.length > 0);
  assertEquals([bytes[0], bytes[1]], [0x50, 0x4b]); // PK — valid zip
  assertEquals(signExpires, 86400);

  const ev = nonNull<DomainEventInput>(emitted);
  assertEquals(ev.type, 'privacy.export.completed');
  assertEquals(ev.aggregate_id, UID);
  assertEquals(ev.actor_user_id, UID);
});

Deno.test('a failing PDF download is skipped, not fatal (still 200)', async () => {
  const ref: PdfRef = {
    bucket: 'invoices',
    path: 'inv/i1.pdf',
    invoiceId: 'i1',
    entryName: 'invoice_pdfs/i1.pdf',
  };
  const res = await buildHandler(baseDeps({
    listPdfs: () => Promise.resolve([ref]),
    downloadPdf: () => Promise.resolve(null), // missing object
  }))(req());
  assertEquals(res.status, 200);
});

Deno.test('emit failure is best-effort (still 200)', async () => {
  const res = await buildHandler(baseDeps({
    emitEvent: () => Promise.reject(new Error('events table down')),
  }))(req());
  assertEquals(res.status, 200);
});

// --- rate limit / oversize --------------------------------------------------

Deno.test('rate-limited caller returns 429', async () => {
  const res = await buildHandler(baseDeps({
    rateLimit: () => Promise.reject(new RateLimitError('export_my_data', UID, 1)),
  }))(req());
  assertEquals(res.status, 429);
});

Deno.test('payload over the cap returns 413', async () => {
  const res = await buildHandler(baseDeps({
    collect: () => Promise.resolve(emptyData()), // JSON entries already exceed 5 bytes
    maxBytes: 5,
  }))(req());
  assertEquals(res.status, 413);
});

// --- internal error ---------------------------------------------------------

Deno.test('an unexpected collect error returns 500', async () => {
  const res = await buildHandler(baseDeps({
    collect: () => Promise.reject(new Error('db exploded')),
  }))(req());
  assertEquals(res.status, 500);
});
