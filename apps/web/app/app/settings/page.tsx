import { Suspense } from "react";
import {
  Input,
  Panel,
  PanelHeader,
  PanelBody,
  Tag,
  Card,
} from "@lapsed/ui";
import { requireMerchant } from "@/app/lib/session";
import { MerchantShell } from "../_components/merchant-shell";
import { SettingsSyncStatus, SettingsSyncStatusSkeleton } from "../_settings-sync-status";
import { BrandVoiceSettings } from "./_brand-voice-settings";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SettingsPage({ searchParams }: PageProps) {
  const merchant = await requireMerchant({ searchParams: await searchParams });

  return (
    <MerchantShell pageTitle="Settings">
      <div className="mb-24">
        <h2 className="mb-4 text-h1 text-ink-900">Settings</h2>
        <p className="text-meta text-ink-500">
          Shop details, brand voice, opt-out keywords and integration status.
        </p>
      </div>

      <Panel className="mb-16">
        <PanelHeader title="Brand voice" />
        <PanelBody>
          <BrandVoiceSettings />
        </PanelBody>
      </Panel>

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
                {/* shopName is derived from domain handle — Shopify API fetch wired in a later sprint */}
                <Input defaultValue={merchant.shopName} readOnly />
              </label>
              <Suspense fallback={<SettingsSyncStatusSkeleton />}>
                <SettingsSyncStatus merchantId={merchant.id} />
              </Suspense>
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
                <Tag tone="stalled">STOP</Tag>
                <Tag tone="stalled">STOPALL</Tag>
              </div>
              <p className="mt-8 text-mini text-ink-500">
                Additional opt-out keywords can be configured here once messaging is active.
              </p>
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
                  <div className="text-mini text-ink-500">SMS sending activates with your first campaign.</div>
                </div>
                <Tag tone="stalled">Pending</Tag>
              </Card>
              <Card className="flex items-center justify-between p-16">
                <div>
                  <div className="text-body-strong text-ink-900">Stripe</div>
                  <div className="text-mini text-ink-500">Billing activates when you select a subscription plan.</div>
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
