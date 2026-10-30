# FinTracka remote viewer runbook

The remote viewer is a sanitized copy of the local ledger. SQLite on the Mac remains authoritative. Financial views are read-only and the viewer is not a backup. An authenticated household member may submit one narrowly typed category/subcategory proposal with a one-time, current-and-future, or eligible-past-and-future scope; only the Mac can validate and apply it to the ledger. The remote service cannot sync banks, change amounts/accounts/owners, bulk-edit arbitrary fields, or recover local data.

## Scoped mobile editing rollout — 2026-10-30

- Worker command protocol v2 is deployed to staging and production. Worker versions: staging `74dc7d54-7ea2-4ff2-8492-4f2b37e78bb8`; production `ee9ec644-fc02-44e4-a411-467e74558b88`.
- D1 migration `0002_mobile_command_v2.sql` was applied once and its second application reported no pending migrations in both environments.
- A fresh production snapshot advertising command versions `[1, 2]` was published after deployment.
- Missing and deliberately invalid Mac credentials return `401` on both Viewer origins. Unauthenticated human Viewer requests still redirect to the interactive Access login. Valid production machine authentication reached the Mac API and found no queued command.
- Both household member mappings are active. The mobile processor and its LaunchAgent remain disabled until the controlled `1×` and `↔` production reconciliations below are completed.
- The phone editor defaults to `↔ Past + future` every time it opens. It does not persist this selection. `1×` and `→ Current + future` remain available. Cash withdrawals and Uncategorized changes are forced to `1×`.
- Service-token expiry is intentionally not stored in Git. Confirm its expiration and renewal reminder in the household password manager before enabling the schedule.

## Release gate

Do not publish household data until every staging and approval item below is checked. As of 2026-10-28, the private R2 bucket and both Access-protected staging Workers are deployed with preview URLs disabled. Only the canonical synthetic fixture is stored remotely. Household approval, both interactive viewer logins, the remaining staging drills, and the live Cloudflare/Plaid policy review are still required.

- [x] Python, Worker, frontend, contract, mobile, browser-storage, interruption, and dependency tests pass with synthetic data.
- [x] Canonical snapshot is 566,949 bytes, below the 5 MiB hard gate. The viewer bundle is 568,815 bytes JavaScript plus 20,556 bytes CSS before transfer compression.
- [x] Local Playwright exercised 320/375/390/430/768/1280 px, all five screens, filters, drawers, stale/no-snapshot states, and no browser persistence.
- [x] Wrangler authenticated to the intended household Cloudflare account.
- [x] R2 enabled for the account after reviewing and accepting Cloudflare storage/billing terms.
- [ ] Synthetic staging deployed; completed acceptance results are recorded below and interactive/drill checks remain pending.
- [ ] David and Ariela explicitly approve Cloudflare storing the sanitized transaction snapshot.
- [ ] Current Plaid agreement/use-case and Cloudflare privacy, retention, location, and deletion terms reviewed by the household.
- [ ] Production starts empty; one manual live publish is reconciled before automation is enabled.

If the snapshot exceeds 5 MiB or a supported iPhone cannot load/filter it acceptably, stop. Design a D1-backed viewer; do not silently remove history or fields.

## Mobile-command security boundary

Mobile classification editing has a separate release gate from snapshot viewing. Keep it disabled until every item below passes:

- [x] D1 stores only command metadata and category/subcategory IDs; no amount, merchant, description, account, provider payload, or financial snapshot.
- [x] Browser users are authenticated by the existing household Viewer Access application.
- [x] Create a second, more-specific Access application for `/api/v1/mobile/mac/*` on each Viewer host.
- [x] Give that application only a **Service Auth** policy for a new, dedicated FinTracka mobile-command service token. Do not reuse the Publisher token.
- [x] Put that application's audience in `ACCESS_MAC_AUD`, deploy, then run `npm run check:deployment -- --require-mac-access`.
- [x] Apply D1 migrations twice (the second run must report no migrations), then test missing, wrong, and valid machine credentials. Expired/revoked credential drills remain part of rotation testing.
- [ ] Provision the two exact household member mappings from the Mac, reconcile controlled `1×` and `↔` commands, and only then enable/schedule production processing. The mappings are provisioned; reconciliation remains.

The more-specific Mac application must win over the general Viewer application for `/api/v1/mobile/mac/*`. Bad or missing service credentials must return 401/403 and must never fall back to an interactive login redirect. Phone API routes remain under the exact-household, MFA-protected Viewer application. `ACCESS_MAC_AUD=UNCONFIGURED_DENY_ALL` intentionally keeps the Mac routes fail-closed before this setup is complete.

Apply and verify the command schema:

```sh
cd remote
npx wrangler d1 migrations apply fintracka-mobile-commands-staging --remote --config wrangler.viewer.jsonc --env staging
npx wrangler d1 migrations apply fintracka-mobile-commands-staging --remote --config wrangler.viewer.jsonc --env staging
npx wrangler d1 migrations apply fintracka-mobile-commands-production --remote --config wrangler.viewer.jsonc --env production
npx wrangler d1 migrations apply fintracka-mobile-commands-production --remote --config wrangler.viewer.jsonc --env production
npm run check:deployment
# After ACCESS_MAC_AUD is configured:
npm run check:deployment -- --require-mac-access
```

Configure the Mac only after creating the dedicated token. Pipe secrets and member emails over standard input so they are not placed in shell history:

```sh
read -s FINTRACKA_COMMAND_SECRET
printf '%s' "$FINTRACKA_COMMAND_SECRET" | \
  .venv/bin/python -m fintracka.cli configure mobile-commands \
    --gateway-url https://VIEWER_PRODUCTION_HOST \
    --client-id MOBILE_COMMAND_ACCESS_CLIENT_ID \
    --secret-stdin
unset FINTRACKA_COMMAND_SECRET

read -r FINTRACKA_MEMBER_EMAIL
printf '%s' "$FINTRACKA_MEMBER_EMAIL" | \
  .venv/bin/python -m fintracka.cli remote commands member upsert \
    --member-id HOUSEHOLD_MEMBER_ID \
    --display-name HOUSEHOLD_MEMBER_DISPLAY_NAME \
    --email-stdin
unset FINTRACKA_MEMBER_EMAIL

.venv/bin/python -m fintracka.cli remote commands status
.venv/bin/python -m fintracka.cli remote commands process
.venv/bin/python -m fintracka.cli remote commands enable
.venv/bin/python -m fintracka.cli remote commands schedule install
.venv/bin/python -m fintracka.cli remote commands schedule status
```

The LaunchAgent checks once per minute and at login while the user session, Mac, network, and Keychain are available. Disable safely with `remote commands disable`, then `remote commands schedule remove`. Mark a replaced household member inactive by rerunning `member upsert --inactive`; revoke their Viewer Access identity/session as a separate Cloudflare action. D1 pending commands expire after 30 days and terminal records after 90 days. Local redacted receipts are retained so a replay can never apply the same command twice. Protocol-v1 commands remain one-time; protocol-v2 commands carry the explicit scope.

### Controlled v2 reconciliation gate

Keep the scheduler off. From the authenticated phone Viewer, choose known, harmless transactions and queue:

1. A `1×` edit. Record the target's revision and learned-rule counts locally before processing. Process once; verify only the target changed, one permanent receipt exists, no categorization/subcategory rule changed, and processing the receipt again is a no-op.
2. A `↔` edit for a merchant with understood history. Record eligible matching IDs before processing. Verify the target plus only non-manual, non-withdrawal eligible matches changed; the learned category/subcategory rules use the desktop rule format; `affected_count` is exact; and replay is a no-op.

Never choose these test transactions on the user's behalf. The household member must identify the intended transaction and destination classification in the authenticated Viewer.

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

   The two values are stored in macOS Keychain; SQLite stores only opaque reference names. Configuration leaves automatic publication disabled. A manual publish still works for reconciliation; `fintracka remote enable` is a separate post-approval step.

## Synthetic staging acceptance

Publish only `tests/fixtures/remote_snapshot_v1.json`. Do not point staging at the live application data directory.

Record date, pass/fail, snapshot byte count, upload wall time, Worker CPU/requests from Cloudflare observability, and iPhone cellular load/filter time—never the displayed financial fixture values.

| Check | Required result | Status |
|---|---|---|
| Viewer exact David identity + MFA | Allowed | Pending interactive login |
| Viewer exact Ariela identity + MFA | Allowed | Not run |
| Any other/no identity | Denied before Worker | Pass for no identity (Access login redirect) |
| Publisher valid service token | POST/DELETE allowed | Pass for POST; DELETE pending purge drill |
| Missing/wrong/expired token | 401/403, no redirect | Pass for missing/wrong token |
| Publisher unsupported method/path | 404/405, no details | Pass |
| Viewer mutation methods | 405 | Not run |
| Production and preview Worker URLs | Both Access-protected | Preview URLs disabled; production intentionally absent |
| Direct/public R2 URL | Unavailable | Pass (private bucket; no public endpoint) |
| Publish interrupted/replayed/lower sequence | Previous active remains readable | Replay/lower sequence pass; interruption covered locally |
| Mac off | Last snapshot remains viewable and shows freshness | Not run |
| Purge | Viewer unavailable; bucket empty | Not run |

Synthetic staging publication on 2026-10-28 uploaded 530,210 bytes in 1.53 seconds. Cloudflare observability and iPhone cellular timing remain to be recorded.

## Phase 2 automation drill

Use a separate staging data directory containing only synthetic or Plaid Sandbox data. Check startup publish, successful post-sync publish, failed/partial sync with no publish, manual publish, and the hourly LaunchAgent. Then test offline retry on the next scheduled run, locked Keychain, sleep/wake, simultaneous manual/scheduled triggers, stale indication, service-token rotation, human-session revocation, and explicit purge.

```sh
.venv/bin/python -m fintracka.cli remote publish --data-dir /private/staging/data
.venv/bin/python -m fintracka.cli remote enable --data-dir /private/staging/data
.venv/bin/python -m fintracka.cli remote schedule install --data-dir /private/staging/data
.venv/bin/python -m fintracka.cli remote schedule status --data-dir /private/staging/data
.venv/bin/python -m fintracka.cli remote purge --confirm-delete-remote-snapshot --data-dir /private/staging/data
```

Scheduled work runs only while the user session and Keychain are available and the Mac is awake. Missed hourly intervals are recovered by the next startup/post-sync/scheduled publication; no queue of old snapshots is replayed.

For production, reconcile the first manual snapshot while automation is still disabled. Only after that comparison passes should `remote enable` and the hourly schedule be installed. Use `remote disable` before maintenance or whenever automatic publication should stop.

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
