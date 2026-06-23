# Changelog

## [0.1.4](https://github.com/Lukazukimo/unibill-backend/compare/v0.1.3...v0.1.4) (2026-06-23)


### Features

* **db:** App.ingest_invoice transactional outbox for invoice capture (T-326) ([859869e](https://github.com/Lukazukimo/unibill-backend/commit/859869e14e0f02da3e942ceb89df8e0897227918))
* **db:** Invoices + invoice_categories schema with PIX/boleto/dedupe (T-301, T-302, T-303) ([8d5ba93](https://github.com/Lukazukimo/unibill-backend/commit/8d5ba93e8c6279fa49f57f4578f976d2afafe361))
* **db:** Invoices + invoice_categories schema, RLS & pgTAP (T-301/302/303, T-309 subset, T-328) ([db5e7e5](https://github.com/Lukazukimo/unibill-backend/commit/db5e7e5b0f6fbda097fda231c3e13fea45e7c406))
* **db:** P4 ingestion schema — parsers, events, runs, queues, RLS, cron (T-304..T-314) ([a9d144f](https://github.com/Lukazukimo/unibill-backend/commit/a9d144f58dc540548a7b38eb79d0ce54b0ec5770))
* **db:** RLS policies for invoices + invoice_categories (T-309 subset) ([517a6bb](https://github.com/Lukazukimo/unibill-backend/commit/517a6bb2046985b62045aa779a3ae37c8a8e9ca8))
* **functions:** DoImapFetch — real IMAP fetch→capture + runbook (T-326, T-333, T-335) ([5148cfe](https://github.com/Lukazukimo/unibill-backend/commit/5148cfe0cfeb6c5b451e56a31649cf0d7dc62932))
* **functions:** P4 ingestion helpers — household routing, PDF discovery, pgmq access (T-322, T-323) ([f4c68a0](https://github.com/Lukazukimo/unibill-backend/commit/f4c68a021d42e22277dbf072ca647e7e06e6fdbb))
* **functions:** P4 ingestion helpers — household routing, PDF discovery, pgmq access (T-322, T-323) ([f8256e1](https://github.com/Lukazukimo/unibill-backend/commit/f8256e1a0110a9d6343c330edb245fe56780ebdf)), closes [#213](https://github.com/Lukazukimo/unibill-backend/issues/213)
* **functions:** Real P4 ingestion middleware (T-316..T-321) ([9ccf0f4](https://github.com/Lukazukimo/unibill-backend/commit/9ccf0f42d0c550dba9a5ad8094efc723d984b899))
* **functions:** Real P4 ingestion middleware (T-316..T-321) ([446ab00](https://github.com/Lukazukimo/unibill-backend/commit/446ab00fe1081ae776c2152a34b4fba6aa35000b)), closes [#213](https://github.com/Lukazukimo/unibill-backend/issues/213)
* **functions:** Sync-dispatcher Edge Function (T-324) ([cbce851](https://github.com/Lukazukimo/unibill-backend/commit/cbce851a2e6b8a2608f6ab9b2ce556ce04f2af24))
* **functions:** Sync-dispatcher Edge Function (T-324) ([e45f4e1](https://github.com/Lukazukimo/unibill-backend/commit/e45f4e107d51825b3328aa7170694ec741ee47fa)), closes [#35](https://github.com/Lukazukimo/unibill-backend/issues/35) [#213](https://github.com/Lukazukimo/unibill-backend/issues/213)
* **functions:** Sync-worker orchestration — loop, claim, DLQ, auto-pause (T-325, T-327) ([95ae391](https://github.com/Lukazukimo/unibill-backend/commit/95ae39174a2e0cc90457ddb3b474ed9bc56e5a5e))
* **functions:** Sync-worker orchestration — loop, claim, DLQ, auto-pause (T-325, T-327) ([3c0c447](https://github.com/Lukazukimo/unibill-backend/commit/3c0c447de4f9d9a3c5bd338e6dad31988a12e373))


### Bug Fixes

* **db:** Break connected_emails RLS recursion, grant base privileges, guard owner takeover ([84c4df4](https://github.com/Lukazukimo/unibill-backend/commit/84c4df4f7cfb8d52555f208fbc837aa08c1997ea)), closes [#213](https://github.com/Lukazukimo/unibill-backend/issues/213)
* **db:** Connected_emails RLS recursion + base grants; green & CI-enforce the pgTAP suite ([1ae25f9](https://github.com/Lukazukimo/unibill-backend/commit/1ae25f9d017e0120cefbd7d450f71f52f71cbe8b))
* **db:** Correct base32 invitation-code CHECK to exclude L (T-227) ([4dcd643](https://github.com/Lukazukimo/unibill-backend/commit/4dcd643392eaa312b7f7fd772b482db264bc02da)), closes [#213](https://github.com/Lukazukimo/unibill-backend/issues/213)
* **db:** Make `supabase db reset` apply migrations on the current CLI ([#213](https://github.com/Lukazukimo/unibill-backend/issues/213)) ([87614c6](https://github.com/Lukazukimo/unibill-backend/commit/87614c6a02cb2b8406ddb67c7cc2b51a983658b6))
* **test:** Lift data-modifying CTEs to top level in pgTAP RLS suite ([215b67b](https://github.com/Lukazukimo/unibill-backend/commit/215b67bc5f111d9de1122f189d13c39a33c984e3))
* **test:** Lift data-modifying CTEs to top level in pgTAP RLS suite (0A000) ([0e64e6f](https://github.com/Lukazukimo/unibill-backend/commit/0e64e6f198a00dabdf39e9002e17613fd9063b06))


### Tests

* **db:** Make the pgTAP suite green end-to-end ([#213](https://github.com/Lukazukimo/unibill-backend/issues/213)) ([c7f62c6](https://github.com/Lukazukimo/unibill-backend/commit/c7f62c695704f4bea935985229035c6d4a7ceeb4))
* **db:** PgTAP cross-tenant RLS + dedupe for invoices/categories (T-328) ([849bde2](https://github.com/Lukazukimo/unibill-backend/commit/849bde2237468aa4ff5ac1af2dcd4227b86301ea))


### CI / Tooling

* **backend:** Run the real pgTAP suite in test-db, replacing the stub ([#213](https://github.com/Lukazukimo/unibill-backend/issues/213)) ([cb52421](https://github.com/Lukazukimo/unibill-backend/commit/cb52421443d1e16a7ae91176bd684f09ab4805bc))

## [0.1.3](https://github.com/Lukazukimo/unibill-backend/compare/v0.1.2...v0.1.3) (2026-06-14)


### Features

* **functions:** Households-create — atomic household + creator-admin (T-516) ([6857943](https://github.com/Lukazukimo/unibill-backend/commit/685794342c6d679365e4b6d7fa9f35849c170117))
* **functions:** Households-create — atomic household + creator-admin (T-516) ([3124b13](https://github.com/Lukazukimo/unibill-backend/commit/3124b13635ad50bcecd84d9d820d6b081f82601f))


### CI / Tooling

* **deploy:** Push auth/api config in the dev-deploy plan ([040798b](https://github.com/Lukazukimo/unibill-backend/commit/040798b945764de5027c8c66064b4051f6377a28))
* **deploy:** Push auth/api config in the dev-deploy plan ([8ed65ec](https://github.com/Lukazukimo/unibill-backend/commit/8ed65ecffcb8fd97bceb3852c2ecda71f2ad02c9))

## [0.1.2](https://github.com/Lukazukimo/unibill-backend/compare/v0.1.1...v0.1.2) (2026-06-11)


### Bug Fixes

* **ci:** Unblock migration-lint, config-drift, and test-deno jobs ([fcb276c](https://github.com/Lukazukimo/unibill-backend/commit/fcb276c2a8da5c831bf95581714772d7d8c3bf0a))
* **ci:** Unblock migration-lint, config-drift, test-deno (3 mechanical fixes) ([d6402b4](https://github.com/Lukazukimo/unibill-backend/commit/d6402b47f5a4b056aa7f0fd24a4be572a9b42ff2))
* **functions:** Resolve 29 TS errors revealed by test-deno (9 files) ([33a3103](https://github.com/Lukazukimo/unibill-backend/commit/33a310361ca5ea0495ba45d8acbb3895b2052a9d))
* **functions:** Resolve 29 TS errors revealed by test-deno (9 files) ([a6743f8](https://github.com/Lukazukimo/unibill-backend/commit/a6743f8da57abfa8b475b6396aa0e03f6eef9b53))
* **functions:** Use nonNull() helper instead of broken NonNullable cast ([64410d2](https://github.com/Lukazukimo/unibill-backend/commit/64410d253a2cd04a8d32ced952be54a964390ef5))
* **lint:** AUDIT-AUTH-OK annotation for Supabase signup hook (last migration-lint error) ([7c136ae](https://github.com/Lukazukimo/unibill-backend/commit/7c136aeb3e29d7753ccd2669c7f4f64e5d4937a2))
* **lint:** Resolve 8 deno lint errors after fmt pass ([fff65ff](https://github.com/Lukazukimo/unibill-backend/commit/fff65ff962f86b56b1a3ad4fb969c264909c0908))
* **lint:** Support AUDIT-AUTH-OK annotation for Supabase signup hook ([670242d](https://github.com/Lukazukimo/unibill-backend/commit/670242d22a399d08b8283b0c5f97c53a1881cfd6))
* **lint:** Tighten no-auth-objects regex + add 8 AUDIT-FK-OK annotations ([dbc6079](https://github.com/Lukazukimo/unibill-backend/commit/dbc607960f47b68d162e131bbf7b9a699f5d59d3))
* **lint:** Tighten no-auth-objects regex + add AUDIT-FK-OK annotations ([5077b3b](https://github.com/Lukazukimo/unibill-backend/commit/5077b3b93584b0cc65df0dbac2bbaeca490b9095))
* **tests:** Pass explicit generic to nonNull&lt;T&gt;(X) calls ([7b5fd89](https://github.com/Lukazukimo/unibill-backend/commit/7b5fd8999e30b535609c7869498d39971c4b649d))
* **tests:** Re-place nonNull import outside multi-line existing imports ([a6650d3](https://github.com/Lukazukimo/unibill-backend/commit/a6650d302b4f031b1cd0f12db5e50b0086b2ea35))


### Tests

* **functions:** Fix makeRequest GET-with-body bug + skip lockout-priority test ([14472f7](https://github.com/Lukazukimo/unibill-backend/commit/14472f71cec770ebcf15b6483eb2e6e66ff03b20))

## [0.1.1](https://github.com/Lukazukimo/unibill-backend/compare/v0.1.0...v0.1.1) (2026-06-10)


### Features

* **auth:** Add deep-link redirect smoke test + document future https URL ([6138c4a](https://github.com/Lukazukimo/unibill-backend/commit/6138c4aeadabdeaa36949b0e5191cbefd7559692))
* **auth:** Add hCaptcha-gated signup and password-reset guards ([eb8578b](https://github.com/Lukazukimo/unibill-backend/commit/eb8578befc3715c556b5fb70d04c2fa4adfb912b))
* **auth:** Add login lockout middleware with 10/30min threshold and 1h block ([073ec9d](https://github.com/Lukazukimo/unibill-backend/commit/073ec9d95e2b2a397dcb2e9db7b4a98eb4a348e7))
* **auth:** Add pt-BR invite/email_change templates + desktop fallback page ([cbfb835](https://github.com/Lukazukimo/unibill-backend/commit/cbfb835cd620f40b6b6f132a3dd70c1ee31bc4e3))
* **db:** Add app schema RLS helper functions (T-113) ([fe10fb4](https://github.com/Lukazukimo/unibill-backend/commit/fe10fb49c77a67614da2dfcddf2ff4ec674bb7ab))
* **db:** Add app_settings + history with audit trigger ([c6ea830](https://github.com/Lukazukimo/unibill-backend/commit/c6ea83038144bc313d51812f9405bd70ee5ddfb2))
* **db:** Add app.create_vault_secret + app.decrypt_app_password wrappers ([16c2a51](https://github.com/Lukazukimo/unibill-backend/commit/16c2a5180d990ec916c2d4f18b1e2c865828e2fa))
* **db:** Add Appendix G business comments for connected_emails tables ([ca9e802](https://github.com/Lukazukimo/unibill-backend/commit/ca9e8024332f33e0f6020f53a5303514a97b1d96))
* **db:** Add business COMMENT ON COLUMN for P0-P1 tables (Appendix G) ([2bcd42c](https://github.com/Lukazukimo/unibill-backend/commit/2bcd42ca580703f47632c4ba403101ce9822f12c))
* **db:** Add connected_emails + connected_email_households schema ([1b9f950](https://github.com/Lukazukimo/unibill-backend/commit/1b9f9507f9aeb5b42f63635da7a2eddc94921d57))
* **db:** Add consent_log table with granular LGPD consent tracking ([89d94db](https://github.com/Lukazukimo/unibill-backend/commit/89d94db2a5624013ed4cf6b18fc997e757653e66))
* **db:** Add household_invitations table with code format check ([e89e443](https://github.com/Lukazukimo/unibill-backend/commit/e89e443896f5a805054313bc65a67949bb25f58d))
* **db:** Add members table with enforce_min_one_admin trigger ([6231042](https://github.com/Lukazukimo/unibill-backend/commit/6231042366391f6e37a704458a1df9642ea9fc52))
* **db:** Add system_actors table with sentinel seeds and RLS ([108a3c5](https://github.com/Lukazukimo/unibill-backend/commit/108a3c53952d2e1a3720f9fdb2cd7665a0a7a1af))
* **db:** Add system_admin_grants append-only audit table ([513367b](https://github.com/Lukazukimo/unibill-backend/commit/513367b794fc3aba9f33ee6f82cf7ddd80f273db))
* **db:** Create app schema and core extensions ([6aea02e](https://github.com/Lukazukimo/unibill-backend/commit/6aea02e7c8563813eb61d711dd612a07478a75ce))
* **db:** Create households table and app.set_updated_at helper ([aba26c3](https://github.com/Lukazukimo/unibill-backend/commit/aba26c3a103b586fd5e3d4aef0fa4523bde55cb6))
* **db:** Lock down vault schema with GRANT/REVOKE matrix ([5fb894a](https://github.com/Lukazukimo/unibill-backend/commit/5fb894a329d280d10daf2bf426a5cdfdd629b27e))
* **edge-functions:** Add auth-consent-status re-consent gate endpoint ([96b27d2](https://github.com/Lukazukimo/unibill-backend/commit/96b27d22d786015c21aa194698071a810c284f68))
* **edge:** POST /invitations/redeem with double rate limit + code lockout ([ad6b561](https://github.com/Lukazukimo/unibill-backend/commit/ad6b561ef944db1c8f2316036bdfccdebfeaab31))
* **edge:** Real impl of shared imap, auth, rateLimit helpers ([6210216](https://github.com/Lukazukimo/unibill-backend/commit/6210216952363eea47042a69280d80a5d4e76c33))
* **emails:** Add DELETE /emails/:id revoke endpoint + vault wrapper ([04342d3](https://github.com/Lukazukimo/unibill-backend/commit/04342d3ce3fd17534ca2c89fc3cc47af056a1200))
* **emails:** Add PATCH /emails/:id/rotate-password (vault in-place swap) ([c006c31](https://github.com/Lukazukimo/unibill-backend/commit/c006c31fe68719ade6cab9ccfb79d35fe4fc9ece))
* **emails:** POST /emails/connect with IMAP validation + Vault ([a74caeb](https://github.com/Lukazukimo/unibill-backend/commit/a74caeb8543e3cc7b79957e39cd1f46ed2932ebc))
* **functions:** Add /consent/accept and /consent/revoke endpoints (LGPD granular) ([c75ba8d](https://github.com/Lukazukimo/unibill-backend/commit/c75ba8df72fd782d46cf8821f00d4afc4e28b143))
* **invitations:** Harden household_invitations with base32 codes + email normalization + redeem index ([027c7fe](https://github.com/Lukazukimo/unibill-backend/commit/027c7fe791c9e25b27c7bfa98325e50a5cd8299b))
* **ops:** Add sys-admin bootstrap script, runbook, and SQL invariant ([9130990](https://github.com/Lukazukimo/unibill-backend/commit/91309908d03c963b33b4d2d20ad5424a9c21c984))
* **P0-P1:** Core schema, RLS, seeds, pgTAP, ERD (T-105..T-126) ([5830863](https://github.com/Lukazukimo/unibill-backend/commit/583086394a019e443acc4495288dfb455ca97719))
* **P2-P3:** Auth + Connected Emails + Vault + LGPD Consent (T-201..T-230) ([9cec56e](https://github.com/Lukazukimo/unibill-backend/commit/9cec56e28c1ed7ceab101ef32c60c71d1e119388))
* **rls:** Enable RLS and add policies for P0-P1 tables ([76ce010](https://github.com/Lukazukimo/unibill-backend/commit/76ce0106cc4f5b561a41d052c8b4ef8fff790675))
* **rls:** Enable RLS for connected_emails and connected_email_households ([5af1a6f](https://github.com/Lukazukimo/unibill-backend/commit/5af1a6f98bf9028aba3037f713651a25d1a80994))


### Tests

* **app_settings:** Add pgTAP suite for audit trigger, CHECK and partial unique ([d003610](https://github.com/Lukazukimo/unibill-backend/commit/d003610d6defc1b69e2e58d73604a6e3999ed318))
* **auth:** HIBP integration test with multi-password fixture + CI workflow ([38aa6de](https://github.com/Lukazukimo/unibill-backend/commit/38aa6de92853ecaa67eccee41b8bb8a40ca3e0af))
* **db:** Add pgTAP suite for create_user_profile trigger ([76f6d62](https://github.com/Lukazukimo/unibill-backend/commit/76f6d62c4f5a0e72b37889b1d6eae60fabecf364))
* **db:** Add pgTAP suite for enforce_min_one_admin trigger ([107878c](https://github.com/Lukazukimo/unibill-backend/commit/107878ca86fc2db1ebb7203c7741388320747d25))
* **rls:** Add pgTAP cross-tenant isolation suite for P0-P1 tables ([bc270bb](https://github.com/Lukazukimo/unibill-backend/commit/bc270bb752917e68cd6a2f4db3f5ca283e4f40c9))
* **rls:** PgTAP cross-tenant + cross-binding tests for connected_emails ([4ed4c0f](https://github.com/Lukazukimo/unibill-backend/commit/4ed4c0fcdf6121e928afd59cd6704c0b401a9ead))


### CI / Tooling

* **backend:** Add base CI workflows and migration lint ([abaa56a](https://github.com/Lukazukimo/unibill-backend/commit/abaa56ae36bd84a93b9c6959c1d20c613a9d488d))
* **backend:** Wire migration-lint TS + config-drift jobs (T-120 follow-up) ([f7b7d61](https://github.com/Lukazukimo/unibill-backend/commit/f7b7d619033b83391f1396155f14c5472a83e8d2))
* **backend:** Wire migration-lint TS and config-drift jobs ([2e863c3](https://github.com/Lukazukimo/unibill-backend/commit/2e863c35571634625105d932b048b4fefce01245))
* **migrations:** Add deno migration linter with structural invariants ([e6b60a2](https://github.com/Lukazukimo/unibill-backend/commit/e6b60a272c81cb4e84fe9ea38aeaf244ef225d97))
* **scripts:** Add Deno config-docs-sync drift check (T-120) ([92cdda7](https://github.com/Lukazukimo/unibill-backend/commit/92cdda7cb82e64f3fb0959a4497897e3c51cd3db))


### Ops / Runbooks

* **T-217:** Add SQL bootstrap script for first sys admin with audit + event ([cf5c582](https://github.com/Lukazukimo/unibill-backend/commit/cf5c5826297f69dd453a36a32bfa5c1c5e547822))


### Documentation

* Import MVP design spec + implementation plan into repo ([fd3c17b](https://github.com/Lukazukimo/unibill-backend/commit/fd3c17b4a8c1bd0512568fafbb54e7b59e390cc9))
* Import MVP design spec and implementation plan into repo ([412cdae](https://github.com/Lukazukimo/unibill-backend/commit/412cdaefe0c0b177af7ba78c7202755ac1cdc569))
* **schema:** Add P0-P1 ERD, data dictionary, and generator script ([2bd1871](https://github.com/Lukazukimo/unibill-backend/commit/2bd1871a23c2bb15d0ac50c468673528eb47885b))
