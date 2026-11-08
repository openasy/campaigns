// Fakes of what Campaigns reads, on one local HTTP server, for the tests: Analytics' report and breakdown with their
// filter, Messages' campaigns, CRM's won deals, Audience's people and timelines, Automation's webhook, Google's OAuth
// token endpoint and the Google Ads searchStream, and Meta's ad account and insights. Each answers in the shape its
// documentation (or the sibling's openapi.json) gives, and checks what a real one would refuse: bearer tokens, the
// developer token, a refresh token, the filter's syntax. They are not the real services: what passes here is tested
// against these fakes only.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const TOKENS = {
  analytics: "analytics-token-for-campaigns",
  messages: "messages-token-for-campaigns",
  crm: "crm-token-for-campaigns",
  audience: "audience-token-for-campaigns",
  automation: "oah_automation-token",
  meta: "meta-system-user-token",
};
export const GOOGLE = {
  clientId: "google-ads-client",
  clientSecret: "google-ads-secret",
  refreshToken: "google-ads-refresh",
  developerToken: "google-ads-dev-token",
  customerId: "1234567890",
};
export const META_ACCOUNT = "9876543210";

export interface FakeVisit {
  /** Days before the fake's today, 0 for today. */
  daysAgo: number;
  utm: { source: string | null; medium: string | null; campaign: string | null };
  goals?: string[];
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startFakes() {
  const state = {
    calls: [] as Array<{ method: string; path: string; query: string; body: string }>,
    analytics: { site: "www", visits: [] as FakeVisit[], status: 200 },
    messages: { campaigns: [] as Array<Record<string, unknown>>, status: 200 },
    crm: { deals: [] as Array<Record<string, unknown>>, status: 200 },
    audience: { people: new Map<string, { id: string; events: Array<Record<string, unknown>> }>(), status: 200 },
    automation: { hooks: [] as Array<{ playbook: string; body: unknown }>, conditions: true },
    google: { rows: [] as Array<Record<string, unknown>>, currency: "TRY", accessTokens: new Set<string>(), status: 200 },
    meta: { rows: [] as Array<Record<string, unknown>>, currency: "TRY", pageSize: 2 },
  };

  const send = (res: ServerResponse, status: number, data: unknown) => {
    const text = data === undefined ? "" : JSON.stringify(data);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }).end(text);
  };
  const problem = (res: ServerResponse, status: number, detail: string) => send(res, status, { status, detail, code: "x" });
  const bearer = (req: IncomingMessage, token: string) => req.headers.authorization === `Bearer ${token}`;

  /** Analytics' filter, as its README gives it: dimension:is|not:values separated by |. */
  function keep(visits: FakeVisit[], filters: string[]): FakeVisit[] | string {
    let out = visits;
    for (const f of filters) {
      const m = /^([A-Za-z]+):(is|not):(.+)$/.exec(f);
      if (!m) return `filter ${f} is dimension:is:values or dimension:not:values.`;
      const key = { utmCampaign: "campaign", utmMedium: "medium", utmSource: "source" }[m[1]!] as "campaign" | "medium" | "source" | undefined;
      if (!key) return `filter ${f}: the fake knows utmCampaign, utmMedium and utmSource.`;
      const values = m[3]!.split("|");
      out = out.filter((v) => values.includes(v.utm[key] ?? "(none)") === (m[2] === "is"));
    }
    return out;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const text = await body(req);
    state.calls.push({ method: req.method ?? "GET", path: url.pathname, query: url.search, body: text });
    const p = url.pathname;

    // ---- Analytics
    if (p === "/analytics/api/v1/report" || p === "/analytics/api/v1/breakdown") {
      if (!bearer(req, TOKENS.analytics)) return problem(res, 401, "invalid token");
      if (state.analytics.status !== 200) return problem(res, state.analytics.status, "down");
      if (url.searchParams.get("site") !== state.analytics.site) return problem(res, 404, "no such site");
      const days = Number(url.searchParams.get("days") ?? 7);
      if (![1, 7, 30, 90].includes(days)) return problem(res, 422, "days is 1, 7, 30 or 90.");
      const kept = keep(
        state.analytics.visits.filter((v) => v.daysAgo < days),
        url.searchParams.getAll("filter"),
      );
      if (typeof kept === "string") return problem(res, 422, kept);
      const range = { site: state.analytics.site, days, from: "2026-08-10T21:00:00.000Z", to: "2026-11-08T21:00:00.000Z" };
      if (p.endsWith("/breakdown")) {
        if (url.searchParams.get("dimension") !== "utmMedium") return problem(res, 422, "the fake breaks down by utmMedium only");
        const by = new Map<string | null, number>();
        for (const v of kept) by.set(v.utm.medium, (by.get(v.utm.medium) ?? 0) + 1);
        return send(res, 200, {
          ...range,
          dimension: "utmMedium",
          rows: [...by].map(([value, n]) => ({ value, group: null, visitors: n, visits: n, count: n, engagementRate: 0.5, duration: 30 })),
        });
      }
      const goals = new Map<string, number>();
      for (const v of kept) for (const g of v.goals ?? []) goals.set(g, (goals.get(g) ?? 0) + 1);
      const camps = new Map<string, { source: string | null; medium: string | null; campaign: string | null; visits: number; visitors: number }>();
      for (const v of kept) {
        const k = JSON.stringify(v.utm);
        const c = camps.get(k) ?? { ...v.utm, visits: 0, visitors: 0 };
        c.visits++;
        c.visitors++;
        camps.set(k, c);
      }
      return send(res, 200, {
        ...range,
        totals: {
          visitors: kept.length,
          visits: kept.length,
          pageviews: kept.length * 2,
          bounceRate: 0.5,
          duration: 30,
          engagedVisits: Math.floor(kept.length / 2),
          engagementRate: 0.5,
          newVisitors: kept.length,
          returningVisitors: 0,
        },
        series: Array.from({ length: days }, (_, i) => {
          const ago = days - 1 - i;
          const n = kept.filter((v) => v.daysAgo === ago).length;
          return { day: new Date(Date.parse("2026-11-02T00:00:00Z") - ago * 86_400_000).toISOString().slice(0, 10), visitors: n, visits: n, pageviews: n * 2 };
        }),
        pages: [],
        entries: [],
        exits: [],
        sources: [],
        campaigns: [...camps.values()],
        browsers: [],
        systems: [],
        devices: [],
        events: [],
        clicks: [],
        goals: [...goals].map(([name, visits]) => ({ name, path: null, event: name, visits, rate: kept.length ? visits / kept.length : 0, download: null })),
        channels: [],
        annotations: [],
      });
    }

    // ---- Messages
    if (p === "/messages/api/v1/campaigns" && req.method === "GET") {
      if (!bearer(req, TOKENS.messages)) return problem(res, 401, "invalid token");
      if (state.messages.status !== 200) return problem(res, state.messages.status, "down");
      return send(res, 200, { campaigns: state.messages.campaigns });
    }

    // ---- CRM
    if (p === "/crm/api/v1/deals" && req.method === "GET") {
      if (!bearer(req, TOKENS.crm)) return problem(res, 401, "invalid token");
      if (state.crm.status !== 200) return problem(res, state.crm.status, "down");
      const status = url.searchParams.get("status") ?? "open";
      const pipeline = url.searchParams.get("pipeline");
      return send(res, 200, { deals: state.crm.deals.filter((d) => (status === "all" || d.status === status) && (!pipeline || d.pipeline === pipeline)) });
    }

    // ---- Audience
    if (p === "/audience/api/v1/people" && req.method === "GET") {
      if (!bearer(req, TOKENS.audience)) return problem(res, 401, "invalid token");
      if (state.audience.status !== 200) return problem(res, state.audience.status, "down");
      const email = url.searchParams.get("email");
      const person = email ? state.audience.people.get(email) : undefined;
      return send(res, 200, {
        people: person
          ? [
              {
                id: person.id,
                name: null,
                email,
                phone: null,
                userId: null,
                emails: [email],
                phones: [],
                traits: {},
                sources: ["analytics"],
                firstSource: "analytics",
                createdAt: "2026-01-01T00:00:00Z",
                lastAt: null,
              },
            ]
          : [],
        total: person ? 1 : 0,
      });
    }
    const timeline = /^\/audience\/api\/v1\/people\/([^/]+)\/events$/.exec(p);
    if (timeline && req.method === "GET") {
      if (!bearer(req, TOKENS.audience)) return problem(res, 401, "invalid token");
      const person = [...state.audience.people.values()].find((x) => x.id === decodeURIComponent(timeline[1]!));
      if (!person) return problem(res, 404, "no such person");
      const limit = Number(url.searchParams.get("limit") ?? 100);
      if (!(limit >= 1 && limit <= 500)) return problem(res, 422, "limit is 1 to 500");
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      // Newest first, as Audience answers.
      const all = [...person.events].sort((a, b) => String(b.at).localeCompare(String(a.at)));
      const page = all.slice(offset, offset + limit);
      return send(res, 200, { events: page, ...(offset + limit < all.length && { nextCursor: String(offset + limit) }) });
    }

    // ---- Automation
    const hook = /^\/automation\/hooks\/([^/]+)$/.exec(p);
    if (hook && req.method === "POST") {
      if (!bearer(req, TOKENS.automation)) return problem(res, 401, "invalid token");
      if (hook[1] !== "pb_launch") return problem(res, 404, "no such playbook");
      state.automation.hooks.push({ playbook: hook[1]!, body: JSON.parse(text) });
      return send(res, state.automation.conditions ? 202 : 200, { run: state.automation.conditions ? "run_1" : null });
    }

    // ---- Google: OAuth token, then Google Ads searchStream
    if (p === "/google/token" && req.method === "POST") {
      const f = new URLSearchParams(text);
      if (f.get("grant_type") !== "refresh_token" || f.get("client_id") !== GOOGLE.clientId || f.get("client_secret") !== GOOGLE.clientSecret)
        return send(res, 401, { error: "invalid_client" });
      if (f.get("refresh_token") !== GOOGLE.refreshToken)
        return send(res, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
      const token = `ya29.${state.google.accessTokens.size + 1}`;
      state.google.accessTokens.add(token);
      return send(res, 200, { access_token: token, expires_in: 3599, token_type: "Bearer", scope: "https://www.googleapis.com/auth/adwords" });
    }
    const ads = /^\/google\/ads\/(v\d+)\/customers\/(\d+)\/googleAds:searchStream$/.exec(p);
    if (ads && req.method === "POST") {
      const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      if (!state.google.accessTokens.has(token))
        return send(res, 401, [{ error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } }]);
      if (req.headers["developer-token"] !== GOOGLE.developerToken)
        return send(res, 401, [{ error: { code: 401, message: "The developer token is not valid.", status: "UNAUTHENTICATED" } }]);
      if (ads[2] !== GOOGLE.customerId)
        return send(res, 403, [{ error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } }]);
      if (state.google.status !== 200)
        return send(res, state.google.status, [{ error: { code: state.google.status, message: "Internal error", status: "INTERNAL" } }]);
      const q = String((JSON.parse(text) as { query?: string }).query ?? "");
      const between = /segments\.date BETWEEN '(\d{4}-\d{2}-\d{2})' AND '(\d{4}-\d{2}-\d{2})'/.exec(q);
      if (!/FROM campaign/.test(q) || !between) return send(res, 400, [{ error: { code: 400, message: "Invalid GAQL", status: "INVALID_ARGUMENT" } }]);
      const rows = state.google.rows.filter((r) => String(r.date) >= between[1]! && String(r.date) <= between[2]!);
      // int64 fields are strings in the JSON of the Google Ads API.
      return send(res, 200, [
        {
          results: rows.map((r) => ({
            customer: { resourceName: `customers/${GOOGLE.customerId}`, currencyCode: state.google.currency },
            campaign: { resourceName: `customers/${GOOGLE.customerId}/campaigns/${r.id}`, id: String(r.id), name: r.name },
            metrics: { costMicros: String(r.costMicros), clicks: String(r.clicks ?? 0), impressions: String(r.impressions ?? 0) },
            segments: { date: r.date },
          })),
          fieldMask: "customer.currencyCode,campaign.id,campaign.name,segments.date,metrics.costMicros,metrics.clicks,metrics.impressions",
          requestId: "fake",
        },
      ]);
    }

    // ---- Meta: ad account, insights with paging
    const meta = /^\/meta\/(v\d+\.\d)\/act_(\d+)(\/insights)?$/.exec(p);
    if (meta && req.method === "GET") {
      if (req.headers.authorization !== `Bearer ${TOKENS.meta}`)
        return send(res, 400, { error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } });
      if (meta[2] !== META_ACCOUNT) return send(res, 400, { error: { message: "Unsupported get request.", type: "GraphMethodException", code: 100 } });
      if (!meta[3]) return send(res, 200, { currency: state.meta.currency, id: `act_${META_ACCOUNT}` });
      if (url.searchParams.get("level") !== "campaign" || url.searchParams.get("time_increment") !== "1")
        return send(res, 400, { error: { message: "level=campaign and time_increment=1 expected by the fake", code: 100 } });
      const range = JSON.parse(url.searchParams.get("time_range") ?? "{}") as { since?: string; until?: string };
      const rows = state.meta.rows.filter((r) => String(r.date) >= range.since! && String(r.date) <= range.until!);
      const after = Number(url.searchParams.get("after") ?? 0);
      const page = rows.slice(after, after + state.meta.pageSize);
      const next = new URL(`${base}${p}`);
      for (const [k, v] of url.searchParams) next.searchParams.set(k, v);
      next.searchParams.set("after", String(after + state.meta.pageSize));
      return send(res, 200, {
        data: page.map((r) => ({
          campaign_id: String(r.id),
          campaign_name: r.name,
          spend: String(r.spend),
          clicks: String(r.clicks ?? 0),
          impressions: String(r.impressions ?? 0),
          date_start: r.date,
          date_stop: r.date,
        })),
        paging: { cursors: { before: "b", after: "a" }, ...(after + state.meta.pageSize < rows.length && { next: next.toString() }) },
      });
    }

    problem(res, 404, `the fake has no ${req.method} ${p}`);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return {
    base,
    state,
    endpoints: { googleToken: `${base}/google/token`, googleAds: `${base}/google/ads`, meta: `${base}/meta` },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type Fakes = Awaited<ReturnType<typeof startFakes>>;
