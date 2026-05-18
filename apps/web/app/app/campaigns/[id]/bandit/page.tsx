// Bandit-state inspector (Sprint 06, chunk 11). A per-proposal, read-only view
// of the Thompson-sampling arms initialized for an approved campaign. It exists
// to make architectural decision 4 legible to the merchant: the bandit state is
// first-class data, so the merchant can see the posterior math — α/β, the mean
// response rate, the 95% credible interval — not a marketing number.
//
// Observation counts are always 0 in Sprint 06: no campaign has run yet. Sprint
// 07's conversation engine populates observations and updates posteriors.

import Link from "next/link";
import { notFound } from "next/navigation";
import { Panel, Table, TableHeader, TableBody, TableRow, TableHead, TableCell, Tag, formatDate } from "@lapsed/ui";
import { mintMerchantJwt, createMerchantClient, getProposalById } from "@lapsed/db";
import type { ProposalVariant, BanditArmState } from "@lapsed/db";
import { posteriorStats } from "@lapsed/core";
import { requireMerchant } from "@/app/lib/session";
import { serverEnv } from "@/app/lib/env";
import { MerchantShell } from "../../../_components/merchant-shell";
import { groupLabel, offerTypeLabel, sendWindowLabel, toneLabel } from "../../_labels";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The stat columns rendered per arm (everything after the Variant column). The
// "no posterior state" fallback cell spans exactly these.
const STAT_COLUMN_COUNT = 6;

// Prose form of a proposal status for the non-approved empty state — keeps the
// raw enum out of merchant-facing copy.
const STATUS_PROSE: Record<string, string> = {
  proposed: "still pending review",
  approved: "approved",
  rejected: "rejected",
  edited: "a superseded version",
};

/**
 * Formats a 0–1 probability as a percentage with one decimal place, e.g.
 * 0.5 → "50.0%". One decimal keeps low response rates (a few percent, typical
 * for SMS) legible once Sprint 07 posteriors replace the Beta(1,1) priors —
 * whole-number rounding would collapse them to "0%".
 */
function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export default async function BanditInspectorPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();

  const merchant = await requireMerchant({ searchParams: await searchParams });
  const env = serverEnv();
  const jwt = await mintMerchantJwt({
    shopDomain: merchant.shopDomain,
    jwtSecret: env.supabaseJwtSecret,
  });
  const client = createMerchantClient({
    url: env.supabaseUrl,
    publishableKey: env.supabasePublishableKey,
    merchantJwt: jwt,
  });

  // A cross-merchant id resolves to null — answer 404 without leaking existence.
  const proposal = await getProposalById(client, merchant.id, id);
  if (!proposal) return notFound();

  const banditByArm = new Map<string, BanditArmState>(
    proposal.banditState.map((b) => [b.armId, b]),
  );

  return (
    <MerchantShell pageTitle="Campaign variants">
      <div className="mb-24">
        <Link
          href="/app/campaigns/list"
          className="text-meta text-ink-500 transition-colors hover:text-ink-900 focus-visible:outline-none focus-visible:shadow-focus"
        >
          ← All campaigns
        </Link>
        <h1 className="mb-4 mt-8 text-h1 text-ink-900">
          {groupLabel(proposal.groupSlug)} — variant performance
        </h1>
        <p className="text-meta text-ink-500">
          Version {proposal.versionNumber} · {proposal.variants.length} variants. Each variant
          tracks its response rate over time. The agent automatically favours variants that
          customers are responding to, so better-performing message options are sent more often.
        </p>
      </div>

      {proposal.status === "approved" ? (
        <ArmTable variants={proposal.variants} banditByArm={banditByArm} />
      ) : (
        <Panel>
          <p className="px-16 py-40 text-center text-meta text-ink-500">
            Variant tracking begins when the campaign is approved. This proposal is{" "}
            {STATUS_PROSE[proposal.status] ?? proposal.status} — no tracking data exists yet.
          </p>
        </Panel>
      )}
    </MerchantShell>
  );
}

function ArmTable({
  variants,
  banditByArm,
}: {
  variants: ProposalVariant[];
  banditByArm: Map<string, BanditArmState>;
}) {
  const ordered = [...variants].sort((a, b) => a.variantIndex - b.variantIndex);

  return (
    <Panel>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Variant</TableHead>
            <TableHead className="text-right">α</TableHead>
            <TableHead className="text-right">β</TableHead>
            <TableHead className="text-right">Mean response rate</TableHead>
            <TableHead className="text-right">95% credible interval</TableHead>
            <TableHead className="text-right">Observations</TableHead>
            <TableHead>Last updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ordered.map((variant) => {
            const state = banditByArm.get(variant.banditArmId);
            return (
              <TableRow key={variant.armId}>
                <TableCell>
                  <div className="flex items-center gap-8">
                    <span className="text-ink-900">
                      Variant {variant.variantIndex + 1}
                    </span>
                    <Tag tone="active">{offerTypeLabel(variant.offerType)}</Tag>
                  </div>
                  <div className="mt-2 text-mini text-ink-500">
                    {sendWindowLabel(variant.sendTimeWindow)} · {toneLabel(variant.tone)} tone
                  </div>
                </TableCell>
                {state ? (
                  <ArmStats state={state} />
                ) : (
                  <TableCell colSpan={STAT_COLUMN_COUNT} className="text-meta text-ink-500">
                    No data yet — tracking begins when the first message is sent.
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Panel>
  );
}

function ArmStats({ state }: { state: BanditArmState }) {
  const stats = posteriorStats(state.alpha, state.beta);
  return (
    <>
      <TableCell className="text-right">{state.alpha}</TableCell>
      <TableCell className="text-right">{state.beta}</TableCell>
      <TableCell className="text-right">{pct(stats.mean)}</TableCell>
      <TableCell className="text-right">
        {pct(stats.ciLower)}–{pct(stats.ciUpper)}
      </TableCell>
      <TableCell className="text-right">{state.observationCount}</TableCell>
      <TableCell className="text-ink-500">
        {formatDate(state.lastUpdatedAt, "short")}
      </TableCell>
    </>
  );
}
