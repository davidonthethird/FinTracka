# FinTracka Live-Testing Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with test-driven development.

**Goal:** Complete FinTracka as a secure localhost application that imports actual bank data through Plaid Trial Production and exports read-only snapshots to Google Sheets.

**Architecture:** Keep SQLite authoritative and route CLI/API/UI actions through the existing services. Keep Plaid and Google credentials in macOS Keychain, use persisted jobs for remote work, and retain the existing strict localhost session boundary.

**Tech Stack:** Python 3.14, FastAPI, SQLite, keyring, plaid-python, Google Python clients, React, TypeScript, Vite, Pytest, Playwright.

**Spec:** `PROJECT_SPEC.md`, `ARCHITECTURE.md`, `SECURITY_PLAN.md`, and the user-approved live-testing plan in this thread.

## Global Constraints

- Bind only to `127.0.0.1`; every mutation requires session, CSRF, Host, and Origin validation.
- Request only Plaid Transactions and use `/accounts/get` for account metadata; never request payment or routing-number products.
- Secrets and OAuth payloads never enter SQLite, Git, browser storage, screenshots, API responses, or logs.
- The missing off-device backup is a visible non-blocking testing warning; FileVault and a verified local pre-link backup remain required.
- CI and automated tests use synthetic data and fakes only.

## Review Focus

- A failed Link completion must revoke the new Plaid Item and remove any partial Keychain secret.
- Sandbox and Production secrets/tokens must never cross environments.
- A retry or interruption must not advance a Plaid cursor without its ledger mutations.
- New remote mutations must enforce the existing localhost session and CSRF boundary.
- Google and Plaid exceptions must not leak credentials or financial payloads.

---

### Task 1: Release baseline

- [ ] Require Python `>=3.14,<3.15`, recreate the environment on 3.14.8, and add synthetic GitHub Actions verification using Node 24.
- [ ] Add Dependabot configuration without repository secrets.

### Task 2: Plaid production services and CLI

- [ ] Add failing tests for environment-separated Keychain configuration, connection completion cleanup, account discovery, repair, revoke, and real sync dispatch.
- [ ] Implement the minimal provider/service/CLI changes and numbered migration.

### Task 3: Plaid API and React Link

- [ ] Add failing API and UI tests for connection sessions, completion, repair, disconnect, sync jobs, CSP, and sanitized responses.
- [ ] Implement the routes, nonce CSP, React Link flow, and connection controls.

### Task 4: Google Sheets

- [ ] Add failing tests for desktop OAuth credential storage and idempotent official-client exports.
- [ ] Implement Keychain-backed Google authorization, workbook creation, export jobs, API routes, and Settings controls.

### Task 5: Scheduling, readiness, and recovery

- [ ] Add failing tests for launchd lifecycle, one catch-up sync, pre-link backup, and readiness warnings/checks.
- [ ] Implement CLI/API/UI behavior and documentation.

### Task 6: Full verification and live handoff

- [ ] Run backend, frontend, Playwright, dependency, integrity, restore, and secret scans.
- [ ] Complete a fresh whole-branch review and fix all Critical/Important findings with RED-to-GREEN tests.
- [ ] Push the branch and create a pull request; credentialed Plaid/Google setup remains local and interactive.
