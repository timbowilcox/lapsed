import { NextResponse, type NextRequest } from "next/server";
import {
  verifyShopifySessionToken,
  SESSION_COOKIE,
} from "@lapsed/shopify";
import {
  createServiceClient,
  decodeEncryptionKey,
  decryptToken,
  type Json,
} from "@lapsed/db";
import { serverEnv } from "@/app/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SHOPIFY_API_VERSION = "2026-04";
const PAGE_SIZE = 250;

type BackfillResource = "customers" | "orders";

interface BackfillBody {
  resource: BackfillResource;
  cursor?: string;
}

/** Extract `page_info` cursor from Shopify Link header. Returns null when no next page. */
function extractNextCursor(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<[^>]+[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/);
  return match?.[1] ?? null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const env = serverEnv();

  // Authenticate — require the lapsed_session cookie.
  const sessionToken = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifyShopifySessionToken({
    token: sessionToken,
    apiKey: env.shopifyApiKey,
    apiSecret: env.shopifyApiSecret,
  });
  if (!session.ok) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const shopDomain = session.shopDomain;

  let body: BackfillBody;
  try {
    body = (await request.json()) as BackfillBody;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { resource, cursor } = body;
  if (resource !== "customers" && resource !== "orders") {
    return NextResponse.json({ error: "invalid_resource" }, { status: 400 });
  }

  const serviceClient = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });

  // Resolve merchant and decrypt access token.
  const { data: merchant } = await serviceClient
    .from("merchants")
    .select("id,shopify_access_token")
    .eq("shopify_shop_domain", shopDomain)
    .single();

  if (!merchant) {
    return NextResponse.json({ error: "merchant_not_found" }, { status: 404 });
  }

  const encKey = decodeEncryptionKey(env.tokenEncryptionKey);
  // shopify_access_token is stored as bytea (hex-encoded ciphertext).
  const ciphertextHex = (merchant.shopify_access_token as string).replace(/^\\x/, "");
  const accessToken = decryptToken(Buffer.from(ciphertextHex, "hex"), encKey);

  // Build Shopify API URL.
  const baseUrl = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}`;
  let apiUrl: string;

  if (resource === "customers") {
    apiUrl = cursor
      ? `${baseUrl}/customers.json?limit=${PAGE_SIZE}&page_info=${cursor}`
      : `${baseUrl}/customers.json?limit=${PAGE_SIZE}&fields=id,email,phone,first_name,last_name,tags,orders_count,total_spent,created_at,updated_at`;
  } else {
    apiUrl = cursor
      ? `${baseUrl}/orders.json?limit=${PAGE_SIZE}&page_info=${cursor}`
      : `${baseUrl}/orders.json?limit=${PAGE_SIZE}&status=any&fields=id,customer,total_price,financial_status,fulfilled_at,created_at`;
  }

  // Fetch from Shopify — 25 s timeout, well under Vercel's 60 s function limit.
  let shopifyResp: Response;
  try {
    shopifyResp = await fetch(apiUrl, {
      signal: AbortSignal.timeout(25_000),
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    const errName = (err as Error).name;
    const status = errName === "TimeoutError" || errName === "AbortError" ? 504 : 502;
    console.warn(`backfill_fetch_error resource=${resource} err=${(err as Error).message}`);
    return NextResponse.json({ error: "shopify_fetch_failed" }, { status });
  }

  // Rate limit: pass Retry-After back to the caller.
  if (shopifyResp.status === 429) {
    const retryAfter = shopifyResp.headers.get("Retry-After") ?? "2";
    return new NextResponse(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "Retry-After": retryAfter, "Content-Type": "application/json" },
    });
  }

  if (!shopifyResp.ok) {
    console.warn(`backfill_shopify_error resource=${resource} status=${shopifyResp.status}`);
    return NextResponse.json({ error: "shopify_error" }, { status: 502 });
  }

  const data = (await shopifyResp.json()) as Record<string, unknown>;
  const nextCursor = extractNextCursor(shopifyResp.headers.get("Link"));
  const now = new Date().toISOString();

  let count = 0;

  if (resource === "customers") {
    const customers = (data.customers ?? []) as Array<{
      id: number;
      email?: string | null;
      phone?: string | null;
      first_name?: string | null;
      last_name?: string | null;
      tags?: string;
      orders_count?: number;
      total_spent?: string;
      created_at?: string;
    }>;

    for (const customer of customers) {
      if (!customer.id) continue;
      const gid = `gid://shopify/Customer/${customer.id}`;
      const tags = customer.tags
        ? customer.tags.split(",").map((t) => t.trim()).filter(Boolean)
        : [];
      const occurredAt = customer.created_at ?? now;

      await serviceClient.from("customer_events").upsert(
        {
          merchant_id: merchant.id,
          shopify_customer_gid: gid,
          event_type: "customer_backfilled",
          source: "shopify_backfill",
          payload: customer as unknown as Json,
          occurred_at: occurredAt,
        },
        { onConflict: "merchant_id,shopify_customer_gid,event_type,source,occurred_at", ignoreDuplicates: true },
      );

      await serviceClient.from("customers").upsert(
        {
          merchant_id: merchant.id,
          shopify_customer_gid: gid,
          email: customer.email ?? null,
          phone: customer.phone ?? null,
          first_name: customer.first_name ?? null,
          last_name: customer.last_name ?? null,
          tags,
          total_order_count: customer.orders_count ?? 0,
          total_ltv_cents: Math.round(parseFloat(customer.total_spent ?? "0") * 100),
        },
        { onConflict: "merchant_id,shopify_customer_gid" },
      );

      count++;
    }
  } else {
    const orders = (data.orders ?? []) as Array<{
      id: number;
      customer?: { id: number } | null;
      total_price?: string;
      financial_status?: string;
      fulfilled_at?: string | null;
      created_at?: string;
    }>;

    for (const order of orders) {
      if (!order.id || !order.customer?.id) continue;
      const orderGid = `gid://shopify/Order/${order.id}`;
      const customerGid = `gid://shopify/Customer/${order.customer.id}`;
      const occurredAt = order.created_at ?? now;
      const totalCents = Math.round(parseFloat(order.total_price ?? "0") * 100);

      await serviceClient.from("order_events").upsert(
        {
          merchant_id: merchant.id,
          shopify_customer_gid: customerGid,
          shopify_order_gid: orderGid,
          event_type: "order_backfilled",
          source: "shopify_backfill",
          payload: order as unknown as Json,
          occurred_at: occurredAt,
        },
        { onConflict: "merchant_id,shopify_order_gid,event_type,source,occurred_at", ignoreDuplicates: true },
      );

      await serviceClient.from("orders").upsert(
        {
          merchant_id: merchant.id,
          shopify_order_gid: orderGid,
          shopify_customer_gid: customerGid,
          total_price_cents: totalCents,
          financial_status: order.financial_status ?? "paid",
          fulfilled_at: order.fulfilled_at ?? null,
          shopify_created_at: occurredAt,
        },
        { onConflict: "merchant_id,shopify_order_gid" },
      );

      count++;
    }
  }

  // Update last_backfill_at timestamp on the merchant row.
  await serviceClient
    .from("merchants")
    .update({ last_backfill_at: now })
    .eq("id", merchant.id);

  return NextResponse.json({ nextCursor, count });
}
