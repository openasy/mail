// Prometheus text exposition, written by hand: a few lines, no client library needed.
const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface Gauges {
  domains: number;
  mailboxes: number;
  /** Whether the last sync with the mail server worked, or null before the first. */
  syncOk: boolean | null;
  /** DNS records that are missing or wrong, over all domains. */
  dnsProblems: number;
  /** 1 when the domains file on disk could not be applied and an older version is in use. */
  fileError: boolean;
}

export function renderMetrics(version: string, g: Gauges): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="mail",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_mail_domains Domains in the domains file.",
    "# TYPE openasy_mail_domains gauge",
    `openasy_mail_domains ${g.domains}`,
    "# HELP openasy_mail_mailboxes Mailboxes in the domains file.",
    "# TYPE openasy_mail_mailboxes gauge",
    `openasy_mail_mailboxes ${g.mailboxes}`,
    "# HELP openasy_mail_sync_ok 1 when the mail server was last brought in step with the file, 0 when that failed.",
    "# TYPE openasy_mail_sync_ok gauge",
    ...(g.syncOk === null ? [] : [`openasy_mail_sync_ok ${g.syncOk ? 1 : 0}`]),
    "# HELP openasy_mail_dns_problems DNS records that are missing or wrong, over all domains.",
    "# TYPE openasy_mail_dns_problems gauge",
    `openasy_mail_dns_problems ${g.dnsProblems}`,
    "# HELP openasy_mail_config_error 1 when the domains file could not be applied and its last good version is in use.",
    "# TYPE openasy_mail_config_error gauge",
    `openasy_mail_config_error ${g.fileError ? 1 : 0}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
