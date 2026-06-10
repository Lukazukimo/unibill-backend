-- ============================================================================
-- Migration: 20260615121100_add_business_comments_p0.sql
-- Date:      2026-06-10
-- Task:      T-121
-- Purpose:   Apply the canonical business-meaningful COMMENT ON COLUMN /
--            COMMENT ON FUNCTION text from spec Appendix G to all P0-P1 tables
--            (households, members, household_invitations, user_profiles,
--            app_settings, app_settings_history, consent_log, system_actors)
--            and their trigger/helper functions. Earlier migrations already
--            attached column comments inline; this final P0-P1 migration is
--            the single, idempotent reference point for the *business*
--            semantics required by Appendix G, ensuring every reviewer sees
--            the canonical wording when they run `\d+ <table>` or query
--            `pg_description`. Re-applying overwrites prior text — that is
--            intentional and the prior migrations are unchanged so a fresh
--            `db reset` still produces the same final state regardless of
--            which migration last touched a given comment.
-- Spec refs: §G  (Estratégia de COMMENTS em colunas — canonical column-level
--                 business text. P0-P1 subset only; invoices /
--                 connected_emails / utility_parsers comments are scoped to
--                 agent 2's tasks per the implementation plan.)
--            §5.1, §5.5, §5.9, §5.10, §5.12 — semantics referenced in the
--            comments themselves (enum kinds, scope cascade, legal basis
--            enumeration, sentinel actor kinds, audit-column FK shape).
--
-- Design notes:
--   * Comments are written as standalone statements so they can be reviewed,
--     diffed, and regenerated independently from the table DDL. The earlier
--     migrations (T-106..T-117) already produced sensible inline comments;
--     this migration is the *Appendix G* finalization step — same column,
--     final canonical wording.
--   * Includes COMMENT ON FUNCTION for the four trigger functions touching
--     P0-P1 tables (set_updated_at, enforce_min_one_admin, create_user_profile,
--     audit_app_settings). Acceptance criterion calls these out explicitly.
--   * Comments are pure text and have no schema-level effects — replaying
--     this migration produces identical output. Reversibility: setting the
--     text to '' (empty string) clears a comment. See commit message for the
--     manual rollback sequence; we do not provide a separate DOWN script in
--     the MVP (Supabase CLI projects do not run DOWN migrations).
--   * No regression risk: comments do not affect query plans, RLS, indexes
--     or triggers. The pgTAP suites from T-115/T-116/T-122/T-123 keep
--     passing.
-- ============================================================================


-- ============================================================================
-- 1. public.system_actors (spec §5.10)
-- ============================================================================
COMMENT ON COLUMN public.system_actors.id IS
  'UUID determinístico (00000000-0000-0000-0000-00000000000{1,2,3}). NÃO usar '
  'gen_random_uuid — os ids são referenciados literalmente em '
  'app.anonymize_user_references (§9.4) e em código de aplicação que resolve '
  'rótulos via app.user_display_name(uuid).';

COMMENT ON COLUMN public.system_actors.kind IS
  'Categoria do actor (enum textual fechado): '
  'deleted_user (usuário anonimizado por LGPD §9.4); '
  'system_worker (jobs pg_cron / Edge Functions que escrevem audit columns sem '
  'JWT de user); '
  'system_admin_bootstrap (admin inicial criado antes do primeiro promote '
  'via claim is_system_admin — ver §9.2 e scripts/bootstrap_sys_admin.sh).';

COMMENT ON COLUMN public.system_actors.display_name IS
  'Rótulo humano exibido na UI quando o actor é resolvido via '
  'app.user_display_name(uuid). pt-BR por default (ex: "Usuário removido", '
  '"Sistema", "Admin (bootstrap)").';

COMMENT ON COLUMN public.system_actors.created_at IS
  'Timestamp de criação da row. Imutável; re-runs idempotentes preservam '
  'o valor original via ON CONFLICT (id) DO NOTHING.';


-- ============================================================================
-- 2. public.households (spec §5.1, §5.10)
-- ============================================================================
COMMENT ON COLUMN public.households.id IS
  'PK gerado por extensions.gen_random_uuid(). Referenciado por members, '
  'invoices, connected_email_households, app_settings (scope=household), etc.';

COMMENT ON COLUMN public.households.name IS
  'Nome amigável escolhido pelo criador (ex: "Casa do Centro", "República 42"). '
  'text livre; UI sanitiza/trunca; sem unicidade global (cada user pode ter '
  'seu próprio "Casa").';

COMMENT ON COLUMN public.households.created_at IS
  'Timestamp de criação (imutável).';

COMMENT ON COLUMN public.households.updated_at IS
  'Atualizado automaticamente pelo trigger trg_households_set_updated_at '
  '(BEFORE UPDATE, executa app.set_updated_at).';

COMMENT ON COLUMN public.households.created_by IS
  'UUID do criador. SEM FK constraint — pode referenciar auth.users(id) '
  'durante uso normal OU public.system_actors(id) após anonymize (§5.10 '
  'Approach A). Display via app.user_display_name(uuid).';

COMMENT ON COLUMN public.households.deleted_at IS
  'Soft-delete marker. NULL = household ativo; NOT NULL = removido. RLS '
  '(T-114) oculta rows soft-deletadas em queries normais; hard-delete só '
  'acontece via fluxo LGPD §9.4.';


-- ============================================================================
-- 3. public.members (spec §5.1)
-- ============================================================================
COMMENT ON COLUMN public.members.id IS
  'PK gerado por extensions.gen_random_uuid().';

COMMENT ON COLUMN public.members.household_id IS
  'FK pra public.households(id). Ownership real — mantém FK (§5.10 callout: '
  'colunas de ownership preservam FK; audit columns como invited_by não têm).';

COMMENT ON COLUMN public.members.user_id IS
  'FK pra auth.users(id). Ownership real — mantém FK (§5.10). Sem ON DELETE '
  'CASCADE: o fluxo LGPD §9.4 anonimiza referências ANTES do DELETE em '
  'auth.users.';

COMMENT ON COLUMN public.members.role IS
  'Papel deste membro no household (public.member_role enum, valores '
  '"admin" | "member"). '
  'admin: gerencia membros (invite/remove/promote), edita settings escopados '
  'a household, vê faturas de todos os membros. '
  'member: vê apenas próprias faturas + categorias compartilhadas. '
  'Default member; primeiro membro do household é promovido a admin pela '
  'Edge Function de criação. Trigger enforce_min_one_admin impede demoção/'
  'remoção do último admin.';

COMMENT ON COLUMN public.members.invited_by IS
  'UUID de quem convidou — uuid puro SEM FK (§5.10 Approach A; sobrevive '
  'a anonymize do convidador). NULL para o criador do household e para joins '
  'feitas por system_worker (bootstrap, ferramentas administrativas).';

COMMENT ON COLUMN public.members.joined_at IS
  'Quando o usuário entrou no household (aceitou convite ou foi adicionado '
  'pelo criador). Distinto de created_at: reservado para futuros fluxos onde '
  'a row é criada antes do aceite (não aplicável no MVP).';

COMMENT ON COLUMN public.members.created_at IS
  'Timestamp de criação da row (imutável).';

COMMENT ON COLUMN public.members.updated_at IS
  'Atualizado automaticamente pelo trigger trg_members_set_updated_at '
  '(BEFORE UPDATE, executa app.set_updated_at).';

COMMENT ON COLUMN public.members.deleted_at IS
  'Soft-delete marker. NULL = membro ativo; NOT NULL = removido. Partial '
  'unique index uq_members_household_user_active ignora rows com deleted_at '
  'NOT NULL, permitindo re-add do mesmo usuário sem perder a história.';


-- ============================================================================
-- 4. public.household_invitations (spec §5.1, §5.12)
-- ============================================================================
COMMENT ON COLUMN public.household_invitations.id IS
  'PK gerado por extensions.gen_random_uuid().';

COMMENT ON COLUMN public.household_invitations.household_id IS
  'FK pra public.households(id). Convite é sempre atrelado a um household '
  'específico.';

COMMENT ON COLUMN public.household_invitations.code IS
  'Código de 8 chars maiúsculos alfanuméricos (CHECK ^[A-Z0-9]{8}$, UNIQUE). '
  'Gerado pela Edge Function POST /invitations com retry em colisão '
  '(probabilidade ~5e-13 num espaço de 36^8). Base32-like sem chars '
  'ambíguos é responsabilidade do gerador no app.';

COMMENT ON COLUMN public.household_invitations.role IS
  'Role com que o invitee entrará no household ao resgatar (public.member_role: '
  '"admin" | "member"). Default "member"; admin só pode ser concedido por '
  'outro admin (validado em /invitations e RLS T-114).';

COMMENT ON COLUMN public.household_invitations.invited_email IS
  'Opcional. NULL = convite aberto (qualquer user autenticado pode resgatar '
  'com o código). NOT NULL = convite travado a este email — Edge Function '
  'POST /invitations/redeem valida lower(auth.email()) == lower(invited_email) '
  'antes de criar o member row (§5.12).';

COMMENT ON COLUMN public.household_invitations.created_by IS
  'UUID do admin que criou o convite. SEM FK (§5.10 Approach A).';

COMMENT ON COLUMN public.household_invitations.created_at IS
  'Timestamp de criação (imutável).';

COMMENT ON COLUMN public.household_invitations.expires_at IS
  'TTL do convite (default now() + 7 dias). Após esse instante o redeem '
  'falha com 410 Gone; pg_cron pode limpar rows expiradas no longo prazo '
  '(reservado pós-MVP).';

COMMENT ON COLUMN public.household_invitations.used_at IS
  'Timestamp do consumo. NULL = ainda ativo. Setado atomicamente com used_by '
  'pela Edge Function de redeem dentro da mesma transação que cria a row '
  'em public.members.';

COMMENT ON COLUMN public.household_invitations.used_by IS
  'UUID do user que resgatou. SEM FK (§5.10 Approach A; sobrevive ao '
  'anonymize do invitee).';


-- ============================================================================
-- 5. public.user_profiles (spec §5.12)
-- ============================================================================
COMMENT ON COLUMN public.user_profiles.user_id IS
  'PK + FK pra auth.users(id) ON DELETE CASCADE. Única tabela do schema com '
  'FK + CASCADE pra auth.users (§5.10): o perfil é display-mirror do user e '
  'deve sumir junto com ele. Todas as demais user-referencing columns omitem '
  'FK para suportar Approach A (anonymize antes do delete).';

COMMENT ON COLUMN public.user_profiles.display_name IS
  'Nome amigável (NOT NULL). Preenchido no signup pelo trigger '
  'public.create_user_profile() com coalesce(raw_user_meta_data->>'
  'display_name, split_part(email, ''@'', 1)). User pode editar via PATCH '
  '/profile.';

COMMENT ON COLUMN public.user_profiles.avatar_url IS
  'URL externa do avatar (opcional). MVP não hospeda upload — só aceita URL '
  'pública (https) provida pelo user; Storage de avatars é roadmap pós-MVP.';

COMMENT ON COLUMN public.user_profiles.locale IS
  'BCP-47 locale code restrito a "pt-BR" | "en-US" via CHECK. Default '
  '"pt-BR" (mercado primário). Adicionar novos valores requer ALTER TABLE '
  '... DROP/ADD CHECK em nova migration; sem migration de enum porque CHECKs '
  'são mais leves de evoluir.';

COMMENT ON COLUMN public.user_profiles.theme IS
  'Preferência de tema da UI: "system" | "light" | "dark". Default "system" '
  '(segue OS). Aplicada client-side; sem efeito server-side.';

COMMENT ON COLUMN public.user_profiles.created_at IS
  'Timestamp de criação (imutável). Setado pelo trigger no signup.';

COMMENT ON COLUMN public.user_profiles.updated_at IS
  'Atualizado automaticamente pelo trigger trg_user_profiles_set_updated_at '
  '(BEFORE UPDATE, executa app.set_updated_at).';


-- ============================================================================
-- 6. public.app_settings (spec §5.5, §G)
-- ============================================================================
COMMENT ON COLUMN public.app_settings.id IS
  'Surrogate PK (uuid). Sem significado de negócio — existe apenas para '
  'contornar a restrição "no NULLs in PRIMARY KEY" do Postgres (spec §5.11 '
  'tech-3). Uniqueness lógica é mantida pelos partial unique indexes '
  'idx_settings_global_unique e idx_settings_scoped_unique.';

COMMENT ON COLUMN public.app_settings.key IS
  'Chave canônica da config no formato dot-notation '
  '(ex: "features.email_sync", "sync.poll_interval_min", '
  '"extraction.layer.l3.confidence_min"). Catálogo completo no spec §B; seed '
  'em T-118.';

-- Appendix G — texto canônico
COMMENT ON COLUMN public.app_settings.scope IS
  'global = uma row por key (scope_id=NULL); household = uma row por (key, '
  'scope_id=household_id); user = uma row por (key, scope_id=user_id). '
  'Resolução: user > household > global > default no código.';

COMMENT ON COLUMN public.app_settings.scope_id IS
  'NULL quando scope=global; uuid do household quando scope=household; uuid '
  'do user quando scope=user. CHECK chk_scope_id enforça essa invariante.';

COMMENT ON COLUMN public.app_settings.value IS
  'Valor JSONB. Convenção do seed §B: empacotar como {"v": <typed>} para '
  'consumo sem cast pelo helper getConfig (value->''v''). NOT NULL na coluna; '
  'para sinalizar "unset" use literal jsonb null dentro do envelope.';

COMMENT ON COLUMN public.app_settings.category IS
  'Categoria da config para agrupamento no admin UI (features, sync, '
  'extraction, ai, capacity, retention, security, notifications, legal — '
  'enumeração textual aberta, documentada em §B).';

COMMENT ON COLUMN public.app_settings.description IS
  'Descrição humana da config — copiada literalmente do spec §B no seed T-118. '
  'Exibida no admin UI e na tela "Configurações > sobre esta opção".';

-- Appendix G — texto canônico
COMMENT ON COLUMN public.app_settings.requires_restart IS
  'Se TRUE, mudança exige invalidação manual do cache de 30s. Sinaliza pra '
  'UI mostrar warning.';

COMMENT ON COLUMN public.app_settings.updated_at IS
  'Timestamp da última modificação (default now()). Atualizado pelo trigger '
  'trg_app_settings_set_updated_at em UPDATEs.';

COMMENT ON COLUMN public.app_settings.updated_by IS
  'uuid do último user a modificar (FK -> auth.users.id, NO ACTION). '
  'Trigger app.audit_app_settings copia o snapshot pra '
  'app_settings_history.changed_by a cada INSERT/UPDATE.';


-- ============================================================================
-- 7. public.app_settings_history (spec §5.5)
-- ============================================================================
COMMENT ON COLUMN public.app_settings_history.id IS
  'PK bigserial. Log append-only; ordem de inserção define ordem temporal '
  'estrita (changed_at pode ter ties em INSERTs simultâneos do mesmo trigger).';

COMMENT ON COLUMN public.app_settings_history.key IS
  'Snapshot da key no momento da mudança. NÃO é FK pra public.app_settings '
  '(a history sobrevive a um DELETE eventual da row original — auditoria LGPD).';

COMMENT ON COLUMN public.app_settings_history.scope IS
  'Snapshot do scope (public.setting_scope: global|household|user) no '
  'momento da mudança.';

COMMENT ON COLUMN public.app_settings_history.scope_id IS
  'Snapshot do scope_id no momento da mudança (NULL para scope=global).';

COMMENT ON COLUMN public.app_settings_history.old_value IS
  'Valor JSONB anterior. NULL no caso de INSERT (criação inicial — não havia '
  '"anterior").';

COMMENT ON COLUMN public.app_settings_history.new_value IS
  'Valor JSONB novo (após a mudança). NOT NULL.';

COMMENT ON COLUMN public.app_settings_history.changed_at IS
  'Timestamp da mudança (default now()). Combinar com id pra ordem '
  'determinística.';

COMMENT ON COLUMN public.app_settings_history.changed_by IS
  'uuid do user que disparou a mudança (FK -> auth.users.id). Pode ser NULL '
  'quando a mudança vem de service_role / pg_cron sem session JWT '
  '(trigger faz coalesce NEW.updated_by -> auth.uid() -> NULL).';


-- ============================================================================
-- 8. public.consent_log (spec §5.9)
-- ============================================================================
COMMENT ON COLUMN public.consent_log.id IS
  'PK gerado por extensions.gen_random_uuid().';

COMMENT ON COLUMN public.consent_log.user_id IS
  'Owner do consent. FK pra auth.users(id) PRESERVADA (§5.10 — user_id é '
  'ownership, não audit pointer). SEM ON DELETE CASCADE: §9.4 '
  'anonymize_user_references UPDATE-a pra sentinel system_actors ANTES do '
  'DELETE em auth.users, preservando evidência LGPD por '
  'retention.consent_log.max_age_days (default 1825 dias = 5 anos).';

COMMENT ON COLUMN public.consent_log.purpose IS
  'Finalidade canônica (public.consent_purpose enum, 4 valores): '
  'terms (Termos de uso — obrigatório); '
  'privacy (Política de privacidade — obrigatório); '
  'telemetry (coleta de telemetria de erros — opt-in, gate ativo em §5.9); '
  'marketing (newsletters/comunicações — opt-in, reservado pós-MVP).';

COMMENT ON COLUMN public.consent_log.version IS
  'Versão do documento aceito (string livre, convenção '
  '"<tipo>-v<major>.<minor>-YYYY-MM" como "terms-v1.2-2026-06"). Trigger de '
  're-consent em §5.9 compara com app_settings.key=''legal.terms_version'' '
  'no login e força nova aceitação se divergir.';

COMMENT ON COLUMN public.consent_log.legal_basis IS
  'Base legal LGPD do tratamento associado a essa finalidade. Valores '
  'canônicos textuais (não enum por flexibilidade): '
  '"consent" (LGPD art. 7 inciso I — base padrão para purposes opt-in); '
  '"legitimate_interest" (art. 7 IX — uso em telemetria mínima sem opt-in '
  'estrito); '
  '"legal_obligation" (art. 7 II — quando uma lei força o tratamento); '
  '"contract" (art. 7 V — execução de contrato com o titular). '
  'Documentado também em docs/legal/lgpd.md.';

COMMENT ON COLUMN public.consent_log.accepted_at IS
  'Momento do aceite (default now()). Imutável após insert — RLS T-114 '
  'bloqueia UPDATE em qualquer coluna que não seja revoked_at/revoked_reason.';

COMMENT ON COLUMN public.consent_log.revoked_at IS
  'NULL = consent ATIVO. timestamptz = momento da revogação. Combinado com '
  'partial unique uq_consent_active_per_purpose garante no máximo 1 row '
  'ativa por (user_id, purpose).';

COMMENT ON COLUMN public.consent_log.revoked_reason IS
  'Texto livre da razão da revogação (ex: "user_request", "terms_updated", '
  '"account_deletion"). NULL enquanto revoked_at IS NULL.';

COMMENT ON COLUMN public.consent_log.ip_address IS
  'IP do cliente no momento do aceite (tipo inet — armazenamento eficiente '
  '4B v4 / 16B v6 + suporte nativo a subnet ops). Mascarado /24 (v4) ou /64 '
  '(v6) após retention.consent_log.ip_mask_after_days (default 90); NULLed '
  'integralmente em §9.4 anonymize_user_references.';

COMMENT ON COLUMN public.consent_log.user_agent IS
  'User-Agent raw no momento do aceite. Convertido em sha256 hex digest após '
  'retention.consent_log.user_agent_hash_after_days (default 30); NULLed em '
  '§9.4 anonymize_user_references.';


-- ============================================================================
-- 9. Trigger / helper functions touching P0-P1 tables
-- ============================================================================
COMMENT ON FUNCTION app.set_updated_at() IS
  'Trigger BEFORE UPDATE compartilhado: seta NEW.updated_at = now() e '
  'retorna NEW. Reaproveitado por households, members, user_profiles, '
  'app_settings (e por todas as tabelas mutáveis das fases seguintes). '
  'Vive em schema app (§5.11 tech-5 — sem objetos em auth). Spec §5.1.';

COMMENT ON FUNCTION public.enforce_min_one_admin() IS
  'Trigger BEFORE UPDATE OR DELETE em public.members. Bloqueia (RAISE '
  'EXCEPTION) três cenários que removeriam o último admin de um household: '
  '(a) UPDATE rebaixando role admin -> member; '
  '(b) UPDATE soft-deletando uma row admin ativa (deleted_at NULL -> NOT NULL); '
  '(c) DELETE hard de uma row admin ativa. '
  'CRITICAL: retorna OLD em DELETE e NEW em UPDATE — devolver NULL em DELETE '
  'aborta silenciosamente, devolver OLD em UPDATE descarta a mudança '
  '(tech-2 fix). Spec §5.1.';

COMMENT ON FUNCTION public.create_user_profile() IS
  'Trigger AFTER INSERT em auth.users (managed schema). Auto-cria a row '
  'correspondente em public.user_profiles com display_name resolvido por '
  'coalesce(NULLIF(raw_user_meta_data->>''display_name'',''''), '
  'split_part(email, ''@'', 1)). SECURITY DEFINER + search_path locked '
  '(public, pg_temp) — necessário porque o caller (GoTrue / anon) não tem '
  'grant direto em public.user_profiles. ON CONFLICT (user_id) DO NOTHING '
  'torna o trigger tolerante a re-fires em testes. Spec §5.12.';

COMMENT ON FUNCTION app.audit_app_settings() IS
  'Trigger AFTER INSERT OR UPDATE em public.app_settings. Insere snapshot '
  '(key, scope, scope_id, old_value, new_value, changed_at, changed_by) em '
  'public.app_settings_history. INSERT -> old_value NULL; UPDATE -> '
  'old_value = OLD.value. changed_by resolvido por NEW.updated_by -> '
  'auth.uid() -> NULL. SECURITY DEFINER + search_path locked (app, public, '
  'pg_temp) — escreve em history mesmo quando RLS bloqueia INSERT direto. '
  'Spec §5.5.';


-- ============================================================================
-- 10. Record this migration
-- ============================================================================
INSERT INTO app.migration_metadata (migration_name, description)
VALUES (
  '20260615121100_add_business_comments_p0',
  'Aplica o texto canônico de COMMENT ON COLUMN / COMMENT ON FUNCTION do '
  'spec Appendix G para o subset P0-P1 (households, members, '
  'household_invitations, user_profiles, app_settings, app_settings_history, '
  'consent_log, system_actors + 4 trigger/helper functions). Texto integral '
  'para app_settings.scope e app_settings.requires_restart copiado verbatim '
  'do §G. Reversível via COMMENT ... IS '''' (cleared) ou re-rodando as '
  'migrations T-106..T-117 que preencheram o texto inline original.'
)
ON CONFLICT (migration_name) DO NOTHING;
