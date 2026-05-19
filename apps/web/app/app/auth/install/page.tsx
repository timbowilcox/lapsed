import { Card, Tag } from "@lapsed/ui";
import { Lock, BarChart3 } from "lucide-react";
import { InstallButton } from "./_install-button";

const requiredScopes = [
  { scope: "read_customers", description: "Identify lapsed customers from your customer list" },
  { scope: "read_orders", description: "Compute your shop's actual purchase cadence" },
  { scope: "read_products", description: "Give the AI accurate product context" },
  { scope: "write_discounts", description: "Create discount codes for win-back offers" },
  { scope: "write_pixels", description: "Track attribution on checkout" },
];

const optionalScopes = [
  "read_inventory",
  "read_checkouts",
  "write_draft_orders",
  "read_locations",
  "read_price_rules",
];

// This page is reached two ways:
//   1. As a redirect from the root entry (/) when the merchant is missing
//      — at that point the page renders inside the Shopify Admin iframe.
//   2. As a direct visit (someone typed the URL or followed a link).
//
// In either case we render the full install screen and require the user
// to click "Install on Shopify". The click is the user gesture browsers
// need to allow `window.top.location.href` to navigate from a cross-origin
// iframe to the OAuth endpoint top-level. Previous iterations tried a
// server-side or `useEffect` auto-redirect to /api/shopify/install — both
// were broken: server-side redirect inside the iframe sets the OAuth state
// cookie as a third-party cookie (Chrome drops it), and useEffect-driven
// top navigation is blocked by Chrome's user-gesture requirement.
//
// The install button's client-side handler (see _install-button.tsx) does
// the correct top-window break-out on click.

export default function InstallPage() {
  return (
    <div className="min-h-screen bg-cream-100">
      <header className="border-b border-border px-32 py-16">
        <div className="text-h1 font-bold tracking-[-0.04em] text-ink-900">lapsed.</div>
      </header>

      <main className="mx-auto max-w-[720px] px-32 py-48">
        <div className="mb-32 text-center">
          <h1 className="text-h1 text-ink-900">Install lapsed on your Shopify store</h1>
          <p className="mt-8 text-meta text-ink-500">
            Recover dormant customers automatically. Pay only when revenue comes back.
          </p>
        </div>

        <Card className="mb-24 p-32">
          <div className="mb-16 flex items-center gap-12">
            <div className="flex h-40 w-40 items-center justify-center rounded-md bg-lavender-50 text-lavender-700">
              <Lock strokeWidth={1.75} size={20} />
            </div>
            <div className="text-h3 text-ink-900">Required permissions</div>
          </div>
          <p className="mb-16 text-meta text-ink-500">
            These scopes are needed at install. We keep this list short to maximise install
            conversion.
          </p>
          <ul className="flex flex-col gap-12">
            {requiredScopes.map((s) => (
              <li
                key={s.scope}
                className="flex items-start gap-12 rounded-sm border border-border bg-cream-100 p-12"
              >
                <code className="rounded-sm bg-cream-200 px-6 py-2 text-mini text-ink-900">
                  {s.scope}
                </code>
                <span className="text-meta text-ink-700">{s.description}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="mb-32 p-32">
          <div className="mb-16 flex items-center gap-12">
            <div className="flex h-40 w-40 items-center justify-center rounded-md bg-lavender-50 text-lavender-700">
              <BarChart3 strokeWidth={1.75} size={20} />
            </div>
            <div className="text-h3 text-ink-900">Optional permissions</div>
          </div>
          <p className="mb-16 text-meta text-ink-500">
            We&apos;ll request these only when a feature first needs them — never at install.
          </p>
          <div className="flex flex-wrap gap-8">
            {optionalScopes.map((s) => (
              <Tag key={s} tone="stalled">
                {s}
              </Tag>
            ))}
          </div>
        </Card>

        <div className="flex flex-col items-center gap-12">
          <InstallButton />
          <p className="text-meta text-ink-400">
            Not coming from Shopify Admin?{" "}
            <a
              href="https://apps.shopify.com/lapsed"
              target="_blank"
              rel="noopener noreferrer"
              className="text-ink-700 underline underline-offset-2 hover:text-ink-900 focus-visible:outline-none focus-visible:shadow-focus"
            >
              Find lapsed in the Shopify App Store
            </a>
          </p>
        </div>

        {/* How to install guidance — for visitors arriving without Shopify Admin context */}
        <details className="mt-16 w-full max-w-[480px] rounded-lg border border-border bg-cream-50">
          <summary className="cursor-pointer select-none px-20 py-14 text-body-strong text-ink-900 hover:bg-cream-100 focus-visible:outline-none focus-visible:shadow-focus">
            How to install from the App Store
          </summary>
          <div className="border-t border-border px-20 py-16">
            <ol className="flex flex-col gap-10 text-meta text-ink-700">
              <li>1. Visit the{" "}
                <a
                  href="https://apps.shopify.com/lapsed"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-ink-900 underline underline-offset-2 hover:text-ink-700"
                >
                  Shopify App Store listing for lapsed
                </a>
              </li>
              <li>2. Click <strong className="font-medium text-ink-900">Add app</strong> on the listing page</li>
              <li>3. You&apos;ll be redirected to your Shopify Admin to review permissions</li>
              <li>4. Click <strong className="font-medium text-ink-900">Install</strong> to grant the required permissions and connect your store</li>
            </ol>
          </div>
        </details>
      </main>
    </div>
  );
}
