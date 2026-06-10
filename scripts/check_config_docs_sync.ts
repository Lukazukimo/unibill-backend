#!/usr/bin/env -S deno run --allow-read --allow-env
// =============================================================================
// scripts/check_config_docs_sync.ts
// -----------------------------------------------------------------------------
// Three-way drift check between:
//   (a) Spec Appendix B (markdown tables in
//       `docs/superpowers/specs/2026-06-08-unibill-mvp-design.md`)
//   (b) Seed file `supabase/seeds/app_settings_defaults.sql`
//   (c) Every `getConfig('foo.bar', ...)` call across `supabase/functions/`
//
// Asserts the three key-sets are equal (modulo wildcard prefixes the spec
// declares — e.g. `security.rate_limits.<endpoint>`). Exits 1 with a
// human-readable diff on drift; exits 0 when all three match.
//
// Task:      T-120
// Spec refs: §B  (Appendix B — Configs default, with the explicit audit
//                 directive: "CI test (scripts/check_config_docs_sync.py)
//                 cruza esta lista com … Falha build se houver drift").
//            §10.5 (retention.* enumeration referenced from §B).
// Date:      2026-06-10
//
// Usage:
//   deno run --allow-read scripts/check_config_docs_sync.ts \
//     [--spec <path>] [--seed <path>] [--functions <path>] [--json]
//
// Defaults (relative to repo root):
//   --spec       ../docs/superpowers/specs/2026-06-08-unibill-mvp-design.md
//   --seed       supabase/seeds/app_settings_defaults.sql
//   --functions  supabase/functions
//
// Exit codes:
//   0  every key in (a), (b) and (c) reconciles
//   1  drift detected (diff printed to stdout)
//   2  invocation/parse error (printed to stderr)
//
// CI integration:
//   TODO(main-loop): add a new job `config-drift` to
//   `.github/workflows/ci.yml`:
//
//       config-drift:
//         name: config-drift (app_settings ↔ spec ↔ code)
//         runs-on: ubuntu-latest
//         steps:
//           - uses: actions/checkout@v4
//             with: { fetch-depth: 1, submodules: false }
//           - uses: denoland/setup-deno@v2
//             with: { deno-version: v2.x }
//           - name: Check config docs sync
//             run: |
//               deno run --allow-read \
//                 scripts/check_config_docs_sync.ts \
//                 --spec ../docs/superpowers/specs/2026-06-08-unibill-mvp-design.md
//
//   The spec lives in a sibling directory (`unibill/docs/...`) — CI must
//   `actions/checkout` the docs repo or use a path strategy. If the spec
//   path is unreachable, the script exits 2 with a clear error.
//
// How to fix common drift scenarios:
//   ─────────────────────────────────────────────────────────────────────────
//   "Key X only in spec §B":
//     → Either (a) seed it in `seeds/app_settings_defaults.sql` with an
//       INSERT row that mirrors the spec defaults, OR (b) add a `getConfig`
//       call in a function that reads it. If the key is intentionally
//       runtime-only (not seeded), document it in this file's
//       `RUNTIME_ONLY_KEYS` constant below.
//
//   "Key X only in seed":
//     → Either (a) add the key to spec §B (preferred — spec is the source
//       of truth), OR (b) remove from seed if it was an experiment.
//
//   "Key X only in code (getConfig call)":
//     → A new feature is reading a config that nobody documented or seeded.
//       Add the row to spec §B AND to the seed file. The two-step keeps
//       deploys deterministic (the cascade-resolver always finds a default).
//
//   Wildcard mismatch:
//     → Spec lists `security.rate_limits.<endpoint>` but code reads
//       `security.rate_limits.foo`. That is OK if the spec declares the
//       wildcard pattern (`<…>` segment); the script automatically accepts
//       concrete suffixes. If the wildcard prefix is missing, add it as a
//       row in spec §B.
//
//   Dynamic getConfig:
//     → `getConfig(\`some.\${name}\`)` cannot be statically analysed. The
//       script reports these as warnings (not failures) and continues. If
//       you need them suppressed, list the wrapper function in the script's
//       `--alias` flag and ensure the concrete keys are also referenced via
//       a literal `getConfig` somewhere (test, init, etc.).
// =============================================================================

import {
  type AppendixBResult,
  parseAppendixB,
  parseGetConfigCalls,
  parseSeedKeys,
} from './lib/parse_appendix_b.ts';

// Keys that legitimately exist in spec §B but are NOT yet seeded or read by
// any function — typically because their consumer lives in a later phase.
// Once seeded/consumed, remove the key from this list. Empty by default;
// future phases will populate as needed.
const RUNTIME_ONLY_KEYS: Set<string> = new Set<string>([]);

// Keys whose absence from `getConfig` consumers is intentional — typically
// because the consumer lives in a later phase. These are still required to
// appear in both the spec AND the seed (so the cascade-resolver has a
// default ready); we just suppress the "documented + seeded but no consumer"
// INFO message for them. Populated explicitly by the maintainer.
const NO_CONSUMER_YET_KEYS: Set<string> = new Set<string>([
  // Vault placeholder rows — overwritten post-deploy, consumed in later phases.
  'extraction.ocr_space.api_key_secret_id',
  'extraction.google_vision.api_key_secret_id',
  'ai.gemini.api_key_secret_id',
  'ai.groq.api_key_secret_id',
  'ai.openrouter.api_key_secret_id',
]);

// Legacy alias retained for backwards compatibility with the spec text —
// the spec calls out "seed-only or runtime-only callouts" as the two
// allow-list buckets. Today both buckets share the same suppression so we
// re-use one constant via assignment.
const SEED_ONLY_KEYS = NO_CONSUMER_YET_KEYS;

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

interface Args {
  spec: string;
  seed: string;
  functions: string;
  json: boolean;
  aliases: string[];
}

function defaultSpecPath(): string {
  // Resolve relative to the script's location so the default works whether
  // invoked from the repo root or from a CI shim. The spec lives in a sibling
  // checkout (../docs/superpowers/...) per the monorepo plan. The current
  // import.meta.url path is `<repo>/scripts/check_config_docs_sync.ts`, so
  // `../../docs/...` lands at `<parent>/docs/superpowers/...`.
  return new URL(
    '../../docs/superpowers/specs/2026-06-08-unibill-mvp-design.md',
    import.meta.url,
  ).pathname;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    spec: Deno.env.get('UNIBILL_SPEC_PATH') ?? defaultSpecPath(),
    seed: 'supabase/seeds/app_settings_defaults.sql',
    functions: 'supabase/functions',
    json: false,
    aliases: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const requireValue = (): string => {
      const v = argv[i + 1];
      if (!v) throw new Error(`${a} requires a value`);
      i++;
      return v;
    };
    switch (a) {
      case '--spec':
        out.spec = requireValue();
        break;
      case '--seed':
        out.seed = requireValue();
        break;
      case '--functions':
        out.functions = requireValue();
        break;
      case '--alias':
        out.aliases.push(requireValue());
        break;
      case '--json':
        out.json = true;
        break;
      case '-h':
      case '--help':
        printHelp();
        Deno.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

function printHelp(): void {
  console.log(
    [
      'Usage: deno run --allow-read scripts/check_config_docs_sync.ts [flags]',
      '',
      'Flags:',
      '  --spec <path>        Spec markdown path (default: sibling docs repo)',
      '  --seed <path>        Seed SQL path (default: supabase/seeds/app_settings_defaults.sql)',
      '  --functions <path>   Functions directory (default: supabase/functions)',
      '  --alias <name>       Additional getConfig wrapper name (repeatable)',
      '  --json               Emit JSON drift report instead of human text',
      '  -h, --help           Show this help',
    ].join('\n'),
  );
}

// -----------------------------------------------------------------------------
// I/O
// -----------------------------------------------------------------------------

async function readSpec(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(
        `spec markdown not found at ${path} — ` +
          `pass --spec <path> or set UNIBILL_SPEC_PATH`,
      );
    }
    throw err;
  }
}

async function readSeed(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(`seed SQL not found at ${path}`);
    }
    throw err;
  }
}

async function* walkTsFiles(root: string): AsyncGenerator<string> {
  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(root);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
  for await (const entry of entries) {
    const full = `${root}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walkTsFiles(full);
    } else if (entry.isFile && entry.name.endsWith('.ts')) {
      // Skip *.test.ts files? — tests may legitimately reference configs
      // (positive: they prove the key is used; negative: they may be only
      // place a key appears). Include them; if a key is referenced ONLY in
      // a test the engineer probably forgot a production call site.
      yield full;
    }
  }
}

// -----------------------------------------------------------------------------
// Drift computation
// -----------------------------------------------------------------------------

interface DriftReport {
  specCount: number;
  seedCount: number;
  codeCount: number;
  wildcardPrefixes: string[];
  onlyInSpec: string[];
  onlyInSeed: string[];
  onlyInCode: string[];
  dynamicCallSites: Array<{ snippet: string; file: string; line: number }>;
  errors: string[];
  infos: string[];
}

function computeDrift(
  specResult: AppendixBResult,
  seedKeys: Set<string>,
  codeKeys: Set<string>,
  dynamicCallSites: Array<{ snippet: string; file: string; line: number }>,
): DriftReport {
  const onlyInSpec: string[] = [];
  const onlyInSeed: string[] = [];
  const onlyInCode: string[] = [];
  const errors: string[] = [];
  const infos: string[] = [];

  const allKeys = new Set<string>([
    ...specResult.keys,
    ...seedKeys,
    ...codeKeys,
  ]);

  const matchesWildcard = (k: string): boolean => {
    for (const prefix of specResult.wildcardPrefixes) {
      if (k.startsWith(prefix)) return true;
    }
    return false;
  };

  for (const k of allKeys) {
    const inSpec = specResult.keys.has(k);
    const inSeed = seedKeys.has(k);
    const inCode = codeKeys.has(k);
    const wildOk = matchesWildcard(k);

    // Bucketing (exclusive — every key falls into exactly one branch):
    if (inSpec && !inSeed && !inCode) {
      if (RUNTIME_ONLY_KEYS.has(k)) {
        infos.push(`runtime-only key in spec, not yet seeded or consumed: ${k}`);
      } else {
        onlyInSpec.push(k);
      }
    } else if (!inSpec && inSeed && !inCode && !wildOk) {
      if (SEED_ONLY_KEYS.has(k)) {
        infos.push(`seed-only key (allow-listed): ${k}`);
      } else {
        onlyInSeed.push(k);
      }
    } else if (!inSpec && !inSeed && inCode && !wildOk) {
      onlyInCode.push(k);
    } else if (inSpec && inSeed && !inCode) {
      // Documented + seeded but no consumer — emit an INFO unless allow-listed
      // via NO_CONSUMER_YET_KEYS (which is the intent of the seed-only and
      // runtime-only buckets per spec §B).
      if (!NO_CONSUMER_YET_KEYS.has(k) && !RUNTIME_ONLY_KEYS.has(k)) {
        infos.push(`documented + seeded but no getConfig consumer: ${k}`);
      }
    } else if (inSpec && !inSeed && inCode) {
      // Read by code, documented, but no default seed — that is a real bug.
      onlyInCode.push(k);
    } else if (!inSpec && inSeed && inCode && !wildOk) {
      onlyInSeed.push(k);
    } else {
      // (inSpec && inSeed && inCode) or wildcard-covered — happy paths.
    }
  }

  // Deterministic, deduplicated output (bucketing above is exclusive so
  // duplicates should not occur — the Set guard is a safety net).
  const dedup = (xs: string[]) => [...new Set(xs)].sort();
  const sortedOnlyInSpec = dedup(onlyInSpec);
  const sortedOnlyInSeed = dedup(onlyInSeed);
  const sortedOnlyInCode = dedup(onlyInCode);

  if (sortedOnlyInSpec.length > 0) {
    errors.push(
      `${sortedOnlyInSpec.length} key(s) declared in spec §B but missing from BOTH seed and code`,
    );
  }
  if (sortedOnlyInSeed.length > 0) {
    errors.push(
      `${sortedOnlyInSeed.length} key(s) seeded but absent from spec §B`,
    );
  }
  if (sortedOnlyInCode.length > 0) {
    errors.push(
      `${sortedOnlyInCode.length} key(s) read by getConfig(...) but absent from seed`,
    );
  }

  return {
    specCount: specResult.keys.size,
    seedCount: seedKeys.size,
    codeCount: codeKeys.size,
    wildcardPrefixes: [...specResult.wildcardPrefixes].sort(),
    onlyInSpec: sortedOnlyInSpec,
    onlyInSeed: sortedOnlyInSeed,
    onlyInCode: sortedOnlyInCode,
    dynamicCallSites,
    errors,
    infos,
  };
}

// -----------------------------------------------------------------------------
// Reporting
// -----------------------------------------------------------------------------

function renderHuman(report: DriftReport): string {
  const out: string[] = [];
  out.push('=== check_config_docs_sync.ts — drift report ===');
  out.push(`spec keys:     ${report.specCount}`);
  out.push(`seed keys:     ${report.seedCount}`);
  out.push(`code keys:     ${report.codeCount}`);
  out.push(`wildcards:     ${report.wildcardPrefixes.length}`);
  if (report.wildcardPrefixes.length > 0) {
    for (const p of report.wildcardPrefixes) out.push(`  - ${p}<...>`);
  }
  out.push('');
  const section = (title: string, items: string[]) => {
    if (items.length === 0) return;
    out.push(`-- ${title} (${items.length}) --`);
    for (const it of items) out.push(`  - ${it}`);
    out.push('');
  };
  section('Only in spec §B (no seed AND no consumer)', report.onlyInSpec);
  section('Only in seed (missing from spec §B)', report.onlyInSeed);
  section('Only in code (read by getConfig but never seeded)', report.onlyInCode);
  if (report.dynamicCallSites.length > 0) {
    out.push(`-- Dynamic getConfig() call sites (cannot be statically checked) --`);
    for (const ds of report.dynamicCallSites) {
      out.push(`  - ${ds.file}:${ds.line}  →  \`${ds.snippet}\``);
    }
    out.push('');
  }
  if (report.infos.length > 0) {
    out.push(`-- INFO --`);
    for (const m of report.infos) out.push(`  i ${m}`);
    out.push('');
  }
  if (report.errors.length === 0) {
    out.push('OK — three sources are consistent.');
  } else {
    out.push('DRIFT DETECTED:');
    for (const e of report.errors) out.push(`  ! ${e}`);
    out.push('');
    out.push('See script header for "How to fix common drift scenarios".');
  }
  return out.join('\n');
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(
      `check_config_docs_sync: ${err instanceof Error ? err.message : String(err)}`,
    );
    printHelp();
    return 2;
  }

  let specText: string;
  let seedText: string;
  try {
    specText = await readSpec(args.spec);
    seedText = await readSeed(args.seed);
  } catch (err) {
    console.error(
      `check_config_docs_sync: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 2;
  }

  let specResult: AppendixBResult;
  try {
    specResult = parseAppendixB(specText);
  } catch (err) {
    console.error(
      `check_config_docs_sync: spec parse error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 2;
  }

  const seedKeys = parseSeedKeys(seedText);

  const codeKeys = new Set<string>();
  const dynamicCallSites: Array<{ snippet: string; file: string; line: number }> = [];
  for await (const file of walkTsFiles(args.functions)) {
    const text = await Deno.readTextFile(file);
    const r = parseGetConfigCalls(text, { aliases: args.aliases });
    for (const k of r.keys) codeKeys.add(k);
    for (const d of r.dynamic) {
      dynamicCallSites.push({ snippet: d.snippet, file, line: d.line });
    }
  }

  const report = computeDrift(specResult, seedKeys, codeKeys, dynamicCallSites);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderHuman(report));
  }

  return report.errors.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  const code = await main(Deno.args);
  Deno.exit(code);
}
