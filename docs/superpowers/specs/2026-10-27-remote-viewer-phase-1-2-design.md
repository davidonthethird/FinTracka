# FinTracka Remote Viewer Product Phases 1–2 Design

**Status:** Approved direction, implementation not started  
**Date:** 2026-10-27  
**Source proposal:** `/Users/david/Downloads/FinTracka_One_Way_Remote_Viewer_Implementation_Proposal.md`

## Intent

FinTracka will gain a private, mobile-first, read-only viewer for David and Ariela. The Mac and its SQLite database remain the only authoritative ledger. The Mac publishes a sanitized snapshot outward to Cloudflare; Cloudflare never connects inward to the Mac and never mutates local financial data.

The first workable end product includes both product phases:

1. **Hosted read-only viewer:** Overview, Transactions, Planning, Savings, and Reports, protected by Cloudflare Access and showing honest freshness information.
2. **Automatic snapshot synchronization:** the same publisher used manually in Phase 1 runs when FinTracka starts, after successful bank syncs, and every 60 minutes while the Mac is awake.

Phase 1 is not a throwaway prototype. Its snapshot contract, publisher, cloud storage, viewer API, and UI are the production foundation used unchanged by Phase 2.

## Goals

- Preserve the current local application and SQLite ledger as the source of truth.
- Show all five requested read-only areas on iPhone, tablet, and desktop.
- Publish only explicitly allowed fields and locally calculated financial read models.
- Keep the last valid remote snapshot available through failed or interrupted publication attempts.
- Authenticate people and the Mac publisher separately.
- Use a single publication operation for manual, startup, post-sync, and scheduled triggers.
- Make stale data obvious using source-capture, last-bank-sync, and cloud-publication timestamps.
- Allow credentials to be revoked and remote snapshots to be purged without the Mac application being publicly reachable.

## Non-goals

- No remote edits, categorization, connection management, bank sync controls, or administrative mutations.
- No tunnel, port forwarding, public FastAPI host, or remote access to localhost.
- No off-device backup claim; the viewer snapshot is a disposable read replica.
- No background publication when the Mac is powered off or its Keychain is locked.
- No per-edit two-minute debounce in this release. Startup, post-sync, hourly, and manual triggers are sufficient.
- No raw Plaid/Google payloads, secrets, access tokens, full account numbers, audit payloads, or free-form transaction notes.
- No D1 schema until measured snapshot size or browser performance proves a complete-object snapshot insufficient.

## Approaches Considered

### Selected: Versioned R2 snapshot plus active manifest

The Mac uploads one validated JSON snapshot to a unique R2 object key. After that succeeds, the Publisher Worker conditionally replaces a small `active.json` manifest. The Viewer Worker reads the manifest and then the referenced immutable snapshot. R2 provides strongly consistent reads and conditional writes, so the active pointer cannot expose a partial object.

This is the smallest design that provides safe interrupted-upload behavior, idempotency, rollback protection, and simple purge/revocation. It also avoids rewriting the financial data into a second database schema.

### Deferred: Normalized D1 read replica

D1 would provide server-side filtering and pagination but duplicates many local financial shapes, adds migrations and activation transactions, and creates more parity work. Upgrade only if the representative snapshot exceeds 5 MiB uncompressed, browser filtering is measurably slow on a supported iPhone, or the transaction history requirement grows beyond the bounded release scope.

### Rejected: Proxy or tunnel to the local FastAPI application

This would expose a mutation-capable local application and make remote availability depend on the Mac being continuously reachable. It violates the one-way trust boundary.

## Architecture

```text
Local SQLite (authoritative)
        │ read-only transaction
        ▼
RemoteSnapshotV1 builder
        │ exact same serialized payload
        ▼
RemotePublisher service
        │ Cloudflare Access service token over HTTPS
        ▼
Publisher Worker ──► versioned private R2 object
        │ validate, hash, sequence check
        └──────────► conditional active.json switch
                              │
                              ▼
Viewer Worker protected by Cloudflare Access
        │ GET only, Cache-Control: no-store
        ▼
Mobile read-only React viewer
```

There are two Workers and two Access applications:

- **Publisher Worker:** accepts only service-token-authenticated publication and purge requests. Strict Service Auth is required.
- **Viewer Worker:** accepts only approved human identities with MFA through an exact Cloudflare Access allowlist. Production and preview routes are both protected and verified before live use.

Neither Worker receives Plaid, Google, SQLite, macOS, or local session credentials.

## Snapshot Contract

`RemoteSnapshotV1` is the sole boundary between the local and remote systems. It contains:

- `schema_version = 1`
- `snapshot_id`
- monotonically increasing `source_sequence`
- `captured_at`, overall/per-connection source freshness, and requested history boundaries
- six months of sanitized transaction detail
- twelve months of locally precomputed aggregate/trend data where Planning, Savings, or Reports need longer history
- Overview read models by available month
- Planning read models for windows `1` through `12` and owner scopes `all, David, Ariela, Shared`
- Savings combined and optional owner/pool read models
- Reports cash flow, category, owner, and mobile flow read models
- record counts and SHA-256 digest metadata

Allowed transaction fields are limited to display identifiers, date, amount in integer minor units, currency, merchant/description, category/subcategory, owner, pending status, institution/account display label, and masked last four digits when available.

The builder excludes archived/excluded transfers and all local-only control fields unless a displayed result requires them. It never includes credentials, provider transaction identifiers, raw payloads, full account numbers, audit records, browser/session tokens, or free-form notes.

The serialized payload must be deterministic, valid UTF-8 JSON, no larger than 5 MiB uncompressed, and built inside a consistent read transaction. The snapshot builder itself performs no financial mutation.

## Publication Semantics

One shared `publish_remote_snapshot()` operation performs every publication regardless of trigger:

1. Acquire a dedicated remote-publication single-flight lock.
2. Reserve the next local source sequence and create a metadata-only run record.
3. Build and validate `RemoteSnapshotV1` from a consistent SQLite read.
4. POST the exact serialized payload with the Access service token and content digest.
5. Publisher Worker rejects unsupported schema, unexpected fields, excessive size, digest mismatch, non-monotonic sequence, and malformed money/date values.
6. Write `snapshots/<snapshot_id>.json` using create-once semantics.
7. Re-read/validate the stored object metadata.
8. Conditionally replace `active.json` only when the new sequence is greater than the active sequence.
9. Retain the active snapshot and one prior valid snapshot; clean older versions only after activation.
10. Record success/failure metadata locally without storing a financial payload in logs.

Repeating the same snapshot ID and digest is an idempotent success. A lower/equal sequence with different content is rejected. Recovery from a restored older local database requires an explicit remote purge/reset followed by a new publication; rollback is never silent.

## Product Phase 1: Hosted Read-only Viewer

Phase 1 includes the production-shaped snapshot builder, manual publisher, both Workers, private R2 storage, Cloudflare Access, and all five read-only screens.

- Bottom navigation contains Overview, Transactions, Planning, Savings, and Reports.
- Transactions support in-memory search, month/category/owner/account filters, bounded pagination, and a details drawer.
- Planning shows local targets, actuals, historical averages, remaining amounts, owner splits, and category drill-downs without edit controls.
- Savings shows combined balances by default, optional owner/pool splits, goal progress, monthly/overall views, and activity without mutation controls.
- Reports use mobile-readable category bars/flow summaries and detail drawers; desktop may retain the larger flow chart.
- Every screen displays freshness and coverage information.
- The app does not use service workers, IndexedDB, localStorage, or persistent browser caches for financial data.

Phase 1 initially publishes representative synthetic data manually. Live household publication is not enabled merely because the viewer works.

## Product Phase 2: Automatic Snapshot Synchronization

Phase 2 connects callers to the unchanged publication operation:

- **Startup:** queue one publication after the startup bank-sync job, or immediately when no bank sync is due.
- **Successful bank sync:** publish only after every requested connection sync completes successfully; a failed/repair-required sync leaves the last remote snapshot active and records the failure.
- **Periodic:** a separate opt-in macOS LaunchAgent runs `fintracka remote publish --reason scheduled` every 60 minutes while the user session and Keychain are available.
- **Manual:** Settings and CLI provide Publish now, status, preview, schedule management, and remote purge.

Concurrent triggers collapse through one lock. Failures never block local finance work, alter ledger facts, or deactivate the last good remote snapshot. Retries use bounded backoff only within a single run; the next trigger safely tries again.

## Local Configuration and Secrets

- Publisher URL, viewer URL, history length, enablement, schedule state, and metadata-only run status may be stored in SQLite.
- Access Client ID and Client Secret are stored only in macOS Keychain under environment-specific references.
- Cloudflare account credentials, Wrangler API tokens, Access policy credentials, and R2 credentials never enter SQLite, browser storage, source control, GitHub Actions, or application logs.
- CI uses only synthetic fixtures and local Worker/R2 fakes.

## Security and Privacy Controls

- Cloudflare Access protects production and preview Worker routes.
- Viewer Access policy must match the exact configured allowlist; Publisher requires strict Service Auth. The Worker does not duplicate Cloudflare's authentication implementation.
- Viewer accepts only `GET`, `HEAD`, and `OPTIONS`; Publisher accepts only its explicit publication/purge operations.
- Responses use CSP, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and frame denial.
- Logs contain snapshot IDs, sequence numbers, counts, timings, status, and error codes only.
- Remote purge deletes the active manifest and every versioned snapshot. Provider recovery/time-travel behavior must be disclosed; purge must not promise immediate physical erasure outside Cloudflare's documented guarantees.
- A lost phone is handled by revoking its human Access session/identity. A compromised publisher token is rotated/revoked in Access and macOS Keychain.

## Acceptance

The combined Phase 1–2 release is complete when:

- All five screens match local synthetic fixtures exactly in integer minor units.
- A manually published snapshot remains available with the Mac powered off.
- Startup, post-sync, hourly, and manual triggers all call the same publisher and do not duplicate or regress snapshots.
- Interrupted upload, timeout, digest failure, invalid schema, stale sequence, concurrent trigger, locked Keychain, and R2 activation failure preserve the last good snapshot.
- Viewer and Publisher deny unauthenticated, wrong-identity, wrong-method, preview-host, and malformed requests.
- No secret or forbidden field appears in snapshot JSON, browser persistence, logs, errors, artifacts, or CI.
- Real iPhone testing covers supported widths, accessibility, logout, stale data, slow network, and Mac-off viewing.
- Representative synthetic output remains below 5 MiB and performs acceptably; otherwise the D1 upgrade is designed before live data.
- Live data remains gated on explicit household privacy approval, staging verification, credential revocation/purge drills, and a current review of applicable Plaid terms.

## Platform References

- [Cloudflare R2 consistency and conditional writes](https://developers.cloudflare.com/r2/reference/consistency/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Access for Workers and `ctx.access`](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- [Cloudflare Access service tokens and strict Service Auth](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
