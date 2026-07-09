// =============================================================================
// admin-system-admins/admins.ts
// -----------------------------------------------------------------------------
// Pure request parsing + reason derivation for the sys-admin admins-management
// endpoint (#295 / T-217). No IO — unit-tested directly.
// =============================================================================

export type AdminAction = 'promote' | 'revoke';

export type ParsedRequest = {
  action: AdminAction;
  userId?: string;
  /** Lowercased login email; exactly one of userId/email is set. */
  email?: string;
  note?: string;
};

export type ParseResult = { value: ParsedRequest } | { error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Deliberately loose: a single @ with non-empty, dot-bearing domain. GoTrue /
// the resolver are the source of truth for existence; this only rejects junk.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NOTE = 500;

export function parseRequest(raw: unknown): ParseResult {
  if (typeof raw !== 'object' || raw === null) {
    return { error: 'body must be a JSON object' };
  }
  const body = raw as Record<string, unknown>;

  const action = body.action;
  if (action !== 'promote' && action !== 'revoke') {
    return { error: 'action must be "promote" or "revoke"' };
  }

  const hasUserId = body.user_id !== undefined && body.user_id !== null;
  const hasEmail = body.email !== undefined && body.email !== null;
  if (hasUserId === hasEmail) {
    return { error: 'provide exactly one of user_id or email' };
  }

  let userId: string | undefined;
  let email: string | undefined;
  if (hasUserId) {
    if (typeof body.user_id !== 'string' || !UUID_RE.test(body.user_id)) {
      return { error: 'user_id must be a uuid' };
    }
    userId = body.user_id;
  } else {
    if (typeof body.email !== 'string' || !EMAIL_RE.test(body.email.trim())) {
      return { error: 'email must be a valid email address' };
    }
    email = body.email.trim().toLowerCase();
  }

  let note: string | undefined;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string' || body.note.length > MAX_NOTE) {
      return { error: `note must be a string of at most ${MAX_NOTE} chars` };
    }
    note = body.note;
  }

  return { value: { action, userId, email, note } };
}

/** Server-derived audit reason (never client-supplied — prevents spoofing). */
export function deriveReason(
  action: AdminAction,
  targetId: string,
  callerId: string,
): string {
  if (action === 'promote') return 'peer_promotion';
  return targetId === callerId ? 'self_revoke' : 'peer_revocation';
}
