# Manual Transfer Connect Design

## Goal

Let a user select any visible transaction, choose the exact matching transaction on another owned account, and confirm the pair as an internal transfer even when the automatic three-day review window missed it. A confirmed pair must be excluded from financial totals and must teach FinTracka the same narrowly scoped account-and-counterparty pattern for history and future syncs.

## User experience

1. Select exactly one transaction in the Transactions register.
2. Click **Connect transfer** beside the existing bulk actions.
3. A dialog lists every eligible exact-opposite transaction, ordered by closest date.
4. Each choice shows direction, merchant/description, date, account, and amount.
5. Choose one match and confirm. FinTracka hides both sides as a confirmed transfer, refreshes the register, and explains that the pattern is remembered.

If no exact match is currently available, the dialog says so instead of allowing an unsafe approximate match.

## Matching and learning rules

- A manual option must be posted, unarchived, non-deleted, in the same currency, on a different owned account, and have the exact opposite amount.
- Transactions already in confirmed transfer links are unavailable.
- Previously rejected exact pairs remain excluded; rejection means the user explicitly decided that pair is not a transfer.
- The manual picker has no date cutoff, so older missed pairs can be connected.
- The ordinary possible-transfer review strip stays conservative at three days.
- Once a user confirms a pair, automatic learning uses the existing signature: outgoing account, incoming account, normalized outgoing counterparty, and normalized incoming counterparty.
- Learned-pattern matching may bridge up to 14 days. This covers delayed posting while avoiding broad equal-amount Zelle matching.
- Learned matches are processed closest-date-first so repeated equal amounts cannot claim a worse match before a closer one.

## Architecture

- Reuse the existing `transfer_links` table and confirmation endpoint. No migration or second rule system.
- Add a ledger query that returns eligible counterpart transaction IDs for one anchor transaction.
- Add one read-only API endpoint returning the normal transaction response objects for those IDs.
- Add a focused React dialog and wire it to the existing Transactions selection toolbar.
- Keep confirmation atomic and continue using the existing audit events, savings-transfer classification, hidden-transfer filtering, and historical/future learning.

## Error handling and safety

- Unknown, pending, archived, deleted, or already-linked anchors return a clear validation error.
- The server revalidates amount, currency, and owned-account separation at confirmation time; the browser cannot force an invalid pair.
- A refresh or concurrent confirmation yields a normal validation error rather than duplicating a link.
- No bank action is performed. Connecting a transfer only changes FinTracka's internal reporting classification.

## Verification

- Ledger tests prove distant exact options are offered, unsafe options are excluded, the three-day review strip is unchanged, and a learned five-day pattern is auto-confirmed.
- API tests prove the match endpoint returns complete account-aware transaction details and validates missing anchors.
- Frontend tests prove the dialog renders exact choices, handles empty/loading/error states, and submits the selected transaction IDs.
- Run the full Python and frontend suites plus a production frontend build.
