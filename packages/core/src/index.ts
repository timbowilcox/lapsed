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

export {
  redact,
  redactSnapshot,
  assertNoPii,
  PiiLeakError,
  SnapshotShapeError,
  type PiiKind,
  type PiiMatch,
  type RedactResult,
} from "./pii-redactor";

export {
  appendVoiceEvent,
  materializeVoice,
  insertVoiceVersion,
  VoiceEventType,
  VoiceEventSource,
  VoiceFailurePhase,
  type VoiceEventInput,
  type InsertVoiceVersionInput,
} from "./voice-events";

export {
  synthesizeVoice,
  createVoiceClient,
  parseVoiceProfile,
  VoiceSynthesisError,
  SONNET_MODEL_DEFAULT,
  PROMPT_VERSION,
  SYSTEM_PROMPT_TEMPLATE,
  TONE_TAXONOMY,
  SENTENCE_LENGTHS,
  REGISTERS,
  EMOJI_POLICIES,
  type VoiceProfile,
  type ToneDescriptor,
  type SentenceLength,
  type Register,
  type EmojiPolicy,
  type SynthesizeVoiceInput,
  type SynthesizeVoiceResult,
  type VoiceSynthesisReason,
  type VoiceClientOptions,
} from "./voice-synthesizer";
