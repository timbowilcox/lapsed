// Server-side environment accessor. Throws at first use if any required
// var is missing so a misconfigured Vercel deploy fails fast at request
// time rather than producing degraded behaviour.

interface ServerEnv {
  shopifyApiKey: string;
  shopifyApiSecret: string;
  shopifyScopes: string;
  shopifyAppUrl: string;
  supabaseUrl: string;
  supabasePublishableKey: string;
  supabaseSecretKey: string;
  supabaseJwtSecret: string;
  tokenEncryptionKey: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`required env var ${name} not set`);
  return v;
}

let cached: ServerEnv | null = null;

export function serverEnv(): ServerEnv {
  if (cached) return cached;
  cached = {
    shopifyApiKey: required("SHOPIFY_API_KEY"),
    shopifyApiSecret: required("SHOPIFY_API_SECRET"),
    shopifyScopes: required("SHOPIFY_SCOPES"),
    shopifyAppUrl: process.env.SHOPIFY_APP_URL ?? "https://app.lapsed.ai",
    supabaseUrl: required("NEXT_PUBLIC_SUPABASE_URL"),
    supabasePublishableKey: required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    supabaseSecretKey: required("SUPABASE_SECRET_KEY"),
    supabaseJwtSecret: required("SUPABASE_JWT_SECRET"),
    tokenEncryptionKey: required("TOKEN_ENCRYPTION_KEY"),
  };
  return cached;
}

/**
 * Public env values that may be read from client components. Next
 * inlines `process.env.NEXT_PUBLIC_*` at build time, so these are
 * embedded into the client JS bundle and safe to read in browser code.
 *
 * NEXT_PUBLIC_SHOPIFY_API_KEY mirrors SHOPIFY_API_KEY (it's the same
 * value — the API key is public; only the secret is sensitive). Used
 * by the App Bridge meta tag in the root layout.
 */
export const publicEnv = {
  shopifyApiKey: process.env.NEXT_PUBLIC_SHOPIFY_API_KEY ?? "",
} as const;
