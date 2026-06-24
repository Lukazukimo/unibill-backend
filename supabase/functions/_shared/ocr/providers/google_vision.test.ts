/**
 * google_vision.test.ts — T-408. DI-fake fetch; no real Vision call.
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import type { CallContext } from '../types.ts';
import { classifyOcrError } from '../classify_error.ts';
import {
  createGoogleVisionProvider,
  googleVisionConfidence,
  parseGoogleVisionResponse,
} from './google_vision.ts';

const CFG = {
  endpoint: 'https://vision.googleapis.com/v1/images:annotate',
  languageHints: ['pt-BR'],
  feature: 'DOCUMENT_TEXT_DETECTION',
  timeoutMs: 30000,
};
const CTX: CallContext = { correlation_id: 'c1', invoice_id: null, household_id: null, page: 1 };
const PAGE = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

function jsonFetch(status: number, body: unknown): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    )) as unknown as typeof fetch;
}

const SUCCESS = {
  responses: [{
    fullTextAnnotation: {
      text: 'Enel Vencimento 15/06/2026 Valor a pagar 234,56',
      pages: [{ confidence: 0.88 }],
    },
  }],
};

Deno.test('success: parses fullTextAnnotation.text + averages page confidence', async () => {
  const p = createGoogleVisionProvider(CFG, { fetch: jsonFetch(200, SUCCESS), apiKey: 'k' });
  const r = await p.ocrPdfPage(PAGE, CTX);
  assertEquals(r.text, 'Enel Vencimento 15/06/2026 Valor a pagar 234,56');
  assertEquals(r.confidence, 0.88);
});

Deno.test('confidence falls back to 0 when no pages confidence present', () => {
  assertEquals(googleVisionConfidence({ responses: [{ fullTextAnnotation: { text: 'x' } }] }), 0);
});

Deno.test('responses[0].error (HTTP 200) → throws → classified error', async () => {
  const p = createGoogleVisionProvider(CFG, {
    fetch: jsonFetch(200, { responses: [{ error: { code: 7, message: 'PERMISSION_DENIED' } }] }),
    apiKey: 'k',
  });
  const err = await p.ocrPdfPage(PAGE, CTX).catch((e) => e);
  assertEquals(classifyOcrError(err).status, 'error');
});

Deno.test('missing responses[0] → invalid_response', () => {
  const err = (() => {
    try {
      parseGoogleVisionResponse({ responses: [] });
    } catch (e) {
      return e;
    }
  })();
  assertEquals(classifyOcrError(err).status, 'invalid_response');
});

Deno.test('HTTP 429 → rate_limited, 500 → error', async () => {
  for (const [status, want] of [[429, 'rate_limited'], [500, 'error']] as const) {
    const p = createGoogleVisionProvider(CFG, { fetch: jsonFetch(status, 'nope'), apiKey: 'k' });
    const err = await p.ocrPdfPage(PAGE, CTX).catch((e) => e);
    assertEquals(classifyOcrError(err).status, want);
  }
});

Deno.test('the api key is sent via x-goog-api-key header, never in the URL', async () => {
  let seenUrl = '';
  let seenKey = '';
  const spy = ((url: string, init: RequestInit) => {
    seenUrl = String(url);
    seenKey = String((init.headers as Record<string, string>)?.['x-goog-api-key'] ?? '');
    return Promise.resolve(new Response(JSON.stringify(SUCCESS), { status: 200 }));
  }) as unknown as typeof fetch;
  const p = createGoogleVisionProvider(CFG, { fetch: spy, apiKey: 'SECRET-KEY' });
  await p.ocrPdfPage(PAGE, CTX);
  assertEquals(seenKey, 'SECRET-KEY');
  assert(!seenUrl.includes('SECRET-KEY'), 'key must not be in the URL');
});
