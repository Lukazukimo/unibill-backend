#!/usr/bin/env -S deno run --allow-read
// =============================================================================
// scripts/lint_migrations.ts
// -----------------------------------------------------------------------------
// Structural-invariant linter for Supabase SQL migrations under
// `supabase/migrations/`. Replaces the legacy `scripts/lint_migrations.sh`
// (filename-only check) with a richer, Deno-based implementation.
//
// Task:      T-124
// Spec refs: §5.10 (sentinel actors — no audit FK to auth.users),
//            §5.11 (RLS helpers live in `app`, never `auth`),
//            §11.1 (branch strategy: CI gate before merge to main)
// Date:      2026-06-10
//
// Invariants enforced (per T-124 acceptance criteria):
//   1. Filename convention: ^[0-9]{14}_[a-z0-9_]+\.sql$ (legacy 14-zero
//      bootstrap `00000000000001_*.sql` is grandfathered in).
//   2. No duplicate timestamp prefixes across files (would silently shuffle
//      apply order across machines).
//   3. Every migration starts with a structured header comment block carrying:
//        * Migration:  <filename>
//        * Task:       T-XXX
//        * Purpose:    <free text>
//        * Spec refs:  <section list>
//      Missing any of the four required markers is a FAIL.
//   4. No CREATE statements target the `auth.` schema (helpers must live in
//      `app.`). Comment-only references (e.g. doc lines) are ignored.
//   5. Every `CREATE TABLE [IF NOT EXISTS] <schema>?.<name>` in the file is
//      matched by a `COMMENT ON TABLE` for the same qualified name, OR by a
//      `-- TODO: comment` marker referencing that table. Missing comment +
//      no TODO = FAIL.
//   6. Any line containing `REFERENCES auth.users` must either:
//        a. Carry an inline `-- AUDIT-FK-OK: <reason>` comment, OR
//        b. Be preceded (within the prior 3 non-blank lines) by such a
//           comment annotation.
//      Otherwise the linter emits a WARNING (non-fatal by default).
//      Pass `--strict-audit-fk` to promote warnings to errors.
//
// Exit codes:
//   0 — all checks passed (warnings allowed unless --strict-audit-fk).
//   1 — one or more errors found.
//
// CLI flags:
//   --dir <path>           Override migrations directory
//                          (default: supabase/migrations).
//   --strict-audit-fk      Treat AUDIT-FK warnings as errors.
//   --json                 Emit machine-readable JSON report on stdout
//                          instead of human text. Exit code still reflects
//                          severity.
//
// Notes for main loop:
//   TODO(main-loop): update `.github/workflows/ci.yml` job `migration-lint`
//   to invoke this .ts version instead of `bash scripts/lint_migrations.sh`,
//   e.g. `deno run --allow-read scripts/lint_migrations.ts`. The legacy
//   shell script is kept until the workflow flip lands.
// =============================================================================

const FILENAME_PATTERN = /^[0-9]{14}_[a-z0-9_]+\.sql$/;
// Bootstrap migration created in T-105 — pre-dates the timestamp convention.
const GRANDFATHERED_FILENAMES = new Set<string>([
  "00000000000001_create_app_schema.sql",
]);

interface Finding {
  level: "error" | "warning";
  file: string;
  line: number; // 1-based; 0 when not line-specific
  rule: string;
  message: string;
}

interface Args {
  dir: string;
  strictAuditFk: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  let dir = Deno.env.get("MIGRATIONS_DIR") ?? "supabase/migrations";
  let strictAuditFk = false;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") {
      const v = argv[i + 1];
      if (!v) throw new Error("--dir requires a value");
      dir = v;
      i++;
    } else if (a === "--strict-audit-fk") {
      strictAuditFk = true;
    } else if (a === "--json") {
      json = true;
    } else if (a === "-h" || a === "--help") {
      printHelp();
      Deno.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return { dir, strictAuditFk, json };
}

function printHelp(): void {
  console.log(
    [
      "Usage: deno run --allow-read scripts/lint_migrations.ts [flags]",
      "",
      "Flags:",
      "  --dir <path>         Migrations directory (default: supabase/migrations)",
      "  --strict-audit-fk    Promote AUDIT-FK warnings to errors",
      "  --json               Emit JSON report instead of human text",
      "  -h, --help           Show this help",
    ].join("\n"),
  );
}

// -----------------------------------------------------------------------------
// File discovery
// -----------------------------------------------------------------------------
async function listMigrationFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".sql")) {
        files.push(entry.name);
      }
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      // No migrations dir yet — caller treats as a clean pass (mirrors bash).
      return [];
    }
    throw err;
  }
  files.sort();
  return files;
}

// -----------------------------------------------------------------------------
// SQL stripping helpers
// -----------------------------------------------------------------------------
// Returns the SQL portion of a line with the `-- ...` trailing comment removed
// (does NOT attempt to parse string literals — sufficient for these lints).
function stripLineComment(line: string): string {
  const idx = line.indexOf("--");
  return idx >= 0 ? line.slice(0, idx) : line;
}

// Strips block comments (/* ... */) across a multi-line buffer. Used for the
// CREATE-statement scan so that doc blocks don't fool the regex.
function stripBlockComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "");
}

// -----------------------------------------------------------------------------
// Rule 1+2: filename + duplicate-prefix detection
// -----------------------------------------------------------------------------
function checkFilenames(files: string[]): Finding[] {
  const findings: Finding[] = [];
  const prefixToFiles = new Map<string, string[]>();

  for (const name of files) {
    if (GRANDFATHERED_FILENAMES.has(name)) {
      // Still record prefix so a real duplicate would still be detected.
      const prefix = name.split("_")[0];
      const arr = prefixToFiles.get(prefix) ?? [];
      arr.push(name);
      prefixToFiles.set(prefix, arr);
      continue;
    }

    if (!FILENAME_PATTERN.test(name)) {
      findings.push({
        level: "error",
        file: name,
        line: 0,
        rule: "filename-convention",
        message:
          "filename violates convention ^[0-9]{14}_[a-z0-9_]+\\.sql$ " +
          "(example: 20260615120100_create_households.sql)",
      });
      continue;
    }

    const prefix = name.slice(0, 14);
    const arr = prefixToFiles.get(prefix) ?? [];
    arr.push(name);
    prefixToFiles.set(prefix, arr);
  }

  for (const [prefix, names] of prefixToFiles) {
    if (names.length > 1) {
      findings.push({
        level: "error",
        file: names.join(", "),
        line: 0,
        rule: "duplicate-prefix",
        message:
          `multiple migrations share timestamp prefix '${prefix}' — ` +
          `apply order is non-deterministic`,
      });
    }
  }
  return findings;
}

// -----------------------------------------------------------------------------
// Rule 3: header block
// -----------------------------------------------------------------------------
const HEADER_REQUIRED = [
  { marker: /^--\s*Migration:/i, name: "Migration:" },
  { marker: /^--\s*Task:\s*T-\d+/i, name: "Task: T-XXX" },
  { marker: /^--\s*Purpose:/i, name: "Purpose:" },
  { marker: /^--\s*Spec refs:/i, name: "Spec refs:" },
];

function checkHeader(file: string, lines: string[]): Finding[] {
  const findings: Finding[] = [];
  // Scan the first 40 lines for the header markers — generous to allow
  // longer separator banners while still failing fast on bodiless files.
  const window = lines.slice(0, 40);
  const present = new Set<string>();

  for (const line of window) {
    for (const { marker, name } of HEADER_REQUIRED) {
      if (marker.test(line.trim())) present.add(name);
    }
  }
  const missing = HEADER_REQUIRED
    .map((h) => h.name)
    .filter((n) => !present.has(n));

  if (missing.length > 0) {
    findings.push({
      level: "error",
      file,
      line: 1,
      rule: "header-block",
      message: `header comment block missing required field(s): ${
        missing.join(", ")
      }`,
    });
  }
  return findings;
}

// -----------------------------------------------------------------------------
// Rule 4: no CREATE in auth.*
// -----------------------------------------------------------------------------
// Detects when a CREATE statement TARGETS the `auth.` schema. The target schema
// appears in different positions depending on the CREATE kind, so we use one
// pattern per kind instead of a single greedy `[^;]*?\bauth\.` which would also
// flag legitimate `auth.uid()` calls inside `USING`/`WITH CHECK` clauses of
// policies targeting `public.*` tables.
//
// Covered kinds (target schema position shown with «auth»):
//   CREATE [OR REPLACE] [MATERIALIZED] VIEW «auth».name
//   CREATE TABLE [IF NOT EXISTS] «auth».name
//   CREATE [OR REPLACE] FUNCTION «auth».name
//   CREATE TYPE «auth».name
//   CREATE SEQUENCE «auth».name
//   CREATE [UNIQUE] INDEX [name] ON «auth».table
//   CREATE [OR REPLACE] TRIGGER name ... ON «auth».table
//   CREATE POLICY name ON «auth».table
//   CREATE SCHEMA «auth»
const CREATE_AUTH_PATTERNS: RegExp[] = [
  // Direct schema-prefixed targets: CREATE [OR REPLACE] <kind> [IF NOT EXISTS] auth.X
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?auth\./i,
  /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?auth\./i,
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+auth\./i,
  /\bCREATE\s+TYPE\s+auth\./i,
  /\bCREATE\s+SEQUENCE\s+(?:IF\s+NOT\s+EXISTS\s+)?auth\./i,
  // Table-attached targets: CREATE ... ON auth.table
  /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:[a-zA-Z_][\w]*\s+)?ON\s+auth\./i,
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+[a-zA-Z_][\w]*\s+(?:BEFORE|AFTER|INSTEAD\s+OF)[^;]*?\bON\s+auth\./i,
  /\bCREATE\s+POLICY\s+[a-zA-Z_][\w]*\s+ON\s+auth\./i,
  // Schema creation itself
  /\bCREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?auth\b/i,
];

function checkNoAuthCreates(file: string, body: string): Finding[] {
  const findings: Finding[] = [];
  const sanitized = stripBlockComments(body)
    .split("\n")
    .map((l, idx) => ({ idx, sql: stripLineComment(l) }))
    .filter(({ sql }) => sql.trim().length > 0);

  // Join into a single string with line markers so multi-line CREATEs match.
  // Track which physical line each character belongs to for accurate reporting.
  let buffer = "";
  const charToLine: number[] = [];
  for (const { idx, sql } of sanitized) {
    for (const ch of sql) {
      buffer += ch;
      charToLine.push(idx + 1);
    }
    buffer += " ";
    charToLine.push(idx + 1);
  }

  // Collect violations from all patterns; dedup by line to avoid double-reporting
  // when more than one pattern would otherwise match the same statement.
  const reported = new Set<number>();
  for (const pattern of CREATE_AUTH_PATTERNS) {
    let searchFrom = 0;
    while (searchFrom < buffer.length) {
      const match = buffer.slice(searchFrom).match(pattern);
      if (!match || match.index === undefined) break;
      const absIdx = searchFrom + match.index;
      const lineNo = charToLine[absIdx] ?? 0;
      if (!reported.has(lineNo)) {
        reported.add(lineNo);
        findings.push({
          level: "error",
          file,
          line: lineNo,
          rule: "no-auth-objects",
          message:
            "CREATE targets the `auth.` schema — helpers must live in `app.` " +
            "(spec §5.11). Move the object to public/app or drop it.",
        });
      }
      const semi = buffer.indexOf(";", absIdx);
      searchFrom = semi >= 0 ? semi + 1 : buffer.length;
    }
  }
  return findings;
}

// -----------------------------------------------------------------------------
// Rule 5: CREATE TABLE → COMMENT ON TABLE (or TODO marker)
// -----------------------------------------------------------------------------
const CREATE_TABLE_RE =
  /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)?)/gi;
const COMMENT_ON_TABLE_RE =
  /\bCOMMENT\s+ON\s+TABLE\s+([a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)?)/gi;

function normalizeTableName(name: string): string {
  // Strip optional schema qualifier; comparison is by unqualified table name
  // because some migrations may write `public.invoices` while the
  // COMMENT line writes `invoices`. Both should match.
  const parts = name.toLowerCase().split(".");
  return parts[parts.length - 1];
}

function checkTableComments(
  file: string,
  body: string,
  rawLines: string[],
): Finding[] {
  const findings: Finding[] = [];
  const sanitized = stripBlockComments(body);
  const sqlOnly = sanitized
    .split("\n")
    .map(stripLineComment)
    .join("\n");

  const createdTables = new Map<string, number>(); // name -> line
  let m: RegExpExecArray | null;

  // Walk by line so we can attach a line number to each match.
  const sqlLines = sqlOnly.split("\n");
  let runningOffset = 0;
  for (let i = 0; i < sqlLines.length; i++) {
    const line = sqlLines[i];
    CREATE_TABLE_RE.lastIndex = 0;
    while ((m = CREATE_TABLE_RE.exec(line)) !== null) {
      createdTables.set(normalizeTableName(m[1]), i + 1);
    }
    runningOffset += line.length + 1;
  }

  const commentedTables = new Set<string>();
  for (const line of sqlLines) {
    COMMENT_ON_TABLE_RE.lastIndex = 0;
    while ((m = COMMENT_ON_TABLE_RE.exec(line)) !== null) {
      commentedTables.add(normalizeTableName(m[1]));
    }
  }

  // TODO marker (per-table) — searches raw lines (comments included).
  const todoForTable = (tableName: string): boolean => {
    const needle = tableName.toLowerCase();
    return rawLines.some((l) => {
      const t = l.toLowerCase();
      return t.includes("--") && t.includes("todo") && t.includes(needle) &&
        t.includes("comment");
    });
  };

  for (const [tableName, lineNo] of createdTables) {
    if (commentedTables.has(tableName)) continue;
    if (todoForTable(tableName)) continue;
    findings.push({
      level: "error",
      file,
      line: lineNo,
      rule: "table-comment-required",
      message:
        `CREATE TABLE \`${tableName}\` has no matching COMMENT ON TABLE ` +
        `(nor a \`-- TODO: comment on ${tableName}\` marker). ` +
        `Every table must be documented at creation time.`,
    });
  }
  return findings;
}

// -----------------------------------------------------------------------------
// Rule 6: REFERENCES auth.users requires AUDIT-FK-OK annotation
// -----------------------------------------------------------------------------
const AUTH_USERS_REF_RE = /\bREFERENCES\s+auth\.users\b/i;
const AUDIT_FK_OK_RE = /--\s*AUDIT-FK-OK\s*:/i;

function checkAuthUsersAnnotation(
  file: string,
  rawLines: string[],
  strict: boolean,
): Finding[] {
  const findings: Finding[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    // Ignore matches that are themselves inside a comment.
    const sqlPart = stripLineComment(line);
    if (!AUTH_USERS_REF_RE.test(sqlPart)) continue;

    // Inline annotation on the same line?
    if (AUDIT_FK_OK_RE.test(line)) continue;

    // Preceding annotation within the prior 3 non-blank lines?
    let annotated = false;
    let scanned = 0;
    for (let j = i - 1; j >= 0 && scanned < 3; j--) {
      const prev = rawLines[j];
      if (prev.trim() === "") continue;
      scanned++;
      if (AUDIT_FK_OK_RE.test(prev)) {
        annotated = true;
        break;
      }
    }
    if (annotated) continue;

    findings.push({
      level: strict ? "error" : "warning",
      file,
      line: i + 1,
      rule: "audit-fk-auth-users",
      message:
        "REFERENCES auth.users without an `-- AUDIT-FK-OK: <reason>` " +
        "annotation. Per spec §5.10 audit columns must NOT FK auth.users; " +
        "if this is an ownership column (e.g. members.user_id), add the " +
        "annotation to document the exception.",
    });
  }
  return findings;
}

// -----------------------------------------------------------------------------
// Driver
// -----------------------------------------------------------------------------
async function lintFile(
  dir: string,
  name: string,
  strictAuditFk: boolean,
): Promise<Finding[]> {
  const path = `${dir}/${name}`;
  const text = await Deno.readTextFile(path);
  const lines = text.split("\n");
  const findings: Finding[] = [];
  findings.push(...checkHeader(name, lines));
  findings.push(...checkNoAuthCreates(name, text));
  findings.push(...checkTableComments(name, text, lines));
  findings.push(...checkAuthUsersAnnotation(name, lines, strictAuditFk));
  return findings;
}

function formatHuman(findings: Finding[], fileCount: number): string {
  if (findings.length === 0) {
    return `lint_migrations: ${fileCount} file(s) ok.`;
  }
  const out: string[] = [];
  for (const f of findings) {
    const prefix = f.level === "error" ? "ERROR" : "WARN ";
    const loc = f.line > 0 ? `${f.file}:${f.line}` : f.file;
    out.push(`${prefix} [${f.rule}] ${loc}: ${f.message}`);
  }
  const errs = findings.filter((f) => f.level === "error").length;
  const warns = findings.length - errs;
  out.push("");
  out.push(
    `lint_migrations: scanned ${fileCount} file(s) — ` +
      `${errs} error(s), ${warns} warning(s).`,
  );
  return out.join("\n");
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(Deno.args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`lint_migrations: ${message}`);
    printHelp();
    Deno.exit(2);
  }

  const files = await listMigrationFiles(args.dir);
  if (files.length === 0) {
    if (args.json) {
      console.log(JSON.stringify({ files: 0, findings: [] }));
    } else {
      console.log(
        `lint_migrations: no .sql files in '${args.dir}' (ok).`,
      );
    }
    Deno.exit(0);
  }

  const findings: Finding[] = [];
  // Filename + cross-file checks first (only need names, not contents).
  findings.push(...checkFilenames(files));

  // Per-file content checks. Skip body checks if the filename itself is
  // invalid AND not grandfathered — the file may still be a stub.
  for (const name of files) {
    if (
      !GRANDFATHERED_FILENAMES.has(name) && !FILENAME_PATTERN.test(name)
    ) {
      continue;
    }
    findings.push(...await lintFile(args.dir, name, args.strictAuditFk));
  }

  if (args.json) {
    console.log(JSON.stringify({ files: files.length, findings }, null, 2));
  } else {
    console.log(formatHuman(findings, files.length));
  }

  const hasErrors = findings.some((f) => f.level === "error");
  Deno.exit(hasErrors ? 1 : 0);
}

if (import.meta.main) {
  await main();
}
