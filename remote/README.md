# FinTracka remote Workers

This package contains two Cloudflare Workers sharing one private R2 bucket:

- `publisher.ts` accepts authenticated POST/DELETE requests from the Mac and atomically activates immutable sanitized snapshots.
- `viewer.ts` serves the active snapshot, metadata-only freshness status, and the dedicated read-only frontend.

The Publisher must be behind strict Cloudflare Access Service Auth. The Viewer must be behind an exact two-person Access allowlist with MFA. Protect preview URLs as well as the normal Worker URLs. The R2 bucket must have no public endpoint.

```sh
npm ci
npm run test:ci
npm run typecheck
cd ../frontend && npm run build:viewer && cd ../remote
npm run deploy:publisher:staging
npm run deploy:viewer:staging
```

Staging and production use separate buckets and Worker environments. Deployment never belongs in CI and requires the manual gate in [`../REMOTE_VIEWER_RUNBOOK.md`](../REMOTE_VIEWER_RUNBOOK.md). No secret, account ID, household identity, or live data belongs in this directory.
