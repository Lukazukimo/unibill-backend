/**
 * captcha.ts — hCaptcha (free tier) server-side verification helper.
 *
 * Ref: T-205, spec §9.1 captcha
 * Date: 2026-06-10
 *
 * Verifies an hCaptcha response token by POSTing to
 * `https://api.hcaptcha.com/siteverify` with the shared secret. The check is
 * gated by `HCAPTCHA_ENABLED` so test suites and local dev can short-circuit
 * without burning quota. Used by the auth-signup-guard and auth-reset-guard
 * Edge Functions when the per-IP rate limit threshold is reached and the UI
 * is required to render the widget.
 *
 * The endpoint contract (see §9.1):
 *   - first N requests/IP/hour: no captcha required
 *   - once the bucket overflows: respond HTTP 429 { error: 'captcha_required' }
 *   - the Flutter UI then surfaces the widget, retries with `captcha_token`
 *   - on retry, this helper verifies the token; non-success → HTTP 429
 *
 * NOTE: the network call is intentionally written without retries — a captcha
 * timeout MUST NOT be silently retried (would let an attacker brute-force by
 * triggering timeouts). On any non-ok response, treat as failure.
 */

/** Endpoint used by hCaptcha's siteverify API (override in tests). */
export const HCAPTCHA_VERIFY_URL = 'https://api.hcaptcha.com/siteverify';

/** Env flag — when 'false', verifyCaptcha() bypasses the network and returns ok. */
export const HCAPTCHA_ENABLED_ENV = 'HCAPTCHA_ENABLED';

/** Env name for the server-side secret (paired with public site key in the app). */
export const HCAPTCHA_SECRET_ENV = 'HCAPTCHA_SECRET';

/** Shape of hCaptcha's JSON response body. Only the fields we read are typed. */
export type HCaptchaApiResponse = {
  success: boolean;
  /** Hostname of the page the token was generated on (we do not enforce). */
  hostname?: string;
  /** Free tier: present when the token was issued for a test site key. */
  credit?: boolean;
  /** Failure-only — codes like 'invalid-input-response', 'timeout-or-duplicate'. */
  'error-codes'?: string[];
};

export type CaptchaVerifyResult =
  | { ok: true; bypassed: boolean }
  | {
    ok: false;
    reason: 'missing_token' | 'missing_secret' | 'rejected' | 'network_error';
    codes?: string[];
  };

/** Reads HCAPTCHA_ENABLED with a safe default ('true' in prod). */
export function captchaEnabled(getEnv: (k: string) => string | undefined = Deno.env.get): boolean {
  const raw = (getEnv(HCAPTCHA_ENABLED_ENV) ?? 'true').toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/**
 * Test-injection seam — callers in `*.test.ts` swap this for a stub that
 * resolves a canned HCaptchaApiResponse without hitting the network.
 */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Verifies an hCaptcha token against the siteverify endpoint.
 *
 * @param token  Response token submitted by the Flutter widget.
 * @param ip     Caller IP (forwarded to hCaptcha for risk scoring).
 * @param deps   Optional overrides for tests (env + fetch).
 */
export async function verifyCaptcha(
  token: string | null | undefined,
  ip: string | null | undefined,
  deps: {
    getEnv?: (k: string) => string | undefined;
    fetchFn?: FetchFn;
  } = {},
): Promise<CaptchaVerifyResult> {
  const getEnv = deps.getEnv ?? Deno.env.get;
  const fetchFn = deps.fetchFn ?? fetch;

  // 1) bypass when explicitly disabled (tests, local dev)
  if (!captchaEnabled(getEnv)) {
    return { ok: true, bypassed: true };
  }

  // 2) presence checks — both client token and server secret are required
  if (!token || token.trim().length === 0) {
    return { ok: false, reason: 'missing_token' };
  }
  const secret = getEnv(HCAPTCHA_SECRET_ENV);
  if (!secret || secret.length === 0) {
    return { ok: false, reason: 'missing_secret' };
  }

  // 3) siteverify call — application/x-www-form-urlencoded per hCaptcha docs
  const body = new URLSearchParams({ secret, response: token });
  if (ip && ip.length > 0) body.set('remoteip', ip);

  let res: Response;
  try {
    res = await fetchFn(HCAPTCHA_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (_e) {
    return { ok: false, reason: 'network_error' };
  }

  if (!res.ok) {
    return { ok: false, reason: 'network_error' };
  }

  let parsed: HCaptchaApiResponse;
  try {
    parsed = (await res.json()) as HCaptchaApiResponse;
  } catch (_e) {
    return { ok: false, reason: 'network_error' };
  }

  if (parsed.success === true) {
    return { ok: true, bypassed: false };
  }
  return { ok: false, reason: 'rejected', codes: parsed['error-codes'] ?? [] };
}

/**
 * Extracts the originating IP from the inbound request headers. Falls back to
 * 'unknown' so the per-IP rate-limit key is still deterministic. Honors:
 *   - x-forwarded-for (left-most entry — first hop before our CDN/edge)
 *   - x-real-ip
 *   - cf-connecting-ip (when fronted by Cloudflare)
 */
export function extractClientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  const cf = req.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  return 'unknown';
}
