# FinTracka

FinTracka is a single-user, local-first personal finance application for macOS. SQLite is the authoritative ledger and the dashboard listens only on `127.0.0.1`. Plaid supplies account and transaction data; Google Sheets and Excel are one-way exports.

## What it does

- Imports balances and transactions from Plaid without giving FinTracka bank credentials.
- Keeps provider facts separate from manual categories, merchants, notes, ownership, and splits.
- Automatically categorizes transactions and learns corrections for one transaction, future matches, or past and future matches.
- Requests up to 730 days of history whenever a new Plaid connection is created.
- Imports older CSV history into an existing account without creating another Plaid Item.
- Supports category and subcategory filtering, manual cash spending, transfer review, and David/Ariela/Shared spending ownership.
- Shows monthly Planning with historical averages, targets, current spending, remaining amounts, and category detail drawers where transactions can be recategorized.
- Splits Planning and Reports spending into clickable David, Ariela, and Shared views.
- Lets you reversibly remove an individual duplicate account without disconnecting its bank or deleting history.
- Maintains a 10%-of-Salary Tzedaka minimum in Planning.
- Tracks connected savings accounts and manually valued savings, investments, and other assets separately from spending Planning.
- Hides confirmed transfers and card payments from ordinary spending views by default.
- Produces deterministic Google Sheets and Excel snapshots while SQLite remains authoritative.

## Requirements and setup

FinTracka requires macOS, Python 3.14.x, and Node 24 or newer. Secrets must never be placed in this public repository, shell history, `.env` files, logs, screenshots, or issue/PR text.

```sh
python3.14 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
cd frontend && npm ci && npm run build && cd ..
```

Configure each Plaid developer profile by typing its secret into standard input when prompted. The CLI stores credentials in macOS Keychain; SQLite receives only profile-scoped Keychain reference names. Omitting `--profile` configures David for compatibility.

```sh
.venv/bin/python -m fintracka.cli configure plaid \
  --profile david \
  --environment production \
  --client-id DAVID_PLAID_CLIENT_ID \
  --secret-stdin

.venv/bin/python -m fintracka.cli configure plaid \
  --profile ariela \
  --environment production \
  --client-id ARIELA_PLAID_CLIENT_ID \
  --secret-stdin
```

Use `--environment sandbox` for either profile's Plaid Sandbox. Configure a Google Desktop OAuth client from a private file outside the repository:

```sh
.venv/bin/python -m fintracka.cli configure google \
  --client-json-stdin < /private/path/google-desktop-client.json
```

## Start and stop

On the configured Mac, double-click `FinTracka.command` on the Desktop. The launcher builds the latest interface, starts the local server, syncs connected Plaid accounts, and opens Google Chrome. If FinTracka is already running, double-clicking the launcher syncs again before opening it. Keep its Terminal window open; press Control-C there to stop FinTracka.

The repository launcher provides the same workflow:

```sh
scripts/launch_fintracka.command
```

To start manually and open Chrome:

```sh
.venv/bin/python -m fintracka.cli serve --open-chrome
```

The first browser visit exchanges a short-lived, one-use bootstrap token for an HttpOnly, SameSite-Strict local session cookie. If Chrome shows a locked page, close that tab and launch FinTracka again instead of reusing an old bootstrap URL.

## Everyday workflow

1. Use **Connections** to connect, repair, disconnect, or sync a bank.
2. Use **Accounts** to set nicknames, spending ownership, reporting scope, and Savings inclusion.
3. Use **Transactions** to search, filter, correct categories/subcategories, add cash spending, and review transfers.
4. Use **History import** to preview and import older bank CSV files into the matching account. Supported files can use Date, Transaction Date, or Posted Date; Description or Payee; and either Amount or separate Debit/Credit columns. Currency defaults to USD.
5. Use **Planning** to enter recurring income, compare usual spending with targets and actuals, adjust category targets, and correct transaction categories from the detail drawer. Reports flow drawers support the same `1×` (once), `→` (future), and `↔` (past and future) correction modes; FinTracka remembers the last mode selected.
6. Use **Connections → Details → Manage bank accounts** to add another account from an existing Plaid bank connection. This uses the existing Plaid Item rather than a new Trial Item.

If the same joint account appears through two bank logins, open **Accounts → Edit → Remove from FinTracka** on the duplicate. Removed accounts and their transactions are hidden from normal views, calculations, savings, and exports but remain locally stored and can be restored with **Show removed accounts**.
7. Use **Savings** for connected savings balances, Regular Savings goals, Retirement goals, manually tracked investments, and monthly allocation reviews.
8. Use **Settings** for readiness checks, Google authorization, exports, backups, scheduling, and theme.

Data and corrections persist in the local SQLite ledger when the browser or application closes. Spreadsheets are exports only; edits made in them are not imported.

## Operations

```sh
# Sync all enabled Plaid connections
.venv/bin/python -m fintracka.cli sync

# Export an atomic Excel snapshot
.venv/bin/python -m fintracka.cli export excel --output /private/path/FinTracka.xlsx

# Export to the authorized Google workbook
.venv/bin/python -m fintracka.cli export google_sheets

# Create a verified local backup
.venv/bin/python -m fintracka.cli backup \
  --output-dir "$HOME/Library/Application Support/FinTracka/backups"

# Verify and restore a backup into the FinTracka data directory
.venv/bin/python -m fintracka.cli restore /private/path/backup.sqlite3 --verify

# Manage the optional 06:17/login schedule
.venv/bin/python -m fintracka.cli schedule install
.venv/bin/python -m fintracka.cli schedule status
.venv/bin/python -m fintracka.cli schedule remove
```

Scheduled work runs only while the Mac is awake. Local backups are retained according to FinTracka's backup policy; an encrypted off-device backup remains recommended.

## Live-data safety

Before Plaid Link opens, FinTracka checks Python 3.14, FileVault, macOS Keychain, Plaid credentials, and a verified local SQLite backup. Missing off-device backup coverage is shown as a prominent, non-blocking testing warning.

Start with one institution, compare account names and balances, sync transactions, and reconcile a statement exactly before expanding use. Bank credentials are entered only inside Plaid Link and never pass through FinTracka.

Every Plaid Item remains permanently bound to the David or Ariela developer profile that created it. Both profiles feed the same household ledger; the account's editable spending owner—not its Plaid profile—controls David, Ariela, or Shared reporting. A second Plaid developer team does not guarantee a separate Trial allowance or institution approval.

Roth IRA holdings are tracked as Retirement only when explicitly assigned or entered as a manual investment. Fidelity data already present in FinTracka can be assigned to Retirement; Pershing is intentionally unsupported until it is connected and reviewed. The Transactions-only Plaid integration does not guess that an account is retirement from its provider or account name.

## Savings goals

Savings goal tracking starts in the month you activate it; it never fabricates earlier goal history. Before activation, create and verify a local SQLite backup. The setup preview allocates up to **$25,000** of current Regular Savings to **Emergency**, assigns any remainder to **General Savings**, and shows Retirement separately. Review that preview in the UI before confirming it.

Monthly dollar targets are authoritative. Percentage sliders redistribute the same exact cents across unlocked goals, while priority order controls which goals receive money first when a deposit is smaller than planned. Deposits above the monthly plan are divided by the saved percentages. Goals linked to Planning categories draw only category spending above that category's target.

Money committed to cover overspending remains visible as **Pending transfer** until a unique matching savings withdrawal settles it. Unmatched withdrawals require an explicit goal, Unallocated, or Pending-transfer assignment. Corrections and undo operations append reversing ledger events; historical entries are not silently rewritten. Regular Savings and Retirement always remain separate, and reconciliation warnings are visible instead of being auto-balanced.

Plaid's history window cannot be expanded after Transactions has already been initialized on an Item. Do not disconnect and reconnect an existing Trial Item merely to request more history: removing it does not restore the lifetime Trial slot. Use **History import** for older records instead.

## Verification

Automated tests use synthetic data. Credentialed Plaid and Google smoke tests remain local-only and never run in GitHub Actions.

```sh
scripts/verify.sh
.venv/bin/python scripts/scan_local_secrets.py
```

See [SECURITY_PLAN.md](SECURITY_PLAN.md), [BANK_INTEGRATION_PLAN.md](BANK_INTEGRATION_PLAN.md), and [FinTracka-threat-model.md](FinTracka-threat-model.md) before using real data.
