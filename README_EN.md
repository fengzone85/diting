<h1 align="center">
  <img src="server/public/logo.png" width="120" alt="Diting">
  <br>Diting
</h1>

<p align="center">
  <strong>Self-hosted VPS monitoring · zero inbound on agents · no command channel</strong><br>
  <sub>Vue3 SPA · audit log · AI daily report · theme market · Komari theme compatibility · designed for 100 agents</sub><br>
  <a href="README.md">中文</a> · <a href="https://fengzone85.github.io/diting/">Docs</a> · <a href="https://github.com/fengzone85/diting/issues">Issues</a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/fengzone85/diting?style=flat-square&color=4ea5d9" alt="version">
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="license">
  <img src="https://img.shields.io/github/actions/workflow/status/fengzone85/diting/test.yml?branch=master&label=tests&style=flat-square" alt="tests">
  <img src="https://img.shields.io/badge/Node.js-22-339933?style=flat-square&logo=node.js" alt="node">
  <img src="https://img.shields.io/badge/SQLite-3-003b57?style=flat-square&logo=sqlite" alt="sqlite">
  <img src="https://img.shields.io/badge/Go-1.22-00ADD8?style=flat-square&logo=go" alt="go">
  <img src="https://img.shields.io/badge/Linux-Docker-2496ED?style=flat-square&logo=docker" alt="linux">
  <img src="https://img.shields.io/badge/Windows-native-0078D4?style=flat-square&logo=windows" alt="windows">
</p>

---

**Diting** is a self-hosted VPS monitoring panel: every monitored host runs a single-binary Go agent that only
makes outbound HTTPS reports — **no inbound port is opened and no server command is ever accepted**. The server
renders a Vue3 admin UI on Node.js + SQLite, and ships alerting, audit logging, an AI daily report, billing and
expiry tracking, backup/restore, and a compatibility layer for Komari community themes.

## ✨ Highlights

<table>
<tr>
<td width="50%">

### 🔒 Security first
- **Zero inbound on agents** — no listening port; NAT/internal networks unaffected
- **No command channel** — Agent → Server one-way flow; the server cannot control agents
- **Audit log** — every admin write is recorded and replayable
- **Signed session cookie** — replaces plaintext token storage in the browser (anti-XSS)
- **TOTP two-factor** — dangerous actions need a one-time code
- **Strict CSP** — no `unsafe-inline`, no external scripts (third-party themes get a one-time nonce)
- **Constant-time token comparison** — no timing side channel
- **IP allowlist** — IPv4/IPv6/CIDR
- **Signed release chain** — agent artifacts ship `sha256` + ed25519 `.sig`; the relay forwards only after verifying</td>

<td width="50%">

### 📊 Monitoring & alerting
- **Live metrics** — CPU/memory/disk/load/traffic/temperature/Swap, multi-disk aggregated
- **Network quality probes** — latency + loss + HTTP/TLS certificate expiry, against fixed public targets
- **Two-tier history** — hourly rollups + weighted merge reads; a 30-day window no longer explodes the DB
- **Capacity fuse** — row/DB-size dual watermark; at the limit only detail ingestion stops
- **AI daily report** — scheduled server-side summary of yesterday's anomalies
- **Monthly traffic** — persisted, survives restarts and month boundaries
- **Billing & expiry** — monthly/quarterly/yearly, auto-renew, batch renew
- **Alerts** — QQ Mail + Telegram + Webhook, sampled-window judgement with cooldown
- **Prometheus `/metrics`** — Grafana friendly (HTTPS enforced)
- **Public status page** — redacted guest view, no token needed</td>
</tr>
<tr>
<td width="50%">

### 🌐 Lightweight & cross-platform
- **Go agent (native Linux)** — single binary + systemd, no external deps, <10 MB
- **Windows agent (native)** — same Go code compiled to an exe, logon-triggered scheduled task
- **Docker agent** — multi-stage scratch image, 65–150 MB (includes the daemon)
- **Zero coupling between agents** — they do not know each other exists
- **Data minimisation** — no kernel/GPU/public-IP/connection-count collection
- **Multi-disk** — physical disks auto-detected (tmpfs/proc/pseudo disks filtered)
- **Batch distribution** — the server generates packages; an admin executes on the node, binary-only swap keeps identity
- **Version determinism** — expected version/sha comparison shows `outdated` / `unknown` at a glance
- **Signed relay** — nodes that cannot reach GitHub pull the binary from your own server</td>

<td width="50%">

### ⚡ Admin UI & ecosystem
- **Vue3 SPA** — Vite + Tailwind v4 + TS, glassmorphism and light themes
- **Theme market** — ZIP install / URL import / update / rollback, safe extraction + SSRF guards
- **Komari theme compatibility** — official community skins run unmodified (`/?theme=<id>`)
- **WebSocket push** — offline/recovery/alert events in real time
- **Dashboard customisation** — drag-to-sort, groups, card/list modes
- **Backup management** — online snapshot, upload/download/restore, integrity spot-checks
- **Unified diting.sh** — deploy + update + uninstall + DB management + rescue (reset token / clear IP allowlist), whiptail TUI with a text-menu fallback
- **Self-registration** — `SETUP_TOKEN` for one-command clients, with optional admin approval and a node cap
- **Designed for 100 agents** — backend downsampling + SQL aggregation, not after-the-fact tuning</td>
</tr>
</table>

---

## 🚀 Quick start

```bash
# One command to deploy
curl -fsSL https://raw.githubusercontent.com/fengzone85/diting/master/diting.sh -o diting.sh
chmod +x diting.sh
sudo ./diting.sh
```

> The script installs Docker, git and other dependencies, then walks you through server and agent setup.

**Non-interactive (CI / bulk):**
```bash
# Install the server
sudo bash diting.sh --install-server

# Install an agent (manual mode)
sudo bash diting.sh --install-agent --server https://your-server:8008 --id NODE1 --token SECRET

# Install an agent (self-registration)
sudo bash diting.sh --install-agent --server https://your-server:8008 --setup-token <SETUP_TOKEN>
```

**Version pinning and integrity checks (optional, recommended for production):**

Every release lists SHA256 values in its notes. Pinning the version and verifying protects against
CDN/MITM tampering:

```bash
# 1) Pin the release tag (default: master, tracking latest)
sudo REPO_BRANCH=v1.2.0 bash diting.sh --install-server

# 2) Verify the script itself (compare against the release notes)
sudo SP_INSTALL_SHA256=<sha256 from the release notes> bash diting.sh --update-script

# 3) Agent payload: diting.sh --install-agent only uses the Go agent, and install.sh
#    enforces the .sha256 shipped with the release (no checksum = install refused).
```

> Two different verification stances: for `SP_INSTALL_SHA256` (the script itself), `--update-script`
> skips verification when the value is absent but still prints the downloaded file's SHA256 for your
> records; for the agent installer the `.sha256` is **fail closed** — missing means no install.
> Release flow: tag → CI runs tests → build three platforms → generate `.sha256` and ed25519 `.sig` → publish notes.

**Nodes that cannot reach GitHub (e.g. China Telecom egress):** with `RELAY_ENABLED=1` on the server,
`--install-agent` first tries `<SERVER_URL>/api/releases/agent/linux/<arch>` (the server verifies the
signature on the whole payload before forwarding a single byte) and automatically falls back to the
GitHub release on failure. Both paths still enforce SHA256.

---

## 🏗️ Architecture

```
   Monitored host (zero inbound, outbound HTTPS + token only)
   ├─ Go agent       (Linux: single binary + systemd)
   └─ Windows agent  (same Go code, scheduled task)
             │
             │  POST /api/report (one-way; response used for error logs only)
             ▼
┌────────────────────────────────────────────────────────────┐
│  Diting Server (Node.js 22, bound to 127.0.0.1:8081 only)   │
│  ├─ REST API        /api/report · /api/agents · /api/admin  │
│  ├─ SPA             / · /login · /admin · /node/:id         │
│  ├─ Komari compat   /api/v1/* · /api/clients(WS) · /api/rpc2│
│  ├─ Public view     /api/public/* (guest-safe, redacted)    │
│  ├─ Agent relay     /api/releases/agent/:os/:arch (verified)│
│  ├─ Theme engine    THEMES_DIR (next to the DB, persisted)  │
│  ├─ Prometheus      /metrics (HTTPS enforced)               │
│  └─ Modules         AI report · audit · billing · alerts    │
│        SQLite (tokens stored as SHA-256 hashes, not plain)  │
└────────────────────────────────────────────────────────────┘
             │
             ▼  Nginx + TLS reverse proxy (443, limit_req)
   Browser dashboard / Grafana / third-party Komari themes
```

**Key design points:**
- The agent only POSTs to `/api/report`; the response is used for error logs and is **never parsed or executed**
- The server binds `127.0.0.1:8081` and is exposed through Nginx + TLS on 443
- Tokens are stored as SHA-256 hashes, never in plaintext
- Sessions use a signed `HttpOnly + Secure + SameSite=Strict` cookie
- Third-party Komari themes are adapted **at response time by rewriting HTML references**; theme files on disk are untouched
- The signed relay forwards only artifacts that pass ed25519 verification *and* match the requested arch, cached per concrete tag; `:os/:arch` is a whitelist lookup

---

## 📁 Project structure

```
diting/
├── diting.sh                # deploy/update/uninstall/DB/backup/rescue (whiptail TUI)
├── docker-compose.yml       # quick start (for testing)
├── server/                  # server (Node.js 22 + Express + SQLite)
│   ├── server.js            # entry + routes + WebSocket + SPA/theme HTML rewrite + prune
│   ├── src/
│   │   ├── api.js           # REST API (agents/settings/alerts/billing/audit/backup/themes)
│   │   ├── auth.js          # auth + sessions + IP allowlist
│   │   ├── db.js            # SQLite + migrations + config (incl. heavy-db facade)
│   │   ├── online.js        # single source of truth for "online?" (shares alert thresholds)
│   │   ├── alerts.js        # threshold/certificate checks + sampled-window judgement
│   │   ├── notify.js        # mail / Telegram / webhook + notification groups (SSRF guards)
│   │   ├── traffic.js       # monthly traffic accounting and reset semantics
│   │   ├── rollup.js        # detail → hourly rows (watermark metrics_rolled)
│   │   ├── metrics-merge.js # weighted merge of hourly + detail rows
│   │   ├── capacity.js      # capacity fuse (row/DB-byte watermarks)
│   │   ├── backups.js       # backup list / download / restore trigger
│   │   ├── theme.js         # theme dir resolution (installed → bundled)
│   │   ├── theme-market.js  # theme market: catalog / safe ZIP extraction / install / rollback
│   │   ├── agent-relay.js   # signed agent relay (ed25519 verify, then forward)
│   │   ├── distribution.js  # batch distribution: packages + binary-only swap scripts
│   │   ├── agent-versions.js# expected version/sha comparison and status
│   │   ├── compat.js        # Komari theme REST compatibility layer
│   │   ├── compat-metrics.js# Komari /api/records/load|ping adapter
│   │   ├── compat-rpc.js    # Komari /api/rpc2 adapter
│   │   ├── v1.js            # standard /api/v1/* endpoints (Komari-shaped)
│   │   ├── totp.js          # RFC 6238 TOTP (zero dependency)
│   │   ├── validate.js      # input validation + CSS sanitising
│   │   └── ai/              # AI daily report (provider/prompt/report/schedule/summarizer)
│   ├── web/                 # Vue3 + Vite + Tailwind v4 + TypeScript SPA
│   │   └── src/             # public pages / admin pages / components / composables / services
│   ├── public/              # SPA build output + setup wizard + bundled themes (read-only)
│   │   └── themes/          # skins shipped with the release; installed ones live in THEMES_DIR
│   └── test/                # node:test unit and integration cases (security/compat/alerts/relay/…)
├── agent-go/                # Go agent (Linux / Windows / Docker share one codebase)
│   ├── main.go              # main loop (adaptive tiers live in adaptive.go)
│   ├── install.sh           # Linux installer (relay first, GitHub fallback)
│   ├── install-go.ps1       # Windows installer (scheduled task)
│   ├── collector/           # collectors (cpu/mem/disk/diskio/network/probe/…)
│   ├── reporter/            # reporting + retry (no dead compression option)
│   └── config/              # env var parsing
├── scripts/sign-agent-release.sh   # ed25519 signing of release artifacts
├── docs/                    # docs site (Astro, 13 pages)
└── nginx/monitor.conf.example   # TLS reverse proxy + rate limiting example
```

---

## ⚙️ Environment variables

> **⚠️ Breaking upgrade note (since 2026-09-07)**: endpoints that generate install commands
> (create agent / reset token / generate commands) **no longer derive the server address from the
> `Host` / `X-Forwarded-Host` header**. Configure one of: ① Dashboard "Settings → Agent server URL"
> (recommended); ② Dashboard "Site URL"; ③ the `PUBLIC_URL` env var — otherwise they return
> `400 server_url_not_configured`. Agent reporting is unaffected.

### Server (`.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | no | `8081` | HTTP listen port |
| `DB_PATH` | no | `/data/monitor.db` | SQLite path |
| `ADMIN_TOKEN` | no | — | **Deprecated, migration only**: new installs create the admin token in the browser `/install` wizard; **only its sha256 is stored**, the plaintext is shown once. Existing deployments keep this var: at startup the plaintext is migrated into the DB with a deprecation warning, after which it can be removed. Reset with `sudo bash diting.sh --reset-admin-token` (takes effect immediately, no restart) |
| `SESSION_SECRET` | recommended | random | Session cookie signing key (fixed value survives restarts) |
| `SESSION_TTL_MS` | no | `43200000` | Session lifetime in ms (12 hours) |
| `READONLY_TOKEN` | no | — | Read-only token (view only; ≥16 chars recommended, placeholders/short values raise a startup warning). Global static credential: cannot be revoked, not audited, cannot be scoped to nodes — use API tokens for that |
| `SETUP_TOKEN` | no | — | Agent self-registration token (moved into the DB on first use, DB wins afterwards) |
| `SETUP_REQUIRE_APPROVAL` | no | `1` | Self-registered nodes wait for admin approval; `0` restores auto-approval |
| `SETUP_MAX_AGENTS` | no | `50` | Cap on nodes creatable via self-registration |
| `AGENT_INTERVAL` | no | `20` | Expected report interval (offline detection, threshold minutes) |
| `OFFLINE_THRESHOLD_SEC` | no | `60` | Offline threshold in seconds; node/group overrides apply, all call sites share `online.js` |
| `RETENTION_DAYS` | no | `30` | Hourly-row retention (7–3650) |
| `METRICS_DETAIL_DAYS` | no | `7` | Minute-level detail retention (3–30); older data lives in hourly rows |
| `PROBES_DOWNSAMPLE` | no | `1` | Backend time-bucket aggregation for latency series (`0` disables) |
| `PROBES_MAX_POINTS` | no | `5000` | Points per label (hard cap 50000) |
| `CERT_WARN_DAYS` | no | `14` | Alert when an HTTPS probe target's certificate has ≤ this many days left (24h cooldown) |
| `ALERT_CPU_PCT` | no | `90` | CPU alert threshold (%) |
| `ALERT_MEM_PCT` | no | `90` | Memory alert threshold (%) |
| `ALERT_COOLDOWN_SEC` | no | `1800` | Alert cooldown in seconds |
| `ALERT_WINDOW_SAMPLES` / `ALERT_TRIGGER_RATIO` | no | `5` / `0.7` | Sampled-window judgement: ≥70% of samples in the window must breach before firing/recovering (replaces "N consecutive samples") |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | no | `smtp.qq.com` / `465` / `true` | SMTP server and encryption |
| `SMTP_USER` / `SMTP_PASS` | no | — | SMTP user / password (QQ Mail uses an authorisation code) |
| `ALERT_FROM` / `ALERT_TO` | no | — | Alert sender / recipient |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | no | — | Telegram bot alerts (in parallel with mail) |
| `PUBLIC_URL` | recommended | — | Public server URL (used to generate one-command agent installs; can also be set in the dashboard) |
| `TRUST_PROXY` | no | `loopback` | Trusted reverse proxy addresses (see below) |
| `ADMIN_ALLOW_HTTP` | no | — | Set to `1` to allow plain HTTP (intranet testing only) |
| `THEMES_DIR` | no | `themes/` next to the DB | Runtime theme install dir (persisted with the data volume); `public/themes` stays read-only |
| `BACKUP_DIR` / `RESTORE_TRIGGER` | no | `/data/backups` / `<BACKUP_DIR>/restore.request` | Host directory used by the dashboard backup page; use host paths for native installs |
| `RELAY_ENABLED` / `RELAY_CACHE_DIR` | no | `0` / system temp | Signed agent relay toggle and artifact cache dir |
| `AI_KEY_FROM_ENV` / `AI_API_KEY` | no | `0` / — | With `1`, the AI key is read from the env only and never stored in the DB |
| `AI_TREND_DAYS` | no | `7` | Disk "days until full" trend window (2–14; `0` restores the old algorithm) |

**Advanced / rollback switches** (defaults are fine; touch these when troubleshooting):

| Variable | Default | Description |
|---|---|---|
| `ALERT_SUSTAIN_SAMPLES` | — | Set `N` to restore the legacy "N consecutive breaches" rule |
| `ONLINE_NOTIFY_GRACE_SEC` | `180` | Only send a "back online" notice after this many seconds offline (`0` disables) |
| `ALERT_CONCURRENCY` / `NOTIFY_CONCURRENCY` | `8` / `8` | Alert evaluation / notification delivery concurrency (max 32) |
| `NOTIFY_GROUPS` | `1` | `0` reverts to the pre-notification-groups direct mail + Telegram path |
| `ALLOW_PRIVATE_WEBHOOK` / `ALLOW_INSECURE_WEBHOOK` | — | Allow private-network / `http` webhooks (default: https + public addresses only) |
| `AUDIT_RETENTION_DAYS` | `90` | Audit log retention (minimum 7) |
| `BACKUP_UPLOAD_MAX_MB` | `1024` | Max size of a backup uploaded through the dashboard |
| `METRICS_ROLLUP_ENABLED` | `1` | `0` disables hourly rollups (single-table fallback, legacy DBs only) |
| `STRICT_SESSION_DB` | — | `1` makes session-DB failures fail closed (default fails open to avoid locking the admin out) |
| `AI_COMPARE` | `1` | `0` disables the period-over-period sampling in the daily report (saves one query) |
| `HEAVY_QUERY_TIMEOUT_MS` / `HEAVY_WORKER_IDLE_MS` / `HEAVY_QUERY_BUDGET_MS` | `60000` / `5000` / `10000` | Heavy-query worker timeout, idle recycle, slow-query warning budget |
| `AGENT_ARTIFACT_DIR` / `AGENT_DISTRIBUTION_DIR` / `AGENT_ARTIFACT_MAX_MB` | `agent-artifacts` / `agent-distributions` next to the DB / `100` | Batch distribution storage and per-file cap |
| `AGENT_RAW_REPO` / `AGENT_GIT_REPO` | this project's master | Script/image sources used in generated commands (forks or self-built images) |

> The AI report, billing, audit, notification groups and the theme market are managed in the dashboard "Settings" page; no env vars needed. See `server/.env.example` for the complete list.

### Reverse proxy and `TRUST_PROXY`

The server uses `req.ip` for the admin IP allowlist, per-IP rate limiting and audit records. Whether
`req.ip` comes from `X-Forwarded-For` or the TCP peer is decided by `trust proxy`:

| Deployment | What to set |
|---|---|
| Nginx on the same host, 8081 bound to `127.0.0.1` (recommended) | Nothing, the `loopback` default works |
| Nginx on another host / another container (docker network) | `TRUST_PROXY=172.16.0.0/12,10.0.0.8` (comma-separated IPs or CIDRs) |
| Single fixed proxy hop, no addresses to list | `TRUST_PROXY=1` (trust one hop) |

⚠️ **Upgrade note**: this used to be `trust proxy = true` (trust any forwarding header). As long as
`8081` was reachable, a client could forge `X-Forwarded-For: <allowlisted IP>` to bypass the IP
allowlist and rate limits, or forge `X-Forwarded-Proto: https` to let admin calls through over
plaintext HTTP. The default is now `loopback`, so **deployments where the proxy is not on the same
host must set `TRUST_PROXY`**, otherwise `req.ip` becomes the proxy IP and allowlisted sites will see
every request rejected with 403.

### Public data boundary (`public_show_business`)

`/api/public/agents` and `/api/v1/nodes` expose business fields (vendor, expiry, notes, monthly quota,
plan) by default — the public overview's "vendors / expiring soon" and the detail page's
"notes / plan" depend on them, so they cannot simply be removed. If the public page faces external
visitors and you do not want to expose business data, turn off "Settings → Expose business fields on
public endpoints": the fields disappear from responses and the related modules hide themselves.

This switch is independent of "public page enabled (`public_enabled`)": when the public page is off,
both endpoint families return 403.

### Agent

| Variable | Required | Default | Description |
|---|---|---|---|
| `SERVER_URL` | ✅ | — | Server URL (HTTPS required unless localhost) |
| `AGENT_ID` | ✅ | — | Node identifier |
| `AGENT_TOKEN` | ✅ | — | Auth token |
| `INTERVAL` | no | `20` (Docker image / Windows installer: `15`) | Fixed-mode report interval in seconds (min 5); acts as the base when `ADAPTIVE` is on |
| `ADAPTIVE` | no | on | Purely local adaptive sampling: fast tier `FAST_INTERVAL` ↔ steady tier `SLOW_INTERVAL`; never parses a server response |
| `FAST_INTERVAL` / `SLOW_INTERVAL` | no | `10` / `60` | Adaptive tier intervals; the server's `OFFLINE_THRESHOLD_SEC` must exceed the slow tier |
| `DISK_PATH` | no | `/` | Path used for disk statistics (usually `/host` in a container) |
| `MONTH_ROTATE` | no | `0` | Traffic reset day: `0` = absolute counters, `1-31` = zero on that day each month (Komari `AGENT_MONTH_ROTATE` alias accepted) |
| `PROBE_TARGETS` | no | Mobile portal + CT/CU DNS + Google DNS | Probe targets (`label:host[:port]` TCP or `label:http(s)://host/path` HTTP, comma-separated, empty disables). Default `CM:www.10086.cn:443,CT:101.226.4.6,CU:202.106.0.20,GG:8.8.8.8` — carrier DNS rejects TCP outright, so `CM` measures "China Mobile ingress reachability" |
| `PROBE_TIMEOUT_MS` | no | `900` | Per-attempt TCP handshake deadline (ms) |
| `PROBE_RESOLVE_MS` | no | `900` | Hostname resolution deadline (ms); a timeout is "no sample", not packet loss (`ok=null`) |
| `NET_IFACE_FILTER` | no | `1` | Network counter interface filtering: `0` falls back to the old "all non-lo interfaces" rule. By default docker/veth/br-/bond/vlan/tunnel interfaces are excluded so bridge/container lifecycle counters are not billed as traffic |
| `NET_IFACE_ONLY` | no | — | Interface allowlist (comma-separated full names): when non-empty, only these count and all built-in exclusions are ignored. Required on nodes whose only uplink is a tunnel (e.g. a WireGuard egress VPS), otherwise traffic reads as zero |
| `DEBUG` | no | off | Verbose logging (never prints tokens) |

---

## 🖥️ Admin UI (Vue3 SPA)

Since v1.0 the admin UI is a **Vue3 + Vite + Tailwind v4 + TypeScript** SPA, rewritten from the old single-page scripts:

| Route | Description |
|---|---|
| `/` | Public page: agent cards (glassmorphism / light themes), groups, drag-to-sort |
| `/node/:id` | Node detail: metric charts + hardware/system/storage/network info cards |
| `/login` | Admin token + TOTP |
| `/admin` | Admin: Dashboard / Agents / AgentDetail / Ai / ApiTokens / AuditLog / Billing / AgentArtifacts / Sessions / Settings / Template |

- **Frontend layering**: `services/{api,adminApi,publicApi}.ts` + `composables/` + `components/`, types from `types.ts`
- **Realtime**: WebSocket pushes offline/recovery/alert events; the public page polls every 10s (paused on hidden tabs, de-duplicated)
- **Settings page**: site info, UI, alert thresholds, notification groups, social links, theme market and theme switching, backup policy and file list, capacity watermarks

Build (output lands directly in `server/public/`, no server restart needed):

```bash
cd server/web && npm install && npm run build
```

---

## 📊 Dashboard features

- **Overview**: total / online / offline / average CPU·memory / traffic / groups / **database size**
- **Agent cards**: status dot, flag, vendor badge, CPU·memory·load·temperature·Swap mini sparklines, disk bars (multi-disk aggregated), expiry countdown, network quality (latency + loss mini bars)
- **List mode**: compact table with CPU/memory/disk bars and up/down rate lines
- **Detail page**: CPU / memory / load / network rate / disk IO / temperature charts, ranges **1h / 6h / 24h / 7d / 30d**, auto-scaled Y axis (B/s → KB/s → MB/s → GB/s)
- **Drag-to-sort**: admins define card order
- **Grouping**: agents grouped, order configurable
- **Disk exhaustion forecast**: days remaining estimated from the recent usage slope (all physical disks aggregated)

---

## 🛡️ Audit log

Every admin write is recorded in the `audit_log` table and can be viewed/filtered in the "Audit Log" page:

| Category | Recorded actions |
|---|---|
| Agents | create / update / delete / renew / reset token |
| Settings | site info / alert thresholds / notifications / social links |
| Auth | TOTP enable / disable / verify |
| System | prune failure streak alerts, etc. |

Each record contains the operator, timestamp, object id and a before/after diff — who changed what, when.

---

## 🤖 AI daily report

The server periodically summarises yesterday's metric anomalies across all agents and delivers the report
to the channel configured in Settings (mail / Telegram):

- Provider layer `server/src/ai/provider.js` (multi-provider), summarising strategy `summarizer.js` based on history and threshold de-duplication
- Inference timeout of 3 minutes (for reasoning models); a successful manual retry clears the degraded-state banner
- Disk "days until full" uses an `AI_TREND_DAYS` (default 7, range 2–14) trend estimate with an interval and confidence; `0` restores the legacy "first/last point in 24h" algorithm
- Risk levels have **local rule anchors** (offline share / breaching nodes / expiring nodes); the model may move at most one level around them. Long-offline nodes get a silence period (default 3 days) and are not reported individually
- The "Ai" page can trigger a run manually (**async task**: the API returns immediately and the page polls; triggers are cooled down to avoid duplicate billing)
- Pure server-side task — no downstream command is introduced

---

## 💰 Billing & expiry

The `agents` table carries `price` / `billing_cycle` / `currency` / `auto_renewal`, managed in the "Billing" page:

- **Cycles**: monthly (30) / quarterly (90) / half-year (180) / yearly (365) / two years (730) / three years (1095) / free (0)
- **Currencies**: ¥ / $ / € / £
- **Renewal**: single node (`POST /api/agents/:id/renew`) and batch renew
- **Expiry reminders**: card countdown (yellow <7 days, red when expired)
- **Statistics**: monthly total cost, per-group stats, expiring-soon list

> Free (`billing_cycle=0`) keeps the original expiry date; renewing only refreshes the start date.

---

## 💾 Backup, capacity and data lifecycle

**Two-tier history**: minute-level detail is kept for `METRICS_DETAIL_DAYS` (default 7 days); once an
hour is sealed, `rollup.js` folds it into `metrics_hour` rows (with sample count `n`). Long-window reads
go through `metrics-merge.js` (means weighted by `n`, peaks by MAX) and the `metrics_rolled` watermark
guarantees there is no gap where data is neither in the hourly table nor still in details. `RETENTION_DAYS`
(default 30) governs only the hourly rows.

**Capacity fuse**: dual watermarks on metrics row count and database file size. At 80% a single
`capacity` alert fires and a yellow banner appears; at 100% only historical detail ingestion is skipped
— `/report` still returns 200 and live data plus alerting keep working. Cleanup is an **explicit**
action (a dashboard button reusing the retention prune); nothing is deleted automatically and there is no
automatic VACUUM.

**Backups** (Settings → Backup):

- Host-side execution: `sudo bash diting.sh --backup`; `--backup-schedule install` enables daily automatic backups with rotation
- In-app consistent snapshot via the SQLite online backup API — no downtime needed
- File management: list / download / delete / upload external backups (SQLite or gzip only, filenames generated by the server) / restore
- Restore: the dashboard only drops a request file (`RESTORE_TRIGGER`); host-side `diting.sh --process-restore` performs it, and a `pre_restore_*` backup is taken first
- Integrity badge: passed / corrupt / unknown (unknown = not yet spot-checked)

---

## 🎨 Komari theme compatibility and theme market

`server/src/compat.js` implements the Komari community-theme compatibility layer, so official theme
ZIPs run **without a single edit**:

- **REST**: `/api/me`, `/api/public`, `/api/version`, `/api/nodes`, `/api/nodes/:uuid`, `/api/recent/:uuid`, `/api/records/load`, `/api/records/ping`
- **Realtime**: `/api/clients` (WebSocket, send `get` for a snapshot), `/api/clients/sse` (fallback), `/api/rpc2` (POST / WS)
- **Response envelope**: all `/api/*` responses use `{status,message,data}`; records are flat arrays and task ids are numeric — the themes' internal normalisation chain reads the Komari shape, so a different envelope or id type silently renders "no data"
- **Field mapping**: `cpu_cores` is real; `kernel_version` / `arch` / `virtualization` explicitly return empty (capability `false` + `null`) so templates hide those blocks instead of showing fake values
- **Static assets**: root-absolute references are rewritten **at response time** (theme files on disk untouched), and trailing-slash routes are handled
- **CSP**: themes with inline scripts get a one-time nonce, relaxing `script-src` for that response only

**Install and update**: the Settings → Theme Market page installs from a theme source, imports a ZIP by
URL, checks for updates and rolls back to the previous version. Themes can also be dropped into
`THEMES_DIR` (default `themes/` next to the DB, persisted with the data volume; `public/themes` stays
read-only and the installed copy wins on name collisions). Enable with `/?theme=<id>`; theme options are
edited visually in Settings.

**Extraction and download boundaries**: each entry is capped by its actual byte count (declared header
sizes are not trusted), path traversal / absolute paths / symlinks are rejected, installs are serialised
with a single-flight lock, and downloads pin DNS and block private addresses (reusing the notification
module's SSRF rules).

> Compatibility is cross-checked against two production artifacts from different stacks: Vue-based
> Glassmorphism v3.4.4 and React-based PurCarte v1.2.5 — the six load charts, node detail and record
> endpoints are verified; the latency chart's "no latency data" empty state is gone while its stat cards
> and curve are still being aligned with the theme's internal components. The rule is to **adapt the
> server, never the theme template** — so a community upgrade is just a new ZIP.

---

## 🔔 Alerts

- **Offline alerts**: no report beyond the threshold (node > group > global override; evaluation is shared with lists, the public page and the compatibility layer through `online.js`)
- **Threshold alerts**: CPU/memory judged over a sample window — ≥`ALERT_TRIGGER_RATIO` (default 70%) of samples must breach before firing/recovering, so a single spike is ignored
- **Certificate alerts**: an HTTPS probe target with ≤ `CERT_WARN_DAYS` (default 14) left
- **Channels**: QQ Mail (SMTP) + Telegram + Webhook, routed by **notification group**; one failing channel never blocks the others
- **Webhook egress constraints**: https and public addresses only by default (DNS pinning + private-range blocking); LAN receivers require `ALLOW_PRIVATE_WEBHOOK` / `ALLOW_INSECURE_WEBHOOK`
- **Cooldown**: the same alert type is not repeated within 30 minutes by default; recovery notices require `ONLINE_NOTIFY_GRACE_SEC` (default 180s) offline
- **System alerts**: three consecutive prune failures, capacity reaching 80%
- **Test button**: dashboard "📨 Test alert" or `POST /api/test-alert`

---

## 🔑 Read-only account and API tokens

To reduce "the all-powerful admin token is shared everywhere", access can be narrowed two ways.

### Global read-only account (`READONLY_TOKEN`)

- Optional `READONLY_TOKEN` in `.env` (≥16 chars recommended)
- Holders can call **read-only GET endpoints only** (agent list, latest metrics, sparklines, …; **not** `/metrics`, which only accepts `ADMIN_TOKEN`)
- All writes (agent CRUD, token reset, test alert) are blocked by the `adminOnly` guard with **403** `admin required`
- Limits: global static credential, only invalidated by changing it (restart needed), not audited, **cannot be scoped to specific nodes**

### API tokens (recommended: revocable, node-scoped, audited)

Issue and revoke them in the sidebar "API Token" page, or call the HTTP endpoint directly (plaintext returned once):

```bash
curl -X POST https://your-server/api/admin/api-tokens \
  -H 'Content-Type: application/json' \
  -H 'X-Admin-Token: <ADMIN_TOKEN>' \
  -d '{"name":"panel-viewer","scope":"readonly","agent_ids":["agt_xxxx"],"expires_in_days":90}'
```

- Callers send `X-API-Token: diting_<48hex>`; the server stores only its SHA-256
- `scope=readonly|admin` (default `readonly`); an empty `agent_ids` array means "all nodes"
- With a non-empty `agent_ids`: per-node endpoints answer **403 `forbidden_node`** on out-of-scope ids, cluster-wide aggregates (`/overview`, `/billing`, `/ai/reports`, `/admin/audit-logs`, …) and global write endpoints (`/settings`, notification channels/groups, `/ai/config`, backups, 2FA, `POST /agents`) answer **403 `forbidden_scope`**, and `/agents` + `/agents/sparklines` are filtered to the allowlist
- Revoke with `DELETE /api/admin/api-tokens/<id>` (401 on the next request); list with `GET /api/admin/api-tokens`
- A scoped token cannot manage tokens itself — otherwise it could mint an unscoped one and escape the node boundary
- Ideal for Grafana / third-party dashboards / handing someone access to specific nodes

---

## 📈 Prometheus metrics export (`/metrics`)

- `GET /metrics` returns Prometheus text format
- Auth: `Authorization: Bearer <ADMIN_TOKEN>` (**only** `ADMIN_TOKEN`, constant-time comparison, subject to the admin IP allowlist)
- **HTTPS enforced by default** (`X-Forwarded-Proto: https` or direct TLS); `ADMIN_ALLOW_HTTP=1` only for intranet debugging
- Metrics: `monitor_agent_cpu_percent`, `monitor_agent_mem_percent`, `monitor_agent_disk_percent`, `monitor_agent_net_rx_rate_bytes`, etc.
- Example: `curl -H 'Authorization: Bearer TOKEN' https://your-server/metrics`

---

## 🐹 Go agent (Linux / Windows / Docker)

`agent-go/` is the only agent implementation (the Python agent was retired in 2026-10):

- **Single-file deploy**: one binary per host (systemd / scheduled task)
- **Adaptive sampling**: `ADAPTIVE=on` (default) moves between `FAST_INTERVAL` (10s) and `SLOW_INTERVAL` (60s) based on local change rates (the server's `OFFLINE_THRESHOLD_SEC` must exceed the slow tier; 120 recommended)
- **Monthly traffic**: reports absolute counters `net_rx/net_tx` plus `month_rotate` only; monthly totals are computed server-side in `traffic_state`, the agent keeps no state
- **Three-state probes**: `ok=true` (reachable) / `ok=false` (unreachable) / `ok=null` (resolve or handshake timeout = no sample, not loss)
- **Disk IO semantics (from v1.1.5)**: whole-disk counters in `/proc/diskstats` already include their partitions, so the collector now reads only whole disks (decided via sysfs `partition`, not "name ends with a digit", which would kill NVMe) and reuses the network-side "counter went backwards → 0" guard. **After upgrading to v1.1.5 disk read/write numbers drop and show a one-off step down — that is the fix (the old values double-counted partitions); history is not backfilled.**
- **Footprint**: ~10 MB resident, no Python / Docker dependency
- **Windows**: an exe compiled from the same code (`agent-go/install-go.ps1` registers a scheduled task); `load1/5/15` are fixed at `0.0`
- **Docker**: multi-stage scratch image; use `--network host` for real traffic counters

---

## 📦 Release, distribution and version determination

- **Release chain**: pushing an `agent-go-vX.Y.Z` tag triggers CI, which runs tests first and then builds three platforms (linux-amd64 / linux-arm64 / windows-amd64), each with `.sha256` and an ed25519 `.sig`
- **Install verification**: `install.sh` / `install-go.ps1` enforce the `.sha256`; a missing checksum refuses installation (fail closed), and the relay path is identical
- **Batch distribution** (dashboard "Distribution"): after uploading a new binary the server generates a package (tar.gz / zip + script). The script **only replaces the binary** and never writes `agent.env` / `run_scheduled.bat`, so `AGENT_ID` / `AGENT_TOKEN` / `PROBE_TARGETS` survive byte-for-byte; download links are one-time HMAC tokens (30 minutes by default, burnt on use) and a failed checksum rolls back
- **Version determination**: with an expected version/sha configured, the dashboard shows `up_to_date` / `outdated` / `unknown` / `custom`; an older agent without `build_sha` is reported as `unknown` rather than `outdated`
- **The red line holds**: distribution is always executed by an admin on the node; the server only generates files, adding **no persistent command channel and no new agent egress target**

---

## ⚡ Performance and scale

**Designed for 100 agents from the start** (not tuned after the fact); every endpoint that grows with fleet size is optimised at the bottom:

- **Two-tier history**: 7 days of minute detail + 30 days of hourly rows; long windows read `metrics_hour` instead of millions of detail rows
- **Backend downsampling**: sparklines default to 1000 points per label; latency series use `PROBES_MAX_POINTS=5000` with time-bucket aggregation
- **SQL-side aggregation**: cluster average CPU/memory trends are computed in the DB instead of pulling everything to the frontend
- **Column pruning**: full metrics queries select only `ts/agent_id/probes`, avoiding the 30d × 100 agents blow-up
- **Heavy-query isolation**: cross-table aggregations run in a worker thread (with fallback) so `/report` and live endpoints are never blocked
- **Capacity fuse**: row/byte watermarks; at the cap only detail ingestion stops, monitoring and alerting continue
- **Polling**: public page every 10s, paused on hidden tabs, de-duplicated
- **Measured**: 62 agents / 3.36M metric rows in the test DB; page responses < 500 ms with 100+ nodes
- **Lesson learned**: a full-table `.all()` on metrics once OOMed a 2 GB heap (fixed); since then: column pruning + time-bucket downsampling, always

---

## 🛡️ Hardening checklist

- [ ] Put Nginx + TLS in front and bind the origin to `127.0.0.1:8081`
- [ ] Complete `/install` on first visit (creates a strong random admin token, **shown once**; only its sha256 is stored)
- [ ] Set `SESSION_SECRET` (fixed random value so restarts do not invalidate sessions)
- [ ] Enable TOTP (Settings → Account security)
- [ ] Configure the IP allowlist (**optional**, IPv4/IPv6/CIDR) — empty means unrestricted; when enabled, other source IPs get 403 and a misconfiguration locks you out (rescue with `sudo bash diting.sh --clear-ip-whitelist`, effective immediately)
- [ ] Back up regularly (`sudo bash diting.sh --backup`, or `--backup-schedule install` for daily backups)
- [ ] **Rehearse one restore** (an unrestorable backup is no backup)
- [ ] Configure alert channels (mail / Telegram / Webhook)
- [ ] Install third-party themes from trusted sources only (a theme executes as front-end code)
- [ ] Review the audit log periodically (Admin → Audit log)
- [ ] Optionally hide the origin IP with Cloudflare Tunnel or Tailscale

---

## 🔄 Updating

```bash
# Update the install script itself
sudo bash diting.sh --update-script

# Update the server (git pull + rebuild)
sudo bash diting.sh --update-server

# Update the agent (keeps the registered identity)
sudo bash diting.sh --update-agent

# Server process control (detects native systemd / Docker automatically)
sudo bash diting.sh --restart-server
sudo bash diting.sh --stop-server
sudo bash diting.sh --start-server
sudo bash diting.sh --status          # form, port, PID, working directory

# Backups and restore
sudo bash diting.sh --backup              # back up now
sudo bash diting.sh --backup-list         # list backups
sudo bash diting.sh --restore <file>      # restore from a backup
sudo bash diting.sh --process-restore     # execute a restore requested from the dashboard
```

> When updating an agent the installer **keeps the registered identity** (`agent.env` / `run_scheduled.bat`
> untouched byte-for-byte) and leaves a `.bak-YYYYMMDD-HHMMSS`. For fleets, generate a package in the
> dashboard "Distribution" page and run it as root on each node.

---

## 📖 Documentation

| Document | Description |
|----------|-------------|
| [Docs home](https://fengzone85.github.io/diting/) | The full documentation site (online version of each entry below) |
| [Installation](https://fengzone85.github.io/diting/install/) | Per-platform installation |
| [Quick start](https://fengzone85.github.io/diting/quick-start/) | Deploy in 5 minutes |
| [Server configuration](https://fengzone85.github.io/diting/server/) | Environment variables and deployment |
| [Agent deployment](https://fengzone85.github.io/diting/agent/) | Linux / Windows |
| [Native Linux](https://fengzone85.github.io/diting/native/) | systemd deployment |
| [Windows agent](https://fengzone85.github.io/diting/windows/) | Native Windows |
| [API reference](https://fengzone85.github.io/diting/api/) | REST endpoints |
| [Environment variables](https://fengzone85.github.io/diting/env/) | Complete variable reference |
| [Security design](https://fengzone85.github.io/diting/security/) | Security features and hardening |
| [Tunnel guide](https://fengzone85.github.io/diting/tunnel-guide/) | Cloudflare Tunnel / Tailscale |
| [FAQ](https://fengzone85.github.io/diting/faq/) | Frequently asked questions |
| [CHANGELOG](CHANGELOG.md) | Version and behaviour changes (incl. the disk IO semantic fix) |

---

## 🛡️ Security design principles

> **Trust isolation matters more than feature richness.** Security is achieved not by stacking layers, but by *not doing* things.

1. **No command channel** — agents accept no instructions, they only report
2. **Zero coupling between agents** — compromising one does not affect the others
3. **Data minimisation** — only basic state; no fingerprints (kernel / CPU model / GPU / public IP)
4. **Defence in depth** — HTTPS + token hashing + signed cookies + TOTP + IP allowlist
5. **The server is untrusted** — a breach of either side does not spread to the other

---

## Threat model: trust-boundary analysis (design philosophy)

> In one sentence: **trust isolation matters more than feature richness.** The security of this project comes not from stacking defensive layers, but from *not doing* things — no command channel, no host fingerprinting, no agent-to-agent awareness. An attacker cannot exploit what does not exist.

### Our assumption: the server is untrusted, and so is the agent

Many monitoring systems implicitly assume "the server is trusted". Once the server is compromised, every agent falls with it — because agents accept server commands, execute pushed tasks, and trust everything the server says.

Our design assumes the opposite: **the server may be compromised, a single agent may be compromised, and either breach must not affect the other.** Below we verify this assumption against the code.

### Three pillars (all verified in code)

**① No command channel (Agent → Server is one-way)**
- The agent only `POST`s to `/api/report`; the response body is used solely for error logging (`e.read()`) and is **never parsed or executed**. The agent listens on no port and has no `subprocess`/`Popen`/`eval`/`exec`.
- `POST /report` is the only endpoint the **running agent** touches; `agentAuth` merely validates the token and stores the metric, returning `{ok:true}`. The server also exposes `GET /api/releases/agent/:os/:arch` (the signed relay), but that is fetched once by the **installer an admin runs** during install/upgrade — the agent never calls it at runtime. Batch distribution is the same: the server only generates packages and scripts, execution is initiated locally by an admin. There is no WebSocket / SSE / downstream push aimed at a running agent; the dashboard refreshes via browser-side polling, unrelated to agents.
- This is a **deliberate non-implementation** of a command channel — not "not yet built". Bidirectional WebSocket monitors are the opposite: more capable, but the trust boundary is broken.

**② Zero coupling between agents**
- Each agent knows only its own `SERVER_URL` + token, and is unaware of other agents.
- Metrics are stored per `agent_id`; all cross-agent aggregation (`getAgents`/`getMetricsAll`) is admin-only read queries for the dashboard, never pushed to any agent. Even a compromised server has no mechanism to make "agent A contact agent B".

**③ Collected data carries no exploitable information**
- We collect only basic state: online, load, CPU, memory, disk, traffic (incl. monthly totals), temperature, Swap, uptime. Temperature / Swap / uptime are **non-fingerprint** metrics (no kernel version / CVE targeting, no public IP, no GPU), so even a leak yields nothing actionable.
- We do **not** collect kernel version, GPU, public IP, connection count, or process count — fingerprints usable for targeted attack. Even if the server DB is exfiltrated, the leak is only "machine X had CPU/memory Y at time Z" — useless for targeted attacks (no kernel version → no CVE targeting, no public IP → no direct target, no GPU → no mining leverage).

**③·b Fingerprints carry two distinct risks: location, and clustering**

The common intuition is: "Since the agent has zero inbound, we don't collect the public IP, and agents take no commands, nothing collected is reachable — so fingerprints are harmless." That reasoning covers only the first dimension and misses the second:

| Dimension | The problem the attacker must solve | What defends against it | Diting's stance |
| --- | --- | --- | --- |
| **Location** | Where is this machine? How do I reach it? | Not collecting the public IP / any IP | ✅ No IP collected, plus zero inbound |
| **Clustering** | I've already landed on one host — **which other hosts can I hit with the same exploit?** | Not collecting vulnerability-matchable fingerprints | ✅ No kernel version, no CPU model, no GPU |

The key insight: **clustering does not require location capability.** If an attacker already has a shell on one host via a completely unrelated entry point (say, an outdated CMS on that box), what he wants to know is "which of your other hosts can my existing exploit hit again?" Any field in the DB that groups machines together lowers his second-wave cost:

- **Kernel version** → directly matches CVEs (`3.10.0-1160` ⇒ that specific vulnerability list);
- **CPU model** → identifies the microarchitecture (`E5-2680 v4` ⇒ Skylake-SP ⇒ MDS/Downfall class; `EPYC 7B13` ⇒ Zen family). All hosts of the same model share an identical vulnerability surface, so **owning one means owning the recipe for all of them**;
- **Listening ports / process list** → literally a to-do list of "which host still runs openssh 7.4 / nginx 1.14".

So "no public IP" defends against *finding you*, while "no kernel version / CPU model" defends against *knowing where to strike once found* — two independent lines, neither a substitute for the other. This project does both, and the discipline **is not relaxed just because a field cannot be exploited in isolation**: once the first exception is granted for "it's unreachable anyway", the line is gone.

> Note: `hostname` and `os` (e.g. "Ubuntu 22.04") are indeed stored and are lightweight identifiers. The former is an operational necessity (telling nodes apart); the latter is coarse-grained (a distro name cannot be matched to a kernel CVE). The line we draw is explicit: **do not collect fields that directly match vulnerabilities or lower the cost of second-wave spread** — not "collect no strings at all".

### Three compromise scenarios

| Scenario | Attacker can | This project | Command-channel / fingerprinting monitor |
| --- | --- | --- | --- |
| ① Server compromised | Read reported data | ✅ (basic state incl. non-fingerprint metrics, no fingerprint) | ✅ (incl. kernel/GPU/public-IP/conns) |
| | Spoof data to mislead agents | no effect (agents take no commands) | no effect |
| | Push malicious tasks / probes | ❌ impossible (no command channel) | ✅ can push; agent becomes jump host |
| | Move laterally to other agents | ❌ impossible | ⚠️ can probe other networks via tasks |
| ② One agent compromised | Read its own token | ✅ (visible via service config) | ✅ (visible via ps/cmdline) |
| | Spoof its own data | ✅ (only affects that agent) | ✅ |
| | Lateral move / attack server | ❌ impossible (POST-only; server runs no agent command) | ❌ impossible |
| ③ Server + one agent compromised | Get other agents' tokens | ⚠️ yes (see refinement) | ⚠️ yes |
| | Spoof other agents' data | ⚠️ yes | ⚠️ yes |
| | Execute / push tasks on other agents | ❌ impossible (no command channel) | ✅ possible (probe tasks, not RCE) |

### Refinement of scenario ③ (our design is more optimistic)

Tokens are stored in the database as **SHA-256 hashes** (`token_hash`), never in plaintext. Authentication compares `sha256(submitted token)` against the stored hash (constant-time). Therefore:

- A **read-only** DB leak (e.g. exfiltration without write access) yields **no plaintext token** for any agent. To spoof another agent's data, the attacker must either brute-force a 24-byte random token (infeasible) or overwrite `token_hash` with a known value.
- In other words, a "compromised server" that is read-only **cannot immediately spoof**; DB write access is required. This is a concrete hardening of the ⚠️ row above.

In the worst case (server + one agent both compromised), the attacker's ceiling is **spoofing other agents' reports** — the dashboard shows fake data, but **no machine is controlled**.

### Three honest caveats

1. **On the collected set**: besides the basic state, `hostname`, `os` (distro name, e.g. "Ubuntu 22.04"), temperature, Swap and uptime are also stored. They are lightweight identifiers or **non-fingerprint metrics**, not attack fingerprints; the "no fingerprint" claim should be read as "no fingerprint useful for targeted attack".
2. **Token hashing downgrades "plaintext leak" to "forge only with DB write access"**, not complete immunity — this should be explicit when evaluating scenario ③.
3. **On the "clustering" dimension**: see ③·b above. "No public IP" addresses *location* only; it does not address "an attacker who already landed on one host uses fingerprints in the DB to select other hosts of the same model for a repeat run". Hence we do not collect kernel version / CPU model / GPU / process count / connection count — not because those fields are directly exploitable given "no public IP + no command channel" (they are not), but because they lower the cost of an attacker's second wave. The same discipline is why **adding any new collected field requires a fresh security review**.

---

## Trust-boundary comparison with mainstream monitors (e.g. Nezha)

Many monitors (e.g. Nezha) prioritise features with an architecture of **monitored hosts exposed to the public internet + bidirectional communication (WebSocket) + remote execution**. More capable, but the trust boundary is broken: once the server is compromised, every monitored host becomes a remotely controllable node.

| Dimension | Diting (this project) | Command-channel monitors (e.g. Nezha) |
| --- | --- | --- |
| Agent inbound | Zero inbound (outbound HTTPS only) | Usually exposes ports / dashboard to the internet |
| Communication | One-way (Agent→Server POST) | Bidirectional (WebSocket, server can push) |
| Remote execution | ❌ none (deliberately absent) | ✅ present (command exec → RCE risk) |
| Agent coupling | Zero; mutually unaware | Server can orchestrate; agents can be jump hosts |
| Collected data | Basic state (incl. non-fingerprint metrics like temp/Swap/uptime), no fingerprint | May include kernel/version/network detail |
| Clustering risk | ❌ none (no kernel/CPU model collected, so the attacker cannot bucket the fleet by microarchitecture) | ⚠️ present (kernel/model bucket the fleet, letting one exploit be reused) |
| Worst case (server + 1 agent breached) | Only report spoofing; no machine controlled | Can push tasks to probe / execute via agents |
| Trust model | Server and agents both untrusted | Implicitly assumes "server is trusted" |

> Bottom line: Diting trades a functional "subtraction" (no command channel, no fingerprinting, no agent awareness) for a security "addition". An attacker cannot exploit what does not exist.

---

## Clarification on other agent-type probes (source-level evidence)

Some other agent-type probes (an open-source project using a server→agent command channel), often compared with this project, also use that pattern. Two common misconceptions are corrected here with its actual `agent/main.go` source.

**Misconception 1: "the agent can be RCE'd" — false.**
Its ICMP probe path is: `executeICMPPing(target)` → `resolvePublicIPs()` (DNS resolution + blacklist check) → take `ips[0].String()` → only then `exec.Command("ping", "-c", "1", "-W", "2", pingTarget)`. Two facts matter:
- The argument reaching `exec.Command` is **always the output of `net.IP.String()`** (e.g. `192.168.1.1`, `2001:db8::1`) — it can never contain shell metacharacters like `;`, `|`, or backticks.
- Go's `exec.Command` calls `execve` directly; no `/bin/sh` is involved.

So even if the server pushes `; rm -rf /`, it is rejected at the `resolvePublicIPs` / `net.ParseIP` stage and ping never starts. **This is not RCE; it is a type-constrained command invocation.** Equating "there is an exec call" with "arbitrary code can be executed" is classic audit over-generalization. Its TCP/HTTP paths dial the already-validated `net.IP` objects directly, with no second DNS resolution, so there is no DNS-rebinding / TOCTOU bypass — its SSRF defence is actually quite rigorous.

**Misconception 2: "adding task signatures to the WebSocket fixes server-compromise risk" — ineffective for this threat model.**
This project's threat model assumes the server is untrusted and may be compromised. Once the server is compromised, the attacker holds the signing key and **is the legitimate signer**. Task signatures only protect against a third party tampering in transit; they cannot stop the server itself from being the attacker. For signatures to help here, a trust root outside the server (independent CA or agent-local allowlist) would be required — which is effectively redesigning the trust model, and that is exactly "no command channel" itself.

**Correct characterisation & conclusion:**
- After a server compromise, the attacker **can** make all agents probe arbitrary public targets via ICMP/TCP/HTTP (restricted by the CIDR blacklist to public addresses only — no intranet reach). It is a **distributed probe jump host**, not an RCE botnet.
- But the "probe jump host" capability **is not a bug; it is the core feature** (public ping monitoring). It cannot be removed while keeping the feature; only eliminating the command channel (this project's approach) resolves it fully.

> In one line: such an agent-type probe is a *constrained controlled probe agent*, not an *RCE backdoor*. Its problem is not RCE — it is the mere existence of a command channel, which this project deliberately avoids.

---

## Why we deliberately do not implement these features

The core idea is "security through omission". Below are common features in similar monitors that we deliberately leave out, each with its security rationale. Every omission corresponds to one of our trust-boundary guarantees.

### 1. Centralised active probing (ICMP / TCP / HTTP ping of arbitrary targets, assignable to specific nodes)
For an agent to ping or probe a target, the server must push a task to it — which requires a command channel. Once a command channel exists, the trust boundary breaks: a compromised server could make every agent probe arbitrary public targets, turning the fleet into a distributed probe jump host. We keep the Agent → Server flow strictly one-way, so we do not offer "server-orchestrated probing."

> **Addendum (2026-07-09): we added a safe equivalent — "agent-side network-quality self-test."** The idea is to replace "server pushes arbitrary probe targets" with "each agent runs TCP/HTTP probes against a few *fixed public infrastructures* hardcoded in its local config (default: China Mobile portal `www.10086.cn:443` + CT/CU carrier DNS + 8.8.8.8)" from its own host. Because targets come from the agent's local config and the server **never** pushes any at runtime, the command channel does not exist and the trust boundary stays intact.

### 2. Host fingerprinting (kernel version / GPU model / public IP / TCP connection count, etc.)
Such fingerprints, if the server is breached (especially exfiltrated), directly expose each machine's attack surface — an old kernel version enables targeted CVE matching, a public IP gives a direct target, a GPU enables mining trade-offs. We collect only basic state (incl. non-fingerprint metrics such as temperature / Swap / uptime), so even a leak yields nothing actionable.

### 3. Server-pushed sampling interval / collection policy
This is another variant of a command channel (server influencing agent behaviour). We fix sampling logic locally on the agent; the server neither pushes nor knows it, preserving the isolation that "a breach of either side cannot affect the other."

### 4. Using agents as jump hosts to probe third parties
A natural consequence of the above. With no command channel and no externally controllable command invocation, an agent can never be induced to contact an attacker-chosen target.

> Note: dashboards, metric history charts, node grouping, alerting on existing metrics, backup/restore and the theme market are fully provided — they only read data the agent already reported or operate on the server, and rely on no downstream command. In one line: we trade the convenience of "letting the server command agents to do work" for the isolation that "a breach of either the server or any agent cannot spread to the other."

---

## Network-quality self-test (fixed public targets)

The agent runs TCP / HTTP(S) probes against **public infrastructures hardcoded in its local config**
(default: China Mobile portal + CT/CU carrier DNS + 8.8.8.8) from its own host and reports each target's
latency and reachability. It is the safe equivalent of the "centralised active probing" feature we refuse
to implement:

- **Targets are local**: configured via `PROBE_TARGETS`, format `label:host[:port]` (TCP) or `label:http(s)://host/path` (HTTP; HTTPS also reports certificate days left), comma-separated; works out of the box, empty disables. The server **never** pushes a probe target — the fundamental divide from command-channel monitors.
- **No command channel**: the server cannot order any agent to probe an arbitrary host, so the fleet can never become a distributed probe jump host. The core pillars stay intact.
- **Only latency and reachability**: each target reports `ms` and `ok` (three states: reachable / unreachable / `null` = resolve or handshake timeout, i.e. no sample), plus `cert_days` for https — no host fingerprint of any kind.
- **Works unprivileged**: TCP is a plain handshake (three attempts, 900 ms per attempt); HTTP is one full request (5 s deadline, reads 4 KiB then discards, does not follow redirects). No `ping` raw-socket privilege is required. Targets are probed in parallel, adding ~1–2 s per cycle.
- **Display**: agent cards show a "network" line (e.g. `CM 18ms · CT 23ms · CU ✕`); the detail page renders a multi-series ECharts chart of latency per target.

> Note: this capability only measures "this host → fixed public IP" network quality. It is entirely different from "letting the server orchestrate agents to probe arbitrary targets", which remains deliberately unimplemented.

> Live traffic rates are another example of a safe enhancement: rates are computed locally on the agent from two samples (`net_rx_rate`/`net_tx_rate`), shipped through the existing report channel and displayed by frontend polling — no command channel added, no fingerprint collected.

---

## Remote dynamic config / self-update: why we reject it

Some monitors let the server push config to agents (e.g. an `X-Agent-Config-Md5` response header carrying
sampling interval, traffic correction and probe targets, hot-reloaded without a restart) and let agents
self-update by fetching an install script and running `bash -s install` as root. Both are command channels,
precisely what this project omits.

- **Trust boundary collapse**: a server→agent downlink implicitly trusts the server. Once compromised, the attacker can push instructions to *every* agent, turning the fleet into remotely controllable nodes (or a distributed probe jump host).
- **Code-execution surface**: auto-update `bash -s install` hands root execution to "remote script + script source". If the source/CDN is MITM'd or supply-chain poisoned, agents run arbitrary scripts as root.
- **Consistent with the no-fingerprint rule**: server-pushed sampling policy or probe targets are just another variant of "server influences agent behaviour" — rejected wholesale.

Our approach is **local-fixed, one-way report**: sampling logic is hardcoded in the agent; probe targets
are hardcoded locally in `PROBE_TARGETS` (default `CM:www.10086.cn:443,CT:101.226.4.6,CU:202.106.0.20,GG:8.8.8.8`,
where `CM` is the China Mobile portal because carrier DNS rejects TCP outright); the server never pushes
anything at runtime; updating an agent is an admin action on the host itself.

> **Batch distribution is not self-update.** The packages the dashboard generates use one-time HMAC-signed
> links, are executed by an admin on the node, only replace the binary and roll back on checksum failure.
> The agent never learns "a new version exists" and never fetches anything itself — that human step is the difference.

> **Supply-chain integrity (L-6)**: the agent installer enforces the `.sha256` shipped with the release;
> a missing checksum refuses installation (fail closed). Release artifacts also carry an ed25519 `.sig`,
> which the relay verifies before forwarding.

> Note: GPU model (from `nvidia-smi` / `lspci`) is a host fingerprint and conflicts with our
> "no kernel/GPU/public-IP" rule, so we do not implement GPU monitoring either.

---

## 📄 License

[MIT](LICENSE)
