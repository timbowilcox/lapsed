import { Button } from "@lapsed/ui";
import { Send, BarChart3, MessageCircle, ShoppingBag } from "lucide-react";

const features = [
  {
    icon: BarChart3,
    title: "Cadence, not guesses",
    body: "We compute each shop's actual purchase cadence — so lapsed means lapsed for your customers, not a generic 60-day threshold.",
  },
  {
    icon: MessageCircle,
    title: "Two-way AI SMS",
    body: "Real conversations, not broadcast campaigns. The AI uses your product catalogue, your brand voice, and stops when a customer says stop.",
  },
  {
    icon: Send,
    title: "Revenue attribution",
    body: "Every recovered order reconciled against Shopify. You only celebrate revenue that actually came back.",
  },
];

export default function MarketingPage() {
  return (
    <div className="min-h-screen bg-cream-100">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-[1180px] items-center justify-between px-32 py-20">
          <div className="text-h1 font-bold tracking-[-0.04em] text-ink-900">lapsed.</div>
          <nav className="flex items-center gap-24">
            <a href="#features" className="text-meta text-ink-700 hover:text-ink-900">
              Features
            </a>
            <a href="#pricing" className="text-meta text-ink-700 hover:text-ink-900">
              Pricing
            </a>
            <Button asChild size="sm">
              <a href="/app/auth/install">
                <ShoppingBag strokeWidth={1.75} size={14} /> Install
              </a>
            </Button>
          </nav>
        </div>
      </header>

      <section className="mx-auto max-w-[1180px] px-32 py-64 text-center">
        <div className="inline-flex items-center gap-8 rounded-pill bg-lavender-100 px-12 py-6 text-mini font-semibold uppercase tracking-wide text-lavender-700">
          <span className="h-7 w-7 rounded-pill bg-lavender-500" aria-hidden="true" />
          For Shopify ecommerce brands
        </div>
        <h1 className="mx-auto mt-24 max-w-[840px] font-serif text-[64px] leading-[1.05] tracking-[-0.025em] text-ink-900">
          Recover the customers you already paid for.
        </h1>
        <p className="mx-auto mt-20 max-w-[620px] text-h3 font-normal leading-[1.5] text-ink-500">
          lapsed.ai identifies dormant Shopify customers, scores their reactivation likelihood, and
          wins them back with two-way AI SMS conversations — attributed cleanly against your real
          orders.
        </p>
        <div className="mt-32 flex items-center justify-center gap-12">
          <Button asChild size="lg">
            <a href="/app/auth/install">
              <ShoppingBag strokeWidth={1.75} size={18} /> Install on Shopify
            </a>
          </Button>
          <Button asChild variant="secondary" size="lg">
            <a href="/app">Preview the dashboard</a>
          </Button>
        </div>
      </section>

      <section id="features" className="mx-auto max-w-[1180px] px-32 pb-64">
        <div className="grid grid-cols-3 gap-16">
          {features.map((f) => {
            const IconComp = f.icon;
            return (
              <article
                key={f.title}
                className="rounded-lg border border-border bg-cream-50 p-32"
              >
                <div className="mb-16 flex h-48 w-48 items-center justify-center rounded-md bg-lavender-100 text-lavender-700">
                  <IconComp strokeWidth={1.75} size={22} />
                </div>
                <h3 className="mb-8 text-h2 text-ink-900">{f.title}</h3>
                <p className="text-body text-ink-500">{f.body}</p>
              </article>
            );
          })}
        </div>
      </section>

      <section id="pricing" className="border-t border-border bg-cream-50">
        <div className="mx-auto max-w-[1180px] px-32 py-64 text-center">
          <h2 className="text-h1 text-ink-900">Pricing that scales with results</h2>
          <p className="mx-auto mt-12 max-w-[520px] text-meta text-ink-500">
            Three flat plans for sending volume. A 3% performance kicker on restored revenue
            above the tier baseline arrives in v2.
          </p>
          <div className="mx-auto mt-32 grid max-w-[820px] grid-cols-3 gap-16">
            {[
              { label: "Starter", price: 299, quota: "5,000 SMS / mo" },
              { label: "Growth", price: 799, quota: "25,000 SMS / mo" },
              { label: "Scale", price: 1999, quota: "100,000 SMS / mo" },
            ].map((tier) => (
              <div key={tier.label} className="rounded-lg border border-border bg-cream-100 p-24">
                <div className="text-body-strong text-ink-900">{tier.label}</div>
                <div className="mt-12 text-display tabular-nums text-ink-900">
                  ${tier.price}
                  <span className="ml-2 text-meta font-normal text-ink-500">/ mo</span>
                </div>
                <div className="mt-4 text-mini text-ink-500">{tier.quota}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-[1180px] items-center justify-between px-32 py-24 text-mini text-ink-500">
          <span>© 2026 lapsed.ai · Built for Shopify ecommerce brands</span>
          <span>Mac Farms Pty Ltd</span>
        </div>
      </footer>
    </div>
  );
}
