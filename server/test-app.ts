// Starts the app on a random port for tests, against a mail server in memory.
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuth } from "@openasy/auth";
import { createApp, type AppOptions } from "./app.ts";
import { parseConfig } from "./config.ts";
import { openDb } from "./db.ts";
import type { Resolver } from "./dns.ts";
import { fakeStalwart, SERVICE_PASSWORD, SERVICE_USER } from "./fake-stalwart.ts";
import { createMail } from "./mail.ts";
import { createStalwart } from "./stalwart.ts";

export const ADMIN_TOKEN = "test-admin-token";
/** Tokens that act as a signed-in person, as personTokens. */
export const JANE = "test-jane-token";
export const GONE = "test-gone-token";
export const STRANGER = "test-stranger-token";

/** The domains file the tests start with. */
export const DOMAINS = `
domains:
  - name: example.com
    dkimSelector: mail
    mailboxes:
      - { address: jane@example.com, name: Jane Doe, quota: 5GB, aliases: [j.doe@example.com, sales@example.org] }
      - { address: gone@example.com, disabled: true }
  - name: example.org
`;

/** Public DNS for example.com, set up the way the product page says it should be. */
export function fakeDns(records: Record<string, string[]> = {}, mx: Record<string, string[]> = { "example.com": ["mail.example.com"] }): Resolver {
  const missing = () => Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  const txt: Record<string, string[]> = {
    "example.com": ["v=spf1 mx -all", "google-site-verification=abc"],
    "mail._domainkey.example.com": ["v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA"],
    "_dmarc.example.com": ["v=DMARC1; p=quarantine"],
    "_mta-sts.example.com": ["v=STSv1; id=1"],
    ...records,
  };
  return {
    resolveMx: async (name) => {
      if (!mx[name]) throw missing();
      return mx[name].map((exchange, i) => ({ exchange, priority: 10 * (i + 1) }));
    },
    resolveTxt: async (name) => {
      if (!txt[name]) throw missing();
      return txt[name].map((t) => [t]);
    },
  };
}

export async function startApp(opts: Partial<AppOptions> & { version: string; domains?: string; resolver?: Resolver }) {
  const db = openDb(":memory:");
  const { domains = DOMAINS, resolver = fakeDns(), ...rest } = opts;
  const fake = fakeStalwart();
  const stalwart = createStalwart({ url: "http://stalwart:8080", user: SERVICE_USER, password: SERVICE_PASSWORD, fetch: fake.fetch });
  const mail = createMail(db, stalwart, { hostname: "mail.example.com", resolver });
  await mail.setDomains(parseConfig(domains));
  // The origin is known once the port is, so the handler is set after listening.
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "mail", productName: "OpenAsy Mail", origin: base, users: true });
  const personTokens = { [JANE]: "jane@example.com", [GONE]: "gone@example.com", [STRANGER]: "stranger@example.net" };
  handler = createApp({ db, mail, auth, adminToken: ADMIN_TOKEN, personTokens, ...rest });
  const as =
    (token: string) =>
    (path: string, init: RequestInit = {}) =>
      fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { db, mail, fake, auth, base, admin: as(ADMIN_TOKEN), jane: as(JANE), as, close };
}
