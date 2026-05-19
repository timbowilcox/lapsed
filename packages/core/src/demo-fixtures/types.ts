export type PlanTier = "starter" | "growth" | "scale";

export interface DemoMerchant {
  id: string;
  shopDomain: string;
  shopName: string;
  shopInitials: string;
  plan: PlanTier;
  planLabel: string;
  monthlyMessageQuota: number;
  monthlyMessagesUsed: number;
  brandVoice: string;
  optOutKeywords: string[];
  agentDraftDefaults: string[];
  ownerName: string;
  ownerInitials: string;
  installedAt: string;
  totalLapsedCount: number;
  weeklyLapsedDelta: number;
  reactivationRate: number;
  reactivationRateDeltaPp: number;
}

export type CustomerStatus = "lapsed" | "reactivating" | "churned" | "converted";
export type CustomerTier = "new" | "repeat" | "vip";

export interface DemoOrderHistoryEntry {
  id: string;
  placedAt: string;
  total: number;
  lineCount: number;
  topProduct: string;
}

export interface DemoLapsedCustomer {
  id: string;
  initials: string;
  firstName: string;
  lastName: string;
  tier: CustomerTier;
  status: CustomerStatus;
  lifetimeValue: number;
  orderCount: number;
  lastOrderAt: string;
  lastOrderDaysAgo: number;
  reactivationScore: number;
  cadenceDays: number;
  preferredCategory: string;
  orderHistory: DemoOrderHistoryEntry[];
}

export type DemoCampaignStatus = "live" | "draft" | "paused" | "completed";

export interface DemoCampaignAudienceBucket {
  label: string;
  count: number;
}

export interface DemoCampaignTimelineEvent {
  at: string;
  label: string;
}

export interface DemoCampaign {
  id: string;
  name: string;
  meta: string;
  status: DemoCampaignStatus;
  statusLabel: string;
  audienceSize: number;
  sentMessages: number;
  responseRate: number;
  conversionRate: number;
  recoveredRevenue: number;
  recoveredOrders: number;
  recoveredRevenueDisplay: string;
  launchedAt: string | null;
  scheduledFor: string | null;
  pausedAt: string | null;
  completedAt: string | null;
  audienceBreakdown: DemoCampaignAudienceBucket[];
  timeline: DemoCampaignTimelineEvent[];
}

export type ConversationTagTone = "converted" | "active" | "stalled" | "churned";
export type ConversationStatus = "active" | "converted" | "stalled" | "opted_out";

export interface DemoConversationMessage {
  id: string;
  role: "customer" | "ai" | "merchant";
  body: string;
  sentAt: string;
}

export interface DemoConversation {
  id: string;
  initials: string;
  customerName: string;
  campaignName: string;
  time: string;
  preview: string;
  tagTone: ConversationTagTone;
  tagLabel: string;
  status: ConversationStatus;
  attributedRevenue: number | null;
  messages: DemoConversationMessage[];
}

export interface DemoAttributionDay {
  date: string;
  recoveredRevenue: number;
}

export interface DemoAttributionCampaignBreakdown {
  campaignId: string;
  campaignName: string;
  recoveredRevenue: number;
  incrementalRevenue: number;
  recoveredOrders: number;
  ciLow: number;
  ciHigh: number;
}

export interface DemoAttributionSummary {
  periodStart: string;
  periodEnd: string;
  totalRestoredRevenue: number;
  incrementalRevenue: number;
  ciLow: number;
  ciHigh: number;
  incrementalityPct: number;
  totalRestoredOrders: number;
  vsPreviousPeriodPct: number;
  byDay: DemoAttributionDay[];
  byCampaign: DemoAttributionCampaignBreakdown[];
}

export interface DemoBillingSnapshot {
  currentPlan: PlanTier;
  currentPlanLabel: string;
  currentPlanPrice: number;
  monthlyMessageQuota: number;
  monthlyMessagesUsed: number;
  renewsAt: string;
  paymentMethodLast4: string;
}

export interface DemoInsight {
  id: string;
  insightKey: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
  category: "cohort" | "arm" | "opt_out" | "conversation" | "payment";
  signalMetric: string;
  signalValue: number;
  threshold: number;
  merchantCopy: string;
  ctaAction: { route: string; params?: Record<string, string> };
  state: "active";
  createdAt: string;
  expiresAt: string | null;
}

export interface DemoFixtures {
  version: number;
  merchant: DemoMerchant;
  lapsedCustomers: DemoLapsedCustomer[];
  campaigns: DemoCampaign[];
  conversations: DemoConversation[];
  attribution: DemoAttributionSummary;
  billing: DemoBillingSnapshot;
  insights: DemoInsight[];
}
