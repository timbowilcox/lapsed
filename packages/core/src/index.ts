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
  type CustomerForGrouping,
  type MerchantContext,
} from "./customer-groups";
