// Server-side environment accessor. Throws at first use if any required
// var is missing so a misconfigured Vercel deploy fails fast at request
// time rather than producing degraded behaviour.

interface ServerEnv {
  shopifyApiKey: string;
  shopifyApiSecret: string;
  shopifyScopes: string;
  shopifyAppUrl: string;
  supabaseUrl: string;
  supabasePublishableKey: string;
  supabaseSecretKey: string;
  supabaseJwtSecret: string;
  tokenEncryptionKey: string;
  cronSecret: string;
  propensityReadyThreshold: number;
  scoringTokenCapDefault: number;
  anthropicApiKey: string;
  /** Sprint 05: max voice extractions per merchant per UTC day. Cap-exhaustion writes extraction_failed event. */
  voiceExtractionDailyCapDefault: number;
  /** Sprint 05: pinned Sonnet model for voice synthesis (decision 9). */
  sonnetModel: string;
  /** Sprint 06: max successful campaign proposals per merchant per UTC day. */
  campaignProposalDailyCapDefault: number;
  /** Sprint 06: fraction of each group held out per campaign (decision 5). */
  holdoutRate: number;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`required env var ${name} not set`);
  return v;
}

/**
 * parseInt with a sentinel default that preserves explicit `"0"` (used as a
 * kill switch for cost caps during incidents). `parseInt(...) || N` collapses
 * 0 → N silently, which would defeat operator-set zero caps.
 */
function parseIntOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

let cached: ServerEnv | null = null;

export function serverEnv(): ServerEnv {
  if (cached) return cached;
  cached = {
    shopifyApiKey: required("SHOPIFY_API_KEY"),
    shopifyApiSecret: required("SHOPIFY_API_SECRET"),
    shopifyScopes: required("SHOPIFY_SCOPES"),
    shopifyAppUrl: process.env.SHOPIFY_APP_URL ?? "https://app.lapsed.ai",
    supabaseUrl: required("NEXT_PUBLIC_SUPABASE_URL"),
    supabasePublishableKey: required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    supabaseSecretKey: required("SUPABASE_SECRET_KEY"),
    supabaseJwtSecret: required("SUPABASE_JWT_SECRET"),
    tokenEncryptionKey: required("TOKEN_ENCRYPTION_KEY"),
    cronSecret: required("CRON_SECRET"),
    propensityReadyThreshold: parseFloat(process.env.PROPENSITY_READY_THRESHOLD ?? "0.4"),
    scoringTokenCapDefault: parseIntOr(process.env.SCORING_TOKEN_CAP_DEFAULT, 10_000_000),
    anthropicApiKey: required("ANTHROPIC_API_KEY"),
    voiceExtractionDailyCapDefault: parseIntOr(process.env.VOICE_EXTRACTION_DAILY_CAP_DEFAULT, 10),
    sonnetModel: process.env.SONNET_MODEL ?? "claude-sonnet-4-6-latest",
    campaignProposalDailyCapDefault: parseIntOr(
      process.env.CAMPAIGN_PROPOSAL_DAILY_CAP_DEFAULT,
      5,
    ),
    holdoutRate: parseFloat(process.env.HOLDOUT_RATE ?? "0.1"),
  };
  return cached;
}

/**
 * Public env values that may be read from client components. Next
 * inlines `process.env.NEXT_PUBLIC_*` at build time, so these are
 * embedded into the client JS bundle and safe to read in browser code.
 *
 * NEXT_PUBLIC_SHOPIFY_API_KEY mirrors SHOPIFY_API_KEY (it's the same
 * value — the API key is public; only the secret is sensitive). Used
 * by the App Bridge meta tag in the root layout.
 */
export const publicEnv = {
  shopifyApiKey: process.env.NEXT_PUBLIC_SHOPIFY_API_KEY ?? "",
} as const;
