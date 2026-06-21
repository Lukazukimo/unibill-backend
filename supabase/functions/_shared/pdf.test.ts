import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { type BodyStructureNode, findPdfParts, isPdfMagic, sha256, streamToBuffer } from './pdf.ts';

const enc = (s: string) => new TextEncoder().encode(s);

Deno.test('isPdfMagic accepts a %PDF header and rejects others', () => {
  assert(isPdfMagic(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])));
  assert(!isPdfMagic(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))); // PNG
  assert(!isPdfMagic(new Uint8Array([0x25, 0x50, 0x44]))); // too short
  assert(!isPdfMagic(new Uint8Array([])));
});

Deno.test('sha256 returns lowercase hex (known vectors)', async () => {
  assertEquals(
    await sha256(enc('')),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assertEquals(
    await sha256(enc('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

const tree: BodyStructureNode = {
  type: 'multipart/mixed',
  childNodes: [
    { part: '1', type: 'text/plain', size: 100 },
    {
      part: '2',
      type: 'application/pdf',
      size: 50000,
      disposition: 'attachment',
      dispositionParameters: { filename: 'fatura.pdf' },
    },
    {
      type: 'multipart/alternative',
      childNodes: [
        { part: '3', type: 'text/html', size: 200 },
        { part: '4', type: 'APPLICATION/PDF', size: 9000, parameters: { name: 'nested.pdf' } },
        { part: '5', type: 'application', subtype: 'pdf', size: 1000 }, // split type/subtype shape
      ],
    },
  ],
};

Deno.test('findPdfParts recursively collects all PDF parts (case-insensitive, both shapes)', () => {
  const parts = findPdfParts(tree);
  assertEquals(parts.map((p) => p.part).sort(), ['2', '4', '5']);
  const p2 = parts.find((p) => p.part === '2');
  assertEquals(p2?.filename, 'fatura.pdf');
  assertEquals(p2?.size, 50000);
  assertEquals(parts.find((p) => p.part === '4')?.filename, 'nested.pdf');
  assert(parts.every((p) => p.oversize === false)); // no max → nothing oversize
});

Deno.test('findPdfParts drops undersize parts but TAGS oversize ones (does not drop them)', () => {
  // min drops the small ones (noise).
  assertEquals(findPdfParts(tree, { min_size_bytes: 10000 }).map((p) => p.part), ['2']);
  // max does NOT drop — returns all >= min and flags the big one so the worker
  // can dead-letter it (spec §6.4).
  const withMax = findPdfParts(tree, { max_size_bytes: 9000 });
  assertEquals(withMax.map((p) => p.part).sort(), ['2', '4', '5']);
  assertEquals(withMax.find((p) => p.part === '2')?.oversize, true);
  assertEquals(withMax.find((p) => p.part === '4')?.oversize, false);
});

Deno.test('findPdfParts bounds are inclusive (size == min included, size == max not oversize)', () => {
  const n: BodyStructureNode = {
    type: 'multipart/mixed',
    childNodes: [{ part: '1', type: 'application/pdf', size: 10000 }],
  };
  assertEquals(findPdfParts(n, { min_size_bytes: 10000 }).length, 1);
  assertEquals(findPdfParts(n, { max_size_bytes: 10000 })[0].oversize, false);
});

Deno.test('findPdfParts collects a single-part PDF-only body (no part id falls back to "1")', () => {
  const parts = findPdfParts({
    type: 'application/pdf',
    size: 5000,
    dispositionParameters: { filename: 'x.pdf' },
  });
  assertEquals(parts.length, 1);
  assertEquals(parts[0].part, '1');
  assertEquals(parts[0].filename, 'x.pdf');
});

Deno.test('findPdfParts returns [] when there are no PDF parts', () => {
  assertEquals(findPdfParts({ type: 'text/plain', part: '1', size: 10 }), []);
});

Deno.test('streamToBuffer concatenates async-iterable chunks', async () => {
  async function* gen() {
    yield enc('hello ');
    yield enc('world');
  }
  const buf = await streamToBuffer(gen());
  assertEquals(new TextDecoder().decode(buf), 'hello world');
  assertEquals(await sha256(buf), await sha256(enc('hello world')));
});

Deno.test('streamToBuffer drains a web ReadableStream', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc('ab'));
      c.enqueue(enc('cd'));
      c.close();
    },
  });
  const buf = await streamToBuffer(stream);
  assertEquals(new TextDecoder().decode(buf), 'abcd');
});

Deno.test('streamToBuffer yields a 0-length buffer for an empty stream', async () => {
  async function* empty(): AsyncGenerator<Uint8Array> {}
  assertEquals((await streamToBuffer(empty())).length, 0);
});

Deno.test('sha256 handles binary (non-UTF8) bytes deterministically', async () => {
  const bytes = new Uint8Array([0x00, 0x7f, 0x80, 0xff]);
  const d = await sha256(bytes);
  assert(/^[0-9a-f]{64}$/.test(d));
  assertEquals(d, await sha256(new Uint8Array([0x00, 0x7f, 0x80, 0xff]))); // deterministic
  assert(d !== (await sha256(new Uint8Array([0x00, 0x7f, 0x80, 0xfe])))); // byte-sensitive
});
