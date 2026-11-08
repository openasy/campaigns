import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { atLeast, AuthError, identityOrigin, mergeOpenApi, sendProblem, type Auth, type Role } from "@openasy/auth";
import type { Campaigns } from "./campaigns.ts";
import { log } from "./log.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import type { ProductLink } from "./products.ts";
import { CampaignsError, type Actor, type ProblemCode } from "./store.ts";

export interface AppOptions {
  db: DatabaseSync;
  campaigns: Campaigns;
  version: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /** For tests and local scripts: one shared token with the admin role. main.ts never sets it. */
  adminToken?: string;
  /** For tests: tokens that act as a member, so an approver can approve over HTTP. main.ts never sets it. */
  memberTokens?: Record<string, Actor>;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
  /** false when /metrics is served on its own port instead (ADR 0026). */
  serveMetrics?: boolean;
  /** The install's OpenAsy products and their addresses, from OPENASY_PRODUCTS, for the product switcher. */
  products?: ProductLink[];
}

function metricsText(c: Campaigns, version: string) {
  return renderMetrics(version, { ...c.gauges(), fileError: !!c.settings().file?.error });
}

/** Serves only /metrics, for a port that is not exposed with the rest (CAMPAIGNS_METRICS_PORT). */
export function createMetricsHandler(c: Campaigns, version: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/metrics") return problem(res, 404, "not-found");
    send(res, 200, metricsText(c, version), "text/plain; version=0.0.4");
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Identity keeps people's theme and language when they sign in through it; the pages read them there (ADR 0033).
const IDENTITY = identityOrigin(process.env);

/** The pages run nothing from elsewhere. */
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": `default-src 'self'; connect-src 'self'${IDENTITY ? ` ${IDENTITY}` : ""}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'`,
};

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown, headers?: Record<string, string>) =>
  send(res, status, JSON.stringify(data), "application/json", headers);

const TITLES: Record<ProblemCode, string> = {
  "invalid-token": "Invalid token",
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  forbidden: "Forbidden",
  "not-found": "Not found",
  conflict: "Conflict",
  "not-linked": "Not linked",
  "not-available": "Not available",
  "link-failed": "Another service failed",
  "rate-limited": "Too many requests",
  "payload-too-large": "Payload too large",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string, headers: Record<string, string> = {}) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
  send(res, status, JSON.stringify(body), "application/problem+json", headers);
}

async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  // A body too large is read to its end and dropped, so the answer reaches a client still sending and the
  // connection stays usable; past four times the limit the connection is cut.
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 4 * limit) {
      req.destroy();
      break;
    }
    if (size <= limit) chunks.push(chunk);
  }
  if (size > limit) throw new CampaignsError(413, "payload-too-large", `The body must be at most ${Math.round(limit / 1024)} KiB.`);
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const text = await readBody(req, limit);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new CampaignsError(400, "invalid-json", "The body must be JSON.");
  }
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The role a route needs (ADR 0003); "none" for the version, which anyone may call. */
type Access = "none" | Role;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  who: Actor;
  body: () => Promise<unknown>;
}
interface Route {
  method: string;
  path: string;
  auth: Access;
  limit?: number;
  handle: (ctx: Ctx) => unknown;
}

export function createApp({
  db,
  campaigns: c,
  version,
  auth,
  adminToken,
  memberTokens = {},
  webDir,
  docsDir,
  openapi,
  serveMetrics = true,
  products = [],
}: AppOptions) {
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const noContent = (res: ServerResponse) => {
    res.writeHead(204, SECURITY_HEADERS).end();
  };
  const created = (res: ServerResponse, data: unknown) => json(res, 201, data);
  const P = "/api/v1";

  const routes: Route[] = [
    { method: "GET", path: `${P}/version`, auth: "none", handle: () => ({ product: "campaigns", version }) },
    { method: "GET", path: `${P}/products`, auth: "viewer", handle: () => ({ products }) },
    { method: "GET", path: `${P}/summary`, auth: "viewer", handle: ({ who }) => c.summary(who) },
    // The settings, as the file sets them. There is no route that changes them.
    { method: "GET", path: `${P}/settings`, auth: "viewer", handle: () => c.settings() },
    { method: "GET", path: `${P}/team`, auth: "viewer", handle: () => ({ members: c.team().map(({ id, name, email }) => ({ id, name, email })) }) },
    { method: "GET", path: `${P}/integrations`, auth: "viewer", handle: () => c.integrations() },
    { method: "GET", path: `${P}/naming`, auth: "viewer", handle: ({ url }) => c.naming(url.searchParams) },

    { method: "GET", path: `${P}/campaigns`, auth: "viewer", handle: ({ who, url }) => ({ campaigns: c.listCampaigns(who, url.searchParams) }) },
    { method: "POST", path: `${P}/campaigns`, auth: "editor", handle: async ({ res, who, body }) => created(res, c.createCampaign(who, await body())) },
    { method: "GET", path: `${P}/campaigns/:id`, auth: "viewer", handle: ({ who, params }) => c.getCampaign(who, params[0]!) },
    { method: "PATCH", path: `${P}/campaigns/:id`, auth: "editor", handle: async ({ who, params, body }) => c.updateCampaign(who, params[0]!, await body()) },
    { method: "DELETE", path: `${P}/campaigns/:id`, auth: "editor", handle: ({ res, who, params }) => (c.removeCampaign(who, params[0]!), noContent(res)) },
    // Anyone the campaign names as an approver decides for themselves, whatever their role.
    { method: "POST", path: `${P}/campaigns/:id/approval`, auth: "viewer", handle: async ({ who, params, body }) => c.decide(who, params[0]!, await body()) },
    { method: "POST", path: `${P}/campaigns/:id/launch`, auth: "editor", handle: ({ who, params }) => c.launch(who, params[0]!) },
    { method: "POST", path: `${P}/campaigns/:id/end`, auth: "editor", handle: ({ who, params }) => c.end(who, params[0]!) },
    { method: "POST", path: `${P}/campaigns/:id/cancel`, auth: "editor", handle: ({ who, params }) => c.cancel(who, params[0]!) },
    { method: "GET", path: `${P}/campaigns/:id/results`, auth: "viewer", handle: ({ who, params }) => c.results(who, params[0]!) },
    {
      method: "POST",
      path: `${P}/campaigns/:id/links`,
      auth: "editor",
      handle: async ({ res, who, params, body }) => {
        const r = c.createLink(who, params[0]!, await body());
        json(res, r.status, r.link);
      },
    },
    {
      method: "POST",
      path: `${P}/campaigns/:id/tasks`,
      auth: "editor",
      handle: async ({ res, who, params, body }) => created(res, c.createTask(who, params[0]!, await body())),
    },
    {
      method: "POST",
      path: `${P}/campaigns/:id/assets`,
      auth: "editor",
      handle: async ({ res, who, params, body }) => created(res, c.createAsset(who, params[0]!, await body())),
    },

    { method: "GET", path: `${P}/links`, auth: "viewer", handle: ({ url }) => ({ links: c.listLinks(url.searchParams) }) },
    { method: "DELETE", path: `${P}/links/:id`, auth: "editor", handle: ({ res, who, params }) => (c.removeLink(who, params[0]!), noContent(res)) },
    {
      method: "GET",
      path: `${P}/links/:id/qr`,
      auth: "viewer",
      handle: async ({ res, params, url }) => {
        const qr = await c.linkQr(params[0]!, url.searchParams.get("format"));
        send(res, 200, qr.body, qr.type, { "content-disposition": `inline; filename="${qr.name}"`, "cache-control": "private, max-age=3600" });
      },
    },

    { method: "GET", path: `${P}/tasks`, auth: "viewer", handle: ({ who, url }) => ({ tasks: c.listTasks(who, url.searchParams) }) },
    { method: "PATCH", path: `${P}/tasks/:id`, auth: "editor", handle: async ({ who, params, body }) => c.updateTask(who, params[0]!, await body()) },
    { method: "DELETE", path: `${P}/tasks/:id`, auth: "editor", handle: ({ res, who, params }) => (c.removeTask(who, params[0]!), noContent(res)) },
    { method: "DELETE", path: `${P}/assets/:id`, auth: "editor", handle: ({ res, who, params }) => (c.removeAsset(who, params[0]!), noContent(res)) },

    { method: "GET", path: `${P}/spend`, auth: "viewer", handle: ({ url }) => c.listSpend(url.searchParams) },
    { method: "POST", path: `${P}/spend`, auth: "editor", handle: async ({ res, who, body }) => created(res, c.addSpend(who, await body())) },
    { method: "DELETE", path: `${P}/spend/:id`, auth: "editor", handle: ({ res, who, params }) => (c.removeSpend(who, params[0]!), noContent(res)) },
    { method: "POST", path: `${P}/spend/:id/assign`, auth: "editor", handle: async ({ who, params, body }) => c.assignSpend(who, params[0]!, await body()) },
    { method: "POST", path: `${P}/spend/import`, auth: "editor", limit: 8 * 1024 * 1024, handle: async ({ who, body }) => c.importSpend(who, await body()) },
    { method: "POST", path: `${P}/spend/sync`, auth: "editor", handle: () => c.syncAds() },

    { method: "GET", path: `${P}/report`, auth: "viewer", handle: ({ who, url }) => c.report(who, url.searchParams) },
    { method: "GET", path: `${P}/attribution`, auth: "viewer", handle: ({ url }) => c.attribution(url.searchParams) },
    { method: "POST", path: `${P}/sync`, auth: "editor", handle: () => c.sync() },

    // What other products call.
    { method: "POST", path: `${P}/erasures`, auth: "admin", handle: async ({ body }) => c.erase(await body()) },
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[a-z]+/g, "([^/]+)")}$`) }));

  function authorize(req: IncomingMessage, access: Access): Actor {
    if (access === "none") return { id: "anonymous", name: "Anonymous", role: "viewer" };
    if (tokenMatches(req.headers.authorization, adminToken)) return { id: "admin-token", name: "Admin token", role: "admin" };
    for (const [token, who] of Object.entries(memberTokens))
      if (tokenMatches(req.headers.authorization, token)) {
        if (!atLeast(who.role, access)) throw new CampaignsError(403, "forbidden", `This needs the ${access} role.`);
        return who;
      }
    const p = auth.authorize(req, access);
    return p.kind === "session" ? { id: p.user.id, name: p.user.name, role: p.role } : { id: `token:${p.tokenId}`, name: p.name, role: p.role };
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");
    if (path === "/readyz") {
      try {
        db.prepare("SELECT 1").get();
        if (!c.config()) throw new Error("no settings");
        json(res, 200, { status: "ready" });
      } catch {
        json(res, 503, { status: "not ready" });
      }
      return "/readyz";
    }
    if (path === "/metrics") {
      if (serveMetrics) send(res, 200, metricsText(c, version), "text/plain; version=0.0.4");
      else problem(res, 404, "not-found");
      return "/metrics";
    }
    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");
    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      if (!(await serveFile(res, docsDir, path.slice("/api/docs/".length) || "index.html"))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const m = path.match(r.re);
      if (!m || r.method !== req.method) continue;
      try {
        const who = authorize(req, r.auth);
        const params = m.slice(1).map(decodeURIComponent);
        const result = await r.handle({ req, res, url, params, who, body: () => readJson(req, r.limit ?? 1024 * 1024) });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) {
          sendProblem(res, err);
          if (!req.complete) req.resume();
          return r.path;
        }
        if (!(err instanceof CampaignsError)) throw err;
        problem(res, err.status, err.code, err.message, err.retryAfter ? { "retry-after": String(err.retryAfter) } : {});
        if (!req.complete) req.resume();
      }
      return r.path;
    }

    if (path.startsWith("/api/")) return (problem(res, 404, "not-found"), "/api/*");

    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      if (!(await serveFile(res, webDir, path === "/" ? "index.html" : path))) send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      return "/web";
    }

    problem(res, 404, "not-found");
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: req.url?.split("?")[0] });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    // Only the path is logged, never the query.
    if (!["/healthz", "/metrics"].includes(routeName)) {
      log("info", "request", { method: req.method, path: (req.url ?? "/").split("?")[0], status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}
