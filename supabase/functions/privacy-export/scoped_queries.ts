/**
 * scoped_queries.ts — the §9.4 "MEUS dados" export scoping (BR-020).
 *
 * Ref: T-608 (#118), spec §9.4 / §E (export-my-data), BR-019, BR-020.
 * Date: 2026-06-25
 *
 * Every query is strictly scoped to the caller. The hard rules (spec §9.4 table):
 *   - members / consent_log / client_telemetry / connected_emails  → owner = me
 *   - households                                                   → only the
 *     households I am a member of (my role + join date; NO other members)
 *   - invoices                                                     → only the
 *     ones I touched: paid_by = me OR created_by = me OR updated_by = me (BR-020)
 *   - domain_events                                                → actor = me,
 *     last 90 days
 *   - client_telemetry                                             → me, last 30 days
 *   - connected_emails                                             → NEVER the
 *     app_password_secret (projected out AND defensively stripped)
 *
 * Runs under a service-role client (RLS bypassed); the explicit per-query filter
 * on the caller id is the authoritative tenancy gate. All queries are awaited in
 * parallel — they are independent reads.
 */

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';

const DAY_MS = 86_400_000;
export const DOMAIN_EVENTS_WINDOW_DAYS = 90;
export const TELEMETRY_WINDOW_DAYS = 30;

/** Columns of connected_emails that are safe to export — app_password_secret omitted. */
const CONNECTED_EMAIL_COLS = [
  'id',
  'email_address',
  'provider',
  'owner_user_id',
  'imap_host',
  'imap_port',
  'imap_use_tls',
  'status',
  'last_processed_uid',
  'last_sync_at',
  'last_error',
  'last_error_at',
  'consecutive_errors',
  'created_at',
  'updated_at',
  'deleted_at',
].join(',');

export type Caller = { id: string; email: string };

export type ExportData = {
  profile: Record<string, unknown>;
  households: Record<string, unknown>[];
  members: Record<string, unknown>[];
  connected_emails: Record<string, unknown>[];
  invoices: Record<string, unknown>[];
  consent_log: Record<string, unknown>[];
  domain_events: Record<string, unknown>[];
  client_telemetry: Record<string, unknown>[];
};

export type PdfRef = {
  bucket: string;
  path: string;
  invoiceId: string;
  /** Path of the PDF inside the export zip. */
  entryName: string;
};

type Row = Record<string, unknown>;

function unwrap<T>(res: { data: unknown; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`export ${what} query failed: ${res.error.message}`);
  return (res.data ?? []) as T;
}

/**
 * Gathers every category of the caller's personal data per §9.4. `nowMs` anchors
 * the domain_events (90d) and client_telemetry (30d) windows.
 */
export async function collectExportData(
  caller: Caller,
  client: SupabaseClient,
  nowMs: number,
): Promise<ExportData> {
  const eventsCutoff = new Date(nowMs - DOMAIN_EVENTS_WINDOW_DAYS * DAY_MS).toISOString();
  const telemetryCutoff = new Date(nowMs - TELEMETRY_WINDOW_DAYS * DAY_MS).toISOString();

  const [
    profileRes,
    householdRows,
    members,
    rawEmails,
    invoices,
    consent,
    events,
    telemetry,
  ] = await Promise.all([
    client
      .from('user_profiles')
      .select('user_id,display_name,avatar_url,locale,theme,created_at,updated_at')
      .eq('user_id', caller.id)
      .maybeSingle(),
    client
      .from('members')
      .select('household_id,role,joined_at,created_at,households(id,name,created_at)')
      .eq('user_id', caller.id)
      .is('deleted_at', null)
      .then((r) => unwrap<Row[]>(r, 'households')),
    client
      .from('members')
      .select('*')
      .eq('user_id', caller.id)
      .then((r) => unwrap<Row[]>(r, 'members')),
    client
      .from('connected_emails')
      .select(CONNECTED_EMAIL_COLS)
      .eq('owner_user_id', caller.id)
      .then((r) => unwrap<Row[]>(r, 'connected_emails')),
    client
      .from('invoices')
      .select('*')
      .or(`paid_by.eq.${caller.id},created_by.eq.${caller.id},updated_by.eq.${caller.id}`)
      .then((r) => unwrap<Row[]>(r, 'invoices')),
    client
      .from('consent_log')
      .select('*')
      .eq('user_id', caller.id)
      .then((r) => unwrap<Row[]>(r, 'consent_log')),
    client
      .from('domain_events')
      .select('*')
      .eq('actor_user_id', caller.id)
      .gte('occurred_at', eventsCutoff)
      .then((r) => unwrap<Row[]>(r, 'domain_events')),
    client
      .from('client_telemetry')
      .select('*')
      .eq('user_id', caller.id)
      .gte('occurred_at', telemetryCutoff)
      .then((r) => unwrap<Row[]>(r, 'client_telemetry')),
  ]);

  if (profileRes.error) {
    throw new Error(`export profile query failed: ${profileRes.error.message}`);
  }
  const profileRow = (profileRes.data ?? {}) as Row;
  const profile: Row = { user_id: caller.id, email: caller.email, ...profileRow };

  // Defensive: never leak app_password_secret even if the projection drifts.
  const connected_emails = rawEmails.map((r) => {
    const { app_password_secret: _drop, ...safe } = r as Row & { app_password_secret?: unknown };
    return safe;
  });

  // Flatten the membership→household embed into a clean, member-free shape.
  const households = householdRows.map((r) => {
    const hh = (r.households ?? null) as Row | null;
    return {
      household_id: r.household_id,
      name: hh?.name ?? null,
      role: r.role,
      joined_at: r.joined_at,
      created_at: hh?.created_at ?? null,
    };
  });

  return {
    profile,
    households,
    members,
    connected_emails,
    invoices,
    consent_log: consent,
    domain_events: events,
    client_telemetry: telemetry,
  };
}

/**
 * Returns the storage refs of the caller's invoice PDFs: invoices whose source
 * email is owned by the caller and whose PDF has NOT been archived/evicted.
 * (Spec §9.4: "PDFs cuja invoice veio de connected_emails.owner_user_id = me".)
 */
export async function listOwnedPdfRefs(
  userId: string,
  client: SupabaseClient,
): Promise<PdfRef[]> {
  const emailRes = await client
    .from('connected_emails')
    .select('id')
    .eq('owner_user_id', userId);
  const emailRows = unwrap<Row[]>(emailRes, 'owned emails');
  const emailIds = emailRows.map((r) => r.id as string);
  if (emailIds.length === 0) return [];

  const invRes = await client
    .from('invoices')
    .select('id,storage_bucket,storage_path,pdf_archived_at')
    .in('connected_email_id', emailIds)
    .is('pdf_archived_at', null);
  const invRows = unwrap<Row[]>(invRes, 'owned invoice PDFs');

  return invRows.map((r) => ({
    bucket: (r.storage_bucket as string) ?? 'invoices',
    path: r.storage_path as string,
    invoiceId: r.id as string,
    entryName: `invoice_pdfs/${r.id}.pdf`,
  }));
}
