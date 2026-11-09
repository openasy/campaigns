// The calendar: every campaign over six months, by channel, with what is due next.
import { Button, cn, EmptyState, FacetFilter, FilterBar, KpiCard, KpiGrid, navigate, PageHeader, Panel, useLocalePreference } from "@openasy/ui";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { Ctx } from "./App.tsx";
import type { Campaign, Task } from "./api.ts";
import { day, dayNumber, today as localToday, money, monthName, useLoad } from "./common.tsx";
import { useT } from "./i18n.ts";
import { BAR, shownOf } from "./parts.tsx";

const MONTHS = 6;

/** The first day of the month `n` months after the month of `d`. */
function monthStart(d: string, n = 0) {
  const [y, m] = d.split("-").map(Number) as [number, number];
  const at = new Date(Date.UTC(y, m - 1 + n, 1));
  return at.toISOString().slice(0, 10);
}

function Timeline({ campaigns, from, to, today }: { campaigns: Campaign[]; from: string; to: string; today: string }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const start = dayNumber(from);
  const total = dayNumber(to) - start + 1;
  const at = (d: string) => Math.min(100, Math.max(0, ((dayNumber(d) - start) / total) * 100));
  const months = Array.from({ length: MONTHS }, (_, i) => monthStart(from, i));
  return (
    <div className="flex flex-col gap-1">
      <div aria-hidden className="cmp-timeline text-2xs text-fg-muted">
        <span />
        <span className="cmp-months border-b border-line">
          {months.map((m) => (
            <span key={m} className="border-s border-line px-1 py-1">
              {monthName(m.slice(0, 7), locale)}
              {m.endsWith("-01-01") || m === months[0] ? ` ${m.slice(0, 4)}` : ""}
            </span>
          ))}
        </span>
      </div>
      {campaigns.length ? (
        <ul aria-label={t("calendar.list")} className="cmp-list flex flex-col gap-1">
          {campaigns.map((c) => {
            const left = at(c.start);
            const right = Math.min(100, at(c.end) + 100 / total);
            const shown = shownOf(c);
            return (
              <li key={c.id} className="cmp-timeline items-center">
                <span className="flex min-w-0 flex-col pe-2">
                  <span className="truncate text-sm text-fg">{c.name}</span>
                  <span className="truncate text-2xs text-fg-muted">{c.channels.map((ch) => ch.name).join(", ") || c.utm}</span>
                </span>
                <span className="cmp-lane relative rounded-md bg-canvas">
                  {today >= from && today <= to && <span aria-hidden className="cmp-today absolute inset-y-0 bg-danger" style={{ left: `${at(today)}%` }} />}
                  <button
                    type="button"
                    aria-label={t("calendar.bar", { name: c.name, from: day(c.start, locale), to: day(c.end, locale), state: t(`state.${shown}`) })}
                    onClick={() => navigate(`/campaigns/${c.id}`)}
                    className={cn("cmp-bar absolute truncate rounded px-1.5 text-start text-2xs font-medium", BAR[shown])}
                    style={{ left: `${left}%`, width: `${Math.max(2, right - left)}%` }}
                  >
                    {c.name}
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="py-3 text-sm text-fg-muted">{t("calendar.none")}</p>
      )}
      {today >= from && today <= to && <p className="text-2xs text-fg-muted">{t("calendar.today", { day: day(today, locale) })}</p>}
    </div>
  );
}

export function CalendarPage({ call, settings, summary }: Ctx) {
  const t = useT();
  const [locale] = useLocalePreference();
  const today = summary?.today ?? localToday();
  const [offset, setOffset] = useState(-1);
  const [channels, setChannels] = useState<string[]>([]);
  const from = monthStart(today, offset);
  const to = new Date(Date.parse(`${monthStart(today, offset + MONTHS)}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const [list] = useLoad<{ campaigns: Campaign[] }>(call, `/api/v1/campaigns?${new URLSearchParams({ from, to })}`);
  const year = today.slice(0, 4);
  const [yearList] = useLoad<{ campaigns: Campaign[] }>(call, `/api/v1/campaigns?${new URLSearchParams({ from: `${year}-01-01`, to: `${year}-12-31` })}`);
  const [tasks] = useLoad<{ tasks: Task[] }>(call, "/api/v1/tasks");
  const c = settings.config;
  const tl = (n: number) => money(n, c.currency, locale);
  const all = list?.campaigns ?? [];
  const shown = all.filter((x) => x.status !== "cancelled" && (!channels.length || x.channels.some((ch) => channels.includes(ch.id))));
  const ofYear = (yearList?.campaigns ?? []).filter((x) => x.status !== "cancelled");
  const waiting = all.filter((x) => shownOf(x) === "approval");
  const soon = new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
  const coming = [
    ...all
      .filter((x) => x.status === "planned" && x.start >= today && x.start <= soon)
      .map((x) => ({
        id: `s-${x.id}`,
        at: x.start,
        what: t("calendar.starts", { name: x.name }),
        where: x.canLaunch ? t("calendar.ready") : x.blockers[0]!,
        href: `/campaigns/${x.id}`,
      })),
    ...all
      .filter((x) => x.status === "live" && x.end >= today && x.end <= soon)
      .map((x) => ({ id: `e-${x.id}`, at: x.end, what: t("calendar.ends", { name: x.name }), where: x.utm, href: `/campaigns/${x.id}` })),
    ...(tasks?.tasks ?? [])
      .filter((x) => x.due && x.due <= soon)
      .map((x) => ({
        id: `t-${x.id}`,
        at: x.due!,
        what: x.text,
        where: `${x.campaign.name}${x.owner ? ` · ${x.owner.name}` : ""}`,
        href: `/campaigns/${x.campaign.id}`,
        overdue: x.overdue,
      })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <>
      <PageHeader title={t("calendar.title")} description={t("calendar.description")} />
      <KpiGrid minWidth={170} className="mt-2.5 mb-2.5">
        <KpiCard
          label={t("calendar.budgetYear", { year })}
          value={tl(ofYear.reduce((n, x) => n + x.budget, 0))}
          delta={{ label: t("calendar.campaignsN", { count: ofYear.length }), intent: "neutral" }}
        />
        <KpiCard label={t("calendar.spent")} value={tl(ofYear.reduce((n, x) => n + x.spend, 0))} />
        <KpiCard label={t("calendar.live")} value={String(summary?.campaigns.live ?? all.filter((x) => x.status === "live").length)} />
        <KpiCard
          label={t("calendar.waiting")}
          value={String(waiting.length)}
          tone={waiting.length ? "warning" : undefined}
          delta={waiting[0] ? { label: t("calendar.startsOn", { name: waiting[0].name, day: day(waiting[0].start, locale) }), intent: "bad" } : undefined}
        />
      </KpiGrid>
      <Panel
        aria-label={t("calendar.title")}
        title={t("calendar.range", {
          from: `${monthName(from.slice(0, 7), locale, true)} ${from.slice(0, 4)}`,
          to: `${monthName(to.slice(0, 7), locale, true)} ${to.slice(0, 4)}`,
        })}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <FilterBar onClear={channels.length ? () => setChannels([]) : undefined}>
              <FacetFilter
                label={t("calendar.channel")}
                options={c.channels.map((ch) => ({ value: ch.id, label: ch.name, count: all.filter((x) => x.channels.some((y) => y.id === ch.id)).length }))}
                selected={channels}
                onChange={setChannels}
              />
            </FilterBar>
            <Button size="sm" icon={<ChevronLeft />} onClick={() => setOffset((o) => o - MONTHS)}>
              {t("calendar.earlier")}
            </Button>
            <Button size="sm" icon={<ChevronRight />} onClick={() => setOffset((o) => o + MONTHS)}>
              {t("calendar.later")}
            </Button>
          </span>
        }
      >
        {list === null ? <EmptyState title={t("common.failed")} /> : <Timeline campaigns={shown} from={from} to={to} today={today} />}
      </Panel>
      <Panel title={t("calendar.next")} description={t("calendar.nextDetail")} className="mt-2.5" flush>
        {coming.length ? (
          <ul aria-label={t("calendar.next")} className="cmp-list flex flex-col">
            {coming.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-subtle px-3 py-2 text-sm last:border-0">
                <a href={k.href} className="flex min-w-0 flex-col text-fg no-underline">
                  <span className="text-fg">{k.what}</span>
                  <span className="text-2xs text-fg-muted">{k.where}</span>
                </a>
                <span className={cn("text-xs whitespace-nowrap", "overdue" in k && k.overdue ? "text-danger-text" : "text-fg-muted")}>{day(k.at, locale)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-3 py-3 text-sm text-fg-muted">{t("calendar.nothingNext")}</p>
        )}
      </Panel>
    </>
  );
}
