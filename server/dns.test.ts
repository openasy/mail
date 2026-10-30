import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";
import { checkDomain } from "./dns.ts";
import { DOMAINS, fakeDns } from "./test-app.ts";

const [example, org] = parseConfig(DOMAINS);
const status = async (r = fakeDns(), d = example!) => Object.fromEntries((await checkDomain(d, "mail.example.com", r)).records.map((x) => [x.kind, x.status]));

describe("DNS checks", () => {
  it("finds every record in place", async () => {
    expect(await status()).toEqual({ mx: "ok", spf: "ok", dkim: "ok", dmarc: "ok", "mta-sts": "ok" });
  });

  it("says what is missing, with a value to copy, and skips DKIM without a selector", async () => {
    const c = await checkDomain(org!, "mail.example.com", fakeDns());
    expect(c.records.map((r) => [r.kind, r.status])).toEqual([
      ["mx", "missing"],
      ["spf", "missing"],
      ["dmarc", "missing"],
      ["mta-sts", "missing"],
    ]);
    expect(c.records[0]!.expected).toBe("10 mail.example.com.");
    expect(c.records[2]!.expected).toBe("v=DMARC1; p=quarantine; rua=mailto:postmaster@example.org");
  });

  it("says why a record is wrong", async () => {
    const r = fakeDns(
      { "example.com": ["v=spf1 +all"], "mail._domainkey.example.com": ["v=DKIM1; p="], "_dmarc.example.com": ["v=DMARC1; p=none", "v=DMARC1; p=reject"] },
      { "example.com": ["mx.other.net."] },
    );
    const c = await checkDomain(example!, "mail.example.com", r);
    expect(c.records.map((x) => [x.kind, x.status])).toEqual([
      ["mx", "wrong"],
      ["spf", "wrong"],
      ["dkim", "wrong"],
      ["dmarc", "wrong"],
      ["mta-sts", "ok"],
    ]);
    expect(c.records[0]!.detail).toBe("Mail for example.com goes first to mx.other.net, not to mail.example.com.");
    expect(await status(fakeDns({ "example.com": ["v=spf1 mx -all", "v=spf1 a -all"] }))).toMatchObject({ spf: "wrong" });
  });

  it("names a null MX, which says the domain takes no mail", async () => {
    const c = await checkDomain(example!, "mail.example.com", fakeDns({}, { "example.com": ["."] }));
    expect(c.records[0]).toMatchObject({ status: "wrong", found: ["."], detail: "The MX record says example.com receives no mail (null MX); replace it." });
  });

  it("passes on lookup failures other than a missing name", async () => {
    const r = fakeDns();
    r.resolveMx = async () => {
      throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
    };
    await expect(checkDomain(example!, "mail.example.com", r)).rejects.toThrow("timeout");
  });
});
