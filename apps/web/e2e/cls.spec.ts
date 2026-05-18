import { test, expect } from "@playwright/test";

/**
 * Cumulative Layout Shift (CLS) guard for public /preview routes.
 * Asserts CLS ≤ 0.1 (Core Web Vitals "Good" threshold) on each page.
 *
 * Uses the Layout Instability API via PerformanceObserver — supported in
 * Chromium (the default Playwright browser). These tests run without auth
 * against the /preview demo routes.
 */

async function measureCLS(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    return new Promise<number>((resolve) => {
      let clsValue = 0;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { hadRecentInput: boolean; value: number };
          if (!shift.hadRecentInput) {
            clsValue += shift.value;
          }
        }
      });
      observer.observe({ type: "layout-shift", buffered: true });
      // Allow buffered entries to drain, then settle
      setTimeout(() => {
        observer.disconnect();
        resolve(clsValue);
      }, 500);
    });
  });
}

const previewRoutes = [
  { name: "preview-dashboard", path: "/preview" },
  { name: "preview-lapsed", path: "/preview/lapsed" },
  { name: "preview-campaigns", path: "/preview/campaigns" },
  { name: "preview-conversations", path: "/preview/conversations" },
  { name: "preview-attribution", path: "/preview/attribution" },
  { name: "preview-billing", path: "/preview/billing" },
  { name: "preview-settings", path: "/preview/settings" },
];

for (const route of previewRoutes) {
  test(`cls: ${route.name} ≤ 0.1`, async ({ page }) => {
    await page.goto(route.path, { waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    const cls = await measureCLS(page);
    expect(cls, `CLS on ${route.path} was ${cls.toFixed(4)} — must be ≤ 0.1`).toBeLessThanOrEqual(0.1);
  });
}
