// =============================================================================
// scripts/lib/parse_appendix_b.ts
// -----------------------------------------------------------------------------
// Library helpers used by `scripts/check_config_docs_sync.ts` (task T-120).
// Exposes pure functions — no Deno-specific I/O so the module is also
// trivially unit-testable.
//
// Task:      T-120
// Spec refs: §B  (Configs default — lista canônica)
//            §10.5 (retention.* enumeration — §B explicitly defers here)
// Date:      2026-06-10
//
// Public surface:
//   - parseAppendixB(specText, opts?)   ── extracts the canonical key set
//                                         (Set<string>) from the markdown
//                                         spec. Includes §10.5 expansion for
//                                         retention.* keys when present.
//
//   - parseSeedKeys(sqlText)            ── extracts keys from
//                                         `seeds/app_settings_defaults.sql`
//                                         INSERT statements.
//
//   - parseGetConfigCalls(tsText)       ── extracts the first-arg string
//                                         literal from every `getConfig('…')`
//                                         (or `await getConfig('…')`) call.
//                                         Multi-line tolerant: tokenises the
//                                         file with whitespace collapsed.
//
//   - WILDCARD_PATTERNS                 ── exported set of patterns that
//                                         intentionally have variable suffixes
//                                         (e.g. `security.rate_limits.<x>`).
//                                         Callers use these to decide whether
//                                         a "spec-only" prefix legitimately
//                                         covers an unknown concrete key.
//
// Design notes:
//   * Markdown table rows we care about start with `|` and contain at least
//     one backtick-wrapped token. Keys are identified by `[a-z0-9_.<>]+` —
//     dots for namespace, angle brackets to capture wildcard placeholders.
//   * The §B prelude has a line "Ver §10.5 — 18 chaves no padrão
//     `retention.<table>.{max_age_days, adaptive_floor_days, slim_after_days}`."
//     This is NOT a row enumeration. We instead also scan §10.5 (a fenced
//     code block of `retention.* = N` lines) to harvest the literal keys.
//   * §B contains an `ocr.chain.*` row that says "idem ai.chain.*". We expand
//     this by mirroring every parsed `ai.chain.*` key to `ocr.chain.*`.
//   * Keys containing `<` or `>` are filed under WILDCARD_PATTERNS instead of
//     the literal key set.
// =============================================================================

// Backtick-delimited tokens that look like config keys. Allows letters,
// digits, underscore, dot, `<`, `>`. The leading char must be a letter so we
// avoid matching things like backtick numeric literals or empty backticks.
const KEY_TOKEN_RE = /`([a-z][a-z0-9_]*(?:\.[a-z0-9_<>]+)+)`/gi;

// Headings that bookend §B in the source markdown.
const APPENDIX_B_HEADING_RE = /^###\s+B\.\s+Configs default/m;
const NEXT_APPENDIX_HEADING_RE = /^###\s+[A-Z]\.\s+/m;
// Heading for §10.5 (retention enumeration).
const SECTION_10_5_HEADING_RE = /^###\s+10\.5\s+Configs de reten/m;
const SECTION_10_6_HEADING_RE = /^###\s+10\.6/m;

// Lines like `retention.foo.bar = 365` (with optional inline comment) inside
// the §10.5 fenced code block.
const RETENTION_LINE_RE = /^\s*(retention\.[a-z0-9_.]+)\s*=/gim;

// =============================================================================
// Public types
// =============================================================================

export interface AppendixBResult {
  /** Canonical literal keys (no `<placeholder>` segments). */
  keys: Set<string>;
  /**
   * Keys that legitimately have a wildcard suffix in spec — e.g.
   * `security.rate_limits.<endpoint>`. Each entry is the *prefix* up to and
   * including the dot before `<placeholder>`. Concrete seed/code keys with
   * this prefix are accepted without spec match.
   */
  wildcardPrefixes: Set<string>;
}

export interface ParseGetConfigOpts {
  /**
   * Optional alias names — some workers might wrap `getConfig` under another
   * function (e.g. `cfg.get('foo')`). Pass identifiers (without parens). Each
   * is matched with the same multi-line tolerant grammar as `getConfig`.
   */
  aliases?: string[];
}

// =============================================================================
// Section slicing
// =============================================================================

function sliceSection(text: string, start: RegExp, end: RegExp): string {
  const m = start.exec(text);
  if (!m) return '';
  const after = text.slice(m.index + m[0].length);
  const endMatch = end.exec(after);
  return endMatch ? after.slice(0, endMatch.index) : after;
}

// =============================================================================
// Appendix B parser
// =============================================================================

export function parseAppendixB(specText: string): AppendixBResult {
  const keys = new Set<string>();
  const wildcardPrefixes = new Set<string>();

  const appendixBBody = sliceSection(
    specText,
    APPENDIX_B_HEADING_RE,
    NEXT_APPENDIX_HEADING_RE,
  );
  if (!appendixBBody) {
    throw new Error(
      'parseAppendixB: could not locate "### B. Configs default" heading in spec.',
    );
  }

  // Track the rows verbatim to handle the special `ocr.chain.*` mirror
  // (which lists no individual rows of its own).
  const aiChainKeys: string[] = [];
  let sawOcrChainMirrorRow = false;

  // Iterate line by line so we can scope our key-extraction to markdown table
  // rows only (lines starting with `|`). This prevents harvesting backticked
  // examples from prose paragraphs (e.g. `getConfig('foo.bar')` references in
  // a paragraph) which would inflate the key set with non-canonical names.
  const lines = appendixBBody.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    // Skip separator rows (|---|---|).
    if (/^\|[\s\-:|]+$/.test(line)) continue;

    // The very first `|...|` cell is the Key column. Extract that cell's text
    // and read the backticked token (or wildcard) from it. Other backticked
    // tokens in the row are descriptions / defaults and must be ignored.
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length === 0) continue;
    const keyCell = cells[0];

    // The OCR chain mirror row: "| `ocr.chain.*` | (idem `ai.chain.*`) | ... |"
    if (keyCell.includes('ocr.chain.*')) {
      sawOcrChainMirrorRow = true;
      continue;
    }

    // Capture every backticked key candidate in the key cell (usually 1).
    KEY_TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = KEY_TOKEN_RE.exec(keyCell)) !== null) {
      const tok = m[1];
      if (tok.includes('<') || tok.includes('>') || tok.endsWith('.*')) {
        // Wildcard — store the literal prefix up to the dot before the wildcard
        // segment.
        const dotIdx = tok.indexOf('.<');
        const wildcardDotIdx = tok.indexOf('.*');
        const cut = dotIdx >= 0
          ? dotIdx + 1
          : wildcardDotIdx >= 0
          ? wildcardDotIdx + 1
          : tok.length;
        const prefix = tok.slice(0, cut); // e.g. "security.rate_limits."
        wildcardPrefixes.add(prefix);
      } else {
        keys.add(tok);
        if (tok.startsWith('ai.chain.')) aiChainKeys.push(tok);
      }
    }
  }

  // Mirror ai.chain.* → ocr.chain.* per the §B note on the mirror row.
  if (sawOcrChainMirrorRow) {
    for (const k of aiChainKeys) {
      keys.add('ocr.chain.' + k.slice('ai.chain.'.length));
    }
  }

  // §10.5 retention enumeration — §B refers callers there for the concrete
  // 18+ retention.* keys.
  const section10_5 = sliceSection(
    specText,
    SECTION_10_5_HEADING_RE,
    SECTION_10_6_HEADING_RE,
  );
  if (section10_5) {
    RETENTION_LINE_RE.lastIndex = 0;
    let rm: RegExpExecArray | null;
    while ((rm = RETENTION_LINE_RE.exec(section10_5)) !== null) {
      keys.add(rm[1]);
    }
  }

  return { keys, wildcardPrefixes };
}

// =============================================================================
// Seed parser
// =============================================================================

// Matches the first string literal after `INSERT INTO public.app_settings ...
// VALUES (`. Tolerant of whitespace and newlines.
//
// NOTE: We do NOT try to bind by table name strictly — every INSERT in
// `seeds/app_settings_defaults.sql` is into public.app_settings. The grammar
// `INSERT INTO ... VALUES ( '<key>'` is sufficient.
const SEED_INSERT_RE =
  /INSERT\s+INTO\s+public\.app_settings[^;]*?VALUES\s*\(\s*'([^']+)'/gi;

export function parseSeedKeys(sqlText: string): Set<string> {
  const out = new Set<string>();
  SEED_INSERT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SEED_INSERT_RE.exec(sqlText)) !== null) {
    out.add(m[1]);
  }
  return out;
}

// =============================================================================
// getConfig() call parser
// =============================================================================

// Locate every `getConfig` (or alias) identifier in a TS file and extract the
// first-arg string literal. We tolerate calls split across multiple lines
// (Deno/TS prettier sometimes wraps long arg lists).
//
// Strategy:
//   1. Strip line comments (`// ...`) and block comments (`/* ... */`) so we
//      do not match references inside docs.
//   2. Find every identifier occurrence followed (after optional whitespace,
//      with possible generic parameters) by `(`.
//   3. From the `(`, scan forward skipping whitespace/newlines until we hit
//      a string-literal opening quote (`'`, `"`, or backtick template). Read
//      until the matching closing quote.
//   4. Template literals are only accepted if they contain NO `${…}` —
//      because we cannot statically resolve those. Such cases emit a warning
//      via the returned `dynamic` set so the caller can surface them.

function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let inString: '"' | "'" | '`' | null = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < src.length) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (c === inString) inString = null;
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      // Skip to end of line.
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c as '"' | "'" | '`';
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export interface GetConfigParseResult {
  keys: Set<string>;
  /** Calls whose first argument was a template literal with interpolation. */
  dynamic: Array<{ snippet: string; line: number }>;
}

export function parseGetConfigCalls(
  tsText: string,
  opts: ParseGetConfigOpts = {},
): GetConfigParseResult {
  const aliases = new Set<string>(['getConfig', ...(opts.aliases ?? [])]);
  const keys = new Set<string>();
  const dynamic: Array<{ snippet: string; line: number }> = [];

  const sanitized = stripComments(tsText);

  // Build identifier regex from union of aliases.
  // Identifier characters: [A-Za-z_$][\w$]*. Aliases must be valid TS idents.
  const identUnion = [...aliases]
    .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const callRe = new RegExp(
    `(?:^|[^A-Za-z0-9_$])(?:${identUnion})\\s*(?:<[^>]*>)?\\s*\\(`,
    'g',
  );

  let m: RegExpExecArray | null;
  while ((m = callRe.exec(sanitized)) !== null) {
    // Position of the `(` is at m.index + m[0].length - 1.
    const openParen = m.index + m[0].length - 1;
    // Scan past whitespace.
    let i = openParen + 1;
    while (i < sanitized.length && /\s/.test(sanitized[i])) i++;
    if (i >= sanitized.length) continue;
    const q = sanitized[i];
    if (q !== '"' && q !== "'" && q !== '`') {
      // First arg is not a string literal — probably a variable. Skip.
      continue;
    }
    // Read until matching closing quote, honoring backslash escapes.
    let j = i + 1;
    let body = '';
    let dynamicSubst = false;
    while (j < sanitized.length) {
      const ch = sanitized[j];
      if (ch === '\\' && j + 1 < sanitized.length) {
        body += sanitized[j + 1];
        j += 2;
        continue;
      }
      if (q === '`' && ch === '$' && sanitized[j + 1] === '{') {
        dynamicSubst = true;
        // Skip to closing brace (track nesting briefly).
        let depth = 1;
        j += 2;
        while (j < sanitized.length && depth > 0) {
          if (sanitized[j] === '{') depth++;
          else if (sanitized[j] === '}') depth--;
          j++;
        }
        continue;
      }
      if (ch === q) {
        j++;
        break;
      }
      body += ch;
      j++;
    }

    // Compute 1-based line number of the call site.
    const upTo = sanitized.slice(0, m.index);
    const line = upTo.split('\n').length;

    if (dynamicSubst) {
      dynamic.push({ snippet: body.trim(), line });
      continue;
    }
    if (body.length > 0) keys.add(body);
  }
  return { keys, dynamic };
}
