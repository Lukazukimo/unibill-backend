/**
 * correlation.test.ts — example deno test proving the test runner is wired.
 *
 * Ref: T-125, spec §4.2 / §4.2.1
 * Date: 2026-06-10
 *
 * Run via `deno task test` from repo root.
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { newCorrelationId, withCorrelation } from './correlation.ts';
import { assertIsUuid, makeRequest } from './_test_utils.ts';

Deno.test('newCorrelationId mints a fresh UUID when no header is present', () => {
  const id = newCorrelationId();
  assertIsUuid(id);
});

Deno.test('newCorrelationId reuses the inbound x-correlation-id header', () => {
  const inbound = '11111111-2222-4333-8444-555555555555';
  const req = makeRequest('https://example.test/fn', {
    headers: { 'x-correlation-id': inbound },
  });
  assertEquals(newCorrelationId(req), inbound);
});

Deno.test('newCorrelationId ignores malformed inbound headers', () => {
  const req = makeRequest('https://example.test/fn', {
    headers: { 'x-correlation-id': 'not-a-uuid!' },
  });
  const id = newCorrelationId(req);
  assertIsUuid(id);
  assert(id !== 'not-a-uuid!');
});

Deno.test('withCorrelation injects a context with a correlation_id', async () => {
  let observedId: string | null = null;
  const handler = withCorrelation((ctx, _req) => {
    observedId = ctx.correlation_id;
    return Promise.resolve(new Response('ok'));
  });

  const res = await handler(makeRequest());
  assertEquals(res.status, 200);
  assertIsUuid(observedId);
});

Deno.test('withCorrelation emits x-correlation-id on the response (generated id)', async () => {
  let observedId: string | null = null;
  const handler = withCorrelation((ctx, _req) => {
    observedId = ctx.correlation_id;
    return Promise.resolve(new Response('ok'));
  });

  const res = await handler(makeRequest());
  assertEquals(res.status, 200);
  assertEquals(await res.text(), 'ok'); // body preserved
  const header = res.headers.get('x-correlation-id');
  assertIsUuid(header);
  assertEquals(header, observedId); // response header === ctx id
});

Deno.test('withCorrelation echoes the inbound x-correlation-id on the response', async () => {
  const inbound = '11111111-2222-4333-8444-555555555555';
  const handler = withCorrelation((_ctx, _req) => Promise.resolve(new Response('ok')));

  const res = await handler(makeRequest('https://example.test/fn', {
    headers: { 'x-correlation-id': inbound },
  }));
  assertEquals(res.headers.get('x-correlation-id'), inbound);
});

Deno.test('withCorrelation preserves handler status + content-type when adding the header', async () => {
  const handler = withCorrelation((_ctx, _req) =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    )
  );

  const res = await handler(makeRequest());
  assertEquals(res.status, 201);
  assertEquals(res.headers.get('content-type'), 'application/json');
  assertIsUuid(res.headers.get('x-correlation-id'));
});
