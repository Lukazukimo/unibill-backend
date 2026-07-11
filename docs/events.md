# Domain events & business rules

> **Generated** — the sections below are produced by
> [`scripts/gen_events_doc.ts`](../scripts/gen_events_doc.ts) from the `emitDomainEvent` /
> `emitEvent` call sites in `supabase/functions/` and the Business Rules catalog (spec §F). **Do not
> edit between the markers** — re-run the generator
> (`deno run --allow-read --allow-write scripts/gen_events_doc.ts`).
>
> Events are appended to `public.domain_events` (lightweight event sourcing, spec §6.5). See also
> the [data dictionary](data-dictionary.md) and [configuration reference](configuration.md).

<!-- BEGIN-GENERATED:events -->

## Domain events emitted (from `supabase/functions/`)

26 distinct event type(s), grepped from `emitDomainEvent` / `emitEvent` call sites.

| Event type | Emitted by |
|---|---|
| `ai.chain.replay_available` | `_shared/chain_breaker.ts` |
| `auth.lockout.triggered` | `auth-login-guard/index.ts` |
| `capacity.critical` | `capacity-evictor/index.ts` |
| `capacity.eviction.tier_escalated` | `capacity-evictor/index.ts` |
| `capacity.ingestion.resumed` | `capacity-monitor/index.ts` |
| `capacity.threshold_crossed` | `capacity-monitor/index.ts` |
| `circuit.admin_controlled` | `admin-circuit-control/index.ts` |
| `consent.accepted` | `consent-accept/index.ts` |
| `consent.required` | `auth-consent-status/index.ts` |
| `consent.revoked` | `consent-revoke/index.ts` |
| `email.connected` | `emails-connect/index.ts` |
| `email.household_unbound` | `emails-unbind/index.ts` |
| `email.password_rotated` | `emails-rotate/index.ts` |
| `email.revoked` | `emails-delete/index.ts` |
| `email.sync.auto_paused` | `sync-worker/index.ts` |
| `email.sync.dead_lettered` | `sync-worker/index.ts` |
| `household.created` | `households-create/index.ts` |
| `invitation.redeem_failed` | `invitations-redeem/index.ts` |
| `invitation.redeemed` | `invitations-redeem/index.ts` |
| `invoice.failed` | `extraction-worker/index.ts` |
| `invoice.reextract_requested` | `admin-invoice-reextract/index.ts` |
| `pdf.archived` | `capacity-evictor/archive_pdf.ts` |
| `privacy.export.completed` | `privacy-export/index.ts` |
| `system_admin.promoted` | `admin-system-admins/index.ts` |
| `system_admin.revoked` | `admin-system-admins/index.ts` |
| `user.deleted` | `privacy-delete/orchestrator.ts` |

---

## Business rules (spec §F)

28 rule(s). The full condition/configs columns live in spec Appendix F.

| ID | Domínio | Trigger | Efeito | Eventos |
|---|---|---|---|---|
| BR-001 | Extraction | Após Layer 4 | status='extracted' | invoice.extracted |
| BR-002 | Extraction | Após Layer 4 | status='needs_review', reason='low_confidence' | invoice.needs_review |
| BR-003 | Extraction | Após Layer 4 | status='failed' | invoice.extraction_failed |
| BR-004 | Extraction | AI chain inteira falha | status='needs_review', reason='ai_chain_open'; ACK pgmq | invoice.routed_to_review |
| BR-005 | OCR | OCR chain inteira falha | status='needs_review', reason='ocr_chain_open' | idem |
| BR-006 | AI chain breaker | 6+ tentativas chain em 10min com 0 successes E dura 60s | state='open', cooldown 15min inicial | ai.chain.circuit_opened |
| BR-007 | AI chain breaker | Provider retorna quota_exceeded | trip imediato | idem com reason='quota' |
| BR-008 | AI chain breaker | 2 probes consecutivos success em half_open | state='closed', reset reopen_count | ai.chain.circuit_closed + replay_available |
| BR-009 | AI chain breaker | Qualquer probe falha em half_open | state='open', cooldown × 2^reopen_count (cap 6h) | ai.chain.circuit_reopened |
| BR-010 | Capacity | DB usage >= 80% | Enfileira eviction | capacity.threshold_crossed |
| BR-011 | Capacity | DB usage >= 90% | Eviction agressiva + pausa ingestão (features.ingestion_enabled=false) + email admin | capacity.threshold_crossed |
| BR-012 | Capacity | DB usage <= 85% após red | features.ingestion_enabled=true | capacity.ingestion.resumed |
| BR-013 | Eviction | Adaptive não converge em Tier 1 | Tier 2 (floor/=2) | capacity.eviction.tier_escalated |
| BR-014 | Households | Rebaixar/remover último admin | EXCEPTION, operação bloqueada | — |
| BR-015 | Sync | 5+ erros IMAP consecutivos numa caixa | connected_emails.status='error' | email.sync.auto_paused |
| BR-016 | PDF storage | PDF em invoice > 365 dias (e Storage > 90%) | DELETE Storage, invoices.pdf_archived_at=now(), INSERT pdf_archive_log | pdf.archived |
| BR-017 | LGPD | Mudança em legal.terms_version | Login bloqueia até re-aceitar | consent.required |
| BR-018 | LGPD | Revogação de telemetry consent | Cliente para POST; backend purga client_telemetry do user | consent.revoked |
| BR-019 | Privacy | Export | 1 export/dia/user | — |
| BR-020 | Privacy | Export | Apenas invoices touched (paid_by/created_by/updated_by = me) + PDFs de emails owned | — |
| BR-021 | Account deletion | Bloqueia se último admin | 422 com lista de households | — |
| BR-022 | Invoices | Soft delete | deleted_at=now(), partial indexes excluem | — |
| BR-023 | OCR | Early-exit | Para no pg 1 | — |
| BR-024 | OCR | Early-exit minimum | Para early | — |
| BR-025 | Retention | Daily hard ceiling | DELETE WHERE age > max_age_days | — |
| BR-026 | Invitations | Code expirado ou usado | 404 | invitation.redeem_failed |
| BR-027 | Invitations | invited_email != auth.email() | 403 | invitation.redeem_failed |
| BR-028 | Sys admin | Bootstrap (1ª vez) | INSERT system_admin_grants + domain_event | system_admin.bootstrapped |

<!-- END-GENERATED:events -->
