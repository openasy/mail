// The domains and mailboxes Mail runs, from one YAML file (MAIL_CONFIG). As with the install's other files, the file is
// the only way in: no screen or API route adds, changes or removes a domain or a mailbox. It is applied whole or not at
// all, read again within a minute of a change, and a file with a mistake leaves the last good version in place.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { parse } from "yaml";

export interface Mailbox {
  /** The address people sign in with and that mail is delivered to, such as jane@example.com. */
  address: string;
  /** The person's name, shown as the sender. */
  name: string | null;
  /** Bytes the mailbox may hold, or null for no limit. */
  quota: number | null;
  /** Other addresses delivered to this mailbox, in any domain of the file. */
  aliases: string[];
  /** A disabled mailbox cannot sign in or receive mail; its mail is kept. */
  disabled: boolean;
}

export interface Domain {
  name: string;
  /** The DKIM selector the server signs with, to check its DNS record; null to skip that check. */
  dkimSelector: string | null;
  mailboxes: Mailbox[];
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOCAL = /^[a-z0-9]([a-z0-9._+-]{0,62}[a-z0-9])?$/;
const SELECTOR = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN_KEYS = ["name", "dkimSelector", "mailboxes"];
const MAILBOX_KEYS = ["address", "name", "quota", "aliases", "disabled"];
const UNITS: Record<string, number> = { "": 1, B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** "5GB", "500 MB" or a number of bytes. */
function size(v: unknown, at: string): number {
  const m = typeof v === "number" ? [String(v), String(v), ""] : typeof v === "string" ? /^(\d+)\s*([KMGT]?B)?$/i.exec(v.trim()) : null;
  const n = m ? Number(m[1]) * UNITS[(m[2] ?? "").toUpperCase()]! : NaN;
  if (!Number.isSafeInteger(n) || n < 1024 ** 2 || n > 100 * 1024 ** 4) throw new Error(`${at} is a size from 1MB to 100TB, such as 5GB.`);
  return n;
}

/** An address split at its @, lowercased; throws with where it is in the file. */
function address(v: unknown, at: string): { address: string; local: string; domain: string } {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  const i = s.lastIndexOf("@");
  const local = s.slice(0, i);
  const domain = s.slice(i + 1);
  if (i < 1 || !LOCAL.test(local) || !DOMAIN.test(domain)) throw new Error(`${at} is an email address, such as jane@example.com.`);
  return { address: s, local, domain };
}

/** Reads the file's text. Throws with the domain and field at fault, so one message says what to fix. */
export function parseConfig(text: string): Domain[] {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw new Error(`Not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (doc === null || doc === undefined) return [];
  if (!isObj(doc) || Object.keys(doc).some((k) => k !== "domains")) throw new Error("The file holds one list, domains:, and nothing else.");
  const list = doc.domains ?? [];
  if (!Array.isArray(list)) throw new Error("domains must be a list.");
  if (list.length > 500) throw new Error("domains holds at most 500 entries.");

  const names = new Set<string>();
  for (const [i, d] of list.entries()) {
    const name = isObj(d) && typeof d.name === "string" ? d.name.trim().toLowerCase() : "";
    if (!DOMAIN.test(name)) throw new Error(`domains[${i}].name is required: a domain such as example.com.`);
    if (names.has(name)) throw new Error(`domains[${i}].name: ${name} is in the file twice.`);
    names.add(name);
  }

  // Every address, mailbox or alias, belongs to one mailbox only.
  const owner = new Map<string, string>();
  const claim = (addr: string, by: string, at: string) => {
    const was = owner.get(addr);
    if (was) throw new Error(`${at}: ${addr} is already ${was === by ? "an address of this mailbox" : `used by ${was}`}.`);
    owner.set(addr, by);
  };
  let total = 0;

  return list.map((d: Record<string, unknown>, i) => {
    const name = (d.name as string).trim().toLowerCase();
    const at = `domains[${i}] (${name})`;
    const extra = Object.keys(d).filter((k) => !DOMAIN_KEYS.includes(k));
    if (extra.length) throw new Error(`${at}: unknown ${extra.join(", ")}; a domain takes ${DOMAIN_KEYS.join(", ")}.`);
    if (d.dkimSelector !== undefined && (typeof d.dkimSelector !== "string" || !SELECTOR.test(d.dkimSelector)))
      throw new Error(`${at}.dkimSelector is the selector's name, such as mail, without ._domainkey.`);
    const boxes = d.mailboxes ?? [];
    if (!Array.isArray(boxes)) throw new Error(`${at}.mailboxes must be a list.`);
    total += boxes.length;
    if (total > 20_000) throw new Error("The file holds at most 20000 mailboxes.");

    const mailboxes = boxes.map((m: unknown, n): Mailbox => {
      const mat = `${at}.mailboxes[${n}]`;
      if (!isObj(m)) throw new Error(`${mat} must be a map with at least address.`);
      const extraKeys = Object.keys(m).filter((k) => !MAILBOX_KEYS.includes(k));
      if (extraKeys.length) throw new Error(`${mat}: unknown ${extraKeys.join(", ")}; a mailbox takes ${MAILBOX_KEYS.join(", ")}.`);
      const a = address(m.address, `${mat}.address`);
      if (a.domain !== name) throw new Error(`${mat}.address ${a.address} must be in ${name}, the domain it is listed under.`);
      claim(a.address, a.address, `${mat}.address`);
      if (m.name !== undefined && (typeof m.name !== "string" || !m.name.trim() || m.name.length > 128))
        throw new Error(`${mat}.name is up to 128 characters.`);
      if (m.disabled !== undefined && typeof m.disabled !== "boolean") throw new Error(`${mat}.disabled is true or false.`);
      if (m.aliases !== undefined && (!Array.isArray(m.aliases) || m.aliases.length > 100)) throw new Error(`${mat}.aliases is a list of up to 100 addresses.`);
      const aliases = ((m.aliases ?? []) as unknown[]).map((v, k) => {
        const al = address(v, `${mat}.aliases[${k}]`);
        if (!names.has(al.domain)) throw new Error(`${mat}.aliases[${k}] ${al.address} must be in a domain of the file.`);
        claim(al.address, a.address, `${mat}.aliases[${k}]`);
        return al.address;
      });
      return {
        address: a.address,
        name: typeof m.name === "string" ? m.name.trim() : null,
        quota: m.quota === undefined ? null : size(m.quota, `${mat}.quota`),
        aliases,
        disabled: m.disabled === true,
      };
    });
    return { name, dkimSelector: (d.dkimSelector as string | undefined) ?? null, mailboxes };
  });
}

/** The mailbox an address belongs to, as its own address or one of its aliases. */
export function mailboxOf(domains: Domain[], addr: string): Mailbox | undefined {
  const a = addr.trim().toLowerCase();
  for (const d of domains) for (const m of d.mailboxes) if (m.address === a) return m;
  return undefined;
}

export interface ConfigFileState {
  path: string;
  /** When the file was last read and applied, or null if it never was. */
  appliedAt: string | null;
  domains: number;
  mailboxes: number;
  /** Why the file on disk is not what is applied; the last good version stays until it is fixed. */
  error: string | null;
}

/**
 * Reads the file now and whenever it changes (checked every `everyMs`, by size, time and content), and hands each new
 * list to `apply`. A file that cannot be read or parsed leaves the last good list in place. `stop()` ends the polling.
 */
export function watchConfig(
  path: string,
  apply: (domains: Domain[]) => void,
  { everyMs = 60_000, onChange }: { everyMs?: number; onChange?: (state: ConfigFileState) => void } = {},
) {
  const state: ConfigFileState = { path, appliedAt: null, domains: 0, mailboxes: 0, error: null };
  let seen = "";
  const read = () => {
    let text: string;
    let stamp: string;
    try {
      const st = statSync(path);
      text = readFileSync(path, "utf8");
      stamp = `${st.size}:${st.mtimeMs}:${createHash("sha256").update(text).digest("hex")}`;
    } catch (err) {
      const error = `Cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`;
      if (state.error !== error) ((state.error = error), onChange?.(state));
      return;
    }
    if (stamp === seen) return;
    seen = stamp;
    try {
      const domains = parseConfig(text);
      apply(domains);
      Object.assign(state, {
        appliedAt: new Date().toISOString(),
        domains: domains.length,
        mailboxes: domains.reduce((n, d) => n + d.mailboxes.length, 0),
        error: null,
      });
    } catch (err) {
      state.error = (err as Error).message;
    }
    onChange?.(state);
  };
  read();
  const timer = setInterval(read, everyMs);
  timer.unref();
  return { state, read, stop: () => clearInterval(timer) };
}
