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
