# FinTracka

FinTracka is a single-user, local-first personal finance application. SQLite is the authoritative ledger; the dashboard binds only to `127.0.0.1`. Plaid supplies account and transaction data, while Google Sheets and Excel are one-way exports.

## Local setup

FinTracka requires Python 3.14.x and Node 24 or newer. Secrets must never be placed in this public repository, shell history, `.env` files, logs, screenshots, or issue/PR text.

```sh
python3.14 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
cd frontend && npm ci && npm run build && cd ..
```

Configure Plaid Production by typing the secret into standard input when prompted. The command stores the client ID and secret in macOS Keychain; SQLite receives only Keychain reference names.

```sh
.venv/bin/python -m fintracka.cli configure plaid \
  --environment production \
  --client-id YOUR_PLAID_CLIENT_ID \
  --secret-stdin
```

Configure a Google Desktop OAuth client from a private file outside this repository:

```sh
.venv/bin/python -m fintracka.cli configure google \
  --client-json-stdin < /private/path/google-desktop-client.json
```

Start the application and immediately open the complete URL it prints:

```sh
.venv/bin/python -m fintracka.cli serve
```

The URL fragment contains a one-use bootstrap token. It is intentionally short-lived and is removed from the address bar after exchange for an HttpOnly, SameSite-Strict local session cookie. Restart the server if the token has expired.

## First live test

Before Plaid Link opens, FinTracka requires Python 3.14, FileVault, macOS Keychain, Plaid Production credentials, and a verified local SQLite backup. The missing off-device backup is displayed as an accepted, non-blocking test risk.

Connect one institution only, compare account names and balances, sync transactions, and reconcile a statement exactly. Observe that connection for seven days before adding another institution. Bank credentials are entered only in Plaid Link and never pass through FinTracka.

The optional daily schedule runs at 06:17 local time and login. Install it explicitly in Settings or with:

```sh
.venv/bin/python -m fintracka.cli schedule install
```

The Mac must be awake for scheduled work.

## Verification

All automated tests use synthetic data. Credentialed smoke tests are local-only and never run in GitHub Actions.

```sh
scripts/verify.sh
.venv/bin/python scripts/scan_local_secrets.py
```

See [SECURITY_PLAN.md](SECURITY_PLAN.md), [BANK_INTEGRATION_PLAN.md](BANK_INTEGRATION_PLAN.md), and [FinTracka-threat-model.md](FinTracka-threat-model.md) before using real data.
