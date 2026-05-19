// Unit tests for POST /api/conversations/[id]/opt-out — the merchant manual
// opt-out route. Covers the auth gate, UUID validation, cross-merchant 404
// (never 403), the no-phone path (decision 18 — opt-out still recorded), and
// the happy path. recordOptOut + the Supabase/Twilio clients are mocked —
// their behavior is unit-tested in @lapsed/core.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionMerchant } from "../app/lib/session";

vi.mock("@/app/lib/session", () => ({ getMerchantFromSession: vi.fn() }));
vi.mock("@lapsed/db", () => ({ createServiceClient: vi.fn() }));
vi.mock("@lapsed/core", () => ({
  createTwilioClient: vi.fn().mockReturnValue({}),
  recordOptOut: vi.fn(),
}));

import { getMerchantFromSession } from "@/app/lib/session";
import { createServiceClient } from "@lapsed/db";
import { recordOptOut } from "@lapsed/core";
import { POST } from "../app/api/conversations/[id]/opt-out/route";

const MERCHANT: SessionMerchant = {
  id: "550e8400-e29b-41d4-a716-446655440001",
  shopDomain: "test-shop.myshopify.com",
  shopName: "Test Shop",
  shopInitials: "TS",
  plan: "starter",
  planLabel: "Starter",
  onboardingState: "completed" as const,
  installedAt: "2026-05-16T09:00:00.000Z",
};

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";

/** A minimal chainable Supabase stub: select → eq → eq → maybeSingle. */
function stubClient(conv: unknown, customer: unknown) {
  const builderFor = (data: unknown) => {
    const b: Record<string, unknown> = {};
    b.eq = () => b;
    b.maybeSingle = async () => ({ data, error: null });
    return b;
  };
  return {
    from: (table: string) => ({
      select: () => builderFor(table === "conversations" ? conv : customer),
    }),
  };
}

function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

const req = new Request("http://localhost/api/conversations/x/opt-out", { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/conversations/[id]/opt-out", () => {
  it("returns 401 when there is no merchant session", async () => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(null);
    const res = await POST(req, paramsFor(CONVERSATION_ID));
    expect(res.status).toBe(401);
  });

  it("returns 404 for a non-UUID conversation id", async () => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(MERCHANT);
    const res = await POST(req, paramsFor("not-a-uuid"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when the conversation belongs to another merchant (not found)", async () => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(MERCHANT);
    // The merchant-scoped lookup resolves to null for a cross-merchant id.
    vi.mocked(createServiceClient).mockReturnValue(
      stubClient(null, null) as unknown as ReturnType<typeof createServiceClient>,
    );
    const res = await POST(req, paramsFor(CONVERSATION_ID));
    expect(res.status).toBe(404);
    expect(recordOptOut).not.toHaveBeenCalled();
  });

  it("records the opt-out and returns 200 on the happy path", async () => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(MERCHANT);
    vi.mocked(createServiceClient).mockReturnValue(
      stubClient(
        { customer_id: "gid://shopify/Customer/1" },
        { phone: "+15551234567" },
      ) as unknown as ReturnType<typeof createServiceClient>,
    );
    vi.mocked(recordOptOut).mockResolvedValue({
      recorded: true,
      alreadyOptedOut: false,
      twilioRecorded: true,
    });
    const res = await POST(req, paramsFor(CONVERSATION_ID));
    expect(res.status).toBe(200);
    expect(recordOptOut).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        merchantId: MERCHANT.id,
        customerId: "gid://shopify/Customer/1",
        phoneNumber: "+15551234567",
        source: "merchant_manual",
      }),
    );
  });

  it("still records the opt-out when the customer has no phone (decision 18)", async () => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(MERCHANT);
    vi.mocked(createServiceClient).mockReturnValue(
      stubClient(
        { customer_id: "gid://shopify/Customer/2" },
        { phone: null },
      ) as unknown as ReturnType<typeof createServiceClient>,
    );
    vi.mocked(recordOptOut).mockResolvedValue({
      recorded: true,
      alreadyOptedOut: false,
      twilioRecorded: false,
    });
    const res = await POST(req, paramsFor(CONVERSATION_ID));
    expect(res.status).toBe(200);
    // The opt-out is recorded with an empty phone — never blocked.
    expect(recordOptOut).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ phoneNumber: "", source: "merchant_manual" }),
    );
  });
});
