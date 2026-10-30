import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GONE, STRANGER, startApp } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp({ version: "0.1.0" });
});
afterAll(() => app.close());

const json = async (res: Response) => (await res.json()) as any;
const jmap = (methodCalls: unknown[], using = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"]) => ({
  method: "POST",
  body: JSON.stringify({ using, methodCalls }),
});

describe("administration", () => {
  it("lists the domains of the file with their mailboxes", async () => {
    const body = await json(await app.admin("/api/v1/domains"));
    expect(body.domains.map((d: any) => [d.name, d.mailboxes, d.disabled])).toEqual([
      ["example.com", 2, 1],
      ["example.org", 0, 0],
    ]);
    const one = await json(await app.admin("/api/v1/domains/EXAMPLE.com"));
    expect(one.mailboxes.map((m: any) => m.address)).toEqual(["jane@example.com", "gone@example.com"]);
    expect((await app.admin("/api/v1/domains/nope.com")).status).toBe(404);
  });

  it("checks a domain's DNS and shows the result with the domain", async () => {
    const check = await json(await app.admin("/api/v1/domains/example.com/dns", { method: "POST" }));
    expect(check.records.every((r: any) => r.status === "ok")).toBe(true);
    expect((await json(await app.admin("/api/v1/domains"))).domains[0].dns.domain).toBe("example.com");
  });

  it("brings the server in step on request and keeps the history", async () => {
    const run = await json(await app.admin("/api/v1/sync", { method: "POST" }));
    expect(run).toMatchObject({ ok: true, created: [], updated: [] });
    const history = await json(await app.admin("/api/v1/sync"));
    expect(history.runs.length).toBe(2);
    expect(history.runs[1]).toMatchObject({ ok: true, domains: 2, created: 2 });
    expect((await json(await app.admin("/api/v1/summary"))).sync.ok).toBe(true);
  });

  it("is not open to people who only read their mail", async () => {
    expect((await app.jane("/api/v1/domains")).status).toBe(401);
    expect((await fetch(`${app.base}/api/v1/domains`)).status).toBe(401);
  });
});

describe("webmail", () => {
  it("gives a person their session, without the server's own addresses or management", async () => {
    const s = await json(await app.jane("/api/v1/webmail/session"));
    expect(s.address).toBe("jane@example.com");
    expect(s.name).toBe("Jane Doe");
    expect(s.accountId).toBeTruthy();
    expect(Object.keys(s.capabilities).sort()).toEqual(["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"]);
    expect(JSON.stringify(s)).not.toContain("mail.example.com/jmap");
  });

  it("passes mail methods on as that person", async () => {
    const r = await json(await app.jane("/api/v1/webmail/jmap", jmap([["Email/query", { accountId: "a" }, "0"]])));
    expect(r.methodResponses[0]).toEqual(["Email/query", { accountId: "a", as: "jane@example.com" }, "0"]);
    const call = app.fake.calls.at(-1)!;
    expect(call).toMatchObject({ as: "jane@example.com", method: "Email/query" });
  });

  it("never passes on the server's management methods or other capabilities", async () => {
    const before = app.fake.calls.length;
    const res = await app.jane("/api/v1/webmail/jmap", jmap([["x:Account/get", { ids: null }, "0"]]));
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("method-not-allowed");
    expect(app.fake.calls.length).toBe(before);
    // A capability the webmail may not use is dropped before the call goes on.
    await app.jane("/api/v1/webmail/jmap", jmap([["Core/echo", {}, "0"]], ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"]));
    expect(app.fake.calls.at(-1)).toMatchObject({ as: "jane@example.com", method: "Core/echo" });
    expect((await app.jane("/api/v1/webmail/jmap", { method: "POST", body: JSON.stringify({ using: [] }) })).status).toBe(400);
    expect((await app.jane("/api/v1/webmail/jmap", { method: "POST", body: "{" })).status).toBe(400);
  });

  it("uploads and downloads attachments, always as a download", async () => {
    const up = await json(
      await app.jane("/api/v1/webmail/upload", { method: "POST", body: "<script>alert(1)</script>", headers: { "content-type": "text/html" } }),
    );
    expect(up.blobId).toBeTruthy();
    const down = await app.jane(`/api/v1/webmail/download/${up.blobId}?name=${encodeURIComponent("a b.html")}&type=text/html`);
    expect(down.status).toBe(200);
    expect(down.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''a%20b.html");
    expect(down.headers.get("content-security-policy")).toBe("sandbox");
    expect(await down.text()).toBe("<script>alert(1)</script>");
  });

  it("refuses people without a mailbox, disabled mailboxes and API tokens", async () => {
    const stranger = await app.as(STRANGER)("/api/v1/webmail/session");
    expect(stranger.status).toBe(403);
    expect((await json(stranger)).detail).toBe("stranger@example.net has no mailbox in the domains file; an admin adds it there.");
    expect((await json(await app.as(GONE)("/api/v1/webmail/session"))).detail).toBe("The mailbox gone@example.com is disabled.");
    expect((await app.admin("/api/v1/webmail/session")).status).toBe(401);
  });

  it("says when the mail server does not answer", async () => {
    app.fake.state.down = true;
    try {
      const res = await app.jane("/api/v1/devices");
      expect(res.status).toBe(502);
      expect((await json(res)).code).toBe("mail-server-unavailable");
    } finally {
      app.fake.state.down = false;
    }
  });
});

describe("device passwords", () => {
  it("are made for a person's own mailbox, shown once, and can be removed", async () => {
    const made = await app.jane("/api/v1/devices", { method: "POST", body: JSON.stringify({ name: " iPhone " }) });
    expect(made.status).toBe(201);
    const device = await json(made);
    expect(device).toMatchObject({ description: "iPhone", username: "jane@example.com" });
    expect(device.secret).toBeTruthy();
    const list = await json(await app.jane("/api/v1/devices"));
    expect(list.devices).toEqual([{ id: device.id, description: "iPhone" }]);
    expect(JSON.stringify(list)).not.toContain(device.secret);
    expect((await app.jane(`/api/v1/devices/${device.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await app.jane(`/api/v1/devices/${device.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await json(await app.jane("/api/v1/devices"))).devices).toEqual([]);
    expect((await app.jane("/api/v1/devices", { method: "POST", body: JSON.stringify({ name: "" }) })).status).toBe(422);
  });
});
