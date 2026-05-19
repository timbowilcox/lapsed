-- Migration 0014 — atomic keyword add / remove for merchants.opt_out_keywords and
-- merchants.agent_draft_defaults. Replaces the Node-side read-modify-write
-- pattern with a single Postgres UPDATE, eliminating the race condition on
-- concurrent PATCH requests from the same merchant.
--
-- Called from packages/db via serviceClient.rpc('merchant_keyword_append', ...)
-- and serviceClient.rpc('merchant_keyword_remove', ...).

CREATE OR REPLACE FUNCTION public.merchant_keyword_append(
  p_merchant_id uuid,
  p_list        text,   -- 'opt_out_keywords' | 'agent_draft_defaults'
  p_keyword     text    -- already normalised: uppercase, trimmed, validated
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE merchants
  SET
    opt_out_keywords = CASE WHEN p_list = 'opt_out_keywords'
      THEN array_remove(opt_out_keywords, p_keyword) || ARRAY[p_keyword]
      ELSE opt_out_keywords END,
    agent_draft_defaults = CASE WHEN p_list = 'agent_draft_defaults'
      THEN array_remove(agent_draft_defaults, p_keyword) || ARRAY[p_keyword]
      ELSE agent_draft_defaults END
  WHERE id = p_merchant_id;
$$;

CREATE OR REPLACE FUNCTION public.merchant_keyword_remove(
  p_merchant_id uuid,
  p_list        text,   -- 'opt_out_keywords' | 'agent_draft_defaults'
  p_keyword     text    -- already normalised: uppercase, trimmed, validated
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE merchants
  SET
    opt_out_keywords = CASE WHEN p_list = 'opt_out_keywords'
      THEN array_remove(opt_out_keywords, p_keyword)
      ELSE opt_out_keywords END,
    agent_draft_defaults = CASE WHEN p_list = 'agent_draft_defaults'
      THEN array_remove(agent_draft_defaults, p_keyword)
      ELSE agent_draft_defaults END
  WHERE id = p_merchant_id;
$$;
