import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPENAPI_TEXT } from "../scripts/openapi.ts";
import { ADMIN_TOKEN, SELIN_TOKEN, startApp, VELI_TOKEN, type TestApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json, and every operation is called.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "campaigns-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: TestApp;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir });
  base = app.base;
});
afterAll(() => app.close());

async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method, redirect: "manual" });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);
  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1").replaceAll("{", "%7B").replaceAll("}", "%7D")}/${method.toLowerCase()}/responses/${res.status}`;
  if (!response.content) {
    await res.arrayBuffer();
    if (res.status !== 302) expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined as any };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();
  if (type === "application/pdf") return { res, body: Buffer.from(await res.arrayBuffer()) as any };
  const body = type.endsWith("json") ? await res.json() : await res.text();
  const validate = ajv.getSchema(`${at}/content/${type.replace("/", "~1")}/schema`)!;
  expect(validate(body), `${method} ${concrete}: ${JSON.stringify(validate.errors)}`).toBe(true);
  return { res, body: body as any };
}

const admin = (b?: unknown) => ({
  headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
  ...(b !== undefined && { body: typeof b === "string" ? b : JSON.stringify(b) }),
});
const as = (token: string, b?: unknown) => ({
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  ...(b !== undefined && { body: JSON.stringify(b) }),
});
const anon = (b?: unknown) => ({ headers: { "content-type": "application/json" }, ...(b !== undefined && { body: JSON.stringify(b) }) });

describe("openapi.json", () => {
  it("is what scripts/openapi.ts writes, with the version of this release", () => {
    expect(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")).toBe(OPENAPI_TEXT);
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version and the sign-in routes", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    expect((await fetch(`${base}/api/docs/`)).headers.get("content-type")).toContain("text/html");
  });
});

describe("responses match openapi.json", () => {
  const ids: Record<string, string> = {};

  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    for (const p of ["/api/v1/products", "/api/v1/summary", "/api/v1/settings", "/api/v1/team", "/api/v1/integrations"]) {
      await call("GET", p, admin());
      await call("GET", p, {});
    }
    await call("GET", "/api/v1/naming", admin(), "/api/v1/naming?name=Autumn&start=2026-10-01");
    await call("GET", "/api/v1/naming", admin(), "/api/v1/naming");
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("campaigns and approvals", async () => {
    const input = {
      name: "Autumn",
      start: "2026-10-01",
      end: "2026-10-31",
      brief: "Bring trial users back.",
      audience: "Trial users of 2025",
      channels: [{ id: "email", budget: 10000 }, "paid-search"],
      goals: [{ metric: "visits", target: 6000 }],
      approvers: ["selin@example.com"],
    };
    ids.campaign = (await call("POST", "/api/v1/campaigns", admin(input))).body.id;
    await call("POST", "/api/v1/campaigns", admin(input));
    await call("POST", "/api/v1/campaigns", admin({ name: "x" }));
    await call("POST", "/api/v1/campaigns", admin("{"));
    await call("POST", "/api/v1/campaigns", as(VELI_TOKEN, input));
    await call("GET", "/api/v1/campaigns", admin(), "/api/v1/campaigns?from=2026-10-01&to=2026-12-31&channel=email");
    await call("GET", "/api/v1/campaigns", admin(), "/api/v1/campaigns?status=nope");
    await call("GET", "/api/v1/campaigns/{id}", admin(), `/api/v1/campaigns/${ids.campaign}`);
    await call("GET", "/api/v1/campaigns/{id}", admin(), "/api/v1/campaigns/missing");
    await call("PATCH", "/api/v1/campaigns/{id}", admin({ budget: 120000, adNames: ["Brand"] }), `/api/v1/campaigns/${ids.campaign}`);
    await call("PATCH", "/api/v1/campaigns/{id}", admin({ end: "2020-01-01" }), `/api/v1/campaigns/${ids.campaign}`);
    await call("PATCH", "/api/v1/campaigns/{id}", admin({}), "/api/v1/campaigns/missing");
    const other = (await call("POST", "/api/v1/campaigns", admin({ name: "Winter", start: "2026-12-01", end: "2026-12-31", approvers: [] }))).body.id;
    await call("PATCH", "/api/v1/campaigns/{id}", admin({ utm: "autumn-2026" }), `/api/v1/campaigns/${other}`);

    await call("POST", "/api/v1/campaigns/{id}/launch", admin(), `/api/v1/campaigns/${ids.campaign}/launch`);
    await call("POST", "/api/v1/campaigns/{id}/approval", admin({ decision: "approved" }), `/api/v1/campaigns/${ids.campaign}/approval`);
    await call("POST", "/api/v1/campaigns/{id}/approval", as(SELIN_TOKEN, { decision: "maybe" }), `/api/v1/campaigns/${ids.campaign}/approval`);
    await call("POST", "/api/v1/campaigns/{id}/approval", as(SELIN_TOKEN, { decision: "approved" }), "/api/v1/campaigns/missing/approval");
    await call("POST", "/api/v1/campaigns/{id}/approval", as(SELIN_TOKEN, { decision: "approved" }), `/api/v1/campaigns/${ids.campaign}/approval`);
    await call("POST", "/api/v1/campaigns/{id}/launch", admin(), `/api/v1/campaigns/${ids.campaign}/launch`);
    await call("POST", "/api/v1/campaigns/{id}/launch", admin(), "/api/v1/campaigns/missing/launch");
    await call("POST", "/api/v1/campaigns/{id}/approval", as(SELIN_TOKEN, { decision: "approved" }), `/api/v1/campaigns/${ids.campaign}/approval`);
    await call("POST", "/api/v1/campaigns/{id}/cancel", admin(), `/api/v1/campaigns/${other}/cancel`);
    await call("POST", "/api/v1/campaigns/{id}/cancel", admin(), `/api/v1/campaigns/${other}/cancel`);
    await call("POST", "/api/v1/campaigns/{id}/cancel", admin(), "/api/v1/campaigns/missing/cancel");
    await call("POST", "/api/v1/campaigns/{id}/end", admin(), `/api/v1/campaigns/${other}/end`);
    await call("POST", "/api/v1/campaigns/{id}/end", admin(), "/api/v1/campaigns/missing/end");
    ids.other = other;
  });

  it("links, tasks and assets", async () => {
    const c = `/api/v1/campaigns/${ids.campaign}`;
    const link = { destination: "https://www.example.com/autumn", channel: "email", content: "hero" };
    ids.link = (await call("POST", "/api/v1/campaigns/{id}/links", admin(link), `${c}/links`)).body.id;
    await call("POST", "/api/v1/campaigns/{id}/links", admin(link), `${c}/links`);
    await call("POST", "/api/v1/campaigns/{id}/links", admin({ ...link, source: "facebook" }), `${c}/links`);
    await call("POST", "/api/v1/campaigns/{id}/links", admin("{"), `${c}/links`);
    await call("POST", "/api/v1/campaigns/{id}/links", admin(link), "/api/v1/campaigns/missing/links");
    await call("POST", "/api/v1/campaigns/{id}/links", admin(link), `/api/v1/campaigns/${ids.other}/links`);
    await call("GET", "/api/v1/links", admin(), `/api/v1/links?campaign=${ids.campaign}`);
    await call("GET", "/api/v1/links/{id}/qr", admin(), `/api/v1/links/${ids.link}/qr`);
    await call("GET", "/api/v1/links/{id}/qr", admin(), `/api/v1/links/${ids.link}/qr?format=png`);
    await call("GET", "/api/v1/links/{id}/qr", admin(), `/api/v1/links/${ids.link}/qr?format=gif`);
    await call("GET", "/api/v1/links/{id}/qr", admin(), "/api/v1/links/missing/qr");

    ids.task = (
      await call("POST", "/api/v1/campaigns/{id}/tasks", admin({ text: "Write the email", owner: "hakan@example.com", due: "2026-10-03" }), `${c}/tasks`)
    ).body.id;
    await call("POST", "/api/v1/campaigns/{id}/tasks", admin({ text: "" }), `${c}/tasks`);
    await call("POST", "/api/v1/campaigns/{id}/tasks", admin("{"), `${c}/tasks`);
    await call("POST", "/api/v1/campaigns/{id}/tasks", admin({ text: "x" }), "/api/v1/campaigns/missing/tasks");
    await call("GET", "/api/v1/tasks", admin(), "/api/v1/tasks?open=false");
    await call("PATCH", "/api/v1/tasks/{id}", admin({ done: true }), `/api/v1/tasks/${ids.task}`);
    await call("PATCH", "/api/v1/tasks/{id}", admin({ done: "yes" }), `/api/v1/tasks/${ids.task}`);
    await call("PATCH", "/api/v1/tasks/{id}", admin("{"), `/api/v1/tasks/${ids.task}`);
    await call("PATCH", "/api/v1/tasks/{id}", admin({}), "/api/v1/tasks/missing");

    ids.asset = (await call("POST", "/api/v1/campaigns/{id}/assets", admin({ name: "Banner", url: "https://files.example.com/s/1" }), `${c}/assets`)).body.id;
    await call("POST", "/api/v1/campaigns/{id}/assets", admin({ name: "Banner", url: "javascript:alert(1)" }), `${c}/assets`);
    await call("POST", "/api/v1/campaigns/{id}/assets", admin("{"), `${c}/assets`);
    await call("POST", "/api/v1/campaigns/{id}/assets", admin({ name: "x", url: "https://x.example.com" }), "/api/v1/campaigns/missing/assets");
  });

  it("spend", async () => {
    app.fakes.state.google.rows = [{ id: 1, name: "Brand", date: "2026-10-20", costMicros: 5_000_000 }];
    app.fakes.state.meta.rows = [{ id: 2, name: "Lookalike", date: "2026-10-20", spend: "3.50" }];
    await call("POST", "/api/v1/spend/sync", admin());
    const s = await call("GET", "/api/v1/spend", admin(), "/api/v1/spend?unmatched=true");
    const lookalike = s.body.spend.find((x: { adCampaign: string }) => x.adCampaign === "Lookalike").id;
    await call("GET", "/api/v1/spend", admin(), `/api/v1/spend?campaign=${ids.campaign}&from=2026-10-01&to=2026-10-31`);
    await call("GET", "/api/v1/spend", admin(), "/api/v1/spend?from=x");
    await call("POST", "/api/v1/spend/{id}/assign", admin({ campaign: ids.campaign }), `/api/v1/spend/${lookalike}/assign`);
    await call("POST", "/api/v1/spend/{id}/assign", admin({ campaign: "missing" }), `/api/v1/spend/${lookalike}/assign`);
    await call("POST", "/api/v1/spend/{id}/assign", admin({}), `/api/v1/spend/${lookalike}/assign`);
    await call("POST", "/api/v1/spend/{id}/assign", admin("{"), `/api/v1/spend/${lookalike}/assign`);
    await call("POST", "/api/v1/spend/{id}/assign", admin({ campaign: ids.campaign }), "/api/v1/spend/missing/assign");
    await call("DELETE", "/api/v1/spend/{id}", admin(), `/api/v1/spend/${lookalike}`);

    const manual = (await call("POST", "/api/v1/spend", admin({ campaign: ids.campaign, channel: "email", day: "2026-10-02", amount: 5000 }))).body.id;
    await call("POST", "/api/v1/spend", admin({ campaign: ids.campaign, channel: "email", day: "x", amount: 5 }));
    await call("POST", "/api/v1/spend", admin({ campaign: "missing", channel: "email", day: "2026-10-02", amount: 5 }));
    await call("POST", "/api/v1/spend", admin("{"));
    const assigned = (await call("POST", "/api/v1/spend/{id}/assign", admin({ campaign: ids.campaign }), `/api/v1/spend/${manual}/assign`)).res.status;
    expect(assigned).toBe(409);
    await call("DELETE", "/api/v1/spend/{id}", admin(), `/api/v1/spend/${manual}`);
    await call("DELETE", "/api/v1/spend/{id}", admin(), `/api/v1/spend/${manual}`);

    await call("POST", "/api/v1/spend/import", admin({ csv: "day;campaign;channel;amount\n05.10.2026;autumn-2026;email;1.250,50\nx;y;z;1" }));
    await call("POST", "/api/v1/spend/import", admin({ csv: "nothing" }));
    await call("POST", "/api/v1/spend/import", admin("{"));
    await call("POST", "/api/v1/spend/import", admin({ csv: "a".repeat(9 * 1024 * 1024) }));
  });

  it("results", async () => {
    app.fakes.state.analytics.visits = [{ daysAgo: 3, utm: { campaign: "autumn-2026", medium: "email", source: "newsletter" }, goals: ["Signup"] }];
    app.fakes.state.crm.deals = [
      {
        id: "d1",
        name: "Deal",
        status: "won",
        value: 1000,
        currency: "TRY",
        closedAt: "2026-10-20T10:00:00Z",
        createdAt: "2026-10-01T10:00:00Z",
        company: { id: "co", name: "Co" },
        contact: null,
        source: "live-chat",
        sourceDetail: "autumn-2026",
      },
    ];
    await call("POST", "/api/v1/sync", admin());
    const links = await call("GET", "/api/v1/links", admin());
    expect(links.body.links[0]).toMatchObject({ campaignName: "Autumn", source: "newsletter", visits: 1 });
    await call("GET", "/api/v1/campaigns/{id}/results", admin(), `/api/v1/campaigns/${ids.campaign}/results`);
    await call("GET", "/api/v1/campaigns/{id}/results", admin(), "/api/v1/campaigns/missing/results");
    await call("GET", "/api/v1/report", admin(), "/api/v1/report?from=2026-09-01&to=2026-11-30");
    await call("GET", "/api/v1/report", admin(), "/api/v1/report?from=2026-12-01&to=2026-11-30");
    await call("GET", "/api/v1/attribution", admin(), `/api/v1/attribution?from=2026-09-01&campaign=${ids.campaign}`);
    await call("GET", "/api/v1/attribution", admin(), "/api/v1/attribution?to=nope");
    app.fakes.state.crm.status = 500;
    await call("POST", "/api/v1/sync", admin());
  });

  it("what other products call", async () => {
    await call("POST", "/api/v1/erasures", admin({ reference: "KVKK-1", product: "audience", people: { emails: ["x@example.com"], phones: [], userIds: [] } }));
    await call("POST", "/api/v1/erasures", admin({ reference: "KVKK-2", product: "audience" }));
    await call("POST", "/api/v1/erasures", admin("{"));
    await call("POST", "/api/v1/erasures", anon({}));
  });

  it("deleting", async () => {
    await call("DELETE", "/api/v1/links/{id}", admin(), `/api/v1/links/${ids.link}`);
    await call("DELETE", "/api/v1/links/{id}", admin(), `/api/v1/links/${ids.link}`);
    await call("DELETE", "/api/v1/tasks/{id}", admin(), `/api/v1/tasks/${ids.task}`);
    await call("DELETE", "/api/v1/tasks/{id}", admin(), `/api/v1/tasks/${ids.task}`);
    await call("DELETE", "/api/v1/assets/{id}", admin(), `/api/v1/assets/${ids.asset}`);
    await call("DELETE", "/api/v1/assets/{id}", admin(), `/api/v1/assets/${ids.asset}`);
    await call("DELETE", "/api/v1/campaigns/{id}", admin(), `/api/v1/campaigns/${ids.other}`);
    await call("DELETE", "/api/v1/campaigns/{id}", admin(), `/api/v1/campaigns/${ids.other}`);
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
