// Campaigns themselves: their dates, brief, budget by channel, goals, owner and approvers, the tasks and assets of
// the work, the tagged links, and the spend entered, imported from CSV or read from the ad platforms. What the
// campaigns brought (visits, sends, won deals) is read in results.ts.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import QRCode from "qrcode";
import { AD_ENDPOINTS, googleAds, metaAds, type AdEndpoints, type AdRow, type AdsSource } from "./ads.ts";
import { configWarnings, type Channel, type Config, type ConfigFileState } from "./config.ts";
import { parseAmount, parseCsv, parseDay } from "./csv.ts";
import {
  analyticsLink,
  audienceLink,
  automationLink,
  crmLink,
  LinkError,
  messagesLink,
  type AnalyticsLink,
  type AudienceLink,
  type AutomationLink,
  type CrmLink,
  type MessagesLink,
} from "./links.ts";
import { log } from "./log.ts";
import { campaignUtm, nameCarries, slug, sourcesOf, taggedUrl, utmProblem } from "./naming.ts";
import { createResults } from "./results.ts";
import { amount, bad, body, CampaignsError, createStore, dayIn, isObj, money, notFound, optDay, optEmail, optText, text, type Actor } from "./store.ts";

export interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
}

export const STATUSES = ["planned", "live", "ended", "cancelled"] as const;
export type Status = (typeof STATUSES)[number];
export const METRICS = ["visits", "conversions", "sends", "opens", "clicks", "deals", "revenue"] as const;
export type Metric = (typeof METRICS)[number];

interface CampaignRow {
  id: string;
  name: string;
  utm: string;
  status: Status;
  start_day: string;
  end_day: string;
  brief: string | null;
  message: string | null;
  audience: string | null;
  owner_id: string | null;
  owner_name: string | null;
  budget_minor: number;
  ad_names: string;
  messages_ids: string;
  launched_at: string | null;
  ended_at: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
}
interface ApprovalRow {
  campaign_id: string;
  email: string;
  name: string | null;
  state: "waiting" | "approved" | "changes";
  note: string | null;
  decided_at: string | null;
}
interface TaskRow {
  id: string;
  campaign_id: string;
  text: string;
  channel: string | null;
  owner_id: string | null;
  owner_name: string | null;
  due_day: string | null;
  done_at: string | null;
  done_by: string | null;
  created_at: string;
}
interface LinkRow {
  id: string;
  campaign_id: string;
  channel: string;
  destination: string;
  source: string;
  medium: string;
  content: string | null;
  term: string | null;
  url: string;
  label: string | null;
  created_at: string;
  created_by: string;
}
interface SpendRow {
  id: string;
  campaign_id: string | null;
  channel: string | null;
  day: string;
  amount_minor: number;
  source: "manual" | "csv" | "google" | "meta";
  ad_campaign: string | null;
  ad_campaign_id: string | null;
  clicks: number | null;
  impressions: number | null;
  note: string | null;
  key: string | null;
  created_at: string;
  created_by: string;
}

export interface CampaignsOptions {
  /** The address people open Campaigns at, for links sent to Automation. */
  publicUrl: string;
  env?: Record<string, string | undefined>;
  clock?: () => number;
  fileState?: () => ConfigFileState | null;
  /** For tests: the links to the other products, in place of the real clients. */
  links?: Partial<{
    analytics: (c: Config) => AnalyticsLink | null;
    messages: (c: Config) => MessagesLink | null;
    crm: (c: Config) => CrmLink | null;
    audience: (c: Config) => AudienceLink | null;
    automation: (c: Config) => AutomationLink | null;
  }>;
  adEndpoints?: AdEndpoints;
}

/** How each link to another product last went, for Settings and the metrics. */
export interface LinkState {
  lastOkAt: string | null;
  lastError: string | null;
  lastTriedAt: string | null;
}

const parse = <T>(s: string | null, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

export function createCampaigns(db: DatabaseSync, opts: CampaignsOptions) {
  const clock = opts.clock ?? Date.now;
  const store = createStore(db, clock);
  const { q, one, run, tx, iso } = store;
  const env = opts.env ?? process.env;
  let config: Config | null = null;
  let configText = "";
  const linkState: Record<string, LinkState> = {};
  const state = (k: string) => (linkState[k] ??= { lastOkAt: null, lastError: null, lastTriedAt: null });
  const links: {
    analytics: AnalyticsLink | null;
    messages: MessagesLink | null;
    crm: CrmLink | null;
    audience: AudienceLink | null;
    automation: AutomationLink | null;
    ads: AdsSource[];
  } = { analytics: null, messages: null, crm: null, audience: null, automation: null, ads: [] };

  const cfg = () => {
    if (!config) throw new CampaignsError(503, "not-available", "The settings file has not been applied yet.");
    return config;
  };
  const today = () => dayIn(cfg().timeZone, clock());

  const team = (): Member[] => {
    try {
      return q<Member>("SELECT id, name, email, role FROM auth_users WHERE status != 'disabled' ORDER BY name COLLATE NOCASE");
    } catch {
      return [];
    }
  };
  const memberById = (id: string | null) => (id ? team().find((m) => m.id === id) : undefined);
  const memberByEmail = (email: string) => team().find((m) => m.email.toLowerCase() === email.toLowerCase());
  /** A member named by id or email, for owner fields. */
  function member(v: unknown, field: string): Member | null | undefined {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    if (typeof v !== "string") throw bad(`${field} is a member's id or email.`);
    const m = v.includes("@") ? memberByEmail(v) : memberById(v);
    if (!m) throw bad(`${field}: ${v} is not a member of Campaigns.`);
    return m;
  }

  function setConfig(c: Config, raw: string): string[] {
    config = c;
    configText = raw;
    const o = opts.links ?? {};
    links.analytics = o.analytics
      ? o.analytics(c)
      : c.analytics
        ? analyticsLink({ url: c.analytics.url, site: c.analytics.site, token: env[c.analytics.token] })
        : null;
    links.messages = o.messages ? o.messages(c) : c.messages ? messagesLink({ url: c.messages.url, token: env[c.messages.token] }) : null;
    links.crm = o.crm ? o.crm(c) : c.crm ? crmLink({ url: c.crm.url, token: env[c.crm.token] }) : null;
    links.audience = o.audience ? o.audience(c) : c.audience ? audienceLink({ url: c.audience.url, token: env[c.audience.token] }) : null;
    links.automation = o.automation
      ? o.automation(c)
      : c.automation?.launch
        ? automationLink({ url: c.automation.url, token: env[c.automation.launch.token] })
        : null;
    const endpoints = opts.adEndpoints ?? AD_ENDPOINTS;
    links.ads = [];
    const g = c.ads.google;
    if (g)
      links.ads.push(
        googleAds({
          customerId: g.customerId,
          loginCustomerId: g.loginCustomerId,
          apiVersion: g.apiVersion,
          developerToken: env[g.developerToken],
          clientId: env[g.clientId],
          clientSecret: env[g.clientSecret],
          refreshToken: env[g.refreshToken],
          endpoints,
        }),
      );
    if (c.ads.meta) links.ads.push(metaAds({ adAccount: c.ads.meta.adAccount, apiVersion: c.ads.meta.apiVersion, token: env[c.ads.meta.token], endpoints }));
    // Spend an ad platform reported for a channel the file no longer has keeps its row; it is matched again.
    rematchSpend();
    return configWarnings(
      c,
      env,
      team().map((m) => m.email.toLowerCase()),
    );
  }

  const channelOf = (id: string | null) => (id ? cfg().channels.find((c) => c.id === id) : undefined);
  const channelName = (id: string | null) => (id ? (channelOf(id)?.name ?? id) : null);
  function channel(v: unknown, field: string): Channel {
    const c = typeof v === "string" ? channelOf(v) : undefined;
    if (!c)
      throw bad(
        `${field} is one of the file's channels: ${cfg()
          .channels.map((x) => x.id)
          .join(", ")}.`,
      );
    return c;
  }

  function activity(campaignId: string, who: { name: string }, textOf: string) {
    run("INSERT INTO activity (campaign_id, at, by_name, text) VALUES (?, ?, ?, ?)", campaignId, iso(), who.name, textOf.slice(0, 2000));
  }

  // ------------------------------------------------------------------ campaigns

  const mustCampaign = (id: string) => {
    const r = one<CampaignRow>("SELECT * FROM campaigns WHERE id = ?", id);
    if (!r) throw notFound("The campaign");
    return r;
  };

  function approvalsOf(id: string) {
    return q<ApprovalRow>("SELECT * FROM approvals WHERE campaign_id = ? ORDER BY rowid", id).map((a) => ({
      email: a.email,
      name: memberByEmail(a.email)?.name ?? a.name ?? a.email,
      state: a.state,
      note: a.note,
      decidedAt: a.decided_at,
    }));
  }

  function spendOf(id: string) {
    return q<{ channel: string | null; n: number }>("SELECT channel, SUM(amount_minor) AS n FROM spend WHERE campaign_id = ? GROUP BY channel", id);
  }

  /** What stops a campaign being marked live: approvals not given, and its status. */
  function blockers(c: CampaignRow, approvals: ReturnType<typeof approvalsOf>): string[] {
    const b: string[] = [];
    if (c.status !== "planned") b.push(c.status === "live" ? "It is live already." : `It is ${c.status}.`);
    for (const a of approvals)
      if (a.state !== "approved") b.push(a.state === "changes" ? `${a.name} asked for changes.` : `${a.name} has not approved it yet.`);
    return b;
  }

  function campaignOut(c: CampaignRow, who: Actor) {
    const cf = cfg();
    const chans = q<{ channel: string; budget_minor: number }>(
      "SELECT channel, budget_minor FROM campaign_channels WHERE campaign_id = ? ORDER BY rowid",
      c.id,
    );
    const spent = spendOf(c.id);
    const approvals = approvalsOf(c.id);
    const counts = one<{ links: number; tasks: number; done: number; assets: number }>(
      `SELECT (SELECT COUNT(*) FROM links WHERE campaign_id = ?1) AS links, (SELECT COUNT(*) FROM tasks WHERE campaign_id = ?1) AS tasks,
         (SELECT COUNT(*) FROM tasks WHERE campaign_id = ?1 AND done_at IS NOT NULL) AS done, (SELECT COUNT(*) FROM assets WHERE campaign_id = ?1) AS assets`,
      c.id,
    )!;
    const me = memberById(who.id);
    const myApproval = me ? approvals.find((a) => a.email === me.email.toLowerCase()) : undefined;
    const b = blockers(c, approvals);
    return {
      id: c.id,
      name: c.name,
      utm: c.utm,
      status: c.status,
      start: c.start_day,
      end: c.end_day,
      brief: c.brief,
      message: c.message,
      audience: c.audience,
      owner: c.owner_id ? { id: c.owner_id, name: memberById(c.owner_id)?.name ?? c.owner_name ?? c.owner_id } : null,
      currency: cf.currency,
      budget: money(c.budget_minor),
      spend: money(spent.reduce((s, x) => s + x.n, 0)),
      channels: chans.map((ch) => ({
        id: ch.channel,
        name: channelName(ch.channel)!,
        inFile: !!channelOf(ch.channel),
        budget: money(ch.budget_minor),
        spend: money(spent.find((s) => s.channel === ch.channel)?.n ?? 0),
      })),
      goals: q<{ id: string; metric: Metric; goal: string | null; target: number }>(
        "SELECT id, metric, goal, target FROM goals WHERE campaign_id = ? ORDER BY pos",
        c.id,
      ),
      approvals,
      approved: approvals.every((a) => a.state === "approved"),
      myApproval: myApproval ? myApproval.state : null,
      canLaunch: b.length === 0,
      blockers: b,
      adNames: parse<string[]>(c.ad_names, []),
      messagesIds: parse<string[]>(c.messages_ids, []),
      counts: { links: counts.links, tasks: counts.tasks, tasksDone: counts.done, assets: counts.assets },
      launchedAt: c.launched_at,
      endedAt: c.ended_at,
      createdAt: c.created_at,
      createdBy: c.created_by,
      updatedAt: c.updated_at,
    };
  }

  function listCampaigns(who: Actor, query: URLSearchParams) {
    const from = optDay(query.get("from") ?? undefined, "from");
    const to = optDay(query.get("to") ?? undefined, "to");
    const status = query.get("status");
    if (status && !STATUSES.includes(status as Status)) throw bad(`status is ${STATUSES.join(", ")}.`);
    const ch = query.get("channel");
    const s = (query.get("q") ?? "").trim().toLocaleLowerCase("tr");
    const rows = q<CampaignRow>(
      `SELECT * FROM campaigns WHERE (?1 IS NULL OR end_day >= ?1) AND (?2 IS NULL OR start_day <= ?2) AND (?3 IS NULL OR status = ?3)
         AND (?4 IS NULL OR id IN (SELECT campaign_id FROM campaign_channels WHERE channel = ?4)) ORDER BY start_day, name COLLATE NOCASE`,
      from ?? null,
      to ?? null,
      status,
      ch,
    );
    return rows.filter((c) => !s || `${c.name} ${c.utm} ${c.owner_name ?? ""}`.toLocaleLowerCase("tr").includes(s)).map((c) => campaignOut(c, who));
  }

  function getCampaign(who: Actor, id: string) {
    const c = mustCampaign(id);
    return {
      ...campaignOut(c, who),
      links: q<LinkRow>("SELECT * FROM links WHERE campaign_id = ? ORDER BY created_at DESC", id).map((l) => linkOut(l, visitsBySource(id))),
      tasks: q<TaskRow>("SELECT * FROM tasks WHERE campaign_id = ? ORDER BY done_at IS NOT NULL, due_day IS NULL, due_day, created_at", id).map((t) =>
        taskOut(t, c),
      ),
      assets: q<{ id: string; name: string; url: string; channel: string | null; created_at: string; created_by: string }>(
        "SELECT * FROM assets WHERE campaign_id = ? ORDER BY created_at",
        id,
      ).map((a) => ({ id: a.id, name: a.name, url: a.url, channel: a.channel, createdAt: a.created_at, createdBy: a.created_by })),
      activity: q<{ at: string; by_name: string; text: string }>(
        "SELECT at, by_name, text FROM activity WHERE campaign_id = ? ORDER BY id DESC LIMIT 100",
        id,
      ).map((a) => ({ at: a.at, by: a.by_name, text: a.text })),
    };
  }

  const CAMPAIGN_FIELDS = [
    "name",
    "utm",
    "start",
    "end",
    "brief",
    "message",
    "audience",
    "owner",
    "budget",
    "channels",
    "goals",
    "approvers",
    "adNames",
    "messagesIds",
  ];

  function readChannels(v: unknown): Array<{ id: string; budgetMinor: number }> {
    if (!Array.isArray(v) || v.length > 30) throw bad("channels is a list of up to 30 channels, each an id or { id, budget }.");
    const out = v.map((x, i) => {
      const o = typeof x === "string" ? { id: x } : isObj(x) ? x : null;
      if (!o) throw bad(`channels[${i}] is a channel id or { id, budget }.`);
      const extra = Object.keys(o).filter((k) => k !== "id" && k !== "budget");
      if (extra.length) throw bad(`channels[${i}]: unknown ${extra.join(", ")}; it takes id and budget.`);
      return {
        id: channel(o.id, `channels[${i}].id`).id,
        budgetMinor: o.budget === undefined || o.budget === null ? 0 : amount(o.budget, `channels[${i}].budget`),
      };
    });
    const dup = out.find((c, i) => out.findIndex((x) => x.id === c.id) !== i);
    if (dup) throw bad(`channels: ${dup.id} is in the list twice.`);
    return out;
  }

  function readGoals(v: unknown) {
    if (!Array.isArray(v) || v.length > 20) throw bad("goals is a list of up to 20 goals, each { metric, target, goal }.");
    return v.map((g, i) => {
      const at = `goals[${i}]`;
      const o = body(g, ["metric", "target", "goal"]);
      if (!METRICS.includes(o.metric as Metric)) throw bad(`${at}.metric is ${METRICS.join(", ")}.`);
      const target = typeof o.target === "string" ? Number(o.target) : o.target;
      if (typeof target !== "number" || !Number.isFinite(target) || target <= 0 || target > 1e12) throw bad(`${at}.target is a number above 0.`);
      const goal = optText(o.goal, `${at}.goal`, 128) ?? null;
      if (o.metric === "conversions" && !goal) throw bad(`${at}.goal is the name of the Analytics goal the conversions are counted by.`);
      return { metric: o.metric as Metric, target, goal: o.metric === "conversions" ? goal : null };
    });
  }

  function readApprovers(v: unknown): Member[] {
    if (!Array.isArray(v) || v.length > 10) throw bad("approvers is a list of up to 10 members, by email or id.");
    const ms = v.map((x, i) => member(x, `approvers[${i}]`)!);
    return ms.filter((m, i) => m && ms.findIndex((x) => x.id === m.id) === i);
  }

  function readNames(v: unknown, field: string, max = 200): string[] {
    if (!Array.isArray(v) || v.length > 50) throw bad(`${field} is a list of up to 50 names or ids.`);
    return [...new Set(v.map((x, i) => text(x, `${field}[${i}]`, max)))];
  }

  function checkUtm(utm: string, except: string | null) {
    const p = utmProblem(cfg().naming, utm);
    if (p) throw bad(p);
    const other = one<{ id: string; name: string }>("SELECT id, name FROM campaigns WHERE utm = ? AND id IS NOT ?", utm, except);
    if (other) throw new CampaignsError(409, "conflict", `utm_campaign ${utm} is ${other.name}'s; one name is one campaign. Choose another name or set utm.`);
  }

  /** The utm_campaign the naming rules make for a name and start day, and whether a campaign has it already. */
  function naming(query: URLSearchParams) {
    const name = text(query.get("name") ?? undefined, "name", 120);
    const start = optDay(query.get("start") ?? undefined, "start") ?? today();
    const utm = campaignUtm(cfg().naming, name, start);
    const taken = one<{ id: string; name: string }>("SELECT id, name FROM campaigns WHERE utm = ?", utm);
    return { utm, problem: utmProblem(cfg().naming, utm), taken: taken ? { id: taken.id, name: taken.name } : null, rule: cfg().naming.campaign };
  }

  function createCampaign(who: Actor, raw: unknown) {
    const b = body(raw, CAMPAIGN_FIELDS);
    const name = text(b.name, "name", 120);
    const start = optDay(b.start, "start");
    const end = optDay(b.end, "end");
    if (!start || !end) throw bad("start and end are days, YYYY-MM-DD.");
    if (end < start) throw bad("end is on or after start.");
    const utm = b.utm === undefined || b.utm === null || b.utm === "" ? campaignUtm(cfg().naming, name, start) : text(b.utm, "utm", 64);
    const owner = b.owner === undefined ? (memberById(who.id) ?? null) : (member(b.owner, "owner") ?? null);
    const chans = b.channels === undefined ? [] : readChannels(b.channels);
    const goals = b.goals === undefined ? [] : readGoals(b.goals);
    const approvers =
      b.approvers === undefined
        ? cfg()
            .approvers.map((e) => memberByEmail(e))
            .filter((m): m is Member => !!m)
        : readApprovers(b.approvers);
    const budgetMinor = b.budget === undefined || b.budget === null ? chans.reduce((s, c) => s + c.budgetMinor, 0) : amount(b.budget, "budget");
    const adNames = b.adNames === undefined ? [] : readNames(b.adNames, "adNames");
    const messagesIds = b.messagesIds === undefined ? [] : readNames(b.messagesIds, "messagesIds", 64);
    const id = randomUUID();
    const now = iso();
    tx(() => {
      checkUtm(utm, null);
      run(
        `INSERT INTO campaigns (id, name, utm, status, start_day, end_day, brief, message, audience, owner_id, owner_name, budget_minor, ad_names, messages_ids,
           created_at, created_by, updated_at) VALUES (?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        name,
        utm,
        start,
        end,
        optText(b.brief, "brief", 20000) ?? null,
        optText(b.message, "message", 500) ?? null,
        optText(b.audience, "audience", 500) ?? null,
        owner?.id ?? null,
        owner?.name ?? null,
        budgetMinor,
        JSON.stringify(adNames),
        JSON.stringify(messagesIds),
        now,
        who.name,
        now,
      );
      for (const c of chans) run("INSERT INTO campaign_channels (campaign_id, channel, budget_minor) VALUES (?, ?, ?)", id, c.id, c.budgetMinor);
      goals.forEach((g, i) =>
        run("INSERT INTO goals (id, campaign_id, metric, goal, target, pos) VALUES (?, ?, ?, ?, ?, ?)", randomUUID(), id, g.metric, g.goal, g.target, i),
      );
      for (const a of approvers) run("INSERT INTO approvals (campaign_id, email, name, state) VALUES (?, ?, ?, 'waiting')", id, a.email.toLowerCase(), a.name);
      activity(id, who, `Planned ${name} for ${start} to ${end}, as ${utm}.`);
    });
    rematchSpend();
    return getCampaign(who, id);
  }

  function updateCampaign(who: Actor, id: string, raw: unknown) {
    const b = body(raw, CAMPAIGN_FIELDS);
    const c = mustCampaign(id);
    if (c.status === "cancelled" || c.status === "ended") {
      const allowed = ["brief", "message", "owner", "adNames", "messagesIds", "goals"];
      const locked = Object.keys(b).filter((k) => !allowed.includes(k));
      if (locked.length) throw new CampaignsError(409, "conflict", `The campaign is ${c.status}; only ${allowed.join(", ")} can change.`);
    }
    const name = b.name === undefined ? c.name : text(b.name, "name", 120);
    const start = b.start === undefined ? c.start_day : optDay(b.start, "start");
    const end = b.end === undefined ? c.end_day : optDay(b.end, "end");
    if (!start || !end) throw bad("start and end are days, YYYY-MM-DD.");
    if (end < start) throw bad("end is on or after start.");
    let utm = c.utm;
    if (b.utm !== undefined && b.utm !== c.utm) {
      const nLinks = one<{ n: number }>("SELECT COUNT(*) AS n FROM links WHERE campaign_id = ?", id)!.n;
      if (c.status !== "planned" || nLinks)
        throw new CampaignsError(409, "conflict", "utm_campaign is fixed once the campaign has links or is live, so it never reports under two names.");
      utm = b.utm === null || b.utm === "" ? campaignUtm(cfg().naming, name, start) : text(b.utm, "utm", 64);
    }
    const owner = member(b.owner, "owner");
    const chans = b.channels === undefined ? undefined : readChannels(b.channels);
    const goals = b.goals === undefined ? undefined : readGoals(b.goals);
    const approvers = b.approvers === undefined ? undefined : readApprovers(b.approvers);
    const brief = optText(b.brief, "brief", 20000);
    const message = optText(b.message, "message", 500);
    const audience = optText(b.audience, "audience", 500);
    const budgetMinor = b.budget === undefined ? c.budget_minor : b.budget === null ? 0 : amount(b.budget, "budget");
    const adNames = b.adNames === undefined ? undefined : readNames(b.adNames, "adNames");
    const messagesIds = b.messagesIds === undefined ? undefined : readNames(b.messagesIds, "messagesIds", 64);

    const before = campaignOut(c, who);
    tx(() => {
      if (utm !== c.utm) checkUtm(utm, id);
      run(
        `UPDATE campaigns SET name = ?, utm = ?, start_day = ?, end_day = ?, brief = ?, message = ?, audience = ?, owner_id = ?, owner_name = ?, budget_minor = ?,
           ad_names = ?, messages_ids = ?, updated_at = ? WHERE id = ?`,
        name,
        utm,
        start,
        end,
        brief === undefined ? c.brief : brief,
        message === undefined ? c.message : message,
        audience === undefined ? c.audience : audience,
        owner === undefined ? c.owner_id : (owner?.id ?? null),
        owner === undefined ? c.owner_name : (owner?.name ?? null),
        budgetMinor,
        adNames === undefined ? c.ad_names : JSON.stringify(adNames),
        messagesIds === undefined ? c.messages_ids : JSON.stringify(messagesIds),
        iso(),
        id,
      );
      if (chans) {
        run("DELETE FROM campaign_channels WHERE campaign_id = ?", id);
        for (const ch of chans) run("INSERT INTO campaign_channels (campaign_id, channel, budget_minor) VALUES (?, ?, ?)", id, ch.id, ch.budgetMinor);
      }
      if (goals) {
        run("DELETE FROM goals WHERE campaign_id = ?", id);
        goals.forEach((g, i) =>
          run("INSERT INTO goals (id, campaign_id, metric, goal, target, pos) VALUES (?, ?, ?, ?, ?, ?)", randomUUID(), id, g.metric, g.goal, g.target, i),
        );
      }
      if (approvers) {
        const keep = approvers.map((a) => a.email.toLowerCase());
        for (const a of q<ApprovalRow>("SELECT * FROM approvals WHERE campaign_id = ?", id))
          if (!keep.includes(a.email)) run("DELETE FROM approvals WHERE campaign_id = ? AND email = ?", id, a.email);
        for (const a of approvers)
          run("INSERT OR IGNORE INTO approvals (campaign_id, email, name, state) VALUES (?, ?, ?, 'waiting')", id, a.email.toLowerCase(), a.name);
      }
      const after = campaignOut(mustCampaign(id), who);
      const changed: string[] = [];
      if (after.name !== before.name) changed.push(`name to ${after.name}`);
      if (after.utm !== before.utm) changed.push(`utm_campaign to ${after.utm}`);
      if (after.start !== before.start || after.end !== before.end) changed.push(`dates to ${after.start} to ${after.end}`);
      if (after.brief !== before.brief) changed.push("the brief");
      if (after.message !== before.message) changed.push("the message");
      if (after.audience !== before.audience) changed.push("who it is for");
      if (after.budget !== before.budget) changed.push(`the budget to ${after.budget}`);
      if (JSON.stringify(after.channels.map((x) => [x.id, x.budget])) !== JSON.stringify(before.channels.map((x) => [x.id, x.budget])))
        changed.push("the channels");
      if (JSON.stringify(after.goals.map((g) => [g.metric, g.goal, g.target])) !== JSON.stringify(before.goals.map((g) => [g.metric, g.goal, g.target])))
        changed.push("the goals");
      if (after.owner?.id !== before.owner?.id) changed.push(`the owner to ${after.owner?.name ?? "nobody"}`);
      if (JSON.stringify(after.approvals.map((a) => a.email)) !== JSON.stringify(before.approvals.map((a) => a.email))) changed.push("the approvers");
      if (JSON.stringify(after.adNames) !== JSON.stringify(before.adNames)) changed.push("the ad campaigns");
      if (JSON.stringify(after.messagesIds) !== JSON.stringify(before.messagesIds)) changed.push("the Messages campaigns");
      if (changed.length) activity(id, who, `Changed ${changed.join(", ")}.`);
      // An approval is of the campaign as it was approved: what an approver decides on sets it back to waiting.
      const decidedOn = ["dates", "the brief", "the message", "who it is for", "the budget", "the channels", "the goals", "name", "utm_campaign"];
      const reset = c.status === "planned" && changed.some((x) => decidedOn.some((d) => x.startsWith(d)));
      if (reset && q<ApprovalRow>("SELECT * FROM approvals WHERE campaign_id = ? AND state != 'waiting'", id).length) {
        run("UPDATE approvals SET state = 'waiting', note = NULL, decided_at = NULL WHERE campaign_id = ?", id);
        activity(id, { name: "Campaigns" }, "The approvals are waiting again: what was approved changed.");
      }
    });
    if (adNames || utm !== c.utm) rematchSpend();
    return getCampaign(who, id);
  }

  function removeCampaign(who: Actor, id: string) {
    const c = mustCampaign(id);
    if (who.role !== "admin" && (c.status === "live" || c.status === "ended"))
      throw new CampaignsError(403, "forbidden", "A campaign that has run is kept with its results; an admin can delete it, or cancel it instead.");
    tx(() => {
      // Spend an ad platform reported stays, unclaimed, so it is not lost with the campaign.
      run("UPDATE spend SET campaign_id = NULL WHERE campaign_id = ? AND source IN ('google', 'meta')", id);
      run("DELETE FROM campaigns WHERE id = ?", id);
    });
    log("info", "campaign deleted", { campaign: id, utm: c.utm, by: who.name });
  }

  function decide(who: Actor, id: string, raw: unknown) {
    const b = body(raw, ["decision", "note"]);
    if (b.decision !== "approved" && b.decision !== "changes") throw bad("decision is approved or changes.");
    const note = optText(b.note, "note", 2000) ?? null;
    if (b.decision === "changes" && !note) throw bad("note says what to change.");
    const c = mustCampaign(id);
    const me = memberById(who.id);
    const a = me && one<ApprovalRow>("SELECT * FROM approvals WHERE campaign_id = ? AND email = ?", id, me.email.toLowerCase());
    if (!a) throw new CampaignsError(403, "forbidden", "Only the members the campaign names as approvers can approve it, each for themselves.");
    if (c.status !== "planned") throw new CampaignsError(409, "conflict", `The campaign is ${c.status}; approvals are for a planned campaign.`);
    tx(() => {
      run(
        "UPDATE approvals SET state = ?, note = ?, decided_at = ?, name = ? WHERE campaign_id = ? AND email = ?",
        b.decision as string,
        note,
        iso(),
        me.name,
        id,
        a.email,
      );
      activity(id, me, b.decision === "approved" ? `Approved${note ? `: ${note}` : "."}` : `Asked for changes: ${note}`);
    });
    return getCampaign(who, id);
  }

  async function launch(who: Actor, id: string) {
    const c = mustCampaign(id);
    const b = blockers(c, approvalsOf(id));
    if (b.length) throw new CampaignsError(409, "conflict", `It cannot be marked live yet. ${b.join(" ")}`);
    tx(() => {
      run("UPDATE campaigns SET status = 'live', launched_at = ?, updated_at = ? WHERE id = ?", iso(), iso(), id);
      activity(id, who, "Marked live.");
    });
    const automation = { sent: false, started: false, error: null as string | null };
    const a = cfg().automation?.launch;
    if (a && links.automation) {
      const out = campaignOut(mustCampaign(id), who);
      const s = state("automation");
      s.lastTriedAt = iso();
      try {
        automation.started = await links.automation.launch(a.playbook, {
          type: "campaign_launched",
          campaign: {
            id: out.id,
            name: out.name,
            utm: out.utm,
            start: out.start,
            end: out.end,
            owner: out.owner?.name ?? null,
            channels: out.channels.map((x) => x.id),
            budget: out.budget,
            currency: out.currency,
            url: `${opts.publicUrl}/campaigns/${out.id}`,
          },
          by: who.name,
        });
        automation.sent = true;
        s.lastOkAt = iso();
        s.lastError = null;
        activity(
          id,
          { name: "Campaigns" },
          automation.started ? "Automation started the launch playbook." : "Automation took the launch; the playbook's conditions did not hold.",
        );
      } catch (err) {
        automation.error = (err as Error).message;
        s.lastError = automation.error;
        activity(id, { name: "Campaigns" }, `Automation could not be told of the launch: ${automation.error}`);
        log("warn", "launch not sent to Automation", { campaign: id, error: automation.error });
      }
    }
    return { campaign: getCampaign(who, id), automation };
  }

  function setStatus(who: Actor, id: string, to: "ended" | "cancelled") {
    const c = mustCampaign(id);
    if (to === "ended" && c.status !== "live") throw new CampaignsError(409, "conflict", "Only a live campaign can be ended.");
    if (to === "cancelled" && c.status !== "planned" && c.status !== "live") throw new CampaignsError(409, "conflict", `The campaign is ${c.status} already.`);
    tx(() => {
      run("UPDATE campaigns SET status = ?, ended_at = ?, updated_at = ? WHERE id = ?", to, iso(), iso(), id);
      activity(id, who, to === "ended" ? "Ended." : "Cancelled.");
    });
    return getCampaign(who, id);
  }

  /** A live campaign past its end day ends; checked with each tick. */
  function endPastCampaigns() {
    if (!config) return 0;
    const t = today();
    const due = q<CampaignRow>("SELECT * FROM campaigns WHERE status = 'live' AND end_day < ?", t);
    for (const c of due)
      tx(() => {
        run("UPDATE campaigns SET status = 'ended', ended_at = ?, updated_at = ? WHERE id = ?", iso(), iso(), c.id);
        activity(c.id, { name: "Campaigns" }, `Ended: its end day, ${c.end_day}, has passed.`);
      });
    return due.length;
  }

  // ------------------------------------------------------------------ links

  /** Visits Analytics counted with each utm_source and utm_medium of a campaign, from its last read. */
  function visitsBySource(campaignId: string): Map<string, number> | null {
    const r = one<{ data: string }>("SELECT data FROM results WHERE campaign_id = ?", campaignId);
    const data = parse<{
      analytics: { bySource: Array<{ source: string | null; medium: string | null; campaign: string | null; visits: number }> } | null;
    } | null>(r?.data ?? null, null);
    if (!data?.analytics) return null;
    const m = new Map<string, number>();
    for (const x of data.analytics.bySource) m.set(`${x.source}|${x.medium}|${x.campaign}`, (m.get(`${x.source}|${x.medium}|${x.campaign}`) ?? 0) + x.visits);
    return m;
  }

  const linkOut = (l: LinkRow, visits?: Map<string, number> | null) => ({
    id: l.id,
    campaign: l.campaign_id,
    channel: l.channel,
    channelName: channelName(l.channel),
    destination: l.destination,
    source: l.source,
    medium: l.medium,
    content: l.content,
    term: l.term,
    url: l.url,
    label: l.label,
    qr: `/api/v1/links/${l.id}/qr`,
    visits: visits ? (visits.get(`${l.source}|${l.medium}|${utmOf(l.campaign_id)}`) ?? 0) : null,
    createdAt: l.created_at,
    createdBy: l.created_by,
  });
  const utmOf = (campaignId: string) => one<{ utm: string }>("SELECT utm FROM campaigns WHERE id = ?", campaignId)?.utm ?? "";

  function listLinks(query: URLSearchParams) {
    const campaign = query.get("campaign");
    const rows = q<LinkRow>("SELECT * FROM links WHERE (?1 IS NULL OR campaign_id = ?1) ORDER BY created_at DESC LIMIT 2000", campaign);
    const visits = new Map<string, Map<string, number> | null>();
    return rows.map((l) => {
      if (!visits.has(l.campaign_id)) visits.set(l.campaign_id, visitsBySource(l.campaign_id));
      return {
        ...linkOut(l, visits.get(l.campaign_id)),
        campaignName: one<{ name: string }>("SELECT name FROM campaigns WHERE id = ?", l.campaign_id)?.name ?? "",
      };
    });
  }

  function createLink(who: Actor, campaignId: string, raw: unknown) {
    const b = body(raw, ["destination", "channel", "source", "content", "term", "label"]);
    const c = mustCampaign(campaignId);
    if (c.status === "cancelled" || c.status === "ended") throw new CampaignsError(409, "conflict", `The campaign is ${c.status}; it takes no new links.`);
    const destination = text(b.destination, "destination", 2000);
    const u = URL.parse(destination);
    if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) throw bad("destination is an http:// or https:// address.");
    const ch = channel(b.channel, "channel");
    const allowed = sourcesOf(cfg(), ch);
    const source = b.source === undefined || b.source === null || b.source === "" ? allowed[0] : String(b.source);
    if (!source || !allowed.includes(source))
      throw bad(`source is one of the utm_source values ${ch.name} links may carry: ${allowed.join(", ") || "none in the file (naming.sources)"}.`);
    const opt = (v: unknown, field: string) => {
      const s = optText(v, field, 100);
      const v2 = s ? slug(s) : null;
      if (s && !v2) throw bad(`${field} needs letters or digits.`);
      return v2;
    };
    const content = opt(b.content, "content");
    const term = opt(b.term, "term");
    const url = taggedUrl(u.toString(), { source, medium: ch.medium, campaign: c.utm, content, term });
    const label = optText(b.label, "label", 120) ?? null;
    const existing = one<LinkRow>("SELECT * FROM links WHERE url = ?", url);
    if (existing) return { status: 200, link: linkOut(existing, visitsBySource(existing.campaign_id)) };
    const id = randomUUID();
    tx(() => {
      run(
        `INSERT INTO links (id, campaign_id, channel, destination, source, medium, content, term, url, label, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        campaignId,
        ch.id,
        u.toString(),
        source,
        ch.medium,
        content,
        term,
        url,
        label,
        iso(),
        who.name,
      );
      activity(campaignId, who, `Made a ${ch.name} link to ${u.host}${u.pathname} (utm_source ${source}${content ? `, utm_content ${content}` : ""}).`);
    });
    return { status: 201, link: linkOut(one<LinkRow>("SELECT * FROM links WHERE id = ?", id)!, visitsBySource(campaignId)) };
  }

  function removeLink(who: Actor, id: string) {
    const l = one<LinkRow>("SELECT * FROM links WHERE id = ?", id);
    if (!l) throw notFound("The link");
    tx(() => {
      run("DELETE FROM links WHERE id = ?", id);
      activity(l.campaign_id, who, `Deleted the link ${l.url}; anyone who has it still reaches the page under the campaign's name.`);
    });
  }

  async function linkQr(id: string, format: string | null) {
    const l = one<LinkRow>("SELECT * FROM links WHERE id = ?", id);
    if (!l) throw notFound("The link");
    const name = `${one<{ utm: string }>("SELECT utm FROM campaigns WHERE id = ?", l.campaign_id)!.utm}-${l.channel}${l.content ? `-${l.content}` : ""}`;
    if (format === "png")
      return { type: "image/png", name: `${name}.png`, body: await QRCode.toBuffer(l.url, { type: "png", errorCorrectionLevel: "M", margin: 2, width: 1024 }) };
    if (format !== null && format !== "svg") throw bad("format is svg or png.");
    return { type: "image/svg+xml", name: `${name}.svg`, body: await QRCode.toString(l.url, { type: "svg", errorCorrectionLevel: "M", margin: 2 }) };
  }

  // ------------------------------------------------------------------ tasks and assets

  function taskOut(t: TaskRow, c?: CampaignRow) {
    const camp = c ?? one<CampaignRow>("SELECT * FROM campaigns WHERE id = ?", t.campaign_id)!;
    const t0 = today();
    return {
      id: t.id,
      campaign: { id: camp.id, name: camp.name },
      text: t.text,
      channel: t.channel,
      owner: t.owner_id ? { id: t.owner_id, name: memberById(t.owner_id)?.name ?? t.owner_name ?? t.owner_id } : null,
      due: t.due_day,
      overdue: !t.done_at && !!t.due_day && t.due_day < t0,
      doneAt: t.done_at,
      doneBy: t.done_by,
      createdAt: t.created_at,
    };
  }

  function listTasks(who: Actor, query: URLSearchParams) {
    const owner = query.get("owner");
    const open = query.get("open") !== "false";
    return q<TaskRow>("SELECT * FROM tasks WHERE (? = 0 OR done_at IS NULL) ORDER BY due_day IS NULL, due_day, created_at", open ? 1 : 0)
      .filter((t) => !owner || (owner === "me" ? t.owner_id === who.id : owner === "none" ? !t.owner_id : t.owner_id === owner))
      .map((t) => taskOut(t));
  }

  function createTask(who: Actor, campaignId: string, raw: unknown) {
    const b = body(raw, ["text", "owner", "due", "channel"]);
    const c = mustCampaign(campaignId);
    const owner = member(b.owner, "owner") ?? null;
    const ch = b.channel === undefined || b.channel === null ? null : channel(b.channel, "channel").id;
    const id = randomUUID();
    tx(() => {
      run(
        "INSERT INTO tasks (id, campaign_id, text, channel, owner_id, owner_name, due_day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        campaignId,
        text(b.text, "text", 500),
        ch,
        owner?.id ?? null,
        owner?.name ?? null,
        optDay(b.due, "due") ?? null,
        iso(),
      );
      activity(c.id, who, `Added the task ${String(b.text).trim().slice(0, 200)}.`);
    });
    return taskOut(one<TaskRow>("SELECT * FROM tasks WHERE id = ?", id)!);
  }

  function updateTask(who: Actor, id: string, raw: unknown) {
    const b = body(raw, ["text", "owner", "due", "channel", "done"]);
    const t = one<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
    if (!t) throw notFound("The task");
    if (b.done !== undefined && typeof b.done !== "boolean") throw bad("done is true or false.");
    const owner = member(b.owner, "owner");
    const ch = b.channel === undefined ? t.channel : b.channel === null ? null : channel(b.channel, "channel").id;
    const due = optDay(b.due, "due");
    const done = b.done === undefined ? t.done_at : b.done ? (t.done_at ?? iso()) : null;
    tx(() => {
      run(
        "UPDATE tasks SET text = ?, owner_id = ?, owner_name = ?, due_day = ?, channel = ?, done_at = ?, done_by = ? WHERE id = ?",
        b.text === undefined ? t.text : text(b.text, "text", 500),
        owner === undefined ? t.owner_id : (owner?.id ?? null),
        owner === undefined ? t.owner_name : (owner?.name ?? null),
        due === undefined ? t.due_day : due,
        ch,
        done,
        done ? (b.done === true && !t.done_at ? who.name : t.done_by) : null,
        id,
      );
      if (b.done === true && !t.done_at) activity(t.campaign_id, who, `Done: ${t.text}`);
    });
    return taskOut(one<TaskRow>("SELECT * FROM tasks WHERE id = ?", id)!);
  }

  function removeTask(_who: Actor, id: string) {
    if (!run("DELETE FROM tasks WHERE id = ?", id).changes) throw notFound("The task");
  }

  function createAsset(who: Actor, campaignId: string, raw: unknown) {
    const b = body(raw, ["name", "url", "channel"]);
    mustCampaign(campaignId);
    const url = text(b.url, "url", 2000);
    const u = URL.parse(url);
    if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) throw bad("url is an http:// or https:// address, such as the file in Files.");
    const ch = b.channel === undefined || b.channel === null ? null : channel(b.channel, "channel").id;
    const id = randomUUID();
    const name = text(b.name, "name", 200);
    tx(() => {
      run(
        "INSERT INTO assets (id, campaign_id, name, url, channel, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id,
        campaignId,
        name,
        u.toString(),
        ch,
        iso(),
        who.name,
      );
      activity(campaignId, who, `Added ${name}.`);
    });
    return { id, name, url: u.toString(), channel: ch, createdAt: iso(), createdBy: who.name };
  }

  function removeAsset(_who: Actor, id: string) {
    if (!run("DELETE FROM assets WHERE id = ?", id).changes) throw notFound("The asset");
  }

  // ------------------------------------------------------------------ spend

  const spendOut = (s: SpendRow) => {
    const c = s.campaign_id ? one<{ id: string; name: string; utm: string }>("SELECT id, name, utm FROM campaigns WHERE id = ?", s.campaign_id) : undefined;
    return {
      id: s.id,
      campaign: c ? { id: c.id, name: c.name, utm: c.utm } : null,
      channel: s.channel,
      channelName: channelName(s.channel),
      day: s.day,
      amount: money(s.amount_minor),
      source: s.source,
      adCampaign: s.ad_campaign,
      adCampaignId: s.ad_campaign_id,
      clicks: s.clicks,
      impressions: s.impressions,
      note: s.note,
      createdAt: s.created_at,
      createdBy: s.created_by,
    };
  };

  function listSpend(query: URLSearchParams) {
    const campaign = query.get("campaign");
    const from = optDay(query.get("from") ?? undefined, "from") ?? null;
    const to = optDay(query.get("to") ?? undefined, "to") ?? null;
    const unmatched = query.get("unmatched") === "true";
    const rows = q<SpendRow>(
      `SELECT * FROM spend WHERE (?1 IS NULL OR campaign_id = ?1) AND (?2 IS NULL OR day >= ?2) AND (?3 IS NULL OR day <= ?3) AND (?4 = 0 OR campaign_id IS NULL)
         ORDER BY day DESC, created_at DESC LIMIT 2000`,
      campaign,
      from,
      to,
      unmatched ? 1 : 0,
    );
    const um = one<{ n: number; total: number | null }>("SELECT COUNT(*) AS n, SUM(amount_minor) AS total FROM spend WHERE campaign_id IS NULL")!;
    return { spend: rows.map(spendOut), unmatched: { rows: um.n, amount: money(um.total ?? 0) }, currency: cfg().currency };
  }

  function addSpend(who: Actor, raw: unknown) {
    const b = body(raw, ["campaign", "channel", "day", "amount", "note"]);
    const c = mustCampaign(text(b.campaign, "campaign", 64));
    const ch = channel(b.channel, "channel");
    const day = optDay(b.day, "day");
    if (!day) throw bad("day is a day, YYYY-MM-DD.");
    const minor = amount(b.amount, "amount");
    if (!minor) throw bad("amount is more than 0.");
    const id = randomUUID();
    tx(() => {
      run(
        "INSERT INTO spend (id, campaign_id, channel, day, amount_minor, source, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?)",
        id,
        c.id,
        ch.id,
        day,
        minor,
        optText(b.note, "note", 300) ?? null,
        iso(),
        who.name,
      );
      activity(c.id, who, `Entered ${money(minor)} ${cfg().currency} spent on ${ch.name} on ${day}.`);
    });
    return spendOut(one<SpendRow>("SELECT * FROM spend WHERE id = ?", id)!);
  }

  function removeSpend(_who: Actor, id: string) {
    const s = one<SpendRow>("SELECT * FROM spend WHERE id = ?", id);
    if (!s) throw notFound("The spend");
    if (s.source === "google" || s.source === "meta")
      throw new CampaignsError(
        409,
        "conflict",
        "Spend read from an ad platform is replaced by the platform's own figures at the next read; it cannot be deleted here.",
      );
    run("DELETE FROM spend WHERE id = ?", id);
  }

  /** Gives an ad platform's campaign to one of ours: its name joins adNames, and its spend moves with it. */
  function assignSpend(who: Actor, id: string, raw: unknown) {
    const b = body(raw, ["campaign"]);
    const s = one<SpendRow>("SELECT * FROM spend WHERE id = ?", id);
    if (!s) throw notFound("The spend");
    if (!s.ad_campaign)
      throw new CampaignsError(409, "conflict", "Only spend read from an ad platform is assigned; other spend names its campaign when it is entered.");
    const c = mustCampaign(text(b.campaign, "campaign", 64));
    const names = parse<string[]>(c.ad_names, []);
    // Other campaigns stop claiming it, so the spend is one campaign's.
    for (const o of q<CampaignRow>("SELECT * FROM campaigns WHERE id != ?", c.id)) {
      const theirs = parse<string[]>(o.ad_names, []);
      const rest = theirs.filter((n) => n !== s.ad_campaign && n !== s.ad_campaign_id);
      if (rest.length !== theirs.length) run("UPDATE campaigns SET ad_names = ? WHERE id = ?", JSON.stringify(rest), o.id);
    }
    if (!names.includes(s.ad_campaign)) {
      run("UPDATE campaigns SET ad_names = ?, updated_at = ? WHERE id = ?", JSON.stringify([...names, s.ad_campaign]), iso(), c.id);
      activity(c.id, who, `Claimed the spend of the ${s.source === "google" ? "Google Ads" : "Meta"} campaign ${s.ad_campaign}.`);
    }
    rematchSpend();
    return spendOut(one<SpendRow>("SELECT * FROM spend WHERE id = ?", id)!);
  }

  /** Which of our campaigns an ad platform's campaign is: one that names it, else the one whose utm_campaign its name carries. */
  function matchAd(adName: string, adId: string | null, campaigns: CampaignRow[]): CampaignRow | undefined {
    const named = campaigns.find((c) => parse<string[]>(c.ad_names, []).some((n) => n === adName || (adId !== null && n === adId)));
    if (named) return named;
    // The longest utm_campaign wins, so autumn-2026-retargeting is not autumn-2026's.
    return campaigns.filter((c) => nameCarries(adName, c.utm)).sort((a, b) => b.utm.length - a.utm.length)[0];
  }

  /** Matches every ad platform's spend again, after a campaign's utm_campaign or adNames changed. */
  function rematchSpend() {
    if (!config) return;
    const campaigns = q<CampaignRow>("SELECT * FROM campaigns");
    tx(() => {
      for (const s of q<SpendRow>("SELECT * FROM spend WHERE source IN ('google', 'meta')")) {
        const c = matchAd(s.ad_campaign ?? "", s.ad_campaign_id, campaigns);
        if ((c?.id ?? null) !== s.campaign_id) run("UPDATE spend SET campaign_id = ? WHERE id = ?", c?.id ?? null, s.id);
      }
    });
  }

  /** Writes what an ad platform reported: each ad campaign's day replaces what was there. */
  function storeAdRows(platform: "google" | "meta", rows: AdRow[], from: string, to: string) {
    const c = cfg();
    const ch = c.channels.find((x) => x.ads === platform)?.id ?? null;
    const campaigns = q<CampaignRow>("SELECT * FROM campaigns");
    let matched = 0;
    let unmatched = 0;
    const skipped = rows.filter((r) => r.currency && r.currency !== c.currency);
    tx(() => {
      // A day the platform no longer reports (spend corrected to 0) goes.
      const keep = new Set(rows.filter((r) => !skipped.includes(r)).map((r) => `${platform}:${r.account}:${r.adCampaignId}:${r.day}`));
      for (const old of q<{ id: string; key: string }>("SELECT id, key FROM spend WHERE source = ? AND day >= ? AND day <= ?", platform, from, to))
        if (!keep.has(old.key)) run("DELETE FROM spend WHERE id = ?", old.id);
      for (const r of rows) {
        if (skipped.includes(r)) continue;
        const m = matchAd(r.adCampaign, r.adCampaignId, campaigns);
        if (m) matched++;
        else unmatched++;
        run(
          `INSERT INTO spend (id, campaign_id, channel, day, amount_minor, source, ad_campaign, ad_campaign_id, clicks, impressions, key, created_at, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (key) DO UPDATE SET campaign_id = excluded.campaign_id, channel = excluded.channel, amount_minor = excluded.amount_minor,
               ad_campaign = excluded.ad_campaign, clicks = excluded.clicks, impressions = excluded.impressions`,
          randomUUID(),
          m?.id ?? null,
          ch,
          r.day,
          r.amountMinor,
          platform,
          r.adCampaign,
          r.adCampaignId,
          r.clicks,
          r.impressions,
          `${platform}:${r.account}:${r.adCampaignId}:${r.day}`,
          iso(),
          platform === "google" ? "Google Ads" : "Meta",
        );
      }
    });
    return { rows: rows.length - skipped.length, matched, unmatched, otherCurrency: skipped.length };
  }

  let lastAds = 0;
  let adsRunning: Promise<unknown> | null = null;
  /** Reads every linked ad platform for the file's ads.days, and says what each gave. */
  async function syncAds() {
    if (adsRunning) return adsRunning as ReturnType<typeof readAds>;
    adsRunning = readAds();
    try {
      return await (adsRunning as ReturnType<typeof readAds>);
    } finally {
      adsRunning = null;
    }
  }
  async function readAds() {
    const c = cfg();
    const to = today();
    const from = new Date(Date.parse(`${to}T00:00:00Z`) - (c.ads.days - 1) * 86_400_000).toISOString().slice(0, 10);
    lastAds = clock();
    const out: Array<{ platform: "google" | "meta"; rows: number; matched: number; unmatched: number; otherCurrency: number; error: string | null }> = [];
    for (const src of links.ads) {
      const s = state(src.platform);
      s.lastTriedAt = iso();
      try {
        const rows = await src.spend(from, to);
        const r = storeAdRows(src.platform, rows, from, to);
        if (r.otherCurrency)
          log("warn", "ad spend in another currency left out", {
            platform: src.platform,
            rows: r.otherCurrency,
            currency: rows.find((x) => x.currency !== c.currency)?.currency,
          });
        s.lastOkAt = iso();
        s.lastError = r.otherCurrency ? `${r.otherCurrency} rows are in another currency than ${c.currency} and were left out.` : null;
        out.push({ platform: src.platform, ...r, error: s.lastError });
      } catch (err) {
        s.lastError = (err as Error).message;
        log("warn", "ad spend not read", { platform: src.platform, error: s.lastError, permanent: err instanceof LinkError && err.permanent });
        out.push({ platform: src.platform, rows: 0, matched: 0, unmatched: 0, otherCurrency: 0, error: s.lastError });
      }
    }
    return { from, to, platforms: out };
  }

  const SPEND_COLUMNS = ["day", "campaign", "channel", "amount", "note"];
  /** A CSV of spend, a row a day, campaign and channel. The same campaign, channel and day replaces what CSV gave before. */
  function importSpend(who: Actor, raw: unknown) {
    const b = body(raw, ["csv", "check"]);
    if (typeof b.csv !== "string" || !b.csv.trim()) throw bad("csv is the file's text, with a header line.");
    if (b.check !== undefined && typeof b.check !== "boolean") throw bad("check is true or false.");
    const rows = parseCsv(b.csv);
    const header = (rows.shift() ?? []).map((h) =>
      h
        .trim()
        .toLowerCase()
        .replace(/^date$/, "day")
        .replace(/^cost$|^spend$/, "amount"),
    );
    const missing = ["day", "campaign", "channel", "amount"].filter((k) => !header.includes(k));
    if (missing.length) throw bad(`The header line needs ${missing.join(", ")}; it takes ${SPEND_COLUMNS.join(", ")} (date, cost and spend are read too).`);
    if (rows.length > 20_000) throw bad("Up to 20000 rows at once.");
    const campaigns = q<CampaignRow>("SELECT * FROM campaigns");
    const errors: Array<{ line: number; error: string }> = [];
    const good: Array<{ c: CampaignRow; ch: Channel; day: string; minor: number; note: string | null }> = [];
    rows.forEach((r, i) => {
      const line = i + 2;
      const get = (k: string) => (r[header.indexOf(k)] ?? "").trim();
      const day = parseDay(get("day"));
      const ref = get("campaign");
      const c = campaigns.find((x) => x.utm === ref.toLowerCase() || x.id === ref || x.name.toLocaleLowerCase("tr") === ref.toLocaleLowerCase("tr"));
      const chRaw = get("channel");
      const ch = cfg().channels.find((x) => x.id === chRaw.toLowerCase() || x.name.toLowerCase() === chRaw.toLowerCase() || x.medium === chRaw.toLowerCase());
      const minor = parseAmount(get("amount"));
      if (!day) return errors.push({ line, error: `day ${JSON.stringify(get("day"))} is not a day such as 2026-10-05 or 05.10.2026.` });
      if (!c) return errors.push({ line, error: `campaign ${JSON.stringify(ref)} is no campaign's utm_campaign, id or name.` });
      if (!ch)
        return errors.push({
          line,
          error: `channel ${JSON.stringify(chRaw)} is not one of ${cfg()
            .channels.map((x) => x.id)
            .join(", ")}.`,
        });
      if (minor === null || minor < 0) return errors.push({ line, error: `amount ${JSON.stringify(get("amount"))} is not an amount such as 1250,50.` });
      good.push({ c, ch, day, minor, note: header.includes("note") ? get("note").slice(0, 300) || null : null });
    });
    let added = 0;
    let replaced = 0;
    if (!b.check)
      tx(() => {
        for (const g of good) {
          const key = `csv:${g.c.id}:${g.ch.id}:${g.day}`;
          const had = one<{ id: string }>("SELECT id FROM spend WHERE key = ?", key);
          if (had) {
            run("UPDATE spend SET amount_minor = ?, note = ?, created_at = ?, created_by = ? WHERE id = ?", g.minor, g.note, iso(), who.name, had.id);
            replaced++;
          } else {
            run(
              "INSERT INTO spend (id, campaign_id, channel, day, amount_minor, source, note, key, created_at, created_by) VALUES (?, ?, ?, ?, ?, 'csv', ?, ?, ?, ?)",
              randomUUID(),
              g.c.id,
              g.ch.id,
              g.day,
              g.minor,
              g.note,
              key,
              iso(),
              who.name,
            );
            added++;
          }
        }
        for (const id of new Set(good.map((g) => g.c.id))) activity(id, who, `Imported spend from CSV: ${good.filter((g) => g.c.id === id).length} rows.`);
      });
    return { check: !!b.check, rows: rows.length, valid: good.length, added, replaced, errors: errors.slice(0, 200) };
  }

  // ------------------------------------------------------------------ results

  const results = createResults({
    store,
    cfg: () => cfg(),
    hasConfig: () => !!config,
    today: () => today(),
    links,
    state,
    channelOf: (id) => channelOf(id),
    campaignOut,
  });

  // ------------------------------------------------------------------ overview, settings, erasure

  function summary(who: Actor) {
    const c = cfg();
    const t = today();
    const month = t.slice(0, 7);
    const by = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
    for (const r of q<{ status: Status; n: number }>("SELECT status, COUNT(*) AS n FROM campaigns GROUP BY status")) by[r.status] = r.n;
    const me = memberById(who.id);
    const waiting = me
      ? q<CampaignRow>(
          "SELECT c.* FROM campaigns c JOIN approvals a ON a.campaign_id = c.id WHERE a.email = ? AND a.state = 'waiting' AND c.status = 'planned' ORDER BY c.start_day",
          me.email.toLowerCase(),
        ).map((x) => ({ id: x.id, name: x.name, start: x.start_day }))
      : [];
    const tasks = q<TaskRow>("SELECT * FROM tasks WHERE owner_id = ? AND done_at IS NULL", who.id);
    const spent = one<{ n: number | null }>("SELECT SUM(amount_minor) AS n FROM spend WHERE day LIKE ? AND campaign_id IS NOT NULL", `${month}-%`)!.n ?? 0;
    const budget =
      one<{ n: number | null }>(
        "SELECT SUM(budget_minor) AS n FROM campaigns WHERE status != 'cancelled' AND start_day <= ? AND end_day >= ?",
        `${month}-31`,
        `${month}-01`,
      )!.n ?? 0;
    const um = one<{ n: number; total: number | null }>("SELECT COUNT(*) AS n, SUM(amount_minor) AS total FROM spend WHERE campaign_id IS NULL")!;
    const starting = q<CampaignRow>("SELECT * FROM campaigns WHERE status = 'planned' AND start_day >= ? ORDER BY start_day LIMIT 5", t).map((x) => ({
      id: x.id,
      name: x.name,
      start: x.start_day,
      canLaunch: blockers(x, approvalsOf(x.id)).length === 0,
    }));
    return {
      today: t,
      currency: c.currency,
      campaigns: by,
      waitingForMe: waiting,
      startingSoon: starting,
      myTasks: { open: tasks.length, overdue: tasks.filter((x) => x.due_day && x.due_day < t).length },
      month: { month, spend: money(spent), budget: money(budget) },
      unmatchedSpend: { rows: um.n, amount: money(um.total ?? 0) },
      linked: {
        analytics: !!c.analytics,
        messages: !!c.messages,
        crm: !!c.crm,
        audience: !!c.audience,
        automation: !!c.automation?.launch,
        google: !!c.ads.google,
        meta: !!c.ads.meta,
      },
      readAt: results.lastReadAt(),
      fileError: opts.fileState?.()?.error ?? null,
    };
  }

  function settings() {
    const c = config;
    return {
      file: opts.fileState?.() ?? null,
      yaml: configText,
      config: c && {
        currency: c.currency,
        timeZone: c.timeZone,
        channels: c.channels.map((ch) => ({ ...ch, sources: sourcesOf(c, ch) })),
        naming: { campaign: c.naming.campaign, pattern: c.naming.patternText, maxLength: c.naming.maxLength, sources: c.naming.sources },
        approvers: c.approvers,
        attribution: { windowDays: c.attributionDays },
        results: { everyMinutes: c.syncMinutes, settleDays: c.settleDays },
        ads: { everyMinutes: c.ads.everyMinutes, days: c.ads.days },
      },
    };
  }

  function integrations() {
    const c = config;
    const linkInfo = (k: string, linked: boolean, url: string | null, tokens: string[]) => ({
      linked,
      url,
      tokenSet: linked && tokens.every((t) => !!env[t]),
      ...state(k),
    });
    return {
      analytics: {
        ...linkInfo("analytics", !!c?.analytics, c?.analytics?.url ?? null, c?.analytics ? [c.analytics.token] : []),
        site: c?.analytics?.site ?? null,
      },
      messages: linkInfo("messages", !!c?.messages, c?.messages?.url ?? null, c?.messages ? [c.messages.token] : []),
      crm: { ...linkInfo("crm", !!c?.crm, c?.crm?.url ?? null, c?.crm ? [c.crm.token] : []), pipeline: c?.crm?.pipeline ?? null },
      audience: linkInfo("audience", !!c?.audience, c?.audience?.url ?? null, c?.audience ? [c.audience.token] : []),
      automation: {
        ...linkInfo("automation", !!c?.automation?.launch, c?.automation?.url ?? null, c?.automation?.launch ? [c.automation.launch.token] : []),
        playbook: c?.automation?.launch?.playbook ?? null,
      },
      google: {
        ...linkInfo(
          "google",
          !!c?.ads.google,
          c?.ads.google ? `customers/${c.ads.google.customerId}` : null,
          c?.ads.google ? [c.ads.google.developerToken, c.ads.google.clientId, c.ads.google.clientSecret, c.ads.google.refreshToken] : [],
        ),
      },
      meta: linkInfo("meta", !!c?.ads.meta, c?.ads.meta ? `act_${c.ads.meta.adAccount}` : null, c?.ads.meta ? [c.ads.meta.token] : []),
    };
  }

  /** Audience's deletion of a person: the won deals kept with their email go; CRM is asked by Audience itself. */
  function erase(raw: unknown) {
    const b = body(raw, ["reference", "product", "people"]);
    const reference = text(b.reference, "reference", 200);
    const done = one<{ deleted: number }>("SELECT deleted FROM erasures WHERE reference = ?", reference);
    if (done) return { status: "done", deleted: done.deleted };
    const p = isObj(b.people) ? b.people : null;
    if (!p) throw bad("people is { emails, phones, userIds }.");
    const emails = (Array.isArray(p.emails) ? p.emails : []).map((e, i) => optEmail(e, `people.emails[${i}]`)).filter((e): e is string => !!e);
    let deleted = 0;
    tx(() => {
      for (const e of emails) deleted += Number(run("DELETE FROM deals WHERE email = ?", e).changes);
      run("INSERT INTO erasures (reference, at, deleted) VALUES (?, ?, ?)", reference, iso(), deleted);
    });
    return { status: "done", deleted };
  }

  function gauges() {
    const by: Record<string, number> = {};
    for (const r of q<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM campaigns GROUP BY status")) by[r.status] = r.n;
    const um = one<{ n: number }>("SELECT COUNT(*) AS n FROM spend WHERE campaign_id IS NULL")!.n;
    const errors: Record<string, number> = {};
    for (const [k, s] of Object.entries(linkState)) errors[k] = s.lastError ? 1 : 0;
    return { campaigns: by, unmatchedSpend: um, linkErrors: errors, deals: one<{ n: number }>("SELECT COUNT(*) AS n FROM deals")!.n };
  }

  let lastSync = 0;
  /** Every 15 seconds from main.ts: ends campaigns past their end day, and reads results and spend when they are due. */
  async function tick() {
    if (!config) return;
    endPastCampaigns();
    const now = clock();
    if (now - lastSync >= config.syncMinutes * 60_000) {
      lastSync = now;
      await results.sync().catch((err) => log("error", "results not read", { error: String(err) }));
    }
    if (links.ads.length && now - lastAds >= config.ads.everyMinutes * 60_000)
      await syncAds().catch((err) => log("error", "ad spend not read", { error: String(err) }));
  }

  return {
    store,
    config: () => config,
    setConfig,
    team,
    summary,
    settings,
    integrations,
    naming,
    listCampaigns,
    getCampaign,
    createCampaign,
    updateCampaign,
    removeCampaign,
    decide,
    launch,
    end: (who: Actor, id: string) => setStatus(who, id, "ended"),
    cancel: (who: Actor, id: string) => setStatus(who, id, "cancelled"),
    endPastCampaigns,
    listLinks,
    createLink,
    removeLink,
    linkQr,
    listTasks,
    createTask,
    updateTask,
    removeTask,
    createAsset,
    removeAsset,
    listSpend,
    addSpend,
    removeSpend,
    assignSpend,
    importSpend,
    syncAds,
    results: (who: Actor, id: string) => results.campaignResults(mustCampaign(id), who),
    report: (who: Actor, query: URLSearchParams) => results.report(who, query),
    attribution: (query: URLSearchParams) => results.attribution(query),
    sync: () => results.sync(),
    erase,
    gauges,
    tick,
  };
}

export type Campaigns = ReturnType<typeof createCampaigns>;
export type CampaignOut = ReturnType<ReturnType<typeof createCampaigns>["getCampaign"]>;
