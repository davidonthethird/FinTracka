# Cost Analysis

Pricing was verified from first-party pages on 2026-10-11 and must be rechecked before live rollout.

## Expected release costs

- FinTracka, FastAPI, React, SQLite, Pytest, Playwright, OpenPyXL, and local launchd: no license or hosting fee.
- Plaid Sandbox: free.
- Plaid Trial: currently free for up to 10 lifetime Production Items for eligible new US/Canada teams; exact paid Transactions pricing is disclosed during production application. [Plaid billing](https://plaid.com/docs/account/billing/)
- SimpleFIN fallback: $15/year plus tax or $1.50/month plus tax, up to 25 institutions and apps. [SimpleFIN](https://beta-bridge.simplefin.org/)
- Teller alternative: development tier currently allows 100 live enrollments; production Transactions is $0.30/enrollment/month and Balance is $0.10/call. [Teller](https://teller.io/)
- Google Sheets: standard API use currently has no additional charge within quota; future over-quota charging is documented as planned. [Sheets limits](https://developers.google.com/workspace/sheets/api/limits)
- Tiller comparison: $99/year. [Tiller pricing](https://tiller.com/pricing/)

## Realistic totals

- Development and synthetic use: $0/year.
- Plaid Trial live use while eligible and below the lifetime Item cap: $0/year.
- Predictable low-cost fallback: approximately $15/year plus tax for SimpleFIN.
- External encrypted backup storage is user-supplied and excluded.

## Cost triggers

- Do not consume Plaid Production Items during ordinary development.
- Re-evaluate provider choice before the eighth lifetime Plaid Item or any paid-plan transition.
- Do not use paid real-time balance refresh when daily provider/account data is sufficient.
- Keep Google requests batched and daily; a personal ledger should remain far below quota.

