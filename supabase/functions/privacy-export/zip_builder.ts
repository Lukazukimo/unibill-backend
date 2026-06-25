/**
 * zip_builder.ts — a tiny, dependency-free ZIP writer for the LGPD data export.
 *
 * Ref: T-608 (#118), spec §9.4 / §E (export-my-data), BR-019.
 * Date: 2026-06-25
 *
 * Why hand-rolled (not a jsr zip lib)?
 *   - Zero new dependency for an Apache-2.0 OSS backend (fewer transitive
 *     licences to vet) and it is fully unit-testable offline (the deflate is
 *     round-tripped via the platform DecompressionStream — no system `unzip`).
 *   - The output is a standard single-disk ZIP (no ZIP64): every entry is
 *     DEFLATE-compressed (method 8), no data descriptor (sizes are known up
 *     front because we deflate fully before writing the header).
 *
 * The 500MB cap (`maxBytes`, spec §E) is enforced on the *uncompressed* payload
 * BEFORE deflating. That is the memory-protecting check that matters in an Edge
 * runtime: the assembled ZIP is always <= the uncompressed total (DEFLATE never
 * meaningfully expands), so capping the input caps the output and never lets a
 * pathological export OOM the function. Exceeding it throws ExportTooLargeError,
 * which the handler maps to HTTP 413.
 *
 * NOT ZIP64: the cap (well under 4GB) and a handful of entries keep every field
 * inside its 32-bit / 16-bit limit, so the classic record layout is always valid.
 */

export type ZipEntry = { name: string; data: Uint8Array };

/** Thrown by `buildZip` when the uncompressed payload exceeds `maxBytes`. */
export class ExportTooLargeError extends Error {
  constructor(public readonly totalBytes: number, public readonly maxBytes: number) {
    super(`export payload ${totalBytes} bytes exceeds cap of ${maxBytes} bytes`);
    this.name = 'ExportTooLargeError';
  }
}

/** Default cap: 500 MiB (spec §E). */
export const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;

// --- CRC-32 (IEEE 802.3, reflected) ----------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE) of `bytes`, returned as an unsigned 32-bit value. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// --- DEFLATE (raw) ----------------------------------------------------------

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(
    new CompressionStream('deflate-raw'),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// --- ZIP assembly -----------------------------------------------------------

// Fixed DOS timestamp (1980-01-01 00:00) — the export mtime is irrelevant and a
// constant keeps the bytes deterministic.
const DOS_TIME = 0;
const DOS_DATE = 0x0021; // (year 1980 → 0) << 9 | (month 1) << 5 | (day 1)

const enc = new TextEncoder();

type Prepared = {
  nameBytes: Uint8Array;
  comp: Uint8Array;
  crc: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

function localFileHeader(p: Prepared): Uint8Array {
  const buf = new Uint8Array(30 + p.nameBytes.length);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x04034b50, true); // signature
  dv.setUint16(4, 20, true); // version needed
  dv.setUint16(6, 0x0800, true); // gp flag: UTF-8 filename
  dv.setUint16(8, 8, true); // method: deflate
  dv.setUint16(10, DOS_TIME, true);
  dv.setUint16(12, DOS_DATE, true);
  dv.setUint32(14, p.crc, true);
  dv.setUint32(18, p.comp.length, true); // compressed size
  dv.setUint32(22, p.uncompressedSize, true); // uncompressed size
  dv.setUint16(26, p.nameBytes.length, true);
  dv.setUint16(28, 0, true); // extra length
  buf.set(p.nameBytes, 30);
  return buf;
}

function centralDirHeader(p: Prepared): Uint8Array {
  const buf = new Uint8Array(46 + p.nameBytes.length);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x02014b50, true); // signature
  dv.setUint16(4, 20, true); // version made by
  dv.setUint16(6, 20, true); // version needed
  dv.setUint16(8, 0x0800, true); // gp flag: UTF-8
  dv.setUint16(10, 8, true); // method: deflate
  dv.setUint16(12, DOS_TIME, true);
  dv.setUint16(14, DOS_DATE, true);
  dv.setUint32(16, p.crc, true);
  dv.setUint32(20, p.comp.length, true);
  dv.setUint32(24, p.uncompressedSize, true);
  dv.setUint16(28, p.nameBytes.length, true);
  dv.setUint16(30, 0, true); // extra length
  dv.setUint16(32, 0, true); // comment length
  dv.setUint16(34, 0, true); // disk number start
  dv.setUint16(36, 0, true); // internal attrs
  dv.setUint32(38, 0, true); // external attrs
  dv.setUint32(42, p.localHeaderOffset, true);
  buf.set(p.nameBytes, 46);
  return buf;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Builds a single-disk ZIP archive from `entries`. Throws ExportTooLargeError
 * when the total uncompressed payload exceeds `opts.maxBytes` (default 500MB).
 */
export async function buildZip(
  entries: ZipEntry[],
  opts: { maxBytes?: number } = {},
): Promise<Uint8Array> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const total = entries.reduce((n, e) => n + e.data.length, 0);
  if (total > maxBytes) {
    throw new ExportTooLargeError(total, maxBytes);
  }

  const prepared: Prepared[] = [];
  const localChunks: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const comp = await deflateRaw(e.data);
    const p: Prepared = {
      nameBytes: enc.encode(e.name),
      comp,
      crc: crc32(e.data),
      uncompressedSize: e.data.length,
      localHeaderOffset: offset,
    };
    prepared.push(p);
    const header = localFileHeader(p);
    localChunks.push(header, comp);
    offset += header.length + comp.length;
  }

  const centralChunks = prepared.map(centralDirHeader);
  const centralSize = centralChunks.reduce((n, c) => n + c.length, 0);
  const centralOffset = offset;

  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true); // signature
  dv.setUint16(4, 0, true); // disk number
  dv.setUint16(6, 0, true); // disk with central dir
  dv.setUint16(8, entries.length, true); // entries on this disk
  dv.setUint16(10, entries.length, true); // total entries
  dv.setUint32(12, centralSize, true);
  dv.setUint32(16, centralOffset, true);
  dv.setUint16(20, 0, true); // comment length

  return concat([...localChunks, ...centralChunks, eocd]);
}
