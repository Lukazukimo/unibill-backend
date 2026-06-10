/**
 * auth-consent-status tests — method/auth gates, app_settings + consent_log
 * fan-out, per-purpose computation, domain_event emission, and the full
 * re-consent loop (bump terms_version → needs_reconsent true → accept new
 * version → needs_reconsent false).
 *
 * Ref:  T-229, spec §5.9 (re-consent gate) + BR-017 (consent.required event)
 * Date: 2026-06-10
 *
 * Covered branches:
 *   - method gate (non-GET)                                          → 405
 *   - JWT missing                                                     → 401
 *   - app_settings query error                                        → 500
 *   - consent_log query error                                         → 500
 *   - no active consents, versions published                          → needs_reconsent=true
 *                                                                       + event emitted
 *   - active versions match published                                 → needs_reconsent=false
 *                                                                       + NO event emitted
 *   - terms accepted matches, privacy missing                         → needs_reconsent=true,
 *                                                                       only privacy stale
 *   - app_settings missing both gating keys                           → needs_reconsent=false
 *                                                                       + warn logged
 *   - full re-consent loop simulation (bump → status flips → accept → flips back)
 *   - non-gating purpose (telemetry) DOES NOT influence needs_reconsent
 *     but APPEARS in active[]
 *   - computePurposeStatus / extractVersionFromSetting pure helpers
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import {
import { nonNull } from '../_shared/_test_utils.ts';
  buildHandler,
  computePurposeStatus,
  type ConsentPurpose,
  type ConsentStatusResponse,
  extractVersionFromSetting,
  type HandlerDeps,
} from './index.ts';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test('extractVersionFromSetting returns null for missing/malformed rows', () => {
  assertEquals(extractVersionFromSetting(null), null);
  assertEquals(extractVersionFromSetting(undefined), null);
  assertEquals(extractVersionFromSetting({ value: null }), null);
  assertEquals(extractVersionFromSetting({ value: 'not-an-object' }), null);
  assertEquals(extractVersionFromSetting({ value: {} }), null);
  assertEquals(extractVersionFromSetting({ value: { v: 42 } }), null);
  assertEquals(extractVersionFromSetting({ value: { v: '' } }), null);
  assertEquals(extractVersionFromSetting({ value: { v: '   ' } }), null);
});

Deno.test('extractVersionFromSetting returns trimmed string when valid', () => {
  assertEquals(
    extractVersionFromSetting({ value: { v: 'v1.0-2026-06' } }),
    'v1.0-2026-06',
  );
  assertEquals(
    extractVersionFromSetting({ value: { v: '  v2.0  ' } }),
    'v2.0',
  );
});

Deno.test('computePurposeStatus null published = no enforcement', () => {
  const s = computePurposeStatus(null, null);
  assertEquals(s.needs_reconsent, false);
  assertEquals(s.published, null);
  assertEquals(s.accepted, null);
});

Deno.test('computePurposeStatus published + no accepted = needs_reconsent', () => {
  const s = computePurposeStatus('v1.0-2026-06', null);
  assertEquals(s.needs_reconsent, true);
});

Deno.test('computePurposeStatus matching versions = no re-consent', () => {
  const s = computePurposeStatus('v1.0-2026-06', 'v1.0-2026-06');
  assertEquals(s.needs_reconsent, false);
});

Deno.test('computePurposeStatus mismatched versions = needs_reconsent', () => {
  const s = computePurposeStatus('v2.0-2026-09', 'v1.0-2026-06');
  assertEquals(s.needs_reconsent, true);
  assertEquals(s.published, 'v2.0-2026-09');
  assertEquals(s.accepted, 'v1.0-2026-06');
});

// ---------------------------------------------------------------------------
// Fake Supabase client
// ---------------------------------------------------------------------------

type ConsentRow = {
  user_id: string;
  purpose: ConsentPurpose;
  version: string;
  accepted_at: string;
  revoked_at: string | null;
};

type SettingRow = {
  key: string;
  scope: 'global' | 'household' | 'user';
  scope_id: string | null;
  // deno-lint-ignore no-explicit-any
  value: any;
};

type FakeState = {
  settings: SettingRow[];
  consents: ConsentRow[];
  /** Force the next app_settings .in()/.select() chain to fail. */
  forceSettingsError?: { message: string };
  /** Force the next consent_log SELECT to fail. */
  forceConsentError?: { message: string };
};

function freshState(over: Partial<FakeState> = {}): FakeState {
  return {
    settings: [],
    consents: [],
    ...over,
  };
}

function defaultSeededSettings(): SettingRow[] {
  return [
    {
      key: 'legal.terms_version',
      scope: 'global',
      scope_id: null,
      value: { v: 'v1.0-2026-06' },
    },
    {
      key: 'legal.privacy_version',
      scope: 'global',
      scope_id: null,
      value: { v: 'v1.0-2026-06' },
    },
  ];
}

// deno-lint-ignore no-explicit-any
function makeFakeClient(state: FakeState): any {
  return {
    from(table: string) {
      if (table === 'app_settings') return buildSettingsBuilder(state);
      if (table === 'consent_log') return buildConsentBuilder(state);
      throw new Error(`unhandled table ${table}`);
    },
  };
}

// deno-lint-ignore no-explicit-any
function buildSettingsBuilder(state: FakeState): any {
  // deno-lint-ignore no-explicit-any
  const filters: Array<(r: any) => boolean> = [];

  // deno-lint-ignore no-explicit-any
  const builder: any = {
    select(_cols: string) {
      return builder;
    },
    eq(col: string, val: unknown) {
      filters.push((r) => r[col] === val);
      return builder;
    },
    is(col: string, val: unknown) {
      filters.push((r) => r[col] === val);
      return builder;
    },
    in(col: string, vals: unknown[]) {
      filters.push((r) => vals.includes(r[col]));
      // Terminal for the settings query in production code.
      if (state.forceSettingsError) {
        return Promise.resolve({ data: null, error: state.forceSettingsError });
      }
      const matched = state.settings.filter((r) => filters.every((f) => f(r)));
      return Promise.resolve({ data: matched, error: null });
    },
  };
  return builder;
}

// deno-lint-ignore no-explicit-any
function buildConsentBuilder(state: FakeState): any {
  // deno-lint-ignore no-explicit-any
  const filters: Array<(r: any) => boolean> = [];

  // deno-lint-ignore no-explicit-any
  const builder: any = {
    select(_cols: string) {
      return builder;
    },
    eq(col: string, val: unknown) {
      filters.push((r) => r[col] === val);
      return builder;
    },
    is(col: string, val: unknown) {
      filters.push((r) => r[col] === val);
      return builder;
    },
    order(col: string) {
      if (state.forceConsentError) {
        return Promise.resolve({ data: null, error: state.forceConsentError });
      }
      const matched = state.consents.filter((r) => filters.every((f) => f(r)));
      matched.sort((a, b) =>
        String(a[col as keyof ConsentRow]).localeCompare(
          String(b[col as keyof ConsentRow]),
        )
      );
      return Promise.resolve({ data: matched, error: null });
    },
  };
  return builder;
}

function callerStub(user: { id: string } | null): HandlerDeps['getCallerUser'] {
  return () => Promise.resolve(user);
}

function makeRequest(opts: { method?: string } = {}): Request {
  return new Request('https://x.test/auth/consent-status', {
    method: opts.method ?? 'GET',
  });
}

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------

Deno.test('handler returns 405 for non-GET', async () => {
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1' }),
    client: makeFakeClient(freshState()),
  });
  const res = await handler(makeRequest({ method: 'POST' }));
  assertEquals(res.status, 405);
});

Deno.test('handler returns 401 when JWT missing', async () => {
  const handler = buildHandler({
    getCallerUser: callerStub(null),
    client: makeFakeClient(freshState()),
  });
  const res = await handler(makeRequest());
  assertEquals(res.status, 401);
});

Deno.test('handler returns 500 when app_settings query fails', async () => {
  const state = freshState({
    forceSettingsError: { message: 'pg outage' },
  });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1' }),
    client: makeFakeClient(state),
  });
  const res = await handler(makeRequest());
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.code, 'settings_query_failed');
});

Deno.test('handler returns 500 when consent_log query fails', async () => {
  const state = freshState({
    settings: defaultSeededSettings(),
    forceConsentError: { message: 'pg outage' },
  });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1' }),
    client: makeFakeClient(state),
  });
  const res = await handler(makeRequest());
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.code, 'consent_query_failed');
});

Deno.test('no active consents + published versions → needs_reconsent=true + event emitted', async () => {
  const state = freshState({
    settings: defaultSeededSettings(),
    consents: [],
  });
  let emitted: { type: string; payload: unknown } | null = null;
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1' }),
    client: makeFakeClient(state),
    emitEvent: (e) => {
      emitted = { type: e.type, payload: e.payload };
      return Promise.resolve();
    },
  });
  const res = await handler(makeRequest());
  assertEquals(res.status, 200);
  const body = (await res.json()) as ConsentStatusResponse;
  assertEquals(body.needs_reconsent, true);
  assertEquals(body.purposes.terms.needs_reconsent, true);
  assertEquals(body.purposes.privacy.needs_reconsent, true);
  assertEquals(body.purposes.terms.published, 'v1.0-2026-06');
  assertEquals(body.purposes.terms.accepted, null);
  assertEquals(body.active.length, 0);

  // Event emitted with both stale purposes.
  assert(emitted !== null);
  const emittedEvent = nonNull(emitted);
  assertEquals(emittedEvent.type, 'consent.required');
  const payload = emittedEvent.payload as {
    version: number;
    data: { stale_purposes: string[] };
  };
  assertEquals(payload.version, 1);
  assertEquals(payload.data.stale_purposes.sort(), ['privacy', 'terms']);
});

Deno.test('matched versions → needs_reconsent=false + NO event emitted', async () => {
  const state = freshState({
    settings: defaultSeededSettings(),
    consents: [
      {
        user_id: 'u1',
        purpose: 'terms',
        version: 'v1.0-2026-06',
        accepted_at: '2026-06-01T10:00:00.000Z',
        revoked_at: null,
      },
      {
        user_id: 'u1',
        purpose: 'privacy',
        version: 'v1.0-2026-06',
        accepted_at: '2026-06-01T10:00:00.000Z',
        revoked_at: null,
      },
    ],
  });
  let emittedCount = 0;
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1' }),
    client: makeFakeClient(state),
    emitEvent: () => {
      emittedCount++;
      return Promise.resolve();
    },
  });
  const res = await handler(makeRequest());
  assertEquals(res.status, 200);
  const body = (await res.json()) as ConsentStatusResponse;
  assertEquals(body.needs_reconsent, false);
  assertEquals(body.purposes.terms.needs_reconsent, false);
  assertEquals(body.purposes.privacy.needs_reconsent, false);
  assertEquals(body.purposes.terms.accepted, 'v1.0-2026-06');
  assertEquals(body.active.length, 2);
  assertEquals(emittedCount, 0);
});

Deno.test('terms matches, privacy missing → needs_reconsent=true with privacy-only stale', async () => {
  const state = freshState({
    settings: defaultSeededSettings(),
    consents: [
      {
        user_id: 'u1',
        purpose: 'terms',
        version: 'v1.0-2026-06',
        accepted_at: '2026-06-01T10:00:00.000Z',
        revoked_at: null,
      },
    ],
  });
  let emitted: { payload: unknown } | null = null;
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1' }),
    client: makeFakeClient(state),
    emitEvent: (e) => {
      emitted = { payload: e.payload };
      return Promise.resolve();
    },
  });
  const res = await handler(makeRequest());
  assertEquals(res.status, 200);
  const body = (await res.json()) as ConsentStatusResponse;
  assertEquals(body.needs_reconsent, true);
  assertEquals(body.purposes.terms.needs_reconsent, false);
  assertEquals(body.purposes.privacy.needs_reconsent, true);

  assert(emitted !== null);
  const emittedEvent = nonNull(emitted);
  const payload = emittedEvent.payload as { data: { stale_purposes: string[] } };
  assertEquals(payload.data.stale_purposes, ['privacy']);
});

Deno.test('missing both gating keys → needs_reconsent=false (mis-seeded env tolerated)', async () => {
  const state = freshState({
    settings: [], // app_settings rows entirely absent
    consents: [],
  });
  let emittedCount = 0;
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1' }),
    client: makeFakeClient(state),
    emitEvent: () => {
      emittedCount++;
      return Promise.resolve();
    },
  });
  const res = await handler(makeRequest());
  assertEquals(res.status, 200);
  const body = (await res.json()) as ConsentStatusResponse;
  assertEquals(body.needs_reconsent, false);
  assertEquals(body.purposes.terms.published, null);
  assertEquals(body.purposes.privacy.published, null);
  assertEquals(emittedCount, 0);
});

Deno.test('non-gating purposes (telemetry) appear in active[] but do NOT trigger reconsent', async () => {
  const state = freshState({
    settings: defaultSeededSettings(),
    consents: [
      {
        user_id: 'u1',
        purpose: 'terms',
        version: 'v1.0-2026-06',
        accepted_at: '2026-06-01T10:00:00.000Z',
        revoked_at: null,
      },
      {
        user_id: 'u1',
        purpose: 'privacy',
        version: 'v1.0-2026-06',
        accepted_at: '2026-06-01T10:00:00.000Z',
        revoked_at: null,
      },
      {
        user_id: 'u1',
        purpose: 'telemetry',
        version: 'tele-v1',
        accepted_at: '2026-06-05T10:00:00.000Z',
        revoked_at: null,
      },
    ],
  });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1' }),
    client: makeFakeClient(state),
  });
  const res = await handler(makeRequest());
  assertEquals(res.status, 200);
  const body = (await res.json()) as ConsentStatusResponse;
  assertEquals(body.needs_reconsent, false);
  assertEquals(body.active.length, 3);
  const telemetry = body.active.find((a) => a.purpose === 'telemetry');
  assert(telemetry);
  assertEquals(telemetry!.version, 'tele-v1');
});

Deno.test('revoked consents are excluded (revoked_at filter)', async () => {
  // Even though a row exists for terms@v1.0-2026-06, it's REVOKED — should
  // be treated as "no active accepted" and flagged for re-consent.
  const state = freshState({
    settings: defaultSeededSettings(),
    consents: [
      {
        user_id: 'u1',
        purpose: 'terms',
        version: 'v1.0-2026-06',
        accepted_at: '2026-06-01T10:00:00.000Z',
        revoked_at: '2026-06-02T10:00:00.000Z',
      },
      {
        user_id: 'u1',
        purpose: 'privacy',
        version: 'v1.0-2026-06',
        accepted_at: '2026-06-01T10:00:00.000Z',
        revoked_at: null,
      },
    ],
  });
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1' }),
    client: makeFakeClient(state),
  });
  const res = await handler(makeRequest());
  assertEquals(res.status, 200);
  const body = (await res.json()) as ConsentStatusResponse;
  assertEquals(body.needs_reconsent, true);
  assertEquals(body.purposes.terms.needs_reconsent, true);
  assertEquals(body.purposes.privacy.needs_reconsent, false);
});

Deno.test('full re-consent loop: bump terms_version → status flips → accept new → flips back', async () => {
  // 1) Initial: user has accepted v1.0; published is v1.0 → no re-consent.
  const state: FakeState = {
    settings: defaultSeededSettings(),
    consents: [
      {
        user_id: 'u1',
        purpose: 'terms',
        version: 'v1.0-2026-06',
        accepted_at: '2026-06-01T10:00:00.000Z',
        revoked_at: null,
      },
      {
        user_id: 'u1',
        purpose: 'privacy',
        version: 'v1.0-2026-06',
        accepted_at: '2026-06-01T10:00:00.000Z',
        revoked_at: null,
      },
    ],
  };
  const handler = buildHandler({
    getCallerUser: callerStub({ id: 'u1' }),
    client: makeFakeClient(state),
  });

  let res = await handler(makeRequest());
  let body = (await res.json()) as ConsentStatusResponse;
  assertEquals(body.needs_reconsent, false);

  // 2) Ops bumps the published terms_version to v2.0.
  state.settings = state.settings.map((s) =>
    s.key === 'legal.terms_version'
      ? { ...s, value: { v: 'v2.0-2026-09' } }
      : s
  );

  res = await handler(makeRequest());
  body = (await res.json()) as ConsentStatusResponse;
  assertEquals(body.needs_reconsent, true);
  assertEquals(body.purposes.terms.published, 'v2.0-2026-09');
  assertEquals(body.purposes.terms.accepted, 'v1.0-2026-06');
  assertEquals(body.purposes.privacy.needs_reconsent, false);

  // 3) User re-accepts via consent-accept (we simulate the DB write here):
  //    the old terms row is revoked, a new active terms row at v2.0 inserted.
  state.consents = state.consents.map((c) =>
    c.purpose === 'terms'
      ? { ...c, revoked_at: '2026-09-02T10:00:00.000Z' }
      : c
  );
  state.consents.push({
    user_id: 'u1',
    purpose: 'terms',
    version: 'v2.0-2026-09',
    accepted_at: '2026-09-02T10:00:01.000Z',
    revoked_at: null,
  });

  res = await handler(makeRequest());
  body = (await res.json()) as ConsentStatusResponse;
  assertEquals(body.needs_reconsent, false);
  assertEquals(body.purposes.terms.accepted, 'v2.0-2026-09');
});
