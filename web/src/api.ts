// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json; mail follows JMAP
// (RFC 8620, 8621), sent through /api/v1/webmail/jmap as the signed-in person.

/** Another OpenAsy product of this install, from OPENASY_PRODUCTS. */
export interface ProductLink {
  id: string;
  url: string;
}

export type ConfigFile = { path: string; appliedAt: string | null; domains: number; mailboxes: number; error: string | null } | null;

export interface SyncResult {
  at: string;
  ok: boolean;
  domains: number;
  created: string[];
  updated: string[];
  disabled: string[];
  error: string | null;
}

export interface Summary {
  domains: number;
  mailboxes: number;
  disabled: number;
  file: ConfigFile;
  sync: SyncResult | null;
  hostname: string;
  dnsProblems: number;
}

export interface RecordCheck {
  kind: "mx" | "spf" | "dkim" | "dmarc" | "mta-sts";
  name: string;
  type: "MX" | "TXT";
  status: "ok" | "missing" | "wrong";
  expected: string;
  found: string[];
  detail: string | null;
}

export interface DomainCheck {
  domain: string;
  checkedAt: string;
  records: RecordCheck[];
}

export interface DomainRow {
  name: string;
  mailboxes: number;
  disabled: number;
  dns: DomainCheck | null;
}

export interface Mailbox {
  address: string;
  name: string | null;
  quota: number | null;
  aliases: string[];
  disabled: boolean;
}

export interface Domain {
  name: string;
  dkimSelector: string | null;
  mailboxes: Mailbox[];
  dns: DomainCheck | null;
}

export interface WebmailSession {
  address: string;
  hostname: string;
  name: string | null;
  accountId: string;
  capabilities: Record<string, unknown>;
  state: string;
}

export interface Device {
  id: string;
  description: string;
  createdAt?: string;
}

export interface NewDevice extends Device {
  secret: string;
  username: string;
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`, problem.code);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export type Call = <T>(path: string, init?: RequestInit) => Promise<T>;

// JMAP mail objects, with only the properties the webmail asks for.

export type MailboxRole = "inbox" | "drafts" | "sent" | "archive" | "junk" | "trash" | null;

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  role: MailboxRole;
  sortOrder: number;
  totalEmails: number;
  unreadEmails: number;
}

export interface Address {
  name: string | null;
  email: string;
}

export interface BodyPart {
  partId: string | null;
  blobId: string | null;
  size: number;
  name: string | null;
  type: string;
  cid: string | null;
  disposition: string | null;
}

export interface Email {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  from: Address[] | null;
  to: Address[] | null;
  cc: Address[] | null;
  replyTo: Address[] | null;
  subject: string | null;
  receivedAt: string;
  preview: string;
  hasAttachment: boolean;
  messageId?: string[] | null;
  references?: string[] | null;
}

export interface EmailBody extends Email {
  textBody: BodyPart[];
  htmlBody: BodyPart[];
  attachments: BodyPart[];
  bodyValues: Record<string, { value: string; isTruncated: boolean }>;
}

export interface MailIdentity {
  id: string;
  name: string;
  email: string;
}

type Invocation = [string, Record<string, unknown>, string];

export const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"];

/** One JMAP request; throws when any method answered with an error, naming it. */
export async function jmap(call: Call, methodCalls: Invocation[]): Promise<Record<string, Record<string, unknown>>> {
  const r = await call<{ methodResponses: Invocation[] }>("/api/v1/webmail/jmap", {
    method: "POST",
    body: JSON.stringify({ using: USING, methodCalls }),
  });
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, args, id] of r.methodResponses) {
    if (name === "error") throw new ApiError(`${String(args.type)}${args.description ? `: ${String(args.description)}` : ""}`, "jmap");
    out[id] = args;
  }
  return out;
}

export const EMAIL_LIST = ["id", "threadId", "mailboxIds", "keywords", "from", "to", "cc", "replyTo", "subject", "receivedAt", "preview", "hasAttachment"];
export const EMAIL_BODY = [...EMAIL_LIST, "messageId", "references", "textBody", "htmlBody", "attachments", "bodyValues"];
