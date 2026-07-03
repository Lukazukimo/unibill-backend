// Tests for scripts/gen_openapi.ts — the OpenAPI document builder.
// Ref: T-625 (#160) + the gen-from-Zod follow-up (#265): request bodies with a
// Zod schema are derived from it; the rest are authored from §E.

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

// Schema-backed request bodies are DERIVED from the Zod schemas (#265): the
// generated JSON Schema must carry the runtime constraints, not a hand-written
// stand-in. If a validator's schema changes, this + the --check drift gate fail.
Deno.test('request bodies are derived from the Zod validators', () => {
  // deno-lint-ignore no-explicit-any
  const doc = buildOpenApiDoc() as any;
  const bodySchema = (path: string, method: string) =>
    doc.paths[path][method].requestBody.content['application/json'].schema;

  const redeem = bodySchema('/invitations/redeem', 'post');
  assertEquals(redeem.properties.code.pattern, '^[A-HJ-NP-Z2-9]{8}$');
  assertEquals(redeem.additionalProperties, false);

  const connect = bodySchema('/emails/connect', 'post');
  assertEquals(connect.properties.app_password.minLength, 16);
  assertEquals(connect.properties.app_password.pattern, '^[a-z]+$');
  // household_ids' dedup superRefine isn't representable → overridden shape.
  assertEquals(connect.properties.household_ids.items.format, 'uuid');

  const rotate = bodySchema('/emails/{id}/rotate-password', 'patch');
  assertEquals(rotate.properties.new_app_password.pattern, '^[a-z]+$');
});

// Every operation carries a unique operationId (#266) — required by the Redocly
// lint step and by client codegen.
Deno.test('every operation has a unique operationId', () => {
  // deno-lint-ignore no-explicit-any
  const doc = buildOpenApiDoc() as any;
  const ids: string[] = [];
  for (const ops of Object.values(doc.paths)) {
    for (const op of Object.values(ops as Record<string, { operationId?: string }>)) {
      assert(op.operationId, 'operation missing operationId');
      ids.push(op.operationId!);
    }
  }
  assertEquals(ids.length, EXPECTED.length);
  assertEquals(new Set(ids).size, ids.length, 'operationIds must be unique');
});
