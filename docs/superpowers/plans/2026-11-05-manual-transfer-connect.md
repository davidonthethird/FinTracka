# Manual Transfer Connect Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a manual exact transfer-pair picker that reuses FinTracka's existing confirmed-transfer learning for history and future delayed matches.

**Architecture:** The ledger owns eligibility and learned-pattern matching. A read-only API route exposes eligible counterpart transactions, while the existing confirmation route performs the write. The desktop React register adds one focused dialog and no new persistence layer.

**Tech Stack:** Python 3.12, SQLite, FastAPI, React 18, TypeScript, Vitest.

---

### Task 1: Ledger eligibility and delayed learned matches

**Files:**
- Modify: `tests/test_financial_integrity.py`
- Modify: `src/fintracka/ledger.py`

- [ ] Write failing tests proving an exact opposite pair more than three days apart appears in manual match options, while same-account, same-sign, pending, archived, rejected, and already-confirmed transactions do not.
- [ ] Write a failing test proving the ordinary review strip still excludes a five-day pair.
- [ ] Write a failing test proving a confirmed account-and-counterparty signature auto-confirms a later five-day pair but not unrelated equal-amount Zelles.
- [ ] Run the focused tests and confirm the expected failures.
- [ ] Implement `transfer_match_options` and refactor candidate generation so learned matching uses a 14-day window sorted closest-first while public review remains three days.
- [ ] Run the focused tests and commit the ledger change.

### Task 2: Match-options API

**Files:**
- Modify: `tests/test_api.py`
- Modify: `src/fintracka/api.py`

- [ ] Write a failing route test for `GET /api/v1/transfers/{transaction_id}/matches`, including account details, closest-date ordering, and missing-anchor validation.
- [ ] Run the focused test and confirm the expected failure.
- [ ] Add the read-only route using normal `TransactionResponse` serialization.
- [ ] Run the focused API tests and commit the API change.

### Task 3: Transactions manual-connect dialog

**Files:**
- Create: `frontend/src/transactions/TransferConnectDialog.tsx`
- Create: `frontend/tests/transfer-connect-dialog.test.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`

- [ ] Write failing component tests for loaded choices, selection/confirmation, empty state, and server error.
- [ ] Run the focused test and confirm the expected failure.
- [ ] Implement the accessible dialog, using the match endpoint and existing confirmation endpoint.
- [ ] Add **Connect transfer** to the selection toolbar, enabled only for one transaction, and clear selection/refresh after success.
- [ ] Add responsive styles that fit the existing FinTracka design.
- [ ] Run the focused frontend test and commit the UI change.

### Task 4: Full verification and integration handoff

**Files:**
- Verify only unless a test exposes a defect.

- [ ] Run all Python tests.
- [ ] Run all frontend tests.
- [ ] Run the production frontend build.
- [ ] Review the diff for financial integrity, unsafe broad matching, accidental schema changes, and unrelated edits.
- [ ] Push the feature branch and create a pull request according to the project's standing Git workflow preference.
