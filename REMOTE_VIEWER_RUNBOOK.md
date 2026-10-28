# FinTracka remote viewer runbook

The remote viewer is a sanitized, read-only copy of the local ledger. SQLite on the Mac remains authoritative. The viewer is not a backup and cannot sync, categorize, edit, or recover local data.

## Release gate

Do not publish household data until every staging and approval item below is checked. As of 2026-10-27, local synthetic verification passes, but Cloudflare staging is **not deployed** because Wrangler on this Mac is not authenticated. Household approval and the live Cloudflare/Plaid policy review are also still required.

- [x] Python, Worker, frontend, contract, mobile, browser-storage, interruption, and dependency tests pass with synthetic data.
- [x] Canonical snapshot is 704,621 bytes, below the 5 MiB hard gate. The viewer bundle is 252,763 bytes JavaScript plus 18,379 bytes CSS before transfer compression.
- [x] Local Playwright exercised 320/375/390/430/768/1280 px, all five screens, filters, drawers, stale/no-snapshot states, and no browser persistence.
- [ ] Wrangler authenticated to the intended household Cloudflare account.
- [ ] Synthetic staging deployed and the acceptance matrix below recorded.
- [ ] David and Ariela explicitly approve Cloudflare storing the sanitized transaction snapshot.
- [ ] Current Plaid agreement/use-case and Cloudflare privacy, retention, location, and deletion terms reviewed by the household.
- [ ] Production starts empty; one manual live publish is reconciled before automation is enabled.

If the snapshot exceeds 5 MiB or a supported iPhone cannot load/filter it acceptably, stop. Design a D1-backed viewer; do not silently remove history or fields.

## Staging provisioning

Use a separate staging bucket and Workers. Never put account IDs, household emails, API tokens, Access credentials, or financial values in Git, shell history, screenshots, tickets, or logs.

1. Authenticate interactively and confirm the account:

   ```sh
   cd remote
   npx wrangler login
   npx wrangler whoami
   ```

2. Create the private staging bucket once:

   ```sh
   npx wrangler r2 bucket create fintracka-snapshots-staging
   ```

   Leave public development URLs and custom public domains disabled for the bucket. Choose the required jurisdiction/location before creation; a location hint is not a legal residency guarantee.

3. Build and deploy the staging Workers:

   ```sh
   cd frontend && npm ci && npm run build:viewer && cd ../remote
   npm ci
   npm run deploy:publisher:staging
   npm run deploy:viewer:staging
   ```

4. In **Zero Trust → Access → Applications**, protect the entire staging Viewer Worker, including production-shaped and preview URLs. Use an Allow policy containing exactly the two household identities, through the selected identity provider with MFA. Do not use an email-domain or Everyone rule.

5. Protect the entire staging Publisher Worker, including preview URLs, with a separate Access application. Its only policy is **Service Auth** for one FinTracka staging service token. Enable strict service-token authentication so bad credentials return 401/403 and never fall back to a browser cookie or redirect.

6. Create the staging service token under **Zero Trust → Access controls → Service credentials**. Copy its ID/secret once into a private password manager, then configure FinTracka by piping the secret; never paste the secret into the command itself:

   ```sh
   read -s FINTRACKA_STAGING_ACCESS_SECRET
   printf '%s' "$FINTRACKA_STAGING_ACCESS_SECRET" | \
     .venv/bin/python -m fintracka.cli configure remote \
       --viewer-url https://VIEWER_STAGING_HOST \
       --publisher-url https://PUBLISHER_STAGING_HOST \
       --client-id STAGING_ACCESS_CLIENT_ID \
       --secret-stdin
   unset FINTRACKA_STAGING_ACCESS_SECRET
   ```

   The two values are stored in macOS Keychain; SQLite stores only opaque reference names.

## Synthetic staging acceptance

Publish only `tests/fixtures/remote_snapshot_v1.json`. Do not point staging at the live application data directory.

Record date, pass/fail, snapshot byte count, upload wall time, Worker CPU/requests from Cloudflare observability, and iPhone cellular load/filter time—never the displayed financial fixture values.

| Check | Required result | Status |
|---|---|---|
| Viewer exact David identity + MFA | Allowed | Not run |
| Viewer exact Ariela identity + MFA | Allowed | Not run |
| Any other/no identity | Denied before Worker | Not run |
| Publisher valid service token | POST/DELETE allowed | Not run |
| Missing/wrong/expired token | 401/403, no redirect | Not run |
| Publisher unsupported method/path | 404/405, no details | Not run |
| Viewer mutation methods | 405 | Not run |
| Production and preview Worker URLs | Both Access-protected | Not run |
| Direct/public R2 URL | Unavailable | Not run |
| Publish interrupted/replayed/lower sequence | Previous active remains readable | Covered locally; stage pending |
| Mac off | Last snapshot remains viewable and shows freshness | Not run |
| Purge | Viewer unavailable; bucket empty | Not run |

## Phase 2 automation drill

Use a separate staging data directory containing only synthetic or Plaid Sandbox data. Check startup publish, successful post-sync publish, failed/partial sync with no publish, manual publish, and the hourly LaunchAgent. Then test offline retry on the next scheduled run, locked Keychain, sleep/wake, simultaneous manual/scheduled triggers, stale indication, service-token rotation, human-session revocation, and explicit purge.

```sh
.venv/bin/python -m fintracka.cli remote publish --data-dir /private/staging/data
.venv/bin/python -m fintracka.cli remote schedule install --data-dir /private/staging/data
.venv/bin/python -m fintracka.cli remote schedule status --data-dir /private/staging/data
.venv/bin/python -m fintracka.cli remote purge --confirm-delete-remote-snapshot --data-dir /private/staging/data
```

Scheduled work runs only while the user session and Keychain are available and the Mac is awake. Missed hourly intervals are recovered by the next startup/post-sync/scheduled publication; no queue of old snapshots is replayed.

## Emergency revocation and purge

If the Mac is available, remove the hourly schedule, purge, then revoke credentials:

```sh
.venv/bin/python -m fintracka.cli remote schedule remove
.venv/bin/python -m fintracka.cli remote purge --confirm-delete-remote-snapshot
```

If the Mac is lost or unavailable:

1. Zero Trust → Service credentials: revoke the FinTracka service token.
2. Access → Applications: disable or delete the Publisher and Viewer applications/policies to stop all access.
3. Workers & Pages: remove Worker routes/deployments if containment requires it.
4. R2 → the relevant bucket: delete `active.json` and every object under `snapshots/`, or empty the bucket; verify it is empty.
5. Review Access, Worker, R2 Data Access, and audit logs for unexpected activity. These logs are useful but are not a complete forensic record.

R2 deletion is strongly consistent for reads, but this procedure cannot promise immediate physical erasure from provider backups, logs, or legal-retention systems. Confirm the current provider policy before live approval.

## No-secret and privacy verification

```sh
./scripts/verify.sh
python scripts/scan_local_secrets.py
git grep -nEi 'CF-Access-Client-Secret|cfast_|access[_-]?token|account[_-]?id' -- ':!REMOTE_VIEWER_RUNBOOK.md'
find frontend/dist-viewer -type f -maxdepth 2 -exec grep -IlE 'CF-Access|keychain|external_connection_id|raw_payload' {} +
```

Inspect R2 custom metadata, Worker/Access logs, local `logs/`, browser local/session storage, IndexedDB, Cache Storage, service workers, CI logs, and built assets. They must contain no service secret, provider identifier, raw payload, private notes, or household financial data beyond the intentionally sanitized snapshot object.

Policy references reviewed for this runbook: [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), [Cloudflare service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/), [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/), [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/), [R2 Data Access Logs](https://developers.cloudflare.com/r2/buckets/data-access-logs/), and [Plaid legal/developer policy](https://plaid.com/legal/). Plaid's current developer policy requires appropriate authorized-user controls and restricts distributing End User Data; confirm the private household viewer remains within the approved internal use case before live publication.
