import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createApp, createMetricsHandler } from "./app.ts";
import { watchConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { log } from "./log.ts";
import { createMail } from "./mail.ts";
import { parseProducts } from "./products.ts";
import { createStalwart } from "./stalwart.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.MAIL_DB ?? "/data/mail.db";
const configPath = process.env.MAIL_CONFIG?.trim() || "/config/mail.yaml";
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = process.env.MAIL_HEADLESS === "true";
// Set it to keep /metrics off the port that is published or behind an ingress (ADR 0026).
const metricsPort = process.env.MAIL_METRICS_PORT ? Number(process.env.MAIL_METRICS_PORT) : undefined;

// The address people open Mail at, behind the TLS proxy (ADR 0026). Cookies, passkeys and OIDC redirects use it.
const publicUrl = (process.env.MAIL_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
// The name other mail servers reach this one at: the MX record points here.
const hostname = (process.env.MAIL_HOSTNAME?.trim() || new URL(publicUrl).hostname).toLowerCase();
const stalwartUrl = process.env.MAIL_STALWART_URL?.trim() || "http://stalwart:8080";
const stalwartUser = process.env.MAIL_STALWART_USER?.trim() || "openasy";
const passwordFile = process.env.MAIL_STALWART_PASSWORD_FILE ?? "/run/secrets/stalwart-password";
const stalwartPassword = process.env.MAIL_STALWART_PASSWORD ?? (existsSync(passwordFile) ? readFileSync(passwordFile, "utf8").trim() : "");
if (!stalwartPassword) throw new Error(`The mail server's service account password is missing: mount it at ${passwordFile} or set MAIL_STALWART_PASSWORD.`);

const db = openDb(dbPath);
const secretsKeyFile = process.env.MAIL_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
const auth = createAuth({
  db,
  product: "mail",
  productName: "OpenAsy Mail",
  origin: publicUrl,
  // Locally the same Mail is often opened as 127.0.0.1 too.
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: process.env.MAIL_PASSWORD_SIGN_IN !== "false",
  // Everyone with a mailbox signs in to read their mail; only some of them manage Mail.
  users: true,
  oidc: oidcFromEnv(process.env, "MAIL_"),
  secretsKey: readSecretsKey(secretsKeyFile),
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" ? "warn" : "info", "auth", { event }),
});
const stalwart = createStalwart({ url: stalwartUrl, user: stalwartUser, password: stalwartPassword });
let file: ReturnType<typeof watchConfig> | undefined;
const mail = createMail(db, stalwart, { hostname, fileState: () => file?.state ?? null });
// The domains come from the file and only from it; a file with a mistake keeps the last good one in place.
file = watchConfig(configPath, (domains) => void mail.setDomains(domains), {
  onChange: (state) =>
    state.error
      ? log("warn", "domains file not applied: the last good version stays until it is fixed", { file: state.path, error: state.error })
      : log("info", "domains file applied", { file: state.path, domains: state.domains, mailboxes: state.mailboxes }),
});
const products = parseProducts(process.env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });
const server = createServer(
  createApp({
    db,
    mail,
    version,
    auth,
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
    serveMetrics: metricsPort === undefined,
    products: products.products,
  }),
);
const metricsServer = metricsPort !== undefined ? createServer(createMetricsHandler(mail, version)) : undefined;
metricsServer?.listen(metricsPort, () => log("info", "metrics on their own port", { port: metricsPort }));

server.listen(port, () => log("info", "mail started", { version, port, db: dbPath, config: configPath, hostname, stalwart: stalwartUrl, headless }));
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl)) {
  log("warn", "MAIL_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys. Put Mail behind TLS (ADR 0026)", { url: publicUrl });
}
if (auth.secretsInClear)
  log("warn", "no secrets key: TOTP secrets are stored unencrypted. Mount a 32-byte key (openssl rand -hex 32)", { file: secretsKeyFile });
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });

void mail.checkDns();
const timers: NodeJS.Timeout[] = [
  setInterval(() => auth.purge(), 5 * 60_000),
  // Changes made on the server by hand are put back, and a sync that failed is tried again.
  setInterval(() => void mail.syncNow(), 5 * 60_000),
  setInterval(() => void mail.checkDns(), 6 * 3_600_000),
];

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  for (const t of timers) clearInterval(t);
  file?.stop();
  metricsServer?.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
