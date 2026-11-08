// Small pieces the campaign pages share: the state a campaign is shown in, and how a decision reads.
import { StatusBadge, type Tone } from "@openasy/ui";
import type { Campaign } from "./api.ts";
import type { T } from "./i18n.ts";

/** What a campaign is shown as: a planned campaign whose approvers have not all approved is waiting for approval. */
export type Shown = "planned" | "approval" | "live" | "ended" | "cancelled";
export const shownOf = (c: Pick<Campaign, "status" | "approved" | "approvals">): Shown =>
  c.status === "planned" && c.approvals.length && !c.approved ? "approval" : c.status;

export const TONE: Record<Shown, Tone> = { planned: "info", approval: "warning", live: "success", ended: "neutral", cancelled: "neutral" };

export function StateBadge({ c, t }: { c: Pick<Campaign, "status" | "approved" | "approvals">; t: T }) {
  const s = shownOf(c);
  return <StatusBadge tone={TONE[s]}>{t(`state.${s}`)}</StatusBadge>;
}

/** The background of a campaign's bar in the calendar. */
export const BAR: Record<Shown, string> = {
  planned: "bg-accent-soft text-accent-text",
  approval: "bg-warning-soft text-fg",
  live: "bg-success-soft text-fg",
  ended: "bg-subtle text-fg",
  cancelled: "bg-subtle text-fg-muted",
};
