/**
 * pdf.ts — PDF attachment discovery + integrity helpers for the IMAP worker.
 *
 * Ref: T-323, spec §6.4
 * Date: 2026-06-21
 *
 * Pure, side-effect-free utilities used by `sync-worker` (T-326):
 *   - findPdfParts: walk an IMAP bodyStructure and collect the PDF leaf parts.
 *   - isPdfMagic:   confirm a downloaded buffer really starts with `%PDF`.
 *   - sha256:       content hash for dedupe (invoices.file_hash, lowercase hex).
 *   - streamToBuffer: drain a download stream into a single Uint8Array.
 */

/** Minimal shape of an IMAP bodyStructure node (imapflow-compatible). */
export type BodyStructureNode = {
  /** IMAP part id, e.g. '2' or '1.3' — used to download the attachment. */
  part?: string;
  /** Either the full MIME type ('application/pdf') or just the primary type. */
  type?: string;
  /** Present when type/subtype are split ('application' + 'pdf'). */
  subtype?: string;
  size?: number;
  disposition?: string | null;
  dispositionParameters?: Record<string, string> | null;
  parameters?: Record<string, string> | null;
  childNodes?: BodyStructureNode[] | null;
};

export type PdfPart = {
  part: string;
  size: number;
  filename: string | null;
  /** size > max_size_bytes — the worker dead-letters these (spec §6.4), not skip. */
  oversize: boolean;
};

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // '%PDF'

/** True iff the first 4 bytes are the `%PDF` signature. */
export function isPdfMagic(buf: Uint8Array): boolean {
  if (buf.length < PDF_MAGIC.length) return false;
  return PDF_MAGIC.every((b, i) => buf[i] === b);
}

/** SHA-256 of `buf` as lowercase hex (64 chars). */
export async function sha256(buf: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer-backed view: crypto.subtle.digest's typing
  // rejects Uint8Array<ArrayBufferLike> (which could be SharedArrayBuffer).
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(buf));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function mimeOf(node: BodyStructureNode): string {
  const type = (node.type ?? '').toLowerCase();
  // Combine only when `type` is the bare primary type; if it already carries a
  // slash (imapflow's actual shape, 'application/pdf'), use it as-is so a stray
  // `subtype` can't produce 'application/pdf/pdf'.
  if (node.subtype && !type.includes('/')) return `${type}/${node.subtype.toLowerCase()}`;
  return type;
}

function filenameOf(node: BodyStructureNode): string | null {
  return node.dispositionParameters?.filename ?? node.parameters?.name ?? null;
}

/**
 * Recursively collects every `application/pdf` leaf in `node`, matched
 * case-insensitively and tolerant of both the combined (`type:'application/pdf'`)
 * and split (`type:'application', subtype:'pdf'`) shapes.
 *
 * Size handling (spec §6.4): parts BELOW `min_size_bytes` are dropped as noise
 * (thumbnails / tiny non-invoice attachments). Parts at/above min are ALWAYS
 * returned; those exceeding `max_size_bytes` are returned with `oversize: true`
 * so the worker can dead-letter them for inspection rather than silently skip.
 *
 * A PDF leaf with no `part` id (a single-part message whose whole body IS the
 * PDF) falls back to part `'1'` (imapflow's id for the single-part body).
 */
export function findPdfParts(
  node: BodyStructureNode | null | undefined,
  opts?: { min_size_bytes?: number; max_size_bytes?: number },
): PdfPart[] {
  const min = opts?.min_size_bytes ?? 0;
  const max = opts?.max_size_bytes ?? Number.POSITIVE_INFINITY;
  const out: PdfPart[] = [];

  const walk = (n: BodyStructureNode | null | undefined): void => {
    if (!n) return;
    if (mimeOf(n) === 'application/pdf') {
      const size = n.size ?? 0;
      if (size >= min) {
        out.push({ part: n.part ?? '1', size, filename: filenameOf(n), oversize: size > max });
      }
    }
    for (const child of n.childNodes ?? []) walk(child);
  };

  walk(node);
  return out;
}

/** Drains an async-iterable or web ReadableStream into one Uint8Array. */
export async function streamToBuffer(
  stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];

  if (typeof (stream as ReadableStream<Uint8Array>).getReader === 'function') {
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } else {
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }
  }

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
