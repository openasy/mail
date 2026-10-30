// The DNS records a domain needs for its mail to arrive and to be trusted when it is sent, and whether they are in place.
// Only public DNS is read; nothing is changed.
import { promises as dns } from "node:dns";
import type { Domain } from "./config.ts";

export type RecordKind = "mx" | "spf" | "dkim" | "dmarc" | "mta-sts";

export interface RecordCheck {
  kind: RecordKind;
  /** The name the record is set on, such as _dmarc.example.com. */
  name: string;
  type: "MX" | "TXT";
  status: "ok" | "missing" | "wrong";
  /** A value that would be right, to copy into the DNS provider. */
  expected: string;
  found: string[];
  /** Why it is wrong, when it is. */
  detail: string | null;
}

export interface DomainCheck {
  domain: string;
  checkedAt: string;
  records: RecordCheck[];
}

export interface Resolver {
  resolveMx(name: string): Promise<Array<{ exchange: string; priority: number }>>;
  resolveTxt(name: string): Promise<string[][]>;
}

const NOT_FOUND = new Set(["ENOTFOUND", "ENODATA", "ENONAME"]);

async function txt(r: Resolver, name: string): Promise<string[]> {
  try {
    return (await r.resolveTxt(name)).map((parts) => parts.join(""));
  } catch (err) {
    if (NOT_FOUND.has((err as NodeJS.ErrnoException).code ?? "")) return [];
    throw err;
  }
}

async function mx(r: Resolver, name: string): Promise<string[]> {
  try {
    return (await r.resolveMx(name)).sort((a, b) => a.priority - b.priority).map((m) => m.exchange.toLowerCase().replace(/\.$/, ""));
  } catch (err) {
    if (NOT_FOUND.has((err as NodeJS.ErrnoException).code ?? "")) return [];
    throw err;
  }
}

/** Checks one domain's records against `host`, the name the mail server is reached at (MAIL_HOSTNAME). */
export async function checkDomain(domain: Domain, host: string, r: Resolver = dns, now = () => new Date()): Promise<DomainCheck> {
  const d = domain.name;
  const records: RecordCheck[] = [];
  const add = (c: Omit<RecordCheck, "detail"> & { detail?: string | null }) => records.push({ ...c, detail: c.detail ?? null });

  const exchanges = await mx(r, d);
  // A single MX of "." (RFC 7505) says the domain receives no mail at all.
  const nullMx = exchanges.length === 1 && exchanges[0] === "";
  add({
    kind: "mx",
    name: d,
    type: "MX",
    expected: `10 ${host}.`,
    found: exchanges.map((e) => e || "."),
    status: exchanges.length === 0 ? "missing" : exchanges[0] === host ? "ok" : "wrong",
    detail: nullMx
      ? `The MX record says ${d} receives no mail (null MX); replace it.`
      : exchanges.length && exchanges[0] !== host
        ? `Mail for ${d} goes first to ${exchanges[0]}, not to ${host}.`
        : null,
  });

  const spf = (await txt(r, d)).filter((t) => /^v=spf1(\s|$)/i.test(t));
  const spfOk = spf.length === 1 && /\s(mx|a:|include:|ip[46]:)/i.test(spf[0]!) && !/\s\+all\b/i.test(spf[0]!);
  add({
    kind: "spf",
    name: d,
    type: "TXT",
    expected: "v=spf1 mx -all",
    found: spf,
    status: spf.length === 0 ? "missing" : spfOk ? "ok" : "wrong",
    detail:
      spf.length > 1
        ? "There is more than one SPF record; receivers then treat SPF as failed. Keep one."
        : spf.length && !spfOk
          ? "The SPF record does not name this server (mx), or allows any sender (+all)."
          : null,
  });

  if (domain.dkimSelector) {
    const name = `${domain.dkimSelector}._domainkey.${d}`;
    const keys = (await txt(r, name)).filter((t) => /(^|;)\s*p=/i.test(t));
    add({
      kind: "dkim",
      name,
      type: "TXT",
      expected: "v=DKIM1; k=rsa; p=<the public key the mail server shows for this selector>",
      found: keys,
      status: keys.length === 0 ? "missing" : keys.some((k) => /(^|;)\s*p=[A-Za-z0-9+/=]{20,}/.test(k)) ? "ok" : "wrong",
      detail: keys.length && !keys.some((k) => /(^|;)\s*p=[A-Za-z0-9+/=]{20,}/.test(k)) ? "The record has no public key (p= is empty)." : null,
    });
  }

  const dmarc = (await txt(r, `_dmarc.${d}`)).filter((t) => /^v=DMARC1\b/i.test(t));
  add({
    kind: "dmarc",
    name: `_dmarc.${d}`,
    type: "TXT",
    expected: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${d}`,
    found: dmarc,
    status: dmarc.length === 0 ? "missing" : dmarc.length === 1 ? "ok" : "wrong",
    detail: dmarc.length > 1 ? "There is more than one DMARC record; receivers then ignore DMARC. Keep one." : null,
  });

  const sts = (await txt(r, `_mta-sts.${d}`)).filter((t) => /^v=STSv1\b/i.test(t));
  add({
    kind: "mta-sts",
    name: `_mta-sts.${d}`,
    type: "TXT",
    expected: "v=STSv1; id=<a new value each time the policy changes>",
    found: sts,
    status: sts.length === 0 ? "missing" : "ok",
  });

  return { domain: d, checkedAt: now().toISOString(), records };
}
