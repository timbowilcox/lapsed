#!/usr/bin/env node
/**
 * Design token contrast guard (Decision 35 extension).
 *
 * Scans user-facing files for bg-TOKEN and text-TOKEN class combinations and
 * checks whether the pair meets WCAG 2.2 AA contrast ratios. Reports violations
 * so developers catch them before they reach the Shopify embedded context.
 *
 * Only covers Vellum token pairs — not third-party class combinations.
 * Exits 1 if any pair fails WCAG AA 4.5:1 — this is a CI gate (grep:contrast).
 * A pair is exempt when its source line is marked `aria-hidden` (decorative —
 * not exposed to assistive tech, so not a text-contrast subject) or carries an
 * explicit `contrast-exempt` annotation. Exemptions are per-element, never blanket.
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
  "lavender-800": "#5A44A8",
  "success-500": "#2D8A4E",
  "success-100": "#DDF0E2",
  "warning-500": "#C8941E",
  "warning-100": "#F8ECCD",
  "danger-700": "#9A2F2F",
  "danger-500": "#C04848",
  "danger-100": "#F4DCDC",
};

// WCAG AA minimum ratio for normal text (≤18pt or ≤14pt bold).
// We can't determine font size from class names alone, so we conservatively
// apply the stricter 4.5:1 threshold to all detected pairs.
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

// Extract color class combinations from two sources:
// 1. className= JSX attribute strings
// 2. Plain quoted string literals (catches CVA variant object values)
// Skip modifier-prefixed classes (hover:, focus:, disabled:, etc.) via negative lookbehind.
const BG_RE = /(?<![a-zA-Z0-9:])bg-((?:cream|ink|lavender|success|warning|danger)-\d+)/g;
const TEXT_RE = /(?<![a-zA-Z0-9:])text-((?:cream|ink|lavender|success|warning|danger)-\d+)/g;
// Quoted string literals containing at least one Vellum color token (single-line only).
const COLOR_STRING_RE = /["'][^"'\n]*(?:bg|text)-(cream|ink|lavender|success|warning|danger)-\d+[^"'\n]*["']/g;

const findings = [];

for (const dir of SCOPED_DIRS) {
  const abs = join(ROOT, dir);
  try {
    for (const file of walkFiles(abs)) {
      const src = readFileSync(file, "utf-8");
      // className= attribute strings cover JSX inline usage.
      const classNameBlocks = src.match(/className=["'`][^"'`]*["'`]/g) ?? [];
      // Plain quoted strings cover CVA variant object values and other string-literal class lists.
      const colorStrings = src.match(COLOR_STRING_RE) ?? [];
      // Deduplicate: className blocks already include quoted substrings, so track seen content.
      const seen = new Set(classNameBlocks);
      const extraBlocks = colorStrings.filter((s) => !seen.has(s));
      const allBlocks = [...classNameBlocks, ...extraBlocks];
      for (const block of allBlocks) {
        // Exemption: skip a className/string when its source line is marked
        // `aria-hidden` (decorative element — not exposed to assistive tech,
        // so its colour is not a WCAG text-contrast subject) or carries an
        // explicit `contrast-exempt` annotation. Per-element, never blanket.
        const blockIdx = src.indexOf(block);
        const exemptStart = blockIdx === -1 ? 0 : src.lastIndexOf("\n", blockIdx) + 1;
        const exemptEnd =
          blockIdx === -1 ? src.length : src.indexOf("\n", blockIdx + block.length);
        const blockLineRegion = src.slice(
          exemptStart,
          exemptEnd === -1 ? undefined : exemptEnd,
        );
        if (/aria-hidden|contrast-exempt/.test(blockLineRegion)) continue;
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

console.log(`\n✗ Contrast failures: ${findings.length} pair(s) below WCAG AA 4.5:1\n`);
for (const f of findings) {
  console.log(`  ${f.file}`);
  console.log(`    bg-${f.bg} (#${COLORS[f.bg]?.slice(1)}) + text-${f.text} (#${COLORS[f.text]?.slice(1)})`);
  console.log(`    ratio: ${f.ratio}:1  (need ≥ 4.5:1 for normal text)`);
  console.log(`    in: ${f.block.trim()}\n`);
}
console.log("Fix these pairings before merging — use text-ink-900/text-ink-700 on light tinted backgrounds.\n");
process.exit(1);
