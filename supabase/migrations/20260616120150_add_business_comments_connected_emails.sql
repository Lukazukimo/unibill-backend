-- ============================================================================
-- Migration: 20260616120100_add_business_comments_connected_emails.sql
-- Date:      2026-06-10
-- Task:      T-207
-- Purpose:   Aplica o texto canônico de COMMENT ON COLUMN do spec Appendix G
--            (subset emails) sobre as colunas business-meaningful das duas
--            tabelas de email criadas em T-206:
--
--              public.connected_emails
--              public.connected_email_households
--
--            A migration anterior (T-206 / 20260616120000) já preencheu
--            comments inline em todas as colunas (defensivo); este passo é a
--            *finalização Appendix G* — sobrescreve com o texto canônico do
--            spec onde ele existe e reforça as semânticas que o plano cobra
--            explicitamente:
--
--              * email_address — regra de normalização (lowercase, trim) e
--                                invariante de UNIQUE global cross-user.
--              * app_password_secret — ponteiro uuid pra vault.secrets;
--                                somente acessível via wrappers SECURITY
--                                DEFINER (§9.3.1 / T-208).
--              * last_processed_uid — semântica de cursor IMAP incremental
--                                (texto verbatim do §G).
--              * consecutive_errors — referência ao threshold de circuit
--                                breaker em app_settings
--                                (sync.consecutive_error_threshold;
--                                texto verbatim do §G).
--              * is_default — invariante de unicidade por email entre
--                                vínculos ativos (idx_default_per_email).
--              * deleted_at  — semântica de soft-delete + re-bind histórico
--                                (uq_email_household_active partial).
--
-- Spec refs: §G  (Estratégia de COMMENTS em colunas — subset connected_emails;
--                 texto canônico para last_processed_uid e consecutive_errors
--                 copiado verbatim. As demais colunas seguem o mesmo padrão
--                 narrativo de §G mas o spec não fixou redação literal.)
--            §5.2 (definição das tabelas + invariantes dos partial unique
--                 indexes).
--            §5.8 (sync.consecutive_error_threshold default 5 → auto-pause
--                 status=error — citado em consecutive_errors).
--            §6.4 (worker IMAP usa last_processed_uid como cursor incremental;
--                 incrementa por mensagem, não por batch).
--            §9.3.1 (Vault: app_password_secret é uuid em vault.secrets;
--                 wrappers app.create_vault_secret / app.decrypt_app_password
--                 em T-208).
--
-- Design notes:
--   * Comments são puro texto e idempotentes — re-executar produz estado
--     idêntico. Comentários atuais (preenchidos por T-206) serão sobrescritos
--     com a redação canônica de §G. As migrations anteriores permanecem
--     intactas: um `db reset` aplica T-206 (inline) e em seguida T-207
--     (canônico), resultando no mesmo estado final.
--   * Inclui também COMMENT ON COLUMN para as colunas que o plano enumera
--     explicitamente (email_address, app_password_secret, is_default,
--     deleted_at) mesmo quando §G não fixou texto literal — a "data
--     dictionary CI check" lê pg_description e quer description não-NULL pra
--     toda coluna business-meaningful.
--   * Sem efeito em RLS, índices, triggers ou planos de query — `pg_description`
--     é metadado puro. Os testes pgTAP de T-115/T-116/T-122/T-123 (P0-P1) e
--     futuros testes de T-211 (connected_emails RLS) continuam passando.
--
-- Rollback:
--   * Para reverter, basta executar `COMMENT ON COLUMN <coluna> IS '';`
--     em cada coluna alterada — Postgres trata empty string como "comment
--     removido". Não fornecemos DOWN script (Supabase CLI não roda DOWN);
--     o estado anterior (T-206 inline) é reproduzível replayando T-206.
-- ============================================================================


-- ============================================================================
-- 1. public.connected_emails
--    (subset business-meaningful — Appendix G + acceptance criteria de T-207)
-- ============================================================================

-- email_address: regra de normalização + invariante UNIQUE global
-- (acceptance criteria T-207). O CHECK constraint em si não existe na tabela
-- (§5.2 não exige normalização forçada via CHECK — a Edge Function POST
-- /emails/connect em T-212 normaliza antes do INSERT); aqui documentamos o
-- contrato pra reviewers e geradores de dicionário.
COMMENT ON COLUMN public.connected_emails.email_address IS
  'Endereço de email completo (ex: fulano@gmail.com). NORMALIZAÇÃO: a Edge '
  'Function POST /emails/connect (T-212) aplica lower(trim(.)) antes do INSERT — '
  'aliases case-variantes (Fulano@GMAIL.COM) colidem com a row existente. '
  'UNIQUE global (constraint UNIQUE sem WHERE): o mesmo endereço NUNCA tem 2 '
  'rows ativas — um segundo user tentando connect recebe 409 Conflict. Para '
  'multi-household basta inserir em connected_email_households (junction). '
  'Spec §5.2.';

-- app_password_secret: Vault uuid pointer (acceptance criteria T-207).
-- Texto reforça que (a) é uuid puro sem FK, (b) único acesso autorizado é via
-- wrappers SECURITY DEFINER em schema app (§9.3.1 / T-208), (c) nunca é
-- retornado em logs ou em respostas de API (§9.3.2 redact middleware).
COMMENT ON COLUMN public.connected_emails.app_password_secret IS
  'Ponteiro uuid pra vault.secrets (Supabase Vault) onde a app password do '
  'Gmail está cifrada at-rest. SEM FK para vault.secrets — o schema do Vault '
  'é gerenciado pela extensão e não é versionado pela app. ACESSO: somente '
  'via os wrappers SECURITY DEFINER em schema app — app.create_vault_secret '
  'para escrita, app.decrypt_app_password para leitura (§9.3.1 / T-208). '
  'authenticated e anon recebem REVOKE em vault.* (T-209). Lifecycle: criado '
  'em POST /emails/connect (T-212); rotacionado in-place (mesmo uuid, novo '
  'plaintext); destruído por app.anonymize_user (T-228) antes do DELETE em '
  'auth.users. NUNCA aparece em logs (redact middleware §9.3.2) nem em '
  'respostas de API.';

-- last_processed_uid: canonical Appendix G text (verbatim do spec §G linha 3444).
COMMENT ON COLUMN public.connected_emails.last_processed_uid IS
  'Cursor IMAP — maior UID já processado nesta caixa. Incrementado dentro do '
  'loop por mensagem (não após batch completo) pra resiliência a crashes.';

-- consecutive_errors: canonical Appendix G text (verbatim do spec §G linha 3446).
COMMENT ON COLUMN public.connected_emails.consecutive_errors IS
  'Erros consecutivos no sync. Atinge sync.consecutive_error_threshold '
  '(default 5) → auto-pause (status=error).';

-- deleted_at: soft-delete semantics (acceptance criteria T-207).
COMMENT ON COLUMN public.connected_emails.deleted_at IS
  'Soft-delete marker. NULL = credencial ativa; NOT NULL = removida. RLS '
  '(T-211) oculta rows soft-deletadas em queries normais; o worker IMAP as '
  'ignora (idx_connected_emails_worker_eligible é parcial WHERE deleted_at '
  'IS NULL). Hard-delete da row + destruição do Vault secret só acontece via '
  'app.anonymize_user (T-228, fluxo LGPD §9.4). Combina com status=''revoked'' '
  'pra distinguir "user desconectou" de "tombstone temporário".';


-- ============================================================================
-- 2. public.connected_email_households
--    (subset business-meaningful — Appendix G + acceptance criteria de T-207)
-- ============================================================================

-- is_default: uniqueness invariant (acceptance criteria T-207).
-- O índice idx_default_per_email (T-206) impõe NO MÁXIMO 1 default ativo por
-- email; zero é permitido (o app resolve com fallback no primeiro household).
COMMENT ON COLUMN public.connected_email_households.is_default IS
  'Sinaliza qual household recebe faturas ambíguas vindas deste email — só é '
  'consultado quando o classificador não consegue inferir destino do conteúdo. '
  'INVARIANTE: NO MÁXIMO 1 row com is_default=true por connected_email_id '
  'entre vínculos ativos (deleted_at IS NULL) — enforced pelo partial unique '
  'idx_default_per_email. Zero defaults é permitido: o app cai no primeiro '
  'household ativo associado ao email (ordem indeterminada, mas consistente '
  'por execução). Spec §5.2.';

-- deleted_at: soft-delete + re-bind invariant (acceptance criteria T-207).
COMMENT ON COLUMN public.connected_email_households.deleted_at IS
  'Soft-delete marker do vínculo email↔household. NULL = vínculo ativo. '
  'INVARIANTE de re-bind: o índice uq_email_household_active é PARTIAL '
  'WHERE deleted_at IS NULL, então o usuário pode remover um vínculo e '
  're-adicioná-lo depois sem violar UNIQUE — o par histórico permanece em '
  'queries de auditoria. RLS (T-211) oculta vínculos soft-deletados; o worker '
  'também os ignora (idx_connected_email_households_household é parcial). '
  'Hard-delete só via app.anonymize_user (§9.4). Spec §5.2.';


-- ============================================================================
-- 3. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260616120100_add_business_comments_connected_emails',
  'Aplica o texto canônico de COMMENT ON COLUMN do spec Appendix G (subset '
  'emails) em public.connected_emails (email_address, app_password_secret, '
  'last_processed_uid, consecutive_errors, deleted_at) e em '
  'public.connected_email_households (is_default, deleted_at). Texto '
  'verbatim de §G para last_processed_uid e consecutive_errors; demais '
  'colunas seguem o padrão narrativo §G + acceptance criteria T-207. '
  'Reversível via COMMENT ... IS '''' ou replay de T-206.'
)
ON CONFLICT (migration_name) DO NOTHING;
