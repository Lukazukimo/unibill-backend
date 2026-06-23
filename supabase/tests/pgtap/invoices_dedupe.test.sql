-- ============================================================================
-- Test:      supabase/tests/pgtap/invoices_dedupe.test.sql
-- Date:      2026-06-14
-- Task:      T-301 (dedupe contract for the §5.3 invoices schema)
-- Purpose:   pgTAP assertions for the CONSTRAINT-level dedupe guarantees of
--            `public.invoices` (NOT the RLS layer — that lives in
--            tests/rls/invoices.test.sql). Exercises the two soft-delete-aware
--            partial unique indexes and the file_hash format CHECK:
--
--              1. uq_invoices_household_filehash_active
--                   UNIQUE (household_id, file_hash) WHERE deleted_at IS NULL
--                 → the same PDF (identical sha256) cannot be ingested twice
--                   into the same household while the first row is active, but
--                   CAN be re-ingested after the first is soft-deleted (so a
--                   user who deletes a fatura and later re-receives it does not
--                   hit a permanent duplicate-key wall — spec §5.3 note).
--
--              2. idx_invoices_email_messageid  (NON-unique lookup index)
--                   (connected_email_id, source_message_id)
--                   WHERE deleted_at IS NULL AND source_message_id IS NOT NULL
--                 → T-326 (migration 20260621120400) DEMOTED this from a UNIQUE
--                   index to a plain lookup index: one IMAP message can bundle
--                   several distinct PDFs, each a legitimate separate invoice
--                   sharing the same source_message_id. Message-ID is therefore
--                   NO LONGER a dedupe key; the only active-duplicate guarantee
--                   is (household_id, file_hash) above. NULL source_message_id
--                   rows are excluded from the index and never collide.
--
--              3. chk_file_hash_format  CHECK (file_hash ~ '^[a-f0-9]{64}$')
--                 → rejects uppercase hex, non-hex characters, and wrong length.
--
-- Spec refs: §5.3 (invoices DDL — partial unique indexes + chk_file_hash_format;
--                   the "UNIQUE constraints inline incluem rows soft-deletadas"
--                   rationale for using partial indexes instead of table
--                   constraints).
--
-- Hermeticity:
--   * Whole file wrapped in BEGIN / ROLLBACK.
--   * Runs as the migration owner (postgres) — RLS is owner-bypassed, which is
--     correct here: we are testing CONSTRAINTS, not policies. No JWT fixture is
--     loaded. The RLS policies are covered separately in tests/rls/invoices.test.sql.
--   * Each scenario uses DISTINCT file_hash values so the household+file_hash
--     index never cross-contaminates between scenarios within the single
--     transaction. message_id scenarios deliberately vary file_hash so a
--     (connected_email_id, source_message_id) violation cannot be masked by a
--     (household_id, file_hash) violation firing first.
--
-- Notes on pgTAP error matching:
--   * Unique-violation  → SQLSTATE '23505' (matched via throws_ok).
--   * Check-violation   → SQLSTATE '23514' (matched via throws_ok).
--   * Successful inserts → lives_ok.
-- ============================================================================


BEGIN;

SET LOCAL search_path = public, extensions, app;

SELECT plan(8);


-- ============================================================================
-- Setup: one auth user, one household, one connected_email credential.
-- ============================================================================
-- The household FK and connected_email FK must be satisfiable. We insert as the
-- table owner so RLS does not interfere (we are not testing RLS here).
INSERT INTO auth.users (id, instance_id, email, aud, role, raw_user_meta_data)
VALUES
  ('a0000001-1111-1111-1111-111111111111',
   '00000000-0000-0000-0000-000000000000',
   'dedupe-owner@test.local', 'authenticated', 'authenticated',
   '{"display_name":"Dedupe Owner"}'::jsonb);

INSERT INTO public.households (id, name, created_by)
VALUES
  ('40000001-1111-1111-1111-111111111111', 'Dedupe Household',
   'a0000001-1111-1111-1111-111111111111');

INSERT INTO public.connected_emails (
  id, email_address, provider, owner_user_id, app_password_secret
) VALUES
  ('ce000001-1111-1111-1111-111111111111',
   'dedupe@example.com', 'gmail',
   'a0000001-1111-1111-1111-111111111111',
   '00000000-0000-0000-0000-0000000000d1');


-- ============================================================================
-- SCENARIO 1 — (household_id, file_hash) active duplicate is rejected (23505)
-- ============================================================================
-- Seed the first active row, then assert a second active row with the SAME
-- (household_id, file_hash) raises a unique violation.
INSERT INTO public.invoices (household_id, storage_path, file_hash)
VALUES
  ('40000001-1111-1111-1111-111111111111',
   'household-40000001/2026-06/a.pdf',
   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

SELECT throws_ok(
  $$INSERT INTO public.invoices (household_id, storage_path, file_hash)
    VALUES (
      '40000001-1111-1111-1111-111111111111',
      'household-40000001/2026-06/a-dup.pdf',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )$$,
  '23505',
  NULL,
  '#1 dedupe: second ACTIVE invoice with same (household_id, file_hash) is rejected (23505)'
);


-- ============================================================================
-- SCENARIO 2 — re-ingest after soft-delete succeeds (partial index excludes it)
-- ============================================================================
-- A distinct file_hash 'b...'. Insert, soft-delete, then re-insert the SAME
-- (household_id, file_hash): the soft-deleted row is excluded from the partial
-- unique index, so the re-insert must succeed.
INSERT INTO public.invoices (household_id, storage_path, file_hash)
VALUES
  ('40000001-1111-1111-1111-111111111111',
   'household-40000001/2026-06/b.pdf',
   'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

UPDATE public.invoices
   SET deleted_at = now()
 WHERE household_id = '40000001-1111-1111-1111-111111111111'
   AND file_hash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

SELECT lives_ok(
  $$INSERT INTO public.invoices (household_id, storage_path, file_hash)
    VALUES (
      '40000001-1111-1111-1111-111111111111',
      'household-40000001/2026-06/b-again.pdf',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    )$$,
  '#2 dedupe: re-ingesting the same (household_id, file_hash) after soft-delete SUCCEEDS'
);


-- ============================================================================
-- SCENARIO 3 — multi-PDF email: same (connected_email_id, source_message_id),
--              DIFFERENT file_hash → BOTH stay active (T-326)
-- ============================================================================
-- T-326 (migration 20260621120400) demoted the message-id index to a non-unique
-- lookup (idx_invoices_email_messageid): one email can bundle several distinct
-- PDFs, each a separate invoice sharing the same source_message_id. So a second
-- active row with the same (connected_email_id, source_message_id) but a
-- DIFFERENT file_hash must SUCCEED — dedupe is content-based only
-- (uq_invoices_household_filehash_active). Re-adding the old message-id UNIQUE
-- would silently drop the 2nd PDF (app.ingest_invoice uses ON CONFLICT DO
-- NOTHING) — exactly the data-loss bug T-326 fixed.
INSERT INTO public.invoices (
  household_id, connected_email_id, source_message_id, storage_path, file_hash
) VALUES (
  '40000001-1111-1111-1111-111111111111',
  'ce000001-1111-1111-1111-111111111111',
  '<msg-1@example.com>',
  'household-40000001/2026-06/c.pdf',
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
);

SELECT lives_ok(
  $$INSERT INTO public.invoices (
      household_id, connected_email_id, source_message_id, storage_path, file_hash
    ) VALUES (
      '40000001-1111-1111-1111-111111111111',
      'ce000001-1111-1111-1111-111111111111',
      '<msg-1@example.com>',
      'household-40000001/2026-06/d.pdf',
      'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
    )$$,
  '#3 multi-PDF email: a 2nd ACTIVE invoice with the SAME (connected_email_id, source_message_id) but a DIFFERENT file_hash SUCCEEDS — message-id is no longer a unique dedupe key (T-326)'
);


-- ============================================================================
-- SCENARIO 4 — same message_id, fresh file_hash after soft-delete succeeds
-- ============================================================================
-- Soft-delete the 'c...' row from scenario 3, then insert the SAME message_id
-- with a fresh file_hash ('e...'). With T-326 there is no message-id uniqueness,
-- so this is governed purely by the content dedupe (household_id, file_hash):
-- a distinct file_hash always succeeds, soft-deleted or not.
UPDATE public.invoices
   SET deleted_at = now()
 WHERE connected_email_id = 'ce000001-1111-1111-1111-111111111111'
   AND source_message_id = '<msg-1@example.com>'
   AND file_hash = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

SELECT lives_ok(
  $$INSERT INTO public.invoices (
      household_id, connected_email_id, source_message_id, storage_path, file_hash
    ) VALUES (
      '40000001-1111-1111-1111-111111111111',
      'ce000001-1111-1111-1111-111111111111',
      '<msg-1@example.com>',
      'household-40000001/2026-06/e.pdf',
      'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    )$$,
  '#4 dedupe: re-ingesting the same (connected_email_id, source_message_id) after soft-delete SUCCEEDS'
);


-- ============================================================================
-- SCENARIO 5 — multiple NULL source_message_id rows do NOT collide
-- ============================================================================
-- Two active rows, same connected_email_id, BOTH source_message_id IS NULL,
-- DIFFERENT file_hashes ('f...' / '1...'). The message_id partial index has
-- `WHERE source_message_id IS NOT NULL`, so NULLs are excluded and never
-- conflict. (Manual uploads / Message-ID-less mail rely on this.)
INSERT INTO public.invoices (
  household_id, connected_email_id, source_message_id, storage_path, file_hash
) VALUES (
  '40000001-1111-1111-1111-111111111111',
  'ce000001-1111-1111-1111-111111111111',
  NULL,
  'household-40000001/2026-06/f.pdf',
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
);

SELECT lives_ok(
  $$INSERT INTO public.invoices (
      household_id, connected_email_id, source_message_id, storage_path, file_hash
    ) VALUES (
      '40000001-1111-1111-1111-111111111111',
      'ce000001-1111-1111-1111-111111111111',
      NULL,
      'household-40000001/2026-06/g.pdf',
      '1111111111111111111111111111111111111111111111111111111111111111'
    )$$,
  '#5 dedupe: two rows with source_message_id IS NULL (same credential) do NOT violate uniqueness'
);


-- ============================================================================
-- SCENARIO 6 — file_hash CHECK rejects UPPERCASE hex (23514)
-- ============================================================================
-- chk_file_hash_format is '^[a-f0-9]{64}$' — uppercase A-F is NOT allowed (the
-- worker lower-cases the sha256 hex before insert). 64 uppercase 'A's.
SELECT throws_ok(
  $$INSERT INTO public.invoices (household_id, storage_path, file_hash)
    VALUES (
      '40000001-1111-1111-1111-111111111111',
      'household-40000001/2026-06/upper.pdf',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    )$$,
  '23514',
  NULL,
  '#6 file_hash CHECK: UPPERCASE hex rejected (23514)'
);


-- ============================================================================
-- SCENARIO 7 — file_hash CHECK rejects non-hex characters (23514)
-- ============================================================================
-- Contains 'z' (and 'g'..) which are outside [a-f0-9]; length is 64.
SELECT throws_ok(
  $$INSERT INTO public.invoices (household_id, storage_path, file_hash)
    VALUES (
      '40000001-1111-1111-1111-111111111111',
      'household-40000001/2026-06/nonhex.pdf',
      'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'
    )$$,
  '23514',
  NULL,
  '#7 file_hash CHECK: non-hex characters rejected (23514)'
);


-- ============================================================================
-- SCENARIO 8 — file_hash CHECK rejects wrong length (23514)
-- ============================================================================
-- Valid hex characters but only 3 of them — not 64.
SELECT throws_ok(
  $$INSERT INTO public.invoices (household_id, storage_path, file_hash)
    VALUES (
      '40000001-1111-1111-1111-111111111111',
      'household-40000001/2026-06/short.pdf',
      'abc'
    )$$,
  '23514',
  NULL,
  '#8 file_hash CHECK: wrong length (not 64 chars) rejected (23514)'
);


-- ============================================================================
-- Finalize
-- ============================================================================
SELECT * FROM finish();

ROLLBACK;
