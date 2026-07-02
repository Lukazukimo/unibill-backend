# ADR-0006: Adopt Zod for Edge Function request validation

- **Status:** Accepted
- **Date:** 2026-07-02
- **Deciders:** Unibill backend maintainers

> Format: [Nygard ADR](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
> (Status / Context / Decision / Consequences), extended with an explicit
> **Alternatives considered** section in the spirit of [MADR](https://adr.github.io/madr/).
> ADRs are immutable once Accepted — supersede with a new ADR instead of editing.

## Context

The design spec (§4.2.1, §9.6, §E) prescribed [Zod](https://zod.dev) for request
body validation in the Edge Functions. The implementation instead validated **by
hand** — a deliberate, code-documented choice ("Zod-style validation done by hand
to avoid pulling zod for a single shape") made when there was only one small
function.

That choice held up until the API surface grew to ~15 functions. Two costs
surfaced:

1. **Three-way duplication.** Each function re-encodes the same request shape
   three times — the runtime validator (`validate*Body`), the TypeScript type,
   and the OpenAPI contract — with no single source keeping them in sync.
2. **No schemas to introspect.** T-625 could not do the spec's `zod-to-openapi`
   step because there were zero Zod schemas in the repo, so `docs/openapi.yaml`
   had to be hand-authored from §E — reintroducing the very drift risk Zod
   avoids.

## Decision

We will **adopt Zod (v4, `npm:zod@^4`, pinned to major 4 in the `deno.jsonc`
imports map) as the single source of truth** for Edge Function request
validation: one schema yields runtime validation, the TypeScript type
(`z.infer`), and — in a later slice — the OpenAPI contract (`z.toJSONSchema`;
OpenAPI 3.1 is JSON-Schema-based, so no extra library is needed).

Migration is **incremental — one function per PR** — and each migrated validator
keeps an **identical external contract**: same HTTP status codes and the same
field-level `422 details` payload, with the existing test suite green at every
step. A thin `_shared/zodError.ts` adapter maps `ZodError.issues` back to the
repo's `{ field, message }[]` shape so no client-visible behaviour changes.
Schemas live in `_shared/schemas/<domain>.ts`.

This supersedes the informal status quo (the hand-written `validate*Body`
pattern and its "no Zod" rationale). The pilot is `invitations-redeem`
(`redeemBodySchema`); the remaining functions and the `gen_openapi.ts` rewrite
follow in later PRs tracked by issue #265.

## Consequences

- **Easier:** one schema per shape — validation, types, and docs stop drifting;
  `gen_openapi.ts` can eventually derive `openapi.yaml` entirely from schemas;
  less bespoke validation code to review.
- **Harder / cost:** this is the repo's **first library dependency** (the core
  was zero-lib by design). Zod enters the Deno module graph, materialised under
  `node_modules` via `nodeModulesDir: auto`. (`deno.lock` is gitignored per repo
  convention, so CI resolves the latest `4.x` from the `^4` range.) There is a
  small convention/learning cost.
- **Risk & mitigation:** a bad migration could silently change a validation
  contract. Mitigated by (a) migrating one function per PR with the existing
  tests as the regression net, (b) the `zodIssuesToErrors` adapter preserving
  the `{ field, message }` 422 payload for every scalar/object body (the pilot
  added tests pinning the exact `details` array, not just pass/fail — an array
  body, which is invalid input, is the one deliberate, more-correct divergence:
  it now returns the whole-body message), and (c) pinning Zod to major 4 (`^4`)
  so no breaking API change lands unbidden.

## Alternatives considered

- **Keep the hand-written validators** — zero dependencies, but perpetuates the
  three-way duplication and blocks `zod-to-openapi`. Rejected now that the API
  surface makes the duplication a real maintenance cost.
- **Zod 3 + `@asteasolutions/zod-to-openapi`** — the classic combo, but needs
  `extendZodWithOpenApi` + a registry and an extra dependency. Rejected in
  favour of Zod 4's native `z.toJSONSchema`, which targets OpenAPI 3.1 directly.
- **Another validator (valibot / typebox / arktype)** — all viable, some with
  smaller footprints, but Zod is what the spec named and has the richest
  ecosystem and OpenAPI story. No reason to diverge from the spec here.
