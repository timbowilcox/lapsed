// Agent identity defaults derivation — pure function from VoiceProfile to
// suggested AgentIdentityDefaults. Implements architectural decision 11:
// role_descriptor is taxonomy-constrained, never freeform. The output is
// suggestion-only — merchant edits override and are persisted on
// agent_profiles directly.

import type {
  VoiceProfile,
  ToneDescriptor,
  Register,
  EmojiPolicy,
} from "./voice-synthesizer";

// ─────────────────────────────────────────────────────────────────────────────
// Role taxonomy (decision 11)
// ─────────────────────────────────────────────────────────────────────────────

export const ROLE_TAXONOMY = [
  "win_back_specialist",
  "customer_care_agent",
  "loyalty_concierge",
  "vip_concierge",
  "reactivation_advisor",
  "personal_shopper",
] as const;

export type RoleDescriptor = (typeof ROLE_TAXONOMY)[number];

// Channel descriptors mirror the channel-agnostic conversation engine
// decision 3: channel is a parameter, never a hardcoded constant.
export const CHANNELS = ["sms", "email", "voice"] as const;
export type Channel = (typeof CHANNELS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Output shape
// ─────────────────────────────────────────────────────────────────────────────

export interface ChannelPreferences {
  primary: Channel;
  fallback?: Channel;
}

export interface FallbackCriteria {
  /** If model confidence on intent classification drops below this, escalate. */
  confidence_threshold: number;
  /** Max turns before automatic human handoff suggestion. */
  escalate_after_turns: number;
  /** Intents that always escalate to a human even on the first turn. */
  escalate_on_intents: string[];
}

export interface AgentIdentityDefaults {
  role_descriptor: RoleDescriptor;
  channel_prefs: ChannelPreferences;
  fallback_criteria: FallbackCriteria;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tone → role mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps a tone descriptor to a role-affinity score (1 = strongest fit). The
 * derivation picks the role with the highest total affinity across the
 * voice profile's tone descriptors. Ties resolve to a stable order via the
 * ROLE_TAXONOMY index.
 *
 * win_back_specialist is the global default for any voice profile that
 * doesn't have strong signal for another role — most brands fit it.
 */
const TONE_TO_ROLE: Record<ToneDescriptor, Partial<Record<RoleDescriptor, number>>> = {
  warm: { customer_care_agent: 2, loyalty_concierge: 1, win_back_specialist: 1 },
  witty: { win_back_specialist: 1, personal_shopper: 1 },
  authoritative: { reactivation_advisor: 2, vip_concierge: 1 },
  playful: { win_back_specialist: 1, personal_shopper: 1 },
  aspirational: { vip_concierge: 2, loyalty_concierge: 1 },
  down_to_earth: { customer_care_agent: 2, win_back_specialist: 1 },
  irreverent: { win_back_specialist: 1, personal_shopper: 1 },
  caring: { customer_care_agent: 3, loyalty_concierge: 1 },
  direct: { reactivation_advisor: 2 },
  nostalgic: { loyalty_concierge: 2 },
  confident: { reactivation_advisor: 1, vip_concierge: 1 },
  curious: { personal_shopper: 2 },
  minimalist: { reactivation_advisor: 1 },
  passionate: { vip_concierge: 1, loyalty_concierge: 1 },
  thoughtful: { customer_care_agent: 1, loyalty_concierge: 1 },
  earnest: { customer_care_agent: 2 },
  wry: { win_back_specialist: 1 },
  polished: { vip_concierge: 2, loyalty_concierge: 1 },
  scrappy: { win_back_specialist: 2 },
  reassuring: { customer_care_agent: 2 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Register + emoji policy → channel preferences
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps register + emoji policy to channel preferences. Formal/never-emoji
 * → email-leaning. Casual/frequent-emoji → SMS-leaning. Conversational +
 * rare emoji → SMS primary with email fallback (the v1 default).
 */
function deriveChannelPrefs(
  register: Register,
  emojiPolicy: EmojiPolicy,
): ChannelPreferences {
  // Formal + email-friendly tone never picks SMS as primary.
  if (register === "formal" || (register === "professional" && emojiPolicy === "never")) {
    return { primary: "email", fallback: "sms" };
  }
  // Casual + emoji-heavy is clearly SMS-native.
  if (register === "casual" || register === "edgy") {
    return { primary: "sms", fallback: "email" };
  }
  // Conversational / professional with emoji signal → SMS-leaning with
  // email fallback for opt-outs.
  return { primary: "sms", fallback: "email" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fallback criteria baseline
// ─────────────────────────────────────────────────────────────────────────────

const FALLBACK_BASELINE: FallbackCriteria = {
  confidence_threshold: 0.55,
  escalate_after_turns: 6,
  escalate_on_intents: ["complaint", "legal", "refund_dispute", "harassment"],
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derives suggested agent identity defaults from a voice profile. PURE.
 *
 * The output is suggestion-only — the merchant approves or edits via the
 * Settings UI (chunk 11) and the merchant's choice overrides the
 * derivation. role_descriptor is constrained to ROLE_TAXONOMY at the type
 * level (decision 11), so a future refactor cannot introduce a freeform
 * persona name through this code path.
 */
export function deriveAgentIdentity(profile: VoiceProfile): AgentIdentityDefaults {
  // Tally affinity across each tone descriptor in the profile.
  const scores: Record<RoleDescriptor, number> = {
    win_back_specialist: 0,
    customer_care_agent: 0,
    loyalty_concierge: 0,
    vip_concierge: 0,
    reactivation_advisor: 0,
    personal_shopper: 0,
  };
  for (const tone of profile.tone_descriptors) {
    const affinities = TONE_TO_ROLE[tone];
    if (!affinities) continue;
    for (const [role, weight] of Object.entries(affinities) as [RoleDescriptor, number][]) {
      scores[role] = (scores[role] ?? 0) + (weight ?? 0);
    }
  }

  // Pick the role with the highest score. Ties resolve to ROLE_TAXONOMY
  // order so the derivation is deterministic across runs (replay safety).
  let bestRole: RoleDescriptor = "win_back_specialist";
  let bestScore = scores[bestRole];
  for (const role of ROLE_TAXONOMY) {
    if (scores[role] > bestScore) {
      bestRole = role;
      bestScore = scores[role];
    }
  }
  // If no tone descriptor produced any signal, fall back to the global
  // default rather than picking an arbitrary entry from the taxonomy.
  if (bestScore === 0) bestRole = "win_back_specialist";

  return {
    role_descriptor: bestRole,
    channel_prefs: deriveChannelPrefs(profile.register, profile.emoji_policy),
    // Deep-clone the baseline so callers can mutate per-merchant escalation
    // intents without leaking back into the module-level constant.
    fallback_criteria: {
      ...FALLBACK_BASELINE,
      escalate_on_intents: [...FALLBACK_BASELINE.escalate_on_intents],
    },
  };
}

/**
 * Predicate: is `value` a member of ROLE_TAXONOMY? Used by the Settings
 * UI's "edit role" form to validate at the boundary. Decision 11 is also
 * enforced at the DB layer via the agent_profiles_role_descriptor_shape
 * CHECK, and at the Zod layer via this function exported here.
 */
export function isRoleDescriptor(value: unknown): value is RoleDescriptor {
  return typeof value === "string" && (ROLE_TAXONOMY as readonly string[]).includes(value);
}
