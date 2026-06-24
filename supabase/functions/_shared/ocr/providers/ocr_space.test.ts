/**
 * ocr_space.test.ts — T-407. DI-fake fetch; no real OCR.space call.
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import type { CallContext } from '../types.ts';
import { classifyOcrError } from '../classify_error.ts';
import { createOcrSpaceProvider, ocrSpaceConfidence, parseOcrSpaceResponse } from './ocr_space.ts';

const CFG = {
  endpoint: 'https://api.ocr.space/parse/image',
  language: 'por',
  engine: 2,
  timeoutMs: 30000,
};
const CTX: CallContext = { correlation_id: 'c1', invoice_id: null, household_id: null, page: 1 };
const PAGE = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF (content irrelevant to fake)

function jsonFetch(status: number, body: unknown): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )) as unknown as typeof fetch;
}

const SUCCESS = {
  IsErroredOnProcessing: false,
  ParsedResults: [{
    ParsedText: 'Enel Vencimento 15/06/2026 Valor 234,56',
    TextOverlay: { Lines: [{ Words: [{ WordConfidence: 90 }, { WordConfidence: 80 }] }] },
  }],
};

Deno.test('success: parses text + averages WordConfidence/100', async () => {
  const p = createOcrSpaceProvider(CFG, { fetch: jsonFetch(200, SUCCESS), apiKey: 'k' });
  const r = await p.ocrPdfPage(PAGE, CTX);
  assertEquals(r.text, 'Enel Vencimento 15/06/2026 Valor 234,56');
  assertEquals(r.confidence, 0.85); // (90+80)/2/100
});

Deno.test('no overlay → confidence falls back to 0 (no throw)', () => {
  assertEquals(ocrSpaceConfidence({ ParsedResults: [{ ParsedText: 'x' }] }), 0);
});

Deno.test('IsErroredOnProcessing → throws → classified as error', async () => {
  const p = createOcrSpaceProvider(CFG, {
    fetch: jsonFetch(200, { IsErroredOnProcessing: true, ErrorMessage: ['bad file'] }),
    apiKey: 'k',
  });
  const err = await p.ocrPdfPage(PAGE, CTX).catch((e) => e);
  assertEquals(classifyOcrError(err).status, 'error');
});

Deno.test('missing ParsedResults → invalid_response', () => {
  let err: unknown;
  try {
    parseOcrSpaceResponse({ IsErroredOnProcessing: false });
  } catch (e) {
    err = e;
  }
  assertEquals(classifyOcrError(err).status, 'invalid_response');
});

Deno.test('HTTP 429 → rate_limited, 402 → quota_exceeded, 500 → error', async () => {
  for (
    const [status, want] of [[429, 'rate_limited'], [402, 'quota_exceeded'], [
      500,
      'error',
    ]] as const
  ) {
    const p = createOcrSpaceProvider(CFG, { fetch: jsonFetch(status, 'nope'), apiKey: 'k' });
    const err = await p.ocrPdfPage(PAGE, CTX).catch((e) => e);
    assertEquals(classifyOcrError(err).status, want);
  }
});

Deno.test('an aborted/timeout fetch surfaces → timeout', async () => {
  const aborting =
    (() => Promise.reject(new DOMException('aborted', 'AbortError'))) as unknown as typeof fetch;
  const p = createOcrSpaceProvider(CFG, { fetch: aborting, apiKey: 'k' });
  const err = await p.ocrPdfPage(PAGE, CTX).catch((e) => e);
  assertEquals(classifyOcrError(err).status, 'timeout');
});

Deno.test('the api key is sent in the apikey header, never in the body/url', async () => {
  let seenUrl = '';
  let seenKey = '';
  const spy = ((url: string, init: RequestInit) => {
    seenUrl = String(url);
    seenKey = String((init.headers as Record<string, string>)?.apikey ?? '');
    return Promise.resolve(new Response(JSON.stringify(SUCCESS), { status: 200 }));
  }) as unknown as typeof fetch;
  const p = createOcrSpaceProvider(CFG, { fetch: spy, apiKey: 'SECRET-KEY' });
  await p.ocrPdfPage(PAGE, CTX);
  assertEquals(seenKey, 'SECRET-KEY');
  assert(!seenUrl.includes('SECRET-KEY'), 'key must not be in the URL');
});
