// E2E for the Sprint 05 brand-voice flow (chunk 12).
//
// Exercises the real onboarding + Settings UI components end to end while
// the voice API endpoints are intercepted with scripted responses — the
// orchestrator's Shopify + Sonnet calls run server-side and cannot be
// driven deterministically from a browser test, so the API layer is
// mocked at the network boundary.
//
// Flow: seeded merchant install → onboarding 4-phase progress → 5-sentence
// preview → Settings active voice → version history → re-extract → new
// version appears.

import { test, expect, seedTestMerchant, removeTestMerchant } from "./fixtures";

test.beforeAll(async () => {
  await seedTestMerchant();
});

test.afterAll(async () => {
  await removeTestMerchant();
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_SENTENCES = [
  "We saved your favourite blend — still warm from the roaster.",
  "It has been a while. Your usual is 15% off this week.",
  "Your cup is waiting. Reorder in two taps.",
  "We tweaked the roast you loved. Want first taste?",
  "A quiet shelf without you. Come grab your batch.",
];

const VOICE_PROFILE = {
  tone_descriptors: ["warm", "playful", "down_to_earth"],
  sentence_length: "medium",
  register: "conversational",
  emoji_policy: "rare",
  forbidden_phrases: [],
  signature_phrases: ["small batch", "still warm"],
  sample_sentences: SAMPLE_SENTENCES,
};

const MODEL = "claude-sonnet-4-6-latest";

function profileResponse(versionId: string, versionNumber: number, extractedAt: string) {
  return { versionId, versionNumber, profile: VOICE_PROFILE, modelVersion: MODEL, extractedAt };
}

function versionView(id: string, versionNumber: number, extractedAt: string) {
  return { id, versionNumber, modelVersion: MODEL, extractedAt, profile: VOICE_PROFILE };
}

// ─────────────────────────────────────────────────────────────────────────────
// Onboarding: 4-phase progress → 5-sentence preview
// ─────────────────────────────────────────────────────────────────────────────

test("onboarding shows 4-phase progress then previews 5 sample sentences", async ({
  merchantPage: page,
}) => {
  // Status advances analyzing → extracting → generating → ready across polls.
  let statusCalls = 0;
  await page.route("**/api/voice/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    statusCalls += 1;
    const phase =
      statusCalls <= 1
        ? "analyzing"
        : statusCalls === 2
          ? "extracting"
          : statusCalls === 3
            ? "generating"
            : "ready";
    await route.fulfill({
      json: {
        phase,
        startedAt: "2026-05-16T10:00:00.000Z",
        completedAt: phase === "ready" ? "2026-05-16T10:01:00.000Z" : null,
        errorMessage: null,
        voiceVersionId: phase === "ready" ? "ver-1" : null,
      },
    });
  });
  await page.route("**/api/voice/profile", async (route) => {
    await route.fulfill({ json: profileResponse("ver-1", 1, "2026-05-16T10:01:00.000Z") });
  });

  await page.goto("/app/onboarding", { waitUntil: "domcontentloaded" });

  // The four-phase indicator renders all four steps.
  await expect(page.getByText("Analyzing storefront")).toBeVisible();
  await expect(page.getByText("Extracting brand voice")).toBeVisible();
  await expect(page.getByText("Generating agent identity")).toBeVisible();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();

  // Once the run reaches `ready`, the preview renders all five sample
  // sentences in the synthesized voice.
  for (const sentence of SAMPLE_SENTENCES) {
    await expect(page.getByText(sentence)).toBeVisible({ timeout: 25_000 });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings: active voice + version history
// ─────────────────────────────────────────────────────────────────────────────

test("settings brand voice tab shows active voice and version history", async ({
  merchantPage: page,
}) => {
  await page.route("**/api/voice/profile", async (route) => {
    await route.fulfill({ json: profileResponse("ver-2", 2, "2026-05-16T10:01:00.000Z") });
  });
  await page.route("**/api/voice/versions", async (route) => {
    await route.fulfill({
      json: [
        versionView("ver-2", 2, "2026-05-16T10:01:00.000Z"),
        versionView("ver-1", 1, "2026-05-15T10:01:00.000Z"),
      ],
    });
  });

  await page.goto("/app/settings", { waitUntil: "domcontentloaded" });

  // Active voice preview shows the synthesized sample sentences.
  await expect(page.getByText(SAMPLE_SENTENCES[0])).toBeVisible({ timeout: 15_000 });

  // The version-history sub-tab lists every version.
  await page.getByRole("tab", { name: "Version history" }).click();
  await expect(page.getByText("Version 2", { exact: false })).toBeVisible();
  await expect(page.getByText("Version 1", { exact: false })).toBeVisible();
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings: re-extract produces a new version
// ─────────────────────────────────────────────────────────────────────────────

test("re-extracting from settings adds a new version to the history", async ({
  merchantPage: page,
}) => {
  let reextracted = false;

  await page.route("**/api/voice/profile", async (route) => {
    await route.fulfill({
      json: reextracted
        ? profileResponse("ver-2", 2, "2026-05-16T12:00:00.000Z")
        : profileResponse("ver-1", 1, "2026-05-15T10:01:00.000Z"),
    });
  });

  await page.route("**/api/voice/versions", async (route) => {
    await route.fulfill({
      json: reextracted
        ? [
            versionView("ver-2", 2, "2026-05-16T12:00:00.000Z"),
            versionView("ver-1", 1, "2026-05-15T10:01:00.000Z"),
          ]
        : [versionView("ver-1", 1, "2026-05-15T10:01:00.000Z")],
    });
  });

  await page.route("**/api/voice/reextract", async (route) => {
    reextracted = true;
    await route.fulfill({ status: 202, json: { ok: true } });
  });

  // Before re-extract the prior run boundary is "run-1"; after, "run-2".
  await page.route("**/api/voice/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      json: {
        phase: "ready",
        startedAt: reextracted ? "2026-05-16T12:00:00.000Z" : "2026-05-15T10:00:00.000Z",
        completedAt: reextracted ? "2026-05-16T12:01:00.000Z" : "2026-05-15T10:01:00.000Z",
        errorMessage: null,
        voiceVersionId: reextracted ? "ver-2" : "ver-1",
      },
    });
  });

  await page.goto("/app/settings", { waitUntil: "domcontentloaded" });

  // Initially only version 1 exists.
  await page.getByRole("tab", { name: "Version history" }).click();
  await expect(page.getByText("Version 1", { exact: false })).toBeVisible();
  await expect(page.getByText("Version 2", { exact: false })).toHaveCount(0);

  // Trigger a re-extraction from the active voice tab.
  await page.getByRole("tab", { name: "Active voice" }).click();
  await page.getByRole("button", { name: /Re-extract/ }).click();

  // Once the re-extraction completes the button returns to its idle label.
  await expect(page.getByRole("button", { name: "Re-extract" })).toBeEnabled({
    timeout: 25_000,
  });

  // The new version now appears in the history.
  await page.getByRole("tab", { name: "Version history" }).click();
  await expect(page.getByText("Version 2", { exact: false })).toBeVisible({ timeout: 10_000 });
});
