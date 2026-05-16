import { describe, expect, it } from "vitest";
import {
  getAttributionWindow,
  getLtvEvaluationWindow,
  ATTRIBUTION_WINDOW_DAYS_DEFAULT,
  LTV_EVALUATION_WINDOW_DAYS_DEFAULT,
} from "../src/attribution-config";
import { makeFakeSupabase } from "./_fake-supabase";

const MERCHANT_A = "11111111-1111-4111-8111-111111111111";
const MERCHANT_B = "22222222-2222-4222-8222-222222222222";

describe("getAttributionWindow", () => {
  it("falls back to the default (14) when the merchant has no config row", async () => {
    const { client } = makeFakeSupabase({ merchant_attribution_config: [] });
    expect(await getAttributionWindow(client, MERCHANT_A)).toBe(14);
    expect(ATTRIBUTION_WINDOW_DAYS_DEFAULT).toBe(14);
  });

  it("returns the per-merchant configured window when a row exists", async () => {
    const { client } = makeFakeSupabase({
      merchant_attribution_config: [
        { merchant_id: MERCHANT_A, attribution_window_days: 21, ltv_evaluation_window_days: 30 },
      ],
    });
    expect(await getAttributionWindow(client, MERCHANT_A)).toBe(21);
  });

  it("resolves each merchant independently", async () => {
    const { client } = makeFakeSupabase({
      merchant_attribution_config: [
        { merchant_id: MERCHANT_A, attribution_window_days: 7, ltv_evaluation_window_days: 30 },
        { merchant_id: MERCHANT_B, attribution_window_days: 28, ltv_evaluation_window_days: 30 },
      ],
    });
    expect(await getAttributionWindow(client, MERCHANT_A)).toBe(7);
    expect(await getAttributionWindow(client, MERCHANT_B)).toBe(28);
  });

  it("rejects a non-UUID merchantId", async () => {
    const { client } = makeFakeSupabase({});
    await expect(getAttributionWindow(client, "not-a-uuid")).rejects.toThrow(/merchantId/);
  });

  it("propagates a query error rather than silently falling back to the default", async () => {
    const { client } = makeFakeSupabase(
      { merchant_attribution_config: [] },
      { failOn: [{ table: "merchant_attribution_config", op: "select" }] },
    );
    await expect(getAttributionWindow(client, MERCHANT_A)).rejects.toThrow(/fake error/);
  });
});

describe("getLtvEvaluationWindow", () => {
  it("falls back to the default (30) when the merchant has no config row", async () => {
    const { client } = makeFakeSupabase({ merchant_attribution_config: [] });
    expect(await getLtvEvaluationWindow(client, MERCHANT_A)).toBe(30);
    expect(LTV_EVALUATION_WINDOW_DAYS_DEFAULT).toBe(30);
  });

  it("returns the per-merchant configured LTV window when a row exists", async () => {
    const { client } = makeFakeSupabase({
      merchant_attribution_config: [
        { merchant_id: MERCHANT_A, attribution_window_days: 14, ltv_evaluation_window_days: 60 },
      ],
    });
    expect(await getLtvEvaluationWindow(client, MERCHANT_A)).toBe(60);
  });

  it("rejects a non-UUID merchantId", async () => {
    const { client } = makeFakeSupabase({});
    await expect(getLtvEvaluationWindow(client, "not-a-uuid")).rejects.toThrow(/merchantId/);
  });

  it("propagates a query error rather than silently falling back to the default", async () => {
    const { client } = makeFakeSupabase(
      { merchant_attribution_config: [] },
      { failOn: [{ table: "merchant_attribution_config", op: "select" }] },
    );
    await expect(getLtvEvaluationWindow(client, MERCHANT_A)).rejects.toThrow(/fake error/);
  });
});
