// Tagged links and QR codes: the link maker, and the links with the visits Analytics counted from them.
import { Button, DataTable, EmptyState, IconButton, PageHeader, Panel, SelectField, TextField, useLocalePreference, type Column } from "@openasy/ui";
import { Check, Copy, QrCode } from "lucide-react";
import { useState } from "react";
import type { Ctx } from "./App.tsx";
import type { Campaign, Link } from "./api.ts";
import { Notice, num, useLoad } from "./common.tsx";
import { useT } from "./i18n.ts";

/** Lowercase, Turkish letters written plainly, anything else a dash: as the server writes utm_content. */
export function slug(s: string) {
  return s
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .replace(/ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function preview(destination: string, p: { source: string; medium: string; campaign: string; content: string; term: string }) {
  const u = URL.parse(destination);
  if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) return null;
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) u.searchParams.delete(k);
  u.searchParams.set("utm_source", p.source);
  u.searchParams.set("utm_medium", p.medium);
  u.searchParams.set("utm_campaign", p.campaign);
  if (p.content) u.searchParams.set("utm_content", p.content);
  if (p.term) u.searchParams.set("utm_term", p.term);
  return u.toString();
}

function copy(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => {});
}

export function LinkBuilder({
  call,
  settings,
  campaigns,
  fixed,
  onMade,
}: Pick<Ctx, "call" | "settings"> & { campaigns: Campaign[]; fixed?: Campaign; onMade: (l: Link) => void }) {
  const t = useT();
  const c = settings.config;
  const open = campaigns.filter((x) => x.status === "planned" || x.status === "live");
  const [campaignId, setCampaignId] = useState(fixed?.id ?? open[0]?.id ?? "");
  const campaign = fixed ?? campaigns.find((x) => x.id === campaignId);
  const firstChannel = campaign?.channels.find((ch) => ch.inFile)?.id ?? c.channels[0]!.id;
  const [channelId, setChannelId] = useState(firstChannel);
  const channel = c.channels.find((x) => x.id === channelId) ?? c.channels[0]!;
  const [source, setSource] = useState(channel.sources[0] ?? "");
  const [destination, setDestination] = useState("https://");
  const [content, setContent] = useState("");
  const [term, setTerm] = useState("");
  const [made, setMade] = useState<Link | null>(null);
  const [qr, setQr] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const url = campaign ? preview(destination, { source, medium: channel.medium, campaign: campaign.utm, content: slug(content), term: slug(term) }) : null;
  const badUrl = destination.length > 8 && !url;

  async function make() {
    if (!campaign || !url) return;
    setBusy(true);
    setError(null);
    try {
      const l = await call<Link>(`/api/v1/campaigns/${campaign.id}/links`, {
        method: "POST",
        body: JSON.stringify({ destination, channel: channel.id, source, content: content || null, term: term || null }),
      });
      setMade(l);
      copy(l.url);
      onMade(l);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="cmp-form2 grid gap-2">
        {!fixed && (
          <SelectField
            label={t("links.campaign")}
            value={campaignId}
            onChange={(e) => setCampaignId(e.target.value)}
            options={open.map((x) => ({ value: x.id, label: `${x.name} (${x.utm})` }))}
          />
        )}
        <TextField
          label={t("links.destination")}
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          mono
          error={badUrl ? t("links.badUrl") : undefined}
          hint={t("links.destinationHint")}
        />
        <SelectField
          label={t("links.channel")}
          value={channel.id}
          onChange={(e) => {
            const ch = c.channels.find((x) => x.id === e.target.value)!;
            setChannelId(ch.id);
            setSource(ch.sources[0] ?? "");
          }}
          options={c.channels.map((ch) => ({ value: ch.id, label: `${ch.name} (utm_medium=${ch.medium})` }))}
        />
        <SelectField
          label={t("links.source")}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          options={channel.sources.map((s) => ({ value: s, label: s }))}
        />
        <TextField
          label={t("links.content")}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="hero-button"
          hint={content && slug(content) !== content ? t("links.savedAs", { value: slug(content) }) : t("links.contentHint")}
        />
        <TextField
          label={t("links.term")}
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          hint={term && slug(term) !== term ? t("links.savedAs", { value: slug(term) }) : t("links.termHint")}
        />
      </div>
      <code aria-label={t("links.tagged")} className="cmp-code block rounded-md bg-canvas px-2.5 py-2 font-mono text-2xs text-fg">
        {made?.url ?? url ?? t("links.enterUrl")}
      </code>
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" icon={<Check />} disabled={busy || !url || !source} onClick={() => void make()}>
          {t("links.save")}
        </Button>
        <Button size="sm" icon={<QrCode />} disabled={!made} onClick={() => setQr(true)}>
          {t("links.qr")}
        </Button>
        {made && (
          <span role="status" className="text-xs text-success">
            {t("links.saved", { utm: campaign!.utm })}
          </span>
        )}
      </div>
      {qr && made && <QrBlock link={made} />}
    </div>
  );
}

function QrBlock({ link }: { link: Link }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-end gap-3">
      <img src={link.qr} alt={t("links.qrOf", { url: link.url })} className="cmp-qr rounded-md bg-white" />
      <span className="flex flex-col gap-1 text-xs text-fg-muted">
        {t("links.qrDetail", { medium: link.medium })}
        <span className="flex gap-1.5">
          <a href={link.qr} download className="text-xs">
            {t("links.downloadSvg")}
          </a>
          <a href={`${link.qr}?format=png`} download className="text-xs">
            {t("links.downloadPng")}
          </a>
        </span>
      </span>
    </div>
  );
}

export function LinksTable({ links, label, showCampaign = true }: { links: Array<Link & { campaignName?: string }>; label: string; showCampaign?: boolean }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [copied, setCopied] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const cols: Column<Link & { campaignName?: string }>[] = [
    {
      id: "url",
      header: t("links.link"),
      width: "44%",
      cell: (l) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-mono text-xs">{(URL.parse(l.destination)?.host ?? "") + (URL.parse(l.destination)?.pathname ?? "")}</span>
          <span className="truncate text-2xs text-fg-muted">
            {l.source} / {l.medium}
            {l.content ? ` / ${l.content}` : ""}
          </span>
        </span>
      ),
    },
    ...(showCampaign
      ? [{ id: "campaign", header: t("links.campaign"), cell: (l: Link & { campaignName?: string }) => <span className="text-xs">{l.campaignName}</span> }]
      : []),
    {
      id: "visits",
      header: t("links.visits"),
      description: t("links.visitsDetail"),
      align: "right",
      mono: true,
      sortValue: (l) => l.visits ?? -1,
      cell: (l) => (l.visits === null ? "–" : num(l.visits, locale)),
    },
    { id: "by", header: t("links.madeBy"), cell: (l) => <span className="text-xs">{l.createdBy}</span> },
    {
      id: "copy",
      header: <span className="sr-only">{t("links.copy")}</span>,
      label: t("links.copy"),
      align: "right",
      cell: (l) => (
        <span className="flex justify-end gap-1">
          <IconButton label={t("links.qrFor", { url: l.url })} size="xs" onClick={() => setQr(qr === l.id ? null : l.id)}>
            <QrCode className="size-3.5" />
          </IconButton>
          <IconButton
            label={t("links.copyLink", { source: l.source, url: l.destination })}
            size="xs"
            onClick={() => {
              copy(l.url);
              setCopied(l.id);
            }}
          >
            {copied === l.id ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </IconButton>
        </span>
      ),
    },
  ];
  const open = links.find((l) => l.id === qr);
  return (
    <>
      <DataTable
        label={label}
        columns={cols}
        rows={links}
        getRowId={(l) => l.id}
        defaultSort={{ id: "visits", direction: "desc" }}
        minWidth={680}
        empty={<p className="px-3 py-3 text-sm text-fg-muted">{t("links.none")}</p>}
      />
      {open && (
        <div className="border-t border-line px-3 py-2.5">
          <QrBlock link={open} />
        </div>
      )}
    </>
  );
}

export function LinksPage(ctx: Ctx) {
  const t = useT();
  const [campaigns] = useLoad<{ campaigns: Campaign[] }>(ctx.call, "/api/v1/campaigns");
  const [links, reload] = useLoad<{ links: Array<Link & { campaignName: string }> }>(ctx.call, "/api/v1/links");
  return (
    <>
      <PageHeader title={t("links.title")} description={t("links.description")} />
      <div className="cmp-halves mt-2.5 grid gap-2.5">
        <Panel aria-label={t("links.make")} title={t("links.make")} description={t("links.makeDetail")}>
          {campaigns?.campaigns.some((x) => x.status === "planned" || x.status === "live") ? (
            <LinkBuilder call={ctx.call} settings={ctx.settings} campaigns={campaigns.campaigns} onMade={reload} />
          ) : campaigns ? (
            <p className="text-sm text-fg-muted">{t("links.noCampaign")}</p>
          ) : null}
        </Panel>
        <Panel title={t("links.all")} flush>
          {links === null ? <EmptyState title={t("common.failed")} /> : <LinksTable links={links?.links ?? []} label={t("links.all")} />}
        </Panel>
      </div>
    </>
  );
}
