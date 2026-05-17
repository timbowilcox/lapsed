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
  runVoiceExtraction,
  type RunVoiceExtractionInput,
  type RunVoiceExtractionResult,
} from "./run-voice-extraction";

export {
  deriveAgentIdentity,
  isRoleDescriptor,
  ROLE_TAXONOMY,
  CHANNELS,
  type RoleDescriptor,
  type Channel,
  type ChannelPreferences,
  type FallbackCriteria,
  type AgentIdentityDefaults,
} from "./derive-agent-identity";

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
  snapshotGroup,
  HOLDOUT_RATE_DEFAULT,
  type SnapshotGroupInput,
  type SnapshotGroupResult,
} from "./snapshot-group";

export {
  appendCampaignEvent,
  materializeCampaign,
  getReadyCampaigns,
  CampaignEventType,
  CampaignFailurePhase,
  type CampaignEventInput,
  type CampaignStatus,
  type CampaignMaterializedState,
  type ReadyCampaign,
} from "./campaign-events";

export {
  getAttributionWindow,
  getLtvEvaluationWindow,
  ATTRIBUTION_WINDOW_DAYS_DEFAULT,
  LTV_EVALUATION_WINDOW_DAYS_DEFAULT,
} from "./attribution-config";

export {
  getTreatmentCohort,
  getTreatmentOrders,
  type CampaignOutbound,
  type AttributedOrder,
  type TreatmentCohortResult,
  type TreatmentOrdersResult,
} from "./attribution-treatment";

export {
  getHoldoutCohort,
  getHoldoutOrders,
  type CalendarWindow,
  type HoldoutCohortResult,
  type HoldoutOrder,
  type HoldoutOrdersResult,
} from "./attribution-holdout";

export {
  welchConfidenceInterval,
  studentTCdf,
  studentTQuantile,
  type WelchResult,
} from "./stats/welch";

export {
  computeIncrementalRevenue,
  campaignCalendarWindow,
  INSUFFICIENT_EVIDENCE_MIN_COHORT,
  type IncrementalRevenueResult,
} from "./incremental-revenue";

export {
  recordOrderArrival,
  recordNoOrderOutcome,
  selectArm,
  ORDER_POSTERIOR_MIN_OBSERVATIONS,
  type RecordOrderArrivalInput,
  type RecordNoOrderInput,
  type RecordOutcomeResult,
  type PosteriorSource,
  type ArmPosteriorChoice,
  type ArmSelection,
} from "./bandit-order";

export {
  computeLtvRestoration,
  type LtvRestorationResult,
} from "./ltv-restoration";

export {
  runAttributionBatch,
  type RunAttributionBatchOptions,
  type AttributionBatchResult,
} from "./attribution-batch";

export {
  runAttributionBackfill,
  type RunAttributionBackfillOptions,
  type AttributionBackfillResult,
  type AttributionResultSnapshot,
} from "./attribution-backfill";

export {
  createStripeClient,
  isSubscriptionTier,
  SUBSCRIPTION_TIERS,
  StripeClientError,
  StripeWebhookSignatureError,
  type SubscriptionTier,
  type StripeClientConfig,
  type LapsedStripeClient,
  type StripeSdkLike,
  type StripeWebhookEvent,
  type MerchantBillingRef,
  type CheckoutReturnUrls,
} from "./stripe-client";

export {
  ensureStripeCustomer,
  backfillStripeCustomers,
  type EnsureStripeCustomerResult,
  type BackfillStripeCustomersResult,
} from "./ensure-stripe-customer";

export {
  TIER_PLANS,
  supportTierLabel,
  type TierPlan,
  type SupportTier,
} from "./subscription-tiers";

export {
  handleStripeWebhookEvent,
  type StripeWebhookHandlerConfig,
  type StripeWebhookHandlerResult,
  type MirrorSubscriptionStatus,
} from "./stripe-webhook";

export {
  designCampaign,
  createCampaignClient,
  parseCampaignProposal,
  CampaignDesignError,
  CampaignProposalSchema,
  OFFER_TYPE_TAXONOMY,
  SEND_TIME_WINDOWS,
  computeBackoffMs as campaignBackoffMs,
  PROMPT_VERSION as CAMPAIGN_PROMPT_VERSION,
  SYSTEM_PROMPT_TEMPLATE as CAMPAIGN_SYSTEM_PROMPT_TEMPLATE,
  MAX_RETRIES as CAMPAIGN_MAX_RETRIES,
  MAX_OUTPUT_TOKENS as CAMPAIGN_MAX_OUTPUT_TOKENS,
  type OfferType,
  type SendTimeWindow,
  type CampaignTone,
  type CampaignVariant,
  type ExpectedImpact,
  type CampaignProposalDraft,
  type GroupSummary,
  type DesignCampaignInput,
  type DesignCampaignResult,
  type CampaignClientOptions,
  type CampaignDesignReason,
} from "./campaign-designer";

export {
  proposeCampaign,
  median as campaignGroupMedian,
  type ProposeCampaignInput,
  type ProposeCampaignResult,
} from "./propose-campaign";

export {
  approveProposal,
  rejectProposal,
  editProposal,
  type ApproveProposalResult,
  type RejectProposalResult,
  type EditProposalResult,
  type VariantEdit,
} from "./campaign-approval";

export {
  initializeBanditArm,
  updatePosterior,
  thompsonSample,
  sampleBeta,
  mulberry32,
  betaMean,
  betaVariance,
  regularizedIncompleteBeta,
  betaQuantile,
  posteriorStats,
  NEUTRAL_PRIOR,
  type BanditState,
  type InitializeBanditArmInput,
  type ThompsonSampleOptions,
  type PosteriorStats,
  type Rng,
} from "./bandit";

export {
  createTwilioClient,
  validateWebhookSignature,
  maskPhone,
  computeBackoffMs as twilioBackoffMs,
  TWILIO_MAX_SEND_RETRIES,
  TWILIO_SEND_TIMEOUT_MS_DEFAULT,
  type TwilioClient,
  type TwilioClientOptions,
  type TwilioSdk,
  type TwilioMessageInstance,
  type SendSmsInput,
  type SendSmsResult,
  type SendSmsMetadata,
  type ValidateWebhookSignatureInput,
} from "./twilio-client";

export {
  appendMessageEvent,
  ensureConversation,
  recordConversationActivity,
  MessageEventType,
  DegradedModePhase,
  type MessageEventInput,
  type AppendMessageEventInput,
  type EnsureConversationInput,
  type RecordConversationActivityInput,
} from "./message-events";

export {
  sweepNoReplyPosteriors,
  retryDegradedReplies,
  type SweepNoReplyOpts,
  type SweepNoReplyResult,
  type RetryDegradedOpts,
  type RetryDegradedResult,
} from "./conversation-sweep";

export {
  launchMerchantCampaigns,
  type LaunchMerchantCampaignsOpts,
  type LaunchMerchantCampaignsResult,
} from "./launch-campaigns";

export {
  handleInboundMessage,
  LATENCY_RESERVE_MS,
  OPT_OUT_ACK,
  DEGRADED_FALLBACK_REPLY,
  type HandleInboundDeps,
  type HandleInboundInput,
  type HandleInboundResult,
  type HandleInboundOutcome,
} from "./handle-inbound";

export {
  sendMessage,
  type SendMessageInput,
  type SendMessageResult,
  type SendMessageSkipReason,
  type SendMessageOptions,
} from "./send-message";

export {
  detectOptOutKeyword,
  isOptedOut,
  assertNotOptedOut,
  recordOptOut,
  OptOutError,
  OptOutSource,
  type RecordOptOutInput,
  type RecordOptOutResult,
} from "./opt-out-registry";

export {
  classifyReply,
  createClassifyClient,
  parseReplyClassification,
  ClassifyReplyError,
  CLASSIFY_SYSTEM_PROMPT,
  MAX_CLASSIFY_ATTEMPTS,
  OPT_OUT_CONFIDENCE_THRESHOLD,
  REPLY_SENTIMENTS,
  REPLY_INTENTS,
  type ReplySentiment,
  type ReplyIntent,
  type ReplyClassification,
  type ClassifyReplyInput,
  type ClassifyReplyResult,
  type ClassifyReplyReason,
  type ClassifyClientOptions,
} from "./classify-reply";

export {
  generateReply,
  createGenerateClient,
  parseGeneratedReply,
  buildSystemPrompt as buildReplySystemPrompt,
  buildUserPrompt as buildReplyUserPrompt,
  GenerateReplyError,
  MAX_GENERATE_ATTEMPTS,
  REPLY_HISTORY_LIMIT,
  REPLY_BODY_MAX_CHARS,
  NEXT_ACTIONS,
  type NextAction,
  type GeneratedReply,
  type GenerateReplyInput,
  type GenerateReplyResult,
  type GenerateReplyReason,
  type GenerateClientOptions,
  type ReplyHistoryMessage,
  type CustomerReplyContext,
} from "./generate-reply";

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
