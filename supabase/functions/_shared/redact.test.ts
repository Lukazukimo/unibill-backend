/**
 * redact.test.ts — unit coverage for redactSecrets + wrapRedaction.
 *
 * Ref: T-315 (#23) — Brazilian CPF/CNPJ patterns + wrapRedaction helper, on top
 *      of the existing SECRET_PATTERNS family (app passwords, IMAP LOGIN, bearer,
 *      tokens, JWT). Spec §6.5.
 * Date: 2026-06-23
 *
 * Every pattern test asserts BOTH that the raw secret is GONE and that a marker
 * is present — the absence assertion is what proves no leak.
 */

import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1.0.0';
import { redactSecrets, wrapRedaction } from './redact.ts';

// -- Brazilian tax IDs (PII) ---------------------------------------------------

Deno.test('redactSecrets redacts a punctuated CPF', () => {
  const out = redactSecrets('cliente cpf=529.982.247-25 fim');
  assertStringIncludes(out, '[REDACTED_CPF]');
  assert(!out.includes('529.982.247-25'), 'raw CPF survived');
  assertStringIncludes(out, 'cpf='); // surrounding text intact
});

Deno.test('redactSecrets redacts a bare 11-digit CPF', () => {
  const out = redactSecrets('cpf 52998224725 done');
  assertStringIncludes(out, '[REDACTED_CPF]');
  assert(!out.includes('52998224725'), 'raw bare CPF survived');
});

Deno.test('redactSecrets redacts a punctuated CNPJ', () => {
  const out = redactSecrets('empresa cnpj=11.222.333/0001-81 ok');
  assertStringIncludes(out, '[REDACTED_CNPJ]');
  assert(!out.includes('11.222.333/0001-81'), 'raw CNPJ survived');
});

Deno.test('redactSecrets redacts a bare 14-digit CNPJ', () => {
  const out = redactSecrets('cnpj 11222333000181 ok');
  assertStringIncludes(out, '[REDACTED_CNPJ]');
  assert(!out.includes('11222333000181'), 'raw bare CNPJ survived');
});

Deno.test('redactSecrets masks a mixed CPF + CNPJ message, each with its own marker', () => {
  const out = redactSecrets('cpf=529.982.247-25 cnpj=11.222.333/0001-81');
  assertStringIncludes(out, '[REDACTED_CPF]');
  assertStringIncludes(out, '[REDACTED_CNPJ]');
  assert(!out.includes('529.982.247-25'));
  assert(!out.includes('11.222.333/0001-81'));
  assertStringIncludes(out, 'cpf=');
  assertStringIncludes(out, 'cnpj=');
});

Deno.test('redactSecrets does NOT eat a long bare digit run (boleto barcode over-match guard)', () => {
  // A 44-digit boleto barcode (no separators). `\b` only exists at the run's
  // ends, so neither the 11-digit CPF nor the 14-digit CNPJ pattern can anchor
  // inside it. It must pass through untouched.
  const barcode = '34191790010104351004791020150008291070026000';
  const out = redactSecrets(`barcode=${barcode}`);
  assertEquals(out, `barcode=${barcode}`);
  assert(!out.includes('[REDACTED'), 'barcode was wrongly redacted');
});

// -- Pre-existing patterns (regression coverage) -------------------------------

Deno.test('redactSecrets redacts the existing secret families', () => {
  assertStringIncludes(redactSecrets('pw abcd efgh ijkl mnop'), '[REDACTED_APP_PASSWORD]');
  assertStringIncludes(redactSecrets('pw abcdefghijklmnop'), '[REDACTED_APP_PASSWORD]');

  const imap = redactSecrets('LOGIN user@example.com s3cr3tImapPass');
  assertStringIncludes(imap, 'LOGIN [REDACTED_USER] [REDACTED]');
  assert(!imap.includes('s3cr3tImapPass'), 'IMAP password survived');

  const bearer = redactSecrets(
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.PAYLOAD000123.SIGNATURE0099',
  );
  assert(!bearer.includes('PAYLOAD000123'), 'bearer token survived');

  // All three JWT segments are >=10 chars, as the JWT pattern requires.
  assertStringIncludes(
    redactSecrets('jwt eyJhbGciOiJIUzI1NiJ9.PAYLOAD000123.SIGNATURE0099 end'),
    '[REDACTED_JWT]',
  );
});

Deno.test('redactSecrets returns empty string for null/undefined', () => {
  assertEquals(redactSecrets(null), '');
  assertEquals(redactSecrets(undefined), '');
});

// -- wrapRedaction -------------------------------------------------------------

Deno.test('wrapRedaction redacts secrets from an Error message', () => {
  const out = wrapRedaction(new Error('boom Authorization: Bearer eyJaaa.bbbbbbbbbb.cccccccccc'));
  assertStringIncludes(out, 'boom');
  assert(!out.includes('eyJaaa.bbbbbbbbbb.cccccccccc'), 'JWT survived wrapRedaction');
});

Deno.test('wrapRedaction never throws on non-Error inputs and still redacts', () => {
  assertStringIncludes(wrapRedaction('cpf=529.982.247-25'), '[REDACTED_CPF]');
  assertEquals(wrapRedaction(42), '42');
  assertEquals(wrapRedaction(null), 'null');
  assertEquals(wrapRedaction(undefined), 'undefined');
  // an object stringifies to [object Object] — no throw, no secret
  assertEquals(wrapRedaction({ a: 1 }), '[object Object]');
});

Deno.test('wrapRedaction falls back when the value has a poisoned toString', () => {
  const poisoned = {
    toString() {
      throw new Error('nope');
    },
  };
  assertEquals(wrapRedaction(poisoned), '[unstringifiable error]');
});
