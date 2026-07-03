#!/usr/bin/env -S deno run --allow-read --allow-write
// =============================================================================
// scripts/gen_dbml.ts
// -----------------------------------------------------------------------------
// Generate `docs/schema.dbml` (DBML — https://dbml.dbdiagram.io) by STATICALLY
// parsing supabase/migrations/*.sql — no live database required (issue #266a).
//
// Scope: every `public.*` table with its columns (name + type) and PRIMARY KEY,
// the `CREATE TYPE ... AS ENUM` enums, and the foreign keys BETWEEN public
// tables. Foreign keys to `auth.*` (Supabase's schema) are intentionally
// omitted: those are audit FKs dropped for LGPD anonymization (see ADR-0004 /
// the anonymize migrations) and reference a table outside this schema.
//
// Mirrors the other generators: --check (CI drift, exit 1 on diff), --out.
// Render `docs/schema.svg` from the DBML with `@softwaretechnik/dbml-renderer`.
// =============================================================================

export type EnumDef = { name: string; values: string[] };
export type Column = { name: string; type: string; pk: boolean };
export type Ref = { col: string; toTable: string; toCol: string };
export type Table = { name: string; columns: Column[]; refs: Ref[] };

/** Strips SQL block comments and `--` line comments (outside string literals). */
function stripSqlComments(sql: string): string {
  const noBlock = sql.replace(/\/\*[\s\S]*?\*\//g, '');
  let out = '';
  let inStr = false;
  for (let i = 0; i < noBlock.length; i++) {
    const ch = noBlock[i];
    if (inStr) {
      out += ch;
      if (ch === "'") inStr = false;
      continue;
    }
    if (ch === "'") {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === '-' && noBlock[i + 1] === '-') {
      while (i < noBlock.length && noBlock[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

/** Splits on `sep` at paren-depth 0, ignoring separators inside string literals. */
export function splitTopLevel(s: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      cur += ch;
      if (ch === "'") inStr = false;
      continue;
    }
    if (ch === "'") {
      inStr = true;
      cur += ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === sep && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Returns the substring inside the parentheses that open at `openIdx`. */
function balancedBody(s: string, openIdx: number): string {
  let depth = 0;
  let inStr = false;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === "'") inStr = false;
      continue;
    }
    if (ch === "'") inStr = true;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return s.slice(openIdx + 1, i);
    }
  }
  return s.slice(openIdx + 1);
}

const unquote = (s: string) => s.replace(/"/g, '').trim();

/** Extracts the first `REFERENCES public.<table>(<col>)`, or null (auth.* skipped). */
function refFromText(text: string): { toTable: string; toCol: string } | null {
  const m = text.match(/REFERENCES\s+([a-z_][a-z0-9_]*\.[a-z0-9_]+)\s*\(\s*([a-z0-9_"]+)\s*\)/i);
  if (m && m[1].toLowerCase().startsWith('public.')) {
    return { toTable: m[1], toCol: unquote(m[2]) };
  }
  return null;
}

/** Parses one comma-separated item inside a CREATE TABLE body. */
function parseItem(
  item: string,
): { column?: Column; ref?: Ref; pkCols?: string[] } {
  const upper = item.toUpperCase();

  if (upper.startsWith('PRIMARY KEY')) {
    const m = item.match(/\(([^)]*)\)/);
    return { pkCols: m ? splitTopLevel(m[1]).map(unquote) : [] };
  }
  if (
    upper.startsWith('FOREIGN KEY') || upper.startsWith('CONSTRAINT') ||
    upper.startsWith('UNIQUE') || upper.startsWith('CHECK') || upper.startsWith('EXCLUDE')
  ) {
    const fk = item.match(/FOREIGN KEY\s*\(\s*([a-z0-9_"]+)\s*\)\s*REFERENCES/i);
    const target = refFromText(item);
    if (fk && target) return { ref: { col: unquote(fk[1]), ...target } };
    return {};
  }

  // Column definition: <name> <type...> <modifiers...>
  const tokens = item.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return {};
  const name = unquote(tokens[0]);

  // The type may span tokens when it carries balanced parens, e.g. numeric(5, 2).
  const typeParts: string[] = [];
  let depth = 0;
  let i = 1;
  for (; i < tokens.length; i++) {
    typeParts.push(tokens[i]);
    depth += (tokens[i].match(/\(/g)?.length ?? 0) - (tokens[i].match(/\)/g)?.length ?? 0);
    if (depth <= 0) {
      i++;
      break;
    }
  }
  const type = typeParts.join(' ');
  const modifiers = tokens.slice(i).join(' ').toUpperCase();

  const pk = /\bPRIMARY\s+KEY\b/.test(modifiers);
  const target = refFromText(item);
  const ref = target ? { col: name, ...target } : undefined;
  return { column: { name, type, pk }, ref };
}

/** Parses `CREATE TYPE <name> AS ENUM (...)` statements. */
export function parseEnums(sql: string): EnumDef[] {
  const clean = stripSqlComments(sql);
  const out: EnumDef[] = [];
  const re = /CREATE\s+TYPE\s+([a-z_][a-z0-9_]*\.[a-z0-9_]+)\s+AS\s+ENUM\s*\(([^)]*)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const values = m[2].split(',').map((v) => v.trim().replace(/^'|'$/g, '')).filter(Boolean);
    out.push({ name: m[1], values });
  }
  return out;
}

/** Parses `CREATE TABLE <name> (...)` statements into tables + refs. */
export function parseTables(sql: string): Table[] {
  const clean = stripSqlComments(sql);
  const out: Table[] = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*\.[a-z0-9_]+)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const name = m[1];
    const body = balancedBody(clean, re.lastIndex - 1);
    const columns: Column[] = [];
    const refs: Ref[] = [];
    const pkCols = new Set<string>();
    for (const item of splitTopLevel(body)) {
      if (!item) continue;
      const parsed = parseItem(item);
      if (parsed.column) columns.push(parsed.column);
      if (parsed.ref) refs.push(parsed.ref);
      parsed.pkCols?.forEach((c) => pkCols.add(c));
    }
    for (const c of columns) if (pkCols.has(c.name)) c.pk = true;
    out.push({ name, columns, refs });
    // `re.lastIndex` stays just past the '('; exec() scans forward for the next
    // CREATE TABLE on its own (it skips over this table's body).
  }
  return out;
}

const qual = (name: string) => name.split('.').map((p) => `"${p}"`).join('.');

/** Renders tables + enums + refs to DBML text. */
export function renderDbml(enums: EnumDef[], tables: Table[]): string {
  const lines: string[] = [];
  for (const e of enums) {
    lines.push(`Enum ${qual(e.name)} {`);
    for (const v of e.values) lines.push(`  "${v}"`);
    lines.push('}', '');
  }
  for (const t of tables) {
    lines.push(`Table ${qual(t.name)} {`);
    for (const c of t.columns) {
      // DBML types are bare identifiers; wrap anything with punctuation in quotes.
      const type = /^[a-z_][a-z0-9_]*$/i.test(c.type) ? c.type : `"${c.type}"`;
      lines.push(`  "${c.name}" ${type}${c.pk ? ' [pk]' : ''}`);
    }
    lines.push('}', '');
  }
  for (const t of tables) {
    for (const r of t.refs) {
      lines.push(`Ref: ${qual(t.name)}."${r.col}" > ${qual(r.toTable)}."${r.toCol}"`);
    }
  }
  return lines.join('\n').trimEnd() + '\n';
}

const HEADER =
  '// Generated by scripts/gen_dbml.ts from supabase/migrations — do not edit by hand.\n' +
  '// Regenerate: deno run --allow-read --allow-write scripts/gen_dbml.ts\n' +
  '// Render SVG: npx @softwaretechnik/dbml-renderer -i docs/schema.dbml -o docs/schema.svg\n\n';

async function readMigrations(dir: string): Promise<string> {
  const files: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (e.isFile && e.name.endsWith('.sql')) files.push(e.name);
  }
  files.sort();
  const parts: string[] = [];
  for (const f of files) parts.push(await Deno.readTextFile(`${dir}/${f}`));
  return parts.join('\n');
}

async function render(dir: string): Promise<string> {
  const sql = await readMigrations(dir);
  const enums = parseEnums(sql);
  const tables = parseTables(sql).sort((a, b) => a.name.localeCompare(b.name));
  enums.sort((a, b) => a.name.localeCompare(b.name));
  return HEADER + renderDbml(enums, tables);
}

async function main(): Promise<void> {
  const argv = Deno.args;
  let out = 'docs/schema.dbml';
  let dir = 'supabase/migrations';
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) out = argv[++i];
    else if (argv[i] === '--migrations' && argv[i + 1]) dir = argv[++i];
    else if (argv[i] === '--check') check = true;
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log('Usage: gen_dbml.ts [--out docs/schema.dbml] [--migrations dir] [--check]');
      Deno.exit(0);
    } else {
      console.error(`Unknown argument: ${argv[i]}`);
      Deno.exit(2);
    }
  }
  const next = await render(dir);
  if (check) {
    let existing = '';
    try {
      existing = await Deno.readTextFile(out);
    } catch {
      console.error(`[gen_dbml] '${out}' missing — run without --check.`);
      Deno.exit(1);
    }
    if (next !== existing) {
      console.error(`[gen_dbml] DIFF in '${out}'. Run without --check to regenerate.`);
      Deno.exit(1);
    }
    console.log(`[gen_dbml] OK — '${out}' up to date.`);
    return;
  }
  await Deno.writeTextFile(out, next);
  const n = (next.match(/^Table /gm) ?? []).length;
  console.log(`[gen_dbml] Wrote '${out}' (${n} tables).`);
}

if (import.meta.main) {
  await main();
}
