export type {
  DemoFixtures,
  DemoMerchant,
  DemoLapsedCustomer,
  DemoCampaign,
  DemoConversation,
  DemoAttributionSummary,
  DemoBillingSnapshot,
  DemoCampaignStatus,
  ConversationTagTone,
  ConversationStatus,
  CustomerTier,
  CustomerStatus,
} from "./types";

export const CURRENT_DEMO_VERSION = 1;

export { v1 as demoFixtures } from "./v1";
