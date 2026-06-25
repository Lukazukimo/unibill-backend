/**
 * scoped_queries tests — the §9.4 export scoping contract (BR-020). A fake
 * Supabase client holds a TWO-user dataset and actually applies eq/or/gte/is/in
 * so the assertions prove real isolation: the export of user `u-me` must never
 * carry another user's rows, and connected_emails must never carry app_password.
 *
 * Ref: T-608 (#118), spec §9.4 / §E, BR-019, BR-020.
 */

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { collectExportData, listOwnedPdfRefs } from './scoped_queries.ts';

const ME = 'u-me';
const OTHER = 'u-other';
const NOW = Date.UTC(2026, 5, 25); // fixed clock
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

// --- fake Supabase client (records ops + applies filters) ------------------

type Row = Record<string, unknown>;
// deno-lint-ignore no-explicit-any
function makeFakeClient(tables: Record<string, Row[]>): any {
  return {
    from(table: string) {
      const rows = (tables[table] ?? []).map((r) => ({ ...r }));
      const preds: Array<(r: Row) => boolean> = [];
      let cols = '*';
      // deno-lint-ignore no-explicit-any
      const builder: any = {
        select(c: string) {
          cols = c;
          return builder;
        },
        eq(col: string, val: unknown) {
          preds.push((r) => r[col] === val);
          return builder;
        },
        or(filter: string) {
          const clauses = filter.split(',').map((c) => {
            const [col, op, val] = c.split('.');
            return { col, op, val };
          });
          preds.push((r) => clauses.some((cl) => cl.op === 'eq' && r[cl.col] === cl.val));
          return builder;
        },
        gte(col: string, val: unknown) {
          preds.push((r) => String(r[col]) >= String(val));
          return builder;
        },
        is(col: string, val: unknown) {
          preds.push((r) => r[col] === val);
          return builder;
        },
        in(col: string, vals: unknown[]) {
          preds.push((r) => vals.includes(r[col]));
          return builder;
        },
        _result() {
          let out = rows.filter((r) => preds.every((p) => p(r)));
          // emulate PostgREST embedding `households(...)`
          if (cols.includes('households(')) {
            out = out.map((r) => ({
              ...r,
              households: (tables.households ?? []).find((h) => h.id === r.household_id) ?? null,
            }));
          }
          return out;
        },
        maybeSingle() {
          const out = builder._result();
          return Promise.resolve({ data: out[0] ?? null, error: null });
        },
        then(
          resolve: (v: { data: Row[]; error: null }) => unknown,
          reject?: (e: unknown) => unknown,
        ) {
          try {
            return Promise.resolve({ data: builder._result(), error: null }).then(resolve, reject);
          } catch (e) {
            return Promise.reject(e).then(resolve, reject);
          }
        },
      };
      return builder;
    },
  };
}

function seed(): Record<string, Row[]> {
  return {
    user_profiles: [
      { user_id: ME, display_name: 'Me', avatar_url: null, locale: 'pt-BR', theme: 'system' },
    ],
    households: [
      { id: 'h1', name: 'Casa', created_at: iso(NOW) },
      { id: 'h2', name: 'Other house', created_at: iso(NOW) },
    ],
    members: [
      {
        id: 'm1',
        household_id: 'h1',
        user_id: ME,
        role: 'admin',
        joined_at: iso(NOW),
        deleted_at: null,
      },
      {
        id: 'm2',
        household_id: 'h1',
        user_id: OTHER,
        role: 'member',
        joined_at: iso(NOW),
        deleted_at: null,
      },
      {
        id: 'm3',
        household_id: 'h2',
        user_id: OTHER,
        role: 'admin',
        joined_at: iso(NOW),
        deleted_at: null,
      },
    ],
    connected_emails: [
      {
        id: 'e1',
        owner_user_id: ME,
        email_address: 'me@gmail.com',
        app_password_secret: 'SECRET-1',
        status: 'active',
        deleted_at: null,
      },
      {
        id: 'e2',
        owner_user_id: OTHER,
        email_address: 'other@gmail.com',
        app_password_secret: 'SECRET-2',
        status: 'active',
        deleted_at: null,
      },
    ],
    invoices: [
      {
        id: 'i1',
        connected_email_id: 'e1',
        paid_by: ME,
        created_by: OTHER,
        updated_by: null,
        storage_bucket: 'invoices',
        storage_path: 'inv/i1.pdf',
        pdf_archived_at: null,
      },
      {
        id: 'i2',
        connected_email_id: 'e1',
        paid_by: null,
        created_by: ME,
        updated_by: null,
        storage_bucket: 'invoices',
        storage_path: 'inv/i2.pdf',
        pdf_archived_at: iso(NOW),
      },
      {
        id: 'i3',
        connected_email_id: 'e2',
        paid_by: OTHER,
        created_by: OTHER,
        updated_by: OTHER,
        storage_bucket: 'invoices',
        storage_path: 'inv/i3.pdf',
        pdf_archived_at: null,
      },
      {
        id: 'i4',
        connected_email_id: 'e1',
        paid_by: OTHER,
        created_by: OTHER,
        updated_by: ME,
        storage_bucket: 'invoices',
        storage_path: 'inv/i4.pdf',
        pdf_archived_at: null,
      },
    ],
    consent_log: [
      { id: 'c1', user_id: ME, purpose: 'terms' },
      { id: 'c2', user_id: OTHER, purpose: 'terms' },
    ],
    domain_events: [
      { id: 'd1', actor_user_id: ME, occurred_at: iso(NOW - 1 * DAY) },
      { id: 'd2', actor_user_id: ME, occurred_at: iso(NOW - 100 * DAY) },
      { id: 'd3', actor_user_id: OTHER, occurred_at: iso(NOW - 1 * DAY) },
    ],
    client_telemetry: [
      { event_type: 'error', user_id: ME, occurred_at: iso(NOW - 1 * DAY) },
      { event_type: 'error', user_id: ME, occurred_at: iso(NOW - 40 * DAY) },
      { event_type: 'error', user_id: OTHER, occurred_at: iso(NOW - 1 * DAY) },
    ],
  };
}

// --- collectExportData ------------------------------------------------------

Deno.test('collectExportData scopes members to the caller only (no other-user rows)', async () => {
  const data = await collectExportData({ id: ME, email: 'me@x.co' }, makeFakeClient(seed()), NOW);
  assertEquals(data.members.length, 1);
  assertEquals((data.members[0] as Row).user_id, ME);
});

Deno.test('collectExportData returns only households the caller belongs to', async () => {
  const data = await collectExportData({ id: ME, email: 'me@x.co' }, makeFakeClient(seed()), NOW);
  assertEquals(data.households.length, 1);
  const hh = data.households[0] as Row;
  assertEquals(hh.household_id, 'h1');
  assertEquals(hh.role, 'admin');
});

Deno.test('collectExportData strips app_password_secret from connected_emails', async () => {
  const data = await collectExportData({ id: ME, email: 'me@x.co' }, makeFakeClient(seed()), NOW);
  assertEquals(data.connected_emails.length, 1);
  const row = data.connected_emails[0] as Row;
  assertEquals(row.owner_user_id, ME);
  assert(!('app_password_secret' in row), 'app_password_secret must not be exported');
});

Deno.test('collectExportData includes only invoices the caller touched (BR-020)', async () => {
  const data = await collectExportData({ id: ME, email: 'me@x.co' }, makeFakeClient(seed()), NOW);
  const ids = (data.invoices as Row[]).map((r) => r.id).sort();
  assertEquals(ids, ['i1', 'i2', 'i4']); // i3 (other-only) excluded
});

Deno.test('collectExportData scopes consent_log to the caller', async () => {
  const data = await collectExportData({ id: ME, email: 'me@x.co' }, makeFakeClient(seed()), NOW);
  assertEquals(data.consent_log.length, 1);
  assertEquals((data.consent_log[0] as Row).user_id, ME);
});

Deno.test('collectExportData limits domain_events to caller + last 90 days', async () => {
  const data = await collectExportData({ id: ME, email: 'me@x.co' }, makeFakeClient(seed()), NOW);
  const ids = (data.domain_events as Row[]).map((r) => r.id);
  assertEquals(ids, ['d1']); // d2 too old, d3 other actor
});

Deno.test('collectExportData limits client_telemetry to caller + last 30 days', async () => {
  const data = await collectExportData({ id: ME, email: 'me@x.co' }, makeFakeClient(seed()), NOW);
  assertEquals(data.client_telemetry.length, 1);
  assertEquals((data.client_telemetry[0] as Row).user_id, ME);
});

Deno.test('collectExportData profile carries the caller email + display_name', async () => {
  const data = await collectExportData({ id: ME, email: 'me@x.co' }, makeFakeClient(seed()), NOW);
  assertEquals((data.profile as Row).email, 'me@x.co');
  assertEquals((data.profile as Row).display_name, 'Me');
});

// --- listOwnedPdfRefs -------------------------------------------------------

Deno.test('listOwnedPdfRefs returns non-archived PDFs from caller-owned emails only', async () => {
  const refs = await listOwnedPdfRefs(ME, makeFakeClient(seed()));
  const ids = refs.map((r) => r.invoiceId).sort();
  assertEquals(ids, ['i1', 'i4']); // i2 archived, i3 not owned by me
  assertEquals(refs.find((r) => r.invoiceId === 'i1')?.entryName, 'invoice_pdfs/i1.pdf');
  assertEquals(refs.find((r) => r.invoiceId === 'i1')?.bucket, 'invoices');
});

Deno.test('listOwnedPdfRefs returns [] when the caller owns no emails', async () => {
  const refs = await listOwnedPdfRefs('nobody', makeFakeClient(seed()));
  assertEquals(refs, []);
});
