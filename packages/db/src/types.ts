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
      conversation_messages: {
        Row: {
          body: string
          channel: string
          conversation_id: string
          embedding: string | null
          id: string
          merchant_id: string
          role: string
          sent_at: string
        }
        Insert: {
          body: string
          channel?: string
          conversation_id: string
          embedding?: string | null
          id?: string
          merchant_id: string
          role: string
          sent_at?: string
        }
        Update: {
          body?: string
          channel?: string
          conversation_id?: string
          embedding?: string | null
          id?: string
          merchant_id?: string
          role?: string
          sent_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_messages_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          attributed_order_gid: string | null
          attributed_revenue_cents: number | null
          campaign_id: string | null
          channel: string
          created_at: string
          embedding: string | null
          id: string
          last_message_at: string | null
          merchant_id: string
          message_count: number
          shopify_customer_gid: string
          status: string
          updated_at: string
        }
        Insert: {
          attributed_order_gid?: string | null
          attributed_revenue_cents?: number | null
          campaign_id?: string | null
          channel?: string
          created_at?: string
          embedding?: string | null
          id?: string
          last_message_at?: string | null
          merchant_id: string
          message_count?: number
          shopify_customer_gid: string
          status?: string
          updated_at?: string
        }
        Update: {
          attributed_order_gid?: string | null
          attributed_revenue_cents?: number | null
          campaign_id?: string | null
          channel?: string
          created_at?: string
          embedding?: string | null
          id?: string
          last_message_at?: string | null
          merchant_id?: string
          message_count?: number
          shopify_customer_gid?: string
          status?: string
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
      merchants: {
        Row: {
          created_at: string
          id: string
          installed_at: string
          last_backfill_at: string | null
          plan: string
          shopify_access_token: string
          shopify_scope: string
          shopify_shop_domain: string
          uninstalled_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          installed_at?: string
          last_backfill_at?: string | null
          plan?: string
          shopify_access_token: string
          shopify_scope: string
          shopify_shop_domain: string
          uninstalled_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          installed_at?: string
          last_backfill_at?: string | null
          plan?: string
          shopify_access_token?: string
          shopify_scope?: string
          shopify_shop_domain?: string
          uninstalled_at?: string | null
          updated_at?: string
        }
        Relationships: []
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
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
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
    Enums: {},
  },
} as const
