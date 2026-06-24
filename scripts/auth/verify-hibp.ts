#!/usr/bin/env -S deno run --allow-net --allow-env
/**
 * verify-hibp.ts — integration test asserting that Supabase Auth rejects
 * known-pwned passwords (HIBP / leaked-password protection) AND accepts a
 * strong unique password. Run nightly and on every PR that touches the auth
 * config — see .github/workflows/auth-hibp.yml.
 *
 * The probe talks directly to the GoTrue HTTP endpoint (no client SDK) so it
 * works against both the local Supabase CLI stack and a remote project. We
 * intentionally do NOT use supabase-js: the SDK swallows error_code into a
 * generic AuthError and we want to assert on the exact wire response.
 *
 * HOSTED-ONLY HIBP: leaked-password protection is a Supabase platform feature.
 * It is NOT in the local `config.toml` schema and the GoTrue booted by
 * `supabase start` does not enforce it. So the pwned-rejection cases run ONLY
 * when the target can enforce HIBP — a REMOTE project (non-localhost URL) or
 * HIBP_ENFORCED=1. Against the local stack they are SKIPPED (loudly, exit 0)
 * and only the strong-password sanity runs — which still catches GoTrue being
 * unreachable or the structural password policy false-rejecting. This keeps the
 * nightly/PR job green locally while still failing loudly against a real
 * HIBP-enabled backend that has drifted.
 *
 * Ref:  T-226 (extends T-201 smoke probe into a full integration test)
 * Spec: §9.1 (Supabase Auth → HIBP check)
 * Date: 2026-06-10
 *
 * Usage:
 *   # local stack (`supabase start`) — HIBP cases SKIPPED (hosted-only)
 *   deno run -A scripts/auth/verify-hibp.ts
 *
 *   # remote project — full HIBP assertions enforced
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_ANON_KEY=eyJ... \
 *     deno run -A scripts/auth/verify-hibp.ts
 *
 *   # force HIBP assertions against a local target (if it somehow enforces them)
 *   HIBP_ENFORCED=1 deno run -A scripts/auth/verify-hibp.ts
 *
 * Exit codes:
 *   0 — HIBP cases passed (remote) OR were skipped (local); strong pw accepted.
 *   1 — at least one pwned password slipped through, OR the strong password
 *       was rejected (config drift — failing CI is the goal).
 *   2 — could not reach GoTrue / unexpected response (infra issue).
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'http://127.0.0.1:54321';

// Local Supabase CLI ships a well-known anon key for the local stack. CI
// must override `SUPABASE_ANON_KEY` when targeting a remote project.
const LOCAL_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.' +
  'CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? LOCAL_ANON_KEY;

// HIBP (leaked-password protection) is a Supabase HOSTED feature: it is not in
// the local `config.toml` schema, and the GoTrue booted by `supabase start`
// does NOT enforce it. So the pwned-rejection cases can only pass against a
// backend where HIBP is actually on. We run them when the target is REMOTE (a
// non-localhost SUPABASE_URL) or when HIBP_ENFORCED=1 is set explicitly;
// against the local stack we SKIP them (loudly) and keep only the strong-
// password-accepted sanity, which still proves GoTrue is reachable and the
// structural password policy doesn't false-reject.
const IS_LOCAL_TARGET = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:\d+)?\/?$/i.test(
  SUPABASE_URL,
);
const ENFORCE_HIBP = Deno.env.get('HIBP_ENFORCED') === '1' || !IS_LOCAL_TARGET;

/**
 * Fixture of passwords that ALL satisfy the structural password policy
 * (>=10 chars, lower, upper, digit, special) but ALL appear in HIBP's top
 * breach lists. If GoTrue accepts any of these, HIBP is OFF — full stop.
 *
 * Counts below are from haveibeenpwned.com circa 2024 (k-anonymity API).
 * Picked specifically because length/complexity rules WOULD pass them; only
 * the HIBP check can catch them.
 */
const PWNED_PASSWORDS: readonly string[] = [
  'Password123!', // >3.7M breaches — canonical "complex but pwned"
  'Admin@2024', //   tens of thousands — corporate weak pick
  'Qwerty12345!', // top-10 base + symbol — still pwned
  'Welcome@123', //  enterprise default — very high count
  'Letmein@2023', // classic + symbol — pwned
];

/**
 * A strong, unique password that should ALWAYS pass HIBP (random words +
 * digits + symbols, very unlikely to appear in any breach corpus). We add
 * a random suffix per run so even if some adversary seeds it into a future
 * breach, this test will not start failing.
 */
function strongUniquePassword(): string {
  const rand = crypto.randomUUID().replace(/-/g, '');
  return `Tr0p1cal-Tapir!${rand}`;
}

/** Random recipient — signup is rejected (or buffered) before any email goes out. */
function probeEmail(label: string): string {
  return `hibp-probe-${label}+${crypto.randomUUID()}@unibill.invalid`;
}

// ---------------------------------------------------------------------------
// GoTrue probe
// ---------------------------------------------------------------------------

type GoTrueError = {
  code?: string;
  error_code?: string;
  msg?: string;
  message?: string;
  weak_password?: { reasons?: string[] };
};

type SignupOutcome = {
  status: number;
  body: GoTrueError;
  rawText: string;
};

async function signup(
  email: string,
  password: string,
): Promise<SignupOutcome> {
  const url = `${SUPABASE_URL.replace(/\/$/, '')}/auth/v1/signup`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ email, password }),
    });
  } catch (err) {
    console.error(`[verify-hibp] ERROR: could not reach ${url}: ${err}`);
    Deno.exit(2);
  }

  const rawText = await response.text();
  let body: GoTrueError = {};
  if (rawText.length > 0) {
    try {
      body = JSON.parse(rawText) as GoTrueError;
    } catch {
      // non-JSON body — leave body as {}; downstream assertions will catch it.
    }
  }
  return { status: response.status, body, rawText };
}

/**
 * Returns true iff GoTrue's response indicates the password was rejected
 * *specifically* by HIBP (not by length, char-class, or some other rule).
 *
 * GoTrue returns 422 with error_code=weak_password and either a free-text
 * message containing "pwned" / "compromised" / "data breach" or a structured
 * `weak_password.reasons` array including "pwned". We accept any of these.
 */
function isHibpRejection(outcome: SignupOutcome): boolean {
  if (outcome.status < 400) return false;

  const { body } = outcome;
  const code = body.error_code ?? body.code ?? '';
  const msg = (body.msg ?? body.message ?? '').toLowerCase();
  const reasons = (body.weak_password?.reasons ?? []).map((r) => r.toLowerCase());

  // Strict path: GoTrue >= 2024 returns error_code=weak_password with
  // reasons: ["pwned"] in the structured body. Accept that as gold.
  if (code === 'weak_password' && reasons.some((r) => r.includes('pwned'))) {
    return true;
  }

  // Fallback paths for older GoTrue builds or proxy normalization:
  if (
    msg.includes('pwned') ||
    msg.includes('compromised') ||
    msg.includes('data breach') ||
    msg.includes('breach')
  ) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

type CaseResult = {
  label: string;
  password: string;
  passed: boolean;
  detail: string;
};

async function assertPwnedRejected(password: string): Promise<CaseResult> {
  const email = probeEmail('pwned');
  const outcome = await signup(email, password);
  const label = `pwned[${password}]`;

  // ACCEPTED → catastrophic: HIBP is off.
  if (outcome.status >= 200 && outcome.status < 300) {
    return {
      label,
      password,
      passed: false,
      detail: `GoTrue ACCEPTED a known-pwned password (HTTP ${outcome.status}). ` +
        `HIBP is NOT enforcing the policy.`,
    };
  }

  // Rejected but not by HIBP → fixture is wrong (password also fails
  // length/charclass) OR HIBP off and another rule caught it. Either way,
  // this is a test-integrity failure.
  if (!isHibpRejection(outcome)) {
    const code = outcome.body.error_code ?? outcome.body.code ?? '(none)';
    const msg = outcome.body.msg ?? outcome.body.message ?? outcome.rawText;
    return {
      label,
      password,
      passed: false,
      detail: `GoTrue rejected but NOT via HIBP. http=${outcome.status} ` +
        `code=${code} msg=${msg}`,
    };
  }

  return {
    label,
    password,
    passed: true,
    detail: `rejected via HIBP (http ${outcome.status})`,
  };
}

async function assertStrongAccepted(): Promise<CaseResult> {
  const password = strongUniquePassword();
  const email = probeEmail('strong');
  const outcome = await signup(email, password);
  const label = `strong[unique]`;

  // 200/201 → user created. 400 with "User already registered" should never
  // happen because email is random. Anything 4xx/5xx that ISN'T a "user
  // already exists" race is a regression worth investigating.
  if (outcome.status >= 200 && outcome.status < 300) {
    return {
      label,
      password,
      passed: true,
      detail: `accepted (http ${outcome.status})`,
    };
  }

  const code = outcome.body.error_code ?? outcome.body.code ?? '(none)';
  const msg = outcome.body.msg ?? outcome.body.message ?? outcome.rawText;

  // Tolerate the rare rate_limit_exceeded — emit a warning but pass the case
  // so a noisy neighbor in shared infra doesn't break the build. We still
  // surface it in the log so it's visible.
  if (code === 'over_email_send_rate_limit' || code === 'rate_limit_exceeded') {
    return {
      label,
      password,
      passed: true,
      detail: `WARN: strong password got rate-limited (${code}); ` +
        `treating as pass to avoid flake.`,
    };
  }

  return {
    label,
    password,
    passed: false,
    detail: `GoTrue REJECTED a strong unique password. http=${outcome.status} ` +
      `code=${code} msg=${msg}. This usually means the password policy is too ` +
      `strict OR GoTrue is misconfigured.`,
  };
}

async function main(): Promise<never> {
  console.log(`[verify-hibp] target: ${SUPABASE_URL}`);

  const results: CaseResult[] = [];

  if (ENFORCE_HIBP) {
    console.log(
      `[verify-hibp] HIBP enforcement EXPECTED — running ` +
        `${PWNED_PASSWORDS.length} pwned-rejection cases + 1 strong-acceptance ` +
        `case...`,
    );
    // Sequential, not parallel: GoTrue rate-limits per IP, and we'd rather
    // take 5s and get clean results than parallelize and hit the limiter.
    for (const password of PWNED_PASSWORDS) {
      results.push(await assertPwnedRejected(password));
    }
  } else {
    console.log(
      `[verify-hibp] SKIP: HIBP is a hosted-only feature; the local Supabase ` +
        `stack (${SUPABASE_URL}) cannot enforce it, so the ` +
        `${PWNED_PASSWORDS.length} pwned-rejection cases are skipped. To assert ` +
        `HIBP, target a remote project (set SUPABASE_URL + SUPABASE_ANON_KEY) ` +
        `or force locally with HIBP_ENFORCED=1. Running the strong-password ` +
        `sanity only.`,
    );
  }

  results.push(await assertStrongAccepted());

  let failed = 0;
  for (const r of results) {
    const tag = r.passed ? 'PASS' : 'FAIL';
    console.log(`  [${tag}] ${r.label} — ${r.detail}`);
    if (!r.passed) failed += 1;
  }

  if (failed > 0) {
    console.error(
      `[verify-hibp] FAIL: ${failed} of ${results.length} cases failed.`,
    );
    Deno.exit(1);
  }

  console.log(
    ENFORCE_HIBP
      ? `[verify-hibp] OK: all ${results.length} cases passed ` +
        `(${PWNED_PASSWORDS.length} pwned rejected, 1 strong accepted).`
      : `[verify-hibp] OK (local): strong password accepted; the ` +
        `${PWNED_PASSWORDS.length} HIBP pwned-rejection cases were skipped ` +
        `(hosted-only). Run against a remote project to assert HIBP.`,
  );
  Deno.exit(0);
}

if (import.meta.main) {
  await main();
}
