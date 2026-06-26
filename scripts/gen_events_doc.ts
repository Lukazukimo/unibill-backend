#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
// =============================================================================
// scripts/gen_events_doc.ts
// -----------------------------------------------------------------------------
// Regenerate `docs/events.md` from two sources of truth:
//   (1) the domain-event `type: '...'` literals emitted across
//       `supabase/functions/` (grep of emit calls), and
//   (2) the Business Rules catalog (spec §F) — the BR-* table.
// Renders both as markdown, spliced between the
// `<!-- BEGIN-GENERATED:events -->` / `<!-- END-GENERATED:events -->` markers.
//
// File-based (no DB). Mirrors gen_data_dictionary.ts CLI: --check / --out.
// Task: T-624 (#134). Spec refs: §F (business rules), §6.5 (events).
// Date: 2026-06-25
// =============================================================================

export interface EmittedEvent {
  type: string;
  files: string[];
}

export interface BusinessRule {
  id: string;
  domain: string;
  trigger: string;
  effect: string;
  events: string;
}

// `type: 'foo.bar'` with a dotted, lowercase event name (≥ 2 segments).
const TYPE_RE = /\btype:\s*'([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)'/g;

/** Extracts distinct emitted event types and the files that emit each. */
export function parseEmittedEventTypes(
  files: Array<{ path: string; text: string }>,
): EmittedEvent[] {
  const byType = new Map<string, Set<string>>();
  for (const { path, text } of files) {
    for (const m of text.matchAll(TYPE_RE)) {
      const set = byType.get(m[1]) ?? new Set<string>();
      set.add(path);
      byType.set(m[1], set);
    }
  }
  return [...byType.keys()].sort().map((type) => ({
    type,
    files: [...byType.get(type)!].sort(),
  }));
}

function cell(s: string): string {
  return s.replace(/`/g, '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/** Parses the spec §F Business Rules table (rows beginning `| BR-NNN |`). */
export function parseBusinessRules(specMd: string): BusinessRule[] {
  const rules: BusinessRule[] = [];
  for (const line of specMd.split('\n')) {
    if (!/^\|\s*BR-\d+\s*\|/.test(line)) continue;
    const parts = line.split('|').map((p) => p.trim());
    // parts: ['', id, domain, trigger, condicao, efeito, configs, eventos, '']
    rules.push({
      id: cell(parts[1] ?? ''),
      domain: cell(parts[2] ?? ''),
      trigger: cell(parts[3] ?? ''),
      effect: cell(parts[5] ?? ''),
      events: cell(parts[7] ?? ''),
    });
  }
  return rules;
}

export function renderEventsBody(events: EmittedEvent[], rules: BusinessRule[]): string {
  const emitted = events.length === 0
    ? '_None found._'
    : '| Event type | Emitted by |\n|---|---|\n' +
      events
        .map((e) =>
          `| \`${e.type}\` | ${
            e.files.map((f) => `\`${f.replace('supabase/functions/', '')}\``).join(', ')
          } |`
        )
        .join('\n');

  const brTable = rules.length === 0
    ? '_None found._'
    : '| ID | Domínio | Trigger | Efeito | Eventos |\n|---|---|---|---|---|\n' +
      rules
        .map((r) => `| ${r.id} | ${r.domain} | ${r.trigger} | ${r.effect} | ${r.events} |`)
        .join('\n');

  return [
    `## Domain events emitted (from \`supabase/functions/\`)`,
    '',
    `${events.length} distinct event type(s), grepped from \`emitDomainEvent\` / \`emitEvent\` call sites.`,
    '',
    emitted,
    '',
    '---',
    '',
    `## Business rules (spec §F)`,
    '',
    `${rules.length} rule(s). The full condition/configs columns live in spec Appendix F.`,
    '',
    brTable,
    '',
  ].join('\n');
}

// --- CLI --------------------------------------------------------------------

interface Args {
  functions: string;
  spec: string;
  out: string;
  check: boolean;
}

function defaultSpecPath(): string {
  return new URL('../docs/superpowers/specs/2026-06-08-unibill-mvp-design.md', import.meta.url)
    .pathname;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    functions: 'supabase/functions',
    spec: Deno.env.get('UNIBILL_SPEC_PATH') ?? defaultSpecPath(),
    out: 'docs/events.md',
    check: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--functions' && argv[i + 1]) args.functions = argv[++i];
    else if (a === '--spec' && argv[i + 1]) args.spec = argv[++i];
    else if (a === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (a === '--check') args.check = true;
    else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: gen_events_doc.ts [--functions <dir>] [--spec <md>] [--out <md>] [--check]',
      );
      Deno.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      Deno.exit(2);
    }
  }
  return args;
}

async function* walkTs(root: string): AsyncGenerator<string> {
  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(root);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
  for await (const entry of entries) {
    const full = `${root}/${entry.name}`;
    if (entry.isDirectory) yield* walkTs(full);
    else if (entry.isFile && entry.name.endsWith('.ts')) yield full;
  }
}

const MARKER = 'events';

function spliceGenerated(existing: string, body: string): string {
  const begin = `<!-- BEGIN-GENERATED:${MARKER} -->`;
  const end = `<!-- END-GENERATED:${MARKER} -->`;
  const b = existing.indexOf(begin);
  const e = existing.indexOf(end);
  if (b === -1 || e === -1 || e < b) {
    throw new Error(`Markers '${begin}' / '${end}' not found in output file.`);
  }
  return `${existing.slice(0, b + begin.length)}\n\n${body}\n${existing.slice(e)}`;
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args);

  const files: Array<{ path: string; text: string }> = [];
  for await (const path of walkTs(args.functions)) {
    if (path.endsWith('.test.ts')) continue; // tests reference types but don't emit
    files.push({ path, text: await Deno.readTextFile(path) });
  }
  const events = parseEmittedEventTypes(files);
  const rules = parseBusinessRules(await Deno.readTextFile(args.spec));
  const body = renderEventsBody(events, rules);

  const existing = await Deno.readTextFile(args.out);
  const next = spliceGenerated(existing, body);

  if (args.check) {
    if (next !== existing) {
      console.error(`[gen_events_doc] DIFF in '${args.out}'. Run without --check.`);
      Deno.exit(1);
    }
    console.log(
      `[gen_events_doc] OK — '${args.out}' up to date (${events.length} events, ${rules.length} rules).`,
    );
    return;
  }
  await Deno.writeTextFile(args.out, next);
  console.log(
    `[gen_events_doc] Wrote '${args.out}' (${events.length} events, ${rules.length} rules).`,
  );
}

if (import.meta.main) {
  await main();
}
