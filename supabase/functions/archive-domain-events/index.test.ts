/**
 * index.test.ts — T-605 archive-domain-events. Pure window/path + gzip roundtrip
 * + handler with injected select/upload/delete (fake client only serves config).
 */

import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1.0.0';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { archiveWindow, buildHandler, type EventRow, gzipText, toJsonl } from './index.ts';

const DAY = 86_400_000;

async function gunzip(bytes: Uint8Array): Promise<string> {
  const s = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(s).text();
}

// --- pure: window / path ----------------------------------------------------

Deno.test('archiveWindow: the 7-day slice that just aged past the hot window', () => {
  const now = Date.parse('2026-06-25T00:00:00.000Z');
  const w = archiveWindow(now, 90);
  assertEquals(w.toIso, new Date(now - 90 * DAY).toISOString());
  assertEquals(w.fromIso, new Date(now - 97 * DAY).toISOString());
  assertEquals((Date.parse(w.toIso) - Date.parse(w.fromIso)) / DAY, 7);
  assertStringIncludes(w.objectPath, 'domain_events/2026/03/week-');
  assert(w.objectPath.endsWith('.jsonl.gz'));
});

Deno.test('archiveWindow path is deterministic for a given now (idempotency key)', () => {
  const now = Date.parse('2026-06-25T11:00:00.000Z');
  assertEquals(archiveWindow(now, 90).objectPath, archiveWindow(now, 90).objectPath);
});

// --- gzip roundtrip ---------------------------------------------------------

Deno.test('toJsonl + gzipText: 1000 events → gzip → exactly 1000 JSONL lines', async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `e${i}`, n: i }));
  const gz = await gzipText(toJsonl(rows));
  const text = await gunzip(gz);
  const lines = text.split('\n');
  assertEquals(lines.length, 1000);
  assertEquals(JSON.parse(lines[0]).id, 'e0');
  assertEquals(JSON.parse(lines[999]).n, 999);
});

// --- handler ----------------------------------------------------------------

function fakeClient() {
  const settled = (data: unknown) => ({ data, error: null });
  return {
    from: () => {
      const c: Record<string, unknown> = {
        eq: () => c,
        is: () => c,
        in: () =>
          Promise.resolve(
            settled([{ key: 'retention.domain_events_hot.max_age_days', value: { v: 90 } }]),
          ),
      };
      return { select: () => c };
    },
  } as unknown as SupabaseClient;
}

function mk(rows: EventRow[], over: Record<string, unknown> = {}) {
  const cap = { uploads: [] as Array<{ path: string; n: number }>, deleted: [] as string[][] };
  const handler = buildHandler({
    client: fakeClient(),
    requireAuth: () => true,
    now: () => Date.parse('2026-06-25T00:00:00.000Z'),
    selectEvents: () => Promise.resolve(rows),
    upload: (_c, path, bytes) => {
      cap.uploads.push({ path, n: bytes.length });
      return Promise.resolve();
    },
    deleteEvents: (_c, ids) => {
      cap.deleted.push(ids);
      return Promise.resolve();
    },
    ...over,
  });
  return { handler, cap };
}

const post = () => new Request('https://x/archive-domain-events', { method: 'POST' });

Deno.test('archives a non-empty slice: upload then delete the same rows', async () => {
  const rows: EventRow[] = [{ id: 'a', event_type: 'x' }, { id: 'b', event_type: 'y' }];
  const { handler, cap } = mk(rows);
  const body = await (await handler(post())).json();
  assertEquals(body.archived, 2);
  assertStringIncludes(body.path, 'domain_events/2026/03/week-');
  assertEquals(cap.uploads.length, 1);
  assert(cap.uploads[0].n > 0);
  assertEquals(cap.deleted, [['a', 'b']]);
});

Deno.test('empty slice → archived 0, no upload, no delete', async () => {
  const { handler, cap } = mk([]);
  const body = await (await handler(post())).json();
  assertEquals(body.archived, 0);
  assertEquals(cap.uploads.length, 0);
  assertEquals(cap.deleted.length, 0);
});

Deno.test('upload failure → 500, rows NOT deleted', async () => {
  const { handler, cap } = mk([{ id: 'a' }], {
    upload: () => Promise.reject(new Error('storage down')),
  });
  const res = await handler(post());
  assertEquals(res.status, 500);
  assertEquals(cap.deleted.length, 0); // never delete if the upload didn't land
});

Deno.test('auth: non-POST → 405; missing service role → 401', async () => {
  const { handler } = mk([]);
  assertEquals((await handler(new Request('https://x/a', { method: 'GET' }))).status, 405);
  const denied = buildHandler({ client: fakeClient(), requireAuth: () => false });
  assertEquals((await denied(post())).status, 401);
});
