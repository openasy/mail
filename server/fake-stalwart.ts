// A mail server in memory for tests, answering the JMAP calls Mail makes the way Stalwart does. Given to
// createStalwart() as its fetch, so the real client code runs against it.
import type { Invocation, StalwartAccount } from "./stalwart.ts";

export const SERVICE_USER = "openasy";
export const SERVICE_PASSWORD = "service-password";
const PUBLIC = "https://mail.example.com";

export function fakeStalwart() {
  let next = 0;
  const id = () => (next++).toString(36);
  const domains = new Map<string, { id: string; name: string }>();
  const accounts = new Map<string, StalwartAccount>();
  const appPasswords = new Map<string, Array<{ id: string; description: string }>>();
  const blobs = new Map<string, { type: string; data: Buffer }>();
  /** Every JMAP call, with who made it: the service account or the person it acted as. */
  const calls: Array<{ as: string; method: string; args: Record<string, unknown> }> = [];
  const state = { down: false };

  const addressOf = (a: StalwartAccount) => `${a.name}@${[...domains.values()].find((d) => d.id === a.domainId)?.name}`;

  /** Who the Authorization header is: null when the password or the form is wrong. */
  function who(header: string | null): { as: string } | null {
    if (!header?.startsWith("Basic ")) return null;
    const [user, password] = Buffer.from(header.slice(6), "base64").toString().split(":");
    if (password !== SERVICE_PASSWORD) return null;
    if (user === SERVICE_USER) return { as: SERVICE_USER };
    const [target, by] = user!.split("%");
    if (by !== SERVICE_USER) return null;
    const account = [...accounts.values()].find((a) => addressOf(a) === target);
    if (!account || account.permissions?.["@type"] === "Merge") return null;
    return { as: target! };
  }

  function set(store: Map<string, any>, args: Record<string, any>, make: (v: any) => any) {
    const created: Record<string, unknown> = {};
    const updated: Record<string, null> = {};
    const notUpdated: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(args.create ?? {})) {
      const obj = make(v);
      store.set(obj.id, obj);
      created[key] = obj.secret ? { id: obj.id, secret: obj.secret } : { id: obj.id };
    }
    for (const [key, patch] of Object.entries(args.update ?? {})) {
      const obj = store.get(key);
      if (!obj) notUpdated[key] = { type: "notFound" };
      else (Object.assign(obj, patch), (updated[key] = null));
    }
    for (const key of (args.destroy ?? []) as string[]) store.delete(key);
    return { created, updated, notUpdated, destroyed: args.destroy ?? [] };
  }

  function method(as: string, [name, args, callId]: Invocation): Invocation {
    calls.push({ as, method: name, args });
    if (as !== SERVICE_USER && name.startsWith("x:")) return ["error", { type: "forbidden" }, callId];
    switch (name) {
      case "Core/echo":
        return [name, args, callId];
      case "x:Domain/get":
        return [name, { list: [...domains.values()] }, callId];
      case "x:Domain/set":
        return [name, set(domains, args, (v) => ({ id: id(), name: v.name })), callId];
      case "x:Account/get":
        return [name, { list: [...accounts.values()].map((a) => structuredClone(a)) }, callId];
      case "x:Account/set":
        return [name, set(accounts, args, (v) => ({ ...v, id: id() })), callId];
      case "x:AppPassword/get":
        return [name, { list: appPasswords.get(args.accountId as string) ?? [] }, callId];
      case "x:AppPassword/set": {
        const list = appPasswords.get(args.accountId as string) ?? [];
        const store = new Map(list.map((p) => [p.id, p]));
        const r = set(store, args, (v) => ({ id: id(), description: v.description, secret: `secret-${next}` }));
        appPasswords.set(
          args.accountId as string,
          [...store.values()].map((p) => ({ id: p.id, description: p.description })),
        );
        return [name, r, callId];
      }
      default:
        // Mail methods answer with what they were asked and who asked, which is all the tests look at.
        return [name, { accountId: args.accountId ?? null, as }, callId];
    }
  }

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    if (state.down) throw new TypeError("fetch failed");
    const url = new URL(String(input));
    const auth = who(new Headers(init.headers).get("authorization"));
    if (!auth) return new Response("Unauthorized", { status: 401 });
    if (url.pathname === "/.well-known/jmap") {
      const accountId = [...accounts.values()].find((a) => addressOf(a) === auth.as)?.id ?? "";
      return json({
        username: auth.as,
        apiUrl: `${PUBLIC}/jmap/`,
        downloadUrl: `${PUBLIC}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
        uploadUrl: `${PUBLIC}/jmap/upload/{accountId}/`,
        primaryAccounts: { "urn:ietf:params:jmap:mail": accountId, "urn:ietf:params:jmap:submission": accountId },
        accounts: { [accountId]: { name: auth.as, isPersonal: true, accountCapabilities: {} } },
        capabilities: {
          "urn:ietf:params:jmap:core": { maxSizeUpload: 50_000_000 },
          "urn:ietf:params:jmap:mail": {},
          "urn:ietf:params:jmap:submission": {},
          "urn:stalwart:jmap": {},
        },
        state: "s1",
      });
    }
    if (url.pathname === "/jmap/" && init.method === "POST") {
      const body = JSON.parse(String(init.body)) as { methodCalls: Invocation[] };
      return json({ methodResponses: body.methodCalls.map((c) => method(auth.as, c)), sessionState: "s1" });
    }
    const up = /^\/jmap\/upload\/([^/]+)\/$/.exec(url.pathname);
    if (up && init.method === "POST") {
      const blobId = `b${id()}`;
      const data = Buffer.from(init.body as Buffer);
      const type = new Headers(init.headers).get("content-type") ?? "";
      blobs.set(blobId, { type, data });
      return json({ accountId: decodeURIComponent(up[1]!), blobId, type, size: data.length });
    }
    const down = /^\/jmap\/download\/[^/]+\/([^/]+)\/[^/]+$/.exec(url.pathname);
    if (down) {
      const blob = blobs.get(decodeURIComponent(down[1]!));
      if (!blob) return new Response("Not found", { status: 404 });
      return new Response(new Uint8Array(blob.data), { headers: { "content-type": blob.type, "content-length": String(blob.data.length) } });
    }
    return new Response("Not found", { status: 404 });
  }) as typeof globalThis.fetch;

  return { fetch, domains, accounts, appPasswords, calls, state, addressOf };
}

export type FakeStalwart = ReturnType<typeof fakeStalwart>;
