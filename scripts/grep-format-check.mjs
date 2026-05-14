#!/usr/bin/env node
// Format-helper guard. Fails CI if inline currency/date/timestamp formatting
// is found in app route files instead of using the format helpers from
// @lapsed/ui (packages/ui/src/lib/format.ts).
//
// Catches:
//   - .toLocaleString( calls (should use formatCurrency, formatCount, etc.)
//   - ${ expr.toFixed( patterns (should use formatCurrency)
//
// Allowlist comment to skip: `// format:allow` on the same line.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();

// Only check app routes, not the format.ts itself or tests
const SEARCH_ROOTS = [join(ROOT, "apps", "web", "app")];

const IGNORED_DIRS = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "__tests__",
  "e2e",
]);

const ALLOWED_EXTS = new Set([".ts", ".tsx"]);

const RULES = [
  {
    name: "inline_toLocaleString",
    description: "Use formatCurrency() or formatCount() instead of .toLocaleString()",
    pattern: /\.toLocaleString\(/,
  },
  {
    name: "inline_dollar_toFixed",
    description: "Use formatCurrency() instead of `$${value.toFixed(...)}`",
    pattern: /\$\{[^}]*\.toFixed\(/,
  },
];

/** @type {{ file: string; line: number; rule: string; text: string }[]} */
const findings = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
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
      scan(full, relative(ROOT, full));
    }
  }
}

function scan(absPath, relPath) {
  const text = readFileSync(absPath, "utf8");
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line.includes("format:allow")) continue;
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        findings.push({ file: relPath, line: i + 1, rule: rule.name, text: line.trim() });
      }
    }
  }
}

for (const root of SEARCH_ROOTS) {
  walk(root);
}

if (findings.length === 0) {
  console.log("grep:format-check — no findings");
  process.exit(0);
}

console.error("grep:format-check — inline formatting found (use format helpers from @lapsed/ui):");
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  [${f.rule}]`);
  console.error(`    ${f.text}`);
}
console.error(
  `\n${findings.length} finding(s). Fix using formatCurrency/formatCount/formatDate/formatDateTime/formatRelativeTime from @lapsed/ui, or add "// format:allow" to suppress a false positive.`,
);
process.exit(1);
