/**
 * redact_integration.test.ts — T-331 (#42)
 *
 * Integration test: secret redaction is NEVER persisted to the sync-worker's
 * failure-path sinks. Drives the real `buildHandler` orchestration (sync-worker
 * index.ts) with an INJECTED fake Supabase client + fake `doImapFetch` that
 * throws an error whose message embeds real-looking secrets. We then capture
 * EVERY row/RPC argument the worker would have written and assert the secret
 * material is gone and the redaction marker is present.
 *
 * Sinks exercised by a single failing sync-worker run (see processOne, step 5c):
 *   - sync_runs.error_summary          (runUpdates → status='failed')
 *   - connected_emails.last_error      (record_mailbox_error RPC, p_error arg)
 *   - circuit_breakers failure reason  (circuit_record_failure RPC, p_reason)
 *   - domain_events.payload            (email.sync.auto_paused, on threshold)
 *
 * This is a DB-free integration test: no real Postgres is touched — a fake
 * client records what WOULD be persisted and we assert on that. It complements
 * the application-side, pattern-level redaction defined in T-315 / redact.ts
 * (redactSecrets / SECRET_PATTERNS) and the unit coverage in runs.test.ts and
 * index.test.ts; here we verify the *wiring*: that every persistence path the
 * worker uses on failure routes the message through redactSecrets first.
 *
 * Spec: §6.5 ("Vault decrypt — redação obrigatória de secrets em logs", last ¶).
 *
 * GAP (asserted explicitly in the 3rd test, NOT silently): redact.ts does NOT
 * currently implement Brazilian CPF/CNPJ patterns. The issue acceptance text
 * lists CPF/CNPJ, but the code does not redact them, so we MUST NOT assert they
 * are absent (that assertion would fail against real behavior). Instead we pin
 * the current behavior so the gap is visible and a follow-up that adds CPF/CNPJ
 * patterns will flip this guard and force this test to be updated.
 *
 * Ref: T-331; depends on T-315 (#23), T-321 (#32), T-325 (#36). Date: 2026-06-22
 */

import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1.0.0';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { buildHandler, type ImapFetchFn } from './index.ts';
import { redactSecrets } from '../_shared/redact.ts';

const NOW = Date.parse('2026-06-22T14:00:00.000Z');

// -- Seeded secret material. Every one of these is a pattern redact.ts DOES
//    implement, so it MUST NOT survive into any persisted value.
const APP_PW_4x4 = 'abcd efgh ijkl mnop'; // Gmail app password, 4×4 display form
const APP_PW_BLOCK = 'pwqprsltuvwxabcd'; // Gmail app password, 16-char block form
const LOGIN_PW = 's3cr3tImapPass'; // password inside an IMAP LOGIN echo
const IMAP_LOGIN = `LOGIN user@example.com ${LOGIN_PW}`;
const BEARER_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.PAYLOADSEGMENT01.SIGNATURESEG02';
const BEARER_HEADER = `Authorization: Bearer ${BEARER_TOKEN}`;

// -- Patterns redact.ts does NOT (yet) implement — see GAP note in the header.
const CPF = '529.982.247-25';
const CNPJ = '11.222.333/0001-81';

/** The error message the failing IMAP fetch throws — embeds every secret. */
const SECRET_ERROR_MESSAGE =
  `IMAP fetch failed: ${IMAP_LOGIN} | ${BEARER_HEADER} | app_password=${APP_PW_4x4} | ` +
  `alt_pw=${APP_PW_BLOCK} | cpf=${CPF} | cnpj=${CNPJ}`;

// Secret substrings that the IMPLEMENTED patterns must scrub out of any sink.
const IMPLEMENTED_SECRETS: ReadonlyArray<[string, string]> = [
  ['app password (4×4 form)', APP_PW_4x4],
  ['app password (16-char block)', APP_PW_BLOCK],
  ['IMAP LOGIN password', LOGIN_PW],
  ['Bearer token', BEARER_TOKEN],
];

/** A faithful, minimal fake of the supabase-js surface the worker calls. */
function fakeClient(scn: { paused?: boolean } = {}) {
  const cap = {
    deletes: [] as number[],
    setVts: [] as Record<string, unknown>[],
    events: [] as Record<string, unknown>[],
    circuitFailures: [] as Record<string, unknown>[],
    recordErrors: [] as Record<string, unknown>[],
    runUpserts: [] as Record<string, unknown>[],
    runUpdates: [] as Record<string, unknown>[],
    ceUpdates: [] as Record<string, unknown>[],
  };
  const settled = (data: unknown, error: { message: string } | null = null) => ({ data, error });

  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      switch (name) {
        case 'queue_read':
          return Promise.resolve(settled([{
            msg_id: 8,
            read_ct: 1,
            enqueued_at: 't',
            vt: 't',
            message: {
              connected_email_id: 'ce1',
              correlation_id: 'corr1',
              idempotency_key: 'ce1:2026-06-22T13:47:00.000Z',
            },
          }]));
        case 'queue_delete':
          cap.deletes.push(args.p_msg_id as number);
          return Promise.resolve(settled(true));
        case 'queue_set_vt':
          cap.setVts.push(args);
          return Promise.resolve(settled(null));
        case 'circuit_begin':
          return Promise.resolve(settled('closed'));
        case 'rate_limit_consume':
          return Promise.resolve(settled(1));
        case 'circuit_record_success':
          return Promise.resolve(settled(null));
        case 'circuit_record_failure':
          cap.circuitFailures.push(args);
          return Promise.resolve(settled(null));
        case 'record_mailbox_error':
          cap.recordErrors.push(args);
          return Promise.resolve(settled(scn.paused ?? false));
        default:
          return Promise.resolve(settled(null));
      }
    },
    from(table: string) {
      if (table === 'app_settings') {
        const c: Record<string, unknown> = {
          eq: () => c,
          is: () => c,
          in: () =>
            Promise.resolve(settled([
              { key: 'sync.max_retries', value: { v: 3 } },
              { key: 'sync.consecutive_error_threshold', value: { v: 5 } },
              { key: 'sync.interval_minutes', value: { v: 60 } },
              { key: 'sync.visibility_timeout_s', value: { v: 120 } },
              { key: 'sync.retry_base_s', value: { v: 60 } },
              { key: 'sync.retry_cap_s', value: { v: 1800 } },
            ])),
        };
        return { select: () => c };
      }
      if (table === 'domain_events') {
        return {
          insert: (row: Record<string, unknown>) => {
            cap.events.push(row);
            return Promise.resolve(settled(null));
          },
        };
      }
      if (table === 'connected_emails') {
        return {
          update: (patch: Record<string, unknown>) => {
            cap.ceUpdates.push(patch);
            const chain: Record<string, unknown> = {
              eq: () => chain,
              or: () => chain,
              select: () => Promise.resolve(settled([{ id: 'ce1', email_address: 'a@b.com' }])),
              then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) =>
                Promise.resolve(settled(null)).then(f, r),
            };
            return chain;
          },
          select: () => {
            const c: Record<string, unknown> = {
              eq: () => c,
              maybeSingle: () => Promise.resolve(settled({ email_address: 'a@b.com' })),
            };
            return c;
          },
        };
      }
      if (table === 'sync_runs') {
        return {
          select: () => {
            const c: Record<string, unknown> = {
              eq: () => c,
              maybeSingle: () => Promise.resolve(settled(null)), // first sight
            };
            return c;
          },
          upsert: (row: Record<string, unknown>) => {
            cap.runUpserts.push(row);
            return { select: () => ({ single: () => Promise.resolve(settled({ id: 'run-1' })) }) };
          },
          update: (patch: Record<string, unknown>) => ({
            eq: () => {
              cap.runUpdates.push(patch);
              return Promise.resolve(settled(null));
            },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
  return { client, cap };
}

/** Fake IMAP fetch that always fails with the secret-laden message. */
const failingFetch: ImapFetchFn = () => Promise.reject(new Error(SECRET_ERROR_MESSAGE));

function runFailingSync(scn: { paused?: boolean } = {}) {
  const f = fakeClient(scn);
  const res = buildHandler({
    client: f.client,
    requireAuth: () => true,
    now: () => NOW,
    doImapFetch: failingFetch,
  })(new Request('https://x.test/sync-worker', { method: 'POST' }));
  return { f, res };
}

/** Assert a persisted value redacted every IMPLEMENTED secret + carries a marker. */
function assertRedacted(label: string, value: unknown) {
  const s = String(value);
  for (const [name, secret] of IMPLEMENTED_SECRETS) {
    assert(
      !s.includes(secret),
      `${label}: leaked ${name} (${secret}) into persisted value: ${s}`,
    );
  }
  assertStringIncludes(s, '[REDACTED', `${label}: expected a redaction marker in: ${s}`);
}

Deno.test('failing sync persists a REDACTED sync_runs.error_summary, connected_emails.last_error, and circuit failure reason', async () => {
  const { f, res } = runFailingSync({ paused: false });
  const body = await (await res).json();
  assertEquals(body.retried, 1); // real failure → backoff/retry path taken

  // 1) sync_runs.error_summary
  const failed = f.cap.runUpdates.find((u) => u.status === 'failed');
  assert(failed, 'expected a failed sync_runs UPDATE');
  assertRedacted('sync_runs.error_summary', failed!.error_summary);

  // 2) connected_emails.last_error (written via record_mailbox_error RPC p_error)
  assertEquals(f.cap.recordErrors.length, 1);
  assertRedacted('connected_emails.last_error (record_mailbox_error.p_error)', f.cap.recordErrors[0].p_error);

  // 3) circuit_breakers failure reason (circuit_record_failure RPC p_reason)
  assertEquals(f.cap.circuitFailures.length, 1);
  assertRedacted('circuit_breakers (circuit_record_failure.p_reason)', f.cap.circuitFailures[0].p_reason);

  // The three sinks must agree: each is exactly redactSecrets(message).
  const expected = redactSecrets(SECRET_ERROR_MESSAGE);
  assertEquals(String(failed!.error_summary), expected);
  assertEquals(String(f.cap.recordErrors[0].p_error), expected);
  assertEquals(String(f.cap.circuitFailures[0].p_reason), expected);
});

Deno.test('auto-pause domain_events payload carries none of the seeded secrets', async () => {
  const { f, res } = runFailingSync({ paused: true });
  await (await res).json();

  const paused = f.cap.events.filter((e) => e.event_type === 'email.sync.auto_paused');
  assertEquals(paused.length, 1, 'expected exactly one auto_paused event');

  // The event payload must not contain any seeded secret anywhere in its JSON.
  const serialized = JSON.stringify(paused[0].payload);
  for (const [name, secret] of IMPLEMENTED_SECRETS) {
    assert(
      !serialized.includes(secret),
      `auto_paused payload leaked ${name} (${secret}): ${serialized}`,
    );
  }
});

Deno.test('GAP: CPF/CNPJ are NOT redacted by redact.ts today (guard so a future fix updates this test)', () => {
  // redact.ts has no Brazilian CPF/CNPJ pattern (T-315 scope). We pin the
  // CURRENT behavior rather than assert a behavior that is not implemented:
  // if/when CPF/CNPJ patterns are added, these assertions flip and force this
  // test — and the secret list above — to be updated. See header GAP note.
  const redacted = redactSecrets(SECRET_ERROR_MESSAGE);
  assert(
    redacted.includes(CPF),
    'CPF unexpectedly redacted — redact.ts gained a CPF pattern; promote CPF to IMPLEMENTED_SECRETS and assert its absence in the sinks.',
  );
  assert(
    redacted.includes(CNPJ),
    'CNPJ unexpectedly redacted — redact.ts gained a CNPJ pattern; promote CNPJ to IMPLEMENTED_SECRETS and assert its absence in the sinks.',
  );
});