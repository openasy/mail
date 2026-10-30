import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { Readable } from "node:stream";
import type { DatabaseSync } from "node:sqlite";
import { AuthError, identityOrigin, mergeOpenApi, sendProblem, type Auth, type Role } from "@openasy/auth";
import { log } from "./log.ts";
import { MailError, type Mail, type ProblemCode } from "./mail.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import type { ProductLink } from "./products.ts";

export interface AppOptions {
  db: DatabaseSync;
  mail: Mail;
  version: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /** For tests and local scripts: one shared token with the admin role. main.ts never sets it. */
  adminToken?: string;
  /** For tests and local scripts: tokens that act as a signed-in person, by token, with their address. main.ts never sets it. */
  personTokens?: Record<string, string>;
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

function metricsText(mail: Mail, version: string) {
  return renderMetrics(version, { ...mail.gauges(), fileError: !!mail.summary().file?.error });
}

/** Serves only /metrics, for a port that is not exposed with the rest (MAIL_METRICS_PORT). */
export function createMetricsHandler(mail: Mail, version: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/metrics") return problem(res, 404, "not-found");
    send(res, 200, metricsText(mail, version), "text/plain; version=0.0.4");
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

// Mail is shown in a sandboxed frame without scripts, and only images inside the message load: remote images, which
// tell the sender when and where a message was read, are never fetched.
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": `default-src 'self'; connect-src 'self'${IDENTITY ? ` ${IDENTITY}` : ""}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-src 'self'`,
};

/** Largest JMAP request from the webmail; a message being written goes up as a blob first. */
const JMAP_LIMIT = 1024 * 1024;
/** Largest attachment the webmail uploads. */
const UPLOAD_LIMIT = 25 * 1024 * 1024;

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown) => send(res, status, JSON.stringify(data), "application/json");

const TITLES: Record<ProblemCode, string> = {
  "invalid-token": "Invalid token",
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  "not-found": "Not found",
  "no-mailbox": "No mailbox",
  "method-not-allowed": "Method not allowed",
  "mail-server-unavailable": "Mail server unavailable",
  "payload-too-large": "Payload too large",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
  send(res, status, JSON.stringify(body), "application/problem+json");
}

/** Serves a file from dir, or returns false when the path is outside it or missing. */
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

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new MailError(413, "payload-too-large", `The body must be at most ${Math.round(limit / 1024 / 1024)} MiB.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const raw = await readBody(req, limit);
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new MailError(400, "invalid-json", "The body must be JSON.");
  }
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The role a route needs (ADR 0003). "none" for the version; "self" for a person's own mail and devices, which need a
 * signed-in person (not an API token) and act only on that person's mailbox.
 */
type Access = "none" | "self" | Role;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  /** The signed-in person's address, for "self" routes. */
  address: string;
}
interface Route {
  method: string;
  /** Path pattern; each `:name` matches one segment. */
  path: string;
  auth: Access;
  handle: (ctx: Ctx) => unknown;
}

export function createApp({
  db,
  mail,
  version,
  auth,
  adminToken,
  personTokens = {},
  webDir,
  docsDir,
  openapi,
  serveMetrics = true,
  products = [],
}: AppOptions) {
  // The served description includes /api/v1/auth from @openasy/auth, so the API reference documents sign-in too.
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const noContent = (res: ServerResponse) => {
    res.writeHead(204, SECURITY_HEADERS).end();
  };

  const routes: Route[] = [
    { method: "GET", path: "/api/v1/version", auth: "none", handle: () => ({ product: "mail", version }) },
    { method: "GET", path: "/api/v1/products", auth: "user", handle: () => ({ products }) },
    { method: "GET", path: "/api/v1/summary", auth: "viewer", handle: () => mail.summary() },

    // The domains and mailboxes, as the file sets them. There is no route that adds, changes or removes one.
    { method: "GET", path: "/api/v1/domains", auth: "viewer", handle: () => ({ domains: mail.domainList(), file: mail.summary().file }) },
    { method: "GET", path: "/api/v1/domains/:name", auth: "viewer", handle: ({ params }) => mail.domain(params[0]!) },
    { method: "POST", path: "/api/v1/domains/:name/dns", auth: "editor", handle: async ({ params }) => (await mail.checkDns(params[0]!))[0] },

    // Bringing the mail server in step with the file, which also happens after every change and every five minutes.
    {
      method: "GET",
      path: "/api/v1/sync",
      auth: "viewer",
      handle: () => ({
        last: mail.lastSync(),
        runs: db
          .prepare("SELECT at, ok, domains, created, updated, disabled, error FROM sync_runs ORDER BY id DESC LIMIT 20")
          .all()
          .map((r) => ({ ...r, ok: r.ok === 1 })),
      }),
    },
    { method: "POST", path: "/api/v1/sync", auth: "admin", handle: () => mail.syncNow() },

    // A person's own mail, as the mail server keeps it.
    { method: "GET", path: "/api/v1/webmail/session", auth: "self", handle: ({ address }) => mail.session(address) },
    { method: "POST", path: "/api/v1/webmail/jmap", auth: "self", handle: async ({ req, address }) => mail.call(address, await readJson(req, JMAP_LIMIT)) },
    {
      method: "POST",
      path: "/api/v1/webmail/upload",
      auth: "self",
      handle: async ({ req, address }) => {
        const type = req.headers["content-type"] ?? "application/octet-stream";
        return mail.upload(address, type, await readBody(req, UPLOAD_LIMIT));
      },
    },
    {
      method: "GET",
      path: "/api/v1/webmail/download/:blob",
      auth: "self",
      handle: async ({ res, url, params, address }) => {
        const name = (url.searchParams.get("name") || "attachment").slice(0, 200);
        const type = url.searchParams.get("type") || "application/octet-stream";
        const r = await mail.download(address, params[0]!, name, type);
        // Always a download, never a page of this origin, whatever the attachment claims to be.
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          "content-security-policy": "sandbox",
          "content-type": r.headers.get("content-type") ?? "application/octet-stream",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          ...(r.headers.get("content-length") && { "content-length": r.headers.get("content-length")! }),
        });
        if (r.body) Readable.fromWeb(r.body as import("node:stream/web").ReadableStream).pipe(res);
        else res.end();
      },
    },

    // Passwords for a person's own mail apps.
    { method: "GET", path: "/api/v1/devices", auth: "self", handle: async ({ address }) => ({ devices: await mail.devices(address) }) },
    {
      method: "POST",
      path: "/api/v1/devices",
      auth: "self",
      handle: async ({ req, res, address }) => {
        const body = (await readJson(req)) as { name?: unknown } | null;
        json(res, 201, await mail.addDevice(address, body?.name));
      },
    },
    {
      method: "DELETE",
      path: "/api/v1/devices/:id",
      auth: "self",
      handle: async ({ res, params, address }) => (await mail.removeDevice(address, params[0]!), noContent(res)),
    },
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[a-z]+/g, "([^/]+)")}$`) }));

  function authorize(req: IncomingMessage, access: Access): string {
    if (access === "none") return "";
    if (access !== "self" && tokenMatches(req.headers.authorization, adminToken)) return "";
    if (access === "self") for (const [token, address] of Object.entries(personTokens)) if (tokenMatches(req.headers.authorization, token)) return address;
    const p = auth.authorize(req, access === "self" ? "user" : access);
    if (access !== "self") return "";
    if (p.kind !== "session") throw new AuthError(403, "forbidden", "Only a signed-in person can read their mail, not an API token.");
    return p.user.email;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");

    if (path === "/readyz") {
      // Ready while the database answers; the mail server being away shows in the summary, not here, so the sign-in
      // and the admin pages stay up to say so.
      try {
        db.prepare("SELECT 1").get();
        json(res, 200, { status: "ready" });
      } catch {
        json(res, 503, { status: "database unavailable" });
      }
      return "/readyz";
    }

    if (path === "/metrics") {
      if (serveMetrics) send(res, 200, metricsText(mail, version), "text/plain; version=0.0.4");
      else problem(res, 404, "not-found");
      return "/metrics";
    }

    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");

    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      const relative = path.slice("/api/docs/".length) || "index.html";
      if (!(await serveFile(res, docsDir, relative))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const m = path.match(r.re);
      if (!m || r.method !== req.method) continue;
      try {
        const address = authorize(req, r.auth);
        const params = m.slice(1).map(decodeURIComponent);
        const result = await r.handle({ req, res, url, params, address });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) {
          sendProblem(res, err);
          if (!req.complete) req.resume();
          return r.path;
        }
        if (!(err instanceof MailError)) throw err;
        problem(res, err.status, err.code, err.message);
        // Unread request bodies would otherwise hold the connection.
        if (!req.complete) req.resume();
      }
      return r.path;
    }

    if (path.startsWith("/api/")) return (problem(res, 404, "not-found"), "/api/*");

    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      // Unknown paths fall back to the single-page app.
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
      log("error", "request failed", { error: String(err), path: req.url });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    if (routeName !== "/healthz" && routeName !== "/metrics") {
      log("info", "request", { method: req.method, path: (req.url ?? "/").split("?")[0], status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}
