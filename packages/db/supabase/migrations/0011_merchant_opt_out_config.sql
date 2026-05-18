-- Migration 0011 — merchant opt-out keyword configuration
-- Sprint 11 Chunk 6: opt-out keyword editing UI
--
-- Two array columns on merchants:
--   opt_out_keywords      — custom inbound keyword detection (merchant can add/remove)
--   agent_draft_defaults  — keywords the agent is instructed to include in outbound drafts
--
-- STOP and STOPALL are enforced as non-removable at the application layer (the API
-- rejects remove requests for these two). The columns store only the merchant-configured
-- keywords, not the Twilio-reserved base set; the API layer merges them for display.

alter table public.merchants
  add column if not exists opt_out_keywords     text[] not null default '{}',
  add column if not exists agent_draft_defaults text[] not null default array['STOP', 'UNSUBSCRIBE'];
