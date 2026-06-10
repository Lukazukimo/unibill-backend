# Changelog

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
