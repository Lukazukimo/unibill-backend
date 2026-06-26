// Tests for scripts/gen_openapi.ts — the §E → OpenAPI document builder.
// Ref: T-625 (#160), spec §E. (Authored from §E: the project has no Zod schemas
// to introspect — see ADR follow-up.)

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { buildOpenApiDoc } from './gen_openapi.ts';

// Every endpoint in spec §E (method + path) must be documented.
const EXPECTED: Array<[string, string]> = [
  ['get', '/config/resolve'],
  ['post', '/emails/connect'],
  ['patch', '/emails/{id}/rotate-password'],
  ['delete', '/emails/{id}'],
  ['post', '/invitations/redeem'],
  ['post', '/admin/promote-system-admin'],
  ['post', '/admin/invoices/{id}/reextract'],
  ['post', '/privacy/export-my-data'],
  ['delete', '/privacy/my-account'],
  ['post', '/telemetry/ingest'],
  ['get', '/health'],
];

Deno.test('buildOpenApiDoc is an OpenAPI 3.1 document with info + security scheme', () => {
  // deno-lint-ignore no-explicit-any
  const doc = buildOpenApiDoc() as any;
  assertEquals(doc.openapi, '3.1.0');
  assert(doc.info?.title);
  assert(doc.info?.version);
  assert(doc.components?.securitySchemes?.bearerAuth, 'bearer JWT scheme present');
});

Deno.test('every §E endpoint is documented with the right method', () => {
  // deno-lint-ignore no-explicit-any
  const doc = buildOpenApiDoc() as any;
  for (const [method, path] of EXPECTED) {
    assert(doc.paths[path], `path ${path} present`);
    assert(doc.paths[path][method], `${method.toUpperCase()} ${path} present`);
    assert(
      doc.paths[path][method].responses?.['200'] || doc.paths[path][method].responses,
      `${path} has responses`,
    );
  }
});

Deno.test('no stray paths beyond §E', () => {
  // deno-lint-ignore no-explicit-any
  const doc = buildOpenApiDoc() as any;
  const documented = new Set<string>();
  for (const p of Object.keys(doc.paths)) {
    for (const m of Object.keys(doc.paths[p])) documented.add(`${m} ${p}`);
  }
  assertEquals(documented.size, EXPECTED.length);
});

Deno.test('public endpoints carry their documented error codes', () => {
  // deno-lint-ignore no-explicit-any
  const doc = buildOpenApiDoc() as any;
  // /invitations/redeem documents 403/404/429 per §E
  const redeem = doc.paths['/invitations/redeem'].post.responses;
  assert(redeem['404'] && redeem['403'] && redeem['429']);
  // /privacy/my-account documents 400 + 422
  const del = doc.paths['/privacy/my-account'].delete.responses;
  assert(del['400'] && del['422']);
});
