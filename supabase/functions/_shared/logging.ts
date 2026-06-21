/**
 * logging.ts — structured logger for Edge Functions.
 *
 * Ref: T-125, spec §4.2 / §4.2.1
 * Date: 2026-06-10
 *
 * `log.{debug,info,warn,error}(msg, meta?)` writes a JSON line to stdout
 * containing the message, severity, timestamp and any metadata. Callers MUST
 * include `{correlation_id, fn}` in `meta` (and `user_id`/`household_id`
 * when known) so log lines are joinable with DB rows.
 *
 * Ref: T-316 (redaction of msg AND meta), spec §6.5.
 */

import { redactDeep, redactSecrets } from './redact.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogMeta = Record<string, unknown>;

function write(level: LogLevel, msg: string, meta?: LogMeta): void {
  // Redact per-field (msg + every meta value) BEFORE serialization (§6.5).
  // Redacting the serialized blob instead risks matching a secret pattern
  // across JSON delimiters (corrupting fields) or missing secrets hidden by
  // JSON escaping.
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: redactSecrets(msg),
    ...(meta ? redactDeep(meta) : {}),
  };
  const serialized = JSON.stringify(line);
  // Edge runtime captures stdout/stderr — `console.log` is the canonical sink.
  if (level === 'error' || level === 'warn') {
    console.error(serialized);
  } else {
    console.log(serialized);
  }
}

export const log = {
  debug: (msg: string, meta?: LogMeta) => write('debug', msg, meta),
  info: (msg: string, meta?: LogMeta) => write('info', msg, meta),
  warn: (msg: string, meta?: LogMeta) => write('warn', msg, meta),
  error: (msg: string, meta?: LogMeta) => write('error', msg, meta),
} as const;
