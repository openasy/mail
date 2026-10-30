import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, GONE, JANE, STRANGER, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "mail-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir });
  base = app.base;
});

afterAll(() => app.close());

/** Calls the API and checks status, content type and body against the description. */
async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);

  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  // A response is either inline or a $ref to components/responses; build the JSON pointer to its schema either way.
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1").replaceAll("{", "%7B").replaceAll("}", "%7D")}/${method.toLowerCase()}/responses/${res.status}`;

  if (!response.content) {
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined };
  }
  const sent = res.headers.get("content-type")!.split(";")[0]!;
  // Attachments are described as */*: whatever type the message gave them, as binary.
  const type = response.content?.[sent] ? sent : "*/*";
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${sent}, which openapi.json does not list`).toBeDefined();
  if (type === "*/*") return { res, body: await res.arrayBuffer() };

  const body = type.endsWith("json") ? await res.json() : await res.text();
  const schema = `${at}/content/${type.replace("/", "~1")}/schema`;
  const validate = ajv.getSchema(schema)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return { res, body };
}

const admin = () => ({ headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
const as = (token: string, init: RequestInit = {}) => ({
  ...init,
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
});
const jmap = (calls: unknown[]) => JSON.stringify({ using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls: calls });

describe("openapi.json", () => {
  it("has the version of this release", () => {
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    // Mail's own operations, then sign-in from @openasy/auth (tested against its description in that package).
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    const res = await fetch(`${base}/api/docs/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/api/docs/../../package.json`)).status).not.toBe(200);
  });
});

describe("responses match openapi.json", () => {
  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    await call("GET", "/api/v1/products", admin());
    await call("GET", "/api/v1/products", {});
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
    await call("GET", "/api/v1/summary", admin());
    await call("GET", "/api/v1/summary", {});
  });

  it("domains and syncs", async () => {
    await call("GET", "/api/v1/domains", admin());
    await call("GET", "/api/v1/domains", {});
    await call("GET", "/api/v1/domains/{name}", admin(), "/api/v1/domains/example.com");
    await call("GET", "/api/v1/domains/{name}", admin(), "/api/v1/domains/nope.com");
    await call("POST", "/api/v1/domains/{name}/dns", admin(), "/api/v1/domains/example.com/dns");
    await call("POST", "/api/v1/domains/{name}/dns", admin(), "/api/v1/domains/nope.com/dns");
    await call("GET", "/api/v1/domains/{name}", admin(), "/api/v1/domains/example.com");
    await call("POST", "/api/v1/sync", admin());
    await call("POST", "/api/v1/sync", as(JANE));
    await call("GET", "/api/v1/sync", admin());
  });

  it("webmail", async () => {
    await call("GET", "/api/v1/webmail/session", as(JANE));
    await call("GET", "/api/v1/webmail/session", as(STRANGER));
    await call("GET", "/api/v1/webmail/session", as(GONE));
    await call("GET", "/api/v1/webmail/session", admin());
    await call("POST", "/api/v1/webmail/jmap", as(JANE, { body: jmap([["Mailbox/get", { accountId: "a" }, "0"]]) }));
    await call("POST", "/api/v1/webmail/jmap", as(JANE, { body: jmap([["x:Account/get", {}, "0"]]) }));
    await call("POST", "/api/v1/webmail/jmap", as(JANE, { body: "{" }));
    await call("POST", "/api/v1/webmail/jmap", as(JANE, { body: "x".repeat(1024 * 1024 + 1) }));
    const { body } = await call("POST", "/api/v1/webmail/upload", as(JANE, { body: "hello", headers: { "content-type": "text/plain" } }));
    await call("GET", "/api/v1/webmail/download/{blob}", as(JANE), `/api/v1/webmail/download/${(body as { blobId: string }).blobId}?name=a.txt`);
    app.fake.state.down = true;
    try {
      await call("POST", "/api/v1/webmail/upload", as(STRANGER, { body: "x" }));
      await call("GET", "/api/v1/webmail/download/{blob}", as(JANE), "/api/v1/webmail/download/b1");
    } finally {
      app.fake.state.down = false;
    }
  });

  it("devices", async () => {
    const { body } = await call("POST", "/api/v1/devices", as(JANE, { body: JSON.stringify({ name: "Phone" }) }));
    await call("POST", "/api/v1/devices", as(JANE, { body: JSON.stringify({ name: "" }) }));
    await call("POST", "/api/v1/devices", as(JANE, { body: "{" }));
    await call("GET", "/api/v1/devices", as(JANE));
    await call("GET", "/api/v1/devices", {});
    await call("DELETE", "/api/v1/devices/{id}", as(JANE), `/api/v1/devices/${(body as { id: string }).id}`);
    await call("DELETE", "/api/v1/devices/{id}", as(JANE), "/api/v1/devices/nope");
    app.fake.state.down = true;
    try {
      await call("GET", "/api/v1/devices", as(JANE));
    } finally {
      app.fake.state.down = false;
    }
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
