// Campaigns: the list, a new campaign, and one campaign with its brief and tasks, budget, links and results.
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Checkbox,
  DataTable,
  Dialog,
  EmptyState,
  KpiCard,
  KpiGrid,
  navigate,
  PageHeader,
  Panel,
  SegmentedControl,
  SelectField,
  StatusBadge,
  Tabs,
  TextField,
  useLocalePreference,
  type Column,
} from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { ArrowLeft, Ban, Check, Flag, Pencil, Plus, RefreshCw, Rocket, Trash2, Upload } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Ctx } from "./App.tsx";
import type { AdsRead, Campaign, CampaignDetail, Metric, Naming, Spend, SpendImported, SpendList } from "./api.ts";
import { day, money, Notice, num, pct, roiText, useLoad, when } from "./common.tsx";
import { useT, type T } from "./i18n.ts";
import { LinkBuilder, LinksTable } from "./links.tsx";
import { shownOf, StateBadge, type Shown } from "./parts.tsx";
import { ResultsTab } from "./results.tsx";

export const TABS = ["brief", "budget", "links", "results"] as const;
export type Tab = (typeof TABS)[number];
const METRICS: Metric[] = ["visits", "conversions", "sends", "opens", "clicks", "deals", "revenue"];

/** A body sent as JSON, with the answer or the problem's words. */
async function send<R>(ctx: Pick<Ctx, "call">, path: string, method: string, body?: unknown): Promise<R> {
  return ctx.call<R>(path, { method, ...(body !== undefined && { body: JSON.stringify(body) }) });
}

/** "120,000", "120.000" or "120000,50" as a number. */
function amountOf(s: string): number | null {
  const v = s.replace(/\s|TL/gi, "");
  if (!v) return null;
  const n = Number(/,\d{1,2}$/.test(v) ? v.replace(/\./g, "").replace(",", ".") : v.replace(/[.,](?=\d{3}(\D|$))/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ---------------------------------------------------------------- list

export function CampaignsPage(ctx: Ctx) {
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const [list, reload] = useLoad<{ campaigns: Campaign[] }>(ctx.call, "/api/v1/campaigns");
  const [report] = useLoad<{
    campaigns: Array<{ id: string; first: { deals: number }; last: { deals: number; revenue: number; roi: number | null }; visits: number }>;
  }>(ctx.call, "/api/v1/report?from=2000-01-01&to=2100-12-31");
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState<"all" | Shown>("all");
  const tl = (n: number) => money(n, ctx.settings.config.currency, locale);
  const results = new Map((report?.campaigns ?? []).map((r) => [r.id, r]));
  const rows = (list?.campaigns ?? []).filter((c) => shown === "all" || shownOf(c) === shown);
  const cols: Column<Campaign>[] = [
    {
      id: "name",
      header: t("campaigns.campaign"),
      width: "26%",
      sortValue: (c) => c.name,
      cell: (c) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{c.name}</span>
          <span className="truncate font-mono text-2xs text-fg-muted">{c.utm}</span>
        </span>
      ),
    },
    { id: "state", header: t("campaigns.state"), cell: (c) => <StateBadge c={c} t={t} /> },
    {
      id: "dates",
      header: t("campaigns.dates"),
      sortValue: (c) => c.start,
      cell: (c) => <span className="text-xs whitespace-nowrap">{t("common.span", { from: day(c.start, locale), to: day(c.end, locale) })}</span>,
    },
    {
      id: "owner",
      header: t("common.owner"),
      cell: (c) =>
        c.owner ? (
          <span className="flex items-center gap-1.5">
            <Avatar name={c.owner.name} size="sm" />
            <span className="truncate text-xs">{c.owner.name}</span>
          </span>
        ) : (
          <span className="text-xs text-fg-muted">{t("common.nobody")}</span>
        ),
    },
    { id: "budget", header: t("campaigns.budget"), align: "right", mono: true, sortValue: (c) => c.budget, cell: (c) => tl(c.budget) },
    { id: "spent", header: t("campaigns.spent"), align: "right", mono: true, sortValue: (c) => c.spend, cell: (c) => (c.spend ? tl(c.spend) : "–") },
    {
      id: "won",
      header: t("campaigns.wonFirstLast"),
      align: "right",
      mono: true,
      cell: (c) => {
        const r = results.get(c.id);
        return r && (r.first.deals || r.last.deals) ? `${r.first.deals} / ${r.last.deals}` : "–";
      },
    },
    {
      id: "roi",
      header: t("campaigns.roiLast"),
      description: t("campaigns.roiDetail"),
      align: "right",
      mono: true,
      cell: (c) => {
        const r = results.get(c.id);
        return r && (r.last.deals || c.spend) ? roiText(r.last.roi) : "–";
      },
    },
  ];
  return (
    <>
      <PageHeader
        title={t("campaigns.title")}
        description={t("campaigns.description")}
        actions={
          can("editor") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
              {t("campaigns.new")}
            </Button>
          )
        }
      />
      <Panel flush className="mt-2.5">
        <div className="px-3 py-2">
          <SegmentedControl
            label={t("campaigns.state")}
            value={shown}
            onChange={setShown}
            options={[
              { value: "all", label: t("campaigns.all") },
              { value: "planned", label: t("state.planned") },
              { value: "approval", label: t("campaigns.waiting") },
              { value: "live", label: t("state.live") },
              { value: "ended", label: t("state.ended") },
              { value: "cancelled", label: t("state.cancelled") },
            ]}
          />
        </div>
        <div className="border-t border-line">
          {list === null ? (
            <EmptyState title={t("common.failed")} />
          ) : (
            <DataTable
              label={t("campaigns.title")}
              columns={cols}
              rows={rows}
              getRowId={(c) => c.id}
              onRowClick={(c) => navigate(`/campaigns/${c.id}`)}
              minWidth={960}
              loading={list === undefined}
              empty={<p className="px-3 py-3 text-sm text-fg-muted">{t("campaigns.none")}</p>}
            />
          )}
        </div>
      </Panel>
      {creating && (
        <CampaignDialog
          ctx={ctx}
          onClose={() => setCreating(false)}
          onSaved={(c) => {
            reload();
            ctx.onChanged();
            navigate(`/campaigns/${c.id}`);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- new and edit

function CampaignDialog({ ctx, c, onClose, onSaved }: { ctx: Ctx; c?: CampaignDetail; onClose: () => void; onSaved: (c: CampaignDetail) => void }) {
  const t = useT();
  const { me } = useAuth();
  const cfg = ctx.settings.config;
  const [name, setName] = useState(c?.name ?? "");
  const [utm, setUtm] = useState<string | null>(c ? c.utm : null);
  const [start, setStart] = useState(c?.start ?? ctx.summary?.today ?? "");
  const [end, setEnd] = useState(c?.end ?? ctx.summary?.today ?? "");
  const [owner, setOwner] = useState(c ? (c.owner?.id ?? "") : me.user.id);
  const [message, setMessage] = useState(c?.message ?? "");
  const [audience, setAudience] = useState(c?.audience ?? "");
  const [brief, setBrief] = useState(c?.brief ?? "");
  const [budget, setBudget] = useState(c ? String(c.budget) : "");
  const [channels, setChannels] = useState<Record<string, string>>(Object.fromEntries((c?.channels ?? []).map((ch) => [ch.id, String(ch.budget || "")])));
  const [goals, setGoals] = useState<Array<{ metric: Metric; target: string; goal: string }>>(
    (c?.goals ?? []).map((g) => ({ metric: g.metric, target: String(g.target), goal: g.goal ?? "" })),
  );
  const defaultApprovers = ctx.members.filter((m) => cfg.approvers.includes(m.email.toLowerCase())).map((m) => m.email.toLowerCase());
  const [approvers, setApprovers] = useState<string[]>(c ? c.approvals.map((a) => a.email) : defaultApprovers);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [naming] = useLoad<Naming>(ctx.call, !c && name.trim() && start ? `/api/v1/naming?${new URLSearchParams({ name: name.trim(), start })}` : null);
  const locked = !!c && (c.status !== "planned" || c.counts.links > 0);
  const value = utm ?? (name.trim() ? (naming?.utm ?? "") : "");
  const taken = !c && naming?.taken && value === naming.utm ? t("new.taken", { name: naming.taken.name }) : undefined;
  const problem = !c && naming?.problem && value === naming.utm ? naming.problem : undefined;
  const ok = name.trim() && start && end && end >= start && value && !taken && !problem;
  const channelsSum = Object.values(channels).reduce((n, v) => n + (amountOf(v) ?? 0), 0);
  const ended = c && (c.status === "ended" || c.status === "cancelled");

  async function save() {
    if (!ok) return;
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = ended
      ? { brief: brief || null, message: message || null, owner: owner || null }
      : {
          name: name.trim(),
          ...(!locked && { utm: value }),
          start,
          end,
          owner: owner || null,
          message: message || null,
          audience: audience || null,
          brief: brief || null,
          budget: amountOf(budget) ?? channelsSum,
          channels: Object.entries(channels).map(([id, b]) => ({ id, budget: amountOf(b) ?? 0 })),
          goals: goals
            .filter((g) => amountOf(g.target))
            .map((g) => ({ metric: g.metric, target: amountOf(g.target), goal: g.metric === "conversions" ? g.goal : null })),
          approvers,
        };
    try {
      const saved = c
        ? await send<CampaignDetail>(ctx, `/api/v1/campaigns/${c.id}`, "PATCH", body)
        : await send<CampaignDetail>(ctx, "/api/v1/campaigns", "POST", body);
      onSaved(saved);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={c ? t("new.editTitle", { name: c.name }) : t("new.title")}
      description={c ? (c.status === "planned" && c.approvals.some((a) => a.state !== "waiting") ? t("new.resets") : undefined) : t("new.description")}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!ok || busy}>
            {c ? t("common.save") : t("new.create")}
          </Button>
        </>
      }
    >
      {error && <Notice tone="danger">{error}</Notice>}
      <TextField label={t("new.name")} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("new.namePlaceholder")} disabled={!!ended} />
      <TextField
        label="utm_campaign"
        mono
        value={value}
        onChange={(e) => setUtm(e.target.value)}
        disabled={locked}
        error={taken ?? problem}
        hint={locked ? t("new.utmFixed") : t("new.utmHint", { rule: cfg.naming.campaign })}
      />
      {!ended && (
        <div className="cmp-form2 grid gap-2">
          <TextField label={t("new.starts")} type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          <TextField
            label={t("new.ends")}
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            error={end < start ? t("new.endsBefore") : undefined}
          />
        </div>
      )}
      <SelectField
        label={t("common.owner")}
        value={owner}
        onChange={(e) => setOwner(e.target.value)}
        options={[{ value: "", label: t("common.nobody") }, ...ctx.members.map((m) => ({ value: m.id, label: m.name }))]}
      />
      <TextField label={t("new.message")} value={message} onChange={(e) => setMessage(e.target.value)} placeholder={t("new.messagePlaceholder")} />
      {!ended && <TextField label={t("new.audience")} value={audience} onChange={(e) => setAudience(e.target.value)} />}
      <label className="flex flex-col gap-1 text-xs font-medium text-fg">
        {t("new.brief")}
        <textarea className="cmp-textarea" value={brief} onChange={(e) => setBrief(e.target.value)} />
      </label>
      {!ended && (
        <>
          <fieldset className="flex flex-col gap-1.5 border-0">
            <legend className="mb-1 text-xs font-medium text-fg">{t("new.channels")}</legend>
            {cfg.channels.map((ch) => (
              <div key={ch.id} className="cmp-channel-row grid items-center gap-2">
                <Checkbox
                  label={ch.name}
                  description={`utm_medium=${ch.medium}`}
                  checked={ch.id in channels}
                  onChange={(e) =>
                    setChannels((x) => {
                      const n = { ...x };
                      if (e.target.checked) n[ch.id] = "";
                      else delete n[ch.id];
                      return n;
                    })
                  }
                />
                {ch.id in channels && (
                  <TextField
                    label={t("new.channelBudget", { channel: ch.name })}
                    inputMode="decimal"
                    value={channels[ch.id]}
                    onChange={(e) => setChannels((x) => ({ ...x, [ch.id]: e.target.value }))}
                    adornment={<span className="text-xs text-fg-muted">{cfg.currency === "TRY" ? "TL" : cfg.currency}</span>}
                  />
                )}
              </div>
            ))}
          </fieldset>
          <TextField
            label={t("new.budget")}
            inputMode="decimal"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder={channelsSum ? String(channelsSum) : "60000"}
            hint={t("new.budgetHint")}
            adornment={<span className="text-xs text-fg-muted">{cfg.currency === "TRY" ? "TL" : cfg.currency}</span>}
          />
        </>
      )}
      <fieldset className="flex flex-col gap-1.5 border-0">
        <legend className="mb-1 text-xs font-medium text-fg">{t("new.goals")}</legend>
        {goals.map((g, i) => (
          <div key={i} className="cmp-goal-row grid items-end gap-2">
            <SelectField
              label={t("new.metric")}
              value={g.metric}
              onChange={(e) => setGoals((x) => x.map((y, j) => (j === i ? { ...y, metric: e.target.value as Metric } : y)))}
              options={METRICS.map((m) => ({ value: m, label: t(`metric.${m}`) }))}
            />
            <TextField
              label={t("new.target")}
              inputMode="decimal"
              value={g.target}
              onChange={(e) => setGoals((x) => x.map((y, j) => (j === i ? { ...y, target: e.target.value } : y)))}
            />
            {g.metric === "conversions" ? (
              <TextField
                label={t("new.analyticsGoal")}
                value={g.goal}
                onChange={(e) => setGoals((x) => x.map((y, j) => (j === i ? { ...y, goal: e.target.value } : y)))}
                placeholder="Signup"
              />
            ) : (
              <span />
            )}
            <Button type="button" size="sm" icon={<Trash2 />} onClick={() => setGoals((x) => x.filter((_, j) => j !== i))}>
              {t("common.remove")}
            </Button>
          </div>
        ))}
        <span>
          <Button type="button" size="sm" icon={<Plus />} onClick={() => setGoals((x) => [...x, { metric: "visits", target: "", goal: "" }])}>
            {t("new.addGoal")}
          </Button>
        </span>
      </fieldset>
      {!ended && (
        <fieldset className="flex flex-col gap-1 border-0">
          <legend className="mb-1 text-xs font-medium text-fg">{t("new.approvers")}</legend>
          {ctx.members.map((m) => (
            <Checkbox
              key={m.id}
              label={m.name}
              description={m.email}
              checked={approvers.includes(m.email.toLowerCase())}
              onChange={(e) => setApprovers((x) => (e.target.checked ? [...x, m.email.toLowerCase()] : x.filter((y) => y !== m.email.toLowerCase())))}
            />
          ))}
        </fieldset>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------- one campaign

export function CampaignPage(ctx: Ctx & { id: string; tab: Tab }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const [c, reload] = useLoad<CampaignDetail>(ctx.call, `/api/v1/campaigns/${encodeURIComponent(ctx.id)}`);
  const [notice, setNotice] = useState<{ text: string; tone?: "danger" } | null>(null);
  const [editing, setEditing] = useState(false);
  const [making, setMaking] = useState(false);
  const tab = ctx.tab;
  if (c === null) return <EmptyState title={t("campaign.missing")} />;
  if (!c) return <PageHeader title={t("loading")} />;
  const changed = () => {
    reload();
    ctx.onChanged();
  };
  const act = async (path: string, done: (r: unknown) => string) => {
    setNotice(null);
    try {
      const r = await send<unknown>(ctx, `/api/v1/campaigns/${c.id}/${path}`, "POST");
      setNotice({ text: done(r) });
      changed();
    } catch (err) {
      setNotice({ text: (err as Error).message, tone: "danger" });
    }
  };
  const waiting = c.approvals.filter((a) => a.state !== "approved");
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t("campaigns.title"), href: "/campaigns" }, { label: c.name }]}
        title={c.name}
        description={`${t("common.span", { from: day(c.start, locale), to: day(c.end, locale) })}${c.owner ? ` · ${t("campaign.ownedBy", { name: c.owner.name })}` : ""}`}
        meta={<StateBadge c={c} t={t} />}
        actions={
          <>
            <Button icon={<ArrowLeft />} onClick={() => navigate("/campaigns")}>
              {t("campaign.back")}
            </Button>
            {can("editor") && (
              <Button icon={<Pencil />} onClick={() => setEditing(true)}>
                {t("common.edit")}
              </Button>
            )}
            {can("editor") && c.status === "live" && (
              <Button icon={<Flag />} onClick={() => void act("end", () => t("campaign.endedNow", { name: c.name }))}>
                {t("campaign.end")}
              </Button>
            )}
            {can("editor") && c.status === "planned" && (
              <Button icon={<Ban />} onClick={() => void act("cancel", () => t("campaign.cancelledNow", { name: c.name }))}>
                {t("campaign.cancel")}
              </Button>
            )}
            {can("editor") && c.status === "planned" && (
              <Button
                variant="primary"
                icon={<Rocket />}
                disabled={!c.canLaunch}
                onClick={() =>
                  void act("launch", (r) => {
                    const a = (r as { automation: { sent: boolean; started: boolean; error: string | null } }).automation;
                    return [
                      t("campaign.liveNow", { name: c.name }),
                      a.error
                        ? t("campaign.automationFailed", { error: a.error })
                        : a.started
                          ? t("campaign.automationRan")
                          : a.sent
                            ? t("campaign.automationSkipped")
                            : "",
                    ]
                      .filter(Boolean)
                      .join(" ");
                  })
                }
              >
                {t("campaign.markLive")}
              </Button>
            )}
          </>
        }
      >
        <Tabs
          label={t("campaign.tabs")}
          value={tab}
          onChange={(v) => navigate(`/campaigns/${c.id}${v === "brief" ? "" : `/${v}`}`)}
          items={[
            { value: "brief", label: t("campaign.brief") },
            { value: "budget", label: t("campaign.budget") },
            { value: "links", label: t("campaign.links"), count: c.counts.links },
            { value: "results", label: t("campaign.results") },
          ]}
        />
      </PageHeader>
      <div className="mt-2.5">
        {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
        {c.status === "planned" && waiting.length > 0 && (
          <p className="mb-2.5 text-xs text-fg-muted">{t("campaign.cannotYet", { names: waiting.map((a) => a.name).join(", ") })}</p>
        )}
        {tab === "brief" && <BriefTab ctx={ctx} c={c} onChanged={changed} />}
        {tab === "budget" && <BudgetTab ctx={ctx} c={c} onChanged={changed} />}
        {tab === "links" && (
          <Panel
            title={t("campaign.links")}
            description={t("campaign.linksDetail", { utm: c.utm })}
            actions={
              can("editor") &&
              (c.status === "planned" || c.status === "live") && (
                <Button size="sm" icon={<Plus />} onClick={() => setMaking(true)}>
                  {t("links.make")}
                </Button>
              )
            }
            flush
          >
            <LinksTable links={c.links} label={t("campaign.links")} showCampaign={false} />
          </Panel>
        )}
        {tab === "results" && <ResultsTab ctx={ctx} c={c} />}
      </div>
      {editing && <CampaignDialog ctx={ctx} c={c} onClose={() => setEditing(false)} onSaved={changed} />}
      <Dialog open={making} onOpenChange={setMaking} title={t("links.makeFor", { name: c.name })} size="lg">
        <LinkBuilder call={ctx.call} settings={ctx.settings} campaigns={[c]} fixed={c} onMade={changed} />
      </Dialog>
    </>
  );
}

function Facts({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="cmp-facts grid gap-x-2 gap-y-1.5 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-xs text-fg-muted">{k}</dt>
          <dd className="m-0 min-w-0 text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function goalText(t: T, g: { metric: Metric; target: number; goal: string | null }, tl: (n: number) => string, locale?: string) {
  if (g.metric === "revenue") return t("goal.revenue", { value: tl(g.target) });
  if (g.metric === "conversions") return t("goal.conversions", { value: num(g.target, locale), goal: g.goal ?? "" });
  return t(`goal.${g.metric}`, { value: num(g.target, locale) });
}

function BriefTab({ ctx, c, onChanged }: { ctx: Ctx; c: CampaignDetail; onChanged: () => void }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const [task, setTask] = useState({ text: "", owner: "", due: "" });
  const [asset, setAsset] = useState({ name: "", url: "" });
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [integrations] = useLoad<{ automation: { linked: boolean; playbook: string | null; url: string | null } }>(ctx.call, "/api/v1/integrations");
  const tl = (n: number) => money(n, c.currency, locale);
  const ran = c.status === "live" || c.status === "ended";
  const mine = c.myApproval !== null;
  const run = async (f: () => Promise<unknown>) => {
    setError(null);
    try {
      await f();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const decide = (decision: "approved" | "changes") =>
    run(async () => {
      await send(ctx, `/api/v1/campaigns/${c.id}/approval`, "POST", { decision, note: note || null });
      setNote("");
    });
  return (
    <div className="cmp-side grid gap-2.5">
      <div className="flex min-w-0 flex-col gap-2.5">
        {error && <Notice tone="danger">{error}</Notice>}
        <Panel aria-label={t("brief.title")} title={t("brief.title")}>
          <Facts
            items={[
              [t("brief.goals"), c.goals.length ? c.goals.map((g) => goalText(t, g, tl, locale)).join(", ") : t("brief.noGoals")],
              [t("brief.audience"), c.audience ?? "–"],
              [t("brief.message"), c.message ?? "–"],
              [t("brief.dates"), t("common.span", { from: day(c.start, locale), to: day(c.end, locale) })],
              [
                t("brief.channels"),
                <span key="ch" className="flex flex-wrap gap-1">
                  {c.channels.length ? c.channels.map((ch) => <Badge key={ch.id}>{ch.name}</Badge>) : "–"}
                </span>,
              ],
              [
                t("brief.name"),
                <span key="utm" className="font-mono text-xs">
                  utm_campaign={c.utm}
                </span>,
              ],
            ]}
          />
          {c.brief && <p className="cmp-pre mt-2.5 mb-0 text-sm text-fg">{c.brief}</p>}
        </Panel>
        <Panel aria-label={t("tasks.title")} title={t("tasks.title")} description={t("tasks.description")}>
          <ul aria-label={t("tasks.title")} className="cmp-list flex flex-col gap-2">
            {!c.tasks.length && <li className="text-xs text-fg-muted">{t("tasks.none")}</li>}
            {c.tasks.map((x) => (
              <li key={x.id} className="flex items-start justify-between gap-3 border-b border-subtle pb-2 last:border-0">
                <Checkbox
                  label={x.text}
                  description={x.owner?.name ?? t("common.nobody")}
                  checked={!!x.doneAt}
                  disabled={!can("editor")}
                  onChange={(e) => void run(() => send(ctx, `/api/v1/tasks/${x.id}`, "PATCH", { done: e.target.checked }))}
                />
                <StatusBadge tone={x.doneAt ? "success" : x.overdue ? "danger" : "neutral"}>
                  {x.doneAt
                    ? t("tasks.doneOn", { day: day(x.doneAt.slice(0, 10), locale) })
                    : x.due
                      ? x.overdue
                        ? t("tasks.overdue", { day: day(x.due, locale) })
                        : day(x.due, locale)
                      : t("tasks.noDue")}
                </StatusBadge>
              </li>
            ))}
          </ul>
          {can("editor") && (
            <form
              className="cmp-task-row mt-2.5 grid items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!task.text.trim()) return;
                void run(async () => {
                  await send(ctx, `/api/v1/campaigns/${c.id}/tasks`, "POST", { text: task.text, owner: task.owner || null, due: task.due || null });
                  setTask({ text: "", owner: "", due: "" });
                });
              }}
            >
              <TextField label={t("tasks.new")} value={task.text} onChange={(e) => setTask({ ...task, text: e.target.value })} />
              <SelectField
                label={t("tasks.who")}
                value={task.owner}
                onChange={(e) => setTask({ ...task, owner: e.target.value })}
                options={[{ value: "", label: t("common.nobody") }, ...ctx.members.map((m) => ({ value: m.id, label: m.name }))]}
              />
              <TextField label={t("tasks.due")} type="date" value={task.due} onChange={(e) => setTask({ ...task, due: e.target.value })} />
              <Button type="submit" size="sm" icon={<Plus />} disabled={!task.text.trim()}>
                {t("tasks.add")}
              </Button>
            </form>
          )}
        </Panel>
        <Panel aria-label={t("assets.title")} title={t("assets.title")} description={t("assets.description")}>
          <ul aria-label={t("assets.title")} className="cmp-list flex flex-col gap-1.5">
            {!c.assets.length && <li className="text-xs text-fg-muted">{t("assets.none")}</li>}
            {c.assets.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2 text-sm">
                <a href={a.url} target="_blank" rel="noreferrer" className="truncate">
                  {a.name}
                </a>
                <span className="text-2xs whitespace-nowrap text-fg-muted">{a.createdBy}</span>
              </li>
            ))}
          </ul>
          {can("editor") && (
            <form
              className="cmp-asset-row mt-2.5 grid items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await send(ctx, `/api/v1/campaigns/${c.id}/assets`, "POST", asset);
                  setAsset({ name: "", url: "" });
                });
              }}
            >
              <TextField label={t("assets.name")} value={asset.name} onChange={(e) => setAsset({ ...asset, name: e.target.value })} />
              <TextField label={t("assets.url")} value={asset.url} onChange={(e) => setAsset({ ...asset, url: e.target.value })} placeholder="https://" />
              <Button type="submit" size="sm" icon={<Plus />} disabled={!asset.name.trim() || !asset.url.trim()}>
                {t("assets.add")}
              </Button>
            </form>
          )}
        </Panel>
      </div>
      <div className="flex min-w-0 flex-col gap-2.5">
        <Panel
          aria-label={t("approvals.title")}
          title={t("approvals.title")}
          description={c.approvals.length ? t("approvals.description") : t("approvals.none")}
        >
          <ul aria-label={t("approvals.list")} className="cmp-list flex flex-col gap-2">
            {c.approvals.map((a) => (
              <li key={a.email} className="flex flex-col gap-0.5 text-sm">
                <span className="flex items-center gap-2">
                  <Avatar name={a.name} size="sm" />
                  <span className="flex min-w-0 grow flex-col">
                    <span className="truncate text-fg">{a.name}</span>
                    <span className="truncate text-2xs text-fg-muted">{a.email}</span>
                  </span>
                  <StatusBadge tone={a.state === "approved" ? "success" : a.state === "changes" ? "danger" : "warning"}>
                    {a.state === "approved"
                      ? t("approvals.approvedOn", { day: day(a.decidedAt!.slice(0, 10), locale) })
                      : a.state === "changes"
                        ? t("approvals.changes")
                        : t("approvals.waiting")}
                  </StatusBadge>
                </span>
                {a.note && <span className="pl-8 text-xs text-fg-muted">{a.note}</span>}
              </li>
            ))}
          </ul>
          {mine && c.status === "planned" && (
            <div className="mt-2.5 flex flex-col gap-2 border-t border-subtle pt-2.5">
              <TextField label={t("approvals.note")} value={note} onChange={(e) => setNote(e.target.value)} hint={t("approvals.noteHint")} />
              <span className="flex flex-wrap gap-2">
                <Button size="sm" variant="primary" icon={<Check />} onClick={() => void decide("approved")}>
                  {t("approvals.approve")}
                </Button>
                <Button size="sm" disabled={!note.trim()} onClick={() => void decide("changes")}>
                  {t("approvals.askChanges")}
                </Button>
              </span>
            </div>
          )}
        </Panel>
        <Panel title={ran ? t("launch.ran") : t("launch.title")} description={t("launch.description")}>
          {integrations?.automation.linked ? (
            <p className="m-0 text-xs text-fg">{t("launch.playbook", { playbook: integrations.automation.playbook ?? "" })}</p>
          ) : (
            <p className="m-0 text-xs text-fg-muted">{t("launch.none")}</p>
          )}
          {c.launchedAt && <p className="mt-1.5 mb-0 text-2xs text-fg-muted">{t("launch.at", { when: when(c.launchedAt, locale) })}</p>}
        </Panel>
        <Panel title={t("activity.title")} flush>
          <ul aria-label={t("activity.title")} className="cmp-list flex flex-col">
            {c.activity.slice(0, 20).map((a, i) => (
              <li key={i} className="border-b border-subtle px-3 py-1.5 text-xs last:border-0">
                <span className="text-fg">{a.text}</span>
                <span className="block text-2xs text-fg-muted">
                  {a.by} · {when(a.at, locale)}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- budget and spend

const SOURCE_KEYS = { manual: "spend.byHand", csv: "spend.csv", google: "spend.google", meta: "spend.meta" } as const;

function BudgetTab({ ctx, c, onChanged }: { ctx: Ctx; c: CampaignDetail; onChanged: () => void }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const cfg = ctx.settings.config;
  const [spend, reload] = useLoad<SpendList>(ctx.call, `/api/v1/spend?campaign=${encodeURIComponent(c.id)}`);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone?: "danger" } | null>(null);
  const tl = (n: number) => money(n, c.currency, locale);
  const planned = c.channels.reduce((n, ch) => n + ch.budget, 0);
  const rows = spend?.spend ?? [];
  const from = (id: string) => {
    const kinds = [...new Set(rows.filter((s) => s.channel === id).map((s) => t(SOURCE_KEYS[s.source])))];
    return kinds.join(", ") || "–";
  };
  const others = rows.filter((s) => !c.channels.some((ch) => ch.id === s.channel));
  const lines = [
    ...c.channels.map((ch) => ({ id: ch.id, name: ch.name, planned: ch.budget, spent: ch.spend })),
    ...[...new Set(others.map((s) => s.channel ?? ""))].map((id) => ({
      id,
      name: id ? (cfg.channels.find((x) => x.id === id)?.name ?? id) : t("spend.noChannel"),
      planned: 0,
      spent: others.filter((s) => (s.channel ?? "") === id).reduce((n, s) => n + s.amount, 0),
    })),
  ];
  const refresh = () => {
    reload();
    onChanged();
  };
  const sync = async () => {
    setNotice(null);
    try {
      const r = await ctx.call<AdsRead>("/api/v1/spend/sync", { method: "POST" });
      setNotice({
        text: r.platforms.length
          ? r.platforms
              .map((p) =>
                p.error
                  ? `${t(SOURCE_KEYS[p.platform])}: ${p.error}`
                  : t("spend.read", { platform: t(SOURCE_KEYS[p.platform]), rows: p.rows, matched: p.matched, unmatched: p.unmatched }),
              )
              .join(" ")
          : t("spend.noPlatforms"),
        tone: r.platforms.some((p) => p.error) ? "danger" : undefined,
      });
      refresh();
    } catch (err) {
      setNotice({ text: (err as Error).message, tone: "danger" });
    }
  };
  return (
    <>
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      <KpiGrid minWidth={160} className="mb-2.5">
        <KpiCard label={t("budget.budget")} value={tl(c.budget)} />
        <KpiCard
          label={t("budget.planned")}
          value={tl(planned)}
          delta={{ label: c.budget > planned ? t("budget.notPlanned", { amount: tl(c.budget - planned) }) : t("budget.allPlanned"), intent: "neutral" }}
        />
        <KpiCard
          label={t("budget.spent")}
          value={tl(c.spend)}
          tone={c.spend > c.budget && c.budget > 0 ? "danger" : undefined}
          delta={{
            label: c.budget ? t("budget.ofBudget", { pct: pct(c.spend, c.budget) }) : t("budget.noBudget"),
            intent: c.spend > c.budget ? "bad" : "neutral",
          }}
        />
      </KpiGrid>
      <Panel
        title={t("budget.byChannel")}
        description={t("budget.byChannelDetail")}
        actions={
          can("editor") && (
            <span className="flex flex-wrap gap-2">
              {ctx.summary && (ctx.summary.linked.google || ctx.summary.linked.meta) && (
                <Button size="sm" icon={<RefreshCw />} onClick={() => void sync()}>
                  {t("spend.readNow")}
                </Button>
              )}
              <Button size="sm" icon={<Upload />} onClick={() => setAdding(true)}>
                {t("spend.add")}
              </Button>
            </span>
          )
        }
        flush
      >
        <DataTable
          label={t("budget.byChannel")}
          rows={lines}
          getRowId={(l) => l.id || "none"}
          minWidth={640}
          empty={<p className="px-3 py-3 text-sm text-fg-muted">{t("budget.noChannels")}</p>}
          columns={[
            { id: "name", header: t("budget.channel"), cell: (l) => <span className="font-medium">{l.name}</span> },
            { id: "planned", header: t("budget.planned"), align: "right", mono: true, cell: (l) => tl(l.planned) },
            { id: "spent", header: t("budget.spent"), align: "right", mono: true, cell: (l) => tl(l.spent) },
            {
              id: "left",
              header: t("budget.left"),
              align: "right",
              cell: (l) => <span className={l.spent > l.planned ? "font-mono text-xs text-danger-text" : "font-mono text-xs"}>{tl(l.planned - l.spent)}</span>,
            },
            { id: "from", header: t("budget.from"), cell: (l) => <span className="text-xs text-fg-muted">{from(l.id)}</span> },
          ]}
        />
      </Panel>
      <Panel title={t("spend.title")} className="mt-2.5" flush>
        <DataTable
          label={t("spend.title")}
          rows={rows}
          getRowId={(s) => s.id}
          minWidth={720}
          pageSize={25}
          empty={<p className="px-3 py-3 text-sm text-fg-muted">{t("spend.none")}</p>}
          columns={[
            {
              id: "day",
              header: t("spend.day"),
              sortValue: (s) => s.day,
              cell: (s) => <span className="text-xs whitespace-nowrap">{day(s.day, locale)}</span>,
            },
            { id: "channel", header: t("budget.channel"), cell: (s) => <span className="text-xs">{s.channelName ?? "–"}</span> },
            { id: "amount", header: t("spend.amount"), align: "right", mono: true, sortValue: (s) => s.amount, cell: (s) => tl(s.amount) },
            {
              id: "from",
              header: t("budget.from"),
              cell: (s) => (
                <span className="flex min-w-0 flex-col text-xs">
                  {t(SOURCE_KEYS[s.source])}
                  {(s.adCampaign || s.note) && <span className="truncate text-2xs text-fg-muted">{s.adCampaign ?? s.note}</span>}
                </span>
              ),
            },
            {
              id: "x",
              header: <span className="sr-only">{t("common.remove")}</span>,
              label: t("common.remove"),
              align: "right",
              cell: (s) =>
                can("editor") && (s.source === "manual" || s.source === "csv") ? (
                  <Button
                    size="xs"
                    icon={<Trash2 />}
                    onClick={() =>
                      void ctx
                        .call(`/api/v1/spend/${s.id}`, { method: "DELETE" })
                        .then(refresh, (err: Error) => setNotice({ text: err.message, tone: "danger" }))
                    }
                  >
                    {t("common.remove")}
                  </Button>
                ) : null,
            },
          ]}
        />
      </Panel>
      {adding && (
        <SpendDialog
          ctx={ctx}
          c={c}
          onClose={() => setAdding(false)}
          onDone={(text) => {
            setNotice({ text });
            refresh();
          }}
        />
      )}
    </>
  );
}

function SpendDialog({ ctx, c, onClose, onDone }: { ctx: Ctx; c: CampaignDetail; onClose: () => void; onDone: (text: string) => void }) {
  const t = useT();
  const cfg = ctx.settings.config;
  const [mode, setMode] = useState<"hand" | "csv">("hand");
  const [channel, setChannel] = useState(c.channels[0]?.id ?? cfg.channels[0]!.id);
  const [dayValue, setDay] = useState(ctx.summary?.today ?? "");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [csv, setCsv] = useState("");
  const [check, setCheck] = useState<SpendImported | null>(null);
  const [error, setError] = useState<string | null>(null);
  const value = amountOf(amount);

  async function submit() {
    setError(null);
    try {
      if (mode === "hand") {
        if (!value) return;
        await send<Spend>(ctx, "/api/v1/spend", "POST", { campaign: c.id, channel, day: dayValue, amount: value, note: note || null });
        onDone(t("spend.added", { amount: money(value, c.currency), channel: cfg.channels.find((x) => x.id === channel)?.name ?? channel }));
        onClose();
      } else {
        const r = await send<SpendImported>(ctx, "/api/v1/spend/import", "POST", { csv, check: !check });
        if (!check) {
          setCheck(r);
          return;
        }
        onDone(t("spend.imported", { added: r.added, replaced: r.replaced, errors: r.errors.length }));
        onClose();
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("spend.add")}
      description={t("spend.addDetail", { utm: c.utm })}
      size="lg"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={mode === "hand" ? !value || !dayValue : !csv.trim()}>
            {mode === "hand" ? t("spend.addButton") : check ? t("spend.importButton") : t("spend.checkButton")}
          </Button>
        </>
      }
    >
      {error && <Notice tone="danger">{error}</Notice>}
      <SegmentedControl
        label={t("spend.from")}
        value={mode}
        onChange={(m) => {
          setMode(m);
          setCheck(null);
        }}
        options={[
          { value: "hand", label: t("spend.byHand") },
          { value: "csv", label: t("spend.csv") },
        ]}
      />
      {mode === "hand" ? (
        <>
          <SelectField
            label={t("budget.channel")}
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            options={cfg.channels.map((ch) => ({ value: ch.id, label: ch.name }))}
          />
          <TextField label={t("spend.day")} type="date" value={dayValue} onChange={(e) => setDay(e.target.value)} />
          <TextField
            label={t("spend.amount")}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="2500"
            adornment={<span className="text-xs text-fg-muted">{t("spend.noVat", { currency: cfg.currency === "TRY" ? "TL" : cfg.currency })}</span>}
          />
          <TextField label={t("spend.note")} value={note} onChange={(e) => setNote(e.target.value)} />
        </>
      ) : (
        <>
          <label className="flex flex-col gap-1 text-xs font-medium text-fg">
            {t("spend.file")}
            <input
              type="file"
              accept=".csv,text/csv"
              className="text-xs font-normal text-fg-muted"
              onChange={(e) => {
                const f = e.target.files?.[0];
                setCheck(null);
                if (f) void f.text().then(setCsv);
              }}
            />
            <span className="font-normal text-fg-muted">{t("spend.fileHint", { utm: c.utm })}</span>
          </label>
          {check && (
            <Callout tone={check.errors.length ? "warning" : "success"} title={t("spend.checked", { valid: check.valid, rows: check.rows })}>
              {check.errors.length ? (
                <ul className="cmp-list text-xs">
                  {check.errors.slice(0, 8).map((e) => (
                    <li key={e.line}>{t("spend.lineError", { line: e.line, error: e.error })}</li>
                  ))}
                </ul>
              ) : (
                t("spend.allGood")
              )}
            </Callout>
          )}
        </>
      )}
    </Dialog>
  );
}
