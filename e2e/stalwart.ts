// End to end against a running Stalwart (e2e/run.sh starts one): its first start through server/stalwart-setup.ts, then
// Mail's own server with the domains file applied, the webmail sending and receiving as people, mail to an alias, a
// password for a mail app checked over IMAP, and a mailbox taken out of the file, each checked in Stalwart itself.
//
//   SW=http://localhost:18080 SW_RECOVERY=... SW_CONTAINER=mail-e2e-sw node e2e/stalwart.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { connect } from "node:tls";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuth } from "@openasy/auth";
import { createApp } from "../server/app.ts";
import { parseConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import type { Resolver } from "../server/dns.ts";
import { createMail } from "../server/mail.ts";
import { CORE, createStalwart, MANAGEMENT } from "../server/stalwart.ts";
import { setUpStalwart } from "../server/stalwart-setup.ts";

const SW = (process.env.SW ?? "http://localhost:18080").replace(/\/$/, "");
const IMAP_PORT = Number(process.env.SW_IMAP_PORT ?? 11993);
const RECOVERY = `admin:${process.env.SW_RECOVERY ?? ""}`;
const CONTAINER = process.env.SW_CONTAINER ?? "mail-e2e-sw";
const SERVICE_PASSWORD = "e2e-service-password-0123456789";

let failures = 0;
async function step(name: string, work: () => Promise<void>) {
  try {
    await work();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.log(`not ok - ${name}\n  ${(err as Error).stack?.split("\n").slice(0, 5).join("\n  ")}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function eventually<T>(work: () => Promise<T>, tries = 30): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await work();
    } catch (err) {
      if (i >= tries) throw err;
      await sleep(1000);
    }
  }
}

/** Stalwart itself, as its recovery admin, to check what Mail did there. */
async function admin(methodCalls: unknown[]): Promise<any[]> {
  const res = await fetch(`${SW}/jmap/`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(RECOVERY).toString("base64")}`, "content-type": "application/json" },
    body: JSON.stringify({ using: [CORE, MANAGEMENT], methodCalls }),
  });
  return ((await res.json()) as { methodResponses: any[] }).methodResponses;
}

/** Signs in over IMAP (993, TLS, as mail apps do) with a mail app's password; true when Stalwart takes it. */
function imapLogin(user: string, password: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    // Stalwart's own certificate until it has one for its name: not checked here.
    const socket = connect({ host: "127.0.0.1", port: IMAP_PORT, rejectUnauthorized: false });
    let buffer = "";
    let sent = false;
    socket.setTimeout(10_000, () => (socket.destroy(), reject(new Error("IMAP timed out"))));
    socket.on("data", (d) => {
      buffer += d.toString();
      if (!sent && buffer.includes("* OK")) {
        sent = true;
        socket.write(`a1 LOGIN "${user}" "${password}"\r\n`);
      }
      const done = /a1 (OK|NO|BAD)/.exec(buffer);
      if (done) {
        socket.end("a2 LOGOUT\r\n");
        resolve(done[1] === "OK");
      }
    });
    socket.on("error", reject);
  });
}

const DOMAINS = (extra = "") => `
domains:
  - name: example.com
    mailboxes:
      - { address: jane@example.com, name: Jane Doe, quota: 1GB, aliases: [j.doe@example.com] }
      - { address: ali@example.com, name: Ali Yılmaz }
      - { address: former@example.com, disabled: true }
${extra}`;

await step("Stalwart's first start is done through its API, with one restart, and runs again with nothing to do", async () => {
  const o = {
    url: SW,
    recovery: RECOVERY,
    hostname: "mail.example.com",
    domain: "example.com",
    user: "openasy",
    password: SERVICE_PASSWORD,
    requestCertificate: false,
  };
  assert.equal(await setUpStalwart(o), "bootstrapped");
  execFileSync("docker", ["restart", CONTAINER], { stdio: "ignore" });
  assert.equal(await eventually(() => setUpStalwart(o)), "ready");
  assert.equal(await setUpStalwart(o), "ready");
});

const stalwart = createStalwart({ url: SW, user: "openasy", password: SERVICE_PASSWORD });
const noDns: Resolver = { resolveMx: async () => [], resolveTxt: async () => [] };
const db = openDb(":memory:");
const mail = createMail(db, stalwart, { hostname: "mail.example.com", resolver: noDns });

let handler: RequestListener = (_req, res) => res.writeHead(503).end();
const server: Server = createServer((req, res) => handler(req, res));
await new Promise<void>((resolve) => server.listen(0, resolve));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
const auth = createAuth({ db, product: "mail", productName: "OpenAsy Mail", origin: base, users: true });
const JANE = "e2e-jane";
const ALI = "e2e-ali";
const FORMER = "e2e-former";
handler = createApp({
  db,
  mail,
  auth,
  adminToken: "e2e-admin",
  personTokens: { [JANE]: "jane@example.com", [ALI]: "ali@example.com", [FORMER]: "former@example.com" },
  version: "0.0.0",
});
async function as<T = any>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${text.slice(0, 300)}`), { status: res.status });
  return (text ? JSON.parse(text) : undefined) as T;
}
const statusOf = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status?: number }) => e.status ?? 0,
  );
const MAIL_USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"];
const jmap = (token: string, methodCalls: unknown[]) =>
  as<{ methodResponses: any[] }>(token, "/api/v1/webmail/jmap", { method: "POST", body: JSON.stringify({ using: MAIL_USING, methodCalls }) });

await step("the domains file makes the mailboxes in Stalwart, with quota and aliases, and a disabled one that cannot sign in", async () => {
  const r = await mail.setDomains(parseConfig(DOMAINS()));
  assert.equal(r.ok, true, r.error ?? "");
  const [[, got]] = await admin([["x:Account/get", { properties: ["name", "aliases", "quotas", "permissions", "description"] }, "0"]]);
  const by = (n: string) => got.list.find((a: { name: string }) => a.name === n);
  assert.ok(by("jane"), JSON.stringify(got.list.map((a: { name: string }) => a.name)));
  assert.ok(by("ali"));
  assert.ok(JSON.stringify(by("jane").aliases).includes("j.doe"));
  assert.ok(JSON.stringify(by("jane").quotas ?? {}).includes(String(1024 ** 3)), JSON.stringify(by("jane").quotas));
  assert.equal(by("former").permissions["@type"], "Merge");
});

let aliInbox = "";
await step("Jane writes to Ali in the webmail; Ali finds it in his inbox", async () => {
  const s = await as<{ accountId: string; address: string }>(JANE, "/api/v1/webmail/session");
  assert.equal(s.address, "jane@example.com");
  const boxes = (await jmap(JANE, [["Mailbox/get", { accountId: s.accountId }, "0"]])).methodResponses[0][1].list as Array<{ id: string; role: string | null }>;
  const drafts = boxes.find((b) => b.role === "drafts")!;
  const ids = await as<{ accountId: string }>(ALI, "/api/v1/webmail/session");
  const identities = (await jmap(JANE, [["Identity/get", { accountId: s.accountId }, "0"]])).methodResponses[0][1].list as Array<{ id: string }>;
  const r = await jmap(JANE, [
    [
      "Email/set",
      {
        accountId: s.accountId,
        create: {
          m: {
            mailboxIds: { [drafts.id]: true },
            from: [{ name: "Jane Doe", email: "jane@example.com" }],
            to: [{ name: "Ali", email: "ali@example.com" }],
            subject: "Quarterly numbers",
            textBody: [{ partId: "1", type: "text/plain" }],
            bodyValues: { "1": { value: "The numbers are in the Finance space." } },
            keywords: { $draft: true },
          },
        },
      },
      "0",
    ],
    ["EmailSubmission/set", { accountId: s.accountId, create: { s: { emailId: "#m", identityId: identities[0]!.id } } }, "1"],
  ]);
  assert.ok(r.methodResponses[1][1].created?.s, JSON.stringify(r.methodResponses[1]));
  aliInbox = ids.accountId;
  await eventually(async () => {
    const q = await jmap(ALI, [
      ["Email/query", { accountId: ids.accountId, filter: { subject: "Quarterly numbers" } }, "0"],
      ["Email/get", { accountId: ids.accountId, "#ids": { resultOf: "0", name: "Email/query", path: "/ids" }, properties: ["from", "subject"] }, "1"],
    ]);
    const got = q.methodResponses[1][1].list as Array<{ from: Array<{ email: string }> }>;
    assert.equal(got[0]?.from[0]?.email, "jane@example.com", "not delivered yet");
  });
});

await step("mail to Jane's alias reaches Jane", async () => {
  const ali = await as<{ accountId: string }>(ALI, "/api/v1/webmail/session");
  const identities = (await jmap(ALI, [["Identity/get", { accountId: ali.accountId }, "0"]])).methodResponses[0][1].list as Array<{ id: string }>;
  const boxes = (await jmap(ALI, [["Mailbox/get", { accountId: ali.accountId }, "0"]])).methodResponses[0][1].list as Array<{
    id: string;
    role: string | null;
  }>;
  await jmap(ALI, [
    [
      "Email/set",
      {
        accountId: ali.accountId,
        create: {
          m: {
            mailboxIds: { [boxes.find((b) => b.role === "drafts")!.id]: true },
            from: [{ email: "ali@example.com" }],
            to: [{ email: "j.doe@example.com" }],
            subject: "To the alias",
            textBody: [{ partId: "1", type: "text/plain" }],
            bodyValues: { "1": { value: "Hello." } },
          },
        },
      },
      "0",
    ],
    ["EmailSubmission/set", { accountId: ali.accountId, create: { s: { emailId: "#m", identityId: identities[0]!.id } } }, "1"],
  ]);
  const jane = await as<{ accountId: string }>(JANE, "/api/v1/webmail/session");
  await eventually(async () => {
    const q = await jmap(JANE, [["Email/query", { accountId: jane.accountId, filter: { subject: "To the alias" } }, "0"]]);
    assert.equal((q.methodResponses[0][1].ids as string[]).length, 1, "not delivered yet");
  });
});

await step("the webmail cannot reach Stalwart's management, nor another person's mail", async () => {
  assert.equal(await statusOf(jmap(JANE, [["x:Account/get", {}, "0"]])), 403);
  const r = await jmap(JANE, [["Email/query", { accountId: aliInbox, filter: {} }, "0"]]);
  assert.equal(r.methodResponses[0][0], "error", JSON.stringify(r.methodResponses[0]));
});

await step("a password made for a mail app signs in over IMAP, and stops when it is removed", async () => {
  const d = await as<{ id: string; secret: string; username: string }>(JANE, "/api/v1/devices", { method: "POST", body: JSON.stringify({ name: "iPhone" }) });
  assert.equal(d.username, "jane@example.com");
  assert.equal(await eventually(async () => assert.equal(await imapLogin(d.username, d.secret), true)), undefined);
  assert.ok((await as<{ devices: Array<{ id: string }> }>(JANE, "/api/v1/devices")).devices.some((x) => x.id === d.id));
  await fetch(`${base}/api/v1/devices/${d.id}`, { method: "DELETE", headers: { authorization: `Bearer ${JANE}` } });
  await eventually(async () => assert.equal(await imapLogin(d.username, d.secret), false));
});

await step("a disabled mailbox has no webmail", async () => {
  assert.equal(await statusOf(as(FORMER, "/api/v1/webmail/session")), 403);
});

await step("a mailbox taken out of the file is disabled in Stalwart, and its mail stays", async () => {
  const r = await mail.setDomains(parseConfig(DOMAINS().replace("      - { address: ali@example.com, name: Ali Yılmaz }\n", "")));
  assert.equal(r.ok, true, r.error ?? "");
  const [[, got]] = await admin([["x:Account/get", { properties: ["name", "permissions", "usedDiskQuota"] }, "0"]]);
  const ali = got.list.find((a: { name: string }) => a.name === "ali");
  assert.ok(ali, "Ali's account is still there");
  assert.equal(ali.permissions["@type"], "Merge");
  assert.ok(ali.usedDiskQuota > 0, "his mail is kept");
});

server.close();
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
