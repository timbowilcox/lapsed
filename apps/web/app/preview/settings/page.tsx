import { Card } from "@lapsed/ui";
import { DemoShell } from "../_components/demo-shell";
import { demoFixtures } from "@lapsed/core/demo-fixtures";

export default function DemoSettingsPage() {
  const { merchant } = demoFixtures;

  return (
    <DemoShell>
      <div className="mb-24">
        <h1 className="mb-4 text-h1 text-ink-900">Settings</h1>
        <p className="text-meta text-ink-500">
          Manage your brand voice, opt-out behaviour, and integrations.
        </p>
      </div>

      <div className="flex flex-col gap-16">
        <Card className="p-32">
          <h2 className="mb-16 text-h2 text-ink-900">Brand voice</h2>
          <p className="mb-12 text-meta text-ink-500">
            The agent uses this voice profile when drafting outbound messages and replies.
          </p>
          <div className="rounded-md border border-border bg-cream-100 px-16 py-14 text-body text-ink-700">
            {merchant.brandVoice}
          </div>
          <div className="mt-12 flex gap-8">
            <button
              type="button"
              className="rounded-sm bg-ink-900 px-14 py-8 text-mini font-semibold text-cream-50 transition-colors hover:opacity-80 focus-visible:outline-none focus-visible:shadow-focus"
            >
              Extract brand voice
            </button>
            <button
              type="button"
              className="rounded-sm border border-cream-300 px-14 py-8 text-mini font-medium text-ink-700 transition-colors hover:bg-cream-200 focus-visible:outline-none focus-visible:shadow-focus"
            >
              Edit
            </button>
          </div>
        </Card>

        <Card className="p-32">
          <h2 className="mb-16 text-h2 text-ink-900">Shop</h2>
          <div className="flex flex-col gap-12">
            <div>
              <label className="mb-4 block text-label font-medium text-ink-700">Shop name</label>
              <div className="rounded-sm border border-cream-300 bg-cream-50 px-12 py-10 text-body text-ink-900">
                {merchant.shopName}
              </div>
            </div>
            <div>
              <label className="mb-4 block text-label font-medium text-ink-700">Shop domain</label>
              <div className="rounded-sm border border-cream-300 bg-cream-50 px-12 py-10 text-body text-ink-500">
                {merchant.shopDomain}
              </div>
            </div>
          </div>
        </Card>

        <Card className="p-32">
          <h2 className="mb-16 text-h2 text-ink-900">Opt-out keywords</h2>
          <p className="mb-12 text-meta text-ink-500">
            When a customer sends any of these keywords, they are immediately unsubscribed from all
            future messages.
          </p>
          <div className="flex flex-wrap gap-8">
            {merchant.optOutKeywords.map((kw) => (
              <span
                key={kw}
                className="inline-flex items-center rounded-pill bg-cream-200 px-10 py-4 text-mini font-medium text-ink-700"
              >
                {kw}
              </span>
            ))}
          </div>
        </Card>

        <Card className="p-32">
          <h2 className="mb-16 text-h2 text-ink-900">Integrations</h2>
          <div className="flex flex-col gap-12">
            <div className="flex items-center justify-between rounded-md border border-border bg-cream-100 px-16 py-14">
              <div>
                <div className="text-body-strong text-ink-900">Shopify</div>
                <div className="text-mini text-ink-500">{merchant.shopDomain}</div>
              </div>
              <span className="inline-flex items-center gap-6 rounded-pill bg-success-100 px-10 py-4 text-mini font-medium text-ink-900">
                <span className="h-6 w-6 rounded-pill bg-success-500" aria-hidden="true" />
                Connected
              </span>
            </div>
            <div className="flex items-center justify-between rounded-md border border-border bg-cream-100 px-16 py-14">
              <div>
                <div className="text-body-strong text-ink-900">Twilio SMS</div>
                <div className="text-mini text-ink-500">
                  SMS sending activates with your first campaign.
                </div>
              </div>
              <span className="inline-flex items-center rounded-pill bg-cream-200 px-10 py-4 text-mini font-medium text-ink-500">
                Not yet active
              </span>
            </div>
          </div>
        </Card>
      </div>
    </DemoShell>
  );
}
