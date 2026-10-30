import {
  AppShell,
  Badge,
  BrandProvider,
  Button,
  Callout,
  DataTable,
  Dialog,
  EmptyState,
  IconButton,
  KpiCard,
  KpiGrid,
  navigate,
  PageHeader,
  Panel,
  PRODUCT_IDS,
  StatusBadge,
  TextField,
  formatBytes,
  toLocale,
  usePath,
  useAgo,
  useLocalePreference,
  useThemePreference,
  type Column,
  type ProductId,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import { CheckCircle2, Globe, KeyRound, LogIn, LogOut, Mail, MailX, RefreshCw, Smartphone, Trash2, UserRound, Users } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  api,
  ApiError,
  MfaSetupRequired,
  Unauthorized,
  type Call,
  type Device,
  type Domain,
  type DomainCheck,
  type DomainRow,
  type NewDevice,
  type ProductLink,
  type RecordCheck,
  type Summary,
  type SyncResult,
  type WebmailSession,
  type ConfigFile,
} from "./api.ts";
import { useT, type T } from "./i18n.ts";
import { Webmail } from "./Webmail.tsx";

const PAGES = ["devices", "domains", "account", "members", "signin", "tokens", "about"] as const;
type Route = { page: "mail" | (typeof PAGES)[number] } | { page: "domain"; name: string };
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = ["mail", ...PAGES];
function parseRoute(path: string): Route {
  const [page, name] = path.replace(/^\//, "").split("/");
  if (page === "domains" && name) return { page: "domain", name: decodeURIComponent(name) };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as (typeof PAGES)[number] };
  return { page: "mail" };
}

/** Data loading with the session; when it ends, the sign-in screen comes back. */
function useApi(): Call {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      try {
        return await api<T>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}

function Code({ children }: { children: ReactNode }) {
  return <pre className="m-0 overflow-x-auto rounded-md bg-subtle px-2.5 py-2 font-mono text-xs text-fg mail-wrap whitespace-pre-wrap">{children}</pre>;
}

// ---------------------------------------------------------------- Devices

function DevicesPage({ call, session }: { call: Call; session: WebmailSession }) {
  const t = useT();
  const [devices, setDevices] = useState<Device[]>();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [made, setMade] = useState<NewDevice>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void call<{ devices: Device[] }>("/api/v1/devices").then(
      (r) => setDevices(r.devices),
      (e: Error) => setError(e.message),
    );
  }, [call]);
  useEffect(load, [load]);

  async function add() {
    setBusy(true);
    setError(undefined);
    try {
      const d = await call<NewDevice>("/api/v1/devices", { method: "POST", body: JSON.stringify({ name }) });
      setMade(d);
      setAdding(false);
      setName("");
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(d: Device) {
    try {
      await call(`/api/v1/devices/${encodeURIComponent(d.id)}`, { method: "DELETE" });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const columns: Column<Device>[] = [
    { id: "name", header: t("devices.name"), cell: (d) => d.description, sortValue: (d) => d.description },
    {
      id: "remove",
      header: "",
      align: "right",
      cell: (d) => (
        <IconButton label={t("devices.remove", { name: d.description })} variant="ghost" size="sm" onClick={() => void remove(d)}>
          <Trash2 />
        </IconButton>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={t("devices.title")}
        description={t("devices.description")}
        actions={
          <Button variant="primary" icon={<Smartphone />} onClick={() => setAdding(true)}>
            {t("devices.add")}
          </Button>
        }
      />
      {error && (
        <Callout tone="danger" title={t("devices.failed")} onDismiss={() => setError(undefined)} className="mb-3">
          {error}
        </Callout>
      )}
      <div className="mail-side">
        <DataTable label={t("devices.title")} columns={columns} rows={devices ?? []} getRowId={(d) => d.id} loading={!devices} empty={t("devices.none")} />
        <Panel title={t("devices.settings")} description={t("devices.settingsDetail")}>
          <dl className="mail-settings m-0 text-sm">
            <dt className="text-fg-muted">{t("devices.username")}</dt>
            <dd className="m-0 font-mono text-xs mail-wrap">{session.address}</dd>
            <dt className="text-fg-muted">IMAP</dt>
            <dd className="m-0 font-mono text-xs mail-wrap">{session.hostname}:993 (SSL/TLS)</dd>
            <dt className="text-fg-muted">SMTP</dt>
            <dd className="m-0 font-mono text-xs mail-wrap">{session.hostname}:465 (SSL/TLS)</dd>
          </dl>
        </Panel>
      </div>
      <Dialog
        open={adding}
        onOpenChange={setAdding}
        title={t("devices.add")}
        description={t("devices.addDetail")}
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setAdding(false)}>
              {t("devices.cancel")}
            </Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
              {t("devices.make")}
            </Button>
          </>
        }
      >
        <TextField label={t("devices.name")} hint={t("devices.nameHint")} value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
      </Dialog>
      <Dialog
        open={!!made}
        onOpenChange={(open) => !open && setMade(undefined)}
        icon={<CheckCircle2 />}
        iconTone="success"
        title={t("devices.made", { name: made?.description ?? "" })}
        description={t("devices.madeDetail")}
        footer={
          <Button variant="primary" onClick={() => setMade(undefined)}>
            {t("devices.done")}
          </Button>
        }
      >
        {made && (
          <div className="flex flex-col gap-2 text-sm">
            <span className="text-fg-muted">{t("devices.username")}</span>
            <Code>{made.username}</Code>
            <span className="text-fg-muted">{t("devices.password")}</span>
            <Code>{made.secret}</Code>
          </div>
        )}
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------- Domains

const tone = { ok: "success", missing: "danger", wrong: "warning" } as const;

function dnsBadge(dns: DomainCheck | null, t: T) {
  if (!dns) return <Badge>{t("dns.notChecked")}</Badge>;
  const bad = dns.records.filter((r) => r.status !== "ok").length;
  return bad ? <StatusBadge tone="warning">{t("dns.problems", { count: bad })}</StatusBadge> : <StatusBadge tone="success">{t("dns.allGood")}</StatusBadge>;
}

function FileCallout({ file, t }: { file: ConfigFile; t: T }) {
  if (!file) return null;
  if (file.error)
    return (
      <Callout tone="warning" title={t("file.error")} className="mb-3">
        <span className="mail-wrap">{file.error}</span>
      </Callout>
    );
  return null;
}

function SyncPanel({ call, sync, onSynced }: { call: Call; sync: SyncResult | null; onSynced: () => void }) {
  const t = useT();
  const ago = useAgo();
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function run() {
    setBusy(true);
    setError(undefined);
    try {
      await call<SyncResult>("/api/v1/sync", { method: "POST" });
      onSynced();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel
      title={t("sync.title")}
      description={t("sync.description")}
      actions={
        can("admin") && (
          <Button size="sm" icon={<RefreshCw />} loading={busy} onClick={() => void run()}>
            {t("sync.now")}
          </Button>
        )
      }
    >
      {error && <p className="m-0 mb-2 text-sm text-danger">{error}</p>}
      {!sync ? (
        <p className="m-0 text-sm text-fg-muted">{t("sync.never")}</p>
      ) : sync.ok ? (
        <p className="m-0 text-sm text-fg">
          <StatusBadge tone="success">{t("sync.ok")}</StatusBadge> <span className="text-fg-muted">{ago(sync.at)}</span>
          {(sync.created.length > 0 || sync.updated.length > 0 || sync.disabled.length > 0) && (
            <span className="mt-1 block text-xs text-fg-muted">
              {t("sync.changed", { created: sync.created.length, updated: sync.updated.length, disabled: sync.disabled.length })}
            </span>
          )}
        </p>
      ) : (
        <div className="flex flex-col gap-1 text-sm">
          <span>
            <StatusBadge tone="danger">{t("sync.failed")}</StatusBadge> <span className="text-fg-muted">{ago(sync.at)}</span>
          </span>
          <span className="text-fg-muted mail-wrap">{sync.error}</span>
        </div>
      )}
    </Panel>
  );
}

function DomainsPage({ call }: { call: Call }) {
  const t = useT();
  const [data, setData] = useState<{ domains: DomainRow[]; file: ConfigFile }>();
  const [summary, setSummary] = useState<Summary>();
  const load = useCallback(() => {
    void call<{ domains: DomainRow[]; file: ConfigFile }>("/api/v1/domains").then(setData, () => {});
    void call<Summary>("/api/v1/summary").then(setSummary, () => {});
  }, [call]);
  useEffect(load, [load]);

  const columns: Column<DomainRow>[] = [
    { id: "name", header: t("domains.domain"), cell: (d) => <a href={`/domains/${encodeURIComponent(d.name)}`}>{d.name}</a>, sortValue: (d) => d.name },
    { id: "mailboxes", header: t("domains.mailboxes"), align: "right", cell: (d) => d.mailboxes, sortValue: (d) => d.mailboxes },
    { id: "disabled", header: t("domains.disabled"), align: "right", cell: (d) => d.disabled || "–", sortValue: (d) => d.disabled },
    { id: "dns", header: t("domains.dns"), cell: (d) => dnsBadge(d.dns, t) },
  ];

  return (
    <>
      <PageHeader title={t("domains.title")} description={t("domains.description")} />
      <FileCallout file={data?.file ?? null} t={t} />
      {summary && (
        <KpiGrid className="mail-gap-below">
          <KpiCard label={t("domains.title")} value={summary.domains} icon={Globe} />
          <KpiCard label={t("domains.mailboxes")} value={summary.mailboxes} icon={Mail} />
          <KpiCard label={t("domains.disabled")} value={summary.disabled} icon={MailX} />
          <KpiCard label={t("domains.dnsProblems")} value={summary.dnsProblems} icon={KeyRound} />
        </KpiGrid>
      )}
      <div className="mail-side">
        {data && data.domains.length === 0 ? (
          <EmptyState icon={<Globe />} title={t("domains.none")}>
            {t("domains.noneDetail")}
            <Code>{"domains:\n  - name: example.com\n    mailboxes:\n      - { address: jane@example.com, name: Jane Doe, quota: 5GB }"}</Code>
          </EmptyState>
        ) : (
          <DataTable
            label={t("domains.title")}
            columns={columns}
            rows={data?.domains ?? []}
            getRowId={(d) => d.name}
            loading={!data}
            onRowClick={(d) => navigate(`/domains/${encodeURIComponent(d.name)}`)}
          />
        )}
        <div className="flex flex-col gap-4">
          <SyncPanel call={call} sync={summary?.sync ?? null} onSynced={load} />
          {summary && (
            <Panel title={t("domains.server")}>
              <p className="m-0 text-sm text-fg-muted">{t("domains.serverDetail")}</p>
              <Code>{summary.hostname}</Code>
              {data?.file && <p className="m-0 mt-2 text-xs text-fg-muted mail-wrap">{t("file.path", { path: data.file.path })}</p>}
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}

function DomainPage({ call, name }: { call: Call; name: string }) {
  const t = useT();
  const ago = useAgo();
  const { can } = useAuth();
  const [domain, setDomain] = useState<Domain>();
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const load = useCallback(() => {
    void call<Domain>(`/api/v1/domains/${encodeURIComponent(name)}`).then(setDomain, (e: Error) => setError(e.message));
  }, [call, name]);
  useEffect(load, [load]);

  async function check() {
    setChecking(true);
    try {
      const dns = await call<DomainCheck>(`/api/v1/domains/${encodeURIComponent(name)}/dns`, { method: "POST" });
      setDomain((d) => d && { ...d, dns });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  }

  if (error && !domain) return <EmptyState title={error} />;
  const records: Column<RecordCheck>[] = [
    { id: "kind", header: t("dns.record"), cell: (r) => <span className="font-medium">{t(`dns.kind.${r.kind}`)}</span> },
    { id: "name", header: t("dns.name"), cell: (r) => <span className="font-mono text-xs mail-wrap">{`${r.type} ${r.name}`}</span> },
    { id: "status", header: t("dns.status"), cell: (r) => <StatusBadge tone={tone[r.status]}>{t(`dns.${r.status}`)}</StatusBadge> },
    {
      id: "value",
      header: t("dns.value"),
      cell: (r) =>
        r.status === "ok" ? (
          <span className="font-mono text-xs mail-wrap">{r.found.join(" · ")}</span>
        ) : (
          <div className="flex flex-col gap-1">
            {r.detail && <span className="text-xs">{r.detail}</span>}
            <span className="text-xs text-fg-muted">{t("dns.set")}</span>
            <Code>{r.expected}</Code>
          </div>
        ),
    },
  ];
  const mailboxes: Column<Domain["mailboxes"][number]>[] = [
    { id: "address", header: t("mailbox.address"), cell: (m) => <span className="mail-wrap">{m.address}</span>, sortValue: (m) => m.address },
    { id: "name", header: t("mailbox.name"), cell: (m) => m.name ?? "–", sortValue: (m) => m.name ?? "" },
    { id: "aliases", header: t("mailbox.aliases"), cell: (m) => (m.aliases.length ? <span className="text-xs mail-wrap">{m.aliases.join(", ")}</span> : "–") },
    {
      id: "quota",
      header: t("mailbox.quota"),
      align: "right",
      cell: (m) => (m.quota ? formatBytes(m.quota) : t("mailbox.noQuota")),
      sortValue: (m) => m.quota ?? Infinity,
    },
    {
      id: "status",
      header: t("mailbox.status"),
      cell: (m) =>
        m.disabled ? <StatusBadge tone="neutral">{t("mailbox.disabled")}</StatusBadge> : <StatusBadge tone="success">{t("mailbox.active")}</StatusBadge>,
    },
  ];

  return (
    <>
      <PageHeader
        title={name}
        breadcrumbs={[{ label: t("domains.title"), href: "/domains" }, { label: name }]}
        description={t("domain.description")}
        meta={domain && dnsBadge(domain.dns, t)}
      />
      <div className="flex flex-col gap-4">
        <Panel
          title={t("dns.title")}
          description={domain?.dns ? t("dns.checked", { when: ago(domain.dns.checkedAt) }) : t("dns.description")}
          actions={
            can("editor") && (
              <Button size="sm" icon={<RefreshCw />} loading={checking} onClick={() => void check()}>
                {t("dns.check")}
              </Button>
            )
          }
          flush
        >
          {domain?.dns ? (
            <DataTable label={t("dns.title")} columns={records} rows={domain.dns.records} getRowId={(r) => r.kind} resizable={false} columnMenu={false} />
          ) : (
            <p className="m-0 p-4 text-sm text-fg-muted">{t("dns.notChecked")}</p>
          )}
        </Panel>
        {domain && !domain.dkimSelector && (
          <Callout tone="info" title={t("dns.noSelector")}>
            {t("dns.noSelectorDetail")}
          </Callout>
        )}
        <DataTable
          label={t("domains.mailboxes")}
          columns={mailboxes}
          rows={domain?.mailboxes ?? []}
          getRowId={(m) => m.address}
          loading={!domain}
          empty={t("domain.noMailboxes")}
          pageSize={50}
        />
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Shell

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function SettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("settings.adminsOnly")}>{t("settings.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`settings.${page}`)}
        description={t(`settings.${page}Detail`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("settings.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

/** Someone signed in without a mailbox of their own, such as an admin who only manages Mail. */
function NoMailbox({ message, admin }: { message: string; admin: boolean }) {
  const t = useT();
  return (
    <EmptyState
      icon={<MailX />}
      title={t("mail.noMailbox")}
      action={
        admin && (
          <Button variant="secondary" onClick={() => navigate("/domains")}>
            {t("mail.toDomains")}
          </Button>
        )
      }
    >
      {message}
    </EmptyState>
  );
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can } = useAuth();
  const account = useAccountMenu();
  const route = parseRoute(usePath());
  const call = useApi();
  const [session, setSession] = useState<WebmailSession>();
  const [sessionError, setSessionError] = useState<string>();
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);

  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) => setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "mail" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
    void call<WebmailSession>("/api/v1/webmail/session").then(setSession, (e: Error) => setSessionError(e instanceof ApiError ? e.message : String(e)));
  }, [call]);

  const manager = can("viewer");
  const nav = [
    { id: "mail", label: msg("nav.mail"), icon: Mail },
    { id: "devices", label: msg("nav.devices"), icon: Smartphone },
    ...(manager ? [{ id: "domains", label: msg("nav.domains"), icon: Globe }] : []),
  ];
  const footerNav = [
    ...(can("admin")
      ? [
          { id: "members", label: msg("nav.members"), icon: Users },
          { id: "signin", label: msg("nav.signIn"), icon: LogIn },
          { id: "tokens", label: msg("nav.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("nav.account"), icon: UserRound },
  ];
  const active = route.page === "domain" ? "domains" : route.page;
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);
  const needsMailbox = (page: ReactNode) =>
    session ? page : sessionError ? <NoMailbox message={sessionError} admin={manager} /> : <p className="text-sm text-fg-muted">{msg("mail.loading")}</p>;

  return (
    <AppShell
      product="mail"
      about={colophon}
      nav={nav}
      activeNav={active}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      user={{ name: me.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {route.page === "mail" ? (
        needsMailbox(session && <Webmail call={call} session={session} />)
      ) : route.page === "devices" ? (
        needsMailbox(session && <DevicesPage call={call} session={session} />)
      ) : route.page === "domains" && manager ? (
        <DomainsPage call={call} />
      ) : route.page === "domain" && manager ? (
        <DomainPage key={route.name} call={call} name={route.name} />
      ) : route.page === "account" || route.page === "members" || route.page === "signin" || route.page === "tokens" ? (
        <SettingsPage page={route.page} />
      ) : (
        <EmptyState title={msg("settings.adminsOnly")}>{msg("settings.askAnAdmin")}</EmptyState>
      )}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Mail">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
