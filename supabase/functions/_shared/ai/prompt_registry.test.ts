/**
 * prompt_registry.test.ts — T-414. Pure registry behaviour.
 */

import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1.0.0';
import {
  buildExtractionPrompt,
  DEFAULT_INVOICE_PROMPT,
  getPrompt,
  hasPrompt,
  INVOICE_PROMPT_KEY,
  registerPrompt,
} from './prompt_registry.ts';

Deno.test('the invoice prompt is registered by default', () => {
  assert(hasPrompt(INVOICE_PROMPT_KEY));
  assertEquals(getPrompt(INVOICE_PROMPT_KEY), DEFAULT_INVOICE_PROMPT);
});

Deno.test('an unknown key falls back to the default invoice prompt', () => {
  assertEquals(getPrompt('does-not-exist'), DEFAULT_INVOICE_PROMPT);
});

Deno.test('registerPrompt hot-swaps a template; empty templates are ignored', () => {
  registerPrompt('custom', 'MEU PROMPT CUSTOMIZADO');
  assertEquals(getPrompt('custom'), 'MEU PROMPT CUSTOMIZADO');
  // empty / whitespace is ignored (keeps the previous value / falls back)
  registerPrompt('blank', '   ');
  assert(!hasPrompt('blank'));
});

Deno.test('buildExtractionPrompt appends the invoice text under a marker', () => {
  const out = buildExtractionPrompt('TEMPLATE', 'Vencimento 15/06/2026');
  assertStringIncludes(out, 'TEMPLATE');
  assertStringIncludes(out, 'TEXTO DA FATURA:');
  assertStringIncludes(out, 'Vencimento 15/06/2026');
});
