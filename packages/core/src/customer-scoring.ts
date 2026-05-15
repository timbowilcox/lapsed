/**
 * Haiku propensity scoring service.
 *
 * Batches up to 50 customers per Anthropic API call to amortize prompt
 * overhead. Returns structured propensity scores + top_signal per customer.
 * Uses claude-haiku-4-5-20251001 (cost-effective batch scoring model).
 *
 * The caller (scoring orchestrator) is responsible for:
 *  - Opening/closing scoring_runs rows
 *  - Token cap enforcement
 *  - Per-customer customer_scored event writes (Decision 1)
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export const HAIKU_MODEL = "claude-haiku-4-5-20251001";
export const BATCH_SIZE = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Input / output types
// ─────────────────────────────────────────────────────────────────────────────

export interface CustomerScoringInput {
  shopifyCustomerGid: string;
  totalOrderCount: number;
  lastOrderDaysAgo: number | null;
  firstOrderDaysAgo: number | null;
  totalLtvCents: number;
  ordersInPast12Months: number;
  engagementEventsInPast90Days: number;
  lifecycleStage: string;
  avgOrderValueCents: number;
}

export interface CustomerScoringOutput {
  shopifyCustomerGid: string;
  propensity30d: number;
  propensity60d: number;
  propensity90d: number;
  predictedResidualLtvCents: number;
  topSignal: string;
}

export interface ScoringBatchResult {
  scores: CustomerScoringOutput[];
  tokensInput: number;
  tokensOutput: number;
  costCents: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Zod schema for structured output validation
// ─────────────────────────────────────────────────────────────────────────────

const CustomerScoreSchema = z.object({
  customer_id: z.string(),
  propensity_30d: z.number().min(0).max(1),
  propensity_60d: z.number().min(0).max(1),
  propensity_90d: z.number().min(0).max(1),
  predicted_residual_ltv_cents: z.number().int().min(0),
  top_signal: z.string(), // truncated to 100 chars during mapping
});

const ScoringResponseSchema = z.object({
  scores: z.array(CustomerScoreSchema),
});

type ScoringResponse = z.infer<typeof ScoringResponseSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Cost calculation
// ─────────────────────────────────────────────────────────────────────────────

// Haiku 4.5 pricing: $0.80/M input tokens, $4.00/M output tokens
const INPUT_COST_PER_M_TOKENS = 0.80;
const OUTPUT_COST_PER_M_TOKENS = 4.00;

function calculateCostCents(tokensInput: number, tokensOutput: number): number {
  const inputCost = (tokensInput / 1_000_000) * INPUT_COST_PER_M_TOKENS;
  const outputCost = (tokensOutput / 1_000_000) * OUTPUT_COST_PER_M_TOKENS;
  return Math.ceil((inputCost + outputCost) * 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt construction
// ─────────────────────────────────────────────────────────────────────────────

function buildSystemPrompt(medianAovCents: number): string {
  const medianAov = (medianAovCents / 100).toFixed(2);
  return `You are a customer reactivation scoring model for a Shopify merchant.

Your task: score each customer's probability of placing an order in the next 30, 60, and 90 days, estimate their residual lifetime value, and provide a one-line signal explaining the score.

Merchant context:
- Median order value: $${medianAov}

Scoring guidelines:
- Higher order count + recent activity → higher propensity
- Longer inactivity → lower propensity (lapsed customers decline over time)
- Engagement events signal interest even without orders
- LTV above median indicates retention potential

Response format: JSON object with a "scores" array. Each score must have:
- customer_id: exactly as provided
- propensity_30d: 0.0–1.0 (probability of ordering in 30 days)
- propensity_60d: 0.0–1.0 (must be ≥ propensity_30d)
- propensity_90d: 0.0–1.0 (must be ≥ propensity_60d)
- predicted_residual_ltv_cents: integer ≥ 0 (expected future spend in cents)
- top_signal: ≤ 100 chars, one-line explanation for the score

Respond ONLY with the JSON object. No markdown, no explanation.`;
}

function buildUserPrompt(customers: CustomerScoringInput[]): string {
  const items = customers.map((c) => {
    const lastOrder = c.lastOrderDaysAgo !== null ? `${c.lastOrderDaysAgo}d ago` : "never";
    const firstOrder = c.firstOrderDaysAgo !== null ? `${c.firstOrderDaysAgo}d ago` : "unknown";
    const aov = (c.avgOrderValueCents / 100).toFixed(2);
    const ltv = (c.totalLtvCents / 100).toFixed(2);
    return [
      `id:${c.shopifyCustomerGid}`,
      `orders:${c.totalOrderCount}(last_12m:${c.ordersInPast12Months})`,
      `last_order:${lastOrder}`,
      `first_order:${firstOrder}`,
      `ltv:$${ltv}`,
      `aov:$${aov}`,
      `engagement_90d:${c.engagementEventsInPast90Days}`,
      `lifecycle:${c.lifecycleStage}`,
    ].join(" ");
  });
  return `Score these ${customers.length} customer(s):\n${items.join("\n")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring client
// ─────────────────────────────────────────────────────────────────────────────

export interface ScoringClientOptions {
  apiKey: string;
  timeoutMs?: number;
}

export function createScoringClient(opts: ScoringClientOptions): Anthropic {
  return new Anthropic({
    apiKey: opts.apiKey,
    timeout: opts.timeoutMs ?? 30_000,
    maxRetries: 2,
  });
}

/**
 * Score a batch of up to BATCH_SIZE customers in a single Haiku API call.
 * Returns structured scores and token accounting. Throws on API or parse errors.
 */
export async function scoreBatch(
  client: Anthropic,
  customers: CustomerScoringInput[],
  medianAovCents: number,
): Promise<ScoringBatchResult> {
  if (customers.length === 0) {
    return { scores: [], tokensInput: 0, tokensOutput: 0, costCents: 0 };
  }
  if (customers.length > BATCH_SIZE) {
    throw new Error(`scoreBatch: cannot score more than ${BATCH_SIZE} customers at once`);
  }

  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 4096,
    system: buildSystemPrompt(medianAovCents),
    messages: [{ role: "user", content: buildUserPrompt(customers) }],
  });

  const tokensInput = response.usage.input_tokens;
  const tokensOutput = response.usage.output_tokens;
  const costCents = calculateCostCents(tokensInput, tokensOutput);

  const rawText = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  let parsed: ScoringResponse;
  try {
    parsed = ScoringResponseSchema.parse(JSON.parse(rawText));
  } catch (err) {
    throw new Error(
      `scoreBatch: failed to parse Haiku response: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Build a lookup map so we can return scores in input order.
  const scoreMap = new Map(parsed.scores.map((s) => [s.customer_id, s]));

  const scores: CustomerScoringOutput[] = customers.map((c) => {
    const s = scoreMap.get(c.shopifyCustomerGid);
    if (!s) {
      // Haiku omitted this customer — return conservative defaults.
      return {
        shopifyCustomerGid: c.shopifyCustomerGid,
        propensity30d: 0,
        propensity60d: 0,
        propensity90d: 0,
        predictedResidualLtvCents: 0,
        topSignal: "no score returned",
      };
    }
    return {
      shopifyCustomerGid: c.shopifyCustomerGid,
      propensity30d: s.propensity_30d,
      propensity60d: s.propensity_60d,
      propensity90d: s.propensity_90d,
      predictedResidualLtvCents: s.predicted_residual_ltv_cents,
      topSignal: s.top_signal.slice(0, 100),
    };
  });

  return { scores, tokensInput, tokensOutput, costCents };
}
