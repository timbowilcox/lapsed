// Regenerate src/types.ts from the remote Supabase schema.
//
// Uses the Supabase Management API directly because `supabase gen types
// typescript` hits a known access-control bug for this project's token
// (returns 403 even though the same token can run db push). The API
// endpoint at /v1/projects/{ref}/types/typescript works fine.

import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const envPath = join(__dirname, "..", "..", "..", ".env.local");
const env = readFileSync(envPath, "utf8");

const token = env.match(/^SUPABASE_ACCESS_TOKEN=(.+)$/m)?.[1]?.trim();
const ref = env.match(/^SUPABASE_PROJECT_REF=(.+)$/m)?.[1]?.trim();

if (!token || !ref) {
  console.error("SUPABASE_ACCESS_TOKEN or SUPABASE_PROJECT_REF missing from .env.local");
  process.exit(1);
}

const url = `https://api.supabase.com/v1/projects/${ref}/types/typescript?included_schemas=public`;
const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

if (!res.ok) {
  console.error(`management API ${res.status}: ${await res.text()}`);
  process.exit(1);
}

const body = await res.json();
const target = join(__dirname, "..", "src", "types.ts");
writeFileSync(target, body.types);
console.log(`wrote ${body.types.length} chars to ${target}`);
