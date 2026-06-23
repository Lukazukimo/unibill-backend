-- ============================================================================
-- Migration: 20260622120300_invitations_code_exclude_l.sql
-- Date:      2026-06-22
-- Task:      T-227 (corrective — fixes the base32 invitation-code CHECK shipped
--            by 20260616123000_invitations_hardening.sql; tracked in #213)
-- Purpose:   Fix the base32 CHECK on public.household_invitations.code so it
--            actually EXCLUDES the letter L. The previous hardening migration
--            (20260616123000) used regex ^[A-HJ-NP-Z2-9]{8}$ whose range
--            J-N inadvertently RE-INCLUDED L (J,K,L,M,N), contradicting its
--            own documented intent and spec §9.1 (alphabet excludes I,L,O,0,1).
--            Split the range to J-K + M-N so L is rejected while J,K,M,N stay
--            valid. Resulting alphabet: 23456789ABCDEFGHJKMNPQRSTUVWXYZ.
--
--            Surfaced by tests/pgtap/invitations.test.sql #3, which asserts a
--            code containing L violates the CHECK (23514) — an assertion the
--            buggy J-N range could never satisfy.
--
-- Spec refs: §9.1 (Invitation security — base32, no confusable chars I/L/O/0/1).
--
-- Design notes:
--   * Pre-flight DO block aborts LOUDLY if any existing row carries a code that
--     would violate the corrected CHECK (i.e. an L-code slipped in under the
--     buggy constraint), so the migration never silently fails to add the
--     tightened constraint. (None exist today — the generator already avoids L
--     in practice; this guards against operator-inserted rows.)
--   * Pure tightening: the corrected alphabet is a STRICT SUBSET of the old one,
--     so no previously-rejected code becomes valid. No data migration needed.
--
-- Rollback:
--   ALTER TABLE public.household_invitations
--     DROP CONSTRAINT IF EXISTS household_invitations_code_format_chk;
--   ALTER TABLE public.household_invitations
--     ADD CONSTRAINT household_invitations_code_format_chk
--     CHECK (code ~ '^[A-HJ-NP-Z2-9]{8}$');   -- reintroduces the L bug
-- ============================================================================

-- Pre-flight: abort if any existing row would violate the corrected CHECK
-- (i.e. an active code containing L slipped in under the buggy constraint).
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.household_invitations
   WHERE code !~ '^[A-HJKM-NP-Z2-9]{8}$';
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'Migration 20260622120300 aborted: % row(s) in household_invitations have '
      'a code that does not match the corrected base32 alphabet '
      '^[A-HJKM-NP-Z2-9]{8}$ (excludes I, L, O, 0, 1). Clean these rows '
      'manually before re-running: SELECT id, code FROM '
      'public.household_invitations WHERE code !~ ''^[A-HJKM-NP-Z2-9]{8}$'';',
      v_count;
  END IF;
END
$$;

ALTER TABLE public.household_invitations
  DROP CONSTRAINT IF EXISTS household_invitations_code_format_chk;

ALTER TABLE public.household_invitations
  ADD CONSTRAINT household_invitations_code_format_chk
  CHECK (code ~ '^[A-HJKM-NP-Z2-9]{8}$');

COMMENT ON CONSTRAINT household_invitations_code_format_chk
  ON public.household_invitations IS
  'Base32 alphabet sem confundiveis (sem I, L, O, 0, 1) — 31 chars. '
  'Range J-K + M-N exclui L explicitamente (correcao de 20260616123000 que '
  'usava J-N e re-incluia L por engano). Spec §9.1.';

INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260622120300_invitations_code_exclude_l',
  'Fix household_invitations.code CHECK: regex ^[A-HJKM-NP-Z2-9]{8}$ exclui L '
  '(20260616123000 usava J-N que re-incluia L). Spec §9.1.'
)
ON CONFLICT (migration_name) DO NOTHING;
