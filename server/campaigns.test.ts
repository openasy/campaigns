import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMILY, HAKAN, SELIN, startApp, VELI, type TestApp } from "./test-app.ts";

let app: TestApp;
beforeEach(async () => {
  app = await startApp();
});
afterEach(() => app.close());

const autumn = (extra: Record<string, unknown> = {}) =>
  app.campaigns.createCampaign(EMILY, {
    name: "Autumn",
    start: "2026-10-01",
    end: "2026-10-31",
    brief: "Bring last year's trial users back before the price change.",
    channels: [
      { id: "email", budget: 10000 },
      { id: "paid-search", budget: 80000 },
      { id: "paid-social", budget: 30000 },
    ],
    goals: [
      { metric: "visits", target: 6000 },
      { metric: "conversions", goal: "Signup", target: 300 },
      { metric: "deals", target: 25 },
    ],
    ...extra,
  });

describe("planning a campaign", () => {
  it("makes utm_campaign by the naming rules, with the creator as owner and the file's approvers", () => {
    const c = autumn();
    expect(c).toMatchObject({
      name: "Autumn",
      utm: "autumn-2026",
      status: "planned",
      owner: { id: EMILY.id, name: "Emily Clark" },
      budget: 120000,
      currency: "TRY",
      approvals: [{ email: "selin@example.com", name: "Selin Aydın", state: "waiting" }],
      approved: false,
      canLaunch: false,
      blockers: ["Selin Aydın has not approved it yet."],
    });
    expect(c.channels.map((x) => [x.id, x.budget])).toEqual([
      ["email", 10000],
      ["paid-search", 80000],
      ["paid-social", 30000],
    ]);
    expect(c.goals.map((g) => g.metric)).toEqual(["visits", "conversions", "deals"]);
    expect(c.activity[0]!.text).toBe("Planned Autumn for 2026-10-01 to 2026-10-31, as autumn-2026.");
  });

  it("never gives two campaigns one name", () => {
    autumn();
    expect(() => app.campaigns.createCampaign(HAKAN, { name: "AUTUMN!", start: "2026-09-01", end: "2026-09-30" })).toThrow(/autumn-2026 is Autumn's/);
    expect(app.campaigns.naming(new URLSearchParams({ name: "Autumn", start: "2026-02-01" }))).toMatchObject({ utm: "autumn-2026", taken: { name: "Autumn" } });
    const other = app.campaigns.createCampaign(HAKAN, { name: "Autumn", utm: "autumn-2026-b2b", start: "2026-09-01", end: "2026-09-30" });
    expect(other.utm).toBe("autumn-2026-b2b");
    expect(() => app.campaigns.createCampaign(HAKAN, { name: "Bad", utm: "Bad Name", start: "2026-09-01", end: "2026-09-30" })).toThrow(/lowercase/);
  });

  it("keeps utm_campaign fixed once a link carries it", () => {
    const c = autumn();
    expect(app.campaigns.updateCampaign(EMILY, c.id, { utm: "autumn-tr-2026" }).utm).toBe("autumn-tr-2026");
    app.campaigns.createLink(EMILY, c.id, { destination: "https://www.example.com/autumn", channel: "email", source: "newsletter" });
    expect(() => app.campaigns.updateCampaign(EMILY, c.id, { utm: "autumn-2026" })).toThrow(/fixed once the campaign has links/);
  });

  it("refuses what it cannot read", () => {
    expect(() => app.campaigns.createCampaign(EMILY, { name: "X", start: "2026-10-05", end: "2026-10-01" })).toThrow(/on or after start/);
    expect(() => app.campaigns.createCampaign(EMILY, { name: "X", start: "2026-10-01", end: "2026-10-05", channels: ["fax"] })).toThrow(
      /one of the file's channels/,
    );
    expect(() =>
      app.campaigns.createCampaign(EMILY, { name: "X", start: "2026-10-01", end: "2026-10-05", goals: [{ metric: "conversions", target: 5 }] }),
    ).toThrow(/Analytics goal/);
    expect(() => app.campaigns.createCampaign(EMILY, { name: "X", start: "2026-10-01", end: "2026-10-05", approvers: ["nobody@example.com"] })).toThrow(
      /not a member/,
    );
    expect(() => app.campaigns.createCampaign(EMILY, { name: "X", start: "2026-10-01", end: "2026-10-05", colour: "red" })).toThrow(/unknown colour/);
  });

  it("lists the calendar's campaigns that overlap a period, by channel", () => {
    autumn();
    app.campaigns.createCampaign(HAKAN, { name: "Black Friday", start: "2026-11-20", end: "2026-11-30", channels: ["email", "social"] });
    app.campaigns.createCampaign(HAKAN, { name: "Spring", start: "2027-03-01", end: "2027-03-31", channels: ["social"] });
    const q = (p: Record<string, string>) => app.campaigns.listCampaigns(EMILY, new URLSearchParams(p)).map((c) => c.name);
    expect(q({ from: "2026-10-15", to: "2026-11-25" })).toEqual(["Autumn", "Black Friday"]);
    expect(q({ from: "2026-10-01", to: "2027-12-31", channel: "social" })).toEqual(["Black Friday", "Spring"]);
    expect(q({ q: "fri" })).toEqual(["Black Friday"]);
  });
});

describe("approvals", () => {
  it("lets only the named approvers decide, and only then marks it live", async () => {
    const c = autumn({ approvers: ["selin@example.com", "hakan@example.com"] });
    expect(() => app.campaigns.decide(EMILY, c.id, { decision: "approved" })).toThrow(/Only the members the campaign names/);
    await expect(app.campaigns.launch(EMILY, c.id)).rejects.toThrow(/Selin Aydın has not approved it yet. Hakan Yıldız has not approved it yet./);
    expect(app.campaigns.decide(SELIN, c.id, { decision: "approved", note: "Budget is fine." }).approvals[0]).toMatchObject({
      state: "approved",
      note: "Budget is fine.",
    });
    expect(() => app.campaigns.decide(HAKAN, c.id, { decision: "changes" })).toThrow(/note says what to change/);
    const asked = app.campaigns.decide(HAKAN, c.id, { decision: "changes", note: "Add the B2B list." });
    expect(asked.blockers).toEqual(["Hakan Yıldız asked for changes."]);
    // A change to what was approved sets every decision back to waiting.
    const changed = app.campaigns.updateCampaign(EMILY, c.id, { brief: "Bring trial users and the B2B list back." });
    expect(changed.approvals.map((a) => a.state)).toEqual(["waiting", "waiting"]);
    expect(changed.activity.map((a) => a.text).slice(0, 2)).toEqual(["The approvals are waiting again: what was approved changed.", "Changed the brief."]);
    // Who owns it does not change what was approved.
    app.campaigns.decide(SELIN, c.id, { decision: "approved" });
    app.campaigns.decide(HAKAN, c.id, { decision: "approved" });
    expect(app.campaigns.updateCampaign(EMILY, c.id, { owner: "hakan@example.com" }).approved).toBe(true);

    const { campaign, automation } = await app.campaigns.launch(EMILY, c.id);
    expect(campaign.status).toBe("live");
    expect(automation).toEqual({ sent: true, started: true, error: null });
    expect(app.fakes.state.automation.hooks).toEqual([
      {
        playbook: "pb_launch",
        body: {
          type: "campaign_launched",
          campaign: {
            id: c.id,
            name: "Autumn",
            utm: "autumn-2026",
            start: "2026-10-01",
            end: "2026-10-31",
            owner: "Hakan Yıldız",
            channels: ["email", "paid-search", "paid-social"],
            budget: 120000,
            currency: "TRY",
            url: `${app.base}/campaigns/${c.id}`,
          },
          by: "Emily Clark",
        },
      },
    ]);
    expect(() => app.campaigns.decide(SELIN, c.id, { decision: "approved" })).toThrow(/approvals are for a planned campaign/);
  });

  it("marks live a campaign that names no approvers, and says when Automation could not be told", async () => {
    const c = autumn({ approvers: [] });
    app.fakes.state.automation.conditions = false;
    expect((await app.campaigns.launch(EMILY, c.id)).automation).toEqual({ sent: true, started: false, error: null });
    const d = app.campaigns.createCampaign(EMILY, { name: "Winter", start: "2026-12-01", end: "2026-12-31", approvers: [] });
    await app.fakes.close();
    const r = await app.campaigns.launch(EMILY, d.id);
    expect(r.campaign.status).toBe("live");
    expect(r.automation.error).toMatch(/Automation could not be reached/);
    expect(app.campaigns.integrations().automation.lastError).toMatch(/could not be reached/);
  });

  it("ends a live campaign the day after its end day, and keeps a run campaign from editors' deletes", async () => {
    const c = autumn({ approvers: [], start: "2026-10-01", end: "2026-11-02" });
    await app.campaigns.launch(EMILY, c.id);
    expect(app.campaigns.endPastCampaigns()).toBe(0);
    app.clock.advance(86_400_000);
    expect(app.campaigns.endPastCampaigns()).toBe(1);
    const ended = app.campaigns.getCampaign(EMILY, c.id);
    expect(ended.status).toBe("ended");
    expect(ended.activity[0]).toMatchObject({ by: "Campaigns", text: "Ended: its end day, 2026-11-02, has passed." });
    expect(() => app.campaigns.removeCampaign(EMILY, c.id)).toThrow(/an admin can delete it/);
    app.campaigns.removeCampaign(SELIN, c.id);
    expect(() => app.campaigns.getCampaign(EMILY, c.id)).toThrow(/does not exist/);
  });
});

describe("tagged links and QR codes", () => {
  it("tags links with the channel's medium and an allowed source, once per address", async () => {
    const c = autumn();
    const a = app.campaigns.createLink(EMILY, c.id, { destination: "https://www.example.com/autumn?ref=menu", channel: "paid-search", content: "Hero Banner" });
    expect(a.status).toBe(201);
    expect(a.link).toMatchObject({
      url: "https://www.example.com/autumn?ref=menu&utm_source=google&utm_medium=cpc&utm_campaign=autumn-2026&utm_content=hero-banner",
      source: "google",
      medium: "cpc",
      channelName: "Paid search",
    });
    expect(
      app.campaigns.createLink(HAKAN, c.id, { destination: "https://www.example.com/autumn?ref=menu", channel: "paid-search", content: "hero banner" }),
    ).toMatchObject({
      status: 200,
      link: { id: a.link.id },
    });
    expect(() => app.campaigns.createLink(EMILY, c.id, { destination: "https://www.example.com/", channel: "paid-search", source: "facebook" })).toThrow(
      /Paid search links may carry: google/,
    );
    expect(app.campaigns.createLink(EMILY, c.id, { destination: "https://www.example.com/", channel: "email" }).link.source).toBe("newsletter");
    expect(() => app.campaigns.createLink(EMILY, c.id, { destination: "ftp://example.com/", channel: "email" })).toThrow(/http:\/\/ or https:\/\//);

    const svg = await app.campaigns.linkQr(a.link.id, null);
    expect(svg.type).toBe("image/svg+xml");
    expect(String(svg.body)).toMatch(/^<svg/);
    expect(svg.name).toBe("autumn-2026-paid-search-hero-banner.svg");
    const png = await app.campaigns.linkQr(a.link.id, "png");
    expect((png.body as Buffer).subarray(1, 4).toString()).toBe("PNG");
  });
});

describe("tasks and assets", () => {
  it("keeps the work of a campaign, and each member's open tasks", () => {
    app.clock.set(Date.parse("2026-10-01T09:00:00Z"));
    const c = autumn();
    const t = app.campaigns.createTask(EMILY, c.id, { text: "Write the email", owner: "hakan@example.com", due: "2026-10-03", channel: "email" });
    app.campaigns.createTask(EMILY, c.id, { text: "Order the banners", due: "2026-11-30" });
    expect(t).toMatchObject({ owner: { name: "Hakan Yıldız" }, overdue: false });
    app.clock.set(Date.parse("2026-10-05T09:00:00Z"));
    expect(app.campaigns.listTasks(HAKAN, new URLSearchParams({ owner: "me" })).map((x) => [x.text, x.overdue])).toEqual([["Write the email", true]]);
    app.campaigns.updateTask(HAKAN, t.id, { done: true });
    expect(app.campaigns.listTasks(HAKAN, new URLSearchParams({ owner: "me" }))).toEqual([]);
    const a = app.campaigns.createAsset(EMILY, c.id, { name: "Hero banner", url: "https://files.example.com/s/abc", channel: "paid-social" });
    const got = app.campaigns.getCampaign(VELI, c.id);
    expect(got.counts).toEqual({ links: 0, tasks: 2, tasksDone: 1, assets: 1 });
    expect(got.assets[0]).toMatchObject({ id: a.id, name: "Hero banner" });
    expect(got.activity.map((x) => x.text)).toContain("Done: Write the email");
  });
});

describe("spend", () => {
  it("takes spend by hand and by CSV, a CSV row replacing the same campaign, channel and day", () => {
    const c = autumn();
    app.campaigns.addSpend(EMILY, { campaign: c.id, channel: "events", day: "2026-10-04", amount: 15000, note: "Fair stand" });
    const csv = [
      "Tarih;Campaign;Channel;Cost;Note",
      "05.10.2026;autumn-2026;paid-social;1.250,50;",
      "06.10.2026;Autumn;Paid social;2000;",
      "07.10.2026;nope;email;10;",
      "x;autumn-2026;email;10;",
    ].join("\n");
    const check = app.campaigns.importSpend(EMILY, { csv: csv.replace("Tarih", "date"), check: true });
    expect(check).toMatchObject({ check: true, rows: 4, valid: 2, added: 0, errors: [{ line: 4 }, { line: 5 }] });
    expect(check.errors[0]!.error).toMatch(/no campaign's utm_campaign/);
    const first = app.campaigns.importSpend(EMILY, { csv: csv.replace("Tarih", "date") });
    expect(first).toMatchObject({ added: 2, replaced: 0 });
    const again = app.campaigns.importSpend(EMILY, { csv: "day,campaign,channel,amount\n2026-10-05,autumn-2026,paid-social,1300" });
    expect(again).toMatchObject({ added: 0, replaced: 1 });
    const got = app.campaigns.getCampaign(EMILY, c.id);
    expect(got.spend).toBe(15000 + 1300 + 2000);
    expect(got.channels.find((x) => x.id === "paid-social")!.spend).toBe(3300);
    expect(() => app.campaigns.importSpend(EMILY, { csv: "day,amount\n" })).toThrow(/needs campaign, channel/);
  });

  it("reads Google Ads and Meta, gives each ad campaign to the campaign its name carries, and keeps the rest unclaimed", async () => {
    const c = autumn();
    const retarget = app.campaigns.createCampaign(EMILY, {
      name: "Autumn retargeting",
      utm: "autumn-2026-retargeting",
      start: "2026-10-01",
      end: "2026-10-31",
    });
    app.fakes.state.google.rows = [
      { id: 11, name: "TR | autumn-2026 | Search", date: "2026-10-20", costMicros: 1_234_560_000, clicks: 300, impressions: 9000 },
      { id: 11, name: "TR | autumn-2026 | Search", date: "2026-10-21", costMicros: 1_000_000_000, clicks: 200, impressions: 7000 },
      { id: 12, name: "autumn-2026-retargeting display", date: "2026-10-21", costMicros: 500_000_000 },
      { id: 13, name: "Brand always on", date: "2026-10-21", costMicros: 700_000_000 },
    ];
    app.fakes.state.meta.rows = [
      { id: 21, name: "Autumn 2026 - Instagram", date: "2026-10-20", spend: "400.25" },
      { id: 21, name: "Autumn 2026 - Instagram", date: "2026-10-21", spend: "350.00" },
      { id: 22, name: "Lookalike test", date: "2026-10-21", spend: "99.99" },
    ];
    const r = await app.campaigns.syncAds();
    expect(r.from).toBe("2026-10-04");
    expect(r.platforms).toEqual([
      { platform: "google", rows: 4, matched: 3, unmatched: 1, otherCurrency: 0, error: null },
      { platform: "meta", rows: 3, matched: 2, unmatched: 1, otherCurrency: 0, error: null },
    ]);
    // Meta's insights were read over two pages.
    expect(app.fakes.state.calls.filter((x) => x.path.endsWith("/insights"))).toHaveLength(2);
    const ads = app.fakes.state.calls.find((x) => x.path.endsWith("googleAds:searchStream"))!;
    expect(JSON.parse(ads.body).query).toContain("segments.date BETWEEN '2026-10-04' AND '2026-11-02'");
    expect(app.campaigns.getCampaign(EMILY, c.id).channels.map((x) => [x.id, x.spend])).toEqual([
      ["email", 0],
      ["paid-search", 2234.56],
      ["paid-social", 750.25],
    ]);
    expect(app.campaigns.getCampaign(EMILY, retarget.id).spend).toBe(500);
    const un = app.campaigns.listSpend(new URLSearchParams({ unmatched: "true" }));
    expect(un.unmatched).toEqual({ rows: 2, amount: 799.99 });

    // Claiming an unmatched ad campaign moves its spend, and the next read keeps it there.
    const brand = un.spend.find((s) => s.adCampaign === "Brand always on")!;
    expect(app.campaigns.assignSpend(EMILY, brand.id, { campaign: c.id }).campaign!.id).toBe(c.id);
    expect(app.campaigns.getCampaign(EMILY, c.id).adNames).toEqual(["Brand always on"]);
    // A day the platform corrects to nothing goes; a changed figure replaces the old one.
    app.fakes.state.google.rows = app.fakes.state.google.rows
      .filter((x) => x.date !== "2026-10-20")
      .map((x) => (x.id === 11 ? { ...x, costMicros: 900_000_000 } : x));
    await app.campaigns.syncAds();
    expect(app.campaigns.getCampaign(EMILY, c.id).channels.find((x) => x.id === "paid-search")!.spend).toBe(900 + 700);
    expect(() => app.campaigns.removeSpend(EMILY, brand.id)).toThrow(/replaced by the platform's own figures/);
  });

  it("leaves out spend in another currency, and says when a platform refuses", async () => {
    autumn();
    app.fakes.state.meta.currency = "USD";
    app.fakes.state.meta.rows = [{ id: 21, name: "autumn-2026", date: "2026-10-20", spend: "10" }];
    app.fakes.state.google.status = 500;
    const r = await app.campaigns.syncAds();
    expect(r.platforms[0]!.error).toMatch(/Google Ads answered 500/);
    expect(r.platforms[1]).toMatchObject({ rows: 0, otherCurrency: 1, error: "1 rows are in another currency than TRY and were left out." });
    expect(app.campaigns.integrations().google.lastError).toMatch(/500/);
  });
});

describe("results and attribution", () => {
  async function scene() {
    const c = autumn({ approvers: [], messagesIds: ["m-b2b"] });
    await app.campaigns.launch(EMILY, c.id);
    const b2b = app.campaigns.createCampaign(EMILY, { name: "Webinar", start: "2026-09-01", end: "2026-09-30", channels: ["email"], approvers: [] });
    const f = app.fakes.state;
    const visit = (daysAgo: number, campaign: string | null, medium: string | null, source: string | null, goals: string[] = []) => ({
      daysAgo,
      utm: { campaign, medium, source },
      goals,
    });
    f.analytics.visits = [
      visit(5, "autumn-2026", "email", "messages", ["Signup"]),
      visit(6, "autumn-2026", "email", "messages"),
      visit(7, "autumn-2026", "cpc", "google", ["Signup"]),
      visit(8, "autumn-2026", "cpc", "google"),
      visit(9, "autumn-2026", "cpc", "google"),
      visit(10, "autumn-2026", "paid-social", "instagram"),
      visit(11, "autumn-b2b-oct", "email", "messages"),
      visit(12, "autumn-2026", null, null),
      visit(12, "winter-2026", "cpc", "google"),
      visit(60, "autumn-2026", "cpc", "google"),
    ];
    f.messages.campaigns = [
      {
        id: "m-1",
        name: "Autumn",
        slug: "autumn-2026",
        channel: "email",
        state: "sent",
        startedAt: "2026-10-02T07:00:00Z",
        counts: { sent: 1000, delivered: 980, opened: 180, clicked: 40, bounced: 20, unsubscribed: 3 },
      },
      {
        id: "m-b2b",
        name: "Autumn B2B Oct",
        slug: "autumn-b2b-oct",
        channel: "email",
        state: "sent",
        startedAt: "2026-10-05T07:00:00Z",
        counts: { sent: 200, delivered: 200, opened: 60, clicked: 10, bounced: 0, unsubscribed: 0 },
      },
      {
        id: "m-2",
        name: "Other",
        slug: "other",
        channel: "sms",
        state: "sent",
        startedAt: null,
        counts: { sent: 5, delivered: 5, opened: 0, clicked: 0, bounced: 0, unsubscribed: 0 },
      },
    ];
    const deal = (id: string, value: number, wonAt: string, email: string | null, sourceDetail: string | null = null, extra: Record<string, unknown> = {}) => ({
      id,
      name: `Deal ${id}`,
      pipeline: "sales",
      status: "won",
      value,
      currency: "TRY",
      closedAt: wonAt,
      createdAt: "2026-10-01T09:00:00Z",
      company: { id: `co-${id}`, name: `Company ${id}` },
      contact: email && { id: `ct-${id}`, name: id, email },
      source: sourceDetail ? "live-chat" : "manual",
      sourceDetail,
      ...extra,
    });
    f.crm.deals = [
      // First touch webinar in September, last touch autumn's paid search.
      deal("d1", 100000, "2026-10-25T12:00:00Z", "ayse@example.com"),
      // A Live Chat lead tagged with autumn, and no other touch.
      deal("d2", 50000, "2026-10-26T12:00:00Z", null, "autumn-2026"),
      // A click in the B2B email, which autumn claims by its Messages id.
      deal("d3", 30000, "2026-10-27T12:00:00Z", "mert@example.com"),
      // Touched only long before the window: not attributed.
      deal("d4", 20000, "2026-10-28T12:00:00Z", "old@example.com"),
      // In another currency: listed, not added.
      deal("d5", 1000, "2026-10-28T12:00:00Z", null, "autumn-2026", { currency: "EUR" }),
      // Open deals are not read.
      deal("d6", 1, "2026-10-28T12:00:00Z", null, "autumn-2026", { status: "open" }),
    ];
    f.audience.people.set("ayse@example.com", {
      id: "p-ayse",
      events: [
        {
          id: 1,
          source: "analytics",
          type: "visit_started",
          at: "2026-09-10T10:00:00Z",
          text: null,
          properties: { utm_campaign: "webinar-2026", utm_medium: "email" },
        },
        { id: 2, source: "analytics", type: "page_viewed", at: "2026-09-10T10:01:00Z", text: null, properties: { path: "/" } },
        {
          id: 3,
          source: "analytics",
          type: "visit_started",
          at: "2026-10-20T10:00:00Z",
          text: null,
          properties: { utm_campaign: "unknown-thing", utm_medium: "cpc" },
        },
        {
          id: 4,
          source: "analytics",
          type: "visit_started",
          at: "2026-10-21T10:00:00Z",
          text: null,
          properties: { utm_campaign: "autumn-2026", utm_medium: "cpc" },
        },
        // After the deal was won: not a touch.
        {
          id: 5,
          source: "messages",
          type: "message_clicked",
          at: "2026-10-30T10:00:00Z",
          text: null,
          properties: { campaign: "webinar-2026", channel: "email" },
        },
      ],
    });
    f.audience.people.set("mert@example.com", {
      id: "p-mert",
      events: [
        {
          id: 6,
          source: "messages",
          type: "message_clicked",
          at: "2026-10-06T08:00:00Z",
          text: null,
          properties: { campaign: "autumn-b2b-oct", channel: "email" },
        },
      ],
    });
    f.audience.people.set("old@example.com", {
      id: "p-old",
      events: [
        {
          id: 7,
          source: "analytics",
          type: "visit_started",
          at: "2026-06-01T08:00:00Z",
          text: null,
          properties: { utm_campaign: "autumn-2026", utm_medium: "cpc" },
        },
      ],
    });
    app.campaigns.addSpend(EMILY, { campaign: c.id, channel: "paid-search", day: "2026-10-10", amount: 60000 });
    app.campaigns.addSpend(EMILY, { campaign: c.id, channel: "email", day: "2026-10-02", amount: 5000 });
    app.campaigns.addSpend(EMILY, { campaign: b2b.id, channel: "email", day: "2026-09-02", amount: 2000 });
    return { c, b2b };
  }

  it("rolls visits, sends and deals up per channel, and counts each deal for its first and its last campaign", async () => {
    const { c, b2b } = await scene();
    const s = await app.campaigns.sync();
    expect(s.errors).toEqual({});
    expect(s.deals).toBe(5);
    // Autumn started 32 days before today: Analytics' 90 days cover it, with its own and the B2B email's slug.
    const report = app.fakes.state.calls.find((x) => x.path === "/analytics/api/v1/report" && x.query.includes("autumn"))!;
    expect(new URLSearchParams(report.query).getAll("filter")).toEqual(["utmCampaign:is:autumn-2026|autumn-b2b-oct"]);
    expect(new URLSearchParams(report.query).get("days")).toBe("90");

    const r = app.campaigns.results(EMILY, c.id);
    expect(r.window).toMatchObject({ days: 90, partial: false });
    expect(r.totals).toMatchObject({
      budget: 120000,
      spend: 65000,
      visits: 9,
      sent: 1200,
      opened: 240,
      clicked: 50,
      first: { deals: 2, revenue: 80000, roi: 0.2308 },
      last: { deals: 3, revenue: 180000, roi: 1.7692 },
      costPerVisit: 7222.22,
    });
    const ch = Object.fromEntries(r.channels.map((x) => [x.id ?? "none", x]));
    expect(ch.email).toMatchObject({
      planned: true,
      budget: 10000,
      spend: 5000,
      visits: 3,
      sent: 1200,
      first: { deals: 1, revenue: 30000 },
      last: { deals: 1, revenue: 30000 },
    });
    expect(ch["paid-search"]).toMatchObject({ budget: 80000, spend: 60000, visits: 4, last: { deals: 1, revenue: 100000 }, first: { deals: 0 } });
    expect(ch["paid-social"]).toMatchObject({ visits: 1 });
    // The Live Chat lead's touch has no channel; the untagged visit has no medium.
    expect(ch.none).toMatchObject({ planned: false, visits: 1, first: { deals: 1, revenue: 50000 }, last: { deals: 1, revenue: 50000 } });
    expect(r.goals.map((g) => [g.metric, g.actual, g.actualFirst, g.share])).toEqual([
      ["visits", 9, null, 0.0015],
      ["conversions", 2, null, 0.0067],
      ["deals", 3, 2, 0.12],
    ]);
    expect(r.deals.map((d) => [d.id, d.first?.campaign.utm, d.last?.campaign.utm, d.counted])).toEqual([
      ["d5", "autumn-2026", "autumn-2026", false],
      ["d3", "autumn-2026", "autumn-2026", true],
      ["d2", "autumn-2026", "autumn-2026", true],
      ["d1", "webinar-2026", "autumn-2026", true],
    ]);
    expect(r.deals.find((d) => d.id === "d1")).toMatchObject({
      first: { channel: "email", via: "visit", at: "2026-09-10T10:00:00Z" },
      last: { channel: "paid-search" },
      touches: 2,
    });

    // The webinar is d1's first touch only.
    expect(app.campaigns.results(EMILY, b2b.id).totals).toMatchObject({
      spend: 2000,
      first: { deals: 1, revenue: 100000, roi: 49 },
      last: { deals: 0, revenue: 0, roi: -1 },
    });

    const rep = app.campaigns.report(EMILY, new URLSearchParams({ from: "2026-09-01", to: "2026-10-31" }));
    expect(rep.campaigns.map((x) => x.utm)).toEqual(["webinar-2026", "autumn-2026"]);
    expect(rep.totals).toMatchObject({ spend: 67000, first: { deals: 3, revenue: 180000 }, last: { deals: 3, revenue: 180000 } });
    expect(rep.notAttributed).toEqual({ deals: 1, revenue: 20000 });
    expect(rep.wonInPeriod).toEqual({ deals: 4, revenue: 200000 });
    expect(rep.channels.find((x) => x.id === "email")).toMatchObject({ campaigns: 2, spend: 7000, first: { deals: 2, revenue: 130000 } });

    const att = app.campaigns.attribution(new URLSearchParams({ from: "2026-10-01", to: "2026-10-31" }));
    expect(att.deals.find((d) => d.id === "d4")).toMatchObject({ first: null, last: null, touches: 0 });
  });

  it("counts a campaign made later for the touches its name was in", async () => {
    await scene();
    await app.campaigns.sync();
    expect(app.campaigns.attribution(new URLSearchParams({ from: "2026-10-01", to: "2026-10-31" })).deals.find((d) => d.id === "d1")!.first!.campaign.utm).toBe(
      "webinar-2026",
    );
    const later = app.campaigns.createCampaign(EMILY, { name: "Unknown thing", utm: "unknown-thing", start: "2026-10-15", end: "2026-10-22" });
    const r = app.campaigns.results(EMILY, later.id);
    expect(r.totals.first.deals).toBe(0);
    expect(r.deals).toEqual([]);
    expect(app.campaigns.attribution(new URLSearchParams({ from: "2026-10-01", to: "2026-10-31", campaign: later.id })).deals).toEqual([]);
    // Its one touch sits between the two others, so it is neither first nor last.
    expect(app.campaigns.attribution(new URLSearchParams({ from: "2026-10-25", to: "2026-10-25" })).deals[0]).toMatchObject({ touches: 3 });
  });

  it("keeps what was read when a product does not answer, and says so", async () => {
    const { c } = await scene();
    await app.campaigns.sync();
    app.fakes.state.analytics.status = 503;
    app.fakes.state.crm.status = 500;
    const s = await app.campaigns.sync();
    expect(s.errors.analytics).toMatch(/Analytics answered 503/);
    expect(s.errors.crm).toMatch(/CRM answered 500/);
    const r = app.campaigns.results(EMILY, c.id);
    expect(r.totals.visits).toBe(9);
    expect(r.totals.last.deals).toBe(3);
    expect(r.errors.analytics).toMatch(/503/);
    expect(app.campaigns.integrations().crm).toMatchObject({ linked: true, tokenSet: true, lastError: expect.stringMatching(/500/) });
  });

  it("keeps a deal's touches when Audience does not answer, and drops deals no longer won", async () => {
    await scene();
    await app.campaigns.sync();
    app.fakes.state.audience.status = 503;
    app.fakes.state.crm.deals = app.fakes.state.crm.deals.map((d) => (d.id === "d1" ? { ...d, value: 120000 } : d)).filter((d) => d.id !== "d2");
    const s = await app.campaigns.sync();
    expect(s.errors.audience).toMatch(/503/);
    const deals = app.campaigns.attribution(new URLSearchParams({ from: "2026-10-01", to: "2026-10-31" })).deals;
    expect(deals.map((d) => d.id)).toEqual(["d4", "d5", "d3", "d1"]);
    expect(deals.find((d) => d.id === "d1")).toMatchObject({ value: 100000, first: { campaign: { utm: "webinar-2026" } } });
    app.fakes.state.audience.status = 200;
    await app.campaigns.sync();
    expect(app.campaigns.attribution(new URLSearchParams({ from: "2026-10-01", to: "2026-10-31" })).deals.find((d) => d.id === "d1")!.value).toBe(120000);
  });

  it("stops reading an ended campaign once it has settled", async () => {
    const { c } = await scene();
    app.campaigns.end(EMILY, c.id);
    await app.campaigns.sync();
    app.clock.advance(15 * 86_400_000);
    await app.campaigns.sync();
    app.fakes.state.analytics.visits = [];
    await app.campaigns.sync();
    expect(app.campaigns.results(EMILY, c.id)).toMatchObject({ frozen: true, totals: { visits: 9 } });
  });

  it("deletes the deals of a person Audience deletes, once per reference", async () => {
    await scene();
    await app.campaigns.sync();
    const req = { reference: "KVKK-7", product: "audience", people: { emails: ["AYSE@example.com"], phones: [], userIds: [] } };
    expect(app.campaigns.erase(req)).toEqual({ status: "done", deleted: 1 });
    expect(app.campaigns.erase(req)).toEqual({ status: "done", deleted: 1 });
    expect(app.campaigns.attribution(new URLSearchParams({ from: "2026-10-01", to: "2026-10-31" })).deals.map((d) => d.id)).not.toContain("d1");
  });
});
