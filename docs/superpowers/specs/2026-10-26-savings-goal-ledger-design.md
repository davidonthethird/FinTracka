# Savings Goal Ledger Design

Date: 2026-10-26
Status: Approved in conversation; builder check complete

## Intent

Turn the existing Savings page from a balance summary into a household savings planner that answers four questions at a glance:

1. How much is saved in total, split between regular savings and retirement?
2. What purpose is the money in the joint savings account reserved for?
3. Are this month's deposits meeting the household's fixed monthly savings plan?
4. How have deposits, withdrawals, spending draws, and investment valuations changed savings over time?

The system must remain an exact, auditable view over real connected balances. Virtual goal buckets must never silently create money or double-count spending and later savings-account withdrawals.

## Existing behavior and constraints

FinTracka currently has:

- connected accounts opted into Savings with locally retained balance history;
- manually valued cash, investment, and other assets;
- monthly savings-account activity classified as contributions, withdrawals, earnings, or expenses;
- David, Ariela, and Shared ownership;
- exact integer minor-unit money values, SQLite migrations, audit events, and optimistic conflict checks;
- Recharts in the frontend, but no reusable icon library.

The current page has no goal hierarchy, virtual allocation ledger, monthly target allocation, month-end review, or reconciliation between goal balances and connected savings.

All functionality remains localhost-only and USD-only. Existing data and audit history must be retained. Pershing receives no provider-specific implementation in this work; it remains blank until it can be connected through an existing supported connection path.

## Goals

- Separate Regular Savings from Retirement while showing one combined household total by default.
- Let users create, edit, archive, reorder, color, and icon savings categories and one level of subcategories.
- Support fixed monthly dollar targets for allocatable savings goals.
- Derive allocation percentages from monthly dollar targets and keep them totaling 100% where a nonzero monthly plan exists.
- Allocate real deposits deterministically: priority order for shortfalls and percentages for excess deposits.
- Seed the existing joint savings balance with $25,000 in Emergency and the remainder in General Savings.
- Treat Roth IRA holdings as Retirement and support separate David and Ariela ownership.
- Deduct linked category spending above the normal Planning target from the corresponding accumulated savings goal.
- Preserve exact reconciliation when a spending draw happens before money physically leaves savings.
- Provide monthly history, goal details, reconciliation warnings, undo, and a month-end underspending review.
- Add consistent category icons throughout the savings UI.

## Non-goals

- No Pershing-specific connection work.
- No investment trading, performance calculation, cost basis, security holdings, or market-price fetching.
- No target dates.
- No backfill of historical virtual savings goals before the activation month.
- No automatic guess about which goal funded an unmatched withdrawal.
- No hard deletion of categories or ledger history that has been used.
- No public hosting, multi-user authentication, or non-USD savings goals.

## Approaches considered

### 1. Audited virtual savings subledger — selected

Store immutable signed savings events for opening allocations, deposits, internal bucket transfers, spending draws, withdrawal settlements, valuation changes, manual corrections, and undo entries. Derive current and monthly balances from those events.

This is the only approach that supports exact reconciliation, historical views that do not change unexpectedly, reversible edits, and prevention of double deductions.

### 2. Recalculate from current transactions and targets

This would add less schema, but historical savings would change when transactions are recategorized or targets are edited. Manual retirement valuations and delayed savings withdrawals would also be unreliable. Rejected.

### 3. Store monthly balance snapshots only

This would make charts easy but would not adequately represent mid-month deposits, priority allocation, partial fills, corrections, or undo. Rejected.

## Domain model

### Savings groups and goals

There are two built-in top-level groups:

- **Regular Savings**: General Savings, Emergency, Shopping, Fun Fund, Vacation, and other user-created goals.
- **Retirement**: David Roth IRA, Ariela Roth IRA, and other user-created retirement goals.

Groups organize the interface and totals. Allocatable leaf goals hold balances and monthly targets. A goal has:

- name;
- group;
- optional parent goal for one level of subcategory nesting;
- David, Ariela, or Shared owner;
- icon key and color key from controlled allowlists;
- fixed monthly target in integer cents;
- priority order within its funding pool;
- locked/unlocked allocation state;
- optional linked Planning spending category;
- active/archived state;
- activation month and timestamps.

Only active leaf goals receive allocations. Categories with history are archived, never deleted. An unused category may be deleted. Archived history remains reportable.

### Separate funding pools

Regular Savings and Retirement are separate funding pools:

- Connected joint savings deposits fund Regular Savings goals.
- Retirement contributions and valuations fund Retirement goals.
- Money still present in a joint bank savings account is never presented as retirement money.
- Existing Fidelity retirement data can be assigned to a Retirement goal through the general account/manual-asset workflow. Pershing remains absent until connected later.

The default Savings view is Combined. A single split control reveals David, Ariela, and Shared amounts using the established household colors. Combined remains the default after reopening the app unless the user explicitly chooses a different persisted view preference.

### System buckets

Each pool has two non-user-editable system buckets:

- **Unallocated**: real savings money not assigned to a goal.
- **Pending transfer**: money still physically in savings but already committed to cover an over-budget spending draw.

The regular-savings reconciliation equation is:

`connected regular savings balance = active goal balances + archived goal balances + unallocated + pending transfer`

Retirement reconciles manual/connected retirement value against Retirement goals separately. A mismatch is always visible and never silently corrected.

Each connected account or manual asset participating in this feature has an explicit pool assignment: Regular Savings, Retirement, or neither. Only inbound activity for an account assigned to Regular Savings counts as a regular-savings contribution. The existing joint savings account is assigned to Regular Savings during setup; retirement accounts/assets are assigned to Retirement. Merely enabling an account for general savings reporting does not guess its funding pool.

### Ledger events

Savings events are append-only and store:

- event ID and movement/grouping ID;
- funding pool;
- goal or system bucket;
- signed amount in cents and USD currency;
- event type;
- effective date and month;
- optional source transaction, Planning category/month, month-end review, or manual asset;
- optional reversing-event reference;
- user/system actor, explanation, and timestamp.

Undo creates an equal and opposite event; it does not delete or rewrite history. Import and reconciliation operations use stable source keys so repeated syncs are idempotent.

## Initialization

Initialization happens once after the schema migration through an explicit idempotent setup operation:

1. Sum the latest balances of active connected accounts included in Savings and classified as regular savings.
2. Allocate up to $25,000 to the Shared Emergency goal.
3. Allocate any remainder to Shared General Savings.
4. If the balance is below $25,000, Emergency receives the entire balance and General Savings receives zero.
5. Existing Roth IRA assets are assigned to Retirement goals for their current owners. Unassigned retirement assets remain visibly unallocated rather than being guessed.
6. Set the activation month to the current month. No virtual goal history is fabricated before it.

The setup records opening events and an audit event. It is safe to repeat without producing duplicates.

## Monthly targets and allocation rules

Monthly dollar targets are the source of truth. Percentages are derived from each goal's monthly target divided by the pool's total monthly target.

- Editing a dollar target changes only that goal's dollar target and therefore changes the pool total and derived percentages.
- Moving a percentage slider keeps the pool total fixed and redistributes dollar targets among unlocked goals.
- Locked goals retain their target during redistribution.
- At least two goals must be unlocked for redistribution.
- Lock All is allowed as a stable read-only state.
- Moving a locked slider automatically unlocks that goal and, if needed, the lowest-priority other goal so two goals can rebalance.
- All percentage arithmetic uses integer basis points and deterministic remainder assignment so values total exactly 10,000 basis points and cents are never lost.

Priority order is user-controlled by keyboard-accessible move controls and drag-and-drop enhancement. Order is stored explicitly.

### Deposit allocation

For each pool and month:

1. Up to the planned monthly total, actual contributions fill fixed monthly targets from highest to lowest priority.
2. If a higher-priority goal is already fully funded for the month, continue to the next goal.
3. Any amount above the planned total is distributed across active goals using their allocation percentages.
4. Excess continues to distribute across active goals by their monthly percentages unless a goal has reached an overall goal and configured overflow destinations. In that case, its share is reassigned to those same-pool destinations by their current monthly target weights. With no overflow destination, the completed goal continues growing.
5. With no nonzero targets, new money remains Unallocated until the user creates a plan.

Provider retries, modified transactions, removed transactions, and pending-to-posted replacements adjust allocations through idempotent delta/reversal events.

## Spending draws and withdrawals

A Regular Savings goal may link to one Planning spending category, such as Shopping or Fun. At most one active goal may link to a given Planning category; the database and API enforce this so the same overspending cannot be deducted twice.

For every open or closed month from the activation month onward, FinTracka reuses Planning's included-spending calculation:

- archived transactions, transfers, credit-card payments, tombstones, and excluded accounts do not count;
- refunds reduce net spending consistently with Planning;
- if the linked Planning category has a target, only `max(0, actual spending - target)` draws savings;
- if it has no Planning target, the full included spending amount draws savings.

The draw is capped at the available goal balance. The goal never becomes negative. Any remainder is reported as uncovered overspending for that month.

Because purchases often occur before money moves from savings:

1. A spending draw moves money from the goal to Pending transfer. This immediately reduces the usable goal balance without changing the reconciled bank total.
2. A later matching withdrawal from an included savings account settles Pending transfer and reduces the physical/reconciled total once. Automatic matching is deliberately conservative: one exact-amount withdrawal, from the same Regular Savings pool, within seven calendar days after the draw. Partial withdrawals, aggregate withdrawals, multiple possible matches, and dates outside that window remain visible for manual assignment.
3. A matched settlement never deducts the goal a second time.
4. An unmatched withdrawal from an included savings account appears as Needs allocation. The user assigns it to a goal, Unallocated, or a pending draw.
5. Withdrawals from non-savings accounts do not affect the savings ledger.

Category edits, archive/unarchive actions, transaction modifications/removals, and Planning target changes reconcile the affected monthly draw by appending the required delta or reversal. Source keys make this repeat-safe.

## Month-end review

Beginning with the activation month, a review is generated after each month closes:

1. Calculate the total included Planning targets and actual included spending using existing Planning rules.
2. Suggested savings is `max(0, total targets - actual spending)`.
3. Cap the suggestion at the household's actual positive cash surplus for the month.
4. Display whether a matching savings deposit or sufficient Unallocated savings exists.

Actions:

- **Add to savings**: attribute an already detected deposit or existing Unallocated amount to this review. A detected deposit is allocated exactly once by the normal deposit allocator in its actual deposit month; accepting the prior-month review only links the matched portion to that review and does not create another allocation. Existing Unallocated money may be allocated when accepted.
- **Move $X to savings**: shown when the money is not yet present; the review waits for a matching deposit.
- **Ignore**: dismiss the review for that month without changing financial data.

When an expected deposit later appears, the pending review becomes confirmable. Its financial event remains in the deposit's real calendar month while the review history identifies the prior month that prompted it. Review state and matching are idempotent and audited. Review history shows pending, waiting, added, and ignored states.

## History and progress

History starts in the activation month. The Savings overview shows:

- combined savings total by month;
- Regular Savings and Retirement subtotals;
- connected balances versus allocated/reconciled balances;
- per-goal opening balance, deposits/additions, spending draws, withdrawals, earnings or investment valuation changes, manual adjustments, and closing balance;
- uncovered overspending and pending transfers;
- allocation percentage and monthly target attainment.

The overview offers two distinct views. Monthly progress compares contributions in the selected month with that month's versioned dollar goal. Overall progress compares the current virtual goal balance with its optional overall goal. Goals without an overall goal remain open-ended while still showing their long-term balance.

The historical detail also retains cumulative expected funding since activation:

`expected to date = monthly target × active months`

Progress is capped visually at 100%, while the detail view shows the actual dollar balance. Goals with a zero monthly target remain visible in lists and balances but do not consume a Monthly doughnut slice. Raising an overall goal can atomically reassign existing same-pool virtual balances from user-selected goals; these append-only ledger entries are reversible and never initiate a bank transfer.

For Retirement, only explicit contribution transactions or confirmed manual contribution entries count toward monthly target attainment. Market movement and changes in a connected/manual asset valuation are recorded as valuation gains or losses and change the retirement balance without being called contributions.

## Interface

The Savings page keeps the existing FinTracka visual language and gains four internal views:

1. **Overview**
   - Combined by default, with a control to reveal David/Ariela/Shared splits.
   - Total, Regular Savings, Retirement, Unallocated, Pending transfer, and reconciliation status.
   - Multi-segment doughnut: angular size represents monthly allocation percentage; each segment's solid portion represents funded progress and its translucent remainder represents unfunded expected savings.
   - Goal list/cards and month-to-month trend.
   - Clicking a segment or goal opens a detail drawer with a focused doughnut, balances, progress, monthly trend, and ledger activity.

2. **Allocation rules**
   - Fixed monthly dollar targets, derived percentages, connected sliders, locks, and priority order.
   - A live simulation shows how the current month's deposits fill goals and how excess would distribute.
   - The sliders are a shared 100% allocation control, not independent ranges that can drift away from 100%.

3. **Manage goals**
   - Regular Savings and Retirement hierarchy.
   - Create, edit, reorder, archive, and delete-unused actions.
   - Name, owner, icon, color, versioned monthly goal, optional overall goal, overflow destinations, optional linked Planning category, and active status.

4. **Monthly review**
   - Prior-month target, actual spending, capped suggestion, deposit match status, distribution preview, accept/transfer-wait/ignore actions, and history.

The current connected-account, manual-asset, balance-history, and monthly-activity information remains available below the overview or within account detail. It is not removed.

### Icons

Add a pinned `lucide-react` dependency and expose a controlled icon-key allowlist rather than arbitrary component names or SVG input. Only imported icons enter the build. Initial choices include piggy bank, shield, plane/palm, shopping bag, gamepad, house, gift, car, chart, wallet, and coins. Interactive icon-only controls have accessible labels and tooltips.

## Suggested additions included

- Reconciliation warnings whenever the virtual ledger does not equal tracked account values.
- Append-only corrections and undo.
- Emergency progress in months of essential Planning spending, alongside its dollar balance.

Target dates are explicitly excluded.

## API surface

The detailed route names may follow existing API conventions, but the public behavior must cover:

- read combined savings overview and monthly history;
- initialize the goal ledger once;
- create/update/archive/delete-unused/reorder goals;
- update monthly target, allocation percentage, lock state, and priority atomically with optimistic conflict checks;
- read goal detail and ledger activity;
- assign or settle an unmatched savings withdrawal;
- undo an eligible manual allocation/correction;
- read and act on month-end reviews;
- reconcile an affected month after transaction or Planning changes.

All mutations retain session-cookie authentication, CSRF, strict Host/Origin checks, unexpected-field rejection, integer-cent validation, and audit events. API responses never include provider secrets or raw sensitive provider payloads.

## Correctness and failure handling

- Every multi-row movement is one SQLite transaction.
- Each external/source-triggered movement has a stable idempotency key.
- Allocation uses integer cents and deterministic remainder handling.
- A failed allocation, review action, or reconciliation writes nothing partial.
- Historical events are immutable; corrections are reversing entries.
- Reconciliation mismatches are visible and actionable, not auto-balanced.
- Existing savings summary and manual asset records remain valid through migration.
- Concurrent edits use `updated_at` optimistic checks and return a conflict rather than overwrite.

## Verification

Backend tests cover:

- one-time initialization at below, equal to, and above $25,000;
- separation of Regular Savings and Retirement;
- priority allocation for short deposits and percentage allocation for excess deposits;
- locked redistribution, automatic unlock, exact 100% basis-point totals, and cent remainders;
- category overspending with and without a Planning target;
- goal balance floor and uncovered overspending;
- pending-transfer creation, matched settlement, and prevention of double deduction;
- unmatched savings withdrawals and exclusion of non-savings withdrawals;
- modified/removed/recategorized/archived transactions and target changes;
- repeated sync/reconciliation idempotency and atomic rollback;
- month-end review cap, waiting, matching, acceptance, and dismissal;
- archive/history/undo and optimistic conflicts;
- combined and owner-split totals and monthly roll-forwards.

Frontend tests cover:

- combined-default and owner split behavior;
- doughnut selection and goal detail drawer;
- target/percentage edits, locks, exact total, and priority order;
- goal management, icon/color selection, and archive safeguards;
- reconciliation, pending-transfer, uncovered-spending, and empty states;
- monthly review actions;
- accessible names, keyboard controls, and responsive layout.

Playwright covers the principal workflow: initialize, set monthly targets, receive a partial deposit, inspect allocations, incur linked-category overspending, settle the savings withdrawal once, and inspect the next monthly history point.

Final verification runs backend tests, frontend tests, type checking, production build, Playwright, dependency audits, SQLite integrity, and a backup/restore drill.

## Rollout

1. Back up the live database.
2. Apply the numbered migration without changing existing balances or assets.
3. Run the one-time opening allocation and show the exact $25,000 Emergency/remainder General Savings preview before committing it.
4. Configure monthly targets and category links.
5. Observe reconciliation for the first month before relying on automated month-end suggestions.
