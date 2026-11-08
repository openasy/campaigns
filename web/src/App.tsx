import {
  AppShell,
  BrandProvider,
  Button,
  Callout,
  EmptyState,
  navigate,
  PageHeader,
  PRODUCT_IDS,
  toLocale,
  usePath,
  useLocalePreference,
  useThemePreference,
  type ProductId,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import { CalendarRange, ChartColumn, KeyRound, Link2, LogIn, LogOut, Megaphone, Plug, Settings as SettingsIcon, UserRound, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Campaign, Member, ProductLink, Settings, Summary } from "./api.ts";
import { CalendarPage } from "./calendar.tsx";
import { CampaignPage, CampaignsPage, TABS, type Tab } from "./campaign.tsx";
import { useApi, type Call } from "./common.tsx";
import { useT } from "./i18n.ts";
import { LinksPage } from "./links.tsx";
import { IntegrationsPage, SettingsFilePage } from "./pages.tsx";
import { ResultsPage } from "./results.tsx";

const PAGES = ["calendar", "campaigns", "links", "results", "integrations", "settings", "account", "members", "signin", "tokens"] as const;
type Page = (typeof PAGES)[number];
type Route = { page: Page } | { page: "campaign"; id: string; tab: Tab };
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = [...PAGES];
function parseRoute(path: string): Route {
  const [page, id, tab] = path.replace(/^\//, "").split("/");
  if (page === "campaigns" && id)
    return { page: "campaign", id: decodeURIComponent(id), tab: (TABS as readonly string[]).includes(tab ?? "") ? (tab as Tab) : "brief" };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as Page };
  return { page: "calendar" };
}

export interface Ctx {
  call: Call;
  settings: Settings & { config: NonNullable<Settings["config"]> };
  members: Member[];
  summary: Summary | undefined;
  onChanged: () => void;
}

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function AuthSettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("auth.adminsOnly")}>{t("auth.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`auth.${page}`)}
        description={t(`auth.${page}Detail`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("auth.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can } = useAuth();
  const account = useAccountMenu();
  const route = parseRoute(usePath());
  const [summary, setSummary] = useState<Summary>();
  const [settings, setSettings] = useState<Settings>();
  const [members, setMembers] = useState<Member[]>([]);
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();

  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) =>
        setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "campaigns" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
    void call<{ members: Member[] }>("/api/v1/team").then(
      (r) => setMembers(r.members),
      () => {},
    );
  }, [call]);

  const reload = useCallback(() => {
    void call<Summary>("/api/v1/summary").then(setSummary, () => {});
    void call<Settings>("/api/v1/settings").then(setSettings, () => {});
  }, [call]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 60_000);
    return () => clearInterval(timer);
  }, [reload]);

  // The search window (Cmd+K) finds campaigns by name or utm_campaign.
  const onSearch = useMemo(
    () => async (q: string, signal: AbortSignal) => {
      const r = await call<{ campaigns: Campaign[] }>(`/api/v1/campaigns?${new URLSearchParams({ q })}`, { signal });
      return r.campaigns.slice(0, 8).map((c) => ({
        id: `campaign:${c.id}`,
        label: c.name,
        detail: c.utm,
        kind: msg("search.campaign"),
        icon: Megaphone,
        href: `/campaigns/${c.id}`,
      }));
    },
    [call, msg],
  );

  const waiting = summary?.waitingForMe.length;
  const nav = [
    { id: "calendar", label: msg("nav.calendar"), icon: CalendarRange },
    { id: "campaigns", label: msg("nav.campaigns"), icon: Megaphone, count: waiting || undefined },
    { id: "links", label: msg("nav.links"), icon: Link2 },
    { id: "results", label: msg("nav.results"), icon: ChartColumn },
  ];
  const footerNav = [
    { id: "integrations", label: msg("nav.integrations"), icon: Plug },
    { id: "settings", label: msg("nav.settings"), icon: SettingsIcon },
    ...(can("admin")
      ? [
          { id: "members", label: msg("nav.members"), icon: Users },
          { id: "signin", label: msg("nav.signIn"), icon: LogIn },
          { id: "tokens", label: msg("nav.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("nav.account"), icon: UserRound },
  ];
  const active = route.page === "campaign" ? "campaigns" : route.page;
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);
  const ready = settings?.config ? (settings as Ctx["settings"]) : undefined;
  const ctx = ready && { call, settings: ready, members, summary, onChanged: reload };

  return (
    <AppShell
      product="campaigns"
      onSearch={onSearch}
      about={colophon}
      nav={nav}
      activeNav={active}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      user={{ name: me.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {summary?.fileError && route.page !== "settings" && (
        <Callout tone="danger" title={msg("file.notApplied")} className="mb-2.5">
          {summary.fileError}
        </Callout>
      )}
      {route.page === "account" || route.page === "members" || route.page === "signin" || route.page === "tokens" ? (
        <AuthSettingsPage page={route.page} />
      ) : !ctx ? (
        <PageHeader title={msg("loading")} />
      ) : route.page === "campaigns" ? (
        <CampaignsPage {...ctx} />
      ) : route.page === "campaign" ? (
        <CampaignPage key={route.id} {...ctx} id={route.id} tab={route.tab} />
      ) : route.page === "links" ? (
        <LinksPage {...ctx} />
      ) : route.page === "results" ? (
        <ResultsPage {...ctx} />
      ) : route.page === "integrations" ? (
        <IntegrationsPage {...ctx} />
      ) : route.page === "settings" ? (
        <SettingsFilePage {...ctx} />
      ) : (
        <CalendarPage {...ctx} />
      )}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Campaigns">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
