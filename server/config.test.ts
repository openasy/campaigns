import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configWarnings, parseConfig, watchConfig } from "./config.ts";
import { campaignUtm, nameCarries, slug, taggedUrl, utmProblem } from "./naming.ts";
import { SETTINGS } from "./test-app.ts";

describe("the settings file", () => {
  it("has defaults for everything, so an empty file works", () => {
    const c = parseConfig("");
    expect(c.currency).toBe("TRY");
    expect(c.timeZone).toBe("Europe/Istanbul");
    expect(c.channels.map((x) => x.id)).toEqual(["email", "sms", "whatsapp", "paid-search", "paid-social", "social", "events"]);
    expect(c.naming).toMatchObject({ campaign: "{name}-{year}", maxLength: 40, sources: ["newsletter", "partner", "website"] });
    expect(c).toMatchObject({ attributionDays: 90, settleDays: 14, syncMinutes: 15, analytics: null, crm: null, ads: { everyMinutes: 360, days: 30 } });
  });

  it("reads the file in config/ as it ships", () => {
    const c = parseConfig(readFileSync(new URL("../config/campaigns.yaml", import.meta.url), "utf8"));
    expect(c.channels).toHaveLength(8);
    expect(c.naming.pattern!.test("autumn-2026")).toBe(true);
    expect(c.naming.pattern!.test("autumn")).toBe(false);
  });

  it("reads the tests' file", () => {
    const c = parseConfig(SETTINGS.replaceAll("FAKES", "http://fakes"));
    expect(c.channels.find((x) => x.id === "paid-search")).toEqual({
      id: "paid-search",
      name: "Paid search",
      medium: "cpc",
      sources: ["google"],
      messages: null,
      ads: "google",
    });
    expect(c.analytics).toEqual({ url: "http://fakes/analytics", token: "ANALYTICS_TOKEN", site: "www" });
    expect(c.ads.google).toMatchObject({ customerId: "1234567890", apiVersion: "v22", developerToken: "G_DEV" });
    expect(c.ads.meta).toEqual({ adAccount: "9876543210", token: "META_TOKEN", apiVersion: "v23.0" });
    expect(c.automation).toEqual({ url: "http://fakes/automation", launch: { playbook: "pb_launch", token: "AUTOMATION_TOKEN" } });
    expect(c.approvers).toEqual(["selin@example.com"]);
  });

  it("says which field is wrong", () => {
    const bad = (yaml: string) => () => parseConfig(yaml);
    expect(bad("colour: red")).toThrow(/unknown colour/);
    expect(bad("currency: lira")).toThrow(/three-letter/);
    expect(bad("naming: { campaign: '{name}-{week}' }")).toThrow(/\{week\} is not one of/);
    expect(bad("naming: { campaign: '{year}' }")).toThrow(/needs \{name\}/);
    expect(bad("naming: { campaign: 'Big {name}' }")).toThrow(/only lowercase/);
    expect(bad("naming: { sources: [Google Ads] }")).toThrow(/UTM value/);
    expect(bad("channels: { email: { medium: email }, news: { medium: email } }")).toThrow(/each channel has its own utm_medium/);
    expect(bad("channels: { a: { ads: google }, b: { ads: google } }")).toThrow(/google is another channel's too/);
    expect(bad("channels: { a: { messages: fax } }")).toThrow(/email, sms or whatsapp/);
    expect(bad("crm: { url: http://crm.example.com, token: X }")).toThrow(/https:\/\//);
    expect(bad("crm: { url: https://crm.example.com, token: abc123 }")).toThrow(/environment variable/);
    expect(bad("analytics: { url: https://a.example.com }")).toThrow(/analytics.site/);
    expect(bad("ads: { google: { customer_id: 12 } }")).toThrow(/customer id/);
    expect(bad("ads: { meta: { ad_account: me } }")).toThrow(/ad account id/);
    expect(bad("ads: { every: 5m }")).toThrow(/1h to 24h/);
    expect(bad("attribution: { window: 2y }")).toThrow(/duration/);
    expect(bad("approvals: { approvers: [not-an-email] }")).toThrow(/email address/);
    expect(bad("naming: { pattern: '[' }")).toThrow(/regular expression/);
  });

  it("warns about secrets that are not set and approvers who are not members", () => {
    const c = parseConfig(SETTINGS.replaceAll("FAKES", "http://fakes"));
    const w = configWarnings(c, { ANALYTICS_TOKEN: "x", CRM_TOKEN: "x", AUDIENCE_TOKEN: "x", G_DEV: "x", G_ID: "x" }, ["emily@example.com"]);
    expect(w).toEqual([
      "messages: MESSAGES_TOKEN is not set, so nothing is read from Messages.",
      "automation.launch: AUTOMATION_TOKEN is not set, so a launch starts no playbook.",
      "ads.google: G_SECRET, G_REFRESH are not set, so no spend is read from Google Ads.",
      "ads.meta: META_TOKEN is not set, so no spend is read from Meta.",
      "approvals.approvers: selin@example.com is not a member of Campaigns.",
    ]);
  });

  it("keeps the last good file when a change has a mistake", () => {
    const dir = mkdtempSync(join(tmpdir(), "campaigns-config-"));
    const path = join(dir, "campaigns.yaml");
    writeFileSync(path, "currency: EUR\n");
    const applied: string[] = [];
    const w = watchConfig(path, (c) => (applied.push(c.currency), []), { everyMs: 60_000 });
    expect(w.state.error).toBeNull();
    writeFileSync(path, "currency: [x]\n");
    w.read();
    expect(w.state.error).toMatch(/currency/);
    expect(applied).toEqual(["EUR"]);
    writeFileSync(path, "currency: USD\n");
    w.read();
    expect(w.state.error).toBeNull();
    expect(applied).toEqual(["EUR", "USD"]);
    w.stop();
  });
});

describe("naming rules", () => {
  const n = parseConfig("").naming;

  it("makes one lowercase ASCII value of a name, in any way it is written", () => {
    expect(slug("Sonbahar İndirimi 2026!")).toBe("sonbahar-indirimi-2026");
    expect(slug("  Çağrı   Merkezi  ")).toBe("cagri-merkezi");
    expect(slug("Größe & Öl, Mädchen")).toBe("grosse-ol-madchen");
    expect(campaignUtm(n, "Autumn", "2026-10-01")).toBe("autumn-2026");
    expect(campaignUtm(n, "AUTUMN ", "2026-10-01")).toBe("autumn-2026");
  });

  it("follows the template, and shortens the name to fit max_length", () => {
    const q = parseConfig("naming: { campaign: '{year}-{quarter}-{name}', max_length: 20 }").naming;
    expect(campaignUtm(q, "Kış kampanyası", "2026-11-15")).toBe("2026-q4-kis-kampanya");
    expect(campaignUtm(q, "Kış kampanyası", "2026-11-15").length).toBeLessThanOrEqual(20);
    const m = parseConfig("naming: { campaign: '{name}-{year}{month}' }").naming;
    expect(campaignUtm(m, "Black Friday", "2026-11-27")).toBe("black-friday-202611");
  });

  it("says what is wrong with a value given by hand", () => {
    expect(utmProblem(n, "Autumn")).toMatch(/lowercase/);
    expect(utmProblem(n, "a".repeat(41))).toMatch(/at most 40/);
    const p = parseConfig("naming: { pattern: '[a-z0-9-]+-20\\d\\d' }").naming;
    expect(utmProblem(p, "autumn")).toMatch(/naming.pattern/);
    expect(utmProblem(p, "autumn-2026")).toBeNull();
  });

  it("tags a link with the five parameters, replacing any already there", () => {
    expect(
      taggedUrl("https://www.example.com/autumn?ref=x&utm_source=old&utm_campaign=old#top", {
        source: "newsletter",
        medium: "email",
        campaign: "autumn-2026",
        content: "hero",
        term: null,
      }),
    ).toBe("https://www.example.com/autumn?ref=x&utm_source=newsletter&utm_medium=email&utm_campaign=autumn-2026&utm_content=hero#top");
  });

  it("finds a campaign's utm_campaign in an ad platform's campaign name, as a whole value", () => {
    expect(nameCarries("autumn-2026 | Search | Brand", "autumn-2026")).toBe(true);
    expect(nameCarries("TR_Autumn_2026_Search", "autumn-2026")).toBe(true);
    expect(nameCarries("autumn-2026b search", "autumn-2026")).toBe(false);
    expect(nameCarries("pre-autumn-2026", "autumn-2026")).toBe(true);
    expect(nameCarries("winter-2026", "autumn-2026")).toBe(false);
  });
});
