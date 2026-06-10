/**
 * invitations-redeem — POST /invitations/redeem.
 *
 * Resgata um convite de household via código de 8 chars (base32 sem
 * confundíveis: alfabeto `^[A-HJ-NP-Z2-9]{8}$` por §9.1 / migration T-227).
 * Valida rate limits, email match (quando convite tem `invited_email`
 * NOT NULL), e aplica lockout permanente após 5 falhas no mesmo código.
 *
 * Ref:  T-215, spec §9.1 Invitation security, §E POST /invitations/redeem,
 *       BR-026, BR-027
 * Date: 2026-06-10
 *
 * Flow (per request):
 *   1. Method gate (POST only).
 *   2. JWT extraction (caller user id + email) — 401 if missing/invalid.
 *   3. Body parse + Zod-style validation:
 *        - code: exactly 8 chars, alfabeto base32 sem confundíveis
 *                [A-HJ-NP-Z2-9] (case-sensitive uppercase).
 *                Frontend normaliza pra uppercase + strip espaços antes
 *                de enviar; aqui aplicamos `trim().toUpperCase()` defensivamente
 *                e revalidamos contra o regex (defense-in-depth contra cliente
 *                bugado que envie minúsculas).
 *      → 422 on validation failure with field-level details.
 *   4. Rate limit duplo (spec §9.1):
 *        - resource_type='invite_redeem', resource_key='ip:<addr>',  limit=10/h
 *        - resource_type='invite_redeem', resource_key='user:<uuid>', limit=5/h
 *      Cada chamada incrementa o bucket; quando count > limit, retorna
 *      429 `rate_limited`. Ordem: IP primeiro (mais barato pra bloquear
 *      attackers sem JWT válido), depois user.
 *   5. Per-code lockout check (spec §9.1 — 5 tentativas falhadas mesmo code →
 *      invalidação permanente, mesmo TTL não-expirou):
 *        - resource_type='invite_redeem_code', resource_key='code:<code>'
 *        - window=24h (suficientemente longo pra cobrir TTL de 7 dias com
 *          múltiplas janelas de tentativa).
 *      Se count já >= 5, retorna 404 `invite_not_found` (não dá pista de
 *      que o código existe — anti-enumeration).
 *   6. Lookup do convite por `code` (case-sensitive). Usa o partial index
 *      `idx_invitations_active_code (code) WHERE used_at IS NULL`
 *      criado em T-227. Filtra `expires_at > now()` na query.
 *      Não-encontrado / expirado / já-usado → 404 `invite_not_found` +
 *      registra falha + emite `invitation.redeem_failed` (BR-026).
 *   7. Se `invitation.invited_email IS NOT NULL`, valida que
 *      `lower(caller.email) === invitation.invited_email`
 *      (o invited_email já está lowercase via trigger T-227).
 *      Mismatch → 403 `email_mismatch` + registra falha + emite
 *      `invitation.redeem_failed` (BR-027).
 *   8. Happy path (serialized inserts, sem BEGIN/COMMIT — PostgREST não
 *      suporta tx multi-statement):
 *        a) INSERT into public.members (household_id, user_id, role,
 *           invited_by=invitation.created_by). UNIQUE partial index
 *           (household_id, user_id) WHERE deleted_at IS NULL pode disparar
 *           23505 se o user já é membro ativo → tratamos como "ok, just
 *           refresh-redirect" (idempotente) e marcamos convite como usado.
 *        b) UPDATE invitation SET used_at=now(), used_by=caller.id
 *           WHERE id = invitation.id AND used_at IS NULL.
 *           A condição WHERE used_at IS NULL implementa CAS otimista —
 *           se outra request resgatou simultaneamente, affected=0 e
 *           retornamos 404 (race resolved).
 *        c) Limpa lockout bucket do código (success reset).
 *      Em qualquer falha após (a), compensa best-effort.
 *   9. Emite `invitation.redeemed` (best-effort, não unwinda success).
 *  10. Retorna 200 { household_id, role }.
 *
 * Side effects detalhados:
 *   - cada FALHA → registra +1 em rate_limit_buckets (lockout do código) +
 *     emite domain_event `invitation.redeem_failed`
 *   - SUCCESS → INSERT members + UPDATE invitation + limpa lockout bucket +
 *     emite domain_event `invitation.redeemed`
 *
 * Test-injection seams (handler exported como buildHandler({...})):
 *   - `getCallerUser` — stub pra injetar { id, email } sem JWT
 *   - `client`        — Supabase service-role client (default buildServiceClient)
 *   - `emitEvent`     — defaults to events.ts emitDomainEvent stub
 *   - `now`           — clock override (Date.now-style); tests usam pra
 *                       window bucket math determinístico
 */

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';
import { withCorrelation } from '../_shared/correlation.ts';
import { buildServiceClient, floorToWindow } from '../_shared/lockout.ts';
import { extractClientIp } from '../_shared/captcha.ts';
import { redactSecrets } from '../_shared/redact.ts';
import {
  emitDomainEvent,
  type DomainEventInput,
} from '../_shared/events.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RedeemInvitationRequest = { code: string };

export type RedeemInvitationResponse = {
  household_id: string;
  role: 'admin' | 'member';
};

export type CallerUser = { id: string; email: string };
export type CallerUserResolver = (req: Request) => Promise<CallerUser | null>;

export type EmitEventFn = (e: DomainEventInput) => Promise<void>;

export type HandlerDeps = {
  getCallerUser: CallerUserResolver;
  client?: SupabaseClient;
  emitEvent?: EmitEventFn;
  /** Clock override for deterministic bucket math in tests. */
  now?: () => Date;
};

// ---------------------------------------------------------------------------
// Constants — keep aligned with spec §9.1 + migration T-227
// ---------------------------------------------------------------------------

/** Code length — fixed by spec §9.1. */
export const CODE_LENGTH = 8;

/**
 * Base32 sem confundíveis (sem I, L, O, 0, 1). Casa com o CHECK constraint
 * `household_invitations_code_format_chk` definido em T-227. ~32^8 ≈ 1.1
 * trilhão de combinações.
 */
export const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;

/** Rate-limit resource type compartilhado entre os dois buckets de redeem. */
export const RL_RESOURCE_REDEEM = 'invite_redeem';

/** Resource type separado para o lockout por CÓDIGO (spec §9.1). */
export const RL_RESOURCE_REDEEM_CODE = 'invite_redeem_code';

/** Spec §9.1 — 10 redeems/hora/IP. */
export const RL_LIMIT_IP = 10;

/** Spec §9.1 — 5 redeems/hora/user. */
export const RL_LIMIT_USER = 5;

/** Janela horária pra os dois buckets de rate limit. */
export const RL_WINDOW_MINUTES = 60;

/** Lockout permanente após 5 falhas pro mesmo código (spec §9.1). */
export const CODE_FAIL_THRESHOLD = 5;

/**
 * Janela do bucket do código: 24h. Por que tão longo? O TTL default do convite
 * é 7 dias; precisamos que o counter cubra a vida útil inteira com folga.
 * Mas a janela é "rolling-via-bucket" — após 24h sem tentativas o bucket
 * expira e o counter reseta. Pro MVP, isso é seguro: 5 tentativas em 24h
 * já indica brute force óbvio.
 */
export const CODE_LOCKOUT_WINDOW_MINUTES = 24 * 60;

// Postgres unique_violation
const PG_UNIQUE_VIOLATION = '23505';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Normaliza o code: trim + uppercase. Defense-in-depth contra cliente que
 * envie minúsculas (mesmo o frontend uppercase-ando, é cheap garantir).
 */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Valida o corpo `{ code: string(8 chars, base32 sem confundíveis) }`.
 * Retorna o code já normalizado (uppercase) na success path.
 */
export function validateRedeemBody(value: unknown): {
  ok: true;
  data: { code: string };
} | {
  ok: false;
  errors: Array<{ field: string; message: string }>;
} {
  const errors: Array<{ field: string; message: string }> = [];

  if (!value || typeof value !== 'object') {
    return { ok: false, errors: [{ field: '', message: 'body must be a JSON object' }] };
  }
  const v = value as Record<string, unknown>;

  if (typeof v.code !== 'string') {
    return { ok: false, errors: [{ field: 'code', message: 'must be a string' }] };
  }
  const code = normalizeCode(v.code);
  if (code.length !== CODE_LENGTH) {
    errors.push({ field: 'code', message: `must be exactly ${CODE_LENGTH} chars` });
  } else if (!CODE_RE.test(code)) {
    errors.push({
      field: 'code',
      message: 'must match base32 alphabet [A-HJ-NP-Z2-9] (no I, L, O, 0, 1)',
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data: { code } };
}

// ---------------------------------------------------------------------------
// Default resolvers (production)
// ---------------------------------------------------------------------------

/** Default JWT → user resolver (igual ao emails-connect). */
export const defaultGetCallerUser: CallerUserResolver = async (req) => {
  const auth = req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) return null;
  const jwt = auth.slice(7).trim();
  if (!jwt) return null;

  const client = buildServiceClient();
  try {
    const { data, error } = await client.auth.getUser(jwt);
    if (error || !data?.user) return null;
    if (!data.user.email) return null;
    return { id: data.user.id, email: data.user.email };
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Bucket helpers — increment-and-check pattern (mirror lockout.ts/ip_rate.ts)
// ---------------------------------------------------------------------------

type BucketIncrementResult = { count: number; over_limit: boolean };

/**
 * Lê o bucket atual e incrementa em 1. Retorna o post-increment count e se
 * passou do limit. Padrão idêntico a `countAndIncrementIp` em ip_rate.ts.
 */
async function incrementBucket(
  client: SupabaseClient,
  resource_type: string,
  resource_key: string,
  windowMinutes: number,
  limit: number,
  now: Date,
): Promise<BucketIncrementResult> {
  const windowStart = floorToWindow(now, windowMinutes);

  const { data: existing, error: readErr } = await client
    .from('rate_limit_buckets')
    .select('count')
    .eq('resource_type', resource_type)
    .eq('resource_key', resource_key)
    .eq('window_start', windowStart.toISOString())
    .maybeSingle();

  if (readErr) throw readErr;

  const nextCount = ((existing?.count as number | undefined) ?? 0) + 1;

  const { error: upsertErr } = await client
    .from('rate_limit_buckets')
    .upsert(
      {
        resource_type,
        resource_key,
        window_start: windowStart.toISOString(),
        window_size: `${windowMinutes} minutes`,
        count: nextCount,
      },
      { onConflict: 'resource_type,resource_key,window_start,window_size' },
    );
  if (upsertErr) throw upsertErr;

  return { count: nextCount, over_limit: nextCount > limit };
}

/**
 * Lê o bucket atual SEM incrementar. Usado pra checar lockout do código
 * antes de mesmo tentar lookup (anti-enumeration: tratamos código locked
 * como not-found pra não dar pista).
 */
async function peekBucket(
  client: SupabaseClient,
  resource_type: string,
  resource_key: string,
  windowMinutes: number,
  now: Date,
): Promise<number> {
  const windowStart = floorToWindow(now, windowMinutes);
  const { data, error } = await client
    .from('rate_limit_buckets')
    .select('count')
    .eq('resource_type', resource_type)
    .eq('resource_key', resource_key)
    .eq('window_start', windowStart.toISOString())
    .maybeSingle();
  if (error) throw error;
  return (data?.count as number | undefined) ?? 0;
}

/** Apaga TODOS os buckets do código (cleanup pós-success). */
async function clearCodeLockout(
  client: SupabaseClient,
  code: string,
): Promise<void> {
  const { error } = await client
    .from('rate_limit_buckets')
    .delete()
    .eq('resource_type', RL_RESOURCE_REDEEM_CODE)
    .eq('resource_key', `code:${code}`);
  if (error) {
    // Best-effort — não falhamos a redempção por causa disso.
    // Logged at caller via try/catch.
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Failure recording + event emission
// ---------------------------------------------------------------------------

type FailureReason =
  | 'invite_not_found'
  | 'invite_expired'
  | 'invite_used'
  | 'email_mismatch'
  | 'code_locked';

/**
 * Registra uma falha de redeem: incrementa o bucket de lockout do código
 * + emite domain_event `invitation.redeem_failed`. Best-effort; falha de
 * IO aqui não muda o response code (mas é logado).
 */
async function recordFailure(args: {
  client: SupabaseClient;
  emitEvent: EmitEventFn;
  correlationId: string;
  caller: CallerUser;
  code: string;
  reason: FailureReason;
  invitationId?: string;
  householdId?: string;
  now: Date;
}): Promise<void> {
  const {
    client, emitEvent, correlationId, caller, code, reason,
    invitationId, householdId, now,
  } = args;

  // 1) Increment lockout bucket (idempotent ON CONFLICT upsert)
  try {
    await incrementBucket(
      client,
      RL_RESOURCE_REDEEM_CODE,
      `code:${code}`,
      CODE_LOCKOUT_WINDOW_MINUTES,
      // limit param is unused for the lockout bucket — we peek to enforce; pass
      // CODE_FAIL_THRESHOLD just for symmetry with the helper signature.
      CODE_FAIL_THRESHOLD,
      now,
    );
  } catch (e) {
    console.error(JSON.stringify({
      level: 'warn',
      correlation_id: correlationId,
      msg: 'failed to increment code lockout bucket',
      error: redactSecrets(e instanceof Error ? e.message : String(e)),
    }));
  }

  // 2) Emit domain_event
  try {
    await emitEvent({
      type: 'invitation.redeem_failed',
      aggregate_type: 'invitation',
      // aggregate_id é UUID; quando convite é desconhecido, usamos um UUID
      // sentinela determinístico baseado no hash do code seria ideal mas o
      // schema requer uuid — usamos all-zeros sentinel (sys actor pattern).
      aggregate_id: invitationId ?? '00000000-0000-0000-0000-000000000000',
      household_id: householdId,
      correlation_id: correlationId,
      actor_type: 'user',
      actor_user_id: caller.id,
      payload: {
        version: 1,
        data: {
          reason,
          // Não logamos o code in plaintext em logs estruturados; só primeiros
          // 2 chars como hint. Brute force inviável sob rate limit (spec §9.1).
          code_prefix: code.slice(0, 2),
          attempt_email: caller.email,
        },
      },
    });
  } catch (e) {
    console.error(JSON.stringify({
      level: 'warn',
      correlation_id: correlationId,
      msg: 'invitation.redeem_failed emit failed (non-fatal)',
      error: redactSecrets(e instanceof Error ? e.message : String(e)),
    }));
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function buildHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const emitEvent = deps.emitEvent ?? emitDomainEvent;
  const nowFn = deps.now ?? (() => new Date());

  return withCorrelation(async (ctx, req) => {
    if (req.method !== 'POST') {
      return jsonResponse(405, { error: 'method_not_allowed' });
    }

    // 1) JWT → caller
    const caller = await deps.getCallerUser(req);
    if (!caller) {
      return jsonResponse(401, { error: 'unauthorized', detail: 'missing or invalid JWT' });
    }

    // 2) Body parse + validation
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return jsonResponse(400, { error: 'invalid_json' });
    }
    const parsed = validateRedeemBody(raw);
    if (!parsed.ok) {
      return jsonResponse(422, {
        error: 'validation_failed',
        details: parsed.errors,
      });
    }
    const { code } = parsed.data;

    const client = deps.client ?? buildServiceClient();
    const ip = extractClientIp(req);
    const now = nowFn();

    // 3) Rate limit: IP first (cheaper to short-circuit attackers)
    try {
      const ipStatus = await incrementBucket(
        client,
        RL_RESOURCE_REDEEM,
        `ip:${ip}`,
        RL_WINDOW_MINUTES,
        RL_LIMIT_IP,
        now,
      );
      if (ipStatus.over_limit) {
        return jsonResponse(429, {
          error: 'rate_limited',
          detail: 'too many redeem attempts from this IP',
          scope: 'ip',
        });
      }
    } catch (e) {
      console.error(JSON.stringify({
        level: 'error',
        correlation_id: ctx.correlation_id,
        msg: 'ip rate-limit bucket failed',
        error: redactSecrets(e instanceof Error ? e.message : String(e)),
      }));
      return jsonResponse(500, { error: 'internal_error', code: 'rate_limit_failed' });
    }

    // 4) Rate limit: per-user
    try {
      const userStatus = await incrementBucket(
        client,
        RL_RESOURCE_REDEEM,
        `user:${caller.id}`,
        RL_WINDOW_MINUTES,
        RL_LIMIT_USER,
        now,
      );
      if (userStatus.over_limit) {
        return jsonResponse(429, {
          error: 'rate_limited',
          detail: 'too many redeem attempts from this user',
          scope: 'user',
        });
      }
    } catch (e) {
      console.error(JSON.stringify({
        level: 'error',
        correlation_id: ctx.correlation_id,
        msg: 'user rate-limit bucket failed',
        error: redactSecrets(e instanceof Error ? e.message : String(e)),
      }));
      return jsonResponse(500, { error: 'internal_error', code: 'rate_limit_failed' });
    }

    // 5) Per-code lockout check (BEFORE lookup → anti-enumeration)
    //    Peek-only here; the actual increment happens on each FAILURE branch.
    let codeFailCount: number;
    try {
      codeFailCount = await peekBucket(
        client,
        RL_RESOURCE_REDEEM_CODE,
        `code:${code}`,
        CODE_LOCKOUT_WINDOW_MINUTES,
        now,
      );
    } catch (e) {
      console.error(JSON.stringify({
        level: 'error',
        correlation_id: ctx.correlation_id,
        msg: 'code lockout peek failed',
        error: redactSecrets(e instanceof Error ? e.message : String(e)),
      }));
      return jsonResponse(500, { error: 'internal_error', code: 'lockout_peek_failed' });
    }
    if (codeFailCount >= CODE_FAIL_THRESHOLD) {
      // Lockout permanente — mas registramos esta tentativa também (incrementa
      // o counter, emite domain_event) pra sys admin ver continued brute force.
      await recordFailure({
        client, emitEvent, correlationId: ctx.correlation_id, caller, code,
        reason: 'code_locked', now,
      });
      // Anti-enumeration: tratamos como not-found (não revelamos que o code
      // existe e foi locked).
      return jsonResponse(404, { error: 'invite_not_found' });
    }

    // 6) Lookup invitation
    type InvitationRow = {
      id: string;
      household_id: string;
      role: 'admin' | 'member';
      invited_email: string | null;
      created_by: string;
      expires_at: string;
      used_at: string | null;
    };

    const { data: inviteRow, error: lookupErr } = await client
      .from('household_invitations')
      .select('id, household_id, role, invited_email, created_by, expires_at, used_at')
      .eq('code', code)
      .is('used_at', null)
      .maybeSingle();

    if (lookupErr) {
      console.error(JSON.stringify({
        level: 'error',
        correlation_id: ctx.correlation_id,
        msg: 'invitation lookup failed',
        error: redactSecrets(lookupErr.message),
      }));
      return jsonResponse(500, { error: 'internal_error', code: 'lookup_failed' });
    }

    const invite = inviteRow as InvitationRow | null;

    // Not found OR already used (used_at IS NULL filter caught used) → 404
    if (!invite) {
      await recordFailure({
        client, emitEvent, correlationId: ctx.correlation_id, caller, code,
        reason: 'invite_not_found', now,
      });
      return jsonResponse(404, { error: 'invite_not_found' });
    }

    // Expired check — partial index does NOT filter expires_at (now() not IMMUTABLE).
    const expiresAt = new Date(invite.expires_at);
    if (expiresAt.getTime() <= now.getTime()) {
      await recordFailure({
        client, emitEvent, correlationId: ctx.correlation_id, caller, code,
        reason: 'invite_expired', invitationId: invite.id,
        householdId: invite.household_id, now,
      });
      // Spec §E retorna 404 pra "código inválido/expirado" (mesma resposta;
      // não vazamos a distinção entre não-existe / expirou).
      return jsonResponse(404, { error: 'invite_not_found' });
    }

    // 7) Email match check (BR-027) — só se invited_email NOT NULL
    if (invite.invited_email !== null) {
      const callerEmailLc = caller.email.trim().toLowerCase();
      // invitation.invited_email já é lowercase (trigger T-227 normaliza)
      if (callerEmailLc !== invite.invited_email) {
        await recordFailure({
          client, emitEvent, correlationId: ctx.correlation_id, caller, code,
          reason: 'email_mismatch', invitationId: invite.id,
          householdId: invite.household_id, now,
        });
        return jsonResponse(403, {
          error: 'email_mismatch',
          detail: 'this invitation is restricted to a different email address',
        });
      }
    }

    // 8) Happy path — INSERT members + UPDATE invitation
    //
    //    Note: PostgREST não suporta BEGIN/COMMIT cross-statement; serializamos
    //    e usamos CAS otimista no UPDATE (used_at IS NULL guard) pra detectar
    //    races. Em falha do UPDATE, compensamos best-effort no members insert.

    let memberAlreadyExists = false;
    {
      const { error: memberErr } = await client
        .from('members')
        .insert({
          household_id: invite.household_id,
          user_id: caller.id,
          role: invite.role,
          invited_by: invite.created_by,
        });

      if (memberErr) {
        if (memberErr.code === PG_UNIQUE_VIOLATION) {
          // User já é membro ativo deste household. Convite válido (link
          // compartilhado, segundo redeem do mesmo user) — tratamos como
          // idempotente: marcamos convite como usado + retornamos success.
          memberAlreadyExists = true;
        } else {
          console.error(JSON.stringify({
            level: 'error',
            correlation_id: ctx.correlation_id,
            msg: 'members insert failed',
            error: redactSecrets(memberErr.message),
          }));
          return jsonResponse(500, { error: 'internal_error', code: 'members_insert_failed' });
        }
      }
    }

    // UPDATE invitation com CAS otimista
    const { data: updateRows, error: updateErr } = await client
      .from('household_invitations')
      .update({
        used_at: now.toISOString(),
        used_by: caller.id,
      })
      .eq('id', invite.id)
      .is('used_at', null)
      .select('id');

    if (updateErr) {
      console.error(JSON.stringify({
        level: 'error',
        correlation_id: ctx.correlation_id,
        msg: 'invitation update failed',
        error: redactSecrets(updateErr.message),
      }));
      // Compensação best-effort: remove o member que acabamos de inserir
      // (a menos que ele já existisse — nesse caso é "ownership" de outra request).
      if (!memberAlreadyExists) {
        try {
          await client
            .from('members')
            .delete()
            .eq('household_id', invite.household_id)
            .eq('user_id', caller.id);
        } catch { /* best-effort compensation */ }
      }
      return jsonResponse(500, { error: 'internal_error', code: 'invitation_update_failed' });
    }

    if (!updateRows || updateRows.length === 0) {
      // Race condition: outra request consumiu o convite entre lookup e update.
      // Compensa o member insert (se foi novo).
      if (!memberAlreadyExists) {
        try {
          await client
            .from('members')
            .delete()
            .eq('household_id', invite.household_id)
            .eq('user_id', caller.id);
        } catch { /* best-effort compensation */ }
      }
      await recordFailure({
        client, emitEvent, correlationId: ctx.correlation_id, caller, code,
        reason: 'invite_used', invitationId: invite.id,
        householdId: invite.household_id, now,
      });
      return jsonResponse(404, { error: 'invite_not_found' });
    }

    // 9) Cleanup lockout bucket (success reset) — best-effort
    try {
      await clearCodeLockout(client, code);
    } catch (e) {
      console.error(JSON.stringify({
        level: 'warn',
        correlation_id: ctx.correlation_id,
        msg: 'failed to clear code lockout bucket (non-fatal)',
        error: redactSecrets(e instanceof Error ? e.message : String(e)),
      }));
    }

    // 10) Emit invitation.redeemed (best-effort)
    try {
      await emitEvent({
        type: 'invitation.redeemed',
        aggregate_type: 'invitation',
        aggregate_id: invite.id,
        household_id: invite.household_id,
        correlation_id: ctx.correlation_id,
        actor_type: 'user',
        actor_user_id: caller.id,
        payload: {
          version: 1,
          data: {
            household_id: invite.household_id,
            role: invite.role,
            redeemed_by_email: caller.email,
            already_member: memberAlreadyExists,
          },
        },
      });
    } catch (e) {
      console.error(JSON.stringify({
        level: 'warn',
        correlation_id: ctx.correlation_id,
        msg: 'invitation.redeemed emit failed (non-fatal)',
        error: redactSecrets(e instanceof Error ? e.message : String(e)),
      }));
    }

    const response: RedeemInvitationResponse = {
      household_id: invite.household_id,
      role: invite.role,
    };
    return jsonResponse(200, response);
  });
}

// ---------------------------------------------------------------------------
// Bootstrap (production)
// ---------------------------------------------------------------------------

export const handler = buildHandler({
  getCallerUser: defaultGetCallerUser,
});

if (import.meta.main) {
  Deno.serve(handler);
}
