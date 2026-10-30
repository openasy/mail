// Makes the mail server match the file: each domain exists, each mailbox is an account with its name, aliases, quota
// and whether it may sign in. Only accounts in the file's domains are touched. A mailbox taken out of the file is
// disabled, never deleted, so its mail stays until an admin deletes it on the server.
import type { Domain, Mailbox } from "./config.ts";
import type { Stalwart, StalwartAccount } from "./stalwart.ts";

/** What a disabled account may not do; the rest of its permissions stay as they are. */
const DISABLED = { authenticate: true, emailReceive: true, emailSend: true };

export interface SyncResult {
  at: string;
  ok: boolean;
  /** Domains created on the server. */
  domains: number;
  created: string[];
  updated: string[];
  /** Accounts disabled because their mailbox left the file. */
  disabled: string[];
  error: string | null;
}

const localPart = (addr: string) => addr.slice(0, addr.lastIndexOf("@"));
const domainPart = (addr: string) => addr.slice(addr.lastIndexOf("@") + 1);

/** The account properties a mailbox sets, with the server's domain ids. */
function wanted(m: Mailbox, domainIds: Map<string, string>, disabled: boolean): Record<string, unknown> {
  return {
    description: m.name,
    aliases: Object.fromEntries(m.aliases.map((a, i) => [String(i), { name: localPart(a), domainId: domainIds.get(domainPart(a))! }])),
    quotas: { maxDiskQuota: m.quota },
    permissions: disabled ? { "@type": "Merge", enabledPermissions: {}, disabledPermissions: DISABLED } : { "@type": "Inherit" },
  };
}

const isDisabled = (a: StalwartAccount) => a.permissions?.["@type"] === "Merge" && a.permissions.disabledPermissions?.authenticate === true;

const aliasKey = (x: StalwartAccount["aliases"]) =>
  JSON.stringify(
    Object.values(x ?? {})
      .map((v) => `${v.name}@${v.domainId}`)
      .sort(),
  );

/** The properties of `want` the account does not have yet. Of permissions, only whether it is disabled is compared,
 * so permissions an admin gave on the server stay. */
function diff(a: StalwartAccount, want: Record<string, unknown>, disabled: boolean): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if ((a.description ?? null) !== want.description) patch.description = want.description;
  if (aliasKey(a.aliases) !== aliasKey(want.aliases as StalwartAccount["aliases"])) patch.aliases = want.aliases;
  if ((a.quotas?.maxDiskQuota ?? null) !== (want.quotas as { maxDiskQuota: number | null }).maxDiskQuota) patch.quotas = want.quotas;
  if (isDisabled(a) !== disabled) patch.permissions = want.permissions;
  return patch;
}

export async function sync(stalwart: Stalwart, domains: Domain[], now = () => new Date()): Promise<SyncResult> {
  const result: SyncResult = { at: now().toISOString(), ok: false, domains: 0, created: [], updated: [], disabled: [], error: null };
  try {
    const domainIds = new Map((await stalwart.domains()).map((d) => [d.name.toLowerCase(), d.id]));
    for (const d of domains) {
      if (domainIds.has(d.name)) continue;
      domainIds.set(d.name, await stalwart.createDomain(d.name));
      result.domains++;
    }
    const names = new Map([...domainIds].map(([name, id]) => [id, name]));
    const ours = new Set(domains.map((d) => domainIds.get(d.name)!));
    const accounts = new Map(
      (await stalwart.accounts())
        .filter((a) => a["@type"] === "User" && ours.has(a.domainId))
        .map((a) => [`${a.name.toLowerCase()}@${names.get(a.domainId)}`, a]),
    );

    const create: Record<string, Record<string, unknown>> = {};
    const update: Record<string, Record<string, unknown>> = {};
    const keys: string[] = [];
    for (const d of domains) {
      for (const m of d.mailboxes) {
        const want = wanted(m, domainIds, m.disabled);
        const have = accounts.get(m.address);
        accounts.delete(m.address);
        if (!have) {
          keys.push(m.address);
          create[`m${keys.length - 1}`] = {
            "@type": "User",
            name: localPart(m.address),
            domainId: domainIds.get(d.name),
            roles: { "@type": "User" },
            encryptionAtRest: { "@type": "Disabled" },
            ...want,
          };
          result.created.push(m.address);
          continue;
        }
        const patch = diff(have, want, m.disabled);
        if (Object.keys(patch).length) {
          update[have.id] = patch;
          result.updated.push(m.address);
        }
      }
    }
    // What is left are accounts in the file's domains that the file no longer lists.
    for (const [addr, a] of accounts) {
      if (isDisabled(a)) continue;
      update[a.id] = { permissions: { "@type": "Merge", enabledPermissions: {}, disabledPermissions: DISABLED } };
      result.disabled.push(addr);
    }
    if (Object.keys(create).length || Object.keys(update).length) await stalwart.setAccounts({ create, update });
    result.ok = true;
  } catch (err) {
    result.error = (err as Error).message;
  }
  return result;
}

/** The account of an address on the server, for its device passwords. */
export async function accountId(stalwart: Stalwart, addr: string): Promise<string | undefined> {
  const domainId = (await stalwart.domains()).find((d) => d.name.toLowerCase() === domainPart(addr))?.id;
  if (!domainId) return undefined;
  return (await stalwart.accounts()).find((a) => a["@type"] === "User" && a.domainId === domainId && a.name.toLowerCase() === localPart(addr))?.id;
}
