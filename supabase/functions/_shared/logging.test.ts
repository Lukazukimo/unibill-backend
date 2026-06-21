import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { log } from './logging.ts';

function capture(level: 'log' | 'error', fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console[level];
  // deno-lint-ignore no-explicit-any
  console[level] = (...args: any[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  try {
    fn();
  } finally {
    console[level] = orig;
  }
  return lines;
}

Deno.test('log.info redacts secrets in the message', () => {
  const lines = capture('log', () => log.info('token eyJabcdefghij.klmnopqrst.uvwxyz12345'));
  assertEquals(lines.length, 1);
  assert(lines[0].includes('[REDACTED_JWT]'));
  // the negative assertion is the one that proves no leak.
  assert(!lines[0].includes('eyJabcdefghij.klmnopqrst.uvwxyz12345'));
});

Deno.test('log.error redacts secrets nested in meta', () => {
  const lines = capture('error', () =>
    log.error('imap failed', {
      correlation_id: 'c',
      app_password: 'abcdefghijklmnop',
    }));
  assertEquals(lines.length, 1);
  assert(lines[0].includes('[REDACTED_APP_PASSWORD]'));
  assert(!lines[0].includes('abcdefghijklmnop'));
  // non-secret meta survives redaction.
  assert(lines[0].includes('"correlation_id":"c"'));
});
