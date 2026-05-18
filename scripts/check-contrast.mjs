#!/usr/bin/env node
/**
 * Design token contrast guard (Decision 35 extension).
 *
 * Scans user-facing files for bg-TOKEN and text-TOKEN class combinations and
 * checks whether the pair meets WCAG 2.2 AA contrast ratios. Reports violations
 * so developers catch them before they reach the Shopify embedded context.
 *
 * Only covers Vellum token pairs — not third-party class combinations.
 * Exits 0 always (warnings only); failures are surfaced via advisory output.
 * Run via: node scripts/check-contrast.mjs
 *
 * Formula: WCAG relative luminance + contrast ratio
 * See: https://www.w3.org/TR/WCAG22/#contrast-minimum
 */

import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";

// ── Vellum colour palette (hex) ──────────────────────────────────────────────
const COLORS = {
  "cream-50": "#FCFAF5",
  "cream-100": "#F8F5EE",
  "cream-200": "#F2EDE2",
  "cream-300": "#E8E1D2",
  "cream-400": "#D6CCB7",
  "ink-900": "#0A0A0B",
  "ink-700": "#2E2C2A",
  "ink-500": "#5F5C57",
  "ink-300": "#94918A",
  "lavender-50": "#F5F1FF",
  "lavender-100": "#E8DFFC",
  "lavender-200": "#D4C5F8",
  "lavender-400": "#B8A6F4",
  "lavender-500": "#9C85EE",
  "lavender-700": "#6B52C9",
  "success-500": "#2D8A4E",
  "success-100": "#DDF0E2",
  "warning-500": "#C8941E",
  "warning-100": "#F8ECCD",
  "danger-700": "#9A2F2F",
  "danger-500": "#C04848",
  "danger-100": "#F4DCDC",
};

// WCAG AA minimum ratios
const LARGE_TEXT_MIN = 3.0; // ≥18pt (24px) or ≥14pt bold
const NORMAL_TEXT_MIN = 4.5;

function hexToLinear(c) {
  const v = parseInt(c, 16) / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function luminance(hex) {
  const h = hex.replace("#", "");
  const r = hexToLinear(h.slice(0, 2));
  const g = hexToLinear(h.slice(2, 4));
  const b = hexToLinear(h.slice(4, 6));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(hex1, hex2) {
  const l1 = luminance(hex1);
  const l2 = luminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ── File scanning ─────────────────────────────────────────────────────────────
const SCOPED_DIRS = [
  "apps/web/app/app",
  "apps/web/app/preview",
  "apps/marketing/app",
  "packages/ui/src",
];
const IGNORED_DIRS = new Set(["node_modules", ".next", ".turbo", "dist"]);
const ROOT = join(import.meta.dirname, "..");

function* walkFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (/\.(tsx|ts|jsx|js)$/.test(entry.name) && !entry.name.endsWith(".stories.tsx")) {
      yield full;
    }
  }
}

// Extract className strings — look for bg-TOKEN and text-TOKEN class combinations.
// Skip modifier-prefixed classes (hover:, focus:, disabled:, etc.) — they only
// apply in specific states and have separate contrast requirements.
const BG_RE = /(?<![a-zA-Z0-9:])bg-((?:cream|ink|lavender|success|warning|danger)-\d+)/g;
const TEXT_RE = /(?<![a-zA-Z0-9:])text-((?:cream|ink|lavender|success|warning|danger)-\d+)/g;

const findings = [];

for (const dir of SCOPED_DIRS) {
  const abs = join(ROOT, dir);
  try {
    for (const file of walkFiles(abs)) {
      const src = readFileSync(file, "utf-8");
      // Find all className= strings and check pairs within each
      const classNameBlocks = src.match(/className=["'`][^"'`]*["'`]/g) ?? [];
      for (const block of classNameBlocks) {
        const bgs = [...block.matchAll(BG_RE)].map((m) => m[1]);
        const texts = [...block.matchAll(TEXT_RE)].map((m) => m[1]);
        for (const bg of bgs) {
          for (const text of texts) {
            const bgHex = COLORS[bg];
            const textHex = COLORS[text];
            if (!bgHex || !textHex) continue;
            const ratio = contrastRatio(bgHex, textHex);
            if (ratio < NORMAL_TEXT_MIN) {
              findings.push({
                file: relative(ROOT, file),
                bg,
                text,
                ratio: ratio.toFixed(2),
                block: block.slice(0, 120),
              });
            }
          }
        }
      }
    }
  } catch {
    // Directory may not exist in all environments
  }
}

if (findings.length === 0) {
  console.log("✓ contrast check passed — all Vellum token pairs meet WCAG AA 4.5:1 in scanned files");
  process.exit(0);
}

console.log(`\n⚠  Contrast warnings: ${findings.length} pair(s) below WCAG AA 4.5:1\n`);
for (const f of findings) {
  console.log(`  ${f.file}`);
  console.log(`    bg-${f.bg} (#${COLORS[f.bg]?.slice(1)}) + text-${f.text} (#${COLORS[f.text]?.slice(1)})`);
  console.log(`    ratio: ${f.ratio}:1  (need ≥ 4.5:1 for normal text, ≥ 3.0:1 for large text)`);
  console.log(`    in: ${f.block.trim()}\n`);
}
console.log("These are advisory warnings — the script exits 0. Fix before shipping.\n");
process.exit(0);
