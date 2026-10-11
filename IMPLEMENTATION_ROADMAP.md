# Implementation Roadmap

## Phase 0: planning package

Deliver the ten cross-linked design documents and the executable Superpowers implementation plan. Exit when there are no placeholders or conflicting conventions.

## Phase 1: synthetic ledger vertical slice

Create migrations, exact money/date/ID types, repositories, provider-neutral sync application, three-institution synthetic data, overview/account/transaction APIs, minimal React shell, and backup command. Exit when repeat sync is idempotent and the UI totals match repository queries.

## Phase 2: financial integrity

Add CSV preview/commit, pending/posting aliases, provider versions/tombstones, rules, splits, transfer candidates/confirmation, refunds/reversals, audit events, and reconciliation. Exit when all fault-injection and edge-behavior tests pass.

## Phase 3: Plaid Sandbox

Add Link session/exchange, Keychain storage, Transactions Sync pagination/checkpoints, repair/revoke, and connection UI. Exit on repeated synthetic Sandbox mutation scenarios with no duplicates. No production connection.

## Phase 4: budgets and reports

Implement separate Tracking and Envelope pages/services plus required reports. Exit when every displayed aggregate reconciles to transaction-level fixture calculations.

## Phase 5: spreadsheet integration

Implement deterministic Excel workbook and Google Sheets snapshot publishing. Exit on repeat/update/delete, formula-injection, and interrupted-export tests.

## Phase 6: automation and hardening

Add launchd installation, catch-up sync, localhost session/CSRF/CSP controls, recovery drill, dependency audit, sensitive-log scan, and implementation-grounded threat model. Exit on complete backend/frontend/Playwright verification.

## Phase 7: live rollout

Outside current execution authority. Reconfirm provider pricing/coverage and obtain explicit approval before any production token or real financial record is used.

## First milestone

The first code milestone is the synthetic ledger kernel: migrations, money/date/ID normalization, provider-neutral batch application, fixture generator, and tests for repeat sync, modification/removal, pending-to-posted preservation, and atomic rollback.

