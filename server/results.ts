// What campaigns brought, read from the linked products and kept, so a page never waits on another product:
//
// - Visits, visitors and goals from Analytics for the campaign's utm_campaign (and the slugs of the Messages
//   campaigns it claims), by channel through utm_medium.
// - Sends, opens and clicks of the Messages campaigns whose slug is the campaign's utm_campaign, or that it claims.
// - Won deals from CRM, each with its touches: the lead's own source in CRM, and from Audience the tagged visits and
//   message clicks of the deal's contact in the attribution window before it was won. A deal counts for the first
//   campaign that touched it and for the last, both shown and never split between them.
//
// Results are read every results.every; a campaign that ended more than results.settle days ago keeps what was read
// last. Analytics reports at most the last 90 days, so a longer campaign's visits are its last 90 days.
import type { Channel, Config } from "./config.ts";
import type { AnalyticsDays, AnalyticsLink, AnalyticsResult, AudienceLink, CrmLink, MessagesCampaign, MessagesLink, Touch } from "./links.ts";
import { log } from "./log.ts";
import { addDays, bad, DAY, daysBetween, money, optDay, type Actor, type Store } from "./store.ts";

interface CampaignRow {
  id: string;
  name: string;
  utm: string;
  status: string;
  start_day: string;
  end_day: string;
  budget_minor: number;
  messages_ids: string;
  launched_at: string | null;
  ended_at: string | null;
}
interface DealRow {
  id: string;
  name: string;
  value_minor: number;
  currency: string;
  won_at: string;
  company: string | null;
  email: string | null;
  url: string | null;
  stamp: string;
  touches: string;
  read_at: string;
}

/** What is kept of a campaign's last read. */
export interface ResultData {
  window: { days: AnalyticsDays; from: string; to: string; partial: boolean } | null;
  analytics: Omit<AnalyticsResult, "days" | "from" | "to"> | null;
  messages: MessagesCampaign[] | null;
  errors: { analytics: string | null; messages: string | null };
}

export interface ResultsContext {
  store: Store;
  cfg: () => Config;
  hasConfig: () => boolean;
  today: () => string;
  links: { analytics: AnalyticsLink | null; messages: MessagesLink | null; crm: CrmLink | null; audience: AudienceLink | null };
  state: (k: string) => { lastOkAt: string | null; lastError: string | null; lastTriedAt: string | null };
  channelOf: (id: string | null) => Channel | undefined;
  campaignOut: (c: never, who: Actor) => { channels: Array<{ id: string; name: string; budget: number }>; budget: number; goals: Goal[] };
}

interface Goal {
  id: string;
  metric: string;
  goal: string | null;
  target: number;
}

/** A touch with what it names: one of our campaigns and one of the file's channels. */
interface Placed {
  at: string;
  campaign: string;
  channel: string | null;
  via: Touch["via"] | "crm";
}

const parse = <T>(s: string | null, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

const UTM_LIKE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/** The Analytics period that covers a campaign from its start to today: the shortest of 1, 7, 30 and 90 days. */
export function analyticsDays(start: string, today: string): { days: AnalyticsDays; partial: boolean } {
  const need = Math.max(1, daysBetween(start, today) + 1);
  const days = ([1, 7, 30, 90] as const).find((d) => d >= need) ?? 90;
  return { days, partial: need > 90 };
}

/** (revenue - cost) / cost; null without cost. */
export const roi = (revenueMinor: number, costMinor: number) => (costMinor > 0 ? Math.round(((revenueMinor - costMinor) / costMinor) * 10_000) / 10_000 : null);

export function createResults(ctx: ResultsContext) {
  const { q, one, run, tx, iso } = ctx.store;
  let readAt: string | null = null;
  let running: Promise<SyncResult> | null = null;

  /** utm_campaign values and Messages slugs, to the campaign they are. */
  function utmMap(): Map<string, string> {
    const m = new Map<string, string>();
    for (const [slug, id] of Object.entries(
      parse<Record<string, string>>(one<{ value: string }>("SELECT value FROM settings WHERE key = 'aliases'")?.value ?? null, {}),
    ))
      m.set(slug, id);
    for (const c of q<{ id: string; utm: string }>("SELECT id, utm FROM campaigns")) m.set(c.utm, c.id);
    return m;
  }

  function channelOfTouch(t: Touch | { via: "crm"; medium: null }): string | null {
    if (!t.medium) return null;
    const chans = ctx.cfg().channels;
    const c = t.via === "message" ? chans.find((x) => x.messages === t.medium) : chans.find((x) => x.medium === t.medium);
    return c?.id ?? null;
  }

  /** Each deal with its first and last touch that names one of our campaigns. */
  function attributed(map = utmMap()) {
    return q<DealRow>("SELECT * FROM deals ORDER BY won_at DESC, id").map((d) => {
      const placed: Placed[] = parse<Array<Touch | (Omit<Touch, "via" | "medium"> & { via: "crm"; medium: null })>>(d.touches, [])
        .map((t) => ({ at: t.at, campaign: map.get(t.utm) ?? "", channel: channelOfTouch(t as Touch), via: t.via }))
        .filter((t) => t.campaign)
        .sort((a, b) => a.at.localeCompare(b.at));
      return { deal: d, first: placed[0] ?? null, last: placed.at(-1) ?? null, touches: placed.length };
    });
  }
  type Attributed = ReturnType<typeof attributed>[number];

  const campaignName = (id: string) => one<{ id: string; name: string; utm: string }>("SELECT id, name, utm FROM campaigns WHERE id = ?", id) ?? null;
  const touchOut = (t: Placed | null) =>
    t && {
      campaign: campaignName(t.campaign) ?? { id: t.campaign, name: t.campaign, utm: t.campaign },
      channel: t.channel,
      channelName: t.channel ? (ctx.channelOf(t.channel)?.name ?? t.channel) : null,
      at: t.at,
      via: t.via,
    };
  const dealOut = (a: Attributed) => ({
    id: a.deal.id,
    name: a.deal.name,
    value: money(a.deal.value_minor),
    currency: a.deal.currency,
    counted: a.deal.currency === ctx.cfg().currency,
    wonAt: a.deal.won_at,
    company: a.deal.company,
    url: a.deal.url,
    first: touchOut(a.first),
    last: touchOut(a.last),
    touches: a.touches,
  });

  /** One campaign's figures: what it brought and what it cost, by channel. */
  function figures(c: CampaignRow, data: ResultData | null, all: Attributed[]) {
    const cf = ctx.cfg();
    const counted = (a: Attributed) => a.deal.currency === cf.currency;
    // A deal in another currency than the file's is listed with the campaign, and counted in neither deals nor revenue.
    const firsts = all.filter((a) => a.first?.campaign === c.id && counted(a));
    const lasts = all.filter((a) => a.last?.campaign === c.id && counted(a));
    const sum = (xs: Attributed[]) => xs.reduce((s, a) => s + a.deal.value_minor, 0);
    const spendBy = new Map(
      q<{ channel: string | null; n: number }>("SELECT channel, SUM(amount_minor) AS n FROM spend WHERE campaign_id = ? GROUP BY channel", c.id).map((r) => [
        r.channel,
        r.n,
      ]),
    );
    const spend = [...spendBy.values()].reduce((s, n) => s + n, 0);
    const budgets = new Map(
      q<{ channel: string; budget_minor: number }>("SELECT channel, budget_minor FROM campaign_channels WHERE campaign_id = ?", c.id).map((r) => [
        r.channel,
        r.budget_minor,
      ]),
    );
    const visitsBy = new Map<string | null, { visits: number; visitors: number }>();
    for (const r of data?.analytics?.byMedium ?? []) {
      const ch = r.medium ? (cf.channels.find((x) => x.medium === r.medium)?.id ?? null) : null;
      const v = visitsBy.get(ch) ?? { visits: 0, visitors: 0 };
      visitsBy.set(ch, { visits: v.visits + r.visits, visitors: v.visitors + r.visitors });
    }
    const msgBy = new Map<string | null, { sent: number; opened: number; clicked: number }>();
    for (const m of data?.messages ?? []) {
      const ch = cf.channels.find((x) => x.messages === m.channel)?.id ?? null;
      const v = msgBy.get(ch) ?? { sent: 0, opened: 0, clicked: 0 };
      msgBy.set(ch, { sent: v.sent + m.sent, opened: v.opened + m.opened, clicked: v.clicked + m.clicked });
    }
    const ids = new Set<string | null>([...budgets.keys(), ...spendBy.keys(), ...visitsBy.keys(), ...msgBy.keys()]);
    for (const a of firsts) ids.add(a.first!.channel);
    for (const a of lasts) ids.add(a.last!.channel);
    const order = (id: string | null) => {
      const i = cf.channels.findIndex((x) => x.id === id);
      return id === null ? 1e9 : budgets.has(id) ? i : 1e6 + i;
    };
    const channels = [...ids]
      .sort((a, b) => order(a) - order(b))
      .map((id) => {
        const f = firsts.filter((a) => a.first?.channel === id);
        const l = lasts.filter((a) => a.last?.channel === id);
        const s = spendBy.get(id) ?? 0;
        return {
          id,
          name: id ? (ctx.channelOf(id)?.name ?? id) : null,
          planned: id !== null && budgets.has(id),
          budget: money(budgets.get(id ?? "") ?? 0),
          spend: money(s),
          visits: visitsBy.get(id)?.visits ?? 0,
          visitors: visitsBy.get(id)?.visitors ?? 0,
          sent: msgBy.get(id)?.sent ?? 0,
          opened: msgBy.get(id)?.opened ?? 0,
          clicked: msgBy.get(id)?.clicked ?? 0,
          first: { deals: f.length, revenue: money(sum(f)) },
          last: { deals: l.length, revenue: money(sum(l)) },
        };
      });
    const m = data?.messages ?? [];
    const totals = {
      budget: money(c.budget_minor),
      spend: money(spend),
      visits: data?.analytics?.visits ?? 0,
      visitors: data?.analytics?.visitors ?? 0,
      engagedVisits: data?.analytics?.engagedVisits ?? 0,
      sent: m.reduce((s, x) => s + x.sent, 0),
      delivered: m.reduce((s, x) => s + x.delivered, 0),
      opened: m.reduce((s, x) => s + x.opened, 0),
      clicked: m.reduce((s, x) => s + x.clicked, 0),
      first: { deals: firsts.length, revenue: money(sum(firsts)), roi: roi(sum(firsts), spend) },
      last: { deals: lasts.length, revenue: money(sum(lasts)), roi: roi(sum(lasts), spend) },
      costPerVisit: spend && data?.analytics?.visits ? money(Math.round(spend / data.analytics.visits)) : null,
    };
    return { totals, channels, firsts, lasts };
  }

  function dataOf(id: string) {
    const r = one<{ data: string; read_at: string; frozen: number }>("SELECT data, read_at, frozen FROM results WHERE campaign_id = ?", id);
    return r ? { data: parse<ResultData | null>(r.data, null), readAt: r.read_at, frozen: !!r.frozen } : null;
  }

  function campaignResults(c: CampaignRow, who: Actor) {
    const kept = dataOf(c.id);
    const all = attributed();
    const f = figures(c, kept?.data ?? null, all);
    const out = ctx.campaignOut(c as never, who);
    const goal = (g: Goal) => {
      const t = f.totals;
      const actual: Record<string, number | null> = {
        visits: t.visits,
        sends: t.sent,
        opens: t.opened,
        clicks: t.clicked,
        conversions: kept?.data?.analytics ? (kept.data.analytics.goals.find((x) => x.name === g.goal)?.visits ?? 0) : null,
        deals: t.last.deals,
        revenue: t.last.revenue,
      };
      const first: Record<string, number> = { deals: t.first.deals, revenue: t.first.revenue };
      const a = actual[g.metric] ?? null;
      return {
        ...g,
        actual: a,
        actualFirst: first[g.metric] ?? null,
        share: a === null ? null : Math.round((a / g.target) * 10_000) / 10_000,
      };
    };
    return {
      campaign: { id: c.id, name: c.name, utm: c.utm, status: c.status, start: c.start_day, end: c.end_day },
      currency: ctx.cfg().currency,
      readAt: kept?.readAt ?? null,
      frozen: kept?.frozen ?? false,
      window: kept?.data?.window ?? null,
      errors: kept?.data?.errors ?? { analytics: null, messages: null },
      linked: { analytics: !!ctx.links.analytics, messages: !!ctx.links.messages, crm: !!ctx.links.crm, audience: !!ctx.links.audience },
      totals: f.totals,
      channels: f.channels,
      goals: out.goals.map(goal),
      analyticsGoals: kept?.data?.analytics?.goals ?? [],
      series: kept?.data?.analytics?.series ?? [],
      sources: kept?.data?.analytics?.bySource ?? [],
      messages: (kept?.data?.messages ?? []).map((m) => ({ ...m, channelName: ctx.cfg().channels.find((x) => x.messages === m.channel)?.name ?? m.channel })),
      deals: all.filter((a) => a.first?.campaign === c.id || a.last?.campaign === c.id).map(dealOut),
    };
  }

  function period(query: URLSearchParams) {
    const t = ctx.today();
    const to = optDay(query.get("to") ?? undefined, "to") ?? t;
    const from = optDay(query.get("from") ?? undefined, "from") ?? addDays(to, -89);
    if (from > to) throw bad("from is on or before to.");
    return { from, to };
  }

  /** The campaigns that ran in a period, each with its whole results, by campaign and by channel. */
  function report(_who: Actor, query: URLSearchParams) {
    const cf = ctx.cfg();
    const { from, to } = period(query);
    const campaigns = q<CampaignRow>(
      "SELECT * FROM campaigns WHERE status != 'cancelled' AND start_day <= ? AND end_day >= ? ORDER BY start_day, name COLLATE NOCASE",
      to,
      from,
    );
    const all = attributed();
    const rows = campaigns.map((c) => {
      const kept = dataOf(c.id);
      const f = figures(c, kept?.data ?? null, all);
      return { c, f, readAt: kept?.readAt ?? null };
    });
    const sumMinor = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x * 100, 0));
    const channelTotals = cf.channels
      .map((ch) => {
        const cs = rows.flatMap((r) => r.f.channels.filter((x) => x.id === ch.id));
        const spend = sumMinor(cs.map((x) => x.spend));
        const fr = sumMinor(cs.map((x) => x.first.revenue));
        const lr = sumMinor(cs.map((x) => x.last.revenue));
        return {
          id: ch.id,
          name: ch.name,
          campaigns: cs.length,
          budget: money(sumMinor(cs.map((x) => x.budget))),
          spend: money(spend),
          visits: cs.reduce((s, x) => s + x.visits, 0),
          sent: cs.reduce((s, x) => s + x.sent, 0),
          opened: cs.reduce((s, x) => s + x.opened, 0),
          clicked: cs.reduce((s, x) => s + x.clicked, 0),
          first: { deals: cs.reduce((s, x) => s + x.first.deals, 0), revenue: money(fr), roi: roi(fr, spend) },
          last: { deals: cs.reduce((s, x) => s + x.last.deals, 0), revenue: money(lr), roi: roi(lr, spend) },
        };
      })
      .filter((x) => x.campaigns > 0);
    const spend = sumMinor(rows.map((r) => r.f.totals.spend));
    const fr = sumMinor(rows.map((r) => r.f.totals.first.revenue));
    const lr = sumMinor(rows.map((r) => r.f.totals.last.revenue));
    const wonIn = all.filter((a) => a.deal.won_at.slice(0, 10) >= from && a.deal.won_at.slice(0, 10) <= to && a.deal.currency === cf.currency);
    const none = wonIn.filter((a) => !a.first);
    return {
      from,
      to,
      currency: cf.currency,
      readAt,
      campaigns: rows.map(({ c, f, readAt: r }) => ({
        id: c.id,
        name: c.name,
        utm: c.utm,
        status: c.status,
        start: c.start_day,
        end: c.end_day,
        readAt: r,
        ...f.totals,
      })),
      channels: channelTotals,
      totals: {
        budget: money(sumMinor(rows.map((r) => r.f.totals.budget))),
        spend: money(spend),
        visits: rows.reduce((s, r) => s + r.f.totals.visits, 0),
        sent: rows.reduce((s, r) => s + r.f.totals.sent, 0),
        first: { deals: rows.reduce((s, r) => s + r.f.totals.first.deals, 0), revenue: money(fr), roi: roi(fr, spend) },
        last: { deals: rows.reduce((s, r) => s + r.f.totals.last.deals, 0), revenue: money(lr), roi: roi(lr, spend) },
      },
      wonInPeriod: { deals: wonIn.length, revenue: money(wonIn.reduce((s, a) => s + a.deal.value_minor, 0)) },
      notAttributed: { deals: none.length, revenue: money(none.reduce((s, a) => s + a.deal.value_minor, 0)) },
    };
  }

  /** Won deals in a period with the first and the last campaign that touched each. */
  function attribution(query: URLSearchParams) {
    const { from, to } = period(query);
    const campaign = query.get("campaign");
    const all = attributed().filter((a) => a.deal.won_at.slice(0, 10) >= from && a.deal.won_at.slice(0, 10) <= to);
    return {
      from,
      to,
      currency: ctx.cfg().currency,
      windowDays: ctx.cfg().attributionDays,
      deals: all.filter((a) => !campaign || a.first?.campaign === campaign || a.last?.campaign === campaign).map(dealOut),
    };
  }

  interface SyncResult {
    readAt: string;
    campaigns: number;
    deals: number;
    touchesRead: number;
    errors: Record<string, string>;
  }

  /** Reads Analytics, Messages, CRM and Audience now. Two calls at once share one read. */
  async function sync(): Promise<SyncResult> {
    if (running) return running;
    running = readAll();
    try {
      return await running;
    } finally {
      running = null;
    }
  }

  async function readAll(): Promise<SyncResult> {
    const cf = ctx.cfg();
    const t = ctx.today();
    const errors: Record<string, string> = {};
    const tried = (k: string) => (ctx.state(k).lastTriedAt = iso());
    const ok = (k: string) => Object.assign(ctx.state(k), { lastOkAt: iso(), lastError: null });
    const failed = (k: string, err: unknown) => {
      const msg = (err as Error).message;
      ctx.state(k).lastError = msg;
      errors[k] = msg;
      return msg;
    };

    // Messages: one read for every campaign.
    let messages: MessagesCampaign[] | null = null;
    let messagesError: string | null = null;
    if (ctx.links.messages) {
      tried("messages");
      try {
        messages = await ctx.links.messages.campaigns();
        ok("messages");
      } catch (err) {
        messagesError = failed("messages", err);
      }
    }
    const campaigns = q<CampaignRow>("SELECT * FROM campaigns");
    if (messages) {
      // The Messages campaigns each of ours claims, by slug or by id; their slugs count as its utm_campaign.
      const aliases: Record<string, string> = {};
      for (const c of campaigns) for (const m of messages) if (m.slug !== c.utm && parse<string[]>(c.messages_ids, []).includes(m.id)) aliases[m.slug] = c.id;
      run("INSERT INTO settings (key, value) VALUES ('aliases', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", JSON.stringify(aliases));
    }

    // Analytics, for each campaign that has started and is not settled.
    const frozen = new Set(q<{ campaign_id: string }>("SELECT campaign_id FROM results WHERE frozen = 1").map((r) => r.campaign_id));
    const due = campaigns.filter((c) => !frozen.has(c.id) && c.start_day <= t && (c.status !== "cancelled" || c.launched_at));
    if (ctx.links.analytics && due.length) tried("analytics");
    let analyticsOk = 0;
    for (const c of due) {
      const mine = messages?.filter((m) => m.slug === c.utm || parse<string[]>(c.messages_ids, []).includes(m.id)) ?? null;
      const utms = [...new Set([c.utm, ...(mine ?? []).map((m) => m.slug)])];
      const before = dataOf(c.id)?.data ?? null;
      const data: ResultData = {
        window: null,
        analytics: before?.analytics ?? null,
        messages: mine ?? before?.messages ?? null,
        errors: { analytics: null, messages: messagesError },
      };
      if (ctx.links.analytics) {
        const { days, partial } = analyticsDays(c.start_day, t);
        try {
          const a = await ctx.links.analytics.campaign(utms, days);
          data.analytics = {
            visits: a.visits,
            visitors: a.visitors,
            engagedVisits: a.engagedVisits,
            series: a.series,
            goals: a.goals,
            byMedium: a.byMedium,
            bySource: a.bySource,
          };
          data.window = { days, from: a.from, to: a.to, partial };
          analyticsOk++;
        } catch (err) {
          data.errors.analytics = failed("analytics", err);
          data.window = before?.window ?? null;
        }
      }
      const endDay = c.ended_at && c.ended_at.slice(0, 10) < c.end_day ? c.ended_at.slice(0, 10) : c.end_day;
      const settled = (c.status === "ended" || c.status === "cancelled") && t > addDays(endDay, cf.settleDays);
      run(
        `INSERT INTO results (campaign_id, data, read_at, frozen) VALUES (?, ?, ?, ?)
           ON CONFLICT (campaign_id) DO UPDATE SET data = excluded.data, read_at = excluded.read_at, frozen = excluded.frozen`,
        c.id,
        JSON.stringify(data),
        iso(),
        settled ? 1 : 0,
      );
    }
    if (ctx.links.analytics && analyticsOk && !errors.analytics) ok("analytics");

    // CRM and Audience: the won deals and what touched them.
    let dealCount = one<{ n: number }>("SELECT COUNT(*) AS n FROM deals")!.n;
    let touchesRead = 0;
    if (ctx.links.crm) {
      tried("crm");
      try {
        const won = await ctx.links.crm.wonDeals(cf.crm?.pipeline ?? null);
        ok("crm");
        const known = new Map(q<DealRow>("SELECT * FROM deals").map((d) => [d.id, d]));
        const recent = new Date(Date.parse(`${t}T00:00:00Z`) - 7 * DAY).toISOString();
        let budget = 200;
        if (ctx.links.audience) tried("audience");
        let audienceFailed = false;
        for (const d of won) {
          const valueMinor = Math.round(d.value * 100);
          const stamp = `${valueMinor}|${d.currency}|${d.wonAt}|${d.sourceDetail ?? ""}|${d.email ?? ""}`;
          const had = known.get(d.id);
          known.delete(d.id);
          // Touches are read again while Audience may still be catching up: for a week after the deal was won.
          const due = !had || had.stamp !== stamp || (d.wonAt >= recent && Date.parse(had.read_at) <= ctx.store.clock() - cf.syncMinutes * 60_000);
          if (!due) {
            run("UPDATE deals SET name = ?, company = ? WHERE id = ?", d.name, d.company, d.id);
            continue;
          }
          const touches: Array<Touch | { at: string; utm: string; medium: null; via: "crm" }> = [];
          const source = d.sourceDetail?.toLowerCase();
          if (source && UTM_LIKE.test(source)) touches.push({ at: d.createdAt, utm: source, medium: null, via: "crm" });
          // Without an answer from Audience, a deal read before keeps what it had and is read again next time.
          let complete = true;
          if (ctx.links.audience && d.email) {
            if (budget <= 0 || audienceFailed) complete = false;
            else {
              budget--;
              try {
                const since = new Date(Date.parse(d.wonAt) - cf.attributionDays * DAY).toISOString();
                touches.push(...(await ctx.links.audience.touches(d.email, since, d.wonAt)));
                touchesRead++;
              } catch (err) {
                failed("audience", err);
                audienceFailed = true;
                complete = false;
              }
            }
          }
          if (!complete && had) continue;
          run(
            `INSERT INTO deals (id, name, value_minor, currency, won_at, company, email, url, stamp, touches, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (id) DO UPDATE SET name = excluded.name, value_minor = excluded.value_minor, currency = excluded.currency, won_at = excluded.won_at,
                 company = excluded.company, email = excluded.email, url = excluded.url, stamp = excluded.stamp, touches = excluded.touches, read_at = excluded.read_at`,
            d.id,
            d.name,
            valueMinor,
            d.currency,
            d.wonAt,
            d.company,
            d.email,
            ctx.links.crm.dealUrl(d.id),
            complete ? stamp : "",
            JSON.stringify(touches),
            iso(),
          );
        }
        if (ctx.links.audience && !audienceFailed) ok("audience");
        // Deals that are no longer won (reopened, deleted) count for nothing.
        tx(() => {
          for (const id of known.keys()) run("DELETE FROM deals WHERE id = ?", id);
        });
        dealCount = won.length;
      } catch (err) {
        failed("crm", err);
      }
    }
    readAt = iso();
    if (Object.keys(errors).length) log("warn", "results read with errors", { errors });
    return { readAt, campaigns: due.length, deals: dealCount, touchesRead, errors };
  }

  return { sync, campaignResults, report, attribution, lastReadAt: () => readAt };
}
