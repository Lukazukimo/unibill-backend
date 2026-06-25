# ADR-0005: Apache 2.0 over MIT / AGPL

- **Status:** Accepted
- **Date:** 2026-06-08
- **Deciders:** Unibill maintainers

> Spec refs: §2.1 (open source). See also [LICENSE](../../LICENSE), T-623.

## Context

Unibill is released as open source. We want broad, friction-free adoption and
contribution, an explicit patent grant for legal clarity, and we are **not** trying
to defend against closed-source SaaS competitors — it is a personal/community
project, not a commercial product needing copyleft protection.

## Decision

We will license the project under the **Apache License 2.0**. Copyright is held by
"Unibill Contributors". The LICENSE file is the verbatim official Apache 2.0 text
so license scanners (incl. GitHub's) detect it correctly.

## Consequences

- **Easier:** permissive use and contribution; an explicit patent grant and a
  trademark clause give more legal certainty than MIT; widely understood by
  individuals and companies.
- **Harder / risks:** more verbose than MIT; no copyleft, so a fork may go
  closed-source — an acceptable trade-off given the project's goals.

## Alternatives considered

- **MIT** — minimal and popular, but grants no explicit patent rights, leaving a
  small patent-litigation gap Apache 2.0 closes.
- **AGPL-3.0** — network copyleft would force SaaS forks to publish source, but it
  deters adoption, contribution, and corporate use — overkill for a personal app.
- **BSL / SSPL (source-available)** — protect against hosted competitors but are
  not OSI-approved open-source licenses, contradicting the §2.1 open-source goal.
