# Changelog

## [0.1.8](https://github.com/Lukazukimo/unibill-backend/compare/v0.1.7...v0.1.8) (2026-06-26)


### Features

* **ops:** GET /health — public status + service_role metrics (T-613) ([6fa2272](https://github.com/Lukazukimo/unibill-backend/commit/6fa22729d2f5389d9f0da8870b85f874dde04f0b))
* **ops:** GET /health — public status + service_role metrics (T-613) ([76dd511](https://github.com/Lukazukimo/unibill-backend/commit/76dd511bb2de777a7e04b7f92d52970df64cc8a9)), closes [#124](https://github.com/Lukazukimo/unibill-backend/issues/124)


### CI / Tooling

* **ops:** Health-monitor + capacity monthly report workflows (T-614) ([8a17289](https://github.com/Lukazukimo/unibill-backend/commit/8a172898087b57f02314c717531a78db58876e90))
* **ops:** Health-monitor + capacity monthly report workflows (T-614) ([0fc2411](https://github.com/Lukazukimo/unibill-backend/commit/0fc24112d90bd8cbb7e4933fccfb8408117ba298)), closes [#123](https://github.com/Lukazukimo/unibill-backend/issues/123)
* Publish Deno coverage artifact + summary (T-617, Deno-only scope) ([46672ed](https://github.com/Lukazukimo/unibill-backend/commit/46672ede023ae5733b95221a3a2bd606eb79007e))
* Publish Deno coverage artifact + summary (T-617, Deno-only scope) ([8c16bad](https://github.com/Lukazukimo/unibill-backend/commit/8c16bad67d554aaa11335ffb7bff5274e45c3248)), closes [#127](https://github.com/Lukazukimo/unibill-backend/issues/127)


### Ops / Runbooks

* **backup:** Weekly pg_dump + monthly storage-metadata → Backblaze B2 (T-620) ([98a03fa](https://github.com/Lukazukimo/unibill-backend/commit/98a03fa16d662640a1ed6a1b88a39f4b6f927529)), closes [#130](https://github.com/Lukazukimo/unibill-backend/issues/130)


### Documentation

* **adr:** Seed ADR directory with the 5 foundational decisions (T-626) ([a18b0cc](https://github.com/Lukazukimo/unibill-backend/commit/a18b0cc1dea3b83176809bf9d03023da51674efc))
* **adr:** Seed ADR directory with the 5 foundational decisions (T-626) ([18f7451](https://github.com/Lukazukimo/unibill-backend/commit/18f7451e4184ff24f8aac3f69804b9a7d882c7ce)), closes [#136](https://github.com/Lukazukimo/unibill-backend/issues/136)
* **api:** OpenAPI 3.1 from §E + docs landing (T-625, scoped) ([5f11aad](https://github.com/Lukazukimo/unibill-backend/commit/5f11aad6ed8272e1cbdd903e7f4e531c3406b405))
* **api:** OpenAPI 3.1 from §E + docs landing (T-625, scoped) ([e838e28](https://github.com/Lukazukimo/unibill-backend/commit/e838e2885333c6764567a95b2db138f310071e0f)), closes [#160](https://github.com/Lukazukimo/unibill-backend/issues/160)
* **gen:** Auto-generate configuration.md + events.md + Pages publish (T-624) ([9fca54a](https://github.com/Lukazukimo/unibill-backend/commit/9fca54a85dc9ca4c7526f47c5e00eade6ea55a2d))
* **gen:** Auto-generate configuration.md + events.md + Pages publish (T-624) ([53a2ce7](https://github.com/Lukazukimo/unibill-backend/commit/53a2ce713ca2717616113a9cda4ac89796a07361)), closes [#134](https://github.com/Lukazukimo/unibill-backend/issues/134)
* **governance:** Exact Apache-2.0 LICENSE, Code of Conduct, 90d disclosure (T-623) ([04e0bbe](https://github.com/Lukazukimo/unibill-backend/commit/04e0bbe20752a85ff17c75e8ba75674a370c6961))
* **governance:** Exact Apache-2.0 LICENSE, Code of Conduct, 90d disclosure (T-623) ([d9910d6](https://github.com/Lukazukimo/unibill-backend/commit/d9910d6595b550ec42bc2bacce3d9bbffddf7181)), closes [#133](https://github.com/Lukazukimo/unibill-backend/issues/133)
* **ops:** RUNBOOK.md with the 8 incident/maintenance procedures (T-621) ([0740b01](https://github.com/Lukazukimo/unibill-backend/commit/0740b01474755651791b1320cd3814e8d9a9731c))
* **ops:** RUNBOOK.md with the 8 incident/maintenance procedures (T-621) ([7383962](https://github.com/Lukazukimo/unibill-backend/commit/738396210ef9dc56d3cae76e2be8962e2f0d3d54)), closes [#131](https://github.com/Lukazukimo/unibill-backend/issues/131)

## [0.1.7](https://github.com/Lukazukimo/unibill-backend/compare/v0.1.6...v0.1.7) (2026-06-25)


### Features

* **lgpd:** Anonymize_user_references + drop audit FKs (T-606) ([0c5617d](https://github.com/Lukazukimo/unibill-backend/commit/0c5617dba987220eba85f7367fe53557b42f82db))
* **lgpd:** Anonymize_user_references + drop audit FKs to auth.users (T-606) ([ecdfda6](https://github.com/Lukazukimo/unibill-backend/commit/ecdfda676be8d738b6ecc533768d69ce6005ead8)), closes [#116](https://github.com/Lukazukimo/unibill-backend/issues/116)
* **lgpd:** Consent_log retention cron — IP mask + UA hash + hard ceiling (T-610) ([e107e74](https://github.com/Lukazukimo/unibill-backend/commit/e107e740f3904b6dafe642982eb24ffaa06cbcf6))
* **lgpd:** Consent_log retention cron — IP mask + UA hash + hard ceiling (T-610) ([df61b59](https://github.com/Lukazukimo/unibill-backend/commit/df61b59c1659f8dbd7435c7487694f63be284984)), closes [#120](https://github.com/Lukazukimo/unibill-backend/issues/120)
* **lgpd:** Delete-my-account Edge Function (T-609) ([d88b86a](https://github.com/Lukazukimo/unibill-backend/commit/d88b86a19536361600b22e1a4e7a7e37c9523367))
* **lgpd:** Delete-my-account Edge Function (T-609) ([0d5f5de](https://github.com/Lukazukimo/unibill-backend/commit/0d5f5de62e78b8056f94d829e7eb52d3310384f2)), closes [#119](https://github.com/Lukazukimo/unibill-backend/issues/119)
* **lgpd:** Export-my-data Edge Function + private-exports bucket (T-608) ([f16165c](https://github.com/Lukazukimo/unibill-backend/commit/f16165c61938953bb53120a3fb50f02d70de964e))
* **lgpd:** Export-my-data Edge Function + private-exports bucket (T-608) ([b0472c0](https://github.com/Lukazukimo/unibill-backend/commit/b0472c05604be81acea50a06f15f1cbf7459c8cf)), closes [#118](https://github.com/Lukazukimo/unibill-backend/issues/118)


### Tests

* **lgpd:** Anonymize pgTAP + auth.users FK coverage guard (T-607) ([0771e6a](https://github.com/Lukazukimo/unibill-backend/commit/0771e6a1aa0643ac19cbf22fcde0cd491305e80f))
* **lgpd:** Anonymize_user_references pgTAP + auth.users FK coverage guard (T-607) ([5fc0882](https://github.com/Lukazukimo/unibill-backend/commit/5fc088270d0890b59d8cced6b76ec5535c27b909)), closes [#117](https://github.com/Lukazukimo/unibill-backend/issues/117)

## [0.1.6](https://github.com/Lukazukimo/unibill-backend/compare/v0.1.5...v0.1.6) (2026-06-25)


### Features

* **capacity:** Archive-domain-events — cold events to jsonl.gz (T-605) ([43f85df](https://github.com/Lukazukimo/unibill-backend/commit/43f85df1a7f4e4ad5028c281a82fb29f1ca27264))
* **capacity:** Archive-domain-events (cold domain_events → jsonl.gz) ([069c39c](https://github.com/Lukazukimo/unibill-backend/commit/069c39c7400fe8e60b885fbe5ed8ee7e876e5965)), closes [#115](https://github.com/Lukazukimo/unibill-backend/issues/115)
* **capacity:** Capacity + health + telemetry schema (T-601) ([23a7500](https://github.com/Lukazukimo/unibill-backend/commit/23a7500d714c7060fba71e1a8dd2779c160754c6))
* **capacity:** Capacity + health + telemetry schema (T-601) ([18cfe47](https://github.com/Lukazukimo/unibill-backend/commit/18cfe478ca49468d245d43ac7c0dc2cbb7ce0a15)), closes [#106](https://github.com/Lukazukimo/unibill-backend/issues/106)
* **capacity:** Capacity-evictor — tier escalation + PDF archive (T-603) ([12ee38e](https://github.com/Lukazukimo/unibill-backend/commit/12ee38e3f8e65bb4d00534782d9e586d1f41f5b6))
* **capacity:** Capacity-evictor (tier escalation + PDF archive) ([1b8eb9c](https://github.com/Lukazukimo/unibill-backend/commit/1b8eb9c9a14aaefddc583533d1508d693dacd560)), closes [#111](https://github.com/Lukazukimo/unibill-backend/issues/111)
* **capacity:** Capacity-monitor edge function (measure + classify + react) ([3af5e7e](https://github.com/Lukazukimo/unibill-backend/commit/3af5e7e01e126b2e84991c5774d8744991429736)), closes [#107](https://github.com/Lukazukimo/unibill-backend/issues/107)
* **capacity:** Capacity-monitor edge function (T-602) ([78f7d57](https://github.com/Lukazukimo/unibill-backend/commit/78f7d5750fd9a3216080fdd7aa8f71cf979262ae))
* **capacity:** Cron schedules for capacity + retention (T-604) ([9c16f94](https://github.com/Lukazukimo/unibill-backend/commit/9c16f94a7eff1214fab3bbee936a769755e31325))
* **capacity:** Cron schedules for capacity + retention (T-604) ([7283a32](https://github.com/Lukazukimo/unibill-backend/commit/7283a32de5ce0b50cca7b0dc4bfe9055319ec4fe)), closes [#114](https://github.com/Lukazukimo/unibill-backend/issues/114)


### Bug Fixes

* **capacity:** Drop unused DomainEventInput import (CI deno-latest lint) ([dc08398](https://github.com/Lukazukimo/unibill-backend/commit/dc08398b8c4ac80f002992e6a39fe98c893496bc))

## [0.1.5](https://github.com/Lukazukimo/unibill-backend/compare/v0.1.4...v0.1.5) (2026-06-25)


### Features

* **admin:** Chain-recovery replay endpoint POST /admin/replay-chain ([09030a8](https://github.com/Lukazukimo/unibill-backend/commit/09030a8c806ec85f0738b7c66e6bf9246c8b3f99)), closes [#68](https://github.com/Lukazukimo/unibill-backend/issues/68)
* **admin:** P5 slice F1 — re-extract endpoint ([84166ba](https://github.com/Lukazukimo/unibill-backend/commit/84166baf84bfaac272318980238342cbf19f0dce))
* **admin:** Re-extract endpoint POST /admin/invoices/:id/reextract ([be7a68a](https://github.com/Lukazukimo/unibill-backend/commit/be7a68ac627c4e93bfed6f238414272ca77dd1d6)), closes [#67](https://github.com/Lukazukimo/unibill-backend/issues/67)
* **db:** Create the ai_calls observability table (T-401) ([1e41884](https://github.com/Lukazukimo/unibill-backend/commit/1e41884302bfef1dc2704df7497dfc09ef54c7a5)), closes [#47](https://github.com/Lukazukimo/unibill-backend/issues/47)
* **extraction:** 4-layer extraction cascade orchestrator ([349d8e6](https://github.com/Lukazukimo/unibill-backend/commit/349d8e6a847d2aa5dfae1ecbe4e2db7a554a63d0)), closes [#65](https://github.com/Lukazukimo/unibill-backend/issues/65)
* **extraction:** AI extraction provider chain (createAiClient) ([d2b0dba](https://github.com/Lukazukimo/unibill-backend/commit/d2b0dba8c1d3dd7e0c94b67d7ffa8c9ba355bc06)), closes [#63](https://github.com/Lukazukimo/unibill-backend/issues/63)
* **extraction:** Announce replayable backlog when the chain breaker closes ([a019698](https://github.com/Lukazukimo/unibill-backend/commit/a019698c4f3db350eff11a0ef8efbcef387481a2)), closes [#68](https://github.com/Lukazukimo/unibill-backend/issues/68)
* **extraction:** Chain-level circuit breaker for the OCR/AI provider chains ([d7f6510](https://github.com/Lukazukimo/unibill-backend/commit/d7f6510fc947bafba9cd6f40c95d62e214c78b77)), closes [#60](https://github.com/Lukazukimo/unibill-backend/issues/60)
* **extraction:** Extracted_payload v1 contract + invoices writer mapper ([08ac070](https://github.com/Lukazukimo/unibill-backend/commit/08ac070f9e067cde1ec867e9eefa7b267d65d578)), closes [#75](https://github.com/Lukazukimo/unibill-backend/issues/75)
* **extraction:** Extraction-worker shell — pgmq consumer + persist + events ([d94a002](https://github.com/Lukazukimo/unibill-backend/commit/d94a0024d061443e20da906b37a14deb4346c242)), closes [#65](https://github.com/Lukazukimo/unibill-backend/issues/65)
* **extraction:** P5 close-out — Vault setup for provider API keys + redaction (T-403) ([9b87d29](https://github.com/Lukazukimo/unibill-backend/commit/9b87d29f894d594521aca1741f8b8a4f9db03f51))
* **extraction:** P5 slice D2 — AI chain + chain-level breaker ([dcd78a7](https://github.com/Lukazukimo/unibill-backend/commit/dcd78a74b40918b2ece4f4ef6515480a3ba86363))
* **extraction:** P5 slice E1 — extracted_payload v1 contract + invoices writer ([0839cfb](https://github.com/Lukazukimo/unibill-backend/commit/0839cfbe18db0fa32e8e8dd05352e57b7bab0f8e))
* **extraction:** P5 slice E2 — 4-layer cascade orchestrator ([cff916b](https://github.com/Lukazukimo/unibill-backend/commit/cff916b1615f7d8e6e1f1b3e2890fff5fe80437b))
* **extraction:** P5 slice E3a — extraction-worker shell + cron ([21c4517](https://github.com/Lukazukimo/unibill-backend/commit/21c45178c166fa118f8ac102933c5047f8f6da4d))
* **extraction:** P5 slice F2 — chain-recovery replay (event + admin endpoint) ([533fc23](https://github.com/Lukazukimo/unibill-backend/commit/533fc236ef3646addbd499b2442623230a6f5945))
* **extraction:** Schedule unibill-extraction-worker cron (1 min) ([77d1693](https://github.com/Lukazukimo/unibill-backend/commit/77d16930ddfdeb02d23d28cd23b39a1b8a1b408b)), closes [#71](https://github.com/Lukazukimo/unibill-backend/issues/71)
* **extraction:** Vault setup for provider API keys + redaction (T-403) ([e4dfcb2](https://github.com/Lukazukimo/unibill-backend/commit/e4dfcb21b3c954bf830a5f453544f41f733b0f86)), closes [#49](https://github.com/Lukazukimo/unibill-backend/issues/49)
* **functions:** AI extraction contract + schema + GeminiProvider (T-412) ([ba55d25](https://github.com/Lukazukimo/unibill-backend/commit/ba55d252369338b3fcd1c6f56d794869090cbec6)), closes [#58](https://github.com/Lukazukimo/unibill-backend/issues/58)
* **functions:** Deterministic confidence formula + status mapper (T-417) ([14b48fe](https://github.com/Lukazukimo/unibill-backend/commit/14b48fe75c2c155e73755bdb54b28e52ec09bbee)), closes [#64](https://github.com/Lukazukimo/unibill-backend/issues/64)
* **functions:** Emit x-correlation-id on the response in withCorrelation (T-316) ([d92b205](https://github.com/Lukazukimo/unibill-backend/commit/d92b20546395dfba92281a2d7e12b9b8f199b36f)), closes [#27](https://github.com/Lukazukimo/unibill-backend/issues/27)
* **functions:** Finish P4 partials — CPF/CNPJ redaction, correlation header, sync_runs RLS (T-315/T-316/T-309) ([a7de43e](https://github.com/Lukazukimo/unibill-backend/commit/a7de43ef8e8ff14d1063809e1c9dbd92d9e79174))
* **functions:** GoogleVisionProvider (fallback OCR provider) (T-408) ([655479b](https://github.com/Lukazukimo/unibill-backend/commit/655479b5206177f3e5b4635fa3bd7cb4e2e4fdcb)), closes [#53](https://github.com/Lukazukimo/unibill-backend/issues/53)
* **functions:** Groq + OpenRouter providers + prompt registry (T-413, T-414) ([2c36536](https://github.com/Lukazukimo/unibill-backend/commit/2c365363fb91ad17c0629aea73820660222b86d0)), closes [#59](https://github.com/Lukazukimo/unibill-backend/issues/59) [#62](https://github.com/Lukazukimo/unibill-backend/issues/62)
* **functions:** Layer 1 — pdfjs native PDF text extraction (T-404) ([eb730cb](https://github.com/Lukazukimo/unibill-backend/commit/eb730cb0d0cb17ed2539dc4990633a44dab3479f)), closes [#50](https://github.com/Lukazukimo/unibill-backend/issues/50)
* **functions:** Layer 2 orchestrator with per-page OCR early-exit (T-410) ([c8eb331](https://github.com/Lukazukimo/unibill-backend/commit/c8eb3319e8a4b63190715e50ebb73b1454c82fa7)), closes [#56](https://github.com/Lukazukimo/unibill-backend/issues/56)
* **functions:** Layer 3 — regex per-utility field extraction (T-411) ([d846c56](https://github.com/Lukazukimo/unibill-backend/commit/d846c567da4876f8207b42e2f6fb554a9817eaf4)), closes [#57](https://github.com/Lukazukimo/unibill-backend/issues/57)
* **functions:** OCR provider contract + classifyOcrError (T-406) ([398acf8](https://github.com/Lukazukimo/unibill-backend/commit/398acf86af12164e17fdc9df382d97093e015335)), closes [#52](https://github.com/Lukazukimo/unibill-backend/issues/52)
* **functions:** OcrClient — provider chain + breaker + rate limit + ai_calls (T-409) ([3e79059](https://github.com/Lukazukimo/unibill-backend/commit/3e790595d9758ece2592d05ee4e91272f129fbca)), closes [#55](https://github.com/Lukazukimo/unibill-backend/issues/55)
* **functions:** OcrSpaceProvider (primary OCR provider) (T-407) ([6f5e946](https://github.com/Lukazukimo/unibill-backend/commit/6f5e946e3365630850c3ccb04dfd8c669fdd469c)), closes [#54](https://github.com/Lukazukimo/unibill-backend/issues/54)
* **functions:** PDF page splitter for the OCR layer (T-405) ([cda633f](https://github.com/Lukazukimo/unibill-backend/commit/cda633f0c31fb83606770fb2e518ffb221802053)), closes [#51](https://github.com/Lukazukimo/unibill-backend/issues/51)
* P5 Slice A — extraction foundation (ai_calls + confidence formula) [T-401/T-417] ([5a8f83c](https://github.com/Lukazukimo/unibill-backend/commit/5a8f83ceca24e08a6a74e858eac147a77db1cf96))
* P5 Slice B — deterministic extraction layers (pdfjs / page-split / regex) [T-404/T-405/T-411] ([6a6af8b](https://github.com/Lukazukimo/unibill-backend/commit/6a6af8b7521f146399e16f07e8d95bfc577a2ae5))
* P5 Slice C1 — OCR providers (contract + OCR.space + Google Vision) [T-406/T-407/T-408] ([95e215d](https://github.com/Lukazukimo/unibill-backend/commit/95e215d874739b50646e16972a74f9d0f9d6abbd))
* P5 Slice C2 — OCR chain + Layer 2 orchestrator (early-exit) [T-409/T-410] ([8f5fe21](https://github.com/Lukazukimo/unibill-backend/commit/8f5fe21431557122bda23ac60117fa679059e2e7))
* P5 Slice D1 — AI extraction providers (Gemini + Groq + OpenRouter + prompt registry) [T-412/T-413/T-414] ([6d0fe64](https://github.com/Lukazukimo/unibill-backend/commit/6d0fe643a28118681978b8b1076ae7e258fd9f32))


### Bug Fixes

* **ci:** Auth-hibp — skip hosted-only HIBP on the local stack; closes [#213](https://github.com/Lukazukimo/unibill-backend/issues/213) (T-226) ([7b4b635](https://github.com/Lukazukimo/unibill-backend/commit/7b4b635f76565ff6bd455aacb109e8241e1bf5dd))
* **ci:** Auth-hibp — skip the hosted-only HIBP cases on the local stack (T-226) ([0fb5e0e](https://github.com/Lukazukimo/unibill-backend/commit/0fb5e0eae6b7372cd5fea04cae63f767f35a30cf)), closes [#213](https://github.com/Lukazukimo/unibill-backend/issues/213)
* **extraction:** Preserve PDF bytes across Layer 1 (pdfjs detaches the buffer) ([04c5b7f](https://github.com/Lukazukimo/unibill-backend/commit/04c5b7ffafb955444cb693f430c9a4eae49eaa0a)), closes [#65](https://github.com/Lukazukimo/unibill-backend/issues/65)


### Tests

* **db:** Add the 4 missing P4 test suites (T-330, T-331, T-332, T-334) ([ab994b3](https://github.com/Lukazukimo/unibill-backend/commit/ab994b3be630ba1a5a5555233c9d5536512e138f)), closes [#41](https://github.com/Lukazukimo/unibill-backend/issues/41) [#43](https://github.com/Lukazukimo/unibill-backend/issues/43) [#45](https://github.com/Lukazukimo/unibill-backend/issues/45) [#42](https://github.com/Lukazukimo/unibill-backend/issues/42) [#213](https://github.com/Lukazukimo/unibill-backend/issues/213)
* **db:** Add the 4 missing P4 test suites (T-330/T-331/T-332/T-334) ([289d111](https://github.com/Lukazukimo/unibill-backend/commit/289d111be9caf286fe8d12ccdfbdf68c12376704))
* **db:** Cross-binding sync_runs RLS coverage (T-309) ([fabfb90](https://github.com/Lukazukimo/unibill-backend/commit/fabfb90a0171b6043c876841ce6ead8480d48da2)), closes [#17](https://github.com/Lukazukimo/unibill-backend/issues/17)
* **extraction:** Consolidated §7.5.1 failure→status spec table ([e6f4157](https://github.com/Lukazukimo/unibill-backend/commit/e6f415792f4bf5c1533594cef08e2df0cbe3d39e)), closes [#73](https://github.com/Lukazukimo/unibill-backend/issues/73)
* **extraction:** End-to-end extraction-worker integration suite ([0a33b8e](https://github.com/Lukazukimo/unibill-backend/commit/0a33b8ec807c1ab6287ad826737e693e2b1bac4d)), closes [#65](https://github.com/Lukazukimo/unibill-backend/issues/65) [#72](https://github.com/Lukazukimo/unibill-backend/issues/72)
* **extraction:** P5 slice E3b — end-to-end integration suite ([eda6f56](https://github.com/Lukazukimo/unibill-backend/commit/eda6f5655e517ed94addcc8f3eb453329efac102))
* **extraction:** P5 slice F3 — consolidated classifyError §7.5.1 table ([7bd317e](https://github.com/Lukazukimo/unibill-backend/commit/7bd317edb1eb5c84c8c7218daed5e8c5aec9f0b3))
* **resilience:** PgTAP for the circuit_breakers state machine ([922118c](https://github.com/Lukazukimo/unibill-backend/commit/922118c35d8304aeca4509569ff4449bcc2899ca)), closes [#70](https://github.com/Lukazukimo/unibill-backend/issues/70)
* **resilience:** PgTAP for the circuit_breakers state machine (T-423) ([a7a65df](https://github.com/Lukazukimo/unibill-backend/commit/a7a65df433b0a62a2ee7cb42444048f8012d45db))


### CI / Tooling

* **extraction:** Deploy-time AI provider smoke test ([b7790df](https://github.com/Lukazukimo/unibill-backend/commit/b7790df7d2a844aa795fed4fb397046889277616)), closes [#66](https://github.com/Lukazukimo/unibill-backend/issues/66)
* **extraction:** P5 slice F4 — deploy-time AI provider smoke test ([13a4b78](https://github.com/Lukazukimo/unibill-backend/commit/13a4b782680ab4a7f375cbcb7695d4a193e0dec6))


### Documentation

* **extraction:** Extraction pipeline + chain breaker operations runbook ([63d773b](https://github.com/Lukazukimo/unibill-backend/commit/63d773b29aebec68fbe413772c57fc6ebab03243)), closes [#76](https://github.com/Lukazukimo/unibill-backend/issues/76)
* **extraction:** P5 slice F5 — extraction pipeline runbook ([b4e0ebd](https://github.com/Lukazukimo/unibill-backend/commit/b4e0ebdb2d70c863b6162f85db88696d8596819e))

## [0.1.4](https://github.com/Lukazukimo/unibill-backend/compare/v0.1.3...v0.1.4) (2026-06-23)


### Features

* **db:** App.ingest_invoice transactional outbox for invoice capture (T-326) ([859869e](https://github.com/Lukazukimo/unibill-backend/commit/859869e14e0f02da3e942ceb89df8e0897227918))
* **db:** Invoices + invoice_categories schema with PIX/boleto/dedupe (T-301, T-302, T-303) ([8d5ba93](https://github.com/Lukazukimo/unibill-backend/commit/8d5ba93e8c6279fa49f57f4578f976d2afafe361))
* **db:** P4 ingestion schema — parsers, events, runs, queues, RLS, cron (T-304..T-314) ([a9d144f](https://github.com/Lukazukimo/unibill-backend/commit/a9d144f58dc540548a7b38eb79d0ce54b0ec5770))
* **db:** RLS policies for invoices + invoice_categories (T-309 subset) ([517a6bb](https://github.com/Lukazukimo/unibill-backend/commit/517a6bb2046985b62045aa779a3ae37c8a8e9ca8))
* **functions:** DoImapFetch — real IMAP fetch→capture + runbook (T-326, T-333, T-335) ([5148cfe](https://github.com/Lukazukimo/unibill-backend/commit/5148cfe0cfeb6c5b451e56a31649cf0d7dc62932))
* **functions:** P4 ingestion helpers — household routing, PDF discovery, pgmq access (T-322, T-323) ([f8256e1](https://github.com/Lukazukimo/unibill-backend/commit/f8256e1a0110a9d6343c330edb245fe56780ebdf)), closes [#213](https://github.com/Lukazukimo/unibill-backend/issues/213)
* **functions:** Real P4 ingestion middleware (T-316..T-321) ([446ab00](https://github.com/Lukazukimo/unibill-backend/commit/446ab00fe1081ae776c2152a34b4fba6aa35000b)), closes [#213](https://github.com/Lukazukimo/unibill-backend/issues/213)
* **functions:** Sync-dispatcher Edge Function (T-324) ([e45f4e1](https://github.com/Lukazukimo/unibill-backend/commit/e45f4e107d51825b3328aa7170694ec741ee47fa)), closes [#35](https://github.com/Lukazukimo/unibill-backend/issues/35) [#213](https://github.com/Lukazukimo/unibill-backend/issues/213)
* **functions:** Sync-worker orchestration — loop, claim, DLQ, auto-pause (T-325, T-327) ([3c0c447](https://github.com/Lukazukimo/unibill-backend/commit/3c0c447de4f9d9a3c5bd338e6dad31988a12e373))


### Bug Fixes

* **db:** Break connected_emails RLS recursion, grant base privileges, guard owner takeover ([84c4df4](https://github.com/Lukazukimo/unibill-backend/commit/84c4df4f7cfb8d52555f208fbc837aa08c1997ea)), closes [#213](https://github.com/Lukazukimo/unibill-backend/issues/213)
* **db:** Correct base32 invitation-code CHECK to exclude L (T-227) ([4dcd643](https://github.com/Lukazukimo/unibill-backend/commit/4dcd643392eaa312b7f7fd772b482db264bc02da)), closes [#213](https://github.com/Lukazukimo/unibill-backend/issues/213)
* **db:** Make `supabase db reset` apply migrations on the current CLI ([#213](https://github.com/Lukazukimo/unibill-backend/issues/213)) ([87614c6](https://github.com/Lukazukimo/unibill-backend/commit/87614c6a02cb2b8406ddb67c7cc2b51a983658b6))
* **test:** Lift data-modifying CTEs to top level in pgTAP RLS suite ([215b67b](https://github.com/Lukazukimo/unibill-backend/commit/215b67bc5f111d9de1122f189d13c39a33c984e3))


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
