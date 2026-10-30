import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mailboxOf, parseConfig, watchConfig } from "./config.ts";
import { DOMAINS } from "./test-app.ts";

describe("the domains file", () => {
  it("reads domains and mailboxes, lowercased, with sizes in bytes", () => {
    const domains = parseConfig(DOMAINS);
    expect(domains.map((d) => d.name)).toEqual(["example.com", "example.org"]);
    expect(domains[0]).toEqual({
      name: "example.com",
      dkimSelector: "mail",
      mailboxes: [
        { address: "jane@example.com", name: "Jane Doe", quota: 5 * 1024 ** 3, aliases: ["j.doe@example.com", "sales@example.org"], disabled: false },
        { address: "gone@example.com", name: null, quota: null, aliases: [], disabled: true },
      ],
    });
    expect(parseConfig("domains:\n  - name: Example.NET\n    mailboxes: [{ address: Ali@Example.net }]")[0]!.mailboxes[0]!.address).toBe("ali@example.net");
    expect(parseConfig("")).toEqual([]);
  });

  it("finds the mailbox of an address, but not of an alias", () => {
    const domains = parseConfig(DOMAINS);
    expect(mailboxOf(domains, "JANE@example.com")?.name).toBe("Jane Doe");
    expect(mailboxOf(domains, "j.doe@example.com")).toBeUndefined();
  });

  it.each([
    ["sites: []", "The file holds one list, domains:, and nothing else."],
    ["domains: {}", "domains must be a list."],
    ["domains:\n  - name: not a domain", "domains[0].name is required: a domain such as example.com."],
    ["domains:\n  - name: a.com\n  - name: A.com", "domains[1].name: a.com is in the file twice."],
    ["domains:\n  - name: a.com\n    mx: x", "domains[0] (a.com): unknown mx; a domain takes name, dkimSelector, mailboxes."],
    [
      "domains:\n  - name: a.com\n    dkimSelector: mail._domainkey",
      "domains[0] (a.com).dkimSelector is the selector's name, such as mail, without ._domainkey.",
    ],
    ["domains:\n  - name: a.com\n    mailboxes: [{ address: jane }]", "domains[0] (a.com).mailboxes[0].address is an email address, such as jane@example.com."],
    [
      "domains:\n  - name: a.com\n    mailboxes: [{ address: jane@b.com }]",
      "domains[0] (a.com).mailboxes[0].address jane@b.com must be in a.com, the domain it is listed under.",
    ],
    [
      "domains:\n  - name: a.com\n    mailboxes: [{ address: x@a.com }, { address: y@a.com, aliases: [x@a.com] }]",
      "domains[0] (a.com).mailboxes[1].aliases[0]: x@a.com is already used by x@a.com.",
    ],
    [
      "domains:\n  - name: a.com\n    mailboxes: [{ address: x@a.com, aliases: [x@b.com] }]",
      "domains[0] (a.com).mailboxes[0].aliases[0] x@b.com must be in a domain of the file.",
    ],
    [
      "domains:\n  - name: a.com\n    mailboxes: [{ address: x@a.com, quota: 10KB }]",
      "domains[0] (a.com).mailboxes[0].quota is a size from 1MB to 100TB, such as 5GB.",
    ],
    [
      "domains:\n  - name: a.com\n    mailboxes: [{ address: x@a.com, password: p }]",
      "domains[0] (a.com).mailboxes[0]: unknown password; a mailbox takes address, name, quota, aliases, disabled.",
    ],
  ])("refuses %j", (text, message) => {
    expect(() => parseConfig(text)).toThrow(message);
  });

  it("keeps the last good version when the file breaks, and applies the fix", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mail-config-")), "mail.yaml");
    writeFileSync(path, DOMAINS);
    const applied: number[] = [];
    const file = watchConfig(path, (d) => void applied.push(d.length), { everyMs: 3_600_000 });
    expect(file.state).toMatchObject({ domains: 2, mailboxes: 2, error: null });
    writeFileSync(path, "domains: [");
    file.read();
    expect(file.state.error).toMatch(/^Not valid YAML/);
    expect(file.state.domains).toBe(2);
    writeFileSync(path, "domains:\n  - name: a.com\n");
    file.read();
    expect(file.state).toMatchObject({ domains: 1, mailboxes: 0, error: null });
    expect(applied).toEqual([2, 1]);
    file.stop();
  });
});
