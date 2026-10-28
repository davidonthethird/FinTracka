# Security notes

FinTracka is a localhost, single-user application. SQLite contains financial records; Plaid and Google secrets remain in macOS Keychain and must never be copied into SQLite, logs, screenshots, browser storage, frontend assets, tests, or Git history.

Savings goals add no new remote service. Goal names, allocations, reviews, and append-only events stay in the local database. The browser stores only the non-secret Savings owner-view preference under `fintracka.savings.ownerSplit`.

Before activating Savings goals on live data:

- verify FileVault and Keychain readiness;
- create and verify a local SQLite backup;
- review the initialization preview without committing it;
- confirm that Regular Savings equals goal balances plus Unallocated and Pending transfer;
- keep Retirement separate and explicitly assigned;
- do not infer or connect Pershing until provider support is reviewed.

Off-device backup remains a visible, accepted testing warning rather than a connection blocker. A lost or destroyed Mac can therefore still cause unrecoverable test-data loss.

The optional remote viewer changes the privacy boundary: Cloudflare stores a sanitized snapshot containing household balances and transaction details. It stores no Plaid/Google token, raw provider payload, note, external provider identifier, or edit capability. The Publisher uses a Keychain-held Access service token; the Viewer uses an exact two-person MFA Access policy; both normal and preview routes must be protected. The R2 bucket has no public endpoint and retains only active plus previous snapshots.

The viewer writes no financial data to localStorage, sessionStorage, IndexedDB, Cache Storage, or a service worker. All responses are `no-store`. Provider logs and physical deletion remain external-service risks, so household approval, staged revocation/purge drills, and current Plaid/Cloudflare terms review are mandatory before live publication. See [REMOTE_VIEWER_RUNBOOK.md](REMOTE_VIEWER_RUNBOOK.md).
