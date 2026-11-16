# FinTracka Receipt Scanner v5 physical acceptance

Do not put receipt text, photos, handoff/import IDs, account details, hostnames, or credentials in this file. Record only pass/fail, date/time, device/iOS version, and a short non-sensitive observation.

## Build under test

- Commit: `feat/immediate-receipt-review` working tree; commit deferred until physical acceptance
- Signed Shortcut archive: SHA-256 `edfbdf963ad05ac2c32d0a6d00842820262b4968834587ede897fc69845e5397`
- Viewer/Worker deployment version: `5e812775-3e29-4be7-a579-ead46a5c0ebd`
- Mac helper build: `src/fintracka/receipt_refinement_service.py` from the same working tree

## David

| Check | Result | Timestamp | Non-sensitive note |
|---|---|---|---|
| Install exactly one canonical Shortcut; shared folder selected | Not run | | |
| Direct tile run fails closed and creates no package | Not run | | |
| Camera, single page | Not run | | |
| Photo library, single page | Not run | | |
| Camera, multiple ordered pages | Not run | | |
| Photo library, multiple ordered pages | Not run | | |
| Faded or crumpled receipt remains reviewable | Not run | | |
| Photographed screen remains reviewable | Not run | | |
| Cancellation creates no package/import | Not run | | |
| Cloud Pro completes and its duration is recorded | Not run | | |
| Mac stopped: immediate draft opens and owner can be saved | Not run | | |
| Immediate draft remains blocked from transaction matching | Not run | | |
| Mac starts: same draft becomes verified without owner changes | Not run | | |
| Mac awake: one ready review, no duplicate | Not run | | |
| Mac asleep then awake: queued scan resumes | Not run | | |
| Viewer closed/reopened: queued scan rediscovered | Not run | | |
| Cloud Pro fails: no manifest is written and retry is safe | Not run | | |
| Blank OCR invokes OCR-only Mac fallback | Not run | | |
| Network loss retries without changed replay | Not run | | |
| Successful package is removed; unrelated files remain | Not run | | |

David sign-off:

## Ariela

| Check | Result | Timestamp | Non-sensitive note |
|---|---|---|---|
| Install exactly one canonical Shortcut; shared folder selected | Not run | | |
| Camera, single page | Not run | | |
| Photo library, single page | Not run | | |
| Multiple ordered pages | Not run | | |
| Mac asleep then awake: queued scan resumes | Not run | | |
| Handoff list contains only Ariela's scans | Not run | | |
| David cannot open Ariela's handoff and vice versa | Not run | | |
| Cloud Pro produces one populated review | Not run | | |
| Immediate owner assignment persists after close/reopen | Not run | | |
| One ready review opens exactly once | Not run | | |

Ariela sign-off:

## Real receipt release gate

| Check | Result | Timestamp | Non-sensitive note |
|---|---|---|---|
| User compares the Cloud Pro output to the receipt | Not run | | |
| Every purchased line and summary amount is present or visibly flagged | Not run | | |
| Cloud Pro route is recorded | Not run | | |
| Existing draft/review page opens exactly once | Not run | | |
| No automatic bank-transaction match or ledger change | Not run | | |
| User explicitly reviews intended posted transaction | Not run | | |

Release decision: **Not approved**
