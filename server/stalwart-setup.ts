// Stalwart's first start, done through its API instead of its admin pages: its host name and first domain, then, after
// one restart, the service account Mail uses. Safe to run again: it does only what is not done yet.
//
//   docker compose exec -e STALWART_RECOVERY_ADMIN=admin:<password> mail node server/stalwart-setup.ts
//
// STALWART_RECOVERY_ADMIN is the same admin:<password> Stalwart is started with. It prints what it did, and exits 2
// when Stalwart must be restarted (docker compose restart stalwart) before it is run again.
import { existsSync, readFileSync } from "node:fs";
import { CORE, MANAGEMENT } from "./stalwart.ts";

export interface StalwartSetup {
  /** Where Mail reaches Stalwart's HTTP listener. */
  url: string;
  /** user:password of Stalwart's recovery admin (STALWART_RECOVERY_ADMIN). */
  recovery: string;
  /** The name other mail servers reach Stalwart at. */
  hostname: string;
  /** The first domain, made with the bootstrap; the others come from the domains file. */
  domain: string;
  /** The account Mail manages and impersonates with, and its password. */
  user: string;
  password: string;
  /** Whether Stalwart asks Let's Encrypt for its certificate at once; off for names the internet cannot reach. */
  requestCertificate?: boolean;
}

export type SetupStep = "bootstrapped" | "ready";

async function jmap(url: string, credentials: string, methodCalls: unknown[]): Promise<Array<[string, Record<string, any>, string]>> {
  const res = await fetch(`${url.replace(/\/$/, "")}/jmap/`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(credentials).toString("base64")}`, "content-type": "application/json" },
    body: JSON.stringify({ using: [CORE, MANAGEMENT], methodCalls }),
    // A Stalwart that is restarting may take the connection and never answer.
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401) throw new Error("Stalwart refused STALWART_RECOVERY_ADMIN: give the same admin:<password> it was started with.");
  if (!res.ok) throw new Error(`Stalwart answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return ((await res.json()) as { methodResponses: Array<[string, Record<string, any>, string]> }).methodResponses;
}

function check(r: [string, Record<string, any>, string] | undefined) {
  if (!r) throw new Error("Stalwart sent no answer.");
  if (r[0] === "error") throw new Error(`Stalwart: ${r[1].description ?? r[1].type}`);
  const failed = ["notCreated", "notUpdated"].flatMap((k) => Object.values((r[1][k] as Record<string, { description?: string }> | null) ?? {}));
  if (failed.length) throw new Error(`Stalwart: ${failed.map((e) => e.description ?? "refused").join("; ")}`);
  return r[1];
}

/** One step of the first start: "bootstrapped" means Stalwart must be restarted, then this run again. */
export async function setUpStalwart(o: StalwartSetup): Promise<SetupStep> {
  const [probe] = await jmap(o.url, o.recovery, [["x:Domain/get", { properties: ["name"] }, "0"]]);
  if (probe?.[0] === "error" && /bootstrap/i.test(String(probe[1].description))) {
    check(
      (
        await jmap(o.url, o.recovery, [
          [
            "x:Bootstrap/set",
            { update: { singleton: { serverHostname: o.hostname, defaultDomain: o.domain, requestTlsCertificate: o.requestCertificate ?? true } } },
            "0",
          ],
        ])
      )[0],
    );
    return "bootstrapped";
  }
  const domains = check(probe).list as Array<{ id: string; name: string }>;
  let domainId = domains.find((d) => d.name === o.domain)?.id;
  if (!domainId) {
    const made = check((await jmap(o.url, o.recovery, [["x:Domain/set", { create: { d: { name: o.domain } } }, "0"]]))[0]);
    domainId = (made.created as Record<string, { id: string }>).d!.id;
  }
  const accounts = check((await jmap(o.url, o.recovery, [["x:Account/get", { properties: ["name", "domainId"] }, "0"]]))[0]).list as Array<{
    id: string;
    name: string;
    domainId: string;
  }>;
  const name = o.user.split("@")[0]!;
  const credentials = { "0": { "@type": "Password", secret: o.password } };
  const existing = accounts.find((a) => a.name === name && a.domainId === domainId);
  // The administrator role holds the impersonate permission, which the webmail needs to act as each person.
  const account = { roles: { "@type": "Admin" }, credentials, description: "OpenAsy Mail" };
  check(
    (
      await jmap(o.url, o.recovery, [
        [
          "x:Account/set",
          existing
            ? { update: { [existing.id]: account } }
            : { create: { s: { "@type": "User", name, domainId, encryptionAtRest: { "@type": "Disabled" }, ...account } } },
          "0",
        ],
      ])
    )[0],
  );
  return "ready";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env;
  const passwordFile = env.MAIL_STALWART_PASSWORD_FILE ?? "/run/secrets/stalwart-password";
  const password = env.MAIL_STALWART_PASSWORD ?? (existsSync(passwordFile) ? readFileSync(passwordFile, "utf8").trim() : "");
  const configPath = env.MAIL_CONFIG?.trim() || "/config/mail.yaml";
  const fromFile = existsSync(configPath) ? /^\s*-\s*name:\s*([a-z0-9.-]+)/m.exec(readFileSync(configPath, "utf8"))?.[1] : undefined;
  const publicUrl = env.MAIL_PUBLIC_URL ?? "http://localhost:8080";
  const hostname = (env.MAIL_HOSTNAME?.trim() || new URL(publicUrl).hostname).toLowerCase();
  const recovery = env.STALWART_RECOVERY_ADMIN ?? "";
  if (!recovery.includes(":")) throw new Error("Set STALWART_RECOVERY_ADMIN to the admin:<password> Stalwart is started with.");
  if (!password) throw new Error(`The service account's password is missing: mount it at ${passwordFile} or set MAIL_STALWART_PASSWORD.`);
  const step = await setUpStalwart({
    url: env.MAIL_STALWART_URL?.trim() || "http://stalwart:8080",
    recovery,
    hostname,
    domain: env.MAIL_DOMAIN?.trim() || fromFile || hostname.split(".").slice(1).join("."),
    user: env.MAIL_STALWART_USER?.trim() || "openasy",
    password,
    requestCertificate: env.STALWART_REQUEST_CERTIFICATE !== "false",
  });
  if (step === "bootstrapped") {
    console.log(`Stalwart is set up as ${hostname}. Restart it (docker compose restart stalwart), then run this again.`);
    process.exit(2);
  }
  console.log("Stalwart is ready: Mail's service account is there with the administrator role.");
}
