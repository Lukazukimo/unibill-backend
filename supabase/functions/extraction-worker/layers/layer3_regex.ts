/**
 * layer3_regex.ts — Layer 3 of the extraction pipeline: deterministic
 * per-utility regex extraction (no OCR, no AI, no external API).
 *
 * Ref:  T-411, spec §7.4 (Layer 3 regex per-utility) + §B (required fields)
 * Date: 2026-06-23
 *
 * PURE — the utility_parsers rows are INJECTED (no DB here). Two steps:
 *   1. selectParser(parsers, ctx)  → the parser whose sender (and optional
 *      subject / body_must_contain) patterns match the email. First match wins.
 *   2. applyParser(parser, text)   → run each field regex over the text, parse
 *      Brazilian money / dates, and score a layer-3 confidence as
 *      captured_required / total_required, where the required set is
 *      [amount_cents, due_date, (barcode OR pix)] (extraction.required_fields_
 *      minimum). The orchestrator feeds layer3Confidence into confidence.ts.
 */

/** Minimal shape of a public.utility_parsers row (the columns Layer 3 reads). */
export interface UtilityParser {
  utility_key: string;
  default_category?: string | null;
  sender_patterns: string[];
  subject_patterns?: string[] | null;
  body_must_contain?: string[] | null;
  amount_regex?: string | null;
  due_date_regex?: string | null;
  due_date_format?: string | null;
  barcode_regex?: string | null;
  pix_regex?: string | null;
  reference_regex?: string | null;
  installation_regex?: string | null;
  customer_name_regex?: string | null;
  service_address_regex?: string | null;
}

/** What we match a parser against (from the email + Layer 1/2 text). */
export interface MatchContext {
  senderEmail?: string;
  subject?: string;
  bodyText?: string;
}

/** Extracted invoice fields (only present keys are set). */
export interface ExtractedFields {
  amount_cents?: number;
  due_date?: string; // ISO yyyy-mm-dd
  barcode?: string;
  pix_payload?: string;
  reference?: string;
  installation?: string;
  customer_name?: string;
  service_address?: string;
  default_category?: string;
}

export interface Layer3Result {
  parserKey: string;
  fields: ExtractedFields;
  /** captured_required / total_required ∈ [0,1]. */
  layer3Confidence: number;
}

/** Compile a stored regex once, case-insensitive; null on an invalid pattern. */
function compile(pattern: string | null | undefined): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

/** Does ANY of the stored patterns match `target`? */
function matchesAny(patterns: string[] | null | undefined, target: string | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  if (!target) return false;
  return patterns.some((p) => compile(p)?.test(target) ?? false);
}

/** Does the text match ALL of the stored patterns? */
function matchesAll(patterns: string[] | null | undefined, target: string | undefined): boolean {
  if (!patterns || patterns.length === 0) return true; // no constraint
  if (!target) return false;
  return patterns.every((p) => compile(p)?.test(target) ?? false);
}

/**
 * Pick the parser whose sender_patterns match the sender. subject_patterns and
 * body_must_contain are SECONDARY refiners: they are enforced only when the
 * caller actually supplies that input (a missing subject/body never disqualifies
 * an otherwise sender-matching parser — the sender is the primary key). First
 * match wins (callers pass parsers in priority order).
 */
export function selectParser(
  parsers: UtilityParser[],
  ctx: MatchContext,
): UtilityParser | null {
  for (const p of parsers) {
    if (!matchesAny(p.sender_patterns, ctx.senderEmail)) continue;
    if (
      ctx.subject !== undefined && p.subject_patterns && p.subject_patterns.length > 0 &&
      !matchesAny(p.subject_patterns, ctx.subject)
    ) continue;
    if (
      ctx.bodyText !== undefined && p.body_must_contain && p.body_must_contain.length > 0 &&
      !matchesAll(p.body_must_contain, ctx.bodyText)
    ) continue;
    return p;
  }
  return null;
}

/** First capture group of `regex` over `text`, trimmed; undefined if no match. */
function cap(text: string, pattern: string | null | undefined): string | undefined {
  const re = compile(pattern);
  if (!re) return undefined;
  const m = text.match(re);
  const g = m?.[1] ?? m?.[0];
  const v = g?.trim();
  return v && v.length > 0 ? v : undefined;
}

/** Brazilian money "1.234,56" / "234,56" → integer cents (123456 / 23456). */
export function parseBrlToCents(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/[^\d.,]/g, '');
  if (!cleaned) return undefined;
  // '.' = thousands, ',' = decimal.
  const normalized = cleaned.replace(/\./g, '').replace(',', '.');
  const n = Number(normalized);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * 100);
}

/** Parse a date string into ISO yyyy-mm-dd per the parser's due_date_format. */
export function parseDate(
  raw: string | undefined,
  format: string | null | undefined,
): string | undefined {
  if (!raw) return undefined;
  // Only DD/MM/YYYY is defined for the MVP parsers; default to it.
  if (!format || format.toUpperCase() === 'DD/MM/YYYY') {
    const m = raw.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  }
  return undefined;
}

/**
 * Apply a parser's field regexes to `text`. Returns the extracted fields and a
 * layer-3 confidence = captured_required / total_required, where required =
 * [amount_cents, due_date, (barcode OR pix)] (extraction.required_fields_minimum).
 */
export function applyParser(parser: UtilityParser, text: string): Layer3Result {
  const fields: ExtractedFields = {};

  const amount = parseBrlToCents(cap(text, parser.amount_regex));
  if (amount !== undefined) fields.amount_cents = amount;

  const due = parseDate(cap(text, parser.due_date_regex), parser.due_date_format);
  if (due) fields.due_date = due;

  const barcode = cap(text, parser.barcode_regex);
  if (barcode) fields.barcode = barcode;

  const pix = cap(text, parser.pix_regex);
  if (pix) fields.pix_payload = pix;

  const reference = cap(text, parser.reference_regex);
  if (reference) fields.reference = reference;

  const installation = cap(text, parser.installation_regex);
  if (installation) fields.installation = installation;

  const customer = cap(text, parser.customer_name_regex);
  if (customer) fields.customer_name = customer;

  const address = cap(text, parser.service_address_regex);
  if (address) fields.service_address = address;

  if (parser.default_category) fields.default_category = parser.default_category;

  // required_fields_minimum: amount_cents, due_date, (barcode OR pix).
  const required = [
    fields.amount_cents !== undefined,
    fields.due_date !== undefined,
    fields.barcode !== undefined || fields.pix_payload !== undefined,
  ];
  const layer3Confidence = required.filter(Boolean).length / required.length;

  return { parserKey: parser.utility_key, fields, layer3Confidence };
}
