# Immediate Receipt Review Before Mac Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Let David or Ariela review a Cloud Pro receipt and assign each line to David, Ariela, or Shared immediately on the iPhone, while keeping the Mac as the final verification gate before transaction matching or financial effects.

**Architecture:** Extend the existing receipt queue handoff instead of creating a parallel system. Shortcut version 5 saves the current private iCloud package, then sends the same OCR text and Cloud Pro result to the existing one-time import endpoint. The existing import page promotes that result into the existing receipt draft editor. The handoff links to the draft and blocks matching until the Mac rebuilds the same canonical capture from iCloud and confirms its digest.

**Tech Stack:** TypeScript, React, Cloudflare Worker, D1/SQLite, Vitest, Python 3, Apple Shortcuts plist generation, Shortcuts Playground validation/signing.

**Spec:** docs/superpowers/specs/2026-11-16-immediate-receipt-review-design.md

## Global Constraints

- Preserve all existing receipt data and unrelated dirty-worktree changes.
- Receipt photos stay in private shared iCloud; only OCR text and the Cloud Pro structured result may be uploaded.
- Use the existing one-time member-bound receipt session token. Never put a persistent credential in the Shortcut.
- Reuse receipt_shortcut_capture/v2, receipt interpretation validation, the existing receipt draft editor, and existing David/Ariela/Shared buttons.
- A provisional receipt must not be matchable and must not affect transactions, planning, savings, or reports.
- Keep the current Mac-only fallback working if the direct iPhone upload fails.
- Keep one canonical Shortcut named FinTracka Receipt Scanner; do not create numbered copies.
- Add no new runtime dependency.
- For every money, security, parser, state-machine, or retry branch, write the focused failing test first.
- Do not claim physical success until camera and photo-library tests pass on an actual iPhone and the Mac verification transition is observed.

## Review Focus

- One-time token secrecy and replay handling.
- Exact D1 state transitions under retries and partial failures.
- No path from provisional draft to transaction matching.
- Direct and iCloud captures use identical canonicalization.
- Existing owner choices remain unchanged by Mac verification.
- Shortcut actions contain no empty required parameter, dangling variable, import question, callback URL, or persistent secret.

---

## Task 1: Add the reviewable handoff state and draft link

**Files:**

- Create: remote/migrations/0009_receipt_immediate_review.sql
- Modify: remote/src/receiptQueueHandoffStore.ts
- Modify: remote/src/receiptQueueHandoffGateway.ts
- Modify: remote/tests/receipt-queue-handoff-store.test.ts
- Modify: remote/tests/receipt-queue-handoff-gateway.test.ts

- [ ] Write failing store tests for this state machine:
  - pending -> reviewable stores the provisional import ID and canonical body digest.
  - linking a household-owned draft stores draft_id exactly once.
  - reviewable -> processing -> completed preserves draft_id and import_id.
  - a replay with the same IDs and digest succeeds idempotently.
  - a changed import, draft, member, or digest fails closed.
  - a legacy handoff with no provisional import still follows the current completion path.
- [ ] Write failing gateway tests showing that a reviewable handoff returns status ready, its import review path, and verification_status pending; a linked draft returns the draft path; a failed handoff returns only a safe error code.
- [ ] Add migration 0009 by recreating receipt_queue_handoffs with:
  - status check including reviewable;
  - nullable draft_id referencing receipt_drafts(id) with ON DELETE SET NULL;
  - the current unique/session/member/import constraints and indexes preserved.
- [ ] Add markReviewableBySession, linkDraft, and verification lookup methods to ReceiptQueueHandoffStore; keep current active-ID ordering and seven-day expiration.
- [ ] Make start() accept pending or reviewable, and make browser serialization expose navigation readiness separately from verification state.
- [ ] Run focused tests:

    npm --prefix remote test -- receipt-queue-handoff-store.test.ts receipt-queue-handoff-gateway.test.ts

- [ ] Commit:

    git add remote/migrations/0009_receipt_immediate_review.sql remote/src/receiptQueueHandoffStore.ts remote/src/receiptQueueHandoffGateway.ts remote/tests/receipt-queue-handoff-store.test.ts remote/tests/receipt-queue-handoff-gateway.test.ts
    git commit -m "feat: add reviewable receipt handoffs"

## Task 2: Connect direct upload to the existing queue handoff

**Files:**

- Modify: remote/src/receiptShortcutGateway.ts
- Modify: remote/src/receiptShortcutStore.ts
- Modify: remote/src/mobileGateway.ts
- Modify: remote/src/receiptShortcutModel.ts
- Modify: remote/tests/receipt-shortcut-gateway.test.ts
- Modify: remote/tests/receipt-shortcut-store.test.ts

- [ ] Write failing tests proving that:
  - a valid receipt_shortcut_capture/v2 direct upload consumes the one-time token, creates one import, and marks the matching handoff reviewable;
  - retrying the exact body returns the same import and state;
  - a different body after token consumption returns a conflict;
  - the upload cannot mark a handoff owned by another member;
  - body size, strict schema, content type, session expiry, and active-import limits remain enforced;
  - a direct upload without an advertised queue handoff keeps legacy behavior.
- [ ] Return the canonical body digest and session digest from the existing ReceiptShortcutStore.createImport result instead of reparsing the request in the gateway.
- [ ] Pass ReceiptQueueHandoffStore into handleReceiptShortcutUpload and call markReviewableBySession only after the import transaction succeeds.
- [ ] Keep /api/v1/mobile/shortcut/receipt-imports outside Cloudflare Access user authentication, protected only by its current single-use bearer token and strict request validation.
- [ ] Add a same-origin endpoint POST /api/v1/mobile/receipt-imports/:id/draft with body { "draft_id": "<uuid>" }; verify household/member ownership of both import and draft before linking.
- [ ] Map only stable safe error codes; do not return tokens, raw bodies, or model text in errors.
- [ ] Run focused tests:

    npm --prefix remote test -- receipt-shortcut-gateway.test.ts receipt-shortcut-store.test.ts receipt-queue-handoff-store.test.ts

- [ ] Commit:

    git add remote/src/receiptShortcutGateway.ts remote/src/receiptShortcutStore.ts remote/src/mobileGateway.ts remote/src/receiptShortcutModel.ts remote/tests/receipt-shortcut-gateway.test.ts remote/tests/receipt-shortcut-store.test.ts remote/tests/receipt-queue-handoff-store.test.ts
    git commit -m "feat: publish provisional receipt results"

## Task 3: Promote the import into the existing receipt editor

**Files:**

- Modify: frontend/src/viewer/receipts/receiptShortcutApi.ts
- Modify: frontend/src/viewer/receipts/ReceiptShortcutImportPage.tsx
- Modify: frontend/src/viewer/receipts/ReceiptCapturePage.tsx
- Modify: frontend/src/viewer/receipts/ReceiptInboxPage.tsx
- Modify: frontend/tests/receipt-shortcut-pages.test.tsx
- Modify: frontend/tests/receipt-pages.test.tsx

- [ ] Write failing component tests proving that:
  - a reviewable handoff navigates to the existing import page before Mac completion;
  - finalizeReceiptImport creates the existing draft, links it to the import/handoff, then deletes the temporary import in that order;
  - if linking fails, deterministic draft creation replays safely and the import remains for retry;
  - owner buttons remain the existing David, Ariela, and Shared controls;
  - capture and inbox copy distinguish immediate review from later Mac verification.
- [ ] Add linkReceiptImportDraft(importId, draftId) to receiptShortcutApi.ts.
- [ ] Change import finalization so cleanup happens only after the new link call succeeds. Do not add another receipt draft format or editor.
- [ ] Update ReceiptCapturePage to describe the direct structured upload, private-photo boundary, Mac verification, and fallback accurately.
- [ ] Update inbox labels to Ready to assign, Waiting for Mac verification, Verified, and Verification failed using the handoff's public verification status.
- [ ] Run focused tests:

    npm --prefix frontend test -- receipt-shortcut-pages.test.tsx receipt-pages.test.tsx

- [ ] Commit:

    git add frontend/src/viewer/receipts/receiptShortcutApi.ts frontend/src/viewer/receipts/ReceiptShortcutImportPage.tsx frontend/src/viewer/receipts/ReceiptCapturePage.tsx frontend/src/viewer/receipts/ReceiptInboxPage.tsx frontend/tests/receipt-shortcut-pages.test.tsx frontend/tests/receipt-pages.test.tsx
    git commit -m "feat: review receipt before Mac verification"

## Task 4: Block matching until verification completes

**Files:**

- Modify: remote/src/receiptStore.ts
- Modify: remote/src/receiptGateway.ts
- Modify: remote/src/mobileGateway.ts
- Modify: remote/tests/mobile-gateway.test.ts
- Modify: remote/tests/receipt-store.test.ts
- Modify: frontend/src/viewer/receipts/types.ts
- Modify: frontend/src/viewer/receipts/ReceiptReviewPage.tsx
- Modify: frontend/src/viewer/receipts/ReceiptMatchPanel.tsx
- Modify: frontend/tests/receipt-pages.test.tsx

- [ ] Write failing server tests proving that linked drafts expose read-only verification metadata and that matching returns RECEIPT_NOT_VERIFIED for reviewable, processing, or failed handoffs.
- [ ] Write failing UI tests proving that:
  - the existing editor remains usable while verification is pending;
  - owner choices survive save, refresh, and reload;
  - the match panel is replaced by a clear verification banner until completion;
  - failed verification keeps the draft inspectable and dismissible but not matchable.
- [ ] Extend PublicReceiptDraft with read-only verification data derived by joining receipt_queue_handoffs.draft_id; do not put verification state inside the client-editable receipt_draft/v1 body or its digest.
- [ ] Add one server-side verification assertion immediately before submitReceiptMatch; UI gating is advisory only.
- [ ] Keep the existing rule that no spending changes until the explicit receipt split command is applied.
- [ ] Run focused tests:

    npm --prefix remote test -- mobile-gateway.test.ts receipt-store.test.ts
    npm --prefix frontend test -- receipt-pages.test.tsx

- [ ] Commit:

    git add remote/src/receiptStore.ts remote/src/receiptGateway.ts remote/src/mobileGateway.ts remote/tests/mobile-gateway.test.ts remote/tests/receipt-store.test.ts frontend/src/viewer/receipts/types.ts frontend/src/viewer/receipts/ReceiptReviewPage.tsx frontend/src/viewer/receipts/ReceiptMatchPanel.tsx frontend/tests/receipt-pages.test.tsx
    git commit -m "feat: gate receipt matching on verification"

## Task 5: Make Mac completion verify the same capture instead of creating a duplicate

**Files:**

- Modify: remote/src/receiptQueueHandoffStore.ts
- Modify: remote/src/receiptQueueHandoffGateway.ts
- Modify: remote/tests/receipt-queue-handoff-store.test.ts
- Modify: remote/tests/receipt-queue-handoff-gateway.test.ts
- Modify: src/fintracka/receipt_refinement_service.py
- Modify: tests/test_receipt_refinement_service.py

- [ ] Write failing tests for both completion branches:
  - provisional branch: the Mac canonical capture digest equals the direct digest, so the same linked draft becomes verified without changing its receipt body or owners;
  - mismatch branch: a different canonical digest returns CAPTURE_MISMATCH, marks verification failed, retains the draft, and never creates a second import;
  - fallback branch: no provisional result exists, so the Mac creates the current import exactly once and returns its review path;
  - response-loss replay is idempotent in every branch.
- [ ] Update ReceiptQueueHandoffStore.complete to compare canonical digests when body_digest already exists; only call createQueuedImport for the no-direct-upload fallback.
- [ ] Add CAPTURE_MISMATCH to the bounded queue failure codes and safe UI mapping.
- [ ] Keep the Python processor package format unchanged. It should continue sending the same normalized single-route capture expected by the server; adjust only fields required to make direct and queued canonicalization identical.
- [ ] Confirm the processor removes an iCloud package only after an idempotent successful completion response.
- [ ] Run focused tests:

    npm --prefix remote test -- receipt-queue-handoff-store.test.ts receipt-queue-handoff-gateway.test.ts
    pytest -q tests/test_receipt_refinement_service.py

- [ ] Commit:

    git add remote/src/receiptQueueHandoffStore.ts remote/src/receiptQueueHandoffGateway.ts remote/tests/receipt-queue-handoff-store.test.ts remote/tests/receipt-queue-handoff-gateway.test.ts src/fintracka/receipt_refinement_service.py tests/test_receipt_refinement_service.py
    git commit -m "feat: verify provisional receipts on Mac"

## Task 6: Build one canonical Shortcut version 5

**Files:**

- Rename: scripts/build-receipt-shortcut-v4.py -> scripts/build-receipt-shortcut-v5.py
- Rename: scripts/verify-receipt-shortcut-v4.py -> scripts/verify-receipt-shortcut-v5.py
- Modify: shortcuts/FinTracka Receipt Scanner.plist
- Create: shortcuts/FinTracka Receipt Scanner.shortcut
- Modify: frontend/src/viewer/receipts/receiptShortcutApi.ts
- Modify: remote/src/receiptShortcutGateway.ts
- Modify: frontend/tests/receipt-shortcut-pages.test.tsx
- Modify: docs/receipt-shortcut-setup.md
- Create: docs/receipt-shortcut-v5-actions.md
- Create: docs/receipt-shortcut-v5-physical-matrix.md
- Delete after replacement is verified: docs/receipt-shortcut-v4-actions.md
- Delete after replacement is verified: docs/receipt-shortcut-v4-physical-matrix.md

- [ ] Write failing frontend/session tests for receipt_immediate_handoff/v1, shortcut_version 5, its three-line Shortcut input, and the unchanged canonical Shortcut name.
- [ ] Generate one version-5 Shortcut with these ordered sections:
  1. two required provenance/safety comments;
  2. strict three-line input validation for contract, handoff UUID, and 43-character token;
  3. camera or multi-photo-library selection bounded to 1–12 pages;
  4. per-page HEIF save and one Apple Vision OCR pass;
  5. one fixed Cloud Pro call using the existing evidence-bound JSON prompt;
  6. complete private iCloud package and manifest save;
  7. one Get Contents of URL POST to the fixed production endpoint with Content-Type application/json, Authorization Bearer one-time token, and exact receipt_shortcut_capture/v2 JSON;
  8. a final result explaining whether immediate review was published or the Mac fallback remains queued.
- [ ] Ensure the direct upload is after the private package is complete so a network failure cannot lose the receipt.
- [ ] Do not add an import question for URL, model, folder path, or credentials except the existing private shared iCloud queue folder selection if Shortcuts requires it.
- [ ] Make the verifier assert:
  - one canonical workflow name and one Cloud Pro action;
  - no empty required action parameter or dangling action-output reference;
  - exact static HTTPS origin and upload path;
  - Authorization comes from the validated one-time input token;
  - no Access credential, service token, API key, clipboard action, callback URL, JavaScript action, shell action, or second model route;
  - package files and direct JSON derive from the same OCR/model action outputs;
  - all control-flow groups are complete and commented;
  - the direct request occurs only after manifest.txt is saved.
- [ ] Run the Shortcuts Playground validation loop, stopping after at most five iterations and after the same validation error repeats twice:

    python3 scripts/build-receipt-shortcut-v5.py
    python3 /Users/david/.codex/plugins/cache/shortcuts-playground/shortcuts-playground/1.2.1/skills/shortcuts-playground/scripts/validate_shortcut.py "shortcuts/FinTracka Receipt Scanner.plist"
    python3 scripts/verify-receipt-shortcut-v5.py "shortcuts/FinTracka Receipt Scanner.plist"
    plutil -lint "shortcuts/FinTracka Receipt Scanner.plist"

- [ ] Sign the exact validated plist and confirm the output is non-empty:

    /Users/david/.codex/plugins/cache/shortcuts-playground/shortcuts-playground/1.2.1/skills/shortcuts-playground/scripts/sign_shortcut.sh "shortcuts/FinTracka Receipt Scanner.plist" "shortcuts/FinTracka Receipt Scanner.shortcut"
    test -s "shortcuts/FinTracka Receipt Scanner.shortcut"

- [ ] Update setup/action/physical-test documentation from the generated action inventory, not from memory.
- [ ] Commit:

    git add scripts/build-receipt-shortcut-v5.py scripts/verify-receipt-shortcut-v5.py "shortcuts/FinTracka Receipt Scanner.plist" "shortcuts/FinTracka Receipt Scanner.shortcut" frontend/src/viewer/receipts/receiptShortcutApi.ts remote/src/receiptShortcutGateway.ts frontend/tests/receipt-shortcut-pages.test.tsx docs/receipt-shortcut-setup.md docs/receipt-shortcut-v5-actions.md docs/receipt-shortcut-v5-physical-matrix.md
    git add -u scripts docs
    git commit -m "feat: add immediate receipt review shortcut"

## Task 7: Automated integration, deployment, and physical acceptance

**Files:**

- Modify if a regression is found: only files already listed above
- Update after observed results: docs/receipt-shortcut-v5-physical-matrix.md
- Update: README.md

- [ ] Run the targeted suites together:

    npm --prefix remote test -- receipt-shortcut-gateway.test.ts receipt-shortcut-store.test.ts receipt-queue-handoff-store.test.ts receipt-queue-handoff-gateway.test.ts mobile-gateway.test.ts receipt-store.test.ts
    npm --prefix frontend test -- receipt-shortcut-pages.test.tsx receipt-pages.test.tsx
    pytest -q tests/test_receipt_refinement_service.py

- [ ] Run the meaningful repository gates used by CI:

    npm --prefix remote run typecheck
    npm --prefix frontend run typecheck
    npm --prefix remote test
    npm --prefix frontend test
    pytest -q

- [ ] Inspect git diff --check, git status --short, and the exact diff; confirm unrelated user changes are untouched.
- [ ] Deploy the D1 migration before the Worker code, then deploy the viewer. Confirm production session creation returns version 5 and the one-time upload endpoint rejects requests without a valid bearer token.
- [ ] On David's iPhone, delete the old canonical Shortcut, import the newly signed canonical Shortcut, answer its folder question once, and confirm there is exactly one FinTracka Receipt Scanner.
- [ ] Run the physical matrix with the Mac processor stopped:
  - one clear single-page receipt from the photo library;
  - one camera receipt;
  - one multi-page or long receipt;
  - verify each opens in FinTracka immediately after Cloud Pro finishes;
  - assign a mixture of David, Ariela, and Shared; save; close and reopen FinTracka; verify choices persist;
  - verify matching remains unavailable.
- [ ] Start the Mac processor and wait through one scheduled minute. Confirm the same drafts become verified, owner choices are unchanged, and matching becomes available.
- [ ] Disable the direct request in a local/staging fixture only, run a scan, and confirm the saved iCloud package still appears through the Mac fallback without duplicate imports.
- [ ] Repeat the canonical install and one camera/photo-library smoke test on Ariela's iPhone.
- [ ] Record observed timestamps, handoff status transitions, and pass/fail results in the physical matrix. Do not write passed for an unobserved device path.
- [ ] Request code review, resolve findings, and rerun every affected check.
- [ ] Commit documentation evidence:

    git add README.md docs/receipt-shortcut-v5-physical-matrix.md
    git commit -m "docs: record immediate receipt review acceptance"

## Task 8: Final integration gate

- [ ] Confirm no provisional receipt can reach transaction.apply_receipt_split.
- [ ] Confirm direct-upload body and queued-package body produce the same canonical digest for the physical test receipt.
- [ ] Confirm no receipt photo exists in Worker logs, D1, R2, request fixtures, or browser state.
- [ ] Confirm one-time tokens are absent from logs, UI responses after creation, docs, plist comments, and committed fixtures.
- [ ] Confirm the Shortcut direct-upload failure still leaves a complete private iCloud package.
- [ ] Confirm Mac verification changes only verification state and never owner/category selections.
- [ ] Confirm version-4 sessions remain readable during rollout and version 5 is the only newly advertised session.
- [ ] Confirm the production viewer, Worker, Mac scheduler, and canonical signed Shortcut versions are recorded in README.md.
- [ ] Only after all automated and physical checks pass, create the PR, wait for CI, merge, deploy the merge commit, and rerun one production receipt scan from the web app.

## Execution Choice

Use **Native execution** for this plan. The state-machine, Worker, viewer, Mac, and Shortcut changes share one contract and should be implemented sequentially in a single context. Subagent-driven execution would add coordination overhead without creating independent workstreams.
