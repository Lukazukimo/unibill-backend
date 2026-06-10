/**
 * errors.ts — typed error classes for middleware short-circuits.
 *
 * Ref: T-125, spec §4.2 / §4.2.1
 * Date: 2026-06-10
 *
 * These are the failure modes the cross-cutting middlewares emit. Callers
 * `instanceof`-check them to map to HTTP responses or to decide whether to
 * push to a DLQ vs. swallow + retry.
 */

export class CircuitOpenError extends Error {
  readonly resource_type: string;
  readonly resource_key: string;

  constructor(resource_type: string, resource_key: string, reason?: string | null) {
    super(
      `circuit open for ${resource_type}:${resource_key}${reason ? ` (${reason})` : ''}`,
    );
    this.name = 'CircuitOpenError';
    this.resource_type = resource_type;
    this.resource_key = resource_key;
  }
}

export class RateLimitError extends Error {
  readonly resource_type: string;
  readonly resource_key: string;
  readonly limit: number;

  constructor(resource_type: string, resource_key: string, limit: number) {
    super(`rate limit exceeded for ${resource_type}:${resource_key} (limit=${limit})`);
    this.name = 'RateLimitError';
    this.resource_type = resource_type;
    this.resource_key = resource_key;
    this.limit = limit;
  }
}

export class NoProviderAvailableError extends Error {
  readonly chain: string[];
  readonly lastError: Error | null;

  constructor(chain: string[], lastError: Error | null) {
    super(`no provider available in chain [${chain.join(', ')}]`);
    this.name = 'NoProviderAvailableError';
    this.chain = chain;
    this.lastError = lastError;
  }
}

export class ChainOpenError extends Error {
  readonly chain_name: string;

  constructor(chain_name: string) {
    super(`chain '${chain_name}' is open — all providers tripped`);
    this.name = 'ChainOpenError';
    this.chain_name = chain_name;
  }
}
