// Writes openapi.json (ADR 0014, 0024). Run `npm run openapi` after changing the API; a test fails when the file is out
// of date. Sign-in routes come from @openasy/auth and are merged in when the description is served.
import { readFileSync, writeFileSync } from "node:fs";

type S = Record<string, unknown>;
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const str = { type: "string" };
const int = { type: "integer" };
const num = { type: "number" };
const bool = { type: "boolean" };
const dt = { type: "string", format: "date-time" };
const day = { type: "string", format: "date", examples: ["2026-10-01"] };
const nul = (s: S) => ({ anyOf: [s, { type: "null" }] });
const arr = (s: S) => ({ type: "array", items: s });
const obj = (properties: Record<string, S>, required = Object.keys(properties)) => ({ type: "object", required, properties });
const map = { type: "object" };
const en = (...values: string[]) => ({ type: "string", enum: values });

const problem = { $ref: "#/components/responses/Problem" };
const ok = (schema: S, description = "OK") => ({ description, content: { "application/json": { schema } } });
const none = (description: string) => ({ description });
const SECURE = [{ session: [] }, { apiToken: [] }, { adminToken: [] }];
const id = (what: string) => [{ name: "id", in: "path", required: true, description: `The ${what}'s id.`, schema: str }];
const query = (name: string, description: string, schema: S = str) => ({ name, in: "query", required: false, description, schema });
const json = (schema: S) => ({ required: true, content: { "application/json": { schema } } });

/** An operation that needs a role (ADR 0003), with the refusals every such operation can answer. */
function op(role: "viewer" | "editor" | "admin", o: S & { responses: Record<string, unknown> }) {
  return {
    ...o,
    security: SECURE,
    "x-openasy-role": role,
    description: [o.description, `Needs the ${role} role.`].filter(Boolean).join("\n\n"),
    responses: { ...o.responses, "401": problem, "403": problem },
  };
}
const pub = (o: S & { responses: Record<string, unknown> }) => ({ ...o, security: [] });

const STATUS = en("planned", "live", "ended", "cancelled");
const METRIC = en("visits", "conversions", "sends", "opens", "clicks", "deals", "revenue");
const Who = nul(obj({ id: str, name: str }));
const Named = obj({ id: str, name: str });

const Approval = obj({
  email: str,
  name: str,
  state: { ...en("waiting", "approved", "changes"), description: "changes: the approver asked for changes, with a note." },
  note: nul(str),
  decidedAt: nul(dt),
});
const Goal = obj({ id: str, metric: METRIC, goal: nul({ ...str, description: "The Analytics goal conversions count, by name." }), target: num });
const Campaign = obj({
  id: str,
  name: str,
  utm: { ...str, description: "Its utm_campaign, made by the file's naming rules; fixed once it has links or is live." },
  status: STATUS,
  start: day,
  end: day,
  brief: nul(str),
  message: nul({ ...str, description: "The one thing it says." }),
  audience: nul({ ...str, description: "Who it is for, in words." }),
  owner: Who,
  currency: str,
  budget: num,
  spend: { ...num, description: "Everything spent: entered, imported from CSV and read from the ad platforms." },
  channels: arr(obj({ id: str, name: str, inFile: bool, budget: num, spend: num })),
  goals: arr(Goal),
  approvals: arr(Approval),
  approved: { ...bool, description: "Every approver approved, or it names none." },
  myApproval: nul({ ...en("waiting", "approved", "changes"), description: "The caller's own decision, when the campaign names them." }),
  canLaunch: bool,
  blockers: { ...arr(str), description: "Why it cannot be marked live yet." },
  adNames: { ...arr(str), description: "Ad platform campaigns, by name or id, whose spend is this campaign's beyond those whose name carries utm." },
  messagesIds: { ...arr(str), description: "Messages campaigns, by id, whose sends count here beyond those whose slug is utm." },
  counts: obj({ links: int, tasks: int, tasksDone: int, assets: int }),
  launchedAt: nul(dt),
  endedAt: nul(dt),
  createdAt: dt,
  createdBy: str,
  updatedAt: dt,
});
const Link = obj({
  id: str,
  campaign: str,
  channel: str,
  channelName: nul(str),
  destination: str,
  source: str,
  medium: str,
  content: nul(str),
  term: nul(str),
  url: { ...str, description: "The destination with utm_source, utm_medium, utm_campaign and, when set, utm_content and utm_term." },
  label: nul(str),
  qr: { ...str, description: "The address of its QR code, SVG or ?format=png." },
  visits: nul({
    ...int,
    description:
      "Visits Analytics counted with its utm_source, utm_medium and utm_campaign at the last read; links that differ only in utm_content share them.",
  }),
  createdAt: dt,
  createdBy: str,
});
const Task = obj({
  id: str,
  campaign: Named,
  text: str,
  channel: nul(str),
  owner: Who,
  due: nul(day),
  overdue: bool,
  doneAt: nul(dt),
  doneBy: nul(str),
  createdAt: dt,
});
const Asset = obj({ id: str, name: str, url: str, channel: nul(str), createdAt: dt, createdBy: str });
const Spend = obj({
  id: str,
  campaign: nul(obj({ id: str, name: str, utm: str })),
  channel: nul(str),
  channelName: nul(str),
  day,
  amount: num,
  source: en("manual", "csv", "google", "meta"),
  adCampaign: nul(str),
  adCampaignId: nul(str),
  clicks: nul(int),
  impressions: nul(int),
  note: nul(str),
  createdAt: dt,
  createdBy: str,
});
const Attribution = obj({ deals: int, revenue: num });
const AttributionRoi = obj({ deals: int, revenue: num, roi: nul({ ...num, description: "(revenue - spend) / spend; null without spend." }) });
const Touch = nul(
  obj({
    campaign: obj({ id: str, name: str, utm: str }),
    channel: nul(str),
    channelName: nul(str),
    at: dt,
    via: { ...en("visit", "message", "crm"), description: "A tagged visit, a click in a message, or the lead's own source in CRM." },
  }),
);
const Deal = obj({
  id: str,
  name: str,
  value: { ...num, description: "In the deal's currency, without KDV." },
  currency: str,
  counted: { ...bool, description: "In the file's currency, so counted in deals and revenue." },
  wonAt: dt,
  company: nul(str),
  url: nul(str),
  first: Touch,
  last: Touch,
  touches: { ...int, description: "Touches that name one of the campaigns." },
});
const Totals = obj({
  budget: num,
  spend: num,
  visits: int,
  visitors: int,
  engagedVisits: int,
  sent: int,
  delivered: int,
  opened: int,
  clicked: int,
  first: AttributionRoi,
  last: AttributionRoi,
  costPerVisit: nul(num),
});
const ChannelResult = obj({
  id: nul({ ...str, description: "null for what has no channel: visits without utm_medium, a CRM lead's source." }),
  name: nul(str),
  planned: bool,
  budget: num,
  spend: num,
  visits: int,
  visitors: int,
  sent: int,
  opened: int,
  clicked: int,
  first: Attribution,
  last: Attribution,
});
const LinkState = obj({ linked: bool, url: nul(str), tokenSet: bool, lastOkAt: nul(dt), lastError: nul(str), lastTriedAt: nul(dt) });

const schemas: Record<string, S> = {
  Problem: obj(
    {
      type: { type: "string", format: "uri" },
      title: str,
      status: int,
      code: {
        type: "string",
        description: "Stable; match on this.",
        enum: [
          "invalid-token",
          "invalid-json",
          "invalid-body",
          "forbidden",
          "not-found",
          "conflict",
          "not-linked",
          "not-available",
          "link-failed",
          "rate-limited",
          "payload-too-large",
          "internal-error",
          "unauthenticated",
          "invalid-credentials",
          "mfa-required",
          "mfa-setup-required",
          "cross-site",
        ],
      },
      detail: str,
    },
    ["type", "title", "status", "code"],
  ),
  Status: obj({ status: str }),
  Version: obj({ product: { const: "campaigns" }, version: str }),
  ProductList: obj({ products: arr(obj({ id: str, url: str })) }),
  Summary: obj({
    today: day,
    currency: str,
    campaigns: obj({ planned: int, live: int, ended: int, cancelled: int }),
    waitingForMe: arr(obj({ id: str, name: str, start: day })),
    startingSoon: arr(obj({ id: str, name: str, start: day, canLaunch: bool })),
    myTasks: obj({ open: int, overdue: int }),
    month: obj({ month: str, spend: num, budget: num }),
    unmatchedSpend: obj({ rows: int, amount: num }),
    linked: obj({ analytics: bool, messages: bool, crm: bool, audience: bool, automation: bool, google: bool, meta: bool }),
    readAt: nul(dt),
    fileError: nul(str),
  }),
  Settings: obj({ file: nul(map), yaml: str, config: nul(map) }),
  Team: obj({ members: arr(obj({ id: str, name: str, email: str })) }),
  Integrations: obj({
    analytics: { ...LinkState, properties: { ...LinkState.properties, site: nul(str) } },
    messages: LinkState,
    crm: { ...LinkState, properties: { ...LinkState.properties, pipeline: nul(str) } },
    audience: LinkState,
    automation: { ...LinkState, properties: { ...LinkState.properties, playbook: nul(str) } },
    google: LinkState,
    meta: LinkState,
  }),
  Naming: obj({ utm: str, problem: nul(str), taken: nul(Named), rule: str }),
  Campaign,
  CampaignList: obj({ campaigns: arr(ref("Campaign")) }),
  CampaignDetail: {
    allOf: [
      ref("Campaign"),
      obj({
        links: arr(ref("Link")),
        tasks: arr(ref("Task")),
        assets: arr(ref("Asset")),
        activity: arr(obj({ at: dt, by: str, text: str })),
      }),
    ],
  },
  CampaignInput: {
    type: "object",
    properties: {
      name: str,
      utm: { ...nul(str), description: "Leave out to make it by the naming rules." },
      start: day,
      end: day,
      brief: nul(str),
      message: nul(str),
      audience: nul(str),
      owner: { ...nul(str), description: "A member's id or email; the caller when left out on create." },
      budget: { ...nul(num), description: "The whole budget; the channels' budgets added up when left out on create." },
      channels: arr({ anyOf: [str, obj({ id: str, budget: num }, ["id"])] }),
      goals: arr(obj({ metric: METRIC, target: num, goal: nul(str) }, ["metric", "target"])),
      approvers: { ...arr(str), description: "Members by email or id; approvals.approvers of the file when left out on create." },
      adNames: arr(str),
      messagesIds: arr(str),
    },
  },
  Decision: obj({ decision: en("approved", "changes"), note: nul({ ...str, description: "Needed with changes." }) }, ["decision"]),
  Launched: obj({
    campaign: ref("CampaignDetail"),
    automation: obj({ sent: bool, started: { ...bool, description: "The playbook's conditions held and a run started." }, error: nul(str) }),
  }),
  Link,
  LinkList: obj({ links: arr({ allOf: [ref("Link"), obj({ campaignName: str })] }) }),
  LinkInput: obj(
    {
      destination: str,
      channel: str,
      source: { ...nul(str), description: "One the channel allows; its first when left out." },
      content: nul(str),
      term: nul(str),
      label: nul(str),
    },
    ["destination", "channel"],
  ),
  Task,
  TaskList: obj({ tasks: arr(ref("Task")) }),
  TaskInput: { type: "object", properties: { text: str, owner: nul(str), due: nul(day), channel: nul(str), done: bool } },
  Asset,
  AssetInput: obj({ name: str, url: str, channel: nul(str) }, ["name", "url"]),
  Spend,
  SpendList: obj({ spend: arr(ref("Spend")), unmatched: obj({ rows: int, amount: num }), currency: str }),
  SpendInput: obj({ campaign: str, channel: str, day, amount: num, note: nul(str) }, ["campaign", "channel", "day", "amount"]),
  SpendAssign: obj({ campaign: str }),
  SpendImport: obj({ csv: { ...str, description: "day, campaign, channel, amount and note; comma or semicolon separated." }, check: bool }, ["csv"]),
  SpendImported: obj({ check: bool, rows: int, valid: int, added: int, replaced: int, errors: arr(obj({ line: int, error: str })) }),
  AdsRead: obj({
    from: day,
    to: day,
    platforms: arr(obj({ platform: en("google", "meta"), rows: int, matched: int, unmatched: int, otherCurrency: int, error: nul(str) })),
  }),
  Deal,
  Results: obj({
    campaign: obj({ id: str, name: str, utm: str, status: STATUS, start: day, end: day }),
    currency: str,
    readAt: nul(dt),
    frozen: { ...bool, description: "Ended more than results.settle days ago: what was read last stays." },
    window: nul(
      obj({
        days: { type: "integer", enum: [1, 7, 30, 90] },
        from: str,
        to: str,
        partial: { ...bool, description: "The campaign is longer than Analytics' 90 days: its visits are of the last 90." },
      }),
    ),
    errors: obj({ analytics: nul(str), messages: nul(str) }),
    linked: obj({ analytics: bool, messages: bool, crm: bool, audience: bool }),
    totals: Totals,
    channels: arr(ChannelResult),
    goals: arr({
      allOf: [
        Goal,
        obj({
          actual: nul({ ...num, description: "Deals and revenue by last touch." }),
          actualFirst: nul({ ...num, description: "Deals and revenue by first touch." }),
          share: nul(num),
        }),
      ],
    }),
    analyticsGoals: arr(obj({ name: str, visits: int })),
    series: { ...arr(obj({ day: str, visits: int })), description: "Visits a day over the window, from Analytics." },
    sources: arr(obj({ source: nul(str), medium: nul(str), campaign: nul(str), visits: int, visitors: int })),
    messages: arr(
      obj({
        id: str,
        name: str,
        slug: str,
        channel: en("email", "sms", "whatsapp"),
        channelName: str,
        state: str,
        startedAt: nul(str),
        sent: int,
        delivered: int,
        opened: int,
        clicked: int,
        bounced: int,
        unsubscribed: int,
      }),
    ),
    deals: arr(ref("Deal")),
  }),
  Report: obj({
    from: day,
    to: day,
    currency: str,
    readAt: nul(dt),
    campaigns: arr({ allOf: [obj({ id: str, name: str, utm: str, status: STATUS, start: day, end: day, readAt: nul(dt) }), Totals] }),
    channels: arr(
      obj({
        id: str,
        name: str,
        campaigns: int,
        budget: num,
        spend: num,
        visits: int,
        sent: int,
        opened: int,
        clicked: int,
        first: AttributionRoi,
        last: AttributionRoi,
      }),
    ),
    totals: obj({ budget: num, spend: num, visits: int, sent: int, first: AttributionRoi, last: AttributionRoi }),
    wonInPeriod: Attribution,
    notAttributed: { ...Attribution, description: "Deals won in the period that no campaign touched." },
  }),
  AttributionList: obj({ from: day, to: day, currency: str, windowDays: int, deals: arr(ref("Deal")) }),
  SyncResult: obj({ readAt: dt, campaigns: int, deals: int, touchesRead: int, errors: { type: "object", additionalProperties: str } }),
  ErasureRequest: obj(
    {
      reference: str,
      product: str,
      people: obj({ emails: arr(str), phones: arr(str), userIds: arr(str) }, []),
    },
    ["reference", "people"],
  ),
  ErasureAnswer: obj({ status: { const: "done" }, deleted: int }),
};

const period = [query("from", "The first day, YYYY-MM-DD; 89 days before to when left out.", day), query("to", "The last day; today when left out.", day)];

const paths: Record<string, Record<string, unknown>> = {
  "/api/v1/version": { get: pub({ operationId: "version", tags: ["Product"], summary: "Product and version", responses: { "200": ok(ref("Version")) } }) },
  "/api/v1/products": {
    get: op("viewer", { operationId: "products", tags: ["Product"], summary: "The install's other products", responses: { "200": ok(ref("ProductList")) } }),
  },
  "/api/v1/summary": {
    get: op("viewer", {
      operationId: "summary",
      tags: ["Product"],
      summary: "Overview",
      description: "Campaigns by status, those waiting for the caller's approval, the caller's tasks, this month's budget and spend, and spend nobody claims.",
      responses: { "200": ok(ref("Summary")), "503": problem },
    }),
  },
  "/api/v1/settings": {
    get: op("viewer", {
      operationId: "settings",
      tags: ["Product"],
      summary: "The settings file as applied",
      description: "Read-only: the file (CAMPAIGNS_CONFIG) is the only way to change them.",
      responses: { "200": ok(ref("Settings")) },
    }),
  },
  "/api/v1/team": {
    get: op("viewer", { operationId: "team", tags: ["Product"], summary: "Members, for owners and approvers", responses: { "200": ok(ref("Team")) } }),
  },
  "/api/v1/integrations": {
    get: op("viewer", {
      operationId: "integrations",
      tags: ["Product"],
      summary: "Linked products and ad platforms",
      description: "Each link's address, whether its token is set, and how its last read went.",
      responses: { "200": ok(ref("Integrations")) },
    }),
  },
  "/api/v1/naming": {
    get: op("viewer", {
      operationId: "naming",
      tags: ["Campaigns"],
      summary: "The utm_campaign the naming rules make",
      parameters: [{ name: "name", in: "query", required: true, schema: str }, query("start", "The start day; today when left out.", day)],
      responses: { "200": ok(ref("Naming")), "422": problem, "503": problem },
    }),
  },

  "/api/v1/campaigns": {
    get: op("viewer", {
      operationId: "listCampaigns",
      tags: ["Campaigns"],
      summary: "Campaigns, for the calendar",
      parameters: [
        query("from", "Only campaigns that end on or after this day.", day),
        query("to", "Only campaigns that start on or before this day.", day),
        query("status", "planned, live, ended or cancelled."),
        query("channel", "Only campaigns on this channel."),
        query("q", "Part of the name, utm_campaign or owner."),
      ],
      responses: { "200": ok(ref("CampaignList")), "422": problem, "503": problem },
    }),
    post: op("editor", {
      operationId: "createCampaign",
      tags: ["Campaigns"],
      summary: "Plan a campaign",
      description: "utm_campaign is made by naming.campaign unless utm is given; it must follow the rules and be no other campaign's (409).",
      requestBody: json(ref("CampaignInput")),
      responses: { "201": ok(ref("CampaignDetail"), "Planned."), "400": problem, "409": problem, "422": problem, "503": problem },
    }),
  },
  "/api/v1/campaigns/{id}": {
    get: op("viewer", {
      operationId: "getCampaign",
      tags: ["Campaigns"],
      summary: "A campaign with its links, tasks, assets and what happened",
      parameters: id("campaign"),
      responses: { "200": ok(ref("CampaignDetail")), "404": problem },
    }),
    patch: op("editor", {
      operationId: "updateCampaign",
      tags: ["Campaigns"],
      summary: "Change a campaign",
      description:
        "A change to its name, dates, brief, message, audience, budget, channels or goals while it is planned sets every approval back to waiting. utm_campaign changes only while it is planned and has no links. An ended or cancelled campaign changes only its brief, message, owner, goals, adNames and messagesIds.",
      parameters: id("campaign"),
      requestBody: json(ref("CampaignInput")),
      responses: { "200": ok(ref("CampaignDetail")), "400": problem, "404": problem, "409": problem, "422": problem },
    }),
    delete: op("editor", {
      operationId: "deleteCampaign",
      tags: ["Campaigns"],
      summary: "Delete a campaign",
      description: "Editors delete planned and cancelled campaigns; one that has run only an admin deletes. Spend from the ad platforms stays, unclaimed.",
      parameters: id("campaign"),
      responses: { "204": none("Deleted."), "404": problem },
    }),
  },
  "/api/v1/campaigns/{id}/approval": {
    post: op("viewer", {
      operationId: "decide",
      tags: ["Approvals"],
      summary: "Approve, or ask for changes",
      description: "Only a member the campaign names as an approver, for themselves; any role.",
      parameters: id("campaign"),
      requestBody: json(ref("Decision")),
      responses: { "200": ok(ref("CampaignDetail")), "400": problem, "404": problem, "409": problem, "422": problem },
    }),
  },
  "/api/v1/campaigns/{id}/launch": {
    post: op("editor", {
      operationId: "launch",
      tags: ["Approvals"],
      summary: "Mark live",
      description: "Refused (409) until every approver has approved. With automation.launch in the file, the playbook's webhook is sent campaign_launched.",
      parameters: id("campaign"),
      responses: { "200": ok(ref("Launched")), "404": problem, "409": problem },
    }),
  },
  "/api/v1/campaigns/{id}/end": {
    post: op("editor", {
      operationId: "end",
      tags: ["Approvals"],
      summary: "End a live campaign",
      description: "A live campaign also ends by itself the day after its end day.",
      parameters: id("campaign"),
      responses: { "200": ok(ref("CampaignDetail")), "404": problem, "409": problem },
    }),
  },
  "/api/v1/campaigns/{id}/cancel": {
    post: op("editor", {
      operationId: "cancel",
      tags: ["Approvals"],
      summary: "Cancel a campaign",
      parameters: id("campaign"),
      responses: { "200": ok(ref("CampaignDetail")), "404": problem, "409": problem },
    }),
  },
  "/api/v1/campaigns/{id}/results": {
    get: op("viewer", {
      operationId: "results",
      tags: ["Results"],
      summary: "What a campaign brought and what it cost",
      description:
        "As last read from Analytics, Messages and CRM: visits, goals, sends and won deals by channel, each deal counted for its first and its last campaign, and ROI by each.",
      parameters: id("campaign"),
      responses: { "200": ok(ref("Results")), "404": problem },
    }),
  },
  "/api/v1/campaigns/{id}/links": {
    post: op("editor", {
      operationId: "createLink",
      tags: ["Links"],
      summary: "Make a tagged link",
      parameters: id("campaign"),
      requestBody: json(ref("LinkInput")),
      responses: {
        "201": ok(ref("Link"), "Made."),
        "200": ok(ref("Link"), "The same link was made before."),
        "400": problem,
        "404": problem,
        "409": problem,
        "422": problem,
      },
    }),
  },
  "/api/v1/campaigns/{id}/tasks": {
    post: op("editor", {
      operationId: "createTask",
      tags: ["Work"],
      summary: "Add a task",
      parameters: id("campaign"),
      requestBody: json(ref("TaskInput")),
      responses: { "201": ok(ref("Task"), "Added."), "400": problem, "404": problem, "422": problem },
    }),
  },
  "/api/v1/campaigns/{id}/assets": {
    post: op("editor", {
      operationId: "createAsset",
      tags: ["Work"],
      summary: "Add an asset, by its address",
      parameters: id("campaign"),
      requestBody: json(ref("AssetInput")),
      responses: { "201": ok(ref("Asset"), "Added."), "400": problem, "404": problem, "422": problem },
    }),
  },
  "/api/v1/links": {
    get: op("viewer", {
      operationId: "listLinks",
      tags: ["Links"],
      summary: "Tagged links, newest first",
      parameters: [query("campaign", "Only this campaign's.")],
      responses: { "200": ok(ref("LinkList")) },
    }),
  },
  "/api/v1/links/{id}": {
    delete: op("editor", {
      operationId: "deleteLink",
      tags: ["Links"],
      summary: "Delete a link",
      parameters: id("link"),
      responses: { "204": none("Deleted."), "404": problem },
    }),
  },
  "/api/v1/links/{id}/qr": {
    get: op("viewer", {
      operationId: "linkQr",
      tags: ["Links"],
      summary: "A link's QR code",
      parameters: [...id("link"), query("format", "svg (default) or png, 1024 pixels.")],
      responses: {
        "200": { description: "The QR code.", content: { "image/svg+xml": { schema: str }, "image/png": { schema: { type: "string", format: "binary" } } } },
        "404": problem,
        "422": problem,
      },
    }),
  },
  "/api/v1/tasks": {
    get: op("viewer", {
      operationId: "listTasks",
      tags: ["Work"],
      summary: "Tasks of every campaign",
      parameters: [query("owner", "me, none or a member's id."), query("open", "false for done tasks too.")],
      responses: { "200": ok(ref("TaskList")) },
    }),
  },
  "/api/v1/tasks/{id}": {
    patch: op("editor", {
      operationId: "updateTask",
      tags: ["Work"],
      summary: "Change or tick off a task",
      parameters: id("task"),
      requestBody: json(ref("TaskInput")),
      responses: { "200": ok(ref("Task")), "400": problem, "404": problem, "422": problem },
    }),
    delete: op("editor", {
      operationId: "deleteTask",
      tags: ["Work"],
      summary: "Delete a task",
      parameters: id("task"),
      responses: { "204": none("Deleted."), "404": problem },
    }),
  },
  "/api/v1/assets/{id}": {
    delete: op("editor", {
      operationId: "deleteAsset",
      tags: ["Work"],
      summary: "Delete an asset",
      parameters: id("asset"),
      responses: { "204": none("Deleted."), "404": problem },
    }),
  },

  "/api/v1/spend": {
    get: op("viewer", {
      operationId: "listSpend",
      tags: ["Spend"],
      summary: "Spend",
      parameters: [
        query("campaign", "A campaign's id."),
        ...period.map((p) => ({ ...p, description: p.name === "from" ? "The first day." : "The last day." })),
        query("unmatched", "true for spend no campaign claims."),
      ],
      responses: { "200": ok(ref("SpendList")), "422": problem },
    }),
    post: op("editor", {
      operationId: "addSpend",
      tags: ["Spend"],
      summary: "Enter spend by hand",
      requestBody: json(ref("SpendInput")),
      responses: { "201": ok(ref("Spend"), "Entered."), "400": problem, "404": problem, "422": problem },
    }),
  },
  "/api/v1/spend/{id}": {
    delete: op("editor", {
      operationId: "deleteSpend",
      tags: ["Spend"],
      summary: "Delete spend entered or imported",
      description: "Spend read from an ad platform is replaced by the platform's figures at the next read (409).",
      parameters: id("spend"),
      responses: { "204": none("Deleted."), "404": problem, "409": problem },
    }),
  },
  "/api/v1/spend/{id}/assign": {
    post: op("editor", {
      operationId: "assignSpend",
      tags: ["Spend"],
      summary: "Give an ad platform's campaign to a campaign",
      description: "Its name joins the campaign's adNames, so all its days, and those read later, are that campaign's.",
      parameters: id("spend"),
      requestBody: json(ref("SpendAssign")),
      responses: { "200": ok(ref("Spend")), "400": problem, "404": problem, "409": problem, "422": problem },
    }),
  },
  "/api/v1/spend/import": {
    post: op("editor", {
      operationId: "importSpend",
      tags: ["Spend"],
      summary: "Import spend from CSV",
      description:
        "A row a day, campaign (utm_campaign, id or name) and channel. The same campaign, channel and day replaces what a CSV gave before. check: true reads every row and changes nothing.",
      requestBody: json(ref("SpendImport")),
      responses: { "200": ok(ref("SpendImported")), "400": problem, "413": problem, "422": problem },
    }),
  },
  "/api/v1/spend/sync": {
    post: op("editor", {
      operationId: "syncAds",
      tags: ["Spend"],
      summary: "Read the ad platforms now",
      description: "Google Ads and Meta, for the last ads.days days. Each ad campaign's day replaces what was read before; a day no longer reported goes.",
      responses: { "200": ok(ref("AdsRead")) },
    }),
  },

  "/api/v1/report": {
    get: op("viewer", {
      operationId: "report",
      tags: ["Results"],
      summary: "Campaigns of a period, by campaign and channel",
      description: "The campaigns that ran in the period, each with its whole results, and the deals won in the period that no campaign touched.",
      parameters: period,
      responses: { "200": ok(ref("Report")), "422": problem },
    }),
  },
  "/api/v1/attribution": {
    get: op("viewer", {
      operationId: "attribution",
      tags: ["Results"],
      summary: "Won deals and the first and last campaign that touched each",
      parameters: [...period, query("campaign", "Only deals this campaign touched first or last.")],
      responses: { "200": ok(ref("AttributionList")), "422": problem },
    }),
  },
  "/api/v1/sync": {
    post: op("editor", {
      operationId: "sync",
      tags: ["Results"],
      summary: "Read Analytics, Messages, CRM and Audience now",
      responses: { "200": ok(ref("SyncResult")) },
    }),
  },

  "/api/v1/erasures": {
    post: op("admin", {
      operationId: "erase",
      tags: ["Contracts"],
      summary: "Delete a person on request, as Audience asks",
      description: "The won deals kept with one of the emails go. The same reference answers the same again.",
      requestBody: json(ref("ErasureRequest")),
      responses: { "200": ok(ref("ErasureAnswer"), "Deleted."), "400": problem, "422": problem },
    }),
  },

  "/healthz": { get: pub({ operationId: "healthz", tags: ["Product"], summary: "Alive", responses: { "200": ok(ref("Status")) } }) },
  "/readyz": {
    get: pub({ operationId: "readyz", tags: ["Product"], summary: "Ready", responses: { "200": ok(ref("Status")), "503": ok(ref("Status"), "Not ready.") } }),
  },
  "/metrics": {
    get: pub({
      operationId: "metrics",
      tags: ["Product"],
      summary: "Prometheus metrics",
      responses: { "200": { description: "Metrics.", content: { "text/plain": { schema: str } } } },
    }),
  },
};

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const doc = {
  openapi: "3.1.0",
  info: {
    title: "OpenAsy Campaigns",
    version,
    description:
      "Campaigns in one calendar with their budget, goals, approvals, tagged links and spend, and what each brought from Analytics, Messages and CRM. Viewers read everything; editors plan and change campaigns; approvers named on a campaign approve it; admins also delete campaigns that ran.",
    license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
  },
  servers: [{ url: "/" }],
  security: SECURE,
  paths,
  components: {
    securitySchemes: {
      session: { type: "apiKey", in: "cookie", name: "openasy_session" },
      apiToken: { type: "http", scheme: "bearer", description: "An API token made under Settings, API tokens." },
      adminToken: { type: "http", scheme: "bearer", description: "Tests only." },
    },
    responses: { Problem: { description: "A problem (RFC 9457).", content: { "application/problem+json": { schema: ref("Problem") } } } },
    schemas,
  },
};

export const OPENAPI = doc;
const text = JSON.stringify(doc, null, 2) + "\n";
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  writeFileSync(new URL("../openapi.json", import.meta.url), text);
  console.log("openapi.json written");
}
export const OPENAPI_TEXT = text;
