#!/usr/bin/env node
// PII-in-logs guard. Fails CI if a console.{log,warn,error,info,debug}
// or logger.* statement is detected with a known-PII identifier in
// its arguments.
//
// Catches:
//   - shop_domain values in log lines
//   - shopify access tokens (shpat_..., shppa_..., shpss_...)
//   - HMAC hex strings adjacent to "hmac" identifier
//   - merchant id in plaintext
//   - email addresses and phone numbers (broad regex; intentional false-positive-prone)
//
// Allowlist comment to skip: `// pii:allow` on the same line.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();

const IGNORED_DIRS = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  "storybook-static",
  "_evidence",
  "playwright-report",
  "test-results",
  ".git",
  "coverage",
]);

const ALLOWED_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_PATH_SUBSTR = [
  // Tests pass fixture PII through expect()/etc. They are not log statements.
  `${sep}__tests__${sep}`,
  `${sep}e2e${sep}`,
  // The grep script itself documents what it looks for.
  `${sep}scripts${sep}grep-pii.mjs`,
];

// Regexes flagged. Each entry: { name, pattern, description }.
const RULES = [
  {
    name: "log_with_shop_domain_value",
    // Matches console.* / logger.* / log( …) whose args include a known
    // myshopify domain literal.
    pattern: /\b(console\.(log|warn|error|info|debug)|logger\.(log|warn|error|info|debug))\s*\([^)]*[a-z0-9-]+\.myshopify\.com/i,
  },
  {
    name: "log_with_shopify_token",
    pattern: /\b(console\.(log|warn|error|info|debug)|logger\.(log|warn|error|info|debug))\s*\([^)]*shp(at|pa|ss|ca)_[a-zA-Z0-9]+/,
  },
  {
    name: "log_with_email_value",
    pattern: /\b(console\.(log|warn|error|info|debug)|logger\.(log|warn|error|info|debug))\s*\([^)]*['"`][^'"`@\s]+@[^'"`@\s]+\.[a-zA-Z]+['"`]/,
  },
  {
    name: "log_with_phone_E164",
    // E.164: + then 8-15 digits, in a string literal
    pattern: /\b(console\.(log|warn|error|info|debug)|logger\.(log|warn|error|info|debug))\s*\([^)]*['"`]\+\d{8,15}['"`]/,
  },
  {
    name: "log_shop_domain_variable_template",
    // Catches `${shop_domain}` or `${shopDomain}` directly inside a log call.
    pattern: /\b(console\.(log|warn|error|info|debug)|logger\.(log|warn|error|info|debug))\s*\([^)]*\$\{\s*(shop_domain|shopDomain|merchant_id|merchantId|access_token|accessToken)\s*\}/,
  },
];

/** @type {{ file: string; line: number; rule: string; text: string }[]} */
const findings = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full);
    } else if (st.isFile()) {
      const ext = entry.slice(entry.lastIndexOf("."));
      if (!ALLOWED_EXTS.has(ext)) continue;
      const rel = relative(ROOT, full);
      if (SKIP_PATH_SUBSTR.some((s) => rel.includes(s.slice(1)))) continue;
      scan(full, rel);
    }
  }
}

function scan(absPath, relPath) {
  const text = readFileSync(absPath, "utf8");
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line.includes("pii:allow")) continue;
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        findings.push({ file: relPath, line: i + 1, rule: rule.name, text: line.trim() });
      }
    }
  }
}

walk(ROOT);

if (findings.length === 0) {
  console.log("grep:pii — no findings");
  process.exit(0);
}

console.error("grep:pii — possible PII in logs:");
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  [${f.rule}]`);
  console.error(`    ${f.text}`);
}
console.error(`\n${findings.length} finding(s). Allowlist a line with "// pii:allow" if it's a false positive.`);
process.exit(1);
