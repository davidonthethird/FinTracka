# Bank Integration Plan

## Scope

Only accounts, balances, and transactions are permitted. Payment initiation, account/routing details, Identity, Auth, Investments, Liabilities, and Transfer products are prohibited.

## Plaid lifecycle

FinTracka supports two fixed credential profiles, **David** and **Ariela**, in one shared ledger. Each profile may use a different Plaid developer account and environment. A connection permanently records the selected profile; sync, repair, and revocation always load that profile's credentials and never fall back to the other profile.

1. The user selects David or Ariela. Backend creates a Link token with that profile's credentials, `products=[transactions]`, `transactions.days_requested=730`, US country, one stable local user ID, and no webhook. This applies only when creating a new Item; existing Items retain their original history window.
2. React opens Plaid Link. The public token is posted once to the backend.
3. Backend exchanges it with the same selected profile, stores the access token in macOS Keychain, and stores only the profile, Keychain reference, and Item metadata in SQLite.
4. Initial `/transactions/sync` starts without a cursor. All pages must complete before data and `next_cursor` commit together.
5. Update mode repairs `ITEM_LOGIN_REQUIRED` and consent errors.
6. Disconnect calls `/item/remove`, deletes the Keychain secret, and preserves local imported records.

## Sync pseudocode

```text
original_cursor = stored_cursor
repeat:
    batch = empty
    cursor = original_cursor
    try:
        do:
            page = provider.sync(cursor)
            validate and append page to batch
            cursor = page.next_cursor
        while page.has_more
    except MUTATION_DURING_PAGINATION:
        continue
    break

begin immediate
apply all account, balance, added, modified, and removed records
preserve user-owned transaction fields
save cursor
commit
```

## Pending and posted records

- When Plaid supplies `pending_transaction_id`, attach both external IDs to one canonical transaction.
- If no explicit relationship exists, create a review candidate using account, amount, date window, and description; never silently merge ambiguous records.
- Provider modifications update provider-owned facts and append a version row.

## Failure policy

- Retry HTTP 429 and transient 5xx/network failures with exponential backoff, jitter, and five attempts.
- Do not retry authentication, revoked access, invalid request, or unsupported-product errors.
- An interrupted pre-commit sync leaves both ledger and cursor unchanged.
- A missing or invalid profile affects only that profile's connections; other profiles continue syncing. The run finishes as failed when any connection fails so the problem remains visible.
- Dashboard status exposes sanitized provider code, last success, and repair action.

## Alternative providers

- SimpleFIN adapter claims a one-time setup token, stores the credential-bearing access URL in Keychain, and syncs overlapping 90-day windows no more than provider limits allow.
- Teller remains unimplemented until a coverage or pricing decision requires it.

## Live-data gate

Before the first Production Link session, the application checks Python 3.14, FileVault, Keychain availability, Plaid Production configuration, and a verified local backup. It creates and verifies the backup before requesting the Link token. The missing off-device backup is an accepted testing warning, not a blocker.

Production Link, first sync, repair, and disconnect are available from Connections. Disconnect revokes Plaid access, removes the local access token, and retains imported records. Start with one institution, compare imported accounts and balances, reconcile one statement to the cent, and observe the connection for seven days before adding another institution.

Each developer account has its own Plaid Trial limits and approval status; using Ariela's credentials does not change or evade those provider-controlled terms. FinTracka counts connected Items, not bank accounts within an Item. Investments remain out of scope, so Fidelity or Pershing retirement holdings will not import unless this product decision is revisited separately.
