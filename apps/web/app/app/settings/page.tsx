import {
  Button,
  Input,
  Panel,
  PanelHeader,
  PanelBody,
  Tag,
  Card,
} from "@lapsed/ui";
import { merchant } from "@lapsed/fixtures";
import { MerchantShell } from "../_components/merchant-shell";

export default function SettingsPage() {
  return (
    <MerchantShell pageTitle="Settings">
      <div className="mb-24">
        <h2 className="mb-4 text-h1 text-ink-900">Settings</h2>
        <p className="text-meta text-ink-500">
          Shop details, brand voice, opt-out keywords and integration status.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-16">
        <Panel>
          <PanelHeader title="Shop" />
          <PanelBody>
            <div className="flex flex-col gap-16 p-24">
              <label className="flex flex-col gap-6">
                <span className="text-label text-ink-700">Shop domain</span>
                <Input defaultValue={merchant.shopDomain} readOnly />
              </label>
              <label className="flex flex-col gap-6">
                <span className="text-label text-ink-700">Shop name</span>
                <Input defaultValue={merchant.shopName} />
              </label>
              <label className="flex flex-col gap-6">
                <span className="text-label text-ink-700">Owner</span>
                <Input defaultValue={merchant.ownerName} />
              </label>
            </div>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader title="Brand voice" />
          <PanelBody>
            <div className="flex flex-col gap-12 p-24">
              <p className="text-meta text-ink-500">
                Used by the conversation engine to keep AI replies on-brand.
              </p>
              <textarea
                defaultValue={merchant.brandVoice}
                rows={4}
                className="rounded-sm border border-cream-300 bg-cream-50 p-12 text-body text-ink-900 focus-visible:outline-none focus-visible:shadow-focus"
              />
              <Button variant="secondary" className="self-start">
                Save brand voice
              </Button>
            </div>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader title="Opt-out keywords" />
          <PanelBody>
            <div className="flex flex-col gap-12 p-24">
              <p className="text-meta text-ink-500">
                Any inbound SMS matching these (case-insensitive) opts the customer out
                immediately. STOP and STOPALL are reserved by Twilio.
              </p>
              <div className="flex flex-wrap gap-8">
                {merchant.optOutKeywords.map((k) => (
                  <Tag key={k} tone="stalled">
                    {k}
                  </Tag>
                ))}
              </div>
            </div>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader title="Integrations" />
          <PanelBody>
            <div className="flex flex-col gap-12 p-24">
              <Card className="flex items-center justify-between p-16">
                <div>
                  <div className="text-body-strong text-ink-900">Shopify</div>
                  <div className="text-mini text-ink-500">
                    Installed · syncs orders, customers, products
                  </div>
                </div>
                <Tag tone="converted">Connected</Tag>
              </Card>
              <Card className="flex items-center justify-between p-16">
                <div>
                  <div className="text-body-strong text-ink-900">Twilio</div>
                  <div className="text-mini text-ink-500">
                    Pending — connects in Sprint 05
                  </div>
                </div>
                <Tag tone="stalled">Pending</Tag>
              </Card>
              <Card className="flex items-center justify-between p-16">
                <div>
                  <div className="text-body-strong text-ink-900">Stripe</div>
                  <div className="text-mini text-ink-500">
                    Pending — connects in Sprint 06
                  </div>
                </div>
                <Tag tone="stalled">Pending</Tag>
              </Card>
            </div>
          </PanelBody>
        </Panel>
      </div>
    </MerchantShell>
  );
}
