#!/usr/bin/env -S deno run --allow-read --allow-write
// =============================================================================
// scripts/gen_openapi.ts
// -----------------------------------------------------------------------------
// Emit `docs/openapi.yaml` (OpenAPI 3.1) for the user-facing & admin Edge
// Functions. Request bodies that have a Zod schema (invitations-redeem,
// emails-connect, emails-rotate) are DERIVED from it via `z.toJSONSchema`
// (#265 / ADR-0006), so those bodies can't drift from the runtime validator.
// The remaining endpoints (no Zod schema — query-param, path-only, or bodies
// not yet migrated) and all responses are authored from spec Appendix §E.
//
// Mirrors the other generators: --check (CI drift, exit 1 on diff), --out.
// Task: T-625 (#160) + gen-from-Zod follow-up. Spec refs: §E.
// Date: 2026-07-02
// =============================================================================

import { stringify } from 'jsr:@std/yaml@^1';
import { z } from 'zod';
import { redeemBodySchema } from '../supabase/functions/_shared/schemas/invitations.ts';
import {
  connectEmailBodySchema,
  rotateEmailBodySchema,
} from '../supabase/functions/_shared/schemas/emails.ts';

// deno-lint-ignore no-explicit-any
type Json = any;

const bearer = [{ bearerAuth: [] as string[] }];

function err(description: string): Json {
  return {
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  };
}

function ok(description: string, properties: Json, required: string[] = []): Json {
  return {
    description,
    content: {
      'application/json': {
        schema: { type: 'object', properties, ...(required.length ? { required } : {}) },
      },
    },
  };
}

function jsonBody(properties: Json, required: string[] = []): Json {
  return {
    required: true,
    content: {
      'application/json': {
        schema: { type: 'object', properties, ...(required.length ? { required } : {}) },
      },
    },
  };
}

/**
 * Derives an OpenAPI requestBody schema from a Zod schema (`#265` / ADR-0006) so
 * the documented request shape can never drift from the runtime validator.
 * Uses `io: 'output'` because the schemas normalize (`.transform`) before
 * validating, so the length/pattern constraints live on the output side; input
 * mode would erase them. `unrepresentable: 'any'` lets a field whose validation
 * isn't expressible in JSON Schema (e.g. the `household_ids` dedup superRefine)
 * through as `{}`, which `overrides` then replaces with a hand-written shape.
 */
function zodBody(schema: z.ZodType, overrides: Record<string, Json> = {}): Json {
  const jsonSchema = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }) as Json;
  delete jsonSchema.$schema;
  if (Object.keys(overrides).length > 0) {
    jsonSchema.properties = { ...jsonSchema.properties, ...overrides };
  }
  return { required: true, content: { 'application/json': { schema: jsonSchema } } };
}

const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

/** Derives a stable camelCase operationId, e.g. GET /emails/{id} → getEmailsId. */
function makeOperationId(method: string, path: string): string {
  const pascal = path
    .split('/')
    .filter(Boolean)
    .map((seg) =>
      seg
        .replace(/[{}]/g, '')
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join('')
    )
    .join('');
  return method + pascal;
}

/** Injects an operationId into every operation (satisfies redocly + client codegen). */
function withOperationIds(doc: Json): Json {
  for (const [path, ops] of Object.entries(doc.paths as Record<string, Json>)) {
    for (const [method, op] of Object.entries(ops as Record<string, Json>)) {
      op.operationId = makeOperationId(method, path);
    }
  }
  return doc;
}

/** Builds the OpenAPI 3.1 document from the §E contracts. */
export function buildOpenApiDoc(): Json {
  const doc = {
    openapi: '3.1.0',
    info: {
      title: 'Unibill backend API',
      version: '0.1.0',
      description: 'User-facing & admin Edge Functions (spec §E). Internal workers ' +
        '(sync/extraction/capacity, cron-invoked) are not part of the public API. ' +
        'Request bodies with a Zod schema are derived from it (z.toJSONSchema); ' +
        'the rest are authored from §E.',
      license: { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
    },
    servers: [{
      url: 'https://<project-ref>.supabase.co/functions/v1',
      description: 'Supabase Edge Functions',
    }],
    security: bearer,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Supabase user JWT (or service_role for admin/internal calls).',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: { error: { type: 'string' }, detail: { type: 'string' } },
          required: ['error'],
        },
      },
    },
    paths: {
      '/config/resolve': {
        get: {
          summary: 'Resolve a config key via the app_settings cascade',
          parameters: [{ name: 'key', in: 'query', required: true, schema: { type: 'string' } }],
          responses: {
            '200': ok('Resolved value + the scope it came from', {
              value: {},
              scope_resolved_from: {
                type: 'string',
                enum: ['user', 'household', 'global', 'default'],
              },
            }),
            '401': err('missing/invalid JWT'),
            '404': err('key does not exist'),
          },
        },
      },
      '/emails/connect': {
        post: {
          summary: 'Connect a Gmail (IMAP) mailbox',
          // household_ids' dedup superRefine isn't expressible in JSON Schema —
          // override it with the documented array/uuid shape.
          requestBody: zodBody(connectEmailBodySchema, {
            household_ids: {
              type: 'array',
              minItems: 1,
              items: { type: 'string', format: 'uuid' },
            },
          }),
          responses: {
            '200': ok('Connected', {
              connected_email_id: { type: 'string', format: 'uuid' },
              household_bindings: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    household_id: { type: 'string', format: 'uuid' },
                    is_default: { type: 'boolean' },
                  },
                },
              },
            }),
            '401': err('IMAP authentication failed'),
            '409': err('email already connected by another user'),
            '422': err('validation failed'),
          },
        },
      },
      '/emails/{id}/rotate-password': {
        patch: {
          summary: 'Rotate the stored app password (owner only)',
          parameters: [idParam],
          requestBody: zodBody(rotateEmailBodySchema),
          responses: {
            '200': ok('Rotated', { rotated_at: { type: 'string', format: 'date-time' } }),
          },
        },
      },
      '/emails/{id}': {
        delete: {
          summary: 'Soft-delete a connected email (owner or sys admin)',
          parameters: [idParam],
          responses: { '200': ok('Soft-deleted', { soft_deleted: { type: 'boolean' } }) },
        },
      },
      '/invitations/redeem': {
        post: {
          summary: 'Redeem a household invitation code',
          requestBody: zodBody(redeemBodySchema),
          responses: {
            '200': ok('Joined household', {
              household_id: { type: 'string', format: 'uuid' },
              role: { type: 'string', enum: ['member'] },
            }),
            '403': err('invited_email does not match'),
            '404': err('invalid or expired code'),
            '429': err('rate limited'),
          },
        },
      },
      '/admin/promote-system-admin': {
        post: {
          summary: 'Grant/revoke system-admin (sys admin only)',
          requestBody: jsonBody({
            target_user_id: { type: 'string', format: 'uuid' },
            grant: { type: 'boolean' },
            reason: { type: 'string' },
          }, ['target_user_id', 'grant', 'reason']),
          responses: {
            '200': ok('Done', {
              success: { type: 'boolean' },
              audit_id: { type: 'string', format: 'uuid' },
            }),
            '403': err('caller is not a system admin'),
            '422': err('cannot demote the last system admin'),
          },
        },
      },
      '/admin/invoices/{id}/reextract': {
        post: {
          summary: 'Re-queue an invoice for extraction (sys admin or household member)',
          parameters: [idParam],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: { type: 'object', properties: { force: { type: 'boolean' } } },
              },
            },
          },
          responses: {
            '200': ok('Queued', {
              queued: { type: 'boolean' },
              idempotency_key: { type: 'string' },
            }),
          },
        },
      },
      '/privacy/export-my-data': {
        post: {
          summary: "Export the caller's personal data (LGPD, 1/day)",
          responses: {
            '200': ok('Export ready', {
              download_url: { type: 'string' },
              expires_at: { type: 'string', format: 'date-time' },
            }),
            '413': err('export exceeds 500MB'),
            '429': err('rate limited (1/day)'),
          },
        },
      },
      '/privacy/my-account': {
        delete: {
          summary: "Delete the caller's account (LGPD right to erasure)",
          requestBody: jsonBody({
            confirmation_email: { type: 'string', format: 'email' },
            reason: { type: 'string' },
          }, ['confirmation_email']),
          responses: {
            '200': ok('Deletion completed', { deletion_initiated: { type: 'boolean' } }),
            '400': err('confirmation_email mismatch'),
            '422': err('caller is the last admin of a household'),
          },
        },
      },
      '/telemetry/ingest': {
        post: {
          summary: 'Ingest client telemetry (consent-gated, redacted)',
          requestBody: jsonBody({
            events: {
              type: 'array',
              maxItems: 50,
              items: {
                type: 'object',
                properties: {
                  event_type: { type: 'string' },
                  severity: { type: 'string' },
                  payload: { type: 'object' },
                },
                required: ['event_type', 'payload'],
              },
            },
          }, ['events']),
          responses: { '200': ok('Ingested', { ingested: { type: 'integer' } }) },
        },
      },
      '/health': {
        get: {
          summary: 'Health probe (public; service_role bearer adds internal metrics)',
          security: [],
          responses: {
            '200': ok('Healthy or degraded', {
              status: { type: 'string', enum: ['ok', 'degraded', 'down'] },
              timestamp: { type: 'string', format: 'date-time' },
              db_ok: { type: 'boolean' },
              queue_depths: { type: 'object' },
              ai_chain_state: { type: 'string' },
              capacity_status: { type: 'string' },
              last_sync_run_minutes_ago: { type: 'integer' },
            }, ['status', 'timestamp']),
            '503': ok('Down', {
              status: { type: 'string', enum: ['down'] },
              timestamp: { type: 'string', format: 'date-time' },
            }, ['status', 'timestamp']),
          },
        },
      },
    },
  };
  return withOperationIds(doc);
}

const HEADER = '# Generated by scripts/gen_openapi.ts from spec §E — do not edit by hand.\n' +
  '# Regenerate: deno run --allow-read --allow-write scripts/gen_openapi.ts\n';

function render(): string {
  return HEADER + stringify(buildOpenApiDoc(), { lineWidth: 100 });
}

async function main(): Promise<void> {
  const argv = Deno.args;
  let out = 'docs/openapi.yaml';
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) out = argv[++i];
    else if (argv[i] === '--check') check = true;
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log('Usage: gen_openapi.ts [--out docs/openapi.yaml] [--check]');
      Deno.exit(0);
    } else {
      console.error(`Unknown argument: ${argv[i]}`);
      Deno.exit(2);
    }
  }
  const next = render();
  if (check) {
    let existing = '';
    try {
      existing = await Deno.readTextFile(out);
    } catch {
      console.error(`[gen_openapi] '${out}' missing — run without --check.`);
      Deno.exit(1);
    }
    if (next !== existing) {
      console.error(`[gen_openapi] DIFF in '${out}'. Run without --check.`);
      Deno.exit(1);
    }
    console.log(`[gen_openapi] OK — '${out}' up to date.`);
    return;
  }
  await Deno.writeTextFile(out, next);
  const n = Object.keys(buildOpenApiDoc().paths).length;
  console.log(`[gen_openapi] Wrote '${out}' (${n} paths).`);
}

if (import.meta.main) {
  await main();
}
