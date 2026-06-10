# Unibill backend Makefile (T-103).
#
# This Makefile is the canonical entry point for backend developer workflows.
# CI invokes the same targets so that local and remote behaviour stay in sync.
#
# Conventions:
#   - All Supabase CLI invocations rely on the version pinned in .tool-versions.
#   - Environment selection (`dev` vs `prod`) is explicit per target; there is
#     intentionally no "default" deploy target to avoid foot-guns.
#   - Targets that touch production require SUPABASE_PROJECT_REF_PROD and a
#     confirmation prompt from the operator (handled by the Supabase CLI).

SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

# ---------------------------------------------------------------------------
# Configurable knobs (override via `make VAR=value <target>` or environment).
# ---------------------------------------------------------------------------
SUPABASE ?= supabase
DENO ?= deno

# Project refs come from the environment (CI secrets locally exported via
# direnv or asdf). They are intentionally not hard-coded.
DEV_PROJECT_REF ?= $(SUPABASE_PROJECT_REF_DEV)
PROD_PROJECT_REF ?= $(SUPABASE_PROJECT_REF_PROD)

.PHONY: help db-reset db-push-dev db-push-prod test-db \
        functions-serve functions-deploy lint format seed

help: ## Show this help message.
	@awk 'BEGIN {FS = ":.*##"; printf "Unibill backend Makefile targets:\n\n"} \
	      /^[a-zA-Z_-]+:.*##/ { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 }' \
	      $(MAKEFILE_LIST)

# ---------------------------------------------------------------------------
# Database lifecycle
# ---------------------------------------------------------------------------

db-reset: ## Reset the local Supabase stack and re-apply all migrations + seeds.
	$(SUPABASE) db reset

db-push-dev: ## Push pending migrations to the linked dev project.
	@if [ -z "$(DEV_PROJECT_REF)" ]; then \
	  echo "error: SUPABASE_PROJECT_REF_DEV is not set"; exit 1; \
	fi
	$(SUPABASE) db push --linked

db-push-prod: ## Push pending migrations to the linked prod project (requires explicit confirmation).
	@if [ -z "$(PROD_PROJECT_REF)" ]; then \
	  echo "error: SUPABASE_PROJECT_REF_PROD is not set"; exit 1; \
	fi
	@echo ">>> About to push migrations to PRODUCTION ($(PROD_PROJECT_REF))."
	@echo ">>> Re-run with CONFIRM=yes in env to bypass interactive prompts in CI."
	$(SUPABASE) db push --linked

test-db: ## Run pgTAP test suite (./supabase/tests/) against the local stack.
	$(SUPABASE) test db

# ---------------------------------------------------------------------------
# Edge Functions
# ---------------------------------------------------------------------------

functions-serve: ## Serve Edge Functions locally with hot reload.
	$(SUPABASE) functions serve --env-file ./supabase/.env.local

functions-deploy: ## Deploy a single Edge Function: `make functions-deploy FUNC=<name>`.
	@if [ -z "$(FUNC)" ]; then \
	  echo "error: pass FUNC=<function-name>"; exit 1; \
	fi
	$(SUPABASE) functions deploy $(FUNC)

# ---------------------------------------------------------------------------
# Lint / format (Deno is the source of truth for TypeScript in Edge Functions)
# ---------------------------------------------------------------------------

lint: ## Lint Edge Functions and shared TypeScript helpers.
	$(DENO) lint supabase/functions

format: ## Format Edge Functions and shared TypeScript helpers in place.
	$(DENO) fmt supabase/functions

# ---------------------------------------------------------------------------
# Seeds
# ---------------------------------------------------------------------------

seed: ## Apply ./supabase/seeds/*.sql against the local database (idempotent).
	$(SUPABASE) db reset --no-seed
	@for f in supabase/seeds/*.sql; do \
	  if [ -f "$$f" ]; then \
	    echo "applying seed: $$f"; \
	    $(SUPABASE) db query --file "$$f"; \
	  fi; \
	done
