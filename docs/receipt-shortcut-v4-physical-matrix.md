# FinTracka Receipt Scanner v4 physical acceptance

Do not put receipt text, photos, handoff/import IDs, account details, hostnames, or credentials in this file. Record only pass/fail, date/time, device/iOS version, and a short non-sensitive observation.

## Build under test

- Commit:
- Signed Shortcut archive:
- Viewer/Worker deployment version:
- Mac helper build:

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
| On-device and Private Cloud Compute outputs/durations remain separate | Not run | | |
| Mac awake: one ready review, no duplicate | Not run | | |
| Mac asleep then awake: queued scan resumes | Not run | | |
| Viewer closed/reopened: queued scan rediscovered | Not run | | |
| One Apple model unavailable: other evidence remains visible | Not run | | |
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
| Both model results remain separate for comparison | Not run | | |
| One ready review opens exactly once | Not run | | |

Ariela sign-off:

## Real receipt release gate

| Check | Result | Timestamp | Non-sensitive note |
|---|---|---|---|
| User compares both model outputs to the receipt | Not run | | |
| Every purchased line and summary amount is present or visibly flagged | Not run | | |
| Better model route selected explicitly | Not run | | |
| Existing draft/review page opens exactly once | Not run | | |
| No automatic bank-transaction match or ledger change | Not run | | |
| User explicitly reviews intended posted transaction | Not run | | |

Release decision: **Not approved**
