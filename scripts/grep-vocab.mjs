#!/usr/bin/env node
// Vocabulary CI gate. Fails if internal terminology appears in rendered strings
// inside user-facing paths.
//
// Deny-list is in scripts/vocab-deny-list.json (decision 35).
// Scoped to page-render paths only:
//   apps/web/app/app/**     — merchant app pages
//   apps/web/app/preview/** — demo mode pages
//   apps/marketing/app/**   — marketing pages
//   packages/ui/src/**      — UI component library (excluding stories)
//
// Only flags terms found in string/JSX text contexts — code identifiers,
// import paths, and DB query column-name strings are not flagged.
// Allowlist comment to skip a line: `// vocab:allow`

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const IGNORED_DIRS = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  "storybook-static",
  "playwright-report",
  "test-results",
  ".git",
  "coverage",
  "__tests__",
  "e2e",
]);

const ALLOWED_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);

// Only scan page-render directories. Excludes /api routes (server handlers,
// not rendered output) and any non-app paths.
const SCOPED_DIRS = [
  join(ROOT, "apps", "web", "app", "app"),      // merchant app pages
  join(ROOT, "apps", "web", "app", "preview"),  // demo mode pages
  join(ROOT, "apps", "marketing", "app"),        // marketing pages
  join(ROOT, "packages", "ui", "src"),           // UI component library
];

// Story files are Storybook dev fixtures, not production renders.
const SKIP_FILE_SUFFIXES = [".stories.tsx", ".stories.ts", ".stories.js", ".stories.jsx"];

// Lines matching DB query builder patterns contain column name strings (e.g.
// `.eq("merchant_id", ...)`) that are not user-visible text.
const DB_QUERY_LINE = /\.\s*(eq|neq|in|contains|select|onConflict|insert|upsert|update|delete|filter)\s*\(/;

// Load deny-list.
const denyList = JSON.parse(
  readFileSync(join(__dirname, "vocab-deny-list.json"), "utf8"),
);
const RULES = denyList.terms.map((t) => ({
  name: t.name,
  description: t.description,
  pattern: new RegExp(t.pattern, t.flags ?? ""),
}));

/**
 * Returns true when the deny-list pattern appears inside a string literal
 * or JSX text context on this line (not purely as a code identifier).
 *
 * Checked contexts:
 *   1. Double-quoted string:  "...TERM..."
 *   2. Single-quoted string:  '...TERM...'
 *   3. Template literal:      `...TERM...`
 *   4. JSX text node:         >...TERM...<
 */
function isInStringContext(line, pattern) {
  const t = pattern.source;
  const flags = pattern.flags.replace("g", "");
  const contexts = [
    new RegExp(`"[^"\\n]*${t}[^"\\n]*"`, flags),
    new RegExp(`'[^'\\n]*${t}[^'\\n]*'`, flags),
    new RegExp("`[^`\\n]*" + t + "[^`\\n]*`", flags),
    // JSX text node: content between a closing > and an opening <
    new RegExp(`>[^<>\\n]*${t}[^<>\\n]*<`, flags),
  ];
  return contexts.some((re) => re.test(line));
}

/** @type {{ file: string; line: number; rule: string; description: string; text: string }[]} */
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
      if (SKIP_FILE_SUFFIXES.some((s) => entry.endsWith(s))) continue;
      const ext = entry.slice(entry.lastIndexOf("."));
      if (!ALLOWED_EXTS.has(ext)) continue;
      const rel = relative(ROOT, full);
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
    // Escape hatch.
    if (line.includes("vocab:allow")) continue;
    // Skip pure comment lines.
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    // Skip import/export declarations.
    if (/^\s*(import|export)\s/.test(line)) continue;
    // Skip DB query builder lines — column name strings are not user-visible text.
    if (DB_QUERY_LINE.test(line)) continue;

    for (const rule of RULES) {
      if (!rule.pattern.test(line)) continue;
      if (isInStringContext(line, rule.pattern)) {
        findings.push({ file: relPath, line: i + 1, rule: rule.name, description: rule.description, text: trimmed });
      }
    }
  }
}

for (const dir of SCOPED_DIRS) {
  try {
    statSync(dir);
  } catch {
    // Directory may not exist in some workspaces — skip silently.
    continue;
  }
  walk(dir);
}

if (findings.length === 0) {
  console.log("grep:vocab — no findings");
  process.exit(0);
}

console.error("grep:vocab — internal vocabulary in user-facing strings:");
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  [${f.rule}] ${f.description}`);
  console.error(`    ${f.text}`);
}
console.error(
  `\n${findings.length} finding(s). Add "// vocab:allow" to suppress a false positive, or fix the copy.`,
);
process.exit(1);
