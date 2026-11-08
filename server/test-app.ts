// Starts the app on a random port for tests, with the fakes of Analytics, Messages, CRM, Audience, Automation, Google
// Ads and Meta, all reached through the real clients.
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuth } from "@openasy/auth";
import { createApp, type AppOptions } from "./app.ts";
import { createCampaigns } from "./campaigns.ts";
import { parseConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { GOOGLE, META_ACCOUNT, startFakes, TOKENS } from "./fakes.ts";
import type { Actor } from "./store.ts";

export const ADMIN_TOKEN = "test-admin-token";
/** Acts as Selin, the file's approver. */
export const SELIN_TOKEN = "test-selin-token";
/** Acts as Veli, a viewer. */
export const VELI_TOKEN = "test-veli-token";

/** Members of the test install: Emily and Hakan are editors, Selin an admin, Veli a viewer. */
export const EMILY: Actor = { id: "user-emily", name: "Emily Clark", role: "editor" };
export const HAKAN: Actor = { id: "user-hakan", name: "Hakan Yıldız", role: "editor" };
export const SELIN: Actor = { id: "user-selin", name: "Selin Aydın", role: "admin" };
export const VELI: Actor = { id: "user-veli", name: "Veli Kaya", role: "viewer" };
const MEMBERS = [
  { ...EMILY, email: "emily@example.com" },
  { ...HAKAN, email: "hakan@example.com" },
  { ...SELIN, email: "selin@example.com" },
  { ...VELI, email: "veli@example.com" },
];

/** The settings file the tests start with; FAKES is replaced with the fake server's address. */
export const SETTINGS = `
currency: TRY
time_zone: Europe/Istanbul
channels:
  email: { name: Email, medium: email, messages: email }
  sms: { name: SMS, medium: sms, messages: sms }
  paid-search: { name: Paid search, medium: cpc, sources: [google], ads: google }
  paid-social: { name: Paid social, medium: paid-social, sources: [meta, instagram], ads: meta }
  social: { name: Social, medium: social, sources: [linkedin, instagram, x] }
  events: { name: Events, medium: offline, sources: [fair, print] }
naming:
  campaign: "{name}-{year}"
  max_length: 40
  sources: [newsletter, partner]
approvals:
  approvers: [selin@example.com]
attribution:
  window: 90d
results:
  every: 15m
  settle: 14d
analytics: { url: FAKES/analytics, token: ANALYTICS_TOKEN, site: www }
messages: { url: FAKES/messages, token: MESSAGES_TOKEN }
crm: { url: FAKES/crm, token: CRM_TOKEN }
audience: { url: FAKES/audience, token: AUDIENCE_TOKEN }
automation:
  url: FAKES/automation
  launch: { playbook: pb_launch, token: AUTOMATION_TOKEN }
ads:
  every: 6h
  days: 30
  google:
    customer_id: 123-456-7890
    developer_token: G_DEV
    client_id: G_ID
    client_secret: G_SECRET
    refresh_token: G_REFRESH
  meta: { ad_account: act_${META_ACCOUNT}, token: META_TOKEN }
`;

/** A clock the test moves by hand: Monday 2 November 2026, 09:00 in Istanbul. */
export function fakeClock(start = Date.parse("2026-11-02T06:00:00Z")) {
  let t = start;
  return Object.assign(() => t, { advance: (ms: number) => void (t += ms), set: (ms: number) => void (t = ms) });
}

export async function startApp(opts: Partial<AppOptions> & { version?: string; settings?: string } = {}) {
  const fakes = await startFakes();
  const db = openDb(":memory:");
  const { settings = SETTINGS, version = "0.1.0", ...rest } = opts;
  const clock = fakeClock();
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "campaigns", productName: "OpenAsy Campaigns", origin: base });
  for (const m of MEMBERS)
    db.prepare("INSERT INTO auth_users (id, email, name, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)").run(
      m.id,
      m.email,
      m.name,
      m.role,
      new Date().toISOString(),
    );
  const env = {
    ANALYTICS_TOKEN: TOKENS.analytics,
    MESSAGES_TOKEN: TOKENS.messages,
    CRM_TOKEN: TOKENS.crm,
    AUDIENCE_TOKEN: TOKENS.audience,
    AUTOMATION_TOKEN: TOKENS.automation,
    G_DEV: GOOGLE.developerToken,
    G_ID: GOOGLE.clientId,
    G_SECRET: GOOGLE.clientSecret,
    G_REFRESH: GOOGLE.refreshToken,
    META_TOKEN: TOKENS.meta,
  };
  const campaigns = createCampaigns(db, { publicUrl: base, env, clock, adEndpoints: fakes.endpoints });
  const text = settings.replaceAll("FAKES", fakes.base);
  campaigns.setConfig(parseConfig(text), text);
  handler = createApp({ db, campaigns, auth, adminToken: ADMIN_TOKEN, memberTokens: { [SELIN_TOKEN]: SELIN, [VELI_TOKEN]: VELI }, version, ...rest });
  const admin = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json", ...init.headers } });
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fakes.close();
  };
  return { db, campaigns, auth, base, admin, clock, fakes, close };
}

export type TestApp = Awaited<ReturnType<typeof startApp>>;
