// Results: what one campaign brought and cost by channel, and every campaign of a period side by side. A won deal
// counts for the first and the last campaign that touched it, both shown and never blended.
import {
  BarList,
  Button,
  Callout,
  DataTable,
  EmptyState,
  KpiCard,
  KpiGrid,
  navigate,
  PageHeader,
  Panel,
  SegmentedControl,
  TextField,
  TimeSeriesChart,
  useLocalePreference,
} from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import type { Ctx } from "./App.tsx";
import type { CampaignDetail, Deal, Report, Results } from "./api.ts";
import { day, today as localToday, money, Notice, num, pct, roiText, useLoad, when } from "./common.tsx";
import { useT } from "./i18n.ts";

function SyncButton({ ctx, onDone }: { ctx: Ctx; onDone: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!can("editor")) return null;
  return (
    <span className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        icon={<RefreshCw />}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          void ctx
            .call<{ errors: Record<string, string> }>("/api/v1/sync", { method: "POST" })
            .then(
              (r) => {
                const e = Object.entries(r.errors);
                setError(e.length ? e.map(([k, v]) => `${k}: ${v}`).join(" ") : null);
                onDone();
              },
              (err: Error) => setError(err.message),
            )
            .finally(() => setBusy(false));
        }}
      >
        {t("results.readNow")}
      </Button>
      {error && <span className="text-2xs text-danger-text">{error}</span>}
    </span>
  );
}

function DealList({ deals, utm, label }: { deals: Deal[]; utm?: string; label: string }) {
  const t = useT();
  const [locale] = useLocalePreference();
  if (!deals.length) return <p className="text-xs text-fg-muted">{t("results.noDeals")}</p>;
  return (
    <ul aria-label={label} className="cmp-list flex flex-col gap-1.5">
      {deals.map((d) => (
        <li key={d.id} className="flex items-start justify-between gap-2 border-b border-subtle pb-1.5 text-sm last:border-0">
          <span className="flex min-w-0 flex-col">
            {d.url ? (
              <a href={d.url} className="truncate">
                {d.company && !d.name.startsWith(d.company) ? `${d.company}: ${d.name}` : d.name}
              </a>
            ) : (
              <span className="truncate text-fg">{d.name}</span>
            )}
            <span className="font-mono text-2xs text-fg-muted">
              {t("results.firstLast", {
                first: d.first ? `${d.first.campaign.utm}${d.first.channelName ? ` (${d.first.channelName})` : ""}` : "–",
                last: d.last ? `${d.last.campaign.utm}${d.last.channelName ? ` (${d.last.channelName})` : ""}` : "–",
              })}
              {utm && d.first?.campaign.utm === utm && d.last?.campaign.utm === utm ? ` · ${t("results.both")}` : ""}
            </span>
          </span>
          <span className="flex flex-col items-end">
            <span className={d.counted ? "font-mono text-xs whitespace-nowrap" : "font-mono text-xs whitespace-nowrap text-fg-muted"}>
              {money(d.value, d.currency, locale)}
            </span>
            <span className="text-2xs text-fg-muted">{d.counted ? day(d.wonAt.slice(0, 10), locale) : t("results.otherCurrency")}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ResultsTab({ ctx, c }: { ctx: Ctx; c: CampaignDetail }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [r, reload] = useLoad<Results>(ctx.call, `/api/v1/campaigns/${encodeURIComponent(c.id)}/results`);
  const [touch, setTouch] = useState<"both" | "first" | "last">("both");
  if (r === null) return <EmptyState title={t("common.failed")} />;
  if (!r) return null;
  const tl = (n: number) => money(n, r.currency, locale);
  const x = r.totals;
  const linked = r.linked.analytics || r.linked.messages || r.linked.crm;
  const deals = r.deals.filter((d) => (touch === "both" ? true : touch === "first" ? d.first?.campaign.id === c.id : d.last?.campaign.id === c.id));
  const conversion = r.goals.find((g) => g.metric === "conversions");
  return (
    <>
      <div className="mb-2.5 flex flex-wrap items-start justify-between gap-2">
        <p className="m-0 text-xs text-fg-muted">
          {r.readAt ? t("results.readAt", { when: when(r.readAt, locale) }) : t("results.notRead")}
          {r.frozen ? ` ${t("results.frozen")}` : ""}
          {r.window ? ` ${t("results.window", { days: r.window.days })}` : ""}
          {r.window?.partial ? ` ${t("results.partial")}` : ""}
        </p>
        <SyncButton ctx={ctx} onDone={reload} />
      </div>
      {!linked && (
        <Callout tone="info" title={t("results.notLinked")} className="mb-2.5">
          {t("results.notLinkedDetail")}
        </Callout>
      )}
      {(r.errors.analytics || r.errors.messages) && <Notice tone="danger">{[r.errors.analytics, r.errors.messages].filter(Boolean).join(" ")}</Notice>}
      <KpiGrid minWidth={150} className="mb-2.5">
        <KpiCard
          label={t("results.spent")}
          value={tl(x.spend)}
          delta={{ label: t("results.ofBudget", { budget: tl(x.budget) }), intent: x.spend > x.budget && x.budget > 0 ? "bad" : "neutral" }}
        />
        <KpiCard label={t("results.visits")} value={num(x.visits, locale)} delta={{ label: t("results.fromAnalytics"), intent: "neutral" }} />
        {conversion && conversion.actual !== null && (
          <KpiCard
            label={conversion.goal ?? t("metric.conversions")}
            value={num(conversion.actual, locale)}
            delta={{ label: t("results.goalInAnalytics"), intent: "neutral" }}
          />
        )}
        {x.sent > 0 && (
          <KpiCard
            label={t("results.opens")}
            value={pct(x.opened, x.delivered || x.sent)}
            delta={{ label: t("results.ofSent", { sent: num(x.sent, locale) }), intent: "neutral" }}
          />
        )}
        <KpiCard label={t("results.wonFirst")} value={String(x.first.deals)} delta={{ label: tl(x.first.revenue), intent: "neutral" }} />
        <KpiCard label={t("results.wonLast")} value={String(x.last.deals)} delta={{ label: tl(x.last.revenue), intent: "neutral" }} />
        <KpiCard
          label={t("results.roi")}
          value={roiText(x.last.roi)}
          unit={t("results.lastTouch")}
          delta={{ label: t("results.roiFirst", { roi: roiText(x.first.roi) }), intent: "neutral" }}
        />
      </KpiGrid>
      <Callout tone="info" title={t("results.rule")} className="mb-2.5">
        {t("results.ruleDetail", { days: ctx.settings.config.attribution.windowDays })}
      </Callout>
      {r.goals.length > 0 && (
        <Panel title={t("results.goals")} className="mb-2.5" flush>
          <DataTable
            label={t("results.goals")}
            rows={r.goals}
            getRowId={(g) => g.id}
            minWidth={560}
            columns={[
              {
                id: "metric",
                header: t("results.goal"),
                cell: (g) => (g.metric === "conversions" ? `${t("metric.conversions")}: ${g.goal}` : t(`metric.${g.metric}`)),
              },
              {
                id: "target",
                header: t("results.target"),
                align: "right",
                mono: true,
                cell: (g) => (g.metric === "revenue" ? tl(g.target) : num(g.target, locale)),
              },
              {
                id: "actual",
                header: t("results.actual"),
                description: t("results.actualDetail"),
                align: "right",
                mono: true,
                cell: (g) =>
                  g.actual === null
                    ? "–"
                    : `${g.metric === "revenue" ? tl(g.actual) : num(g.actual, locale)}${g.actualFirst !== null ? ` / ${g.metric === "revenue" ? tl(g.actualFirst) : num(g.actualFirst, locale)}` : ""}`,
              },
              { id: "share", header: t("results.share"), align: "right", mono: true, cell: (g) => (g.share === null ? "–" : `${Math.round(g.share * 100)}%`) },
            ]}
          />
        </Panel>
      )}
      <Panel title={t("results.byChannel")} flush className="mb-2.5">
        <DataTable
          label={t("results.byChannel")}
          rows={r.channels}
          getRowId={(ch) => ch.id ?? "none"}
          minWidth={920}
          empty={<p className="px-3 py-3 text-sm text-fg-muted">{t("results.nothingYet")}</p>}
          columns={[
            { id: "name", header: t("budget.channel"), cell: (ch) => <span className="font-medium">{ch.name ?? t("results.noChannel")}</span> },
            { id: "spend", header: t("results.spent"), align: "right", mono: true, sortValue: (ch) => ch.spend, cell: (ch) => tl(ch.spend) },
            { id: "visits", header: t("results.visits"), align: "right", mono: true, sortValue: (ch) => ch.visits, cell: (ch) => num(ch.visits, locale) },
            {
              id: "sent",
              header: t("results.sentOpened"),
              align: "right",
              cell: (ch) => (
                <span className="font-mono text-xs">
                  {ch.sent ? (ch.opened ? `${num(ch.sent, locale)}, ${pct(ch.opened, ch.sent)}` : num(ch.sent, locale)) : "–"}
                </span>
              ),
            },
            { id: "first", header: t("results.wonFirstShort"), align: "right", mono: true, cell: (ch) => `${ch.first.deals}, ${tl(ch.first.revenue)}` },
            { id: "last", header: t("results.wonLastShort"), align: "right", mono: true, cell: (ch) => `${ch.last.deals}, ${tl(ch.last.revenue)}` },
            {
              id: "cost",
              header: t("results.costPerDeal"),
              description: t("results.costPerDealDetail"),
              align: "right",
              mono: true,
              cell: (ch) => (ch.last.deals && ch.spend ? tl(Math.round(ch.spend / ch.last.deals)) : "–"),
            },
          ]}
        />
      </Panel>
      <div className="cmp-halves grid gap-2.5">
        <Panel title={t("results.byDay")} description={t("results.byDayDetail", { utm: c.utm })}>
          {r.series.length ? (
            <TimeSeriesChart
              label={t("results.byDayLabel", { name: c.name })}
              labels={r.series.map((s) => day(s.day, locale))}
              series={[{ id: "v", name: t("results.visits"), data: r.series.map((s) => s.visits) }]}
              xTicks={6}
              height={190}
            />
          ) : (
            <p className="text-xs text-fg-muted">{t("results.nothingYet")}</p>
          )}
        </Panel>
        <Panel
          aria-label={t("results.won")}
          title={t("results.won")}
          description={t("results.wonDetail")}
          actions={
            <SegmentedControl
              label={t("results.countedAs")}
              value={touch}
              onChange={setTouch}
              options={[
                { value: "both", label: t("results.either") },
                { value: "first", label: t("results.firstTouch") },
                { value: "last", label: t("results.lastTouchShort") },
              ]}
            />
          }
        >
          <DealList deals={deals.slice(0, 20)} utm={c.utm} label={t("results.won")} />
        </Panel>
      </div>
      {r.messages.length > 0 && (
        <Panel title={t("results.messages")} description={t("results.messagesDetail")} className="mt-2.5" flush>
          <DataTable
            label={t("results.messages")}
            rows={r.messages}
            getRowId={(m) => m.id}
            minWidth={640}
            columns={[
              {
                id: "name",
                header: t("results.messageCampaign"),
                cell: (m) => (
                  <span className="flex flex-col">
                    <span className="font-medium">{m.name}</span>
                    <span className="font-mono text-2xs text-fg-muted">{m.slug}</span>
                  </span>
                ),
              },
              { id: "channel", header: t("budget.channel"), cell: (m) => m.channelName },
              { id: "sent", header: t("results.sent"), align: "right", mono: true, cell: (m) => num(m.sent, locale) },
              {
                id: "opened",
                header: t("results.opened"),
                align: "right",
                mono: true,
                cell: (m) => (m.channel === "sms" ? "–" : pct(m.opened, m.delivered || m.sent)),
              },
              { id: "clicked", header: t("results.clicked"), align: "right", mono: true, cell: (m) => pct(m.clicked, m.delivered || m.sent) },
              { id: "unsub", header: t("results.unsubscribed"), align: "right", mono: true, cell: (m) => num(m.unsubscribed, locale) },
            ]}
          />
        </Panel>
      )}
    </>
  );
}

export function ResultsPage(ctx: Ctx) {
  const t = useT();
  const [locale] = useLocalePreference();
  const today = ctx.summary?.today ?? localToday();
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const [touch, setTouch] = useState<"last" | "first">("last");
  const [r, reload] = useLoad<Report>(ctx.call, from && to && from <= to ? `/api/v1/report?${new URLSearchParams({ from, to })}` : null);
  const tl = (n: number) => money(n, ctx.settings.config.currency, locale);
  const by = touch === "last" ? "last" : "first";
  const other = touch === "last" ? "first" : "last";
  const measured = (r?.campaigns ?? []).filter((c) => c.spend || c.visits || c.first.deals || c.last.deals);
  return (
    <>
      <PageHeader
        title={t("report.title")}
        description={t("report.description")}
        actions={
          <span className="flex flex-wrap items-end gap-2">
            <TextField label={t("report.from")} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <TextField label={t("report.to")} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            <SegmentedControl
              label={t("report.attribution")}
              value={touch}
              onChange={setTouch}
              options={[
                { value: "last", label: t("results.lastTouchShort") },
                { value: "first", label: t("results.firstTouch") },
              ]}
            />
            <SyncButton ctx={ctx} onDone={reload} />
          </span>
        }
      />
      {r === null && <EmptyState title={t("common.failed")} />}
      {r && (
        <>
          <KpiGrid minWidth={170} className="mt-2.5 mb-2.5">
            <KpiCard
              label={t("results.spent")}
              value={tl(r.totals.spend)}
              delta={{ label: t("results.ofBudget", { budget: tl(r.totals.budget) }), intent: "neutral" }}
            />
            <KpiCard
              label={t(`report.revenue_${by}`)}
              value={tl(r.totals[by].revenue)}
              delta={{ label: t(`report.revenueOther_${other}`, { value: tl(r.totals[other].revenue) }), intent: "neutral" }}
            />
            <KpiCard
              label={t(`report.roi_${by}`)}
              value={roiText(r.totals[by].roi)}
              delta={{ label: t(`report.roiOther_${other}`, { roi: roiText(r.totals[other].roi) }), intent: "neutral" }}
            />
            <KpiCard label={t("results.visits")} value={num(r.totals.visits, locale)} />
            <KpiCard
              label={t("report.notAttributed")}
              value={String(r.notAttributed.deals)}
              delta={{ label: t("report.ofWon", { revenue: tl(r.notAttributed.revenue), deals: r.wonInPeriod.deals }), intent: "neutral" }}
            />
          </KpiGrid>
          <div className="cmp-side mb-2.5 grid gap-2.5">
            <Panel title={t("report.byCampaign")} flush>
              <DataTable
                label={t("report.byCampaign")}
                rows={r.campaigns}
                getRowId={(c) => c.id}
                minWidth={760}
                defaultSort={{ id: "spent", direction: "desc" }}
                onRowClick={(c) => navigate(`/campaigns/${c.id}/results`)}
                empty={<p className="px-3 py-3 text-sm text-fg-muted">{t("report.none")}</p>}
                columns={[
                  {
                    id: "name",
                    header: t("campaigns.campaign"),
                    cell: (c) => (
                      <a href={`/campaigns/${c.id}/results`} className="font-medium">
                        {c.name}
                      </a>
                    ),
                  },
                  { id: "spent", header: t("results.spent"), align: "right", mono: true, sortValue: (c) => c.spend, cell: (c) => tl(c.spend) },
                  { id: "visits", header: t("results.visits"), align: "right", mono: true, sortValue: (c) => c.visits, cell: (c) => num(c.visits, locale) },
                  { id: "first", header: t("results.wonFirstShort"), align: "right", mono: true, cell: (c) => `${c.first.deals}, ${tl(c.first.revenue)}` },
                  { id: "last", header: t("results.wonLastShort"), align: "right", mono: true, cell: (c) => `${c.last.deals}, ${tl(c.last.revenue)}` },
                  {
                    id: "roiFirst",
                    header: t("report.roiFirstShort"),
                    align: "right",
                    mono: true,
                    sortValue: (c) => c.first.roi ?? -1e9,
                    cell: (c) => roiText(c.first.roi),
                  },
                  {
                    id: "roiLast",
                    header: t("report.roiLastShort"),
                    align: "right",
                    mono: true,
                    sortValue: (c) => c.last.roi ?? -1e9,
                    cell: (c) => roiText(c.last.roi),
                  },
                ]}
              />
            </Panel>
            <Panel title={t(`report.revenue_${by}`)} description={t("report.fromCrm")}>
              {measured.length ? (
                <BarList
                  label={t(`report.revenue_${by}`)}
                  format={tl}
                  items={measured.map((c) => ({ id: c.id, label: c.name, value: c[by].revenue, href: `/campaigns/${c.id}/results` }))}
                />
              ) : (
                <p className="text-xs text-fg-muted">{t("results.nothingYet")}</p>
              )}
            </Panel>
          </div>
          <Panel title={t("report.byChannel")} description={t("report.byChannelDetail")} flush>
            <DataTable
              label={t("report.byChannel")}
              rows={r.channels}
              getRowId={(c) => c.id}
              minWidth={820}
              empty={<p className="px-3 py-3 text-sm text-fg-muted">{t("report.none")}</p>}
              columns={[
                { id: "name", header: t("budget.channel"), cell: (c) => <span className="font-medium">{c.name}</span> },
                { id: "campaigns", header: t("report.campaigns"), align: "right", mono: true, cell: (c) => c.campaigns },
                { id: "budget", header: t("budget.budget"), align: "right", mono: true, cell: (c) => tl(c.budget) },
                { id: "spent", header: t("results.spent"), align: "right", mono: true, cell: (c) => tl(c.spend) },
                { id: "visits", header: t("results.visits"), align: "right", mono: true, cell: (c) => num(c.visits, locale) },
                { id: "first", header: t("results.wonFirstShort"), align: "right", mono: true, cell: (c) => `${c.first.deals}, ${tl(c.first.revenue)}` },
                { id: "last", header: t("results.wonLastShort"), align: "right", mono: true, cell: (c) => `${c.last.deals}, ${tl(c.last.revenue)}` },
                { id: "roi", header: t(`report.roi_${by}`), align: "right", mono: true, cell: (c) => roiText(c[by].roi) },
              ]}
            />
          </Panel>
        </>
      )}
    </>
  );
}
