# Mobile scoped classification design

**Date:** 2026-10-30  
**Status:** Proposed  
**Extends:** `2026-10-30-mobile-transaction-editing-design.md`

## Intent

Make phone classification edits behave like desktop classification edits. A household member should be able to choose whether a category/subcategory change applies to one transaction, the current and future matching transactions, or matching past/current/future transactions. The phone must use the same matching and rule behavior as the Mac rather than creating a second categorization system.

The default whenever the phone editor opens is past and future (`↔`). The selection is not persisted between visits, browser restarts, or devices.

## User experience

The phone classification editor adds the same three compact scope controls used on desktop:

- `1×` — this transaction only (`one_time`)
- `→` — this transaction and future matches (`future`)
- `↔` — matching past, current, and future transactions (`past_and_future`)

Each icon has an accessible label and a visible explanation of the selected behavior. The editor starts on `↔` each time it opens. It may retain a changed selection while that editor remains open, but closing/reopening resets it to `↔`.

Cash withdrawals always use `1×`, matching desktop financial-safety behavior. The scope controls are disabled for a withdrawal and explain why. Clearing a category to Uncategorized is also one-time because FinTracka cannot create a rule whose destination is no category.

Pending proposals display their requested scope. Replacing a pending proposal submits the currently selected category, subcategory, and scope as a new command.

## Chosen implementation

Introduce `transaction.set_classification/v2`. Version 2 adds a required `scope` field with one of the three existing desktop values. Version 1 remains readable and processable as `one_time` so already-created commands and receipts remain valid.

This is preferred over a second rule-specific command because category, subcategory, scope, optimistic revision, idempotency, replacement, and status remain one user action. It is preferred over silently changing v1 because command payload digests and permanent local receipts must retain stable historical meaning.

## Cloud command contract

Version 2 request and claimed-command payloads add:

```json
{
  "command_type": "transaction.set_classification",
  "command_version": 2,
  "scope": "past_and_future"
}
```

The canonical payload digest for v2 covers `category_id`, `subcategory_id`, and `scope`. The v1 digest algorithm remains unchanged.

Public command responses expose `scope`; a v1 command is presented as `one_time`. Capability negotiation advertises versions 1 and 2. The phone submits v2 only when both the published snapshot and authenticated session advertise v2.

D1 continues to store only stable IDs, scope, revisions, state, timestamps, and safe results. It receives no merchant, description, account name, amount, Plaid identifier, or rule-matching text.

## Mac application behavior

The processor validates the target's observed classification revision before making any change. A stale revision produces the existing conflict result and creates no rule.

For v1, processing stays exactly as it is today: atomic one-time category/subcategory assignment.

For v2:

1. Validate taxonomy and optimistic revision.
2. Calculate the effective scope. Withdrawals and Uncategorized are forced to `one_time`.
3. Apply category learning through the same domain behavior used by the desktop:
   - `one_time`: current transaction only, no rule.
   - `future`: current transaction plus create/update the learned rule.
   - `past_and_future`: create/update the learned rule and reclassify eligible historical matches.
4. Apply the optional subcategory through the desktop subcategory-rule behavior. If the transaction has no usable merchant, the existing desktop fallback makes the subcategory one-time even when the category rule is learned.
5. Reconcile savings/financial mutations for every affected transaction.
6. Write the permanent mobile receipt in the same SQLite transaction.
7. Publish one refreshed remote snapshot after the batch.

The new orchestration must call shared domain functions or extract their shared internals; it must not copy matching algorithms into the mobile service. The entire v2 operation—including rule changes, historical reclassification, reconciliation, audit records, and receipt—is one SQLite transaction.

The command result includes the final target classification/revision plus requested/effective scope and affected transaction count. No transaction descriptions or financial amounts are returned.

## Safety and idempotency

- The permanent receipt key remains the command ID.
- A retried command with the same ID must return the stored result without reapplying rules or transactions.
- A command ID whose version/payload digest/actor differs from its receipt remains a hard processing failure.
- Historical matches with manual classifications retain the desktop protection and are not overwritten.
- Archived, tombstoned, or withdrawal matches are excluded exactly as on desktop.
- Scope cannot widen after submission; replacement creates a new immutable command and supersedes the old pending command.
- Mobile editing remains disabled until v2 tests, deployment, authenticated reconciliation, and idempotency checks pass.

## Rollout

1. Add v2 contract/model/store tests while retaining v1 tests.
2. Add Mac processor tests for all scopes, forced one-time cases, stale revisions, rule updates, historical manual protection, and replay.
3. Add phone tests for default `↔`, all icons, no persistence, withdrawal/Uncategorized fallback, replacements, and capability fallback.
4. Deploy the Worker and Viewer with v1+v2 support while the Mac processor remains disabled.
5. Publish a v2-capable snapshot.
6. Submit one harmless `1×` command and verify exact-once processing.
7. Submit one controlled `↔` command for a merchant whose expected matches are known; verify affected transactions and learned rules against desktop behavior.
8. Only then enable/install the once-per-minute processor.

## Non-goals

- Editing amounts, dates, merchants, accounts, owners, transfers, archives, or splits from the phone.
- Creating arbitrary rule conditions on the phone.
- Persisting or synchronizing the last selected scope.
- Allowing learned rules for cash withdrawals.
- Replacing the local Mac ledger as the source of truth.

## Approaches considered

1. **Versioned unified command (chosen):** add scope to v2 and keep v1 compatibility. This preserves immutable receipts and one coherent edit lifecycle.
2. **Separate rule command:** submit one classification command and a second rule command. Rejected because partial success could leave classification and learning inconsistent.
3. **Change v1 in place:** reinterpret existing v1 payloads. Rejected because it would change the meaning of stored payload digests and receipts.

## Acceptance criteria

- Phone editor opens with `↔` selected and never reads/writes scope storage.
- `1×`, `→`, and `↔` match desktop outcomes for the same transaction.
- Withdrawals and Uncategorized visibly/effectively use one-time.
- v1 commands continue to apply once.
- v2 scope is covered by payload integrity, replay safety, and optimistic revision checks.
- Category/subcategory rule creation and historical updates commit atomically with the receipt.
- No additional financial or provider data enters D1.
- The processor is not enabled until both one-time and past/future production reconciliation tests pass.
