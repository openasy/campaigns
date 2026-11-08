// Spend read from the ad platforms, a day and an ad campaign at a time. Campaigns does not buy or change ads: it asks
// each platform what was spent, with read-only access.
//
// - Google Ads API: an access token from the refresh token (OAuth, https://oauth2.googleapis.com/token), then
//   POST /{version}/customers/{id}/googleAds:searchStream with a GAQL query of campaign, segments.date,
//   metrics.cost_micros, clicks and impressions, and the customer's currency_code.
// - Meta Marketing API: GET /{version}/act_{id}?fields=currency, then GET /{version}/act_{id}/insights at the campaign
//   level, one row a day (time_increment=1), following paging.next.
import { LinkError, request } from "./links.ts";

export interface AdRow {
  platform: "google" | "meta";
  account: string;
  adCampaignId: string;
  adCampaign: string;
  day: string;
  amountMinor: number;
  clicks: number;
  impressions: number;
  currency: string;
}

export interface AdsSource {
  platform: "google" | "meta";
  /** What was spent each day from `from` to `to`, both days included. */
  spend(from: string, to: string): Promise<AdRow[]>;
}

export interface AdEndpoints {
  googleToken: string;
  googleAds: string;
  meta: string;
}

export const AD_ENDPOINTS: AdEndpoints = {
  googleToken: "https://oauth2.googleapis.com/token",
  googleAds: "https://googleads.googleapis.com",
  meta: "https://graph.facebook.com",
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

export function googleAds(o: {
  customerId: string;
  loginCustomerId: string | null;
  apiVersion: string;
  developerToken: string | undefined;
  clientId: string | undefined;
  clientSecret: string | undefined;
  refreshToken: string | undefined;
  endpoints?: AdEndpoints;
  fetch?: typeof fetch;
}): AdsSource {
  const f = o.fetch ?? fetch;
  const ep = o.endpoints ?? AD_ENDPOINTS;
  let access: { token: string; until: number } | null = null;

  async function token(): Promise<string> {
    if (access && access.until > Date.now()) return access.token;
    if (!o.clientId || !o.clientSecret || !o.refreshToken) throw new LinkError("The Google Ads client id, secret or refresh token is not set.", null, true);
    let res: Response;
    try {
      res = await f(ep.googleToken, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ client_id: o.clientId, client_secret: o.clientSecret, refresh_token: o.refreshToken, grant_type: "refresh_token" }),
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
    } catch (err) {
      throw new LinkError(`Google could not be reached: ${(err as Error).message}`);
    }
    const b = obj(await res.json().catch(() => null));
    if (!res.ok || typeof b.access_token !== "string")
      throw new LinkError(
        `Google refused the refresh token: ${String(b.error_description ?? b.error ?? res.status)}`,
        res.status,
        res.status === 400 || res.status === 401,
      );
    access = { token: b.access_token, until: Date.now() + (num(b.expires_in) - 60) * 1000 };
    return access.token;
  }

  return {
    platform: "google",
    async spend(from, to) {
      if (!o.developerToken) throw new LinkError("The Google Ads developer token is not set.", null, true);
      const query =
        "SELECT customer.currency_code, campaign.id, campaign.name, segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions " +
        `FROM campaign WHERE segments.date BETWEEN '${from}' AND '${to}' AND metrics.cost_micros > 0`;
      const r = await request(
        f,
        `${ep.googleAds}/${o.apiVersion}/customers/${o.customerId}/googleAds:searchStream`,
        {
          method: "POST",
          token: await token(),
          body: { query },
          headers: { "developer-token": o.developerToken, ...(o.loginCustomerId && { "login-customer-id": o.loginCustomerId }) },
          timeoutMs: 60_000,
        },
        "Google Ads",
      );
      if (r.status === 404) throw new LinkError(`Google Ads has no customer ${o.customerId}.`, 404, true);
      // searchStream answers an array of batches, each with its results.
      const batches = Array.isArray(r.body) ? r.body : [r.body];
      const rows: AdRow[] = [];
      for (const batch of batches)
        for (const raw of Array.isArray(obj(batch).results) ? (obj(batch).results as unknown[]) : []) {
          const row = obj(raw);
          const c = obj(row.campaign);
          const day = String(obj(row.segments).date ?? "");
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || c.id === undefined) continue;
          const m = obj(row.metrics);
          rows.push({
            platform: "google",
            account: o.customerId,
            adCampaignId: String(c.id),
            adCampaign: String(c.name ?? c.id),
            day,
            // Micros are a millionth of the currency's unit; minor units are a hundredth.
            amountMinor: Math.round(num(m.costMicros) / 10_000),
            clicks: Math.round(num(m.clicks)),
            impressions: Math.round(num(m.impressions)),
            currency: String(obj(row.customer).currencyCode ?? ""),
          });
        }
      return rows;
    },
  };
}

export function metaAds(o: { adAccount: string; apiVersion: string; token: string | undefined; endpoints?: AdEndpoints; fetch?: typeof fetch }): AdsSource {
  const f = o.fetch ?? fetch;
  const ep = o.endpoints ?? AD_ENDPOINTS;
  return {
    platform: "meta",
    async spend(from, to) {
      if (!o.token) throw new LinkError("The Meta token is not set.", null, true);
      const base = `${ep.meta}/${o.apiVersion}/act_${o.adAccount}`;
      const account = await request(f, `${base}?fields=currency`, { token: o.token }, "Meta");
      if (account.status === 404) throw new LinkError(`Meta has no ad account act_${o.adAccount}.`, 404, true);
      const currency = String(obj(account.body).currency ?? "");
      const q = new URLSearchParams({
        level: "campaign",
        fields: "campaign_id,campaign_name,spend,clicks,impressions",
        time_increment: "1",
        time_range: JSON.stringify({ since: from, until: to }),
        limit: "500",
      });
      let next: string | null = `${base}/insights?${q}`;
      const rows: AdRow[] = [];
      for (let page = 0; next && page < 50; page++) {
        const r = await request(f, next, { token: o.token, timeoutMs: 60_000 }, "Meta");
        const b = obj(r.body);
        for (const raw of Array.isArray(b.data) ? b.data : []) {
          const d = obj(raw);
          const day = String(d.date_start ?? "");
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || d.campaign_id === undefined) continue;
          rows.push({
            platform: "meta",
            account: o.adAccount,
            adCampaignId: String(d.campaign_id),
            adCampaign: String(d.campaign_name ?? d.campaign_id),
            day,
            amountMinor: Math.round(num(d.spend) * 100),
            clicks: Math.round(num(d.clicks)),
            impressions: Math.round(num(d.impressions)),
            currency,
          });
        }
        const n = obj(b.paging).next;
        // Only pages on the same Graph API host are followed.
        next = typeof n === "string" && n.startsWith(`${ep.meta}/`) ? n : null;
      }
      return rows;
    },
  };
}
