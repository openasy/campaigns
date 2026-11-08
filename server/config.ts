// Campaigns' settings, from one YAML file (CAMPAIGNS_CONFIG): the currency, the channels campaigns run on and the
// utm_medium each tags its links with, the naming rules utm_campaign values are made by, who approves by default,
// how far back a won deal's touches are read, and the links to Analytics, Messages, CRM, Audience, Automation and the
// ad platforms spend is read from. As in the other products, the file is the only way in: no screen or API route
// changes these. It is applied whole or not at all, read again within a minute of a change, and a file with a mistake
// leaves the last good version in place. Campaigns, their links, tasks and spend are kept in the database.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { parse } from "yaml";

export type MessagesChannel = "email" | "sms" | "whatsapp";
export type AdPlatform = "google" | "meta";

export interface Channel {
  id: string;
  name: string;
  /** The utm_medium its links carry; visits with it count for this channel. */
  medium: string;
  /** The utm_source values its links may carry; empty for any of naming.sources. */
  sources: string[];
  /** The Messages channel whose campaigns' sends roll up here. */
  messages: MessagesChannel | null;
  /** The ad platform whose spend lands here. */
  ads: AdPlatform | null;
}

export interface Naming {
  /** How utm_campaign is made, such as {name}-{year}. */
  campaign: string;
  /** What every utm_campaign must match, beyond the characters allowed. */
  pattern: RegExp | null;
  patternText: string | null;
  maxLength: number;
  /** utm_source values any channel's links may carry. */
  sources: string[];
}

export interface Link {
  url: string;
  /** The name of the environment variable that holds the token. */
  token: string;
}

export interface Config {
  currency: string;
  timeZone: string;
  channels: Channel[];
  naming: Naming;
  /** Members (by email) every new campaign names as approvers. */
  approvers: string[];
  /** Days before a deal was won in which a touch counts. */
  attributionDays: number;
  /** Days after a campaign ends that its results are still read; after that they stay as they were. */
  settleDays: number;
  /** Minutes between reads of Analytics, Messages and CRM. */
  syncMinutes: number;
  analytics: (Link & { site: string }) | null;
  messages: Link | null;
  crm: (Link & { pipeline: string | null }) | null;
  audience: Link | null;
  automation: { url: string; launch: { playbook: string; token: string } | null } | null;
  ads: {
    /** Minutes between reads of the ad platforms. */
    everyMinutes: number;
    /** Days back each read covers; spend of those days is replaced by what the platform says now. */
    days: number;
    google: {
      customerId: string;
      loginCustomerId: string | null;
      developerToken: string;
      clientId: string;
      clientSecret: string;
      refreshToken: string;
      apiVersion: string;
    } | null;
    meta: { adAccount: string; token: string; apiVersion: string } | null;
  };
}

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
const UTM = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const TOP = [
  "currency",
  "time_zone",
  "channels",
  "naming",
  "approvals",
  "attribution",
  "results",
  "analytics",
  "messages",
  "crm",
  "audience",
  "automation",
  "ads",
];
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function keys(v: Record<string, unknown>, at: string, allowed: string[]) {
  const extra = Object.keys(v).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`${at}: unknown ${extra.join(", ")}; it takes ${allowed.join(", ")}.`);
}

function text(v: unknown, at: string, max = 80): string {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error(`${at} is a text of 1 to ${max} characters.`);
  return v.trim();
}

function env(v: unknown, at: string): string {
  if (typeof v !== "string" || !ENV.test(v))
    throw new Error(`${at} is the name of an environment variable, such as CAMPAIGNS_CRM_TOKEN, never the secret itself.`);
  return v;
}

function utmValue(v: unknown, at: string): string {
  if (typeof v !== "string" || !UTM.test(v)) throw new Error(`${at} is a UTM value: lowercase letters, digits, - _ and ., such as newsletter.`);
  return v;
}

/** 30m, 2h, 14d: a duration in minutes. */
export function minutesOf(v: unknown, at: string, units = "mhd"): number {
  const m = /^(\d{1,5})\s*([mhd])$/.exec(String(v ?? "").trim());
  if (!m || !units.includes(m[2]!)) {
    const examples = { m: "30m", h: "4h", d: "14d" } as Record<string, string>;
    throw new Error(`${at} is a duration such as ${[...units].map((u) => examples[u]).join(" or ")}.`);
  }
  return Number(m[1]) * { m: 1, h: 60, d: 1440 }[m[2] as "m" | "h" | "d"];
}

/** An address of another product: https://, or http:// inside the install (localhost, or a host without dots). */
function baseUrl(raw: unknown, at: string): string {
  const url = typeof raw === "string" ? URL.parse(raw.trim()) : null;
  const inside = url && (/^(localhost|127\.0\.0\.1)$/.test(url.hostname) || !url.hostname.includes("."));
  if (!url || (url.protocol !== "https:" && !(url.protocol === "http:" && inside)) || url.search || url.hash)
    throw new Error(`${at} is an https:// address, such as https://crm.example.com (http:// only for a host without dots, such as http://crm:8080).`);
  return url.origin + url.pathname.replace(/\/$/, "");
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
function email(v: unknown, at: string): string {
  if (typeof v !== "string" || !EMAIL.test(v.trim()) || v.length > 254) throw new Error(`${at} is an email address.`);
  return v.trim().toLowerCase();
}

function link(v: unknown, at: string, defaultToken: string, extra: string[] = []): Link & { raw: Record<string, unknown> } {
  if (!isObj(v)) throw new Error(`${at} is a map with url and token${extra.length ? `, ${extra.join(", ")}` : ""}.`);
  keys(v, at, ["url", "token", ...extra]);
  return { url: baseUrl(v.url, `${at}.url`), token: v.token === undefined ? defaultToken : env(v.token, `${at}.token`), raw: v };
}

const TEMPLATE_TOKENS = ["name", "year", "quarter", "month"];

const DEFAULT_CHANNELS: Channel[] = [
  { id: "email", name: "Email", medium: "email", sources: [], messages: "email", ads: null },
  { id: "sms", name: "SMS", medium: "sms", sources: [], messages: "sms", ads: null },
  { id: "whatsapp", name: "WhatsApp", medium: "whatsapp", sources: [], messages: "whatsapp", ads: null },
  { id: "paid-search", name: "Paid search", medium: "cpc", sources: ["google"], messages: null, ads: "google" },
  { id: "paid-social", name: "Paid social", medium: "paid-social", sources: ["meta", "instagram", "facebook"], messages: null, ads: "meta" },
  { id: "social", name: "Social", medium: "social", sources: [], messages: null, ads: null },
  { id: "events", name: "Events and print", medium: "offline", sources: [], messages: null, ads: null },
];

/** Reads the file's text. Throws with the field at fault, so one message says what to fix. */
export function parseConfig(raw: string): Config {
  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (err) {
    throw new Error(`Not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (doc === null || doc === undefined) doc = {};
  if (!isObj(doc)) throw new Error(`The file is a map of ${TOP.join(", ")}.`);
  keys(doc, "The file", TOP);

  const currency = doc.currency === undefined ? "TRY" : String(doc.currency).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("currency is a three-letter ISO 4217 code, such as TRY or EUR.");
  const timeZone = doc.time_zone === undefined ? "Europe/Istanbul" : text(doc.time_zone, "time_zone", 64);
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    throw new Error(`time_zone: ${timeZone} is not a time zone, such as Europe/Istanbul.`);
  }

  // Naming rules.
  const nm = doc.naming ?? {};
  if (!isObj(nm)) throw new Error("naming is a map with campaign, pattern, max_length and sources.");
  keys(nm, "naming", ["campaign", "pattern", "max_length", "sources"]);
  const template = nm.campaign === undefined ? "{name}-{year}" : text(nm.campaign, "naming.campaign", 80);
  const tokens = [...template.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]!);
  const unknown = tokens.filter((t) => !TEMPLATE_TOKENS.includes(t));
  if (unknown.length) throw new Error(`naming.campaign: {${unknown[0]}} is not one of ${TEMPLATE_TOKENS.map((t) => `{${t}}`).join(", ")}.`);
  if (!tokens.includes("name")) throw new Error("naming.campaign needs {name}, such as {name}-{year}.");
  if (/[^a-z0-9_.{}-]/.test(template.replace(/\{[^}]*\}/g, "")))
    throw new Error("naming.campaign: outside the {tokens}, only lowercase letters, digits, - _ and . are allowed.");
  let pattern: RegExp | null = null;
  let patternText: string | null = null;
  if (nm.pattern !== undefined && nm.pattern !== null) {
    patternText = text(nm.pattern, "naming.pattern", 200);
    try {
      pattern = new RegExp(`^(?:${patternText})$`);
    } catch {
      throw new Error("naming.pattern is a regular expression every utm_campaign must match, such as [a-z0-9-]+-20\\d\\d.");
    }
  }
  const maxLength = nm.max_length ?? 40;
  if (!Number.isInteger(maxLength) || (maxLength as number) < 8 || (maxLength as number) > 64) throw new Error("naming.max_length is 8 to 64.");
  const srcs = nm.sources ?? ["newsletter", "partner", "website"];
  if (!Array.isArray(srcs) || srcs.length > 100) throw new Error("naming.sources is a list of up to 100 utm_source values, such as [newsletter, partner].");
  const sources = [...new Set(srcs.map((s, i) => utmValue(s, `naming.sources[${i}]`)))];

  // Channels.
  let channels: Channel[] = DEFAULT_CHANNELS;
  if (doc.channels !== undefined && doc.channels !== null) {
    const cs = doc.channels;
    if (!isObj(cs) || Object.keys(cs).length < 1 || Object.keys(cs).length > 30)
      throw new Error("channels is a map of 1 to 30 channels, such as email: { name: Email, medium: email, messages: email }.");
    channels = Object.entries(cs).map(([id, v]) => {
      const at = `channels.${id}`;
      if (!ID.test(id)) throw new Error(`${at}: a channel id is up to 32 lowercase letters, digits and -.`);
      if (!isObj(v)) throw new Error(`${at} is a map with name, medium, sources, messages and ads.`);
      keys(v, at, ["name", "medium", "sources", "messages", "ads"]);
      const s = v.sources ?? [];
      if (!Array.isArray(s) || s.length > 30) throw new Error(`${at}.sources is a list of up to 30 utm_source values.`);
      if (v.messages !== undefined && v.messages !== null && !["email", "sms", "whatsapp"].includes(v.messages as string))
        throw new Error(`${at}.messages is email, sms or whatsapp: the Messages channel whose sends count here.`);
      if (v.ads !== undefined && v.ads !== null && !["google", "meta"].includes(v.ads as string))
        throw new Error(`${at}.ads is google or meta: the ad platform whose spend lands here.`);
      return {
        id,
        name: v.name === undefined ? id : text(v.name, `${at}.name`, 40),
        medium: utmValue(v.medium ?? id, `${at}.medium`),
        sources: [...new Set(s.map((x, i) => utmValue(x, `${at}.sources[${i}]`)))],
        messages: (v.messages ?? null) as MessagesChannel | null,
        ads: (v.ads ?? null) as AdPlatform | null,
      };
    });
  }
  const dupMedium = channels.find((c, i) => channels.findIndex((x) => x.medium === c.medium) !== i);
  if (dupMedium) throw new Error(`channels.${dupMedium.id}.medium: ${dupMedium.medium} is another channel's too; each channel has its own utm_medium.`);
  for (const k of ["messages", "ads"] as const) {
    const dup = channels.find((c, i) => c[k] && channels.findIndex((x) => x[k] === c[k]) !== i);
    if (dup) throw new Error(`channels.${dup.id}.${k}: ${dup[k]} is another channel's too.`);
  }

  // Approvals.
  const ap = doc.approvals ?? {};
  if (!isObj(ap)) throw new Error("approvals is a map with approvers.");
  keys(ap, "approvals", ["approvers"]);
  const al = ap.approvers ?? [];
  if (!Array.isArray(al) || al.length > 10) throw new Error("approvals.approvers is a list of up to 10 members' emails.");
  const approvers = [...new Set(al.map((e, i) => email(e, `approvals.approvers[${i}]`)))];

  // Attribution and results.
  const at = doc.attribution ?? {};
  if (!isObj(at)) throw new Error("attribution is a map with window.");
  keys(at, "attribution", ["window"]);
  const attributionDays = at.window === undefined ? 90 : minutesOf(at.window, "attribution.window", "d") / 1440;
  if (attributionDays < 1 || attributionDays > 365) throw new Error("attribution.window is 1d to 365d.");
  const rs = doc.results ?? {};
  if (!isObj(rs)) throw new Error("results is a map with every and settle.");
  keys(rs, "results", ["every", "settle"]);
  const syncMinutes = rs.every === undefined ? 15 : minutesOf(rs.every, "results.every", "mh");
  if (syncMinutes < 5 || syncMinutes > 1440) throw new Error("results.every is 5m to 24h.");
  const settleDays = rs.settle === undefined ? 14 : minutesOf(rs.settle, "results.settle", "d") / 1440;
  if (settleDays < 0 || settleDays > 60) throw new Error("results.settle is 0d to 60d.");

  // Linked products.
  let analytics: Config["analytics"] = null;
  if (doc.analytics !== undefined && doc.analytics !== null) {
    const l = link(doc.analytics, "analytics", "CAMPAIGNS_ANALYTICS_TOKEN", ["site"]);
    analytics = { url: l.url, token: l.token, site: text(l.raw.site, "analytics.site", 128) };
  }
  let messages: Config["messages"] = null;
  if (doc.messages !== undefined && doc.messages !== null) {
    const l = link(doc.messages, "messages", "CAMPAIGNS_MESSAGES_TOKEN");
    messages = { url: l.url, token: l.token };
  }
  let crm: Config["crm"] = null;
  if (doc.crm !== undefined && doc.crm !== null) {
    const l = link(doc.crm, "crm", "CAMPAIGNS_CRM_TOKEN", ["pipeline"]);
    const p = l.raw.pipeline;
    if (p !== undefined && p !== null && (typeof p !== "string" || !ID.test(p))) throw new Error("crm.pipeline is a CRM pipeline id, such as sales.");
    crm = { url: l.url, token: l.token, pipeline: (p as string | undefined) ?? null };
  }
  let audience: Config["audience"] = null;
  if (doc.audience !== undefined && doc.audience !== null) {
    const l = link(doc.audience, "audience", "CAMPAIGNS_AUDIENCE_TOKEN");
    audience = { url: l.url, token: l.token };
  }
  let automation: Config["automation"] = null;
  if (doc.automation !== undefined && doc.automation !== null) {
    const a = doc.automation;
    if (!isObj(a)) throw new Error("automation is a map with url and launch.");
    keys(a, "automation", ["url", "launch"]);
    let launch: NonNullable<Config["automation"]>["launch"] = null;
    if (a.launch !== undefined && a.launch !== null) {
      if (!isObj(a.launch)) throw new Error("automation.launch is a map with playbook and token.");
      keys(a.launch, "automation.launch", ["playbook", "token"]);
      const pb = a.launch.playbook;
      if (typeof pb !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(pb))
        throw new Error("automation.launch.playbook is the id of a playbook with a webhook trigger.");
      launch = { playbook: pb, token: a.launch.token === undefined ? "CAMPAIGNS_AUTOMATION_TOKEN" : env(a.launch.token, "automation.launch.token") };
    }
    automation = { url: baseUrl(a.url, "automation.url"), launch };
  }

  // Ad platforms.
  const ad = doc.ads ?? {};
  if (!isObj(ad)) throw new Error("ads is a map with every, days, google and meta.");
  keys(ad, "ads", ["every", "days", "google", "meta"]);
  const everyMinutes = ad.every === undefined ? 360 : minutesOf(ad.every, "ads.every", "mh");
  if (everyMinutes < 60 || everyMinutes > 1440) throw new Error("ads.every is 1h to 24h.");
  const days = ad.days ?? 30;
  if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 90) throw new Error("ads.days is 1 to 90.");
  let google: Config["ads"]["google"] = null;
  if (ad.google !== undefined && ad.google !== null) {
    const g = ad.google;
    if (!isObj(g)) throw new Error("ads.google is a map with customer_id, login_customer_id, developer_token, client_id, client_secret and refresh_token.");
    keys(g, "ads.google", ["customer_id", "login_customer_id", "developer_token", "client_id", "client_secret", "refresh_token", "api_version"]);
    const cid = (v: unknown, at: string) => {
      const s = String(v ?? "").replace(/-/g, "");
      if (!/^\d{10}$/.test(s)) throw new Error(`${at} is a Google Ads customer id, such as 123-456-7890.`);
      return s;
    };
    const version = g.api_version ?? "v22";
    if (typeof version !== "string" || !/^v\d{1,3}$/.test(version)) throw new Error("ads.google.api_version is a Google Ads API version, such as v22.");
    google = {
      customerId: cid(g.customer_id, "ads.google.customer_id"),
      loginCustomerId: g.login_customer_id === undefined || g.login_customer_id === null ? null : cid(g.login_customer_id, "ads.google.login_customer_id"),
      developerToken: env(g.developer_token ?? "CAMPAIGNS_GOOGLE_ADS_DEVELOPER_TOKEN", "ads.google.developer_token"),
      clientId: env(g.client_id ?? "CAMPAIGNS_GOOGLE_ADS_CLIENT_ID", "ads.google.client_id"),
      clientSecret: env(g.client_secret ?? "CAMPAIGNS_GOOGLE_ADS_CLIENT_SECRET", "ads.google.client_secret"),
      refreshToken: env(g.refresh_token ?? "CAMPAIGNS_GOOGLE_ADS_REFRESH_TOKEN", "ads.google.refresh_token"),
      apiVersion: version,
    };
  }
  let meta: Config["ads"]["meta"] = null;
  if (ad.meta !== undefined && ad.meta !== null) {
    const m = ad.meta;
    if (!isObj(m)) throw new Error("ads.meta is a map with ad_account and token.");
    keys(m, "ads.meta", ["ad_account", "token", "api_version"]);
    const acct = String(m.ad_account ?? "").replace(/^act_/, "");
    if (!/^\d{5,20}$/.test(acct)) throw new Error("ads.meta.ad_account is a Meta ad account id, such as act_1234567890.");
    const version = m.api_version ?? "v23.0";
    if (typeof version !== "string" || !/^v\d{1,3}\.\d$/.test(version)) throw new Error("ads.meta.api_version is a Graph API version, such as v23.0.");
    meta = { adAccount: acct, token: env(m.token ?? "CAMPAIGNS_META_TOKEN", "ads.meta.token"), apiVersion: version };
  }
  return {
    currency,
    timeZone,
    channels,
    naming: { campaign: template, pattern, patternText, maxLength: maxLength as number, sources },
    approvers,
    attributionDays,
    settleDays,
    syncMinutes,
    analytics,
    messages,
    crm,
    audience,
    automation,
    ads: { everyMinutes, days: days as number, google, meta },
  };
}

/** Things to fix that do not stop the file from being applied: secrets that are not set, approvers who are not members. */
export function configWarnings(c: Config, environment: Record<string, string | undefined>, members: string[]): string[] {
  const w: string[] = [];
  const unset = (name: string) => !environment[name];
  for (const [k, l] of [
    ["analytics", c.analytics],
    ["messages", c.messages],
    ["crm", c.crm],
    ["audience", c.audience],
  ] as const)
    if (l && unset(l.token)) w.push(`${k}: ${l.token} is not set, so nothing is read from ${k[0]!.toUpperCase()}${k.slice(1)}.`);
  if (c.automation?.launch && unset(c.automation.launch.token))
    w.push(`automation.launch: ${c.automation.launch.token} is not set, so a launch starts no playbook.`);
  const g = c.ads.google;
  if (g) {
    const missing = [g.developerToken, g.clientId, g.clientSecret, g.refreshToken].filter(unset);
    if (missing.length) w.push(`ads.google: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set, so no spend is read from Google Ads.`);
  }
  if (c.ads.meta && unset(c.ads.meta.token)) w.push(`ads.meta: ${c.ads.meta.token} is not set, so no spend is read from Meta.`);
  for (const ch of c.channels)
    if (ch.ads && !(ch.ads === "google" ? g : c.ads.meta)) w.push(`channels.${ch.id}.ads: ${ch.ads} is not under ads, so its spend is entered by hand or CSV.`);
  for (const a of c.approvers) if (!members.includes(a)) w.push(`approvals.approvers: ${a} is not a member of Campaigns.`);
  return w;
}

export interface ConfigFileState {
  path: string;
  /** When the file was last read and applied, or null if it never was. */
  appliedAt: string | null;
  /** Why the file on disk is not what is applied; the last good version stays until it is fixed. */
  error: string | null;
  /** Things to fix that did not stop the file from being applied. */
  warnings: string[];
}

/**
 * Reads the file now and whenever it changes (checked every `everyMs`, by size, time and content), and hands each new
 * version and its text to `apply`, which returns warnings or throws to refuse it. A file that cannot be read or applied
 * leaves the last good version in place. `stop()` ends the polling.
 */
export function watchConfig(
  path: string,
  apply: (config: Config, text: string) => string[],
  { everyMs = 60_000, onChange }: { everyMs?: number; onChange?: (state: ConfigFileState) => void } = {},
) {
  const state: ConfigFileState = { path, appliedAt: null, error: null, warnings: [] };
  let seen = "";
  const read = () => {
    let raw: string;
    let stamp: string;
    try {
      const st = statSync(path);
      raw = readFileSync(path, "utf8");
      stamp = `${st.size}:${st.mtimeMs}:${createHash("sha256").update(raw).digest("hex")}`;
    } catch (err) {
      const error = `Cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`;
      if (state.error !== error) ((state.error = error), onChange?.(state));
      return;
    }
    if (stamp === seen) return;
    seen = stamp;
    try {
      state.warnings = apply(parseConfig(raw), raw);
      Object.assign(state, { appliedAt: new Date().toISOString(), error: null });
    } catch (err) {
      state.error = (err as Error).message;
    }
    onChange?.(state);
  };
  read();
  const timer = setInterval(read, everyMs);
  timer.unref();
  return { state, read, stop: () => clearInterval(timer) };
}
