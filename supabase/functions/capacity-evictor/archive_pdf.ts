/**
 * archive_pdf.ts — PDF archive eviction (T-603, spec §10.4 / BR-016).
 *
 * When Storage is over the PDF-archive threshold, old invoice PDFs are removed
 * from Storage (the extracted data stays). Per eligible invoice: DELETE the
 * Storage object → mark invoices.pdf_archived_at + INSERT pdf_archive_log →
 * emit pdf.archived. Per-item failures are isolated (one bad object never aborts
 * the batch). All collaborators injected → unit-tested with no Storage/DB.
 */

import type { DomainEventInput } from '../_shared/events.ts';

export interface PdfRow {
  id: string;
  household_id: string | null;
  storage_bucket: string;
  storage_path: string;
  file_hash: string;
  file_size_bytes: number | null;
}

export interface ArchivePdfDeps {
  /** Invoices with a live PDF older than the retention floor (Storage over threshold). */
  listOldPdfs: () => Promise<PdfRow[]>;
  /** Remove the object from Storage. */
  deleteObject: (bucket: string, path: string) => Promise<void>;
  /** Set invoices.pdf_archived_at=now() + INSERT the pdf_archive_log row. */
  recordArchive: (inv: PdfRow) => Promise<void>;
  emitEvent: (e: DomainEventInput) => Promise<void>;
  correlationId: string;
  /** Best-effort warn sink for per-item failures. */
  onError?: (inv: PdfRow, err: unknown) => void;
}

export interface ArchivePdfResult {
  archived: number;
  failed: number;
  freedBytes: number;
  ids: string[];
}

export async function archivePdfs(deps: ArchivePdfDeps): Promise<ArchivePdfResult> {
  const olds = await deps.listOldPdfs();
  let archived = 0;
  let failed = 0;
  let freedBytes = 0;
  const ids: string[] = [];

  for (const inv of olds) {
    try {
      await deps.deleteObject(inv.storage_bucket, inv.storage_path);
      await deps.recordArchive(inv);
      await deps.emitEvent({
        type: 'pdf.archived',
        aggregate_type: 'invoice',
        aggregate_id: inv.id,
        household_id: inv.household_id ?? undefined,
        correlation_id: deps.correlationId,
        actor_type: 'system',
        payload: {
          version: 1,
          data: { file_hash: inv.file_hash, file_size_bytes: inv.file_size_bytes },
        },
      });
      archived++;
      freedBytes += inv.file_size_bytes ?? 0;
      ids.push(inv.id);
    } catch (err) {
      failed++;
      deps.onError?.(inv, err);
    }
  }

  return { archived, failed, freedBytes, ids };
}
