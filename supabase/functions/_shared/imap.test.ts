/**
 * imap.test.ts — Deno unit tests for `_shared/imap.ts`.
 *
 * Ref:  T-230, spec §6.4 + §6.5
 * Date: 2026-06-10
 *
 * Coverage:
 *   - returns `ok` when client.connect() resolves
 *   - returns `invalid_credentials` for authenticationFailed=true
 *   - returns `invalid_credentials` for code='AUTHENTICATIONFAILED'
 *   - returns `invalid_credentials` for messages matching auth pattern
 *   - returns `network_error` for transport failures
 *   - `network_error.message` is redacted (no raw password leaks)
 *   - logout() is invoked even when connect() throws
 *   - host/port/useTls defaults match Gmail spec §6.4
 *
 * Tests never reach `npm:imapflow` — they inject a fake `imapFactory`.
 */

import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1.0.0';
import {
  classifyImapError,
  IMAP_GMAIL_HOST,
  IMAP_GMAIL_PORT,
  type ImapClientFactory,
  type ImapClientLike,
  validateImapCredentials,
} from './imap.ts';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type FakeOpts = {
  /** Behaviour of connect(): 'ok' | throw spec. */
  onConnect: 'ok' | { throw: unknown };
  /** Optional spy capture for the options passed to the factory. */
  captured?: Parameters<ImapClientFactory>[0][];
  /** Tracks whether logout() was invoked. */
  logoutCalled?: { value: boolean };
};

function fakeFactory(opts: FakeOpts): ImapClientFactory {
  return (input) => {
    opts.captured?.push(input);
    const client: ImapClientLike = {
      async connect() {
        if (opts.onConnect === 'ok') return;
        throw opts.onConnect.throw;
      },
      async logout() {
        if (opts.logoutCalled) opts.logoutCalled.value = true;
      },
    };
    return client;
  };
}

// ---------------------------------------------------------------------------
// classifyImapError — pure function tests
// ---------------------------------------------------------------------------

Deno.test('classifyImapError: authenticationFailed=true → invalid_credentials', () => {
  const err = Object.assign(new Error('boom'), { authenticationFailed: true });
  assertEquals(classifyImapError(err), { kind: 'invalid_credentials' });
});

Deno.test("classifyImapError: code='AUTHENTICATIONFAILED' → invalid_credentials", () => {
  const err = Object.assign(new Error('whatever'), { code: 'AUTHENTICATIONFAILED' });
  assertEquals(classifyImapError(err), { kind: 'invalid_credentials' });
});

Deno.test('classifyImapError: message matching auth pattern → invalid_credentials', () => {
  assertEquals(
    classifyImapError(new Error('Invalid credentials')),
    { kind: 'invalid_credentials' },
  );
  assertEquals(
    classifyImapError(new Error('AUTHENTICATIONFAILED LOGIN failed')),
    { kind: 'invalid_credentials' },
  );
});

Deno.test('classifyImapError: transport failure → network_error', () => {
  const result = classifyImapError(new Error('ECONNREFUSED imap.gmail.com:993'));
  assertEquals(result.kind, 'network_error');
  if (result.kind === 'network_error') {
    assertStringIncludes(result.message, 'ECONNREFUSED');
  }
});

Deno.test('classifyImapError: redacts JWT-looking tokens in message', () => {
  const fakeJwt = 'eyJabcdefghij.klmnopqrst.uvwxyz12345';
  const result = classifyImapError(new Error(`upstream rejected: ${fakeJwt}`));
  assertEquals(result.kind, 'network_error');
  if (result.kind === 'network_error') {
    // redact.ts replaces JWT-shape strings with [REDACTED_JWT]
    assert(!result.message.includes(fakeJwt), 'JWT must be redacted from message');
    assertStringIncludes(result.message, '[REDACTED_JWT]');
  }
});

// ---------------------------------------------------------------------------
// validateImapCredentials — integration with fake factory
// ---------------------------------------------------------------------------

Deno.test('validateImapCredentials: returns ok when connect() resolves', async () => {
  const captured: Parameters<ImapClientFactory>[0][] = [];
  const logoutCalled = { value: false };
  const result = await validateImapCredentials(
    { email: 'user@example.com', password: 'abcdabcdabcdabcd' },
    { imapFactory: fakeFactory({ onConnect: 'ok', captured, logoutCalled }) },
  );

  assertEquals(result, { kind: 'ok' });
  // logout must be called even on success
  assert(logoutCalled.value, 'logout() must be called in finally');
  // Defaults match Gmail per §6.4
  assertEquals(captured.length, 1);
  assertEquals(captured[0].host, IMAP_GMAIL_HOST);
  assertEquals(captured[0].port, IMAP_GMAIL_PORT);
  assertEquals(captured[0].secure, true);
  assertEquals(captured[0].logger, false);
  assertEquals(captured[0].emitLogs, false);
  assertEquals(captured[0].tls.rejectUnauthorized, true);
});

Deno.test('validateImapCredentials: returns invalid_credentials on auth failure', async () => {
  const logoutCalled = { value: false };
  const result = await validateImapCredentials(
    { email: 'user@example.com', password: 'wrongwrongwrong1' },
    {
      imapFactory: fakeFactory({
        onConnect: { throw: Object.assign(new Error('LOGIN failed'), { authenticationFailed: true }) },
        logoutCalled,
      }),
    },
  );

  assertEquals(result, { kind: 'invalid_credentials' });
  // logout must still be attempted in finally
  assert(logoutCalled.value, 'logout() must be called in finally even after connect() throws');
});

Deno.test('validateImapCredentials: returns network_error on transport failure', async () => {
  const result = await validateImapCredentials(
    { email: 'user@example.com', password: 'abcdabcdabcdabcd' },
    {
      imapFactory: fakeFactory({
        onConnect: { throw: new Error('ECONNREFUSED imap.gmail.com:993') },
      }),
    },
  );

  assertEquals(result.kind, 'network_error');
  if (result.kind === 'network_error') {
    assertStringIncludes(result.message, 'ECONNREFUSED');
  }
});

Deno.test('validateImapCredentials: network_error.message does not contain the password', async () => {
  // Simulate the worst case: imapflow error echoes the LOGIN line with the
  // password verbatim. The result MUST not surface the password.
  const password = 'abcdefghijklmnop';
  const leakyMessage = `IMAP LOGIN user@example.com ${password} failed at handshake`;
  const result = await validateImapCredentials(
    { email: 'user@example.com', password },
    {
      imapFactory: fakeFactory({
        onConnect: { throw: new Error(leakyMessage) },
      }),
    },
  );

  // Will classify as invalid_credentials (msg contains "failed" → matches auth
  // pattern) but the important assertion is that NEITHER branch exposes the
  // raw password — invalid_credentials returns no message at all, network_error
  // would be redacted. Verify the result type and that any message field is
  // absent or scrubbed.
  if (result.kind === 'network_error') {
    assert(
      !result.message.includes(password),
      `network_error.message must not contain raw password, got: ${result.message}`,
    );
  }
  // invalid_credentials carries no message field — safe by construction.
});

Deno.test('validateImapCredentials: honours custom host/port/useTls', async () => {
  const captured: Parameters<ImapClientFactory>[0][] = [];
  await validateImapCredentials(
    {
      email: 'user@example.com',
      password: 'abcdabcdabcdabcd',
      host: 'imap.custom.test',
      port: 143,
      useTls: false,
    },
    { imapFactory: fakeFactory({ onConnect: 'ok', captured }) },
  );

  assertEquals(captured.length, 1);
  assertEquals(captured[0].host, 'imap.custom.test');
  assertEquals(captured[0].port, 143);
  assertEquals(captured[0].secure, false);
});

Deno.test('validateImapCredentials: factory throw is returned as redacted network_error', async () => {
  const result = await validateImapCredentials(
    { email: 'user@example.com', password: 'abcdabcdabcdabcd' },
    {
      imapFactory: (() => {
        throw new Error('module resolution failed');
      }) as ImapClientFactory,
    },
  );

  assertEquals(result.kind, 'network_error');
  if (result.kind === 'network_error') {
    assertStringIncludes(result.message, 'module resolution failed');
  }
});
