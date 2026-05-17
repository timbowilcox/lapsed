#!/usr/bin/env node
// Verify that the Vercel project `lapsed-web` has every env var that
// the production app expects AND that turbo.json's @lapsed/web#build env
// array declares them all. Fails CI on either gap.
//
// Reads the expected list from EXPECTED_ALL — keep in sync with
// apps/web/app/lib/env.ts's required() calls and turbo.json.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROJECT_NAME = "lapsed-web";

// ── turbo.json parity check ────────────────────────────────────────────────
// Fail immediately if turbo.json's @lapsed/web#build env array doesn't
// declare every var in EXPECTED_ALL. This prevents the Vercel warning
// "env var stripped by Turborepo" from silently reappearing.

const turboPath = join(process.cwd(), "turbo.json");
const turbo = JSON.parse(readFileSync(turboPath, "utf8"));
const turboEnv = new Set(turbo.tasks?.["@lapsed/web#build"]?.env ?? []);

const EXPECTED_ALL = [
  "SHOPIFY_API_KEY",
  "NEXT_PUBLIC_SHOPIFY_API_KEY",
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
  "ANTHROPIC_API_KEY",
  "CRON_SECRET",
  "PROPENSITY_READY_THRESHOLD",
  "SCORING_TOKEN_CAP_DEFAULT",
  "VOICE_EXTRACTION_DAILY_CAP_DEFAULT",
  "SONNET_MODEL",
  "CAMPAIGN_PROPOSAL_DAILY_CAP_DEFAULT",
  "HOLDOUT_RATE",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "OUTBOUND_DAILY_CAP_DEFAULT",
  "INBOUND_REPLY_LATENCY_BUDGET_MS",
  "NO_REPLY_SWEEP_DAYS",
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_STARTER",
  "STRIPE_PRICE_GROWTH",
  "STRIPE_PRICE_SCALE",
  "BILLING_GRACE_PERIOD_DAYS"
];

const missingFromTurbo = EXPECTED_ALL.filter((k) => !turboEnv.has(k));
if (missingFromTurbo.length > 0) {
  console.error("turbo.json @lapsed/web#build env is missing:");
  for (const k of missingFromTurbo) console.error(`  ✗ ${k}`);
  console.error(
    "\nAdd these to turbo.json tasks[\"@lapsed/web#build\"].env to prevent " +
      "Turborepo from stripping them from the Vercel build environment."
  );
  process.exit(4);
}
console.log("turbo:env:check — @lapsed/web#build env array matches EXPECTED_ALL ✓\n");

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
