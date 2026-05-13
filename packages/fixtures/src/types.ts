export type PlanTier = "starter" | "growth" | "scale";

export interface Merchant {
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

export interface OrderLine {
  productName: string;
  quantity: number;
  unitPrice: number;
}

export interface OrderHistoryEntry {
  id: string;
  placedAt: string;
  total: number;
  lineCount: number;
  topProduct: string;
}

export interface LapsedCustomer {
  id: string;
  initials: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  city: string;
  state: string;
  tier: CustomerTier;
  status: CustomerStatus;
  lifetimeValue: number;
  orderCount: number;
  lastOrderAt: string;
  lastOrderDaysAgo: number;
  reactivationScore: number;
  cadenceDays: number;
  preferredCategory: string;
  optedIn: boolean;
  orderHistory: OrderHistoryEntry[];
}

export type CampaignStatus = "live" | "draft" | "paused" | "error";

export interface CampaignAudienceBucket {
  label: string;
  count: number;
}

export interface CampaignTimelineEvent {
  at: string;
  label: string;
}

export interface Campaign {
  id: string;
  name: string;
  meta: string;
  status: CampaignStatus;
  statusLabel: string;
  audienceSize: number;
  audienceDescription: string;
  cohortLabel: string;
  offerDescription: string;
  offerCode: string;
  offerValue: string;
  sentMessages: number;
  responseRate: number;
  conversionRate: number;
  recoveredRevenue: number;
  recoveredOrders: number;
  recoveredRevenueDisplay: string;
  launchedAt: string | null;
  scheduledFor: string | null;
  pausedAt: string | null;
  audienceBreakdown: CampaignAudienceBucket[];
  timeline: CampaignTimelineEvent[];
}

export type ConversationTagTone = "converted" | "active" | "stalled" | "churned";
export type ConversationStatus = "active" | "converted" | "stalled" | "opted_out";

export interface ConversationMessage {
  id: string;
  role: "customer" | "ai" | "merchant";
  body: string;
  sentAt: string;
}

export interface Conversation {
  id: string;
  customerId: string;
  campaignId: string;
  initials: string;
  customerName: string;
  customerPhone: string;
  campaignName: string;
  time: string;
  preview: string;
  tagTone: ConversationTagTone;
  tagLabel: string;
  status: ConversationStatus;
  startedAt: string;
  lastMessageAt: string;
  attributedRevenue: number | null;
  attributedOrderId: string | null;
  messages: ConversationMessage[];
}

export interface AttributionDay {
  date: string;
  recoveredRevenue: number;
  recoveredOrders: number;
}

export interface AttributionCampaignBreakdown {
  campaignId: string;
  campaignName: string;
  recoveredRevenue: number;
  recoveredOrders: number;
  reconciliationStatus: "reconciled" | "pending" | "discrepancy";
}

export interface AttributionSummary {
  periodStart: string;
  periodEnd: string;
  totalRecoveredRevenue: number;
  totalRecoveredOrders: number;
  vsPreviousPeriodPct: number;
  byDay: AttributionDay[];
  byCampaign: AttributionCampaignBreakdown[];
}

export interface InvoiceEntry {
  id: string;
  issuedAt: string;
  amount: number;
  status: "paid" | "open" | "void";
  url: string;
}

export interface BillingSnapshot {
  currentPlan: PlanTier;
  currentPlanLabel: string;
  currentPlanPrice: number;
  monthlyMessageQuota: number;
  monthlyMessagesUsed: number;
  renewsAt: string;
  paymentMethodLast4: string;
  invoices: InvoiceEntry[];
}
