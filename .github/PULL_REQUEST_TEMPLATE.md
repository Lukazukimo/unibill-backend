<!-- PR Template — fill out each section. Delete sections that don't apply. -->

## Summary

<!-- 1–3 bullets describing what changed and why -->

-
-

## Tasks implemented / closed

<!-- Use `Closes #N` for issues this PR resolves (auto-closes on merge).
     Use `Refs #N` for related issues that aren't fully closed by this PR. -->

Closes #
Refs

## Test plan

<!-- Checklist of validations the reviewer should expect to pass.
     Mark [x] before merge. -->

- [ ] CI green (lint + migration-lint + pgTAP + Deno tests)
- [ ] New migrations roll forward cleanly on `supabase db reset`
- [ ] RLS tests added for any new table with PII
- [ ] No secrets in code or logs (`redactSecrets()` helper used where relevant)
- [ ] Manual smoke test if Edge Function (curl / dev script result documented below)

## Screenshots / output

<!-- If UI / CLI output / dashboard changes, paste relevant before/after -->

## Notes for reviewer

<!-- Anything reviewer should pay extra attention to: tricky decisions,
     known limitations, follow-up issues already filed. -->

---

<sub>Branch naming: `tipo/T-XYZ-descricao` · Commit style: [Conventional Commits](https://www.conventionalcommits.org/) · One task per PR · See [CONTRIBUTING.md](../CONTRIBUTING.md)</sub>
