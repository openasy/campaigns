// The other products Campaigns reads from, each behind a small interface so the tests can point it at a fake. Every
// call is as the product's openapi.json describes it:
//
// - Analytics: GET /api/v1/report and GET /api/v1/breakdown?dimension=utmMedium, with filter=utmCampaign:is:<values>,
//   for the visits, visitors and goals of a campaign's tagged links, by channel.
// - Messages: GET /api/v1/campaigns, whose slug is the utm_campaign its links carry, for sends, opens and clicks.
// - CRM: GET /api/v1/deals?status=won, the won deals with their value, contact and source.
// - Audience: GET /api/v1/people?email= and GET /api/v1/people/{id}/events, the visits and message clicks that came
//   before a deal was won: the touches attribution is made of.
// - Automation: POST /hooks/{playbook} when a campaign is launched.

export class LinkError extends Error {
  /** true when sending the same again gives the same answer: a refused body or token. */
  readonly permanent: boolean;
  readonly status: number | null;
  constructor(message: string, status: number | null = null, permanent = false) {
    super(message);
    this.status = status;
    this.permanent = permanent;
  }
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown, max = 300): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const int = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(obj).filter((x): x is Record<string, unknown> => !!x) : []);

export async function request(
  f: typeof fetch,
  url: string,
  init: { method?: string; token?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number },
  product: string,
): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await f(url, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(init.token && { authorization: `Bearer ${init.token}` }),
        ...(init.body !== undefined && { "content-type": "application/json" }),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
      redirect: "error",
    });
  } catch (err) {
    throw new LinkError(`${product} could not be reached: ${(err as Error).message}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok && res.status !== 404) {
    const b = obj(body);
    const detail = str(b?.detail) ?? str(obj(b?.error)?.message) ?? str(b?.message);
    // 4xx but 408 and 429 are the request's fault: sending it again gives the same answer.
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
    throw new LinkError(`${product} answered ${res.status}${detail ? `: ${detail}` : ""}`, res.status, permanent);
  }
  return { status: res.status, body };
}

const need = (token: string | undefined, product: string) => {
  if (!token) throw new LinkError(`The ${product} token is not set.`, null, true);
  return token;
};

// ------------------------------------------------------------------ Analytics

/** The days Analytics reports over: today, or the last 7, 30 or 90. */
export type AnalyticsDays = 1 | 7 | 30 | 90;

export interface AnalyticsResult {
  days: AnalyticsDays;
  from: string;
  to: string;
  visits: number;
  visitors: number;
  engagedVisits: number;
  /** Visits a day, oldest first. */
  series: Array<{ day: string; visits: number }>;
  goals: Array<{ name: string; visits: number }>;
  /** Visits by utm_medium; null for visits without one. */
  byMedium: Array<{ medium: string | null; visits: number; visitors: number }>;
  /** Visits by utm_source and utm_medium. */
  bySource: Array<{ source: string | null; medium: string | null; campaign: string | null; visits: number; visitors: number }>;
}

export interface AnalyticsLink {
  /** The visits whose utm_campaign is one of the values, over the days. */
  campaign(utms: string[], days: AnalyticsDays): Promise<AnalyticsResult>;
}

export function analyticsLink(o: { url: string; site: string; token: string | undefined; fetch?: typeof fetch }): AnalyticsLink {
  const f = o.fetch ?? fetch;
  return {
    async campaign(utms, days) {
      const token = need(o.token, "Analytics");
      const filter = `utmCampaign:is:${utms.join("|")}`;
      const q = (extra: Record<string, string>) => new URLSearchParams({ site: o.site, days: String(days), filter, ...extra });
      const report = await request(f, `${o.url}/api/v1/report?${q({})}`, { token }, "Analytics");
      if (report.status === 404) throw new LinkError(`Analytics has no site ${o.site} (analytics.site).`, 404, true);
      const breakdown = await request(f, `${o.url}/api/v1/breakdown?${q({ dimension: "utmMedium", limit: "100" })}`, { token }, "Analytics");
      const r = obj(report.body) ?? {};
      const totals = obj(r.totals) ?? {};
      return {
        days,
        from: String(r.from ?? ""),
        to: String(r.to ?? ""),
        visits: int(totals.visits),
        visitors: int(totals.visitors),
        engagedVisits: int(totals.engagedVisits),
        series: list(r.series).map((x) => ({ day: String(x.day ?? ""), visits: int(x.visits) })),
        goals: list(r.goals).map((g) => ({ name: String(g.name ?? ""), visits: int(g.visits) })),
        byMedium: list(obj(breakdown.body)?.rows).map((row) => ({ medium: str(row.value, 64), visits: int(row.visits), visitors: int(row.visitors) })),
        bySource: list(r.campaigns).map((c) => ({
          source: str(c.source, 64),
          medium: str(c.medium, 64),
          campaign: str(c.campaign, 64),
          visits: int(c.visits),
          visitors: int(c.visitors),
        })),
      };
    },
  };
}

// ------------------------------------------------------------------ Messages

export interface MessagesCampaign {
  id: string;
  name: string;
  /** The utm_campaign its links carry. */
  slug: string;
  channel: "email" | "sms" | "whatsapp";
  state: string;
  startedAt: string | null;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  unsubscribed: number;
}

export interface MessagesLink {
  campaigns(): Promise<MessagesCampaign[]>;
}

export function messagesLink(o: { url: string; token: string | undefined; fetch?: typeof fetch }): MessagesLink {
  const f = o.fetch ?? fetch;
  return {
    async campaigns() {
      const { body } = await request(f, `${o.url}/api/v1/campaigns`, { token: need(o.token, "Messages") }, "Messages");
      return list(obj(body)?.campaigns).flatMap((c) => {
        const counts = obj(c.counts) ?? {};
        const channel = c.channel;
        if (channel !== "email" && channel !== "sms" && channel !== "whatsapp") return [];
        return [
          {
            id: String(c.id),
            name: String(c.name ?? ""),
            slug: String(c.slug ?? ""),
            channel,
            state: String(c.state ?? ""),
            startedAt: str(c.startedAt, 40),
            sent: int(counts.sent),
            delivered: int(counts.delivered),
            opened: int(counts.opened),
            clicked: int(counts.clicked),
            bounced: int(counts.bounced),
            unsubscribed: int(counts.unsubscribed),
          },
        ];
      });
    },
  };
}

// ------------------------------------------------------------------ CRM

export interface WonDeal {
  id: string;
  name: string;
  /** In the currency's units, without KDV. */
  value: number;
  currency: string;
  wonAt: string;
  createdAt: string;
  company: string | null;
  email: string | null;
  source: string;
  /** What CRM kept of where the lead came from: the utm_campaign of a Live Chat or form lead, or a page. */
  sourceDetail: string | null;
}

export interface CrmLink {
  wonDeals(pipeline: string | null): Promise<WonDeal[]>;
  dealUrl(id: string): string;
}

export function crmLink(o: { url: string; token: string | undefined; fetch?: typeof fetch }): CrmLink {
  const f = o.fetch ?? fetch;
  return {
    async wonDeals(pipeline) {
      const q = new URLSearchParams({ status: "won", ...(pipeline && { pipeline }) });
      const { body } = await request(f, `${o.url}/api/v1/deals?${q}`, { token: need(o.token, "CRM") }, "CRM");
      return list(obj(body)?.deals).flatMap((d) => {
        const wonAt = str(d.closedAt, 40);
        if (d.status !== "won" || !wonAt || typeof d.value !== "number") return [];
        return [
          {
            id: String(d.id),
            name: String(d.name ?? ""),
            value: d.value,
            currency: String(d.currency ?? ""),
            wonAt,
            createdAt: String(d.createdAt ?? wonAt),
            company: str(obj(d.company)?.name, 200),
            email: str(obj(d.contact)?.email, 254)?.toLowerCase() ?? null,
            source: String(d.source ?? ""),
            sourceDetail: str(d.sourceDetail, 300),
          },
        ];
      });
    },
    dealUrl: (id) => `${o.url}/deals/${encodeURIComponent(id)}`,
  };
}

// ------------------------------------------------------------------ Audience

/** Something that happened to a person that names a campaign: a tagged visit, or a click in a message. */
export interface Touch {
  at: string;
  /** utm_campaign of a visit, or the Messages campaign's slug of a click. */
  utm: string;
  /** utm_medium of a visit, or the Messages channel of a click. */
  medium: string | null;
  via: "visit" | "message";
}

export interface AudienceLink {
  /** The touches of the person with exactly this email, from `since` to `until`, oldest first. */
  touches(email: string, since: string, until: string): Promise<Touch[]>;
}

export function audienceLink(o: { url: string; token: string | undefined; fetch?: typeof fetch }): AudienceLink {
  const f = o.fetch ?? fetch;
  return {
    async touches(email, since, until) {
      const token = need(o.token, "Audience");
      const found = await request(f, `${o.url}/api/v1/people?${new URLSearchParams({ email, limit: "1" })}`, { token }, "Audience");
      const id = str(list(obj(found.body)?.people)[0]?.id, 200);
      if (!id) return [];
      const out: Touch[] = [];
      let cursor: string | null = null;
      // Newest first; reading stops at the window's start, or after 2000 events.
      for (let page = 0; page < 4; page++) {
        const q = new URLSearchParams({ limit: "500", ...(cursor && { cursor }) });
        const r = await request(f, `${o.url}/api/v1/people/${encodeURIComponent(id)}/events?${q}`, { token }, "Audience");
        const events = list(obj(r.body)?.events);
        let older = false;
        for (const e of events) {
          const at = str(e.at, 40);
          if (!at) continue;
          if (at < since) {
            older = true;
            continue;
          }
          if (at > until) continue;
          const p = obj(e.properties) ?? {};
          if (e.source === "analytics" && e.type === "visit_started" && str(p.utm_campaign, 64))
            out.push({ at, utm: str(p.utm_campaign, 64)!.toLowerCase(), medium: str(p.utm_medium, 64)?.toLowerCase() ?? null, via: "visit" });
          else if (e.source === "messages" && e.type === "message_clicked" && str(p.campaign, 64))
            out.push({ at, utm: str(p.campaign, 64)!.toLowerCase(), medium: str(p.channel, 64), via: "message" });
        }
        cursor = str(obj(r.body)?.nextCursor, 500);
        if (older || !cursor || !events.length) break;
      }
      return out.sort((a, b) => a.at.localeCompare(b.at));
    },
  };
}

// ------------------------------------------------------------------ Automation

export interface AutomationLink {
  /** Sends the event to the playbook's webhook; true when a run started, false when its conditions did not hold. */
  launch(playbook: string, event: Record<string, unknown>): Promise<boolean>;
}

export function automationLink(o: { url: string; token: string | undefined; fetch?: typeof fetch }): AutomationLink {
  const f = o.fetch ?? fetch;
  return {
    async launch(playbook, event) {
      const r = await request(
        f,
        `${o.url}/hooks/${encodeURIComponent(playbook)}`,
        { method: "POST", token: need(o.token, "Automation"), body: event, timeoutMs: 10_000 },
        "Automation",
      );
      if (r.status === 404) throw new LinkError(`Automation has no playbook ${playbook}.`, 404, true);
      return r.status === 202;
    },
  };
}
