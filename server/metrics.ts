// Prometheus text exposition, written by hand: a few lines, no client library needed.
const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface Gauges {
  /** Campaigns by status. */
  campaigns: Record<string, number>;
  /** Spend rows an ad platform reported that no campaign claims. */
  unmatchedSpend: number;
  /** Won deals from CRM. */
  deals: number;
  /** 1 for each link whose last read failed. */
  linkErrors: Record<string, number>;
  /** 1 when the settings file on disk could not be applied and an older version is in use. */
  fileError: boolean;
}

export function renderMetrics(version: string, g: Gauges): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="campaigns",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_campaigns_campaigns Campaigns, by status.",
    "# TYPE openasy_campaigns_campaigns gauge",
    ...["planned", "live", "ended", "cancelled"].map((s) => `openasy_campaigns_campaigns{status="${s}"} ${g.campaigns[s] ?? 0}`),
    "# HELP openasy_campaigns_unmatched_spend Spend rows from the ad platforms that no campaign claims.",
    "# TYPE openasy_campaigns_unmatched_spend gauge",
    `openasy_campaigns_unmatched_spend ${g.unmatchedSpend}`,
    "# HELP openasy_campaigns_won_deals Won deals read from CRM.",
    "# TYPE openasy_campaigns_won_deals gauge",
    `openasy_campaigns_won_deals ${g.deals}`,
    "# HELP openasy_campaigns_link_error 1 when the last read of a linked product or ad platform failed.",
    "# TYPE openasy_campaigns_link_error gauge",
    ...Object.entries(g.linkErrors).map(([k, n]) => `openasy_campaigns_link_error{link="${k}"} ${n}`),
    "# HELP openasy_campaigns_config_error 1 when the settings file could not be applied and its last good version is in use.",
    "# TYPE openasy_campaigns_config_error gauge",
    `openasy_campaigns_config_error ${g.fileError ? 1 : 0}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
