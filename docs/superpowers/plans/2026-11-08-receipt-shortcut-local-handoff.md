# Receipt Shortcut Local Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Shortcut's direct upload with a privacy-preserving clipboard handoff that the authenticated FinTracka page imports.

**Architecture:** The Shortcut emits a versioned text-only envelope to the local clipboard and never calls the network. The browser reads that envelope only after a user tap and posts it to a same-origin endpoint that consumes the existing one-time scan session.

**Tech Stack:** React, TypeScript, Cloudflare Workers/D1, Vitest, Playwright, Python plist tests, Apple Shortcuts plist.

**Spec:** `docs/superpowers/specs/2026-11-08-receipt-shortcut-local-handoff-design.md`

## Global Constraints

- Receipt images never leave Apple processing.
- No new dependency or third-party service.
- Keep legacy direct-upload compatibility during migration.
- The canonical Shortcut name remains `FinTracka Receipt Scanner`.

## Review Focus

- Malformed or unrelated clipboard content shows a recoverable error without consuming a session.
- Expired or replayed tokens remain rejected.
- Oversized clipboard payloads are rejected before storage.
- Clipboard access denied by Safari leaves the scan recoverable.
- Successful import clears the clipboard and navigates exactly once.

---

### Task 1: Same-origin browser completion endpoint

**Files:**
- Modify: `remote/src/receiptShortcutGateway.ts`
- Modify: `remote/tests/receipt-shortcut-gateway.test.ts`

**Interfaces:**
- Consumes: `{ token: string, capture: receipt_shortcut_capture/v3 }`
- Produces: `{ review_path: string }`

- [ ] Add failing gateway tests for valid, malformed, cross-origin, expired, and replayed completion requests.
- [ ] Run the targeted Worker test and verify the new assertions fail.
- [ ] Implement the size-limited, same-origin completion route using the existing store.
- [ ] Run the targeted Worker test and verify it passes.

### Task 2: Browser clipboard import

**Files:**
- Modify: `frontend/src/viewer/receipts/receiptShortcutApi.ts`
- Modify: `frontend/src/viewer/receipts/ReceiptCapturePage.tsx`
- Modify: `frontend/tests/receipt-shortcut-pages.test.tsx`
- Modify: `frontend/e2e/remote-viewer.spec.ts`
- Modify: `frontend/src/viewer/viewer.css`

**Interfaces:**
- Consumes: `fintracka_receipt_handoff/v1` clipboard JSON
- Produces: same-origin completion call and internal review navigation

- [ ] Add failing tests for launch configuration, successful clipboard import, invalid clipboard data, denied clipboard access, cleanup, and navigation.
- [ ] Run the targeted frontend tests and verify they fail for the missing behavior.
- [ ] Implement strict envelope parsing and the explicit import action.
- [ ] Run targeted frontend and Playwright tests and verify they pass.

### Task 3: Network-free canonical Shortcut

**Files:**
- Modify: `shortcuts/FinTracka Receipt Model Comparison.xml`
- Modify: `tests/test_receipt_shortcut_privacy.py`
- Generate: `shortcuts/FinTracka Receipt Scanner.shortcut`

**Interfaces:**
- Consumes: the session token from Shortcut input
- Produces: `fintracka_receipt_handoff/v1` JSON in the clipboard

- [ ] Add failing privacy tests requiring no network action/upload URL and requiring clipboard handoff output.
- [ ] Run the privacy test and verify it fails on the direct-upload action.
- [ ] Replace the upload block with text envelope and Copy to Clipboard actions.
- [ ] Validate the plist, sign the canonical artifact, and verify non-zero output.
- [ ] Run privacy and validator tests and verify they pass.

### Task 4: Full verification and rollout

**Files:**
- Modify only if verification exposes a defect.

- [ ] Run Worker, frontend, Python, typecheck, build, and receipt Playwright verification.
- [ ] Install/replace the canonical Shortcut and test one real receipt on the iPhone.
- [ ] Verify no photo-upload prompt appears and the comparison screen receives both model outputs.
- [ ] Remove superseded duplicate FinTracka receipt shortcuts from the iPhone after the canonical flow passes.
- [ ] Commit, push, open/merge the PR, deploy production with comparison enabled, and verify the deployed endpoints.
