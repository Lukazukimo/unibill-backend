/**
 * vault.test.ts — T-403. getVaultSecret cache + TTL + miss, injected decrypt.
 */

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@^1.0.0';
import { clearVaultCache, getVaultSecret } from './vault.ts';

const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

Deno.test('decrypts once and serves subsequent reads from cache within TTL', async () => {
  clearVaultCache();
  let calls = 0;
  const decrypt = (_id: string) => {
    calls++;
    return Promise.resolve('secret-value');
  };
  const v1 = await getVaultSecret(ID, { decrypt, now: () => 1000, ttlMs: 60_000 });
  const v2 = await getVaultSecret(ID, { decrypt, now: () => 1100, ttlMs: 60_000 });
  assertEquals(v1, 'secret-value');
  assertEquals(v2, 'secret-value');
  assertEquals(calls, 1); // second read hit the cache
});

Deno.test('re-decrypts after the TTL expires', async () => {
  clearVaultCache();
  let calls = 0;
  const decrypt = (_id: string) => {
    calls++;
    return Promise.resolve(`v${calls}`);
  };
  const a = await getVaultSecret(ID, { decrypt, now: () => 1000, ttlMs: 100 });
  const b = await getVaultSecret(ID, { decrypt, now: () => 2000, ttlMs: 100 }); // past TTL
  assertEquals(a, 'v1');
  assertEquals(b, 'v2');
  assertEquals(calls, 2);
});

Deno.test('throws when the secret is missing (null) — caller falls back', async () => {
  clearVaultCache();
  await assertRejects(
    () => getVaultSecret(ID, { decrypt: () => Promise.resolve(null) }),
    Error,
    'not found',
  );
});

Deno.test('propagates a decrypt RPC error', async () => {
  clearVaultCache();
  await assertRejects(
    () => getVaultSecret(ID, { decrypt: () => Promise.reject(new Error('rpc boom')) }),
    Error,
    'rpc boom',
  );
});

Deno.test('distinct secret ids are cached independently', async () => {
  clearVaultCache();
  const decrypt = (id: string) => Promise.resolve(`val-for-${id}`);
  const a = await getVaultSecret('id-a', { decrypt, now: () => 0 });
  const b = await getVaultSecret('id-b', { decrypt, now: () => 0 });
  assert(a !== b);
  assertEquals(a, 'val-for-id-a');
  assertEquals(b, 'val-for-id-b');
});
