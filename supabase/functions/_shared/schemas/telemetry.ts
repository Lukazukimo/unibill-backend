// =============================================================================
// _shared/schemas/telemetry.ts
// -----------------------------------------------------------------------------
// Zod schema + enums for the client telemetry ingest body (T-513, spec §8.9 /
// Appendix E /telemetry/ingest). Single source of truth for runtime validation
// and TS types (z.infer). The batch-size cap (max events) is enforced here (a
// too-large batch is a 422 validation_failed); the per-event byte cap (413) is
// enforced in the handler since it is a size limit, not a shape rule.
// =============================================================================

import { z } from 'zod';

/** Allowed telemetry severities (client_telemetry.severity is free-form text
 *  server-side, so the enum lives here — BR-018). */
export const TELEMETRY_SEVERITIES = ['debug', 'info', 'warn', 'error'] as const;
export type TelemetrySeverity = (typeof TELEMETRY_SEVERITIES)[number];

/** Max events accepted per ingest batch. Over this → 422 validation_failed. */
export const MAX_TELEMETRY_EVENTS = 50;

export const telemetryEventSchema = z.object({
  event_type: z.string().min(1).max(200),
  severity: z.enum(TELEMETRY_SEVERITIES),
  // jsonb bag — an object; leaf strings are deep-redacted server-side before
  // persistence (§6.5).
  payload: z.record(z.string(), z.unknown()),
  screen: z.string().max(200).optional(),
  // Full ISO-8601 datetime WITH an explicit offset (Z or ±HH:MM), matching what
  // the mobile client sends (DateTime.toUtc().toIso8601String()). A looser
  // Date.parse check let partial values like "2026" pass validation but then
  // crash the timestamptz INSERT with a 500 instead of a clean 422.
  occurred_at: z.string().regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/,
    'occurred_at must be an ISO-8601 datetime with a timezone offset',
  ),
});

export const telemetryIngestBodySchema = z.object({
  events: z.array(telemetryEventSchema).min(1).max(MAX_TELEMETRY_EVENTS),
});

export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;
export type TelemetryIngestBody = z.infer<typeof telemetryIngestBodySchema>;
