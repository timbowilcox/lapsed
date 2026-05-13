#!/usr/bin/env node
// Verify that the Vercel project `lapsed-web` has every env var that
// the production app expects. Fails CI when a value is missing on any
// of development, preview, or production.
//
// Reads the expected list from EXPECTED below — keep in sync with
// apps/web/app/lib/env.ts's required() calls.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROJECT_NAME = "lapsed-web";

const EXPECTED_ALL = [
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "SHOPIFY_SCOPES",
  "SHOPIFY_OPTIONAL_SCOPES",
  "SHOPIFY_DEV_STORE",
  "SHOPIFY_APP_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_JWT_SECRET",
  "SUPABASE_DB_URL",
  "TOKEN_ENCRYPTION_KEY",
];

const ENVIRONMENTS = ["development", "preview", "production"];

const envPath = join(process.cwd(), ".env.local");
const envText = readFileSync(envPath, "utf8");
function pickEnv(name) {
  const m = envText.match(new RegExp(`^${name}=(.+)$`, "m"));
  return m ? m[1].trim() : null;
}

const vercelToken = pickEnv("VERCEL_TOKEN");
const teamId = pickEnv("VERCEL_ORG_ID");
if (!vercelToken) {
  console.error("VERCEL_TOKEN missing from .env.local");
  process.exit(1);
}

const teamQ = teamId ? `&teamId=${teamId}` : "";

async function api(path) {
  const res = await fetch(`https://api.vercel.com${path}${path.includes("?") ? teamQ : `?${teamQ.slice(1)}`}`, {
    headers: { Authorization: `Bearer ${vercelToken}` },
  });
  if (!res.ok) {
    throw new Error(`Vercel API ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

const projects = await api(`/v9/projects?limit=100`);
const project = projects.projects.find((p) => p.name === PROJECT_NAME);
if (!project) {
  console.error(`Vercel project "${PROJECT_NAME}" not found`);
  process.exit(2);
}

const envs = await api(`/v9/projects/${project.id}/env?decrypt=false`);
const presence = new Map(); // key -> Set of target envs
for (const e of envs.envs) {
  if (!presence.has(e.key)) presence.set(e.key, new Set());
  for (const t of e.target || []) presence.get(e.key).add(t);
}

let missing = 0;
console.log(`vercel:env:check — project=${PROJECT_NAME}`);
for (const key of EXPECTED_ALL) {
  const have = presence.get(key) ?? new Set();
  const gaps = ENVIRONMENTS.filter((env) => !have.has(env));
  if (gaps.length === 0) {
    console.log(`  ✓ ${key}`);
  } else {
    console.error(`  ✗ ${key} — missing in: ${gaps.join(", ")}`);
    missing++;
  }
}

if (missing > 0) {
  console.error(`\n${missing} env var(s) missing on Vercel for ${PROJECT_NAME}.`);
  process.exit(3);
}
console.log("\nAll expected env vars present on all three target environments.");
