# FinTracka mobile editing: Cloudflare setup handoff

## Objective

Finish and safely activate FinTracka's mobile transaction-category editing.

The hosted Viewer is already usable. A household member can propose a one-time, current-and-future, or eligible-past-and-future category/subcategory change from the phone. The Mac retrieves queued edits, validates them against the local ledger, applies them exactly once, and reports the result to the phone.

## Implementation status — 2026-10-30

The Cloudflare boundary and protocol implementation are complete:

- Both path-specific Access applications and the dedicated Keychain-backed service token are configured.
- Staging and production Mac endpoints reject missing/fake credentials with `401`; human routes remain interactive Access protected.
- Both D1 databases are migrated to protocol v2, with a successful idempotent second migration run.
- Viewer protocol v2 and the scoped phone UI are deployed to staging and production.
- The Mac authenticates successfully and both household member mappings are active.
- Processing and the one-minute LaunchAgent remain disabled pending the two controlled live reconciliation checks (`1×` and `↔`).

The editor defaults to `↔ Past + future` on every opening without browser persistence. Cash withdrawals and Uncategorized changes are forced to `1×`. Protocol-v1 commands remain compatible and normalize to one-time.

This task does **not** make Cloudflare authoritative. The local SQLite ledger on the Mac remains authoritative. The remote system must never receive Plaid credentials, raw provider payloads, account credentials, or unrestricted write access.

## Current state

- Repository: `/Users/david/Cursor Project/FinTracka`
- Branch: `main`
- Production Viewer: `https://fintracka-viewer-production.fintracka-david.workers.dev`
- Staging Viewer: `https://fintracka-viewer-staging.fintracka-david.workers.dev`
- Cloudflare Access team domain: `https://hidden-silence-257f.cloudflareaccess.com`
- Existing human Viewer Access applications and human audience values are already configured.
- D1 databases already exist:
  - staging: `fintracka-mobile-commands-staging`
  - production: `fintracka-mobile-commands-production`
- `remote/wrangler.viewer.jsonc` contains separate configured Mac Access audiences for staging and production.
- Local processing remains disabled until all gates below pass.
- The existing Publisher service token must **not** be reused.

The current code expects two different JWT audiences:

- `ACCESS_USER_AUD`: the existing interactive, MFA-protected household Viewer application.
- `ACCESS_MAC_AUD`: a new, path-specific Cloudflare Access application used only by the Mac command processor.

They must remain different.

## Required architecture

```text
iPhone browser
  -> existing household Viewer Access app (interactive login + MFA)
  -> /api/v1/mobile/session and /api/v1/mobile/commands/*
  -> queues narrowly typed command metadata in D1

Mac command processor
  -> dedicated Access service token from macOS Keychain
  -> path-specific Mac Access app
  -> /api/v1/mobile/mac/*
  -> claims command, validates/applies it locally, reports completion
```

The more-specific Mac Access application must take precedence over the existing whole-host Viewer application for `/api/v1/mobile/mac/*`.

## Non-negotiable security requirements

1. Do not reuse the snapshot Publisher service token.
2. Do not paste any service-token secret, household email, API token, or financial value into chat, Git, screenshots, tickets, or command-line arguments.
3. Store the new service-token secret only in macOS Keychain through FinTracka's `--secret-stdin` flow.
4. The Mac Access application must use a **Service Auth** policy, not Allow, Bypass, or an interactive identity policy.
5. Missing, incorrect, revoked, or expired machine credentials must return `401` or `403`. They must not redirect to Cloudflare login and must not reach the Worker.
6. Preview URLs remain disabled. Do not loosen `workers_dev`, R2, Viewer, Publisher, or existing MFA protections.
7. `ACCESS_MAC_AUD` is the Access application's 64-character audience tag. It is **not** the service-token client ID ending in `.access`.
8. Keep command processing disabled until staging, authentication, reconciliation, and production checks all pass.

## Recommended execution route: Cloudflare dashboard

The browser dashboard is the simplest one-time setup. The Cloudflare API can also do this, but it requires a separate administrative API token with Access Apps/Policies Write and Access Service Tokens Write permissions. Do not create that extra credential unless dashboard automation is genuinely needed.

Official references:

- [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [Cloudflare self-hosted applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)

## Phase A: create the dedicated service token

In the Cloudflare Zero Trust dashboard:

1. Open **Access controls -> Service credentials -> Service Tokens**.
2. Create a token named `FinTracka Mobile Commands`.
3. Choose a reasonable explicit expiration, record it in the household password manager, and set a reminder before expiry. One year is acceptable for the initial setup.
4. Copy the generated values exactly once:
   - Client ID, which normally ends in `.access`
   - Client secret, which Cloudflare only displays at creation time
5. Store both in a private password manager temporarily. Never place the secret in this repository.

## Phase B: create path-specific Access applications

Create one Self-hosted Access application for each Viewer environment. Separate applications are preferred because they provide distinct audiences and make staging/production isolation explicit.

### Staging application

- Suggested name: `FinTracka Mobile Commands - Staging`
- Host: `fintracka-viewer-staging.fintracka-david.workers.dev`
- Path: `/api/v1/mobile/mac/*`
- Policy action: **Service Auth**
- Include rule: the `FinTracka Mobile Commands` service token only
- Configure service-auth failures to return `401`/`403`, not an interactive login redirect, if the dashboard exposes that option.

### Production application

- Suggested name: `FinTracka Mobile Commands - Production`
- Host: `fintracka-viewer-production.fintracka-david.workers.dev`
- Path: `/api/v1/mobile/mac/*`
- Policy action: **Service Auth**
- Include rule: the `FinTracka Mobile Commands` service token only
- Configure service-auth failures to return `401`/`403`, not an interactive login redirect, if the dashboard exposes that option.

Do not add household email rules to these two applications. Human access remains on the existing Viewer applications; these new applications are only for the Mac.

After saving each application, copy its **Application Audience (AUD) Tag**. Each should be a 64-character hexadecimal value. Record which value belongs to staging and which belongs to production.

## Phase C: configure and deploy the Worker

Edit only the two `ACCESS_MAC_AUD` values in:

`remote/wrangler.viewer.jsonc`

Replace `UNCONFIGURED_DENY_ALL` with the corresponding staging and production application audience tags. Do not change `ACCESS_USER_AUD`.

Then run:

```sh
cd '/Users/david/Cursor Project/FinTracka/remote'

npm ci
npm run typecheck
npm run test:ci
npm run check:deployment -- --require-mac-access

npx wrangler d1 migrations apply fintracka-mobile-commands-staging \
  --remote --config wrangler.viewer.jsonc --env staging
npx wrangler d1 migrations apply fintracka-mobile-commands-staging \
  --remote --config wrangler.viewer.jsonc --env staging

npx wrangler d1 migrations apply fintracka-mobile-commands-production \
  --remote --config wrangler.viewer.jsonc --env production
npx wrangler d1 migrations apply fintracka-mobile-commands-production \
  --remote --config wrangler.viewer.jsonc --env production

npm run deploy:viewer:staging
npm run deploy:viewer:production
```

Each second migration command must report that there are no migrations left to apply. This is an idempotency check, not an accidental duplicate.

## Phase D: verify the external authentication boundary

Before placing the valid credentials on the Mac, test both environments.

For each Viewer origin:

1. A request to `/api/v1/mobile/mac/commands/claim` with no service-token headers must return `401` or `403`.
2. The same request with deliberately incorrect token headers must return `401` or `403`.
3. Neither request may return `2xx` or `3xx`.
4. `/api/v1/mobile/session` without an authenticated human browser session must still be denied by the existing Viewer Access application.
5. A normal authenticated household Viewer login must continue working.

The repository check can verify the unauthenticated boundary:

```sh
cd '/Users/david/Cursor Project/FinTracka/remote'

FINTRACKA_DEPLOYMENT_ORIGIN='https://fintracka-viewer-staging.fintracka-david.workers.dev' \
  npm run check:deployment -- --require-mac-access

FINTRACKA_DEPLOYMENT_ORIGIN='https://fintracka-viewer-production.fintracka-david.workers.dev' \
  npm run check:deployment -- --require-mac-access
```

Do not use `curl -L` for these checks because following a redirect can hide an incorrect Access configuration.

## Phase E: put the production credential in macOS Keychain

Run this locally on David's Mac. Substitute the real `.access` client ID, but do not put the secret directly in the command:

```sh
cd '/Users/david/Cursor Project/FinTracka'

read -s FINTRACKA_COMMAND_SECRET
printf '%s' "$FINTRACKA_COMMAND_SECRET" | \
  .venv/bin/python -m fintracka.cli configure mobile-commands \
    --gateway-url 'https://fintracka-viewer-production.fintracka-david.workers.dev' \
    --client-id 'REPLACE_WITH_CLIENT_ID_ENDING_IN_.access' \
    --secret-stdin
unset FINTRACKA_COMMAND_SECRET
```

Confirm that no secret was written to shell history, files, logs, or Git. Do not print Keychain contents.

## Phase F: provision the two household identities

Provision David and Ariela using the exact email addresses used by Cloudflare Access. Read each email from standard input so it does not enter shell history.

Use stable, non-email internal member IDs, for example `david` and `ariela`:

```sh
cd '/Users/david/Cursor Project/FinTracka'

read -r FINTRACKA_MEMBER_EMAIL
printf '%s' "$FINTRACKA_MEMBER_EMAIL" | \
  .venv/bin/python -m fintracka.cli remote commands member upsert \
    --member-id 'david' \
    --display-name 'David' \
    --email-stdin
unset FINTRACKA_MEMBER_EMAIL

read -r FINTRACKA_MEMBER_EMAIL
printf '%s' "$FINTRACKA_MEMBER_EMAIL" | \
  .venv/bin/python -m fintracka.cli remote commands member upsert \
    --member-id 'ariela' \
    --display-name 'Ariela' \
    --email-stdin
unset FINTRACKA_MEMBER_EMAIL
```

Do not guess or normalize to a different address. The address must match the authenticated Cloudflare identity.

## Phase G: staging/reconciliation test before enabling automation

1. Keep the processor disabled.
2. Confirm current status:

   ```sh
   cd '/Users/david/Cursor Project/FinTracka'
   .venv/bin/python -m fintracka.cli remote commands status
   ```

3. From an authenticated household phone session, submit one harmless `1×` category/subcategory edit for a known transaction. After it passes, submit one understood `↔` edit.
4. Manually process it once:

   ```sh
   .venv/bin/python -m fintracka.cli remote commands process
   ```

5. Verify all of the following:
   - The `1×` command changes exactly one transaction and creates no rule.
   - The `↔` command changes only the target and eligible non-manual, non-withdrawal historical matches, creates/updates the same learned rules used by desktop editing, and reports the exact affected count.
   - Amount, date, account, owner, notes, and merchant did not change.
   - Replaying either permanent receipt makes no further ledger or rule changes.
   - Reprocessing does not apply the command a second time.
   - The phone receives a completed or rejected result without exposing sensitive local data.
   - A stale edit or invalid taxonomy/revision is rejected safely.
6. Inspect logs only for error codes and operational metadata. No financial or credential data should appear.

## Phase H: enable the once-per-minute processor

Only after every preceding gate passes:

```sh
cd '/Users/david/Cursor Project/FinTracka'

.venv/bin/python -m fintracka.cli remote commands enable
.venv/bin/python -m fintracka.cli remote commands schedule install
.venv/bin/python -m fintracka.cli remote commands schedule status
.venv/bin/python -m fintracka.cli remote commands status
```

Expected behavior:

- LaunchAgent label: `com.fintracka.mobile-commands`
- It starts at login and polls once per minute while the Mac, user session, network, and Keychain are available.
- Empty polling is expected and designed for the Cloudflare free-tier estimate.

## Completion criteria

The task is complete only when all are true:

- Both path-specific Access applications exist and have separate, valid audience tags.
- Both applications have only the intended Service Auth token policy.
- The existing interactive Viewer applications and MFA allowlist are unchanged.
- `ACCESS_MAC_AUD` is configured correctly in both environments and differs from `ACCESS_USER_AUD`.
- TypeScript checks, Worker tests, deployment checks, and D1 idempotency checks pass.
- Missing, wrong, revoked, and expired machine credentials return `401`/`403`, never `2xx` or login redirects.
- A valid token reaches the Mac API without permitting access to unrelated routes.
- David and Ariela's exact identity mappings are provisioned without committing their emails.
- One harmless `1×` command and one understood `↔` command are each reconciled exactly once before automation is enabled.
- The schedule reports installed/enabled and successfully checks once per minute.
- No secret appears in Git, shell history, logs, screenshots, or chat.

## Rollback and emergency stop

To stop local processing without deleting data:

```sh
cd '/Users/david/Cursor Project/FinTracka'
.venv/bin/python -m fintracka.cli remote commands disable
.venv/bin/python -m fintracka.cli remote commands schedule remove
```

If the machine credential may be compromised:

1. Revoke the `FinTracka Mobile Commands` service token in Cloudflare immediately.
2. Disable/remove the local schedule.
3. Confirm requests with the revoked credential return `401`/`403`.
4. Create a replacement token and repeat the Keychain configuration. Never restore the old token.

If a household member should lose access, mark their member mapping inactive and separately remove/revoke their identity from the interactive Viewer Access policy/session.

## API alternative

An agent may use the Cloudflare REST API instead of the browser only if a purpose-built API token already exists or the user explicitly approves creating one. The API token needs the narrowest account-level permissions capable of:

- Creating and reading Access service tokens.
- Creating/updating Access applications and policies.

Use Cloudflare's documented Access API, never scrape the dashboard, and revoke the administrative API token after the one-time setup if it is no longer needed. The resulting architecture, policies, audience values, tests, and Keychain handling must be identical to the dashboard procedure above.

## Relevant repository files

- `REMOTE_VIEWER_RUNBOOK.md`
- `remote/wrangler.viewer.jsonc`
- `remote/scripts/check-mobile-command-deployment.ts`
- `remote/src/mobileGateway.ts`
- `src/fintracka/mobile_command_client.py`
- `src/fintracka/mobile_command_config.py`
- `src/fintracka/launchd.py`
- `docs/superpowers/specs/2026-10-30-mobile-scoped-classification-design.md`
- `docs/superpowers/plans/2026-10-30-mobile-scoped-classification.md`

Do not modify unrelated repository files or any user security/self-control software.
