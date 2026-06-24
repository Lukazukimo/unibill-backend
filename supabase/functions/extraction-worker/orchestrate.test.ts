/**
 * orchestrate.test.ts — T-418 (part 1). The cascade branching, fully DI'd:
 * runLayer1/runLayer2/selectParser/applyParser/aiClient are fakes — no real
 * PDFs, OCR or AI calls.
 */

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@^1.0.0';
import { ChainOpenError, NoProviderAvailableError } from '../_shared/errors.ts';
import type { Layer1Assessment } from './layers/layer1_pdfjs.ts';
import type {
  ExtractedFields as Layer3Fields,
  Layer3Result,
  UtilityParser,
} from './layers/layer3_regex.ts';
import type { Layer2Result } from './layers/layer2_orchestrator.ts';
import type { AiCallContext, AiExtractResult } from '../_shared/ai/types.ts';
import type { OcrClient } from '../_shared/ocr/ocr_client.ts';
import { orchestrate, type OrchestrateDeps, type OrchestrateInput } from './orchestrate.ts';

const CTX: AiCallContext = { correlation_id: 'c1', invoice_id: 'i1', household_id: 'h1' };
const OCR_STUB = {
  chain: [],
  ocrPage: () => Promise.reject(new Error('unused')),
} as unknown as OcrClient;
const PARSER = { utility_key: 'enel-sp' } as UtilityParser;

function l1(over: Partial<Layer1Assessment> = {}): Layer1Assessment {
  return {
    text: 'NATIVE PDFJS TEXT',
    perPageText: ['NATIVE PDFJS TEXT'],
    pageCount: 1,
    charCount: 1200,
    charDensity: 0.3,
    byteLength: 5000,
    failed: false,
    sufficient: true,
    needsOcr: false,
    ...over,
  };
}

function l3(conf: number, fields: Layer3Fields = {}, parserKey = 'enel-sp'): Layer3Result {
  return { parserKey, fields, layer3Confidence: conf };
}

function l2(over: Partial<Layer2Result> = {}): Layer2Result {
  return {
    ocrText: 'OCR TEXT',
    perPageText: ['OCR TEXT'],
    ocrConfidence: 0.9,
    pagesProcessed: 1,
    totalPages: 1,
    layer3: null,
    earlyExit: false,
    ...over,
  };
}

const FULL_FIELDS: Layer3Fields = { amount_cents: 12345, due_date: '2026-07-10', barcode: '8466' };

function fakeAi(impl: (t: string, c: AiCallContext) => Promise<AiExtractResult>) {
  const state = { calls: 0 };
  return {
    state,
    extractStructured: (t: string, c: AiCallContext) => {
      state.calls++;
      return impl(t, c);
    },
  };
}

function baseDeps(over: Partial<OrchestrateDeps> = {}): OrchestrateDeps {
  return {
    ocrClient: OCR_STUB,
    aiClient: { extractStructured: () => Promise.reject(new Error('AI should not be called')) },
    runLayer1: () => Promise.resolve(l1()),
    runLayer2: () => Promise.resolve(l2()),
    selectParser: () => PARSER,
    applyParser: () => l3(1, FULL_FIELDS),
    ...over,
  };
}

const INPUT: OrchestrateInput = {
  pdfBytes: new Uint8Array([1, 2, 3]),
  ctx: CTX,
  matchContext: { senderEmail: 'fatura@enel.com.br', subject: 'Sua fatura' },
  parsers: [PARSER],
};

Deno.test('text-rich + strong regex → extracted/regex, no OCR, no AI', async () => {
  const ai = fakeAi(() => Promise.resolve({ fields: {}, selfReported: 1 }));
  const out = await orchestrate(INPUT, baseDeps({ aiClient: ai }));
  assertEquals(out.status, 'extracted');
  assertEquals(out.method, 'regex');
  assert(out.confidence >= 0.85);
  assertEquals(out.fields.utility_key, 'enel-sp');
  assertEquals(out.payload.data.layer2, null);
  assertEquals(out.payload.data.layer4, null);
  assertEquals(ai.state.calls, 0); // AI must NOT run when regex is strong
});

Deno.test('text-rich + weak regex → AI runs → ai_fallback', async () => {
  const ai = fakeAi(() => Promise.resolve({ fields: FULL_FIELDS, selfReported: 0.9 }));
  const out = await orchestrate(
    INPUT,
    baseDeps({ aiClient: ai, applyParser: () => l3(1 / 3, { amount_cents: 100 }) }),
  );
  assertEquals(out.method, 'ai_fallback');
  assertEquals(ai.state.calls, 1);
  assert(out.payload.data.layer4 !== null);
  assertEquals(out.payload.data.layer2, null); // no OCR (text was rich)
});

Deno.test('scanned (needsOcr) + strong OCR-side regex → ocr_api, no AI', async () => {
  const ai = fakeAi(() => Promise.resolve({ fields: {}, selfReported: 1 }));
  const out = await orchestrate(
    INPUT,
    baseDeps({
      aiClient: ai,
      runLayer1: () =>
        Promise.resolve(l1({ needsOcr: true, sufficient: false, text: '', charCount: 10 })),
      runLayer2: () => Promise.resolve(l2({ layer3: l3(1, FULL_FIELDS) })),
    }),
  );
  assertEquals(out.method, 'ocr_api');
  assertEquals(out.status, 'extracted'); // 1.0*0.7 + 0.9*0.3 = 0.97
  assert(out.payload.data.layer2 !== null);
  assertEquals(out.payload.data.layer2?.applied, true);
  assertEquals(ai.state.calls, 0);
});

Deno.test('scanned + weak OCR-side regex → AI runs → ai_fallback, layer2 present', async () => {
  const ai = fakeAi(() => Promise.resolve({ fields: FULL_FIELDS, selfReported: 0.8 }));
  const out = await orchestrate(
    INPUT,
    baseDeps({
      aiClient: ai,
      runLayer1: () =>
        Promise.resolve(l1({ needsOcr: true, sufficient: false, text: '', charCount: 10 })),
      runLayer2: () => Promise.resolve(l2({ layer3: l3(1 / 3, { amount_cents: 1 }) })),
    }),
  );
  assertEquals(out.method, 'ai_fallback');
  assertEquals(ai.state.calls, 1);
  assert(out.payload.data.layer2 !== null);
  assert(out.payload.data.layer4 !== null);
});

Deno.test('AI chain open → needs_review reason ai_chain_open (recoverable)', async () => {
  const ai = fakeAi(() => Promise.reject(new ChainOpenError('extraction_default')));
  const out = await orchestrate(
    INPUT,
    baseDeps({ aiClient: ai, selectParser: () => null, applyParser: () => l3(0) }),
  );
  assertEquals(out.status, 'needs_review');
  assertEquals(out.needsReviewReason, 'ai_chain_open');
  assertEquals(out.method, 'pdfjs'); // no parser matched, AI didn't run
  assertEquals(out.payload.data.layer4, null);
  assertEquals(ai.state.calls, 1);
});

Deno.test('AI all-providers-fail (NoProviderAvailableError) bubbles (retryable)', async () => {
  const ai = fakeAi(() =>
    Promise.reject(new NoProviderAvailableError(['gemini', 'groq'], new Error('x')))
  );
  await assertRejects(
    () => orchestrate(INPUT, baseDeps({ aiClient: ai, selectParser: () => null })),
    NoProviderAvailableError,
  );
});

Deno.test('computeConfidence receives the right per-layer signals', async () => {
  let seen: unknown = null;
  const ai = fakeAi(() => Promise.resolve({ fields: FULL_FIELDS, selfReported: 0.77 }));
  await orchestrate(
    INPUT,
    baseDeps({
      aiClient: ai,
      runLayer1: () =>
        Promise.resolve(l1({ needsOcr: true, sufficient: false, text: '', charCount: 10 })),
      runLayer2: () =>
        Promise.resolve(l2({ ocrConfidence: 0.66, layer3: l3(1 / 3, { amount_cents: 1 }) })),
      computeConfidenceFn: (signals) => {
        seen = signals;
        return { confidence: 0.5, status: 'needs_review', needsReviewReason: 'low_confidence' };
      },
    }),
  );
  const s = seen as Record<string, unknown>;
  assertEquals(s.layer2Ran, true);
  assertEquals(s.ocrConfidence, 0.66);
  assertEquals(s.layer4Ran, true);
  assertEquals(s.layer4SelfReported, 0.77);
  assertEquals(s.layer3Confidence, 1 / 3);
});
