// What the routes call: the domains from the file, keeping the mail server in step with it, the DNS checks, and a
// person's own mail and device passwords. The mail itself stays on the mail server; Mail keeps none of it.
import type { DatabaseSync } from "node:sqlite";
import { mailboxOf, type ConfigFileState, type Domain } from "./config.ts";
import { checkDomain, type DomainCheck, type Resolver } from "./dns.ts";
import { log } from "./log.ts";
import { CORE, StalwartError, type AppPassword, type JmapRequest, type JmapResponse, type JmapSession, type Stalwart } from "./stalwart.ts";
import { accountId, sync, type SyncResult } from "./sync.ts";

export type ProblemCode =
  | "invalid-token"
  | "invalid-json"
  | "invalid-body"
  | "not-found"
  | "no-mailbox"
  | "method-not-allowed"
  | "mail-server-unavailable"
  | "payload-too-large"
  | "internal-error";

export class MailError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  constructor(status: number, code: ProblemCode, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

const MAIL = "urn:ietf:params:jmap:mail";
const SUBMISSION = "urn:ietf:params:jmap:submission";
const VACATION = "urn:ietf:params:jmap:vacationresponse";
const QUOTA = "urn:ietf:params:jmap:quota";
/** What the webmail may use. Stalwart's own management methods (x:*) are never passed on. */
export const CAPABILITIES = [CORE, MAIL, SUBMISSION, VACATION, QUOTA];
export const METHODS = new Set([
  "Core/echo",
  "Mailbox/get",
  "Mailbox/changes",
  "Mailbox/query",
  "Mailbox/queryChanges",
  "Mailbox/set",
  "Thread/get",
  "Thread/changes",
  "Email/get",
  "Email/changes",
  "Email/query",
  "Email/queryChanges",
  "Email/set",
  "SearchSnippet/get",
  "Identity/get",
  "Identity/changes",
  "Identity/set",
  "EmailSubmission/get",
  "EmailSubmission/changes",
  "EmailSubmission/query",
  "EmailSubmission/set",
  "VacationResponse/get",
  "VacationResponse/set",
  "Quota/get",
]);

/** A person's session as the webmail sees it: their account and limits, with every URL pointing back at Mail. */
export interface WebmailSession {
  address: string;
  /** The server mail apps connect to, over IMAP (993) and SMTP (465 or 587). */
  hostname: string;
  name: string | null;
  accountId: string;
  capabilities: Record<string, unknown>;
  state: string;
}

export interface MailOptions {
  /** The name the mail server is reached at, for the MX record (MAIL_HOSTNAME). */
  hostname: string;
  resolver?: Resolver;
  clock?: () => number;
  fileState?: () => ConfigFileState | null;
}

/** The path of a URL Stalwart gave, so Mail calls it at the address Mail reaches the server at, not its public name. */
const pathOf = (url: string) => url.replace(/^https?:\/\/[^/]+/i, "");

export function createMail(db: DatabaseSync, stalwart: Stalwart, { hostname, resolver, clock = Date.now, fileState = () => null }: MailOptions) {
  let domains: Domain[] = [];
  let last: SyncResult | null = null;
  let running: Promise<SyncResult> | null = null;
  let again = false;
  const checks = new Map<string, DomainCheck>();
  const sessions = new Map<string, { session: JmapSession; until: number }>();

  const insert = db.prepare("INSERT INTO sync_runs (at, ok, domains, created, updated, disabled, error) VALUES (?, ?, ?, ?, ?, ?, ?)");

  /** Brings the server in step with the file; a call while one runs makes it run once more after. */
  function syncNow(): Promise<SyncResult> {
    if (running) {
      again = true;
      return running;
    }
    running = sync(stalwart, domains, () => new Date(clock()))
      .then((r) => {
        last = r;
        insert.run(r.at, r.ok ? 1 : 0, r.domains, r.created.length, r.updated.length, r.disabled.length, r.error);
        db.prepare("DELETE FROM sync_runs WHERE id NOT IN (SELECT id FROM sync_runs ORDER BY id DESC LIMIT 100)").run();
        if (r.ok && (r.domains || r.created.length || r.updated.length || r.disabled.length))
          log("info", "mail server updated from the file", { domains: r.domains, created: r.created, updated: r.updated, disabled: r.disabled });
        else if (!r.ok) log("warn", "mail server not updated; trying again in five minutes", { error: r.error });
        return r;
      })
      .finally(() => {
        running = null;
        if (again) ((again = false), void syncNow());
      });
    return running;
  }

  /** The mailbox of a signed-in person: their address must be a mailbox of the file that is not disabled. */
  function own(addr: string) {
    const m = mailboxOf(domains, addr);
    if (!m) throw new MailError(403, "no-mailbox", `${addr} has no mailbox in the domains file; an admin adds it there.`);
    if (m.disabled) throw new MailError(403, "no-mailbox", `The mailbox ${m.address} is disabled.`);
    return m;
  }

  /** Stalwart's failures as a problem the webmail can show; other errors go up as they are. */
  async function server<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof StalwartError) {
        log("warn", "mail server call failed", { error: err.message, status: err.status });
        throw new MailError(502, "mail-server-unavailable", "The mail server did not answer; try again in a moment.");
      }
      throw err;
    }
  }

  async function sessionOf(addr: string): Promise<JmapSession> {
    const hit = sessions.get(addr);
    if (hit && hit.until > clock()) return hit.session;
    const session = await server(() => stalwart.session(addr));
    sessions.set(addr, { session, until: clock() + 5 * 60_000 });
    return session;
  }

  const total = () => domains.reduce((n, d) => n + d.mailboxes.length, 0);

  return {
    /** Takes the file's domains and starts bringing the server in step; the promise is that sync. */
    setDomains(next: Domain[]): Promise<SyncResult> {
      domains = next;
      for (const name of checks.keys()) if (!next.some((d) => d.name === name)) checks.delete(name);
      sessions.clear();
      return syncNow();
    },
    domains: () => domains,
    syncNow,
    lastSync: () => last,

    summary() {
      return {
        domains: domains.length,
        mailboxes: total(),
        disabled: domains.reduce((n, d) => n + d.mailboxes.filter((m) => m.disabled).length, 0),
        file: fileState(),
        sync: last,
        hostname,
        dnsProblems: [...checks.values()].reduce((n, c) => n + c.records.filter((r) => r.status !== "ok").length, 0),
      };
    },

    domainList() {
      return domains.map((d) => ({
        name: d.name,
        mailboxes: d.mailboxes.length,
        disabled: d.mailboxes.filter((m) => m.disabled).length,
        dns: checks.get(d.name) ?? null,
      }));
    },

    domain(name: string) {
      const d = domains.find((x) => x.name === name.toLowerCase());
      if (!d) throw new MailError(404, "not-found", `${name} is not a domain of the file.`);
      return { name: d.name, dkimSelector: d.dkimSelector, mailboxes: d.mailboxes, dns: checks.get(d.name) ?? null };
    },

    /** Reads the DNS of one domain, or of all of them; a lookup that fails keeps the previous check. */
    async checkDns(name?: string): Promise<DomainCheck[]> {
      const list = name ? [this.domain(name)] : domains;
      const out: DomainCheck[] = [];
      for (const d of list) {
        try {
          const c = await checkDomain(
            domains.find((x) => x.name === d.name)!,
            hostname,
            resolver,
            () => new Date(clock()),
          );
          checks.set(d.name, c);
          out.push(c);
        } catch (err) {
          log("warn", "DNS check failed", { domain: d.name, error: String(err) });
          const prev = checks.get(d.name);
          if (prev) out.push(prev);
        }
      }
      return out;
    },

    /** The signed-in person's session for the webmail. */
    async session(addr: string): Promise<WebmailSession> {
      const m = own(addr);
      const s = await sessionOf(m.address);
      const accountId = s.primaryAccounts[MAIL];
      if (!accountId) throw new MailError(502, "mail-server-unavailable", "The mail server has no mail account for this person yet; it is being set up.");
      return {
        address: m.address,
        hostname,
        name: m.name,
        accountId,
        capabilities: Object.fromEntries(Object.entries(s.capabilities).filter(([k]) => CAPABILITIES.includes(k))),
        state: s.state,
      };
    },

    /** JMAP calls from the webmail, as the signed-in person, limited to reading and sending their own mail. */
    async call(addr: string, body: unknown): Promise<JmapResponse> {
      const m = own(addr);
      const req = body as JmapRequest;
      if (
        !req ||
        typeof req !== "object" ||
        !Array.isArray(req.using) ||
        !Array.isArray(req.methodCalls) ||
        req.methodCalls.length > 32 ||
        req.methodCalls.some(
          (c) => !Array.isArray(c) || c.length !== 3 || typeof c[0] !== "string" || typeof c[2] !== "string" || !c[1] || typeof c[1] !== "object",
        )
      )
        throw new MailError(400, "invalid-body", "A JMAP request: using, and up to 32 methodCalls of [name, arguments, id].");
      const blocked = req.methodCalls.map((c) => c[0]).filter((n) => !METHODS.has(n));
      if (blocked.length) throw new MailError(403, "method-not-allowed", `Not available to the webmail: ${[...new Set(blocked)].join(", ")}.`);
      const using = req.using.filter((u) => typeof u === "string" && CAPABILITIES.includes(u));
      const s = await sessionOf(m.address);
      return server(() => stalwart.call(m.address, { using, methodCalls: req.methodCalls }, pathOf(s.apiUrl)));
    },

    async upload(addr: string, type: string, data: Buffer) {
      const m = own(addr);
      const s = await sessionOf(m.address);
      const accountId = s.primaryAccounts[MAIL]!;
      return server(() => stalwart.upload(m.address, pathOf(s.uploadUrl).replace("{accountId}", encodeURIComponent(accountId)), type, data));
    },

    async download(addr: string, blobId: string, name: string, type: string): Promise<Response> {
      const m = own(addr);
      const s = await sessionOf(m.address);
      const url = pathOf(s.downloadUrl)
        .replace("{accountId}", encodeURIComponent(s.primaryAccounts[MAIL]!))
        .replace("{blobId}", encodeURIComponent(blobId))
        .replace("{name}", encodeURIComponent(name))
        .replace("{type}", encodeURIComponent(type));
      return server(() => stalwart.download(m.address, url));
    },

    /** The passwords for a person's own mail apps (IMAP and SMTP); the secrets are never shown again. */
    async devices(addr: string): Promise<AppPassword[]> {
      const m = own(addr);
      return server(async () => {
        const id = await accountId(stalwart, m.address);
        return id ? stalwart.appPasswords(id) : [];
      });
    },
    async addDevice(addr: string, name: unknown): Promise<{ id: string; description: string; secret: string; username: string }> {
      const m = own(addr);
      if (typeof name !== "string" || !name.trim() || name.trim().length > 64)
        throw new MailError(422, "invalid-body", "name is 1 to 64 characters, such as iPhone.");
      return server(async () => {
        const id = await accountId(stalwart, m.address);
        if (!id) throw new MailError(502, "mail-server-unavailable", "The mailbox is still being set up on the mail server; try again in a minute.");
        const p = await stalwart.createAppPassword(id, name.trim());
        return { id: p.id, description: name.trim(), secret: p.secret, username: m.address };
      });
    },
    async removeDevice(addr: string, deviceId: string): Promise<void> {
      const m = own(addr);
      await server(async () => {
        const id = await accountId(stalwart, m.address);
        if (!id || !(await stalwart.appPasswords(id)).some((p) => p.id === deviceId)) throw new MailError(404, "not-found", "No such device password.");
        await stalwart.deleteAppPassword(id, deviceId);
      });
    },

    /** 1 when the server answers the service account. */
    async reachable(): Promise<boolean> {
      try {
        await stalwart.ping();
        return true;
      } catch {
        return false;
      }
    },

    gauges() {
      return { domains: domains.length, mailboxes: total(), syncOk: last ? last.ok : null, dnsProblems: this.summary().dnsProblems };
    },
  };
}

export type Mail = ReturnType<typeof createMail>;
