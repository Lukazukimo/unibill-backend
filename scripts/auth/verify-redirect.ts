#!/usr/bin/env -S deno run --allow-net --allow-env
/**
 * verify-redirect.ts — proves that Supabase Auth (GoTrue) is configured to
 * issue password-recovery / magic-link emails whose action URL points at the
 * `unibill://` custom URL scheme, NOT at the default GoTrue HTML page.
 *
 * Ref:  T-203
 * Spec: §9.1 (Supabase Auth → Deep links + redirect URLs)
 * Date: 2026-06-10
 *
 * What this does:
 *   1. POST /auth/v1/recover with a throwaway email address and an explicit
 *      `redirect_to=unibill://auth/recovery` — GoTrue MUST honour the
 *      redirect because it is in `additional_redirect_urls` (supabase/
 *      config.toml). If it is not whitelisted, GoTrue silently falls back to
 *      `site_url` and the test fails (assertion below).
 *   2. Read the rendered email via Inbucket — the SMTP sink that `supabase
 *      start` provisions on port 54324. The recovery email contains an
 *      `ActionLink` whose target SHOULD start with `unibill://auth/recovery`.
 *   3. Assert the prefix; exit 0 on match, 1 on mismatch, 2 on infra error.
 *
 * Usage:
 *   # against the local Supabase stack started by `supabase start`
 *   deno run -A scripts/auth/verify-redirect.ts
 *
 *   # against a remote project — Inbucket is local-only, so this script
 *   # currently only works against the local stack. Future TODO: hit the
 *   # admin /admin/generate_link endpoint with the service role key when
 *   # SUPABASE_SERVICE_ROLE_KEY is set, so this can run against a staging
 *   # project as well.
 *
 * Exit codes:
 *   0 — recovery email link starts with `unibill://auth/recovery`.
 *   1 — link uses a different scheme (config drift — failing CI is the goal).
 *   2 — could not reach GoTrue / Inbucket, or unexpected response shape.
 *
 * TODO(main loop): wire this into the CI workflow as a required step that
 * runs after `supabase start` boots the local stack — see acceptance for
 * T-203 (redirect URL smoke test).
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SUPABASE_URL =
  Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";

// Inbucket is the SMTP sink baked into the Supabase CLI local stack.
// Default port is 54324 and it exposes a JSON HTTP API at /api/v1.
const INBUCKET_URL =
  Deno.env.get("INBUCKET_URL") ?? "http://127.0.0.1:54324";

// Local Supabase CLI ships a well-known anon key for the local stack. CI
// must override `SUPABASE_ANON_KEY` when targeting a remote project.
const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9." +
  "CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const SUPABASE_ANON_KEY =
  Deno.env.get("SUPABASE_ANON_KEY") ?? LOCAL_ANON_KEY;

// Per spec §9.1 — every recovery email MUST deep-link the mobile app.
const EXPECTED_REDIRECT_PREFIX = "unibill://auth/recovery";

// Random recipient so each CI run is independent. Inbucket accepts any
// address; the mailbox name is the local part of the email.
const TEST_LOCAL_PART = `redirect-probe-${crypto.randomUUID()}`;
const TEST_EMAIL = `${TEST_LOCAL_PART}@unibill.invalid`;

// How long to wait for Inbucket to materialize the email (GoTrue dispatches
// asynchronously). Keep small so CI fails fast on real issues.
const INBUCKET_POLL_MS = 500;
const INBUCKET_POLL_ATTEMPTS = 20; // 10s total budget

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type InbucketMessageSummary = {
  id: string;
  from: { address: string };
  subject: string;
  date: string;
};

type InbucketMessageDetail = {
  id: string;
  subject: string;
  body: { text: string; html: string };
};

async function postRecover(): Promise<void> {
  const url = `${SUPABASE_URL.replace(/\/$/, "")}/auth/v1/recover`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        email: TEST_EMAIL,
        // Explicit redirect: GoTrue only honours this if it is in
        // `additional_redirect_urls` — which is the whole point of the
        // test. If the URL is not whitelisted, GoTrue silently substitutes
        // `site_url` and the email link will start with `unibill://`
        // (the site URL) instead of `unibill://auth/recovery`.
        redirect_to: EXPECTED_REDIRECT_PREFIX,
      }),
    });
  } catch (err) {
    console.error(`[verify-redirect] ERROR: could not reach ${url}: ${err}`);
    Deno.exit(2);
  }

  // GoTrue intentionally returns 200 even for unknown emails to avoid
  // enumeration. Any non-2xx is an infra problem.
  if (response.status < 200 || response.status >= 300) {
    const bodyText = await response.text().catch(() => "(unreadable)");
    console.error(
      `[verify-redirect] ERROR: GoTrue /recover returned HTTP ` +
        `${response.status} for ${TEST_EMAIL}: ${bodyText}`,
    );
    Deno.exit(2);
  }
}

async function waitForRecoveryEmail(): Promise<InbucketMessageDetail> {
  const listUrl =
    `${INBUCKET_URL.replace(/\/$/, "")}/api/v1/mailbox/${TEST_LOCAL_PART}`;

  for (let attempt = 0; attempt < INBUCKET_POLL_ATTEMPTS; attempt++) {
    let listResp: Response;
    try {
      listResp = await fetch(listUrl);
    } catch (err) {
      console.error(
        `[verify-redirect] ERROR: could not reach Inbucket at ${listUrl}: ${err}`,
      );
      Deno.exit(2);
    }

    if (listResp.status === 200) {
      const summaries = (await listResp.json()) as InbucketMessageSummary[];
      if (summaries.length > 0) {
        // Newest first — Inbucket sorts ascending, take the last.
        const newest = summaries[summaries.length - 1];
        const detailUrl =
          `${INBUCKET_URL.replace(/\/$/, "")}` +
          `/api/v1/mailbox/${TEST_LOCAL_PART}/${newest.id}`;
        const detailResp = await fetch(detailUrl);
        if (detailResp.status !== 200) {
          console.error(
            `[verify-redirect] ERROR: Inbucket returned HTTP ` +
              `${detailResp.status} fetching message ${newest.id}`,
          );
          Deno.exit(2);
        }
        return (await detailResp.json()) as InbucketMessageDetail;
      }
    }

    await new Promise((r) => setTimeout(r, INBUCKET_POLL_MS));
  }

  console.error(
    `[verify-redirect] ERROR: no recovery email arrived in mailbox ` +
      `${TEST_LOCAL_PART} after ${INBUCKET_POLL_MS * INBUCKET_POLL_ATTEMPTS}ms.`,
  );
  console.error(
    `  hint: is the Supabase stack running? \`supabase status\` should ` +
      `show Inbucket on ${INBUCKET_URL}.`,
  );
  Deno.exit(2);
}

function extractActionLink(message: InbucketMessageDetail): string | null {
  // GoTrue's default recovery template renders the link both in plain text
  // and inside an <a href="..."> tag. Search both so the assertion is
  // robust against template tweaks (T-202).
  const body = `${message.body.text}\n${message.body.html}`;

  // Match an href first (HTML), then any bare URL with the unibill scheme.
  const hrefMatch = body.match(/href=["']([^"']+)["']/i);
  if (hrefMatch?.[1]) return hrefMatch[1];

  const bareMatch = body.match(/unibill:\/\/\S+/);
  if (bareMatch?.[0]) return bareMatch[0];

  // Fall back to any http(s) link — that would be a FAIL but the caller
  // needs the URL to render a useful error message.
  const httpMatch = body.match(/https?:\/\/\S+/);
  return httpMatch?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await postRecover();
  const message = await waitForRecoveryEmail();
  const link = extractActionLink(message);

  if (!link) {
    console.error(
      `[verify-redirect] FAIL: recovery email contains no action link.`,
    );
    console.error(`  subject: ${message.subject}`);
    console.error(`  body[:200]: ${message.body.text.slice(0, 200)}`);
    Deno.exit(1);
  }

  if (!link.startsWith(EXPECTED_REDIRECT_PREFIX)) {
    console.error(
      `[verify-redirect] FAIL: recovery link does not use the ` +
        `${EXPECTED_REDIRECT_PREFIX} scheme.`,
    );
    console.error(`  expected_prefix: ${EXPECTED_REDIRECT_PREFIX}`);
    console.error(`  actual_link:     ${link}`);
    console.error(
      `  hint: is \`unibill://auth/recovery\` listed in ` +
        `supabase/config.toml under [auth].additional_redirect_urls?`,
    );
    Deno.exit(1);
  }

  console.log(
    `[verify-redirect] OK: recovery email link starts with ` +
      `${EXPECTED_REDIRECT_PREFIX} (${link.slice(0, 80)}...).`,
  );
  Deno.exit(0);
}

if (import.meta.main) {
  await main();
}
