import { Card } from "@lapsed/ui";
import { DemoShell } from "../_components/demo-shell";
import { demoFixtures } from "@lapsed/core/demo-fixtures";

const planDetails: Record<string, { features: string[]; quota: string }> = {
  starter: {
    features: ["5,000 SMS / month", "AI conversation engine", "Revenue attribution", "Campaign review"],
    quota: "5k msgs",
  },
  growth: {
    features: ["25,000 SMS / month", "AI conversation engine", "Revenue attribution", "Campaign review", "Priority support"],
    quota: "25k msgs",
  },
  scale: {
    features: ["100,000 SMS / month", "AI conversation engine", "Revenue attribution", "Campaign review", "Priority support", "Dedicated success manager"],
    quota: "100k msgs",
  },
};

export default function DemoBillingPage() {
  const { billing } = demoFixtures;
  const details = planDetails[billing.currentPlan] ?? planDetails.growth!;
  const usagePct = Math.round((billing.monthlyMessagesUsed / billing.monthlyMessageQuota) * 100);

  return (
    <DemoShell>
      <div className="mb-24">
        <h1 className="mb-4 text-h1 text-ink-900">Billing</h1>
        <p className="text-meta text-ink-500">
          Your current plan and usage. Payment is handled securely by Stripe — card details are
          never stored by lapsed.ai.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-16">
        <Card className="p-32">
          <div className="mb-16">
            <div className="mb-4 text-label text-ink-500">Current plan</div>
            <div className="text-h2 text-ink-900">{billing.currentPlanLabel}</div>
            <div className="mt-4 font-serif text-[40px] leading-none tabular-nums text-ink-900">
              ${billing.currentPlanPrice.toLocaleString("en-US")}
              <span className="ml-4 text-meta font-sans font-normal text-ink-500">/ month</span>
            </div>
          </div>

          <ul className="mb-20 flex flex-col gap-8">
            {details.features.map((f) => (
              <li key={f} className="flex items-center gap-8 text-meta text-ink-700">
                <span className="h-6 w-6 rounded-pill bg-success-500" aria-hidden="true" />
                {f}
              </li>
            ))}
          </ul>

          <div className="text-mini text-ink-500">
            Renews{" "}
            {new Date(billing.renewsAt).toLocaleDateString("en-AU", {
              day: "numeric",
              month: "long",
              year: "numeric",
            })}{" "}
            · Visa ending {billing.paymentMethodLast4}
          </div>
        </Card>

        <Card className="p-32">
          <div className="mb-16">
            <div className="mb-8 text-label text-ink-500">Monthly usage</div>
            <div className="mb-4 flex items-end justify-between">
              <span className="text-display tabular-nums text-ink-900">
                {billing.monthlyMessagesUsed.toLocaleString("en-US")}
              </span>
              <span className="text-meta text-ink-500">
                of {billing.monthlyMessageQuota.toLocaleString("en-US")} msgs
              </span>
            </div>
            <div className="h-8 overflow-hidden rounded-pill bg-cream-300">
              <div
                className="h-full rounded-pill bg-lavender-700 transition-all"
                style={{ width: `${usagePct}%` }}
                role="progressbar"
                aria-valuenow={usagePct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${usagePct}% of monthly message quota used`}
              />
            </div>
            <div className="mt-8 text-mini text-ink-500">{usagePct}% used this period</div>
          </div>
        </Card>
      </div>
    </DemoShell>
  );
}
