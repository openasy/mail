import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";
import { fakeStalwart, SERVICE_PASSWORD, SERVICE_USER } from "./fake-stalwart.ts";
import { createStalwart } from "./stalwart.ts";
import { accountId, sync } from "./sync.ts";
import { DOMAINS } from "./test-app.ts";

function setup() {
  const fake = fakeStalwart();
  const stalwart = createStalwart({ url: "http://stalwart:8080", user: SERVICE_USER, password: SERVICE_PASSWORD, fetch: fake.fetch });
  const byAddress = (addr: string) => [...fake.accounts.values()].find((a) => fake.addressOf(a) === addr);
  return { fake, stalwart, byAddress };
}

describe("keeping the mail server in step with the file", () => {
  it("creates the domains and an account for each mailbox", async () => {
    const { fake, stalwart, byAddress } = setup();
    const r = await sync(stalwart, parseConfig(DOMAINS));
    expect(r).toMatchObject({ ok: true, domains: 2, created: ["jane@example.com", "gone@example.com"], updated: [], disabled: [], error: null });
    expect([...fake.domains.values()].map((d) => d.name)).toEqual(["example.com", "example.org"]);
    const org = [...fake.domains.values()].find((d) => d.name === "example.org")!.id;
    expect(byAddress("jane@example.com")).toMatchObject({
      "@type": "User",
      description: "Jane Doe",
      quotas: { maxDiskQuota: 5 * 1024 ** 3 },
      permissions: { "@type": "Inherit" },
      aliases: { "0": { name: "j.doe" }, "1": { name: "sales", domainId: org } },
    });
    expect(byAddress("gone@example.com")!.permissions).toMatchObject({ "@type": "Merge", disabledPermissions: { authenticate: true } });
    // Nothing is created without a password of its own: people reach their mail through Mail or a device password.
    expect(byAddress("jane@example.com")).not.toHaveProperty("credentials");
  });

  it("changes nothing when the server already matches", async () => {
    const { fake, stalwart } = setup();
    await sync(stalwart, parseConfig(DOMAINS));
    const before = fake.calls.length;
    const r = await sync(stalwart, parseConfig(DOMAINS));
    expect(r).toMatchObject({ ok: true, domains: 0, created: [], updated: [], disabled: [] });
    expect(fake.calls.slice(before).map((c) => c.method)).toEqual(["x:Domain/get", "x:Account/get"]);
  });

  it("updates what changed and disables mailboxes taken out of the file, keeping their mail", async () => {
    const { fake, stalwart, byAddress } = setup();
    await sync(stalwart, parseConfig(DOMAINS));
    const next = `
domains:
  - name: example.com
    mailboxes:
      - { address: jane@example.com, name: Jane Smith, quota: 10GB }
      - { address: gone@example.com }
  - name: example.org
`;
    const r = await sync(stalwart, parseConfig(next));
    expect(r).toMatchObject({ ok: true, created: [], updated: ["jane@example.com", "gone@example.com"], disabled: [] });
    expect(byAddress("jane@example.com")).toMatchObject({ description: "Jane Smith", quotas: { maxDiskQuota: 10 * 1024 ** 3 }, aliases: {} });
    expect(byAddress("gone@example.com")!.permissions).toEqual({ "@type": "Inherit" });

    const r2 = await sync(stalwart, parseConfig("domains:\n  - name: example.com\n    mailboxes: [{ address: gone@example.com }]\n  - name: example.org"));
    expect(r2.disabled).toEqual(["jane@example.com"]);
    expect(byAddress("jane@example.com")!.permissions).toMatchObject({ "@type": "Merge" });
    expect(fake.accounts.size).toBe(2);
  });

  it("leaves accounts in other domains alone", async () => {
    const { fake, stalwart, byAddress } = setup();
    await sync(stalwart, parseConfig("domains:\n  - name: other.com\n    mailboxes: [{ address: x@other.com }]"));
    await sync(stalwart, parseConfig(DOMAINS));
    expect(byAddress("x@other.com")!.permissions).toEqual({ "@type": "Inherit" });
    expect(fake.accounts.size).toBe(3);
  });

  it("reports a server it cannot reach, and finds an account by address", async () => {
    const { fake, stalwart } = setup();
    await sync(stalwart, parseConfig(DOMAINS));
    expect(await accountId(stalwart, "jane@example.com")).toBeTruthy();
    expect(await accountId(stalwart, "nobody@example.com")).toBeUndefined();
    expect(await accountId(stalwart, "jane@nowhere.com")).toBeUndefined();
    fake.state.down = true;
    const r = await sync(stalwart, parseConfig(DOMAINS));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot be reached/);
  });

  it("names the service account when the server refuses it", async () => {
    const fake = fakeStalwart();
    const stalwart = createStalwart({ url: "http://stalwart:8080", user: SERVICE_USER, password: "wrong", fetch: fake.fetch });
    expect((await sync(stalwart, [])).error).toMatch(/MAIL_STALWART_USER/);
  });
});
