// The mail server. Stalwart receives, stores and sends the mail; Mail talks to it over JMAP only: its management
// methods (x:Domain, x:Account, x:AppPassword, Stalwart 0.16 and later) with a service account, and the standard mail
// methods as a person, by impersonation (`<address>%<service account>`), so people never give Mail their password.

export const CORE = "urn:ietf:params:jmap:core";
export const MANAGEMENT = "urn:stalwart:jmap";

export type Invocation = [name: string, args: Record<string, unknown>, id: string];

export interface JmapRequest {
  using: string[];
  methodCalls: Invocation[];
}

export interface JmapResponse {
  methodResponses: Invocation[];
  sessionState?: string;
}

export interface JmapSession {
  username: string;
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  primaryAccounts: Record<string, string>;
  accounts: Record<string, { name: string; isPersonal: boolean; accountCapabilities: Record<string, unknown> }>;
  capabilities: Record<string, unknown>;
  state: string;
}

/** A Stalwart domain, as x:Domain/get returns it. */
export interface StalwartDomain {
  id: string;
  name: string;
}

/** A Stalwart account; only the properties Mail sets or reads. */
export interface StalwartAccount {
  id: string;
  "@type": string;
  name: string;
  domainId: string;
  description?: string | null;
  aliases?: Record<string, { name: string; domainId: string }> | null;
  quotas?: { maxDiskQuota?: number | null } | null;
  permissions?: { "@type": string; disabledPermissions?: Record<string, boolean> } | null;
}

export interface AppPassword {
  id: string;
  description: string;
  createdAt?: string;
}

export class StalwartError extends Error {
  /** The HTTP status Stalwart answered with, or 0 when it could not be reached. */
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

export interface StalwartOptions {
  /** Where Mail reaches Stalwart's HTTP listener, such as http://stalwart:8080. */
  url: string;
  /** The service account Mail manages and impersonates with; it needs the impersonate permission. */
  user: string;
  password: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

export function createStalwart({ url, user, password, fetch: f = fetch, timeoutMs = 15_000 }: StalwartOptions) {
  const base = url.replace(/\/$/, "");
  const admin = basic(user, password);
  /** The header that acts as one person; Stalwart checks the service account's password and permission. */
  const as = (addr: string) => basic(`${addr}%${user}`, password);

  async function request(path: string, init: RequestInit & { authorization: string }): Promise<Response> {
    let res: Response;
    try {
      res = await f(path.startsWith("http") ? path : base + path, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: init.authorization },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new StalwartError(`The mail server at ${base} cannot be reached: ${(err as Error).message}`);
    }
    if (res.status === 401) throw new StalwartError("The mail server refused the service account; check MAIL_STALWART_USER and its password.", 401);
    if (!res.ok) throw new StalwartError(`The mail server answered ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
    return res;
  }

  async function jmap(authorization: string, body: JmapRequest, apiUrl = "/jmap/"): Promise<JmapResponse> {
    const res = await request(apiUrl, { method: "POST", authorization, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as JmapResponse;
  }

  /** One management method; throws with Stalwart's own description when it answers with an error. */
  async function manage<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const r = await jmap(admin, { using: [CORE, MANAGEMENT], methodCalls: [[name, args, "0"]] });
    const [got, result] = r.methodResponses[0] ?? [];
    if (got === "error") throw new StalwartError(`${name}: ${String(result?.description ?? result?.type ?? "error")}`, 200);
    return result as T;
  }

  /** Throws when a /set left anything not created, updated or destroyed, naming each and why. */
  function checkSet(name: string, r: Record<string, unknown>) {
    const failed = ["notCreated", "notUpdated", "notDestroyed"].flatMap((k) =>
      Object.entries((r[k] as Record<string, { type?: string; description?: string }> | null) ?? {}).map(
        ([id, e]) => `${id}: ${e.description ?? e.type ?? "refused"}`,
      ),
    );
    if (failed.length) throw new StalwartError(`${name}: ${failed.join("; ")}`, 200);
  }

  return {
    url: base,

    async domains(): Promise<StalwartDomain[]> {
      return (await manage<{ list: StalwartDomain[] }>("x:Domain/get", { ids: null, properties: ["id", "name"] })).list;
    },
    async createDomain(name: string): Promise<string> {
      const r = await manage<{ created?: Record<string, { id: string }> }>("x:Domain/set", { create: { d: { name } } });
      checkSet("x:Domain/set", r);
      return r.created!.d!.id;
    },

    async accounts(): Promise<StalwartAccount[]> {
      return (await manage<{ list: StalwartAccount[] }>("x:Account/get", { ids: null })).list;
    },
    /** Creates, updates and destroys accounts in one call; returns the ids of the created ones by their key. */
    async setAccounts(changes: {
      create?: Record<string, Record<string, unknown>>;
      update?: Record<string, Record<string, unknown>>;
    }): Promise<Record<string, string>> {
      const r = await manage<Record<string, unknown>>("x:Account/set", changes);
      checkSet("x:Account/set", r);
      return Object.fromEntries(Object.entries((r.created as Record<string, { id: string }> | null) ?? {}).map(([k, v]) => [k, v.id]));
    },

    async appPasswords(accountId: string): Promise<AppPassword[]> {
      return (await manage<{ list: AppPassword[] }>("x:AppPassword/get", { accountId, ids: null })).list;
    },
    /** A password for one device; Stalwart returns its secret only here. */
    async createAppPassword(accountId: string, description: string): Promise<{ id: string; secret: string }> {
      const r = await manage<{ created?: Record<string, { id: string; secret: string }> }>("x:AppPassword/set", {
        accountId,
        create: { p: { description, permissions: { "@type": "Inherit" }, allowedIps: {} } },
      });
      checkSet("x:AppPassword/set", r);
      return r.created!.p!;
    },
    async deleteAppPassword(accountId: string, id: string): Promise<void> {
      checkSet("x:AppPassword/set", await manage<Record<string, unknown>>("x:AppPassword/set", { accountId, destroy: [id] }));
    },

    /** The JMAP session of one person, by impersonation. */
    async session(addr: string): Promise<JmapSession> {
      return (await (await request("/.well-known/jmap", { authorization: as(addr) })).json()) as JmapSession;
    },
    /** Standard JMAP calls as one person, to their session's apiUrl. */
    async call(addr: string, body: JmapRequest, apiUrl: string): Promise<JmapResponse> {
      return jmap(as(addr), body, apiUrl);
    },
    async upload(addr: string, url: string, type: string, body: Buffer): Promise<unknown> {
      return (await request(url, { method: "POST", authorization: as(addr), headers: { "content-type": type }, body })).json();
    },
    async download(addr: string, url: string): Promise<Response> {
      return request(url, { authorization: as(addr) });
    },
    async ping(): Promise<void> {
      await manage("Core/echo", {});
    },
  };
}

export type Stalwart = ReturnType<typeof createStalwart>;
