/**
 * archive_pdf.test.ts — T-603. PDF archive (BR-016) with injected Storage/DB.
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { type ArchivePdfDeps, archivePdfs, type PdfRow } from './archive_pdf.ts';

const row = (id: string, size = 1000): PdfRow => ({
  id,
  household_id: 'h1',
  storage_bucket: 'invoices',
  storage_path: `h1/${id}.pdf`,
  file_hash: `hash-${id}`,
  file_size_bytes: size,
});

function harness(rows: PdfRow[], over: Partial<ArchivePdfDeps> = {}) {
  const cap = { deleted: [] as string[], recorded: [] as string[], events: [] as string[] };
  const deps: ArchivePdfDeps = {
    correlationId: 'c1',
    listOldPdfs: () => Promise.resolve(rows),
    deleteObject: (_b, path) => {
      cap.deleted.push(path);
      return Promise.resolve();
    },
    recordArchive: (inv) => {
      cap.recorded.push(inv.id);
      return Promise.resolve();
    },
    emitEvent: (e) => {
      cap.events.push(e.type);
      return Promise.resolve();
    },
    ...over,
  };
  return { deps, cap };
}

Deno.test('archives each eligible PDF: delete + record + pdf.archived event', async () => {
  const { deps, cap } = harness([row('a'), row('b', 2000)]);
  const r = await archivePdfs(deps);
  assertEquals(r.archived, 2);
  assertEquals(r.failed, 0);
  assertEquals(r.freedBytes, 3000);
  assertEquals(r.ids, ['a', 'b']);
  assertEquals(cap.deleted.length, 2);
  assertEquals(cap.recorded, ['a', 'b']);
  assertEquals(cap.events, ['pdf.archived', 'pdf.archived']);
});

Deno.test('a per-item delete failure is isolated — the batch continues', async () => {
  const errors: string[] = [];
  const { deps, cap } = harness([row('a'), row('b')], {
    deleteObject: (_b, path) => {
      if (path.includes('a')) return Promise.reject(new Error('storage 500'));
      return Promise.resolve();
    },
    onError: (inv) => errors.push(inv.id),
  });
  const r = await archivePdfs(deps);
  assertEquals(r.archived, 1);
  assertEquals(r.failed, 1);
  assertEquals(r.ids, ['b']);
  assertEquals(cap.recorded, ['b']); // the failed one was NOT recorded/archived
  assertEquals(errors, ['a']);
});

Deno.test('no eligible PDFs → archived 0, no events', async () => {
  const { deps, cap } = harness([]);
  const r = await archivePdfs(deps);
  assertEquals(r.archived, 0);
  assertEquals(r.freedBytes, 0);
  assertEquals(cap.events.length, 0);
});

Deno.test('null file_size_bytes contributes 0 to freedBytes (still archives)', async () => {
  const { deps } = harness([{ ...row('a'), file_size_bytes: null }]);
  const r = await archivePdfs(deps);
  assertEquals(r.archived, 1);
  assertEquals(r.freedBytes, 0);
  assert(r.ids.includes('a'));
});
