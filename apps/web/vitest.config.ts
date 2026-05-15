import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Mirror the "@/*" path alias declared in apps/web/tsconfig.json so
      // route handlers importing `@/app/lib/env` resolve under Vitest.
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    env: {
      // Required by serverEnv() in route handlers under test.
      // These are fake values — routes mock all external calls (Supabase, Shopify).
      CRON_SECRET: "test-secret",
      SHOPIFY_API_KEY: "test-shopify-api-key",
      SHOPIFY_API_SECRET: "test-shopify-api-secret",
      SHOPIFY_SCOPES: "read_customers,read_orders",
      NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
      SUPABASE_SECRET_KEY: "test-service-role-key",
      SUPABASE_JWT_SECRET: "test-jwt-secret",
      TOKEN_ENCRYPTION_KEY: "test-aes-key-32-chars-padded-00000",
      ANTHROPIC_API_KEY: "test-anthropic-key",
    },
  },
});
