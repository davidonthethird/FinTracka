import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "wrangler.viewer.jsonc"), "utf8"));
const failures: string[] = [];

for (const environment of ["staging", "production"]) {
  const entry = config.env?.[environment];
  const database = entry?.d1_databases?.find((item: any) => item.binding === "COMMANDS");
  if (!database?.database_id || !database?.database_name) failures.push(`${environment}: missing COMMANDS D1 binding`);
  if (database?.migrations_dir !== "migrations") failures.push(`${environment}: wrong D1 migrations directory`);
  if (!entry?.vars?.ACCESS_TEAM_DOMAIN?.startsWith("https://")
      || !entry.vars.ACCESS_TEAM_DOMAIN.endsWith(".cloudflareaccess.com")) failures.push(`${environment}: invalid Access team domain`);
  if (!/^[a-f0-9]{64}$/.test(entry?.vars?.ACCESS_USER_AUD ?? "")) failures.push(`${environment}: invalid user Access audience`);
  if ((entry?.vars?.ACCESS_USER_AUD ?? "").trim() === (entry?.vars?.ACCESS_MAC_AUD ?? "").trim()) failures.push(`${environment}: browser and Mac Access audiences must be different`);
  if (!entry?.vars?.HOUSEHOLD_ID || !entry?.vars?.HOUSEHOLD_NAME) failures.push(`${environment}: missing household binding`);
  if (entry?.preview_urls !== undefined && entry.preview_urls !== false) failures.push(`${environment}: preview URLs must remain disabled`);
}

const migration = readFileSync(join(root, "migrations", "0001_mobile_commands.sql"), "utf8").toLowerCase();
for (const field of ["merchant", "amount_minor", "account_name", "institution_name", "provider_transaction", "description"]) {
  if (migration.includes(field)) failures.push(`D1 schema contains forbidden financial field: ${field}`);
}

if (process.argv.includes("--require-mac-access")) {
  for (const environment of ["staging", "production"]) {
    const audience = config.env[environment].vars.ACCESS_MAC_AUD;
    if (!/^[a-f0-9]{64}$/.test(audience)) failures.push(`${environment}: Mac Access application is not configured`);
  }
}

const origin = process.env.FINTRACKA_DEPLOYMENT_ORIGIN;
if (origin) {
  if (!origin.startsWith("https://")) failures.push("deployment origin must use HTTPS");
  else await checkExternalBoundary(origin);
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Mobile-command deployment configuration passed (free-tier estimate: 1,440 indexed empty polls/day)." );
}

async function checkExternalBoundary(origin: string) {
  for (const path of ["/api/v1/mobile/session", "/api/v1/mobile/mac/commands/claim"]) {
    try {
      const response = await fetch(new URL(path, origin), {
        method: path.includes("/mac/") ? "POST" : "GET",
        redirect: "manual",
        headers: path.includes("/mac/") ? { "Content-Type": "application/json" } : undefined,
        body: path.includes("/mac/") ? JSON.stringify({ limit: 1 }) : undefined,
      });
      if (response.status >= 200 && response.status < 300) failures.push(`unauthenticated request reached ${path}`);
    } catch {
      failures.push(`TLS or network verification failed for ${path}`);
    }
  }
}
