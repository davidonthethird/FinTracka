# FinTracka Long-Term Architecture Guardrails

These guardrails apply to every future feature plan, implementation, review, and migration. They preserve financial correctness while allowing the phone experience to grow beyond the current read-only viewer.

## Authority domains

FinTracka has three explicit authority domains:

1. **Financial ledger — Mac SQLite.** Committed transactions, balances, categories, Planning values, Savings allocations, reports, provider checkpoints, and financial audit history are authoritative only after they are validated and committed on the Mac.
2. **Proposed financial changes — cloud command service.** A mobile financial edit is authoritative only as a command lifecycle record: pending, applied, rejected, conflicted, cancelled, or expired. Its proposed financial value is never presented as committed ledger state before the Mac applies it.
3. **Non-financial collaboration — cloud storage.** Shopping lists, wishes, and unmatched receipt drafts may be authoritative in the cloud so they remain useful while the Mac is off. They cannot create transactions, alter balances, or claim that funds were saved or spent.

The R2 viewer snapshot is a selective read replica. It is neither a command queue nor a disaster-recovery backup.

## Mobile financial command boundary

Build one narrow, typed command system that can support transaction categorization first and later Savings, Planning, and planned-income edits.

Every command must have:

- a stable command ID, household ID, authenticated actor/member ID, and idempotency key;
- a named, versioned type such as `transaction.set_category/v1`;
- a stable target entity ID and the revision observed by the phone;
- a strictly validated command-specific payload;
- creation, expiration, cancellation, application, and result timestamps where applicable;
- an auditable status and safe conflict/error code;
- server-enforced authorization for that exact command type.

The cloud stores and serves command state. The Mac pulls commands, revalidates them against current ledger state, applies each command at most once inside a database transaction, records the financial audit event, acknowledges the result, and publishes a refreshed snapshot.

Never expose arbitrary SQL, arbitrary resource patching, archiving, account removal, Plaid credentials, provider checkpoints, raw restore, or unrestricted rules through this boundary.

## Identity and authorization

- Give David and Ariela stable internal member IDs. Display names are editable labels, not identities.
- `Shared` is a financial attribution, not an authenticated actor.
- Map Cloudflare Access identity to a household member on the server. Never trust a member ID supplied only by browser JavaScript.
- Authorize every command and collaboration operation server-side, using least privilege.
- Keep high-risk administration local unless a separately reviewed design explicitly expands it.

## Resource separation

- Receipt drafts are not transactions. A confirmed match creates or updates canonical transaction splits only after Mac validation.
- Shopping wishes are not Savings balances. Link a wish to a Savings goal rather than copying its funded balance.
- Planned income, future contributions, and shopping estimates never create bank activity.
- AI output is a suggestion with provenance and confidence, not an accepted category. Manual decisions and explicit rules outrank it.
- Gamification state remains outside the financial ledger and cannot fabricate balances or savings.
- Cloud command status remains separate from read-only snapshot data, even if the phone overlays a clearly labeled pending value.

## Contracts and compatibility

- Version financial snapshots, commands, receipt drafts, lists, and uploads independently.
- Publish a capability manifest so the phone knows which command and resource versions the current Mac supports.
- Support rolling deployment: an older Mac, Worker, or phone UI must fail closed or hide unsupported actions rather than corrupt data.
- Preserve stable canonical transaction IDs across pending-to-posted provider transitions.
- Continue using integer minor units and deterministic rounding for every financial calculation.

## Storage and recovery

- Use transactional structured storage for commands and collaborative metadata. Confirm service cost and limits at design time.
- Use object storage only for immutable snapshots and encrypted binary objects such as receipt images; do not use it as a transactional queue.
- Encrypt sensitive receipt images before durable cloud storage under an explicitly reviewed key and recovery design.
- Reuse the verified SQLite backup path for off-device backups; never copy a live database unsafely.
- Establish tested, encrypted off-device recovery before enabling durable receipt-image storage or broad mobile Savings, Planning, and income mutation.
- Keep recovery credentials separate from the encrypted backup and document how Keychain-held provider secrets are restored or reconnected.

## Preserve proven local invariants

Future work should extend, not replace, these existing safeguards:

- optimistic `updated_at` revision checks for stale-write detection;
- effective-dated Planning and planned-income versions;
- append-only Savings ledger entries and explicit reversals;
- provider checkpoints and exact-once transaction import behavior;
- canonical external-ID alias handling for pending-to-posted transactions;
- immutable, sequence-controlled remote snapshots;
- strict local session, CSRF, Host, and Origin checks;
- synthetic-data tests for financial behavior.

Do not rewrite the application as a general event-sourcing or distributed-database system merely to add mobile editing.

## Required design review checklist

Before implementing a roadmap feature, its approved design must answer:

1. Which authority domain owns each new record and each lifecycle state?
2. Is any displayed number committed, proposed, planned, estimated, or collaborative-only?
3. Which stable identity acts, and what server-side permission authorizes it?
4. What revision or idempotency mechanism prevents stale or duplicate application?
5. What is the versioned contract, and how do mixed-version components fail safely?
6. Can it double-count money, duplicate a Savings balance, or invent a transaction?
7. What happens while the Mac is off, during interruption, and after retry?
8. What audit, conflict, undo/reversal, expiry, and cancellation behavior exists?
9. What secrets or sensitive images are stored, where, and under which recovery model?
10. Does it introduce recurring cost, new provider permissions, or a new recovery obligation?
11. Are financial tests performed with synthetic data and exact cent reconciliation?
12. Does the feature preserve all existing invariants listed above?

If a design cannot answer these questions, implementation pauses until the boundary is explicit.
