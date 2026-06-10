#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env
// =============================================================================
// scripts/gen_data_dictionary.ts
// -----------------------------------------------------------------------------
// Regenerate the markdown data dictionary at `docs/data-dictionary.md` from a
// live Postgres database. Queries `information_schema.columns` and
// `pg_description` (via `pg_class.oid`/`objsubid`) to pull every column's
// type, nullability, default and COMMENT text, then renders a stable
// markdown body between the `<!-- BEGIN-GENERATED:<scope> -->` /
// `<!-- END-GENERATED:<scope> -->` markers. Sections outside the markers
// are preserved verbatim — the static prologue and epilogue authored in
// `docs/data-dictionary.md` survive every regeneration.
//
// Task:      T-126
// Spec refs: §5 (data model), §G (column comment strategy),
//            §5.10 (audit columns are uuid-no-FK), §5.11 (RLS recap).
// Date:      2026-06-10
//
// USAGE
//   deno run --allow-net --allow-read --allow-write --allow-env \
//     scripts/gen_data_dictionary.ts \
//     [--conn <postgres://...>] [--scope p0-p1] [--check] \
//     [--out docs/data-dictionary.md]
//
// FLAGS
//   --conn      Postgres connection string. Default reads from $DATABASE_URL
//               or falls back to the local Supabase dev DSN
//               (postgres://postgres:postgres@127.0.0.1:54322/postgres).
//   --scope     Logical scope (and marker suffix). Default `p0-p1`. The
//               script reads `--scope <name>` and edits the body delimited
//               by `<!-- BEGIN-GENERATED:<name> -->` /
//               `<!-- END-GENERATED:<name> -->`. Each phase owns its own
//               marker pair so phases can be regenerated independently.
//   --check     Do NOT write; render to a buffer and compare against the
//               current on-disk file. Exit 1 on any diff (suitable for CI).
//   --out       Output file path. Default `docs/data-dictionary.md`.
//
// SCOPE-TO-TABLE MAPPING
//   The mapping below tracks which tables belong to each phase so that the
//   generator can render a deterministic, spec-ordered listing. Each phase
//   should append its table list when it ships migrations:
//     p0-p1 : system_actors, households, members, household_invitations,
//             user_profiles, app_settings, app_settings_history, consent_log
//     p2-p3 : connected_emails, connected_email_households
//     p4    : invoices, invoice_categories, utility_parsers
//     p5    : sync_runs, extraction_runs, ai_calls, domain_events
//     ...
//
// DETERMINISM
//   * Tables emit in the order defined in SCOPE_TABLES (spec order).
//   * Columns within a table emit in `information_schema.columns.ordinal_position`.
//   * Types are normalised to their `format_type(atttypid, atttypmod)` text
//     (`uuid`, `text`, `timestamp with time zone`, `public.member_role`,
//     `bigserial` for serials, etc.).
//   * Defaults are trimmed and stripped of redundant `::type` casts only
//     when the cast equals the column type (cosmetic, never semantic).
//   * Markdown tables use a single space pad and `|` separators with no
//     trailing whitespace.
//
// MAIN-LOOP TODO
//   * Wire as an optional CI job (NOT blocking) that invokes
//       deno run --allow-all scripts/gen_data_dictionary.ts --check
//     against `docs/data-dictionary.md` after applying migrations to a
//     throwaway Postgres. Pin the Postgres image to the same minor used by
//     the Supabase CLI to avoid type-name drift.
//   * Once `connected_emails` migrations land, add `'connected_emails'` and
//     `'connected_email_households'` to `SCOPE_TABLES['p2-p3']` and add a
//     new marker pair to `docs/data-dictionary.md`.
// =============================================================================

import { Client } from 'https://deno.land/x/postgres@v0.19.3/mod.ts';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface ColumnRow {
  table_schema: string;
  table_name: string;
  ordinal_position: number;
  column_name: string;
  data_type: string; // format_type-normalised, e.g. "uuid", "public.member_role"
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  description: string | null;
  table_description: string | null;
}

interface CliArgs {
  conn: string;
  scope: string;
  check: boolean;
  out: string;
}

// -----------------------------------------------------------------------------
// Scope-to-table mapping (extend in future phases)
// -----------------------------------------------------------------------------

const SCOPE_TABLES: Record<string, Array<{ schema: string; table: string; specRef: string }>> = {
  'p0-p1': [
    { schema: 'public', table: 'system_actors', specRef: '§5.10' },
    { schema: 'public', table: 'households', specRef: '§5.1' },
    { schema: 'public', table: 'members', specRef: '§5.1' },
    { schema: 'public', table: 'household_invitations', specRef: '§5.1' },
    { schema: 'public', table: 'user_profiles', specRef: '§5.12' },
    { schema: 'public', table: 'app_settings', specRef: '§5.5' },
    { schema: 'public', table: 'app_settings_history', specRef: '§5.5' },
    { schema: 'public', table: 'consent_log', specRef: '§5.9' },
  ],
};

// -----------------------------------------------------------------------------
// CLI parsing
// -----------------------------------------------------------------------------

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    conn:
      Deno.env.get('DATABASE_URL') ??
      'postgres://postgres:postgres@127.0.0.1:54322/postgres',
    scope: 'p0-p1',
    check: false,
    out: 'docs/data-dictionary.md',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--conn' && argv[i + 1]) {
      args.conn = argv[++i];
    } else if (a === '--scope' && argv[i + 1]) {
      args.scope = argv[++i];
    } else if (a === '--out' && argv[i + 1]) {
      args.out = argv[++i];
    } else if (a === '--check') {
      args.check = true;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      Deno.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printHelp();
      Deno.exit(2);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(
    `Usage: deno run --allow-net --allow-read --allow-write --allow-env \\\n` +
      `  scripts/gen_data_dictionary.ts \\\n` +
      `  [--conn <postgres://...>] [--scope p0-p1] [--check] [--out docs/data-dictionary.md]\n\n` +
      `See file header for full documentation.`,
  );
}

// -----------------------------------------------------------------------------
// SQL — single query joining information_schema.columns to pg_description.
// We use format_type so enum types come back as `schema.enum_name`, which
// matches what `\d+` would display and what the CREATE TABLE source used.
// -----------------------------------------------------------------------------

const QUERY = `
WITH wanted (schema_name, table_name) AS (
  SELECT * FROM UNNEST($1::text[], $2::text[])
)
SELECT
  c.table_schema,
  c.table_name,
  c.ordinal_position,
  c.column_name,
  -- format_type honours typmod (varchar(64), numeric(3,2)) and renders
  -- enums as schema.enum_name. atttypid + atttypmod come from pg_attribute.
  format_type(a.atttypid, a.atttypmod) AS data_type,
  c.is_nullable,
  c.column_default,
  pgd.description AS description,
  tabd.description AS table_description
FROM information_schema.columns c
JOIN wanted w
  ON w.schema_name = c.table_schema
 AND w.table_name  = c.table_name
JOIN pg_class cls
  ON cls.relname = c.table_name
JOIN pg_namespace ns
  ON ns.oid = cls.relnamespace
 AND ns.nspname = c.table_schema
JOIN pg_attribute a
  ON a.attrelid = cls.oid
 AND a.attname  = c.column_name
 AND a.attnum > 0
 AND NOT a.attisdropped
LEFT JOIN pg_description pgd
  ON pgd.objoid    = cls.oid
 AND pgd.objsubid  = a.attnum
LEFT JOIN pg_description tabd
  ON tabd.objoid   = cls.oid
 AND tabd.objsubid = 0
ORDER BY
  -- Preserve the user-supplied table order via array_position
  array_position($2::text[], c.table_name),
  c.ordinal_position;
`;

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------

function escapeCell(s: string): string {
  // Markdown table cells: pipes break the row; newlines break rendering.
  // Replace newlines with a single space (comments are written as a single
  // paragraph anyway) and escape the few literal pipes that may appear.
  return s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

function formatDefault(def: string | null, dataType: string): string {
  if (def === null) return '—';
  // Strip a trailing `::<type>` cast when it matches the column type.
  // Cosmetic only — keeps the dictionary readable without changing meaning.
  const m = def.match(/^(.*?)::([\w. ]+)$/);
  if (m && m[2].trim() === dataType.trim()) {
    return `\`${m[1]}\``;
  }
  return `\`${def}\``;
}

function renderColumn(row: ColumnRow): string {
  const nullable = row.is_nullable === 'YES' ? 'yes' : 'no';
  const desc = row.description ? escapeCell(row.description) : '';
  return `| \`${row.column_name}\` | \`${row.data_type}\` | ${nullable} | ${formatDefault(
    row.column_default,
    row.data_type,
  )} | ${desc} |`;
}

function renderTable(
  schema: string,
  table: string,
  specRef: string,
  rows: ColumnRow[],
): string {
  if (rows.length === 0) {
    return (
      `### \`${schema}.${table}\` (spec ${specRef})\n\n` +
      `> **Missing from database.** No columns returned by \`information_schema.columns\`. ` +
      `Either the migrations have not been applied or the table was renamed.\n`
    );
  }
  const tableDesc = rows[0].table_description?.trim();
  const purpose = tableDesc
    ? `**Purpose:** ${escapeCell(tableDesc)}\n\n`
    : `> **Missing \`COMMENT ON TABLE\`** — add one in the next \`add_business_comments_*.sql\` migration.\n\n`;
  const header =
    '| Column | Type | Nullable | Default | Description |\n' +
    '|---|---|---|---|---|';
  const body = rows.map(renderColumn).join('\n');
  return `### \`${schema}.${table}\` (spec ${specRef})\n\n${purpose}${header}\n${body}\n`;
}

function renderBody(
  scope: string,
  rowsByTable: Map<string, ColumnRow[]>,
): string {
  const tables = SCOPE_TABLES[scope];
  if (!tables) {
    throw new Error(
      `Unknown scope '${scope}'. Known scopes: ${Object.keys(SCOPE_TABLES).join(', ')}`,
    );
  }
  const sections = tables.map(({ schema, table, specRef }) => {
    const key = `${schema}.${table}`;
    const rows = rowsByTable.get(key) ?? [];
    return renderTable(schema, table, specRef, rows);
  });
  // Join with the horizontal rule used in the static template so the diff
  // between human-authored baseline and generated output is minimal.
  return sections.join('\n---\n\n').trimEnd() + '\n';
}

// -----------------------------------------------------------------------------
// File splice — preserve everything outside the BEGIN/END markers.
// -----------------------------------------------------------------------------

function spliceGenerated(existing: string, scope: string, body: string): string {
  const begin = `<!-- BEGIN-GENERATED:${scope} -->`;
  const end = `<!-- END-GENERATED:${scope} -->`;
  const beginIdx = existing.indexOf(begin);
  const endIdx = existing.indexOf(end);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new Error(
      `Could not find markers '${begin}' / '${end}' in the output file. ` +
        `Add them to the file before running the generator.`,
    );
  }
  // Keep the markers themselves; replace only the content between them.
  const prologue = existing.slice(0, beginIdx + begin.length);
  const epilogue = existing.slice(endIdx);
  return `${prologue}\n\n${body}\n${epilogue}`;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function fetchColumns(
  conn: string,
  scope: string,
): Promise<Map<string, ColumnRow[]>> {
  const tables = SCOPE_TABLES[scope];
  if (!tables) {
    throw new Error(`Unknown scope '${scope}'.`);
  }
  const schemas = tables.map((t) => t.schema);
  const names = tables.map((t) => t.table);

  const client = new Client(conn);
  await client.connect();
  try {
    const result = await client.queryObject<ColumnRow>({
      text: QUERY,
      args: [schemas, names],
    });
    const byTable = new Map<string, ColumnRow[]>();
    for (const row of result.rows) {
      const key = `${row.table_schema}.${row.table_name}`;
      const list = byTable.get(key) ?? [];
      list.push(row);
      byTable.set(key, list);
    }
    return byTable;
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args);

  let rowsByTable: Map<string, ColumnRow[]>;
  try {
    rowsByTable = await fetchColumns(args.conn, args.scope);
  } catch (err) {
    console.error(`[gen_data_dictionary] DB error: ${(err as Error).message}`);
    Deno.exit(3);
  }

  const body = renderBody(args.scope, rowsByTable);

  let existing: string;
  try {
    existing = await Deno.readTextFile(args.out);
  } catch (err) {
    console.error(
      `[gen_data_dictionary] Cannot read '${args.out}': ${(err as Error).message}\n` +
        `The output file must exist and contain the BEGIN/END markers.`,
    );
    Deno.exit(4);
  }

  const next = spliceGenerated(existing, args.scope, body);

  if (args.check) {
    if (next !== existing) {
      console.error(
        `[gen_data_dictionary] DIFF detected in '${args.out}'. ` +
          `Run without --check to regenerate.`,
      );
      Deno.exit(1);
    }
    console.log(`[gen_data_dictionary] OK — '${args.out}' is up to date.`);
    return;
  }

  await Deno.writeTextFile(args.out, next);
  console.log(
    `[gen_data_dictionary] Wrote '${args.out}' (scope=${args.scope}, ` +
      `${rowsByTable.size} table(s) covered).`,
  );
}

if (import.meta.main) {
  await main();
}
