# Supabase Auth configuration (Unibill MVP)

**Ref:** T-201
**Spec:** §9.1 (Supabase Auth)
**Last updated:** 2026-06-10

This document is the single source of truth for the Supabase Auth (GoTrue)
configuration used by Unibill. Every knob below has a counterpart in
[`supabase/config.toml`](../config.toml) (local stack) AND must be mirrored
in the Supabase Cloud dashboard for the production project. Drift between
the two is treated as a security defect — open a ticket.

## TL;DR

| Concern              | Value                                              | Where enforced                   |
| -------------------- | -------------------------------------------------- | -------------------------------- |
| Email signup         | enabled, **mandatory confirmation**                | GoTrue                           |
| Magic link           | enabled (alternative to password)                  | GoTrue                           |
| Password reset link  | 1 hour TTL                                         | GoTrue (`otp_expiry`)            |
| Access-token (JWT)   | 1 hour                                             | GoTrue (`jwt_expiry`)            |
| Refresh-token        | 1 week, **rotation on every refresh**              | GoTrue                           |
| Password length      | >= 10 chars                                        | GoTrue (`password_min_length`)   |
| Password classes     | lower + upper + digit + special                    | GoTrue (`password_required_characters`) |
| HIBP check           | **enabled** (`GOTRUE_PASSWORD_HIBP_ENABLED=true`)  | GoTrue                           |
| Signups / IP / hour  | 5                                                  | GoTrue                           |
| Pwd resets / IP / hr | 10                                                 | GoTrue                           |
| OTP / email / hour   | 5                                                  | GoTrue                           |
| Login lockout        | 10 fails / 30 min → 1 h block + unlock email       | Edge Function (T-204)            |
| hCaptcha             | triggered on signup + reset when rate-limited      | Edge Function (T-205)            |
| Invitation redeem    | 10/h/IP + 5/h/user, lock after 5 fails             | Edge Function (T-227)            |

## 1. Authentication methods

- **Email + password** with mandatory confirmation. The user cannot sign in
  until they click the confirmation link.
- **Magic link** as an alternative to password — useful for password
  recovery and for users who refuse to store a long passphrase.
- Social providers are **not** in MVP scope (see roadmap).

## 2. Password policy

| Setting                        | Value                              |
| ------------------------------ | ---------------------------------- |
| `password_min_length`          | `10`                               |
| `password_required_characters` | `lower:upper:digit:special` (4 classes) |
| `password_hibp_enabled`        | `true`                             |

### HIBP (HaveIBeenPwned)

Supabase GoTrue ships a built-in HIBP integration. When
`password_hibp_enabled = true`:

1. The user's password is SHA-1 hashed on the GoTrue server.
2. Only the **first 5 hex chars** of the hash are sent to
   `api.pwnedpasswords.com/range/<5char>`.
3. The remote returns ~500 partial hashes; GoTrue checks locally if the
   user's full hash is in the list.
4. If matched, GoTrue rejects the signup / password change with
   `weak_password` (HTTP 422).

The user's plaintext password never leaves the server, and HIBP itself
never learns which password was checked (k-anonymity).

The smoke test in [`scripts/auth/verify-hibp.ts`](../../scripts/auth/verify-hibp.ts)
proves that the configuration is live by attempting to register a
known-pwned password (`Password123!`) and asserting the rejection. CI must
run this script after any auth-config change.

## 3. Session policy

- **Access token (JWT):** 1 hour (`jwt_expiry = 3600`). Short-lived to
  reduce the window of impact of a stolen access token.
- **Refresh token:** 1 week (`refresh_token_expiry = 604800`).
- **Rotation:** `refresh_token_rotation_enabled = true`. Every successful
  refresh issues a new refresh token AND invalidates the previous one.
  A reuse attempt (two clients pointing at the same refresh token) revokes
  the family — the user is logged out on all devices. This is the GoTrue
  default behavior when rotation is on; we rely on it.

## 4. Rate limits (GoTrue-native)

The values below land in `[auth.rate_limit]` in `config.toml` and in the
Supabase Cloud dashboard:

| Setting                      | Value | Source spec |
| ---------------------------- | ----- | ----------- |
| Signups / hour / IP          | 5     | §9.1        |
| Password resets / hour / IP  | 10    | §9.1        |
| OTP sends / hour / email     | 5     | §9.1        |

> **Note.** GoTrue 2024+ surfaces these limits under different field
> names depending on the CLI version (`sign_in_sign_ups`, `email_sent`,
> etc). The values are correct; the field names are the canonical CLI
> mapping for these spec items.

## 5. Rate limits + lockout enforced outside GoTrue

GoTrue does not natively support per-email failed-login lockout windows or
hCaptcha challenges, so we implement those in Edge Function middleware
(`supabase/functions/_shared/rate_limit.ts` + bucket table from T-104).

| Limit                                | Where               | Task   |
| ------------------------------------ | ------------------- | ------ |
| 10 failed logins / 30 min / email    | login middleware    | T-204  |
| hCaptcha on signup / reset           | signup/reset fn     | T-205  |
| 10 invite redeems / h / IP           | invite redeem fn    | T-227  |
| 5 invite redeems / h / user          | invite redeem fn    | T-227  |
| 5 wrong invite codes → permanent lock| invite redeem fn    | T-227  |

## 6. Deep links (Android-first)

Site URL and redirect URLs match the Android app's custom URL scheme. See
spec §9.1 "Deep links + redirect URLs" for the full rationale.

```
Site URL:        unibill://
Redirect URLs:   unibill://auth/callback
                 unibill://auth/recovery
                 unibill://auth/magic-link
```

Web redirect (`https://app.unibill.dev/auth/callback`) is intentionally
omitted from MVP and will be added in T-203's follow-up when the domain
is provisioned.

## 7. Email templates

The pt-BR templates for `confirmation`, `recovery`, `magic_link`, `invite`,
and `email_change` are owned by **T-202** and live in
`supabase/auth/templates/`. They are applied to the linked project via
`scripts/auth/apply-templates.sh`.

## 8. How to update

1. Edit `supabase/config.toml` for the LOCAL stack.
2. Edit THIS README so the table at the top stays accurate.
3. Mirror the change in the **Supabase Cloud dashboard** for staging and
   production projects — there is no `supabase push` for auth config.
4. Re-run `deno run -A scripts/auth/verify-hibp.ts` (locally and in CI)
   to prove HIBP is still rejecting `Password123!`.
5. Commit with `Refs: T-201` (or the follow-up task that drove the change).

## 9. Threat model coverage

| Threat                                 | Control                                |
| -------------------------------------- | -------------------------------------- |
| Credential stuffing (leaked passwords) | HIBP block at signup + password change |
| Brute force on a single account        | Login lockout (T-204) + captcha (T-205)|
| Spam signups from a single IP          | 5/h/IP GoTrue limit + captcha          |
| Stolen refresh token                   | 1-week TTL + rotation invalidates fam. |
| Stolen access token                    | 1-hour TTL                             |
| Compromised inbox → email change       | `double_confirm_changes = true`        |
| Phishing of password-reset link        | 1-hour TTL on reset link               |

Anything outside this table is either out of MVP scope (e.g. WebAuthn,
device binding) or covered by an adjacent task (RLS, audit log, etc.).
