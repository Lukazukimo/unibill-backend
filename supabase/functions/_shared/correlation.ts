/**
 * correlation.ts — correlation id propagation middleware.
 *
 * Ref: T-125 + T-316 (emit x-correlation-id response header), spec §4.2 / §4.2.1
 * Date: 2026-06-10
 *
 * Provides `withCorrelation()`, a wrapper that injects a `CorrelationContext`
 * into every Edge Function handler. The correlation_id (UUID v4) is the
 * primary join key that links structured logs, `ai_calls`, `domain_events`,
 * `sync_runs`, `extraction_runs` and any HTTP egress made from the request.
 * It is read from the inbound `x-correlation-id` header (or minted) and echoed
 * back on the response `x-correlation-id` header so callers can correlate.
 */

export type CorrelationContext = {
  correlation_id: string;
  user_id?: string;
  household_id?: string;
};

/**
 * If the inbound request carries `x-correlation-id`, reuse it; otherwise mint
 * a fresh UUID v4 via `crypto.randomUUID()`. The returned id is suitable for
 * inclusion in logs, queue payloads and DB rows.
 */
export function newCorrelationId(req?: Request): string {
  const inbound = req?.headers.get('x-correlation-id');
  if (inbound && /^[0-9a-f-]{32,36}$/i.test(inbound)) {
    return inbound;
  }
  return crypto.randomUUID();
}

/**
 * Wraps an Edge Function handler so it receives a `CorrelationContext` and so
 * the resolved correlation_id is emitted back on the response's
 * `x-correlation-id` header. The returned handler is shaped to be passed
 * directly to `Deno.serve()`.
 *
 * JWT extraction of `user_id` and household resolution land in a later task.
 */
export function withCorrelation<T extends Response>(
  handler: (ctx: CorrelationContext, req: Request) => Promise<T>,
): (req: Request) => Promise<T> {
  return async (req: Request): Promise<T> => {
    const ctx: CorrelationContext = {
      correlation_id: newCorrelationId(req),
    };
    const res = await handler(ctx, req);
    // Emit the correlation id back to the caller (spec §4.2 "Headers comuns:
    // x-correlation-id"). Header names are case-insensitive; lowercase matches
    // the inbound read above and the spec. Non-destructive: status, body and
    // any handler-set headers (e.g. content-type) are preserved.
    res.headers.set('x-correlation-id', ctx.correlation_id);
    return res;
  };
}
