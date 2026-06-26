#!/usr/bin/env -S deno run --allow-read --allow-write
// =============================================================================
// scripts/gen_configuration_doc.ts
// -----------------------------------------------------------------------------
// Regenerate `docs/configuration.md` from the source-of-truth seed
// `supabase/seeds/app_settings_defaults.sql`. Parses every
// `INSERT INTO public.app_settings (...)` row into {key, category, value,
// description} and renders a markdown table grouped by category (namespace),
// spliced between the `<!-- BEGIN-GENERATED:config -->` /
// `<!-- END-GENERATED:config -->` markers (static prologue/epilogue preserved).
//
// File-based — NO database needed (unlike gen_data_dictionary.ts), so it runs
// in the no-DB CI job. Mirrors that script's CLI: --check (CI drift, exit 1 on
// diff), --seed, --out.
//
// Task:      T-624 (#134). Spec refs: §B (Appendix B — configs).
// Date:      2026-06-25
// =============================================================================

export interface ConfigRow {
  key: string;
  category: string;
  value: string;
  description: string;
}

// One INSERT row: key, jsonb_build_object('v', <value>), category, description,
// requires_restart. Description may be one or more adjacent SQL string literals.
const ROW_RE =
  /VALUES\s*\(\s*'([^']+)'\s*,\s*'global'\s*,\s*NULL\s*,\s*jsonb_build_object\(\s*'v'\s*,\s*(.+?)\s*\)\s*,\s*'([^']+)'\s*,\s*((?:'(?:[^']|'')*'\s*)+),\s*(?:true|false)\s*\)/gs;

/** Concatenates adjacent SQL string literals and unescapes doubled quotes. */
function parseSqlText(raw: string): string {
  const parts = [...raw.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  return parts.join('');
}

/** Parses every app_settings INSERT in the seed SQL into a ConfigRow. */
export function parseSeedRows(sql: string): ConfigRow[] {
  const rows: ConfigRow[] = [];
  for (const m of sql.matchAll(ROW_RE)) {
    // String values may be multi-literal SQL concatenations ('a' 'b'); use the
    // text parser for those. Non-string values (true/123/jsonb_build_array(...))
    // are kept as their literal SQL expression.
    const rawValue = m[2].trim();
    rows.push({
      key: m[1],
      value: rawValue.startsWith("'") ? parseSqlText(rawValue) : rawValue,
      category: m[3],
      description: parseSqlText(m[4]).trim(),
    });
  }
  return rows;
}

function escapeCell(s: string): string {
  return s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/** Renders the markdown body: one table per category, alphabetical, key-sorted. */
export function renderConfigBody(rows: ConfigRow[]): string {
  const byCategory = new Map<string, ConfigRow[]>();
  for (const r of rows) {
    const list = byCategory.get(r.category) ?? [];
    list.push(r);
    byCategory.set(r.category, list);
  }
  const categories = [...byCategory.keys()].sort();
  const sections = categories.map((cat) => {
    const list = byCategory.get(cat)!.slice().sort((a, b) => a.key.localeCompare(b.key));
    const header = '| Key | Default | Description |\n|---|---|---|';
    const body = list
      .map((r) => `| \`${r.key}\` | \`${escapeCell(r.value)}\` | ${escapeCell(r.description)} |`)
      .join('\n');
    return `### \`${cat}\` (${list.length})\n\n${header}\n${body}\n`;
  });
  return sections.join('\n---\n\n').trimEnd() + '\n';
}

// --- CLI (mirrors gen_data_dictionary.ts) ----------------------------------

interface Args {
  seed: string;
  out: string;
  check: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    seed: 'supabase/seeds/app_settings_defaults.sql',
    out: 'docs/configuration.md',
    check: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seed' && argv[i + 1]) args.seed = argv[++i];
    else if (a === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (a === '--check') args.check = true;
    else if (a === '-h' || a === '--help') {
      console.log('Usage: gen_configuration_doc.ts [--seed <sql>] [--out <md>] [--check]');
      Deno.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      Deno.exit(2);
    }
  }
  return args;
}

const MARKER = 'config';

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
  const sql = await Deno.readTextFile(args.seed);
  const rows = parseSeedRows(sql);
  if (rows.length === 0) {
    console.error(`[gen_configuration_doc] parsed 0 rows from ${args.seed} — aborting.`);
    Deno.exit(3);
  }
  const body = renderConfigBody(rows);
  const existing = await Deno.readTextFile(args.out);
  const next = spliceGenerated(existing, body);

  if (args.check) {
    if (next !== existing) {
      console.error(`[gen_configuration_doc] DIFF in '${args.out}'. Run without --check.`);
      Deno.exit(1);
    }
    console.log(`[gen_configuration_doc] OK — '${args.out}' up to date (${rows.length} keys).`);
    return;
  }
  await Deno.writeTextFile(args.out, next);
  console.log(`[gen_configuration_doc] Wrote '${args.out}' (${rows.length} keys).`);
}

if (import.meta.main) {
  await main();
}
