#!/usr/bin/env node
// Push every Sprint 02 env var from .env.local up to the lapsed-web
// project on Vercel, across development/preview/production. Idempotent:
// if a var is already present on a target env it is removed and
// re-added (Vercel doesn't have a direct "update value" endpoint).
//
// SAFETY: this script ONLY pushes the EXPECTED list. Random vars in
// .env.local are ignored. Stripe / Twilio / Anthropic vars come in
// later sprints — explicitly excluded here so we don't ship them to
// Vercel before they're actually used.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROJECT_NAME = "lapsed-web";

// Keep in sync with apps/web/app/lib/env.ts and scripts/vercel-env-check.mjs.
const EXPECTED = [
  { key: "SHOPIFY_API_KEY", type: "encrypted" },
  { key: "NEXT_PUBLIC_SHOPIFY_API_KEY", type: "plain", mirrorOf: "SHOPIFY_API_KEY" },
  { key: "SHOPIFY_API_SECRET", type: "encrypted" },
  { key: "SHOPIFY_SCOPES", type: "plain" },
  { key: "SHOPIFY_OPTIONAL_SCOPES", type: "plain" },
  { key: "SHOPIFY_DEV_STORE", type: "plain" },
  { key: "SHOPIFY_APP_URL", type: "plain", default: "https://app.lapsed.ai" },
  { key: "NEXT_PUBLIC_SUPABASE_URL", type: "plain" },
  { key: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", type: "plain" },
  { key: "SUPABASE_SECRET_KEY", type: "encrypted" },
  { key: "SUPABASE_JWT_SECRET", type: "encrypted" },
  { key: "SUPABASE_DB_URL", type: "encrypted" },
  { key: "TOKEN_ENCRYPTION_KEY", type: "encrypted" },
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

async function api(path, init = {}) {
  const url = `https://api.vercel.com${path}${path.includes("?") ? teamQ : `?${teamQ.slice(1)}`}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${vercelToken}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Vercel API ${res.status} on ${path}: ${await res.text()}`);
  }
  return res.json();
}

const projects = await api(`/v9/projects?limit=100`);
const project = projects.projects.find((p) => p.name === PROJECT_NAME);
if (!project) {
  console.error(`Vercel project "${PROJECT_NAME}" not found`);
  process.exit(2);
}

const existing = await api(`/v9/projects/${project.id}/env?decrypt=false`);
const byKey = new Map();
for (const e of existing.envs) {
  if (!byKey.has(e.key)) byKey.set(e.key, []);
  byKey.get(e.key).push(e);
}

for (const spec of EXPECTED) {
  // `mirrorOf` lets a NEXT_PUBLIC_* key inherit its value from the
  // canonical (non-public) env var, so we don't duplicate values in
  // .env.local.
  const sourceKey = spec.mirrorOf ?? spec.key;
  const value = pickEnv(spec.key) ?? pickEnv(sourceKey) ?? spec.default ?? null;
  if (!value) {
    console.warn(`  skipping ${spec.key} — not present in .env.local`);
    continue;
  }

  // Delete any existing entries for this key so the upsert is clean.
  const stale = byKey.get(spec.key) ?? [];
  for (const e of stale) {
    await api(`/v9/projects/${project.id}/env/${e.id}`, { method: "DELETE" });
  }

  await api(`/v10/projects/${project.id}/env`, {
    method: "POST",
    body: JSON.stringify({
      key: spec.key,
      value,
      type: spec.type === "encrypted" ? "encrypted" : "plain",
      target: ENVIRONMENTS,
    }),
  });
  console.log(`  ✓ pushed ${spec.key} to ${ENVIRONMENTS.join(", ")}`);
}

console.log("\nDone. Run `pnpm vercel:env:check` to verify presence.");
