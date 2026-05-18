export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      conversations: {
        Row: {
          channel: string
          created_at: string
          customer_id: string
          embedding: string | null
          id: string
          last_inbound_at: string | null
          last_message_at: string | null
          merchant_id: string
          message_count: number
          opened_at: string
          updated_at: string
        }
        Insert: {
          channel?: string
          created_at?: string
          customer_id: string
          embedding?: string | null
          id?: string
          last_inbound_at?: string | null
          last_message_at?: string | null
          merchant_id: string
          message_count?: number
          opened_at?: string
          updated_at?: string
        }
        Update: {
          channel?: string
          created_at?: string
          customer_id?: string
          embedding?: string | null
          id?: string
          last_inbound_at?: string | null
          last_message_at?: string | null
          merchant_id?: string
          message_count?: number
          opened_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_opt_outs: {
        Row: {
          created_at: string
          customer_id: string
          id: string
          inbound_message_id: string | null
          merchant_id: string
          opted_out_at: string
          phone_number: string
          source: string
        }
        Insert: {
          created_at?: string
          customer_id: string
          id?: string
          inbound_message_id?: string | null
          merchant_id: string
          opted_out_at?: string
          phone_number: string
          source: string
        }
        Update: {
          created_at?: string
          customer_id?: string
          id?: string
          inbound_message_id?: string | null
          merchant_id?: string
          opted_out_at?: string
          phone_number?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_opt_outs_inbound_message_id_fkey"
            columns: ["inbound_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_opt_outs_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      message_events: {
        Row: {
          conversation_id: string
          event_type: string
          id: string
          ingested_at: string
          merchant_id: string
          message_id: string | null
          occurred_at: string
          payload: Json
        }
        Insert: {
          conversation_id: string
          event_type: string
          id?: string
          ingested_at?: string
          merchant_id: string
          message_id?: string | null
          occurred_at: string
          payload?: Json
        }
        Update: {
          conversation_id?: string
          event_type?: string
          id?: string
          ingested_at?: string
          merchant_id?: string
          message_id?: string | null
          occurred_at?: string
          payload?: Json
        }
        Relationships: [
          {
            foreignKeyName: "message_events_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_events_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_events_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          arm_id: string | null
          body: string
          campaign_id: string | null
          channel: string
          conversation_id: string
          created_at: string
          direction: string
          embedding: string | null
          id: string
          intent: string | null
          merchant_id: string
          pii_redacted_body: string
          posterior_updated_at: string | null
          sent_at: string
          sentiment: string | null
          status: string
          twilio_sid: string | null
          updated_at: string
        }
        Insert: {
          arm_id?: string | null
          body: string
          campaign_id?: string | null
          channel?: string
          conversation_id: string
          created_at?: string
          direction: string
          embedding?: string | null
          id?: string
          intent?: string | null
          merchant_id: string
          pii_redacted_body: string
          posterior_updated_at?: string | null
          sent_at?: string
          sentiment?: string | null
          status?: string
          twilio_sid?: string | null
          updated_at?: string
        }
        Update: {
          arm_id?: string | null
          body?: string
          campaign_id?: string | null
          channel?: string
          conversation_id?: string
          created_at?: string
          direction?: string
          embedding?: string | null
          id?: string
          intent?: string | null
          merchant_id?: string
          pii_redacted_body?: string
          posterior_updated_at?: string | null
          sent_at?: string
          sentiment?: string | null
          status?: string
          twilio_sid?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_arm_id_fkey"
            columns: ["arm_id"]
            isOneToOne: false
            referencedRelation: "campaign_arms"
            referencedColumns: ["bandit_arm_id"]
          },
          {
            foreignKeyName: "messages_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaign_proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_events: {
        Row: {
          event_type: string
          id: string
          ingested_at: string
          merchant_id: string
          occurred_at: string
          payload: Json
          shopify_customer_gid: string
          source: string
        }
        Insert: {
          event_type: string
          id?: string
          ingested_at?: string
          merchant_id: string
          occurred_at: string
          payload?: Json
          shopify_customer_gid: string
          source: string
        }
        Update: {
          event_type?: string
          id?: string
          ingested_at?: string
          merchant_id?: string
          occurred_at?: string
          payload?: Json
          shopify_customer_gid?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_events_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          created_at: string
          email: string | null
          first_name: string | null
          id: string
          lapsed_at: string | null
          lapsed_score: number | null
          last_name: string | null
          last_order_at: string | null
          last_order_days_ago: number | null
          merchant_id: string
          phone: string | null
          profile_version: number
          restored_at: string | null
          shopify_customer_gid: string
          sms_opt_out: boolean
          sms_opt_out_at: string | null
          tags: string[]
          total_ltv_cents: number
          total_order_count: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          first_name?: string | null
          id?: string
          lapsed_at?: string | null
          lapsed_score?: number | null
          last_name?: string | null
          last_order_at?: string | null
          last_order_days_ago?: number | null
          merchant_id: string
          phone?: string | null
          profile_version?: number
          restored_at?: string | null
          shopify_customer_gid: string
          sms_opt_out?: boolean
          sms_opt_out_at?: string | null
          tags?: string[]
          total_ltv_cents?: number
          total_order_count?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string | null
          first_name?: string | null
          id?: string
          lapsed_at?: string | null
          lapsed_score?: number | null
          last_name?: string | null
          last_order_at?: string | null
          last_order_days_ago?: number | null
          merchant_id?: string
          phone?: string | null
          profile_version?: number
          restored_at?: string | null
          shopify_customer_gid?: string
          sms_opt_out?: boolean
          sms_opt_out_at?: string | null
          tags?: string[]
          total_ltv_cents?: number
          total_order_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customers_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_events: {
        Row: {
          event_type: string
          id: string
          ingested_at: string
          merchant_id: string
          occurred_at: string
          payload: Json
          source: string
        }
        Insert: {
          event_type: string
          id?: string
          ingested_at?: string
          merchant_id: string
          occurred_at: string
          payload?: Json
          source: string
        }
        Update: {
          event_type?: string
          id?: string
          ingested_at?: string
          merchant_id?: string
          occurred_at?: string
          payload?: Json
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_events_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      merchants: {
        Row: {
          agent_draft_defaults: string[]
          created_at: string
          id: string
          installed_at: string
          last_backfill_at: string | null
          onboarding_state: "not_started" | "in_progress" | "completed" | "skipped"
          opt_out_keywords: string[]
          plan: string
          shopify_access_token: string
          shopify_scope: string
          shopify_shop_domain: string
          stripe_customer_id: string | null
          subscription_status: string | null
          subscription_tier: string | null
          uninstalled_at: string | null
          updated_at: string
        }
        Insert: {
          agent_draft_defaults?: string[]
          created_at?: string
          id?: string
          installed_at?: string
          last_backfill_at?: string | null
          onboarding_state?: "not_started" | "in_progress" | "completed" | "skipped"
          opt_out_keywords?: string[]
          plan?: string
          shopify_access_token: string
          shopify_scope: string
          shopify_shop_domain: string
          stripe_customer_id?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          uninstalled_at?: string | null
          updated_at?: string
        }
        Update: {
          agent_draft_defaults?: string[]
          created_at?: string
          id?: string
          installed_at?: string
          last_backfill_at?: string | null
          onboarding_state?: "not_started" | "in_progress" | "completed" | "skipped"
          opt_out_keywords?: string[]
          plan?: string
          shopify_access_token?: string
          shopify_scope?: string
          shopify_shop_domain?: string
          stripe_customer_id?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          uninstalled_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      merchant_subscriptions: {
        Row: {
          cancel_at: string | null
          canceled_at: string | null
          created_at: string
          current_period_end: string
          current_period_start: string
          grace_period_started_at: string | null
          id: string
          merchant_id: string
          status: string
          stripe_subscription_id: string
          tier: string
          updated_at: string
        }
        Insert: {
          cancel_at?: string | null
          canceled_at?: string | null
          created_at?: string
          current_period_end: string
          current_period_start: string
          grace_period_started_at?: string | null
          id?: string
          merchant_id: string
          status: string
          stripe_subscription_id: string
          tier: string
          updated_at?: string
        }
        Update: {
          cancel_at?: string | null
          canceled_at?: string | null
          created_at?: string
          current_period_end?: string
          current_period_start?: string
          grace_period_started_at?: string | null
          id?: string
          merchant_id?: string
          status?: string
          stripe_subscription_id?: string
          tier?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_subscriptions_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: true
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      subscription_events: {
        Row: {
          appended_at: string
          data: Json
          event_type: string
          id: string
          merchant_id: string
          stripe_event_id: string | null
        }
        Insert: {
          appended_at?: string
          data?: Json
          event_type: string
          id?: string
          merchant_id: string
          stripe_event_id?: string | null
        }
        Update: {
          appended_at?: string
          data?: Json
          event_type?: string
          id?: string
          merchant_id?: string
          stripe_event_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "subscription_events_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      order_events: {
        Row: {
          event_type: string
          id: string
          ingested_at: string
          merchant_id: string
          occurred_at: string
          payload: Json
          shopify_customer_gid: string
          shopify_order_gid: string
          source: string
        }
        Insert: {
          event_type: string
          id?: string
          ingested_at?: string
          merchant_id: string
          occurred_at: string
          payload?: Json
          shopify_customer_gid: string
          shopify_order_gid: string
          source: string
        }
        Update: {
          event_type?: string
          id?: string
          ingested_at?: string
          merchant_id?: string
          occurred_at?: string
          payload?: Json
          shopify_customer_gid?: string
          shopify_order_gid?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_events_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          created_at: string
          financial_status: string
          fulfilled_at: string | null
          id: string
          merchant_id: string
          shopify_created_at: string
          shopify_customer_gid: string
          shopify_order_gid: string
          total_price_cents: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          financial_status: string
          fulfilled_at?: string | null
          id?: string
          merchant_id: string
          shopify_created_at: string
          shopify_customer_gid: string
          shopify_order_gid: string
          total_price_cents: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          financial_status?: string
          fulfilled_at?: string | null
          id?: string
          merchant_id?: string
          shopify_created_at?: string
          shopify_customer_gid?: string
          shopify_order_gid?: string
          total_price_cents?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          created_at: string
          handle: string
          id: string
          inventory_quantity: number
          merchant_id: string
          price_cents: number
          product_type: string
          shopify_product_gid: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          handle: string
          id?: string
          inventory_quantity?: number
          merchant_id: string
          price_cents?: number
          product_type?: string
          shopify_product_gid: string
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          handle?: string
          id?: string
          inventory_quantity?: number
          merchant_id?: string
          price_cents?: number
          product_type?: string
          shopify_product_gid?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "products_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_deliveries: {
        Row: {
          error_message: string | null
          id: string
          merchant_id: string | null
          payload: Json
          processed_at: string | null
          received_at: string
          shopify_webhook_id: string
          status: string
          topic: string
        }
        Insert: {
          error_message?: string | null
          id?: string
          merchant_id?: string | null
          payload: Json
          processed_at?: string | null
          received_at?: string
          shopify_webhook_id: string
          status?: string
          topic: string
        }
        Update: {
          error_message?: string | null
          id?: string
          merchant_id?: string | null
          payload?: Json
          processed_at?: string | null
          received_at?: string
          shopify_webhook_id?: string
          status?: string
          topic?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_deliveries_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_rfm: {
        Row: {
          created_at: string
          frequency: number
          frequency_score: number | null
          id: string
          lifecycle_stage: Database["public"]["Enums"]["lifecycle_stage"] | null
          merchant_id: string
          monetary_cents: string  // bigint — returned as string by Supabase to preserve precision
          monetary_score: number | null
          recency_days: number | null
          recency_score: number | null
          refreshed_at: string
          rfm_combined: number | null
          shopify_customer_gid: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          frequency?: number
          frequency_score?: number | null
          id?: string
          lifecycle_stage?: Database["public"]["Enums"]["lifecycle_stage"] | null
          merchant_id: string
          monetary_cents?: string | number  // bigint — accepts number for convenience on insert
          monetary_score?: number | null
          recency_days?: number | null
          recency_score?: number | null
          refreshed_at?: string
          rfm_combined?: number | null
          shopify_customer_gid: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          frequency?: number
          frequency_score?: number | null
          id?: string
          lifecycle_stage?: Database["public"]["Enums"]["lifecycle_stage"] | null
          merchant_id?: string
          monetary_cents?: string | number  // bigint — accepts number for convenience on update
          monetary_score?: number | null
          recency_days?: number | null
          recency_score?: number | null
          refreshed_at?: string
          rfm_combined?: number | null
          shopify_customer_gid?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_rfm_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      scoring_runs: {
        Row: {
          cost_cents: number
          created_at: string
          customers_scored: number
          error_message: string | null
          finished_at: string | null
          id: string
          merchant_id: string
          model_version: string
          started_at: string
          status: "running" | "succeeded" | "failed"
          tokens_input: number
          tokens_output: number
        }
        Insert: {
          cost_cents?: number
          created_at?: string
          customers_scored?: number
          error_message?: string | null
          finished_at?: string | null
          id?: string
          merchant_id: string
          model_version: string
          started_at?: string
          status?: "running" | "succeeded" | "failed"
          tokens_input?: number
          tokens_output?: number
        }
        Update: {
          cost_cents?: number
          created_at?: string
          customers_scored?: number
          error_message?: string | null
          finished_at?: string | null
          id?: string
          merchant_id?: string
          model_version?: string
          started_at?: string
          status?: "running" | "succeeded" | "failed"
          tokens_input?: number
          tokens_output?: number
        }
        Relationships: [
          {
            foreignKeyName: "scoring_runs_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_scoring_caps: {
        Row: {
          created_at: string
          daily_token_cap: number
          id: string
          merchant_id: string
          period_start: string
          tokens_used_today: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          daily_token_cap?: number
          id?: string
          merchant_id: string
          period_start?: string
          tokens_used_today?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          daily_token_cap?: number
          id?: string
          merchant_id?: string
          period_start?: string
          tokens_used_today?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_scoring_caps_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      storefront_snapshots: {
        Row: {
          created_at: string
          fetched_at: string
          id: string
          merchant_id: string
          pii_match_summary: Json
          raw_content: Json
          redacted_content: Json
          source_hash: string
        }
        Insert: {
          created_at?: string
          fetched_at?: string
          id?: string
          merchant_id: string
          pii_match_summary?: Json
          raw_content: Json
          redacted_content: Json
          source_hash: string
        }
        Update: {
          created_at?: string
          fetched_at?: string
          id?: string
          merchant_id?: string
          pii_match_summary?: Json
          raw_content?: Json
          redacted_content?: Json
          source_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "storefront_snapshots_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      voice_events: {
        Row: {
          event_type: string
          id: string
          ingested_at: string
          merchant_id: string
          occurred_at: string
          payload: Json
          source: string
        }
        Insert: {
          event_type: string
          id?: string
          ingested_at?: string
          merchant_id: string
          occurred_at: string
          payload?: Json
          source: string
        }
        Update: {
          event_type?: string
          id?: string
          ingested_at?: string
          merchant_id?: string
          occurred_at?: string
          payload?: Json
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "voice_events_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      voice_versions: {
        Row: {
          created_at: string
          extracted_at: string
          id: string
          merchant_id: string
          model_version: string
          profile: Json
          prompt_version: string
          retries: number
          source_snapshot_id: string
          tokens_input: number
          tokens_output: number
          version_number: number
        }
        Insert: {
          created_at?: string
          extracted_at?: string
          id?: string
          merchant_id: string
          model_version: string
          profile: Json
          prompt_version: string
          retries?: number
          source_snapshot_id: string
          tokens_input?: number
          tokens_output?: number
          version_number: number
        }
        Update: {
          created_at?: string
          extracted_at?: string
          id?: string
          merchant_id?: string
          model_version?: string
          profile?: Json
          prompt_version?: string
          retries?: number
          source_snapshot_id?: string
          tokens_input?: number
          tokens_output?: number
          version_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "voice_versions_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voice_versions_source_snapshot_id_fkey"
            columns: ["source_snapshot_id"]
            isOneToOne: false
            referencedRelation: "storefront_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_profiles: {
        Row: {
          active_voice_version_id: string | null
          channel_prefs: Json
          created_at: string
          fallback_criteria: Json
          merchant_id: string
          role_descriptor: string
          updated_at: string
        }
        Insert: {
          active_voice_version_id?: string | null
          channel_prefs?: Json
          created_at?: string
          fallback_criteria?: Json
          merchant_id: string
          role_descriptor?: string
          updated_at?: string
        }
        Update: {
          active_voice_version_id?: string | null
          channel_prefs?: Json
          created_at?: string
          fallback_criteria?: Json
          merchant_id?: string
          role_descriptor?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_profiles_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: true
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_profiles_active_voice_version_id_fkey"
            columns: ["active_voice_version_id"]
            isOneToOne: false
            referencedRelation: "voice_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_inferred_state: {
        Row: {
          created_at: string
          group_memberships: string[]
          id: string
          last_engagement_event_at: string | null
          last_scored_at: string | null
          lifecycle_stage: Database["public"]["Enums"]["lifecycle_stage"] | null
          merchant_id: string
          predicted_residual_ltv_cents: string | null  // bigint → string for precision safety
          propensity_30d: number | null
          propensity_60d: number | null
          propensity_90d: number | null
          score_model_version: string | null
          score_run_id: string | null
          shopify_customer_gid: string
          top_signal: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          group_memberships?: string[]
          id?: string
          last_engagement_event_at?: string | null
          last_scored_at?: string | null
          lifecycle_stage?: Database["public"]["Enums"]["lifecycle_stage"] | null
          merchant_id: string
          predicted_residual_ltv_cents?: string | null  // bigint → string
          propensity_30d?: number | null
          propensity_60d?: number | null
          propensity_90d?: number | null
          score_model_version?: string | null
          score_run_id?: string | null
          shopify_customer_gid: string
          top_signal?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          group_memberships?: string[]
          id?: string
          last_engagement_event_at?: string | null
          last_scored_at?: string | null
          lifecycle_stage?: Database["public"]["Enums"]["lifecycle_stage"] | null
          merchant_id?: string
          predicted_residual_ltv_cents?: string | null  // bigint → string
          propensity_30d?: number | null
          propensity_60d?: number | null
          propensity_90d?: number | null
          score_model_version?: string | null
          score_run_id?: string | null
          shopify_customer_gid?: string
          top_signal?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_inferred_state_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_inferred_state_score_run_id_fkey"
            columns: ["score_run_id"]
            isOneToOne: false
            referencedRelation: "scoring_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_attribution_config: {
        Row: {
          attribution_window_days: number
          created_at: string
          ltv_evaluation_window_days: number
          merchant_id: string
          updated_at: string
        }
        Insert: {
          attribution_window_days?: number
          created_at?: string
          ltv_evaluation_window_days?: number
          merchant_id: string
          updated_at?: string
        }
        Update: {
          attribution_window_days?: number
          created_at?: string
          ltv_evaluation_window_days?: number
          merchant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_attribution_config_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: true
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      attribution_decisions: {
        Row: {
          attributed_campaign_id: string | null
          attributed_message_id: string | null
          attribution_window_days: number
          customer_id: string | null
          decided_at: string
          decision_type: string
          id: string
          merchant_id: string
          order_id: string | null
        }
        Insert: {
          attributed_campaign_id?: string | null
          attributed_message_id?: string | null
          attribution_window_days: number
          customer_id?: string | null
          decided_at?: string
          decision_type?: string
          id?: string
          merchant_id: string
          order_id?: string | null
        }
        Update: {
          attributed_campaign_id?: string | null
          attributed_message_id?: string | null
          attribution_window_days?: number
          customer_id?: string | null
          decided_at?: string
          decision_type?: string
          id?: string
          merchant_id?: string
          order_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "attribution_decisions_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attribution_decisions_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attribution_decisions_attributed_campaign_id_fkey"
            columns: ["attributed_campaign_id"]
            isOneToOne: false
            referencedRelation: "campaign_proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attribution_decisions_attributed_message_id_fkey"
            columns: ["attributed_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      attribution_results: {
        Row: {
          campaign_id: string
          computed_at: string
          holdout_cohort_size: number
          holdout_revenue_cents: number
          id: string
          incremental_ci_high_cents: number | null
          incremental_ci_low_cents: number | null
          incremental_revenue_cents: number
          insufficient_evidence: boolean
          ltv_ci_high_cents: number | null
          ltv_ci_low_cents: number | null
          ltv_restored_cents: number
          merchant_id: string
          treatment_cohort_size: number
          treatment_revenue_cents: number
          window_close_date: string
        }
        Insert: {
          campaign_id: string
          computed_at?: string
          holdout_cohort_size: number
          holdout_revenue_cents: number
          id?: string
          incremental_ci_high_cents?: number | null
          incremental_ci_low_cents?: number | null
          incremental_revenue_cents: number
          insufficient_evidence?: boolean
          ltv_ci_high_cents?: number | null
          ltv_ci_low_cents?: number | null
          ltv_restored_cents: number
          merchant_id: string
          treatment_cohort_size: number
          treatment_revenue_cents: number
          window_close_date: string
        }
        Update: {
          campaign_id?: string
          computed_at?: string
          holdout_cohort_size?: number
          holdout_revenue_cents?: number
          id?: string
          incremental_ci_high_cents?: number | null
          incremental_ci_low_cents?: number | null
          incremental_revenue_cents?: number
          insufficient_evidence?: boolean
          ltv_ci_high_cents?: number | null
          ltv_ci_low_cents?: number | null
          ltv_restored_cents?: number
          merchant_id?: string
          treatment_cohort_size?: number
          treatment_revenue_cents?: number
          window_close_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "attribution_results_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attribution_results_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaign_proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      ltv_snapshots: {
        Row: {
          campaign_id: string
          customer_id: string
          delta_cents: number
          id: string
          merchant_id: string
          post_30d_revenue_cents: number
          pre_30d_revenue_cents: number
          snapshot_at: string
        }
        Insert: {
          campaign_id: string
          customer_id: string
          delta_cents: number
          id?: string
          merchant_id: string
          post_30d_revenue_cents: number
          pre_30d_revenue_cents: number
          snapshot_at?: string
        }
        Update: {
          campaign_id?: string
          customer_id?: string
          delta_cents?: number
          id?: string
          merchant_id?: string
          post_30d_revenue_cents?: number
          pre_30d_revenue_cents?: number
          snapshot_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ltv_snapshots_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ltv_snapshots_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaign_proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_proposals: {
        Row: {
          approved_at: string | null
          approved_by_user_id: string | null
          attribution_window_days: number
          created_at: string
          generated_at: string
          group_slug: string
          id: string
          merchant_id: string
          model_version: string
          rejected_at: string | null
          rejection_reason: string | null
          source: "agent" | "manual"
          status: Database["public"]["Enums"]["campaign_proposal_status"]
          supersedes_proposal_id: string | null
          version_number: number
        }
        Insert: {
          approved_at?: string | null
          approved_by_user_id?: string | null
          attribution_window_days?: number
          created_at?: string
          generated_at?: string
          group_slug: string
          id?: string
          merchant_id: string
          model_version: string
          rejected_at?: string | null
          rejection_reason?: string | null
          source?: "agent" | "manual"
          status?: Database["public"]["Enums"]["campaign_proposal_status"]
          supersedes_proposal_id?: string | null
          version_number?: number
        }
        Update: {
          approved_at?: string | null
          approved_by_user_id?: string | null
          attribution_window_days?: number
          created_at?: string
          generated_at?: string
          group_slug?: string
          id?: string
          merchant_id?: string
          model_version?: string
          rejected_at?: string | null
          rejection_reason?: string | null
          source?: "agent" | "manual"
          status?: Database["public"]["Enums"]["campaign_proposal_status"]
          supersedes_proposal_id?: string | null
          version_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "campaign_proposals_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_proposals_supersedes_proposal_id_fkey"
            columns: ["supersedes_proposal_id"]
            isOneToOne: false
            referencedRelation: "campaign_proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_arms: {
        Row: {
          bandit_arm_id: string
          created_at: string
          expected_impact: Json
          id: string
          merchant_id: string
          message_draft: string
          offer_type: string
          offer_value: string
          proposal_id: string
          send_time_window: string
          tone: string
          variant_index: number
        }
        Insert: {
          bandit_arm_id?: string
          created_at?: string
          expected_impact?: Json
          id?: string
          merchant_id: string
          message_draft: string
          offer_type: string
          offer_value: string
          proposal_id: string
          send_time_window: string
          tone: string
          variant_index: number
        }
        Update: {
          bandit_arm_id?: string
          created_at?: string
          expected_impact?: Json
          id?: string
          merchant_id?: string
          message_draft?: string
          offer_type?: string
          offer_value?: string
          proposal_id?: string
          send_time_window?: string
          tone?: string
          variant_index?: number
        }
        Relationships: [
          {
            foreignKeyName: "campaign_arms_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "campaign_proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_arms_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      bandit_state: {
        Row: {
          arm_id: string
          created_at: string
          last_updated_at: string
          merchant_id: string
          observation_count: number
          order_alpha: number
          order_beta: number
          order_last_updated_at: string | null
          order_observation_count: number
          proposal_id: string
          sentiment_alpha: number
          sentiment_beta: number
        }
        Insert: {
          arm_id: string
          created_at?: string
          last_updated_at?: string
          merchant_id: string
          observation_count?: number
          order_alpha?: number
          order_beta?: number
          order_last_updated_at?: string | null
          order_observation_count?: number
          proposal_id: string
          sentiment_alpha?: number
          sentiment_beta?: number
        }
        Update: {
          arm_id?: string
          created_at?: string
          last_updated_at?: string
          merchant_id?: string
          observation_count?: number
          order_alpha?: number
          order_beta?: number
          order_last_updated_at?: string | null
          order_observation_count?: number
          proposal_id?: string
          sentiment_alpha?: number
          sentiment_beta?: number
        }
        Relationships: [
          {
            foreignKeyName: "bandit_state_arm_id_fkey"
            columns: ["arm_id"]
            isOneToOne: true
            referencedRelation: "campaign_arms"
            referencedColumns: ["bandit_arm_id"]
          },
          {
            foreignKeyName: "bandit_state_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "campaign_proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bandit_state_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_group_snapshots: {
        Row: {
          created_at: string
          customer_id: string
          included_in_holdout: boolean
          merchant_id: string
          proposal_id: string
        }
        Insert: {
          created_at?: string
          customer_id: string
          included_in_holdout?: boolean
          merchant_id: string
          proposal_id: string
        }
        Update: {
          created_at?: string
          customer_id?: string
          included_in_holdout?: boolean
          merchant_id?: string
          proposal_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_group_snapshots_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "campaign_proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_group_snapshots_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_events: {
        Row: {
          event_type: string
          id: string
          ingested_at: string
          merchant_id: string
          occurred_at: string
          payload: Json
          proposal_id: string
        }
        Insert: {
          event_type: string
          id?: string
          ingested_at?: string
          merchant_id: string
          occurred_at: string
          payload?: Json
          proposal_id: string
        }
        Update: {
          event_type?: string
          id?: string
          ingested_at?: string
          merchant_id?: string
          occurred_at?: string
          payload?: Json
          proposal_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_events_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_events_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "campaign_proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      insights: {
        Row: {
          category: string
          created_at: string
          cta_action: Json
          expires_at: string | null
          id: string
          insight_key: string
          merchant_copy: string
          merchant_id: string
          priority: string
          signal_metric: string
          signal_value: number
          state: string
          threshold: number
        }
        Insert: {
          category: string
          created_at?: string
          cta_action: Json
          expires_at?: string | null
          id?: string
          insight_key: string
          merchant_copy: string
          merchant_id: string
          priority: string
          signal_metric: string
          signal_value: number
          state?: string
          threshold: number
        }
        Update: {
          category?: string
          created_at?: string
          cta_action?: Json
          expires_at?: string | null
          id?: string
          insight_key?: string
          merchant_copy?: string
          merchant_id?: string
          priority?: string
          signal_metric?: string
          signal_value?: number
          state?: string
          threshold?: number
        }
        Relationships: [
          {
            foreignKeyName: "insights_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      campaign_holdouts: {
        Row: {
          created_at: string | null
          customer_id: string | null
          merchant_id: string | null
          proposal_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "campaign_group_snapshots_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "campaign_proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_aggregates: {
        Row: {
          ltv_p75_cents: string | null
          ltv_p90_cents: string | null
          median_aov_cents: string | null
          median_ltv_cents: string | null
          merchant_id: string
          refreshed_at: string
          total_customers: string | null
          total_lapsed: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      refresh_merchant_aggregates: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      increment_customer_order: {
        Args: {
          p_merchant_id: string
          p_customer_gid: string
          p_amount_cents: number
          p_ordered_at: string
        }
        Returns: undefined
      }
      merchant_keyword_append: {
        Args: {
          p_merchant_id: string
          p_list: string
          p_keyword: string
        }
        Returns: undefined
      }
      merchant_keyword_remove: {
        Args: {
          p_merchant_id: string
          p_list: string
          p_keyword: string
        }
        Returns: undefined
      }
    }
    Enums: {
      lifecycle_stage: "new" | "engaged" | "at_risk" | "lapsed" | "won_back" | "churned"
      campaign_proposal_status: "proposed" | "approved" | "rejected" | "edited"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      lifecycle_stage: ["new", "engaged", "at_risk", "lapsed", "won_back", "churned"],
      campaign_proposal_status: ["proposed", "approved", "rejected", "edited"],
    },
  },
} as const
