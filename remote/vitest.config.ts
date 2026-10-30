import path from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      miniflare: {
        d1Databases: ["COMMANDS"],
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(directory, "migrations")),
        },
      },
    })),
  ],
});
