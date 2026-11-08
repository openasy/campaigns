// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

export interface ProductLink {
  id: string;
  url: string;
}

export type ConfigFile = { path: string; appliedAt: string | null; error: string | null; warnings: string[] } | null;

export interface ChannelConfig {
  id: string;
  name: string;
  medium: string;
  sources: string[];
  messages: "email" | "sms" | "whatsapp" | null;
  ads: "google" | "meta" | null;
}

export interface Config {
  currency: string;
  timeZone: string;
  channels: ChannelConfig[];
  naming: { campaign: string; pattern: string | null; maxLength: number; sources: string[] };
  approvers: string[];
  attribution: { windowDays: number };
  results: { everyMinutes: number; settleDays: number };
  ads: { everyMinutes: number; days: number };
}

export interface Settings {
  file: ConfigFile;
  yaml: string;
  config: Config | null;
}

export interface Summary {
  today: string;
  currency: string;
  campaigns: Record<Status, number>;
  waitingForMe: Array<{ id: string; name: string; start: string }>;
  startingSoon: Array<{ id: string; name: string; start: string; canLaunch: boolean }>;
  myTasks: { open: number; overdue: number };
  month: { month: string; spend: number; budget: number };
  unmatchedSpend: { rows: number; amount: number };
  linked: Record<"analytics" | "messages" | "crm" | "audience" | "automation" | "google" | "meta", boolean>;
  readAt: string | null;
  fileError: string | null;
}

export interface Member {
  id: string;
  name: string;
  email: string;
}

export type Status = "planned" | "live" | "ended" | "cancelled";
export type Metric = "visits" | "conversions" | "sends" | "opens" | "clicks" | "deals" | "revenue";
export type Decision = "waiting" | "approved" | "changes";

export interface Goal {
  id: string;
  metric: Metric;
  goal: string | null;
  target: number;
}

export interface Approval {
  email: string;
  name: string;
  state: Decision;
  note: string | null;
  decidedAt: string | null;
}

export interface Campaign {
  id: string;
  name: string;
  utm: string;
  status: Status;
  start: string;
  end: string;
  brief: string | null;
  message: string | null;
  audience: string | null;
  owner: { id: string; name: string } | null;
  currency: string;
  budget: number;
  spend: number;
  channels: Array<{ id: string; name: string; inFile: boolean; budget: number; spend: number }>;
  goals: Goal[];
  approvals: Approval[];
  approved: boolean;
  myApproval: Decision | null;
  canLaunch: boolean;
  blockers: string[];
  adNames: string[];
  messagesIds: string[];
  counts: { links: number; tasks: number; tasksDone: number; assets: number };
  launchedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

export interface Link {
  id: string;
  campaign: string;
  channel: string;
  channelName: string | null;
  destination: string;
  source: string;
  medium: string;
  content: string | null;
  term: string | null;
  url: string;
  label: string | null;
  qr: string;
  visits: number | null;
  createdAt: string;
  createdBy: string;
}

export interface Task {
  id: string;
  campaign: { id: string; name: string };
  text: string;
  channel: string | null;
  owner: { id: string; name: string } | null;
  due: string | null;
  overdue: boolean;
  doneAt: string | null;
  doneBy: string | null;
  createdAt: string;
}

export interface Asset {
  id: string;
  name: string;
  url: string;
  channel: string | null;
  createdAt: string;
  createdBy: string;
}

export interface CampaignDetail extends Campaign {
  links: Link[];
  tasks: Task[];
  assets: Asset[];
  activity: Array<{ at: string; by: string; text: string }>;
}

export interface Spend {
  id: string;
  campaign: { id: string; name: string; utm: string } | null;
  channel: string | null;
  channelName: string | null;
  day: string;
  amount: number;
  source: "manual" | "csv" | "google" | "meta";
  adCampaign: string | null;
  adCampaignId: string | null;
  clicks: number | null;
  impressions: number | null;
  note: string | null;
  createdAt: string;
  createdBy: string;
}

export interface SpendList {
  spend: Spend[];
  unmatched: { rows: number; amount: number };
  currency: string;
}

export interface SpendImported {
  check: boolean;
  rows: number;
  valid: number;
  added: number;
  replaced: number;
  errors: Array<{ line: number; error: string }>;
}

export interface AdsRead {
  from: string;
  to: string;
  platforms: Array<{ platform: "google" | "meta"; rows: number; matched: number; unmatched: number; otherCurrency: number; error: string | null }>;
}

export interface Touch {
  campaign: { id: string; name: string; utm: string };
  channel: string | null;
  channelName: string | null;
  at: string;
  via: "visit" | "message" | "crm";
}

export interface Deal {
  id: string;
  name: string;
  value: number;
  currency: string;
  counted: boolean;
  wonAt: string;
  company: string | null;
  url: string | null;
  first: Touch | null;
  last: Touch | null;
  touches: number;
}

export interface ByTouch {
  deals: number;
  revenue: number;
  roi: number | null;
}

export interface Totals {
  budget: number;
  spend: number;
  visits: number;
  visitors: number;
  engagedVisits: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  first: ByTouch;
  last: ByTouch;
  costPerVisit: number | null;
}

export interface ChannelResult {
  id: string | null;
  name: string | null;
  planned: boolean;
  budget: number;
  spend: number;
  visits: number;
  visitors: number;
  sent: number;
  opened: number;
  clicked: number;
  first: { deals: number; revenue: number };
  last: { deals: number; revenue: number };
}

export interface Results {
  campaign: { id: string; name: string; utm: string; status: Status; start: string; end: string };
  currency: string;
  readAt: string | null;
  frozen: boolean;
  window: { days: 1 | 7 | 30 | 90; from: string; to: string; partial: boolean } | null;
  errors: { analytics: string | null; messages: string | null };
  linked: { analytics: boolean; messages: boolean; crm: boolean; audience: boolean };
  totals: Totals;
  channels: ChannelResult[];
  goals: Array<Goal & { actual: number | null; actualFirst: number | null; share: number | null }>;
  analyticsGoals: Array<{ name: string; visits: number }>;
  series: Array<{ day: string; visits: number }>;
  sources: Array<{ source: string | null; medium: string | null; campaign: string | null; visits: number; visitors: number }>;
  messages: Array<{
    id: string;
    name: string;
    slug: string;
    channel: "email" | "sms" | "whatsapp";
    channelName: string;
    state: string;
    startedAt: string | null;
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
    bounced: number;
    unsubscribed: number;
  }>;
  deals: Deal[];
}

export interface Report {
  from: string;
  to: string;
  currency: string;
  readAt: string | null;
  campaigns: Array<Totals & { id: string; name: string; utm: string; status: Status; start: string; end: string; readAt: string | null }>;
  channels: Array<{
    id: string;
    name: string;
    campaigns: number;
    budget: number;
    spend: number;
    visits: number;
    sent: number;
    opened: number;
    clicked: number;
    first: ByTouch;
    last: ByTouch;
  }>;
  totals: { budget: number; spend: number; visits: number; sent: number; first: ByTouch; last: ByTouch };
  wonInPeriod: { deals: number; revenue: number };
  notAttributed: { deals: number; revenue: number };
}

export type LinkState = {
  linked: boolean;
  url: string | null;
  tokenSet: boolean;
  lastOkAt: string | null;
  lastError: string | null;
  lastTriedAt: string | null;
};
export interface Integrations {
  analytics: LinkState & { site: string | null };
  messages: LinkState;
  crm: LinkState & { pipeline: string | null };
  audience: LinkState;
  automation: LinkState & { playbook: string | null };
  google: LinkState;
  meta: LinkState;
}

export interface Naming {
  utm: string;
  problem: string | null;
  taken: { id: string; name: string } | null;
  rule: string;
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
