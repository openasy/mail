import { Badge, Button, Callout, Dialog, EmptyState, IconButton, SearchInput, TextField, cn, formatBytes, useAgo, useLocalePreference } from "@openasy/ui";
import {
  Archive,
  ArrowLeft,
  Forward,
  Inbox,
  Mail,
  MailOpen,
  Paperclip,
  PenLine,
  RefreshCw,
  Reply,
  ReplyAll,
  Send,
  ShieldAlert,
  Star,
  Trash2,
  X,
  FileText,
  Folder as FolderIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ApiError,
  EMAIL_BODY,
  EMAIL_LIST,
  jmap,
  type Address,
  type BodyPart,
  type Call,
  type Email,
  type EmailBody,
  type Folder,
  type MailIdentity,
  type MailboxRole,
  type WebmailSession,
} from "./api.ts";
import { useT, type T } from "./i18n.ts";

const ROLE_ORDER: MailboxRole[] = ["inbox", "drafts", "sent", "archive", "junk", "trash"];
const ROLE_ICONS: Record<string, typeof Inbox> = { inbox: Inbox, drafts: FileText, sent: Send, archive: Archive, junk: ShieldAlert, trash: Trash2 };
const PAGE = 50;

const roleOf = (folders: Folder[], role: MailboxRole) => folders.find((f) => f.role === role);
const sortFolders = (folders: Folder[]) =>
  [...folders].sort((a, b) => {
    const ra = a.role ? ROLE_ORDER.indexOf(a.role) : 99;
    const rb = b.role ? ROLE_ORDER.indexOf(b.role) : 99;
    return ra - rb || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
  });

/** "Jane Doe" or the address when there is no name. */
const who = (a: Address | undefined) => (a ? a.name || a.email : "");
const list = (as: Address[] | null) => (as ?? []).map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ");

/** Addresses typed into a field: "Jane <jane@x.com>, ali@y.com"; the ones that are not an address are returned too. */
export function parseAddresses(text: string): { addresses: Address[]; invalid: string[] } {
  const addresses: Address[] = [];
  const invalid: string[] = [];
  for (const part of text
    .split(/[,;\n]/)
    .map((p) => p.trim())
    .filter(Boolean)) {
    const m = /^(?:"?([^"<]*?)"?\s*<([^>]+)>|([^\s<>]+))$/.exec(part);
    const email = (m?.[2] ?? m?.[3] ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid.push(part);
    else addresses.push({ name: m?.[1]?.trim() || null, email });
  }
  return { addresses, invalid };
}

/** The download address of a part of a message; the server always sends it as a download. */
export const partUrl = (p: BodyPart) =>
  `/api/v1/webmail/download/${encodeURIComponent(p.blobId ?? "")}?name=${encodeURIComponent(p.name ?? "attachment")}&type=${encodeURIComponent(p.type)}`;

/**
 * A message's HTML for a frame without scripts: links open in a new tab, pictures sent with the message are shown and
 * remote ones are left out (the page's policy blocks them), so the sender cannot see when it was read.
 */
export function framedHtml(html: string, parts: BodyPart[]): { html: string; remoteImages: boolean } {
  const byCid = new Map(parts.filter((p) => p.cid).map((p) => [p.cid!.replace(/^<|>$/g, ""), p]));
  const withCid = html.replace(/(["'(])cid:([^"')\s]+)/gi, (all, q: string, cid: string) => {
    const p = byCid.get(decodeURIComponent(cid));
    return p ? `${q}${partUrl(p)}` : all;
  });
  const remoteImages = /<img[^>]+src\s*=\s*["']?https?:/i.test(withCid) || /url\(\s*["']?https?:/i.test(withCid);
  const head =
    '<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src \'self\' data: blob:; style-src \'unsafe-inline\'; font-src data:"><base target="_blank"><style>body{margin:0;padding:12px 16px;font:14px/1.5 system-ui,sans-serif;color:#1f2328;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}img[src^="http:"],img[src^="https:"]{display:none}</style>';
  return { html: `<!doctype html><html><head>${head}</head><body>${withCid}</body></html>`, remoteImages };
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** The frame a message's HTML is shown in, as tall as the message. */
function MessageFrame({ html, title }: { html: string; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);
  const fit = () => {
    const doc = ref.current?.contentDocument;
    if (doc?.body) setHeight(Math.min(Math.max(doc.documentElement.scrollHeight, 120), 20_000));
  };
  // Without allow-scripts nothing in the message runs; allow-same-origin only lets this page measure its height.
  return (
    <iframe
      ref={ref}
      title={title}
      srcDoc={html}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      onLoad={fit}
      className="mail-frame"
      style={{ height }}
    />
  );
}

interface Draft {
  to: string;
  cc: string;
  subject: string;
  body: string;
  inReplyTo?: string[];
  references?: string[];
  attachments: Array<{ blobId: string; name: string; type: string; size: number }>;
}

const quoted = (e: EmailBody, text: string, t: T, locale: string) =>
  `\n\n${t("compose.wrote", { date: new Date(e.receivedAt).toLocaleString(locale), name: who(e.from?.[0]) })}\n${text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n")}`;

function bodyText(e: EmailBody): string {
  const text = e.textBody.map((p) => e.bodyValues[p.partId ?? ""]?.value ?? "").join("\n");
  if (text.trim()) return text;
  // Only HTML: its text, for quoting.
  const html = e.htmlBody.map((p) => e.bodyValues[p.partId ?? ""]?.value ?? "").join("\n");
  return new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
}

function Compose({
  call,
  session,
  folders,
  initial,
  onClose,
  onSent,
}: {
  call: Call;
  session: WebmailSession;
  folders: Folder[];
  initial: Draft;
  onClose: () => void;
  onSent: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(0);
  const file = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  async function attach(files: FileList | null) {
    for (const f of Array.from(files ?? [])) {
      if (f.size > 25 * 1024 * 1024) {
        setError(t("compose.tooLarge", { name: f.name }));
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const r = await call<{ blobId: string }>("/api/v1/webmail/upload", {
          method: "POST",
          body: f,
          headers: { "content-type": f.type || "application/octet-stream" },
        });
        setDraft((d) => ({
          ...d,
          attachments: [...d.attachments, { blobId: r.blobId, name: f.name, type: f.type || "application/octet-stream", size: f.size }],
        }));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  async function send() {
    const to = parseAddresses(draft.to);
    const cc = parseAddresses(draft.cc);
    const invalid = [...to.invalid, ...cc.invalid];
    if (invalid.length) return setError(t("compose.invalid", { list: invalid.join(", ") }));
    if (!to.addresses.length) return setError(t("compose.noRecipient"));
    const drafts = roleOf(folders, "drafts");
    const sent = roleOf(folders, "sent");
    if (!drafts || !sent) return setError(t("compose.noFolders"));
    setSending(true);
    setError(undefined);
    try {
      const ids = await jmap(call, [["Identity/get", { accountId: session.accountId }, "i"]]);
      const identities = (ids.i!.list as MailIdentity[]) ?? [];
      const identity = identities.find((i) => i.email.toLowerCase() === session.address) ?? identities[0];
      if (!identity) throw new ApiError(t("compose.noIdentity"));
      await jmap(call, [
        [
          "Email/set",
          {
            accountId: session.accountId,
            create: {
              draft: {
                mailboxIds: { [drafts.id]: true },
                keywords: { $draft: true, $seen: true },
                from: [{ name: identity.name || session.name, email: identity.email }],
                to: to.addresses,
                ...(cc.addresses.length && { cc: cc.addresses }),
                subject: draft.subject,
                ...(draft.inReplyTo && { inReplyTo: draft.inReplyTo, references: draft.references }),
                bodyValues: { body: { value: draft.body } },
                textBody: [{ partId: "body", type: "text/plain" }],
                attachments: draft.attachments.map((a) => ({ blobId: a.blobId, type: a.type, name: a.name, disposition: "attachment" })),
              },
            },
          },
          "e",
        ],
        [
          "EmailSubmission/set",
          {
            accountId: session.accountId,
            create: { send: { identityId: identity.id, emailId: "#draft" } },
            // Once it is sent, it leaves Drafts for Sent.
            onSuccessUpdateEmail: { "#send": { [`mailboxIds/${drafts.id}`]: null, [`mailboxIds/${sent.id}`]: true, "keywords/$draft": null } },
          },
          "s",
        ],
      ]);
      onSent();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      size="lg"
      title={t("compose.title")}
      description={t("compose.from", { address: session.address })}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      footer={
        <>
          <Button type="button" variant="ghost" icon={<Paperclip />} onClick={() => file.current?.click()} loading={uploading > 0}>
            {t("compose.attach")}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("compose.discard")}
          </Button>
          <Button type="submit" variant="primary" icon={<Send />} loading={sending} disabled={uploading > 0}>
            {t("compose.send")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && (
          <Callout tone="danger" title={t("compose.failed")}>
            {error}
          </Callout>
        )}
        <TextField
          label={t("compose.to")}
          value={draft.to}
          onChange={(e) => set({ to: e.target.value })}

          placeholder="jane@example.com, Ali <ali@example.org>"
        />
        <TextField label={t("compose.cc")} value={draft.cc} onChange={(e) => set({ cc: e.target.value })} />
        <TextField label={t("compose.subject")} value={draft.subject} onChange={(e) => set({ subject: e.target.value })} />
        <label className="flex flex-col gap-1.5 text-sm font-medium text-fg">
          {t("compose.body")}
          <textarea
            value={draft.body}
            onChange={(e) => set({ body: e.target.value })}

            rows={14}
            className="mail-textarea"
          />
        </label>
        <input ref={file} type="file" multiple hidden onChange={(e) => void attach(e.target.files).then(() => (e.target.value = ""))} />
        {draft.attachments.length > 0 && (
          <ul className="mail-list flex flex-wrap gap-2">
            {draft.attachments.map((a) => (
              <li key={a.blobId}>
                <Badge icon={<Paperclip className="size-3" />}>
                  {a.name} · {formatBytes(a.size)}
                  <button
                    type="button"
                    aria-label={t("compose.remove", { name: a.name })}
                    className="mail-chip-remove"
                    onClick={() => set({ attachments: draft.attachments.filter((x) => x.blobId !== a.blobId) })}
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

function Reader({
  call,
  session,
  email,
  folders,
  onBack,
  onChanged,
  onCompose,
}: {
  call: Call;
  session: WebmailSession;
  email: EmailBody;
  folders: Folder[];
  onBack: () => void;
  onChanged: (removed: boolean) => void;
  onCompose: (d: Draft) => void;
}) {
  const t = useT();
  const ago = useAgo();
  const [locale] = useLocalePreference();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const html = email.htmlBody.some((p) => p.type === "text/html")
    ? framedHtml(
        email.htmlBody
          .map((p) =>
            p.type === "text/html"
              ? (email.bodyValues[p.partId ?? ""]?.value ?? "")
              : `<pre>${escapeHtml(email.bodyValues[p.partId ?? ""]?.value ?? "")}</pre>`,
          )
          .join(""),
        [...email.attachments, ...email.htmlBody],
      )
    : null;
  const text = html ? "" : bodyText(email);
  const shown = email.attachments.filter((a) => a.disposition !== "inline" || !a.cid);
  const inFolder = (role: MailboxRole) => {
    const f = roleOf(folders, role);
    return !!f && email.mailboxIds[f.id] === true;
  };

  async function update(patch: Record<string, unknown>, removed: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      await jmap(call, [["Email/set", { accountId: session.accountId, update: { [email.id]: patch } }, "u"]]);
      onChanged(removed);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const moveTo = (role: MailboxRole) => {
    const f = roleOf(folders, role);
    if (f) void update({ mailboxIds: { [f.id]: true } }, true);
  };
  async function destroy() {
    setBusy(true);
    try {
      await jmap(call, [["Email/set", { accountId: session.accountId, destroy: [email.id] }, "d"]]);
      onChanged(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const subject = email.subject ?? "";
  const re = (prefix: string) => (subject.toLowerCase().startsWith(prefix.toLowerCase()) ? subject : `${prefix} ${subject}`);
  const thread = { inReplyTo: email.messageId ?? undefined, references: [...(email.references ?? []), ...(email.messageId ?? [])] };
  const quote = quoted(email, bodyText(email), t, locale);
  const replyTo = list(email.replyTo?.length ? email.replyTo : email.from);
  const others = [...(email.to ?? []), ...(email.cc ?? [])].filter((a) => a.email.toLowerCase() !== session.address);
  const flagged = email.keywords.$flagged === true;

  return (
    <article className="flex min-w-0 flex-col gap-4" aria-label={subject || t("mail.noSubject")}>
      <div className="flex flex-wrap items-center gap-1">
        <IconButton label={t("mail.back")} variant="ghost" onClick={onBack} className="mail-only-narrow">
          <ArrowLeft />
        </IconButton>
        <Button
          size="sm"
          variant="secondary"
          icon={<Reply />}
          onClick={() => onCompose({ to: replyTo, cc: "", subject: re("Re:"), body: quote, attachments: [], ...thread })}
        >
          {t("mail.reply")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<ReplyAll />}
          onClick={() => onCompose({ to: replyTo, cc: list(others), subject: re("Re:"), body: quote, attachments: [], ...thread })}
        >
          {t("mail.replyAll")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<Forward />}
          onClick={() =>
            onCompose({
              to: "",
              cc: "",
              subject: re("Fwd:"),
              body: quote,
              attachments: shown.filter((a) => a.blobId).map((a) => ({ blobId: a.blobId!, name: a.name ?? "attachment", type: a.type, size: a.size })),
            })
          }
        >
          {t("mail.forward")}
        </Button>
        <span className="flex-1" />
        <IconButton
          label={flagged ? t("mail.unflag") : t("mail.flag")}
          variant="ghost"
          disabled={busy}
          onClick={() => void update({ "keywords/$flagged": flagged ? null : true }, false)}
        >
          <Star className={cn(flagged && "mail-flagged")} />
        </IconButton>
        <IconButton label={t("mail.markUnread")} variant="ghost" disabled={busy} onClick={() => void update({ "keywords/$seen": null }, false)}>
          <Mail />
        </IconButton>
        {!inFolder("archive") && roleOf(folders, "archive") && (
          <IconButton label={t("mail.archive")} variant="ghost" disabled={busy} onClick={() => moveTo("archive")}>
            <Archive />
          </IconButton>
        )}
        {!inFolder("junk") && roleOf(folders, "junk") && (
          <IconButton label={t("mail.junk")} variant="ghost" disabled={busy} onClick={() => moveTo("junk")}>
            <ShieldAlert />
          </IconButton>
        )}
        {inFolder("trash") ? (
          <IconButton label={t("mail.deleteForever")} variant="ghost" disabled={busy} onClick={() => void destroy()}>
            <Trash2 />
          </IconButton>
        ) : (
          <IconButton label={t("mail.delete")} variant="ghost" disabled={busy} onClick={() => moveTo("trash")}>
            <Trash2 />
          </IconButton>
        )}
      </div>
      {error && (
        <Callout tone="danger" title={t("mail.failed")}>
          {error}
        </Callout>
      )}
      <header className="flex flex-col gap-1">
        <h2 className="m-0 text-lg font-semibold text-fg">{subject || t("mail.noSubject")}</h2>
        <p className="m-0 text-sm text-fg">
          <span className="font-medium">{who(email.from?.[0])}</span> <span className="text-fg-muted">&lt;{email.from?.[0]?.email}&gt;</span>
        </p>
        <p className="m-0 text-xs text-fg-muted">
          {t("mail.toLine", { list: list(email.to) })}
          {email.cc?.length ? ` · ${t("mail.ccLine", { list: list(email.cc) })}` : ""} ·{" "}
          <time dateTime={email.receivedAt} title={new Date(email.receivedAt).toLocaleString(locale)}>
            {ago(email.receivedAt)}
          </time>
        </p>
      </header>
      {html?.remoteImages && <p className="m-0 text-xs text-fg-muted">{t("mail.remoteImages")}</p>}
      {html ? (
        <MessageFrame html={html.html} title={subject || t("mail.noSubject")} />
      ) : (
        <pre className="m-0 whitespace-pre-wrap font-sans text-sm text-fg mail-wrap">{text}</pre>
      )}
      {shown.length > 0 && (
        <ul className="mail-list flex flex-wrap gap-2" aria-label={t("mail.attachments")}>
          {shown.map((a) => (
            <li key={a.partId ?? a.blobId}>
              <a href={partUrl(a)} download={a.name ?? undefined} className="mail-attachment">
                <Paperclip className="size-3.5" aria-hidden /> {a.name ?? t("mail.attachment")} <span className="text-fg-muted">{formatBytes(a.size)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function FolderLabel({ folder, t }: { folder: Folder; t: T }) {
  return <>{folder.role ? t(`folder.${folder.role}`) : folder.name}</>;
}

/** The person's mail: folders, the messages of one, and the one being read. */
export function Webmail({ call, session }: { call: Call; session: WebmailSession }) {
  const t = useT();
  const ago = useAgo();
  const [folders, setFolders] = useState<Folder[]>();
  const [folderId, setFolderId] = useState<string>();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [emails, setEmails] = useState<Email[]>();
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState<EmailBody>();
  const [compose, setCompose] = useState<Draft>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const accountId = session.accountId;

  const loadFolders = useCallback(async () => {
    const r = await jmap(call, [
      ["Mailbox/get", { accountId, properties: ["id", "name", "parentId", "role", "sortOrder", "totalEmails", "unreadEmails"] }, "m"],
    ]);
    const list = sortFolders(r.m!.list as Folder[]);
    setFolders(list);
    setFolderId((id) => id ?? list.find((f) => f.role === "inbox")?.id ?? list[0]?.id);
  }, [call, accountId]);

  /** The folder's messages from `position`; 0 starts the list again. */
  const loadEmails = useCallback(
    async (position = 0) => {
      if (!folderId) return;
      const filter = search ? { inMailbox: folderId, text: search } : { inMailbox: folderId };
      const r = await jmap(call, [
        [
          "Email/query",
          { accountId, filter, sort: [{ property: "receivedAt", isAscending: false }], collapseThreads: true, position, limit: PAGE, calculateTotal: true },
          "q",
        ],
        ["Email/get", { accountId, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: EMAIL_LIST }, "g"],
      ]);
      const got = r.g!.list as Email[];
      setTotal((r.q!.total as number) ?? got.length);
      setEmails((prev) => (position ? [...(prev ?? []), ...got] : got));
    },
    [call, accountId, folderId, search],
  );

  const refresh = useCallback(() => {
    void loadFolders().catch((e: Error) => setError(e.message));
    void loadEmails().catch((e: Error) => setError(e.message));
  }, [loadFolders, loadEmails]);

  useEffect(() => {
    void loadFolders().catch((e: Error) => setError(e.message));
  }, [loadFolders]);
  useEffect(() => {
    setEmails(undefined);
    void loadEmails().catch((e: Error) => setError(e.message));
  }, [loadEmails]);
  // New mail shows within half a minute.
  useEffect(() => {
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function read(e: Email) {
    setError(undefined);
    try {
      const r = await jmap(call, [
        [
          "Email/get",
          {
            accountId,
            ids: [e.id],
            properties: EMAIL_BODY,
            fetchHTMLBodyValues: true,
            fetchTextBodyValues: true,
            bodyProperties: ["partId", "blobId", "size", "name", "type", "cid", "disposition"],
          },
          "g",
        ],
        ...(e.keywords.$seen
          ? []
          : [["Email/set", { accountId, update: { [e.id]: { "keywords/$seen": true } } }, "s"] as [string, Record<string, unknown>, string]]),
      ]);
      const body = (r.g!.list as EmailBody[])[0];
      if (!body) return;
      setOpen({ ...body, keywords: { ...body.keywords, $seen: true } });
      if (!e.keywords.$seen) {
        setEmails((list) => list?.map((x) => (x.id === e.id ? { ...x, keywords: { ...x.keywords, $seen: true } } : x)));
        void loadFolders();
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const folder = folders?.find((f) => f.id === folderId);
  const unread = useMemo(() => roleOf(folders ?? [], "inbox")?.unreadEmails ?? 0, [folders]);
  useEffect(() => {
    document.title = unread ? `(${unread}) ${t("title")} · OpenAsy` : `${t("title")} · OpenAsy`;
  }, [unread, t]);

  const newDraft = (): Draft => ({ to: "", cc: "", subject: "", body: "", attachments: [] });

  let content: ReactNode;
  if (!folders) content = <p className="p-4 text-sm text-fg-muted">{t("mail.loading")}</p>;
  else
    content = (
      <div className={cn("mail-layout", open && "mail-reading")}>
        <nav aria-label={t("mail.folders")} className={"mail-folders flex flex-col gap-1"}>
          <Button variant="primary" icon={<PenLine />} onClick={() => setCompose(newDraft())} className="mb-2">
            {t("mail.compose")}
          </Button>
          <ul className="mail-list flex flex-col gap-0.5">
            {folders.map((f) => {
              const Icon = (f.role && ROLE_ICONS[f.role]) || FolderIcon;
              const active = f.id === folderId;
              return (
                <li key={f.id}>
                  <button
                    type="button"
                    aria-current={active ? "page" : undefined}
                    onClick={() => {
                      setFolderId(f.id);
                      setOpen(undefined);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm",
                      "mail-folder",
                      active && "mail-active",
                      f.parentId && "mail-child",
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden />
                    <span className="flex-1 truncate">
                      <FolderLabel folder={f} t={t} />
                    </span>
                    {f.unreadEmails > 0 && f.role !== "sent" && f.role !== "trash" && (
                      <span className="text-xs font-semibold text-accent">{f.unreadEmails}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <section
          aria-label={folder ? (folder.role ? t(`folder.${folder.role}`) : folder.name) : t("mail.messages")}
          className={"mail-messages flex min-w-0 flex-col gap-2"}
        >
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(query.trim());
            }}
          >
            <SearchInput label={t("mail.search")} placeholder={t("mail.search")} value={query} onChange={(e) => setQuery(e.target.value)} className="flex-1" />
            {search && (
              <IconButton type="button" label={t("mail.clearSearch")} variant="ghost" onClick={() => (setQuery(""), setSearch(""))}>
                <X />
              </IconButton>
            )}
            <IconButton type="button" label={t("mail.refresh")} variant="ghost" onClick={refresh}>
              <RefreshCw />
            </IconButton>
          </form>
          {!emails ? (
            <p className="p-2 text-sm text-fg-muted">{t("mail.loading")}</p>
          ) : emails.length === 0 ? (
            <EmptyState icon={<MailOpen />} title={search ? t("mail.noResults") : t("mail.empty")} />
          ) : (
            <ul className="mail-list mail-rows">
              {emails.map((e) => {
                const seen = e.keywords.$seen === true;
                const sentFolder = folder?.role === "sent" || folder?.role === "drafts";
                return (
                  <li key={e.id}>
                    <button
                      type="button"
                      onClick={() => void read(e)}
                      aria-current={open?.id === e.id ? "true" : undefined}
                      className={cn("flex w-full flex-col gap-0.5 px-3 py-2 text-left", "mail-row", open?.id === e.id && "mail-active")}
                    >
                      <span className="flex items-baseline gap-2">
                        {!seen && <span className="size-2 shrink-0 rounded-full bg-accent" aria-label={t("mail.unread")} />}
                        <span className={cn("flex-1 truncate text-sm", seen ? "text-fg" : "font-semibold text-fg")}>
                          {sentFolder ? t("mail.toLine", { list: (e.to ?? []).map(who).join(", ") }) : who(e.from?.[0])}
                        </span>
                        <time dateTime={e.receivedAt} className="shrink-0 text-xs text-fg-muted">
                          {ago(e.receivedAt)}
                        </time>
                      </span>
                      <span className={cn("flex items-center gap-1 truncate text-sm", seen ? "text-fg-muted" : "font-medium text-fg")}>
                        {e.keywords.$flagged && <Star className="size-3 shrink-0 mail-flagged" aria-label={t("mail.flagged")} />}
                        {e.hasAttachment && <Paperclip className="size-3 shrink-0" aria-label={t("mail.attachment")} />}
                        <span className="truncate">{e.subject || t("mail.noSubject")}</span>
                      </span>
                      <span className="mail-clamp text-xs text-fg-muted">{e.preview}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {emails && emails.length < total && (
            <Button variant="ghost" size="sm" onClick={() => void loadEmails(emails.length).catch((err: Error) => setError(err.message))}>
              {t("mail.more", { count: total - emails.length })}
            </Button>
          )}
        </section>

        <div className={"mail-reader min-w-0"}>
          {open ? (
            <Reader
              key={open.id}
              call={call}
              session={session}
              email={open}
              folders={folders}
              onBack={() => setOpen(undefined)}
              onCompose={setCompose}
              onChanged={(removed) => {
                if (removed) setOpen(undefined);
                else void read(open);
                refresh();
              }}
            />
          ) : (
            <EmptyState icon={<Mail />} title={t("mail.pick")} />
          )}
        </div>
      </div>
    );

  return (
    <>
      {error && (
        <Callout tone="danger" title={t("mail.failed")} onDismiss={() => setError(undefined)} className="mb-3">
          {error}
        </Callout>
      )}
      {notice && <Callout tone="success" title={notice} onDismiss={() => setNotice(undefined)} className="mb-3" />}
      {content}
      {compose && folders && (
        <Compose
          call={call}
          session={session}
          folders={folders}
          initial={compose}
          onClose={() => setCompose(undefined)}
          onSent={() => {
            setCompose(undefined);
            setNotice(t("compose.sent"));
            refresh();
          }}
        />
      )}
    </>
  );
}
