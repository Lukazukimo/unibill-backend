/**
 * zip_builder tests — CRC-32 correctness, ZIP container structure, a full
 * deflate→inflate round-trip (offline, no system `unzip`), and the 500MB cap.
 *
 * Ref: T-608 (#118), spec §9.4 / §E (export-my-data).
 */

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@^1.0.0';
import { buildZip, crc32, ExportTooLargeError } from './zip_builder.ts';

const enc = new TextEncoder();

// --- helpers (parse our own output to prove it is a real ZIP) --------------

/** Offset of the End-Of-Central-Directory record (scans backward). */
function findEocd(zip: Uint8Array): number {
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x05 && zip[i + 3] === 0x06) {
      return i;
    }
  }
  return -1;
}

/** Inflates the first entry's data back to bytes (handles store + deflate). */
async function firstEntryBytes(zip: Uint8Array): Promise<Uint8Array> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assertEquals(dv.getUint32(0, true), 0x04034b50); // local file header sig
  const method = dv.getUint16(8, true);
  const compSize = dv.getUint32(18, true);
  const fnLen = dv.getUint16(26, true);
  const extraLen = dv.getUint16(28, true);
  const dataStart = 30 + fnLen + extraLen;
  const comp = zip.slice(dataStart, dataStart + compSize);
  if (method === 0) return comp;
  const stream = new Blob([comp as BlobPart]).stream().pipeThrough(
    new DecompressionStream('deflate-raw'),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// --- crc32 ------------------------------------------------------------------

Deno.test('crc32 matches the standard "123456789" vector (0xCBF43926)', () => {
  assertEquals(crc32(enc.encode('123456789')) >>> 0, 0xcbf43926);
});

Deno.test('crc32 of empty input is 0', () => {
  assertEquals(crc32(new Uint8Array(0)) >>> 0, 0);
});

// --- container structure ----------------------------------------------------

Deno.test('buildZip starts with a local-file-header signature and contains an EOCD', async () => {
  const zip = await buildZip([{ name: 'a.txt', data: enc.encode('hello') }]);
  assertEquals([zip[0], zip[1], zip[2], zip[3]], [0x50, 0x4b, 0x03, 0x04]);
  assert(findEocd(zip) >= 0, 'EOCD record present');
});

Deno.test('buildZip records the total entry count in the EOCD', async () => {
  const zip = await buildZip([
    { name: 'a.txt', data: enc.encode('a') },
    { name: 'invoice_pdfs/x.pdf', data: enc.encode('cc') },
    { name: 'README.md', data: enc.encode('readme') },
  ]);
  const eocd = findEocd(zip);
  const dv = new DataView(zip.buffer, zip.byteOffset + eocd, 22);
  assertEquals(dv.getUint16(8, true), 3, 'entries on this disk');
  assertEquals(dv.getUint16(10, true), 3, 'total entries');
});

// --- round-trip (the real correctness proof) -------------------------------

Deno.test('buildZip round-trips entry bytes through deflate → inflate', async () => {
  const payload = enc.encode('the quick brown fox jumps over the lazy dog. '.repeat(40));
  const zip = await buildZip([{ name: 'x.txt', data: payload }]);
  assertEquals(await firstEntryBytes(zip), payload);
});

// --- 500MB cap (the 413 path) ----------------------------------------------

Deno.test('buildZip rejects with ExportTooLargeError when payload exceeds maxBytes', async () => {
  await assertRejects(
    () => buildZip([{ name: 'big.bin', data: new Uint8Array(100) }], { maxBytes: 10 }),
    ExportTooLargeError,
  );
});

Deno.test('buildZip allows payloads at or under maxBytes', async () => {
  const zip = await buildZip([{ name: 'ok.bin', data: new Uint8Array(10) }], { maxBytes: 10 });
  assert(zip.length > 0);
});
