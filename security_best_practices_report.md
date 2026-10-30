# FinTracka remote viewer security release review

Date: 2026-10-28  
Scope: the local snapshot builder/publisher, Cloudflare Publisher and Viewer Workers, private R2 storage, the read-only React viewer, secret handling, deployment configuration, and the real-household-data release gate.

## Executive summary

The final review found one High issue: Python's default redirect behavior could forward the Cloudflare service token to a redirected origin. It is remediated by rejecting all publisher redirects and covered by a two-server regression test. The review also found that configuration previously enabled automatic startup publication before the first manual reconciliation; configuration now leaves automation disabled and requires an explicit `fintracka remote enable` command. No Critical or unresolved High application vulnerability remains.

Real household data must **not** be activated yet. Production does not exist: there is no production R2 bucket or production Viewer/Publisher Worker, and the local ledger's remote publication setting is disabled. In addition, the Mac's verified HTTPS clients currently reject the Cloudflare Gateway certificate chain, so the automatic publisher cannot securely reach even the protected staging Worker. Bypassing TLS verification is not an acceptable fix.

## Remediated findings

### SEC-REDIRECT-001

- Severity: High, remediated.
- Location: `src/fintracka/remote_client.py:18-28` and `tests/test_remote_service.py`.
- Evidence: the previous client used `urllib.request.urlopen`, whose redirect handler copied the reusable Access headers to redirected requests. The client now uses an opener whose redirect handler rejects every redirect; the regression test proves a second origin receives no request or credential.
- Impact before fix: a routing mistake or redirecting publisher could steal a token capable of publishing or purging snapshots.
- Fix: shipped in this branch; the configured Publisher origin must return the final response directly.

### SEC-AUTOMATION-001

- Severity: Medium, remediated.
- Location: `src/fintracka/remote_config.py`, `src/fintracka/remote_service.py`, and `src/fintracka/cli.py`.
- Evidence: configuration previously wrote `enabled = 1`, allowing the next startup to publish before manual reconciliation. Configuration now writes `enabled = 0`; only manual publication is allowed while disabled, and automatic startup/sync/scheduled publication requires an explicit `remote enable` command.
- Impact before fix: a normal restart could cross the Cloudflare privacy boundary before the operator completed the production gate.
- Fix: shipped in this branch with configuration, service, CLI, startup, and redirect regression coverage.

## Release blockers

### SEC-DEPLOY-001

- Severity: High release blocker; not an exploitable code defect in the currently deployed synthetic staging environment.
- Location: `remote/wrangler.viewer.jsonc:20-22`, `remote/wrangler.publisher.jsonc:14-16`, and `REMOTE_VIEWER_RUNBOOK.md:5-19`.
- Evidence: production bindings are configured in source, but Cloudflare reports no production Worker and lists only the staging R2 bucket. `fintracka remote status` reports `enabled: false` with no viewer URL or prior publication.
- Impact: there is no private production destination to which household data can be safely published. Publishing to staging would mix synthetic acceptance and live data and bypass the documented release process.
- Fix: provision the production bucket and Workers, then protect the complete Viewer hostname with an exact David/Ariela Access allowlist and the complete Publisher hostname with strict Service Auth before enabling local publication. Verify both deny unauthorized requests and that R2 has no public endpoint.
- Mitigation: keep staging synthetic and keep remote publication disabled, which is the current state.
- False-positive notes: none; the absence was confirmed through the Cloudflare account and local settings on 2026-10-28.

### SEC-TLS-001

- Severity: Medium availability/security blocker.
- Location: `src/fintracka/remote_client.py:18-20` and the Mac's HTTPS trust configuration.
- Evidence: both `curl` and the application's `truststore.SSLContext` reject the staging Worker chain as an untrusted Cloudflare Gateway CA. The client correctly fails closed rather than disabling certificate verification.
- Impact: manual, startup, post-sync, and scheduled publication cannot securely upload a snapshot from this Mac. Weakening TLS would expose the service token and household snapshot to interception.
- Fix: verify the Cloudflare Gateway CA fingerprint in the household Cloudflare dashboard and repair its macOS trust/profile installation so the same unmodified client succeeds with normal hostname and chain validation.
- Mitigation: do not publish until normal TLS validation succeeds.
- False-positive notes: Chrome may use a different trust path, but the Python publisher's actual trust path failed and is the one that matters for Phase 2.

### SEC-GATE-001

- Severity: Medium operational blocker.
- Location: `REMOTE_VIEWER_RUNBOOK.md:5-19` and `REMOTE_VIEWER_RUNBOOK.md:54-68`.
- Evidence: the runbook still records Ariela interactive login, mutation/purge/Mac-off drills, production-empty reconciliation, and the current Plaid/Cloudflare privacy review as incomplete.
- Impact: access revocation, deletion, and stale-data behavior have not been demonstrated end-to-end with the intended household identities. Activating real data before those checks could leave financial data accessible longer than intended or make emergency removal unreliable.
- Fix: complete and record the remaining drills, get explicit household approval for the sanitized fields stored by Cloudflare, then perform one production manual publish and reconcile it before installing the hourly schedule.
- Mitigation: keep production empty and automation disabled.
- False-positive notes: prior verbal approval was given for Ariela's identity, but the runtime login/revocation and production-empty checks remain independently necessary.

## Defense-in-depth finding

### REACT-HEADERS-001 / FASTAPI-HEADERS-001

- Severity: Low.
- Location: `remote/src/viewer.ts:13-19` and `remote/src/publisher.ts:9-15`.
- Evidence: CSP, `no-store`, `no-referrer`, `nosniff`, and frame denial are present. `Permissions-Policy` and HSTS are not set in Worker code.
- Impact: there is no known exploit in this viewer, which does not request powerful browser features and only uses HTTPS URLs. The missing headers reduce defense in depth if future UI code adds such capabilities or if edge HSTS is absent.
- Fix: after the production hostname is chosen, set a restrictive `Permissions-Policy` and verify HSTS at the Cloudflare edge. Do not enable HSTS blindly on a shared or transitional hostname.
- Mitigation: the current CSP, HTTPS-only configuration validation, Access boundary, and read-only methods materially limit exposure.
- False-positive notes: Cloudflare may add HSTS outside this repository; verify the final production response.

## Controls verified

- Publisher input is limited to 5 MiB, SHA-256 checked, strictly schema-validated, and rejected on stale/equal competing sequences (`remote/src/publisher.ts:8-48`, `remote/src/contract.ts:145-189`, `remote/src/storage.ts:16-78`).
- Viewer methods are limited to `GET`, `HEAD`, and `OPTIONS`; mutations return 405 (`remote/src/viewer.ts:21-64`).
- Snapshot fields are explicitly projected from SQLite, archived rows and confirmed transfers are excluded, free-form notes and provider identifiers are absent, and Pydantic rejects extra fields (`src/fintracka/remote_snapshot.py:47-148`, `src/fintracka/remote_snapshot.py:170-220`, `src/fintracka/remote_models.py:8-253`).
- Access service credentials are read from macOS Keychain and SQLite stores only opaque references (`src/fintracka/remote_config.py:48-120`, `src/fintracka/remote_client.py:55-68`).
- The publisher uses HTTPS with certificate verification, timeouts, bounded retries, stable redacted errors, and no response-body logging (`src/fintracka/remote_client.py:18-20`, `src/fintracka/remote_client.py:86-134`).
- The viewer uses same-origin fetches, does not persist financial data, and serves sanitized storage failures (`frontend/src/viewer/api.ts:9-24`, `remote/src/viewer.ts:62-64`).
- Preview URLs are disabled and R2 has no public endpoint in the checked configuration (`remote/wrangler.publisher.jsonc:6-7`, `remote/wrangler.viewer.jsonc:6-7`).
- `scripts/verify.sh` passed all 196 Python, 27 Worker, 41 frontend, and 3 Playwright tests. Both npm trees and the Python dependency tree reported no known vulnerabilities; the local-secret scanner found no leak. The first-party `fintracka` package is not on PyPI and therefore is not covered by `pip-audit`'s registry check.

## Release decision

**NO-GO for household data today.** The safe current state is synthetic-only staging with local remote publication disabled. Move to GO only after production is Access-protected, TLS validation succeeds from the actual Python publisher, the remaining identity/purge drills pass, and a single manual production snapshot is reconciled before automation is installed.
