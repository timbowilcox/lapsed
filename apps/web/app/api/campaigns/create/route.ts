// POST /api/campaigns/create
//
// Creates a new campaign proposal from the manual campaign wizard. Calls the
// AI Campaign Designer (proposeCampaign) with source='manual' so the proposal
// is tagged as merchant-created rather than agent-generated.
//
//   Body: { groupSlug: string }
//
// Returns: { proposalId: string } on success.
// Errors:  400 missing/invalid groupSlug
//          422 voice profile not set up yet
//          429 daily proposal cap reached
//          500 unexpected failure
//
// Auth: lapsed_session cookie / App Bridge bearer token via getMerchantFromSession.

import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createServiceClient } from "@lapsed/db";
import { proposeCampaign } from "@lapsed/core";
import { getMerchantFromSession } from "@/app/lib/session";
import { serverEnv } from "@/app/lib/env";
import { isValidGroupSlug } from "../_group-labels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// proposeCampaign includes an AI call — allow up to 60 s end-to-end.
export const maxDuration = 60;

export async function POST(req: Request): Promise<NextResponse> {
  const merchant = await getMerchantFromSession();
  if (!merchant) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { groupSlug } = raw as Record<string, unknown>;

  if (!isValidGroupSlug(groupSlug)) {
    return NextResponse.json(
      { error: "Please select a valid customer group." },
      { status: 400 },
    );
  }

  const env = serverEnv();
  const serviceClient = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });

  const anthropicClient = new Anthropic({
    apiKey: env.anthropicApiKey,
    maxRetries: 0,
  });

  const result = await proposeCampaign({
    serviceClient,
    anthropicClient,
    merchantId: merchant.id,
    groupSlug,
    dailyCapDefault: env.campaignProposalDailyCapDefault,
    holdoutRate: env.holdoutRate,
    model: env.sonnetModel,
    source: "manual",
  });

  if (!result.ok) {
    if (result.reason === "voice_profile") {
      return NextResponse.json(
        {
          error:
            "Your brand voice hasn't been set up yet. Extract your brand voice in Settings before creating a campaign.",
        },
        { status: 422 },
      );
    }
    if (result.reason === "cap_check") {
      return NextResponse.json(
        { error: "You've reached the daily campaign limit. Try again tomorrow." },
        { status: 429 },
      );
    }
    if (result.reason === "group_fetch") {
      return NextResponse.json(
        { error: "That group has no scored customers yet. Try again after your first nightly sync." },
        { status: 422 },
      );
    }
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  return NextResponse.json({ proposalId: result.proposalId });
}
