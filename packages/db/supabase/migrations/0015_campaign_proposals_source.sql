-- Migration 0015 — add source column to campaign_proposals.
--
-- Distinguishes agent-generated proposals (the AI Campaign Designer, Sprint 06)
-- from merchant-created proposals (the manual builder, Sprint 11 Chunk 7).
-- Stored on the row so attribution dashboards and operator tooling can filter
-- by origin without replaying the event log.

alter table public.campaign_proposals
  add column if not exists source text not null default 'agent'
    constraint campaign_proposals_source_check check (source in ('agent', 'manual'));

comment on column public.campaign_proposals.source is
  'Origin of the proposal: ''agent'' (AI Campaign Designer) or ''manual'' (merchant-created via the wizard).';
