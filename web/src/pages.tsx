// Integrations (the products results come from, the ad platforms and Automation) and the read-only settings file.
import { Button, Callout, DataTable, PageHeader, Panel, SelectField, StatusBadge, useLocalePreference } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Ctx } from "./App.tsx";
import type { AdsRead, Campaign, Integrations, LinkState, SpendList } from "./api.ts";
import { Code, day, money, Notice, useLoad, when } from "./common.tsx";
import { FileSettingsPage } from "./FileSettings.tsx";
import { useT, type T } from "./i18n.ts";

type State = LinkState;

function LinkBadge({ s, t }: { s: State; t: T }) {
  return (
    <StatusBadge tone={!s.linked ? "neutral" : s.lastError ? "danger" : s.lastOkAt ? "success" : "neutral"}>
      {!s.linked ? t("integrations.notLinked") : s.lastError ? t("integrations.failing") : s.lastOkAt ? t("integrations.ok") : t("integrations.notYet")}
    </StatusBadge>
  );
}

function LinkPanel({ title, detail, s, example, children }: { title: string; detail: string; s: State | undefined; example: string; children?: ReactNode }) {
  const t = useT();
  const [locale] = useLocalePreference();
  return (
    <Panel title={title} description={detail} actions={s && <LinkBadge s={s} t={t} />}>
      {s?.linked ? (
        <div className="flex flex-col gap-1 text-xs text-fg-muted">
          <span className="font-mono text-fg">{s.url}</span>
          {children}
          {!s.tokenSet && <span className="text-danger-text">{t("integrations.tokenUnset")}</span>}
          {s.lastOkAt && <span>{t("integrations.lastOk", { when: when(s.lastOkAt, locale) })}</span>}
          {s.lastError && <span className="text-danger-text">{s.lastError}</span>}
        </div>
      ) : (
        <Code label={title}>{example}</Code>
      )}
    </Panel>
  );
}

function Unclaimed({ ctx }: { ctx: Ctx }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const [list, reload] = useLoad<SpendList>(ctx.call, "/api/v1/spend?unmatched=true");
  const [campaigns] = useLoad<{ campaigns: Campaign[] }>(ctx.call, "/api/v1/campaigns");
  const [notice, setNotice] = useState<{ text: string; tone?: "danger" } | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const tl = (n: number) => money(n, ctx.settings.config.currency, locale);
  // One row per ad campaign: what it spent, and since when.
  const groups = new Map<string, { id: string; name: string; source: string; amount: number; first: string; last: string }>();
  for (const s of list?.spend ?? []) {
    const k = `${s.source}:${s.adCampaignId ?? s.adCampaign}`;
    const g = groups.get(k) ?? { id: s.id, name: s.adCampaign ?? "", source: s.source, amount: 0, first: s.day, last: s.day };
    g.amount += s.amount;
    if (s.day < g.first) g.first = s.day;
    if (s.day > g.last) g.last = s.day;
    groups.set(k, g);
  }
  const rows = [...groups.values()];
  const sync = async () => {
    setNotice(null);
    try {
      const r = await ctx.call<AdsRead>("/api/v1/spend/sync", { method: "POST" });
      setNotice({
        text: r.platforms
          .map((p) => p.error ?? t("spend.read", { platform: t(`spend.${p.platform}`), rows: p.rows, matched: p.matched, unmatched: p.unmatched }))
          .join(" "),
        tone: r.platforms.some((p) => p.error) ? "danger" : undefined,
      });
      reload();
    } catch (err) {
      setNotice({ text: (err as Error).message, tone: "danger" });
    }
  };
  return (
    <Panel
      title={t("unclaimed.title")}
      description={t("unclaimed.description")}
      actions={
        can("editor") && (
          <Button size="sm" icon={<RefreshCw />} onClick={() => void sync()}>
            {t("spend.readNow")}
          </Button>
        )
      }
      className="mt-2.5"
      flush
    >
      {notice && (
        <div className="px-3 pt-2.5">
          <Notice tone={notice.tone}>{notice.text}</Notice>
        </div>
      )}
      <DataTable
        label={t("unclaimed.title")}
        rows={rows}
        getRowId={(r) => r.id}
        minWidth={720}
        empty={<p className="px-3 py-3 text-sm text-fg-muted">{t("unclaimed.none")}</p>}
        columns={[
          {
            id: "name",
            header: t("unclaimed.adCampaign"),
            cell: (r) => (
              <span className="flex flex-col">
                <span className="font-medium">{r.name}</span>
                <span className="text-2xs text-fg-muted">{t(`spend.${r.source as "google" | "meta"}`)}</span>
              </span>
            ),
          },
          {
            id: "days",
            header: t("unclaimed.days"),
            cell: (r) => <span className="text-xs">{t("common.span", { from: day(r.first, locale), to: day(r.last, locale) })}</span>,
          },
          { id: "amount", header: t("spend.amount"), align: "right", mono: true, cell: (r) => tl(r.amount) },
          {
            id: "assign",
            header: t("unclaimed.give"),
            cell: (r) =>
              can("editor") ? (
                <span className="flex items-end gap-1.5">
                  <SelectField
                    aria-label={t("unclaimed.giveTo", { name: r.name })}
                    value={pick[r.id] ?? ""}
                    onChange={(e) => setPick({ ...pick, [r.id]: e.target.value })}
                    options={[{ value: "", label: t("unclaimed.choose") }, ...(campaigns?.campaigns ?? []).map((c) => ({ value: c.id, label: c.name }))]}
                  />
                  <Button
                    size="sm"
                    disabled={!pick[r.id]}
                    onClick={() =>
                      void ctx.call(`/api/v1/spend/${r.id}/assign`, { method: "POST", body: JSON.stringify({ campaign: pick[r.id] }) }).then(
                        () => {
                          setNotice({ text: t("unclaimed.given", { name: r.name }) });
                          reload();
                          ctx.onChanged();
                        },
                        (err: Error) => setNotice({ text: err.message, tone: "danger" }),
                      )
                    }
                  >
                    {t("unclaimed.giveButton")}
                  </Button>
                </span>
              ) : null,
          },
        ]}
      />
    </Panel>
  );
}

export function IntegrationsPage(ctx: Ctx) {
  const t = useT();
  const [i] = useLoad<Integrations>(ctx.call, "/api/v1/integrations");
  const origin = window.location.origin;
  return (
    <>
      <PageHeader title={t("integrations.title")} description={t("integrations.description")} />
      <div className="cmp-halves grid gap-2.5">
        <LinkPanel
          title="Analytics"
          detail={t("integrations.analytics")}
          s={i?.analytics}
          example="analytics: { url: http://analytics:8080, token: CAMPAIGNS_ANALYTICS_TOKEN, site: www }"
        >
          {i?.analytics.site && <span>{t("integrations.site", { site: i.analytics.site })}</span>}
        </LinkPanel>
        <LinkPanel
          title="Messages"
          detail={t("integrations.messages")}
          s={i?.messages}
          example="messages: { url: http://messages:8080, token: CAMPAIGNS_MESSAGES_TOKEN }"
        />
        <LinkPanel title="CRM" detail={t("integrations.crm")} s={i?.crm} example="crm: { url: http://crm:8080, token: CAMPAIGNS_CRM_TOKEN, pipeline: sales }">
          {i?.crm.pipeline && <span>{t("integrations.pipeline", { pipeline: i.crm.pipeline })}</span>}
        </LinkPanel>
        <LinkPanel
          title="Audience"
          detail={t("integrations.audience")}
          s={i?.audience}
          example="audience: { url: http://audience:8080, token: CAMPAIGNS_AUDIENCE_TOKEN }"
        />
        <LinkPanel
          title="Automation"
          detail={t("integrations.automation")}
          s={i?.automation}
          example={`automation:
  url: http://automation:8080
  launch: { playbook: pb_campaign_launch, token: CAMPAIGNS_AUTOMATION_TOKEN }`}
        >
          {i?.automation.playbook && <span>{t("integrations.playbook", { playbook: i.automation.playbook })}</span>}
        </LinkPanel>
        <LinkPanel
          title="Google Ads"
          detail={t("integrations.google")}
          s={i?.google}
          example={`ads:
  google:
    customer_id: 123-456-7890
    developer_token: CAMPAIGNS_GOOGLE_ADS_DEVELOPER_TOKEN
    client_id: CAMPAIGNS_GOOGLE_ADS_CLIENT_ID
    client_secret: CAMPAIGNS_GOOGLE_ADS_CLIENT_SECRET
    refresh_token: CAMPAIGNS_GOOGLE_ADS_REFRESH_TOKEN`}
        />
        <LinkPanel
          title="Meta"
          detail={t("integrations.meta")}
          s={i?.meta}
          example={`ads:
  meta: { ad_account: act_1234567890, token: CAMPAIGNS_META_TOKEN }`}
        />
        <Panel title={t("integrations.erasure")} description={t("integrations.erasureDetail")}>
          <Code label={t("integrations.erasure")}>{`POST ${origin}/api/v1/erasures
Authorization: Bearer <a Campaigns token with the admin role>

{ "reference": "KVKK-2026-099", "people": { "emails": ["…"] } }
200 { "status": "done", "deleted": 1 }`}</Code>
          <a href="/api/docs/" className="mt-2 block text-xs">
            {t("integrations.reference")}
          </a>
        </Panel>
      </div>
      <Unclaimed ctx={ctx} />
    </>
  );
}

export function SettingsFilePage({ settings }: Ctx) {
  const t = useT();
  const [locale] = useLocalePreference();
  const c = settings.config;
  const f = settings.file;
  const applied = f?.appliedAt ? when(f.appliedAt, locale) : t("settings.notYet");
  return (
    <FileSettingsPage
      file="campaigns.yaml"
      applied={applied}
      yaml={settings.yaml || t("settings.noFile")}
      problems={
        <>
          {f?.error && (
            <Callout tone="danger" title={t("file.notApplied")} className="mb-2.5">
              {f.error}
            </Callout>
          )}
          {!!f?.warnings.length && (
            <Callout tone="warning" title={t("settings.warnings")} className="mb-2.5">
              <ul className="cmp-list">
                {f.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Callout>
          )}
        </>
      }
      groups={[
        {
          title: t("settings.naming"),
          description: t("settings.namingDetail"),
          items: [
            { label: t("settings.campaignNames"), value: <code className="font-mono">{c.naming.campaign}</code>, path: "naming.campaign" },
            {
              label: t("settings.pattern"),
              value: c.naming.pattern ? <code className="font-mono">{c.naming.pattern}</code> : t("settings.none"),
              path: "naming.pattern",
            },
            { label: t("settings.maxLength"), value: t("settings.characters", { n: c.naming.maxLength }), path: "naming.max_length" },
            { label: t("settings.sources"), value: c.naming.sources.join(", ") || t("settings.none"), path: "naming.sources" },
          ],
        },
        {
          title: t("settings.channels"),
          description: t("settings.channelsDetail"),
          items: c.channels.map((ch) => ({
            label: ch.name,
            value: [
              `utm_medium=${ch.medium}`,
              `utm_source: ${ch.sources.join(", ")}`,
              ch.messages && t("settings.fromMessages", { channel: ch.messages }),
              ch.ads && t("settings.fromAds", { platform: ch.ads === "google" ? "Google Ads" : "Meta" }),
            ]
              .filter(Boolean)
              .join(" · "),
            path: `channels.${ch.id}`,
          })),
        },
        {
          title: t("settings.approvalsAttribution"),
          items: [
            { label: t("settings.approvers"), value: c.approvers.join(", ") || t("settings.none"), path: "approvals.approvers" },
            { label: t("settings.window"), value: t("settings.windowValue", { days: c.attribution.windowDays }), path: "attribution.window" },
            {
              label: t("settings.results"),
              value: t("settings.resultsValue", { minutes: c.results.everyMinutes, days: c.results.settleDays }),
              path: "results",
            },
            { label: t("settings.ads"), value: t("settings.adsValue", { hours: Math.round(c.ads.everyMinutes / 60), days: c.ads.days }), path: "ads" },
            { label: t("settings.currency"), value: `${c.currency}, ${c.timeZone}`, path: "currency" },
          ],
        },
      ]}
    />
  );
}
