# ADR-0002: Flutter over React Native for mobile

- **Status:** Accepted
- **Date:** 2026-06-08
- **Deciders:** Unibill maintainers

> Spec refs: §3.2.

## Context

The MVP ships a mobile app (iOS + Android) maintained by one developer. We want a
single codebase, strong static typing, a testable state-management story, a solid
local database for offline-first invoice browsing, and good visual-regression
tooling — without doubling the work across two native platforms.

## Decision

We will build the app in **Flutter (Dart)** using the VGV layered architecture,
`flutter_bloc`/Cubit for state, and Drift for the local database. State changes go
through Cubits (not `setState`) even in leaf widgets, for testability and to avoid
lifecycle footguns.

## Consequences

- **Easier:** one codebase for both platforms; Dart's sound typing catches errors
  at compile time; excellent tooling; golden tests pin visual regressions across
  light/dark × pt/en; Cubit makes state unit-testable.
- **Harder / risks:** Dart is less ubiquitous than JavaScript (smaller hiring/
  contributor pool); larger baseline app size; some platform features need
  plugins or platform channels.

## Alternatives considered

- **React Native** — large JS ecosystem, but weaker typing without strict
  TypeScript discipline, historic bridge/perf friction, and a more fragmented
  navigation/state landscape.
- **Native iOS + Android** — best per-platform UX, but ~2× the implementation and
  maintenance cost for a solo project.
- **PWA / web-first** — deferred to Phase 2; background email/IMAP processing and
  mobile UX expectations are weaker in a PWA.
