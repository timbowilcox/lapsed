// Sync the monorepo root .env.local into apps/web/.env.local so that
// `next dev` / `next start` / `next build` (which look for env files
// in CWD) can find the project's secrets. Strips NODE_ENV because
// `next start` runs in production mode and an inherited
// NODE_ENV=development triggers a Next warning and inconsistent
// behaviour.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "..", ".env.local");
const dst = join(here, "..", ".env.local");

if (!existsSync(src)) {
  console.log("sync-env: no root .env.local found; skipping");
  process.exit(0);
}

const raw = readFileSync(src, "utf8");
const filtered = raw
  .split(/\r?\n/)
  .filter((line) => !/^\s*NODE_ENV\s*=/.test(line))
  .join("\n");

writeFileSync(dst, filtered);
console.log("sync-env: wrote", dst);
