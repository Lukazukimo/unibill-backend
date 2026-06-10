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
 * STUB: minimal console-based implementation already works — real impl will
 * add log level filtering via env and redaction via `redact.ts`.
 */

import { redactSecrets } from './redact.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogMeta = Record<string, unknown>;

function write(level: LogLevel, msg: string, meta?: LogMeta): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: redactSecrets(msg),
    ...(meta ?? {}),
  };
  // Edge runtime captures stdout/stderr — `console.log` is the canonical sink.
  if (level === 'error' || level === 'warn') {
    console.error(JSON.stringify(line));
  } else {
    console.log(JSON.stringify(line));
  }
}

export const log = {
  debug: (msg: string, meta?: LogMeta) => write('debug', msg, meta),
  info: (msg: string, meta?: LogMeta) => write('info', msg, meta),
  warn: (msg: string, meta?: LogMeta) => write('warn', msg, meta),
  error: (msg: string, meta?: LogMeta) => write('error', msg, meta),
} as const;
