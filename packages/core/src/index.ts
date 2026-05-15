// @lapsed/core — domain logic (cadence, scoring, attribution).
export const CORE_VERSION = "0.1.0";

export {
  appendCustomerEvent,
  appendOrderEvent,
  CustomerEventType,
  OrderEventType,
  type CustomerEventInput,
  type OrderEventInput,
} from "./customer-events";

export { materializeCustomer } from "./materialize-customer";

export {
  classifyLifecycle,
  type LifecycleStage,
  type CustomerSnapshot,
} from "./customer-lifecycle";

export {
  assignGroups,
  type GroupSlug,
  type GroupAssignment,
  type CustomerForGrouping,
  type MerchantContext,
} from "./customer-groups";

export { runRfmBatch, type RfmBatchResult } from "./rfm-batch";

export {
  scoreBatch,
  createScoringClient,
  HAIKU_MODEL,
  BATCH_SIZE,
  type CustomerScoringInput,
  type CustomerScoringOutput,
  type ScoringBatchResult,
  type ScoringClientOptions,
} from "./customer-scoring";

export {
  scoreCustomers,
  type ScoreCustomersResult,
  type ScoreCustomersOpts,
} from "./score-customers";
