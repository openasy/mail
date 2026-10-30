# mail

[![CI](https://github.com/openasy/mail/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/mail/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Mail product: your company's email on your own server. A webmail of our own,
device passwords for mail apps, and the administration of domains and mailboxes from a file, on
[Stalwart](https://stalw.art), the open-source mail server that receives, stores and sends the mail.

```
mail.yaml ──▶ mail ── JMAP (management) ──▶ Stalwart ◀── SMTP ── other mail servers
               │  ▲                            ▲
   webmail ────┘  └── JMAP, as the person ─────┘◀── IMAP, SMTP ── Outlook, Thunderbird, phones
```

Mail keeps no mail. It talks to Stalwart over JMAP only: with a service account to keep the server in step with the
file, and as the signed-in person, by impersonation, to read and send their mail. People never give Mail a mail
password, and Stalwart's management methods are never passed on from the webmail.

## Domains and mailboxes

List them in the domains file, `/config/mail.yaml` (`MAIL_CONFIG`):

```yaml
domains:
  - name: example.com
    dkimSelector: mail
    mailboxes:
      - { address: jane@example.com, name: Jane Doe, quota: 5GB, aliases: [sales@example.com] }
      - { address: former@example.com, disabled: true }
```

The file is the only way in: no screen and no API route adds, changes or removes a domain or a mailbox, so the list can
live in git and be reviewed like code. It is read at start and again within a minute of a change, and applied whole or
not at all. A file with a mistake leaves the last good version in place, and the log and the Domains page say which
domain and field to fix.

| Field | | |
| --- | --- | --- |
| `name` | required | The domain, such as `example.com` |
| `dkimSelector` | | The selector Stalwart signs this domain's mail with, so its DKIM record is checked too |
| `mailboxes[].address` | required | In the domain it is listed under. People sign in to the webmail with it |
| `mailboxes[].name` | | Shown as the sender |
| `mailboxes[].quota` | no limit | Such as `5GB` or `500MB` |
| `mailboxes[].aliases` | | Other addresses delivered to this mailbox, in any domain of the file |
| `mailboxes[].disabled` | `false` | `true`: it can no longer sign in, send or receive; its mail is kept |

After every change, and every five minutes, Mail brings Stalwart in step: it creates the domains and an account for each
mailbox, updates names, aliases and quotas, and disables accounts in the file's domains that the file no longer lists.
Nothing is deleted; an admin deletes an account and its mail in Stalwart when it is no longer needed. Accounts in other
domains are left alone.

## DNS

The Domains page reads each domain's records from public DNS every six hours, or on request, and shows a value to copy
for each one that is missing or wrong:

| Record | Where | For |
| --- | --- | --- |
| MX | the domain | Other servers deliver its mail to `MAIL_HOSTNAME` |
| SPF | the domain | Receivers know this server may send for it (`v=spf1 mx -all`) |
| DKIM | `<selector>._domainkey` | Receivers can check the signature; the key is in Stalwart's admin |
| DMARC | `_dmarc` | What receivers do with mail that fails SPF and DKIM |
| MTA-STS | `_mta-sts` | Other servers deliver over TLS only |

Delivery also depends on the server's address: it needs a reverse DNS name (PTR) matching `MAIL_HOSTNAME`, and port 25
open for outgoing mail. Many cloud providers block it; then set a relay for outgoing mail in Stalwart.

## Run

```bash
openssl rand -hex 32 > openasy-kek
printf '%s' "$(openssl rand -base64 24)" > stalwart-password
$EDITOR config/mail.yaml   # your domains and mailboxes
docker compose up -d stalwart
```

The first time, finish Stalwart's own setup in its admin on https://localhost:8443 (the log of `stalwart` shows its
first password): its host name, which is `MAIL_HOSTNAME`, and its TLS certificate. Then create the account Mail uses,
`openasy`, with the password in `stalwart-password` and the administrator role, which includes the `impersonate`
permission. Then start Mail:

```bash
docker compose up -d mail
docker compose logs mail | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013). Mail is on
http://localhost:8080; put it behind TLS. Everyone with a mailbox signs in with the same address: through your identity
provider with `OPENASY_OIDC_DEFAULT_ROLE=user`, or invited as members with the user role. `openasy-kek` encrypts sign-in
secrets in Mail's database (ADR 0021): keep it apart from the volume and with your backups. Back up Stalwart's volume:
it holds every mailbox.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `MAIL_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy |
| `MAIL_HOSTNAME` | `MAIL_PUBLIC_URL`'s host | The name other mail servers and mail apps reach Stalwart at |
| `MAIL_CONFIG` | `/config/mail.yaml` | The domains file |
| `MAIL_STALWART_URL` | `http://stalwart:8080` | Where Mail reaches Stalwart's HTTP listener |
| `MAIL_STALWART_USER` | `openasy` | The service account; it needs the `impersonate` permission |
| `MAIL_STALWART_PASSWORD_FILE` | `/run/secrets/stalwart-password` | Its password, or `MAIL_STALWART_PASSWORD` |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher. Give every product the same value |
| `MAIL_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key |
| `MAIL_DB` | `/data/mail.db` | SQLite file (WAL), on the `/data` volume |
| `MAIL_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `MAIL_HEADLESS` | `false` | `true` serves only the API |
| `MAIL_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`.

## The webmail

Folders, threads, search, reading, writing with attachments, replying and forwarding. A message's HTML is shown in a
frame where nothing runs, and pictures from other sites are not loaded, so a sender cannot tell when it was read.
Attachments are always downloads. Under Devices, people make a password for each mail app (Outlook, Thunderbird, a
phone), shown once, and remove it when the device is gone.

## Roles

Users read and send their own mail and manage their own device passwords. Viewers also see the domains, mailboxes, DNS
checks and syncs; editors also check DNS on request; admins also sync on request and manage members and API tokens
(ADR 0003). API tokens never read anyone's mail.

## Coming next

Calendars and contacts (CalDAV, CardDAV), shared mailboxes, distribution lists, the delivery queue and DMARC reports on
the Domains page, and filters and out-of-office replies in the webmail.

## Develop

```bash
npm install
npm test        # the domains file, the sync, DNS checks, the webmail's limits and every API response against openapi.json
npm run dev     # the UI, with the API on :8080
```

Tests run against a mail server in memory (`server/fake-stalwart.ts`) that answers the JMAP calls Mail makes.

## Licence

AGPL-3.0 (ADR 0008). Stalwart is AGPL-3.0 too; Mail uses only its open-source edition.
