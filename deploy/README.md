# Deploying AgentTether as a daemon

The backend is a long-lived single process (API + Substreams stream + settlement
sweeps), so it belongs under a supervisor. Two unit files are provided — pick the one
for your OS. In both cases the **single-writer lease** (src/lease.ts) makes it safe to
run the daemon and manual instances side by side: only the lease holder streams.

## macOS — launchd

```bash
mkdir -p ~/Library/Logs/AgentTether   # launchd won't create the log dir itself
cp deploy/com.agenttether.backend.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.agenttether.backend.plist

launchctl print gui/$(id -u)/com.agenttether.backend   # status
tail -f ~/Library/Logs/AgentTether/backend.log         # app logs (pino)
tail -f ~/Library/Logs/AgentTether/backend.err.log     # stderr

launchctl bootout gui/$(id -u)/com.agenttether.backend # stop
```

`launchctl bootout` sends SIGTERM — the backend stops the stream, **releases the
lease**, and exits, so the next start takes over immediately (no TTL wait).

## Linux — systemd (user unit)

```bash
mkdir -p ~/.config/systemd/user
cp deploy/agenttether.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agenttether

systemctl --user status agenttether
journalctl --user -u agenttether -f

systemctl --user stop agenttether    # graceful — releases the lease
```

## Restart semantics (why exit(1) on a held lease)

| Scenario | What happens |
|---|---|
| Graceful stop (`launchctl bootout`, `systemctl stop`, Ctrl-C) | Stream stops → lease released → next start owns it instantly |
| Crash (SIGKILL / power / panic) | Lease goes stale after 30s; supervisor restarts exit(1) during that window (`ThrottleInterval`/`RestartSec` pace it) and then take over |
| Second instance started while the daemon streams | Second instance exits non-zero immediately — never a silent API-only zombie |

Both supervisors retry on failure (launchd `KeepAlive` + `ThrottleInterval` 10s;
systemd `Restart=on-failure` + `RestartSec=10`), which is what turns the lease's
stale-takeover into seamless crash recovery.

## Notes

- `deploy/start.sh` resolves the node binary (nvm path baked in for this machine;
  override with `NODE_BIN=...`). It execs tsx directly so signals reach the backend.
- All secrets stay in `.env` (gitignored), loaded by dotenv from the working
  directory — nothing sensitive lives in the unit files.
- Bumped node versions: update the path in `start.sh` (and the plist `PATH`).
- The lease holder identity is `hostname:pid:started-at` — visible in the logs and in
  `select * from process_lease;` for forensic clarity.

---

# Cloud deployment: backend on EC2 + web on Netlify

The tiers are separate: **the backend is API-only** (x402 endpoints, lifecycle JSON,
annotate, recent) and **the web pages live on Netlify**. The pages carry their own API
base (`web/config.js`, overridable per-URL with `?api=`), so the only coupling is CORS —
which the report/recent/annotate endpoints already allow (`*`).

## 1. Backend on EC2 (Ubuntu) — auto-deployed from GitHub

One-time bootstrap, then every push to `main` deploys automatically. The bootstrap
script is idempotent — run it again after filling `.env` and adding the deploy key,
and it finishes the job:

```bash
scp deploy/bootstrap-ec2.sh ubuntu@<ec2-host>:
ssh ubuntu@<ec2-host> 'sudo bash bootstrap-ec2.sh'
```

What it does: installs node 25 (nodesource) + git; creates the `agenttether` system
user with home `/opt/agenttether` (matching the systemd unit); generates a
**read-only deploy keypair** and prints its public half — add it under
GitHub → Settings → Deploy keys (read-only access, nothing more); clones the repo;
scaffolds `.env` from `.env.example`; ensures the **swapfile** (below); runs
`npm ci` + `prisma generate` + `prisma db push` once `DATABASE_URL` is real; installs
Caddy and copies `deploy/Caddyfile` (the https front, §2a); installs
`agenttether.system.service` and starts the backend.

`.env` (edit on the box, never in GitHub): DATABASE_URL (this server's own Neon
database, not your laptop's), SUBSTREAMS_API_KEY, EVM_PRIVATE_KEY, PAY_TO_ADDRESS,
PUBLIC_SITE_URL (the web tier), PUBLIC_BASE_URL (the backend's https base),
RECENT_INTENTS_LIMIT.

**Repo secrets (Settings → Secrets and variables → Actions):** exactly two —

| Secret | Value |
|---|---|
| `EC2_HOST` | the instance's public DNS or IP (no protocol, no user) |
| `EC2_SSH_KEY` | the private half of a dedicated deploy keypair (public half goes into `ubuntu`'s `authorized_keys` — not your laptop key, not the AWS-launch PEM) |

**Swapfile:** micro instances ship without swap, and a downtime catch-up replay can
spike memory. Both scripts create a 2G `/swapfile` only when no swap is active
(`fallocate` → `mkswap` → `swapon`, fstab line guarded against dupes,
`vm.swappiness=10`). Verify with `swapon --show && free -h`.

**The deploy itself** (`.github/workflows/ci.yml` → `deploy-backend`): gated on both
test suites (`needs: [fast-suite, agent-suite]`); SSHes in as `ubuntu` and runs
`sudo /opt/agenttether/deploy/deploy.sh <sha>`, which builds **before** restarting
(old process keeps streaming — downtime is just the restart: graceful SIGTERM
releases the single-writer lease instantly, the new stream resumes from the cursor),
then gates on `healthz` (15 × 2s, failing the job loudly with service logs).
Rollback: **Run workflow** (dispatch) with the previous SHA.

Risk model, stated plainly: an approved push to `main` is root on this box (the
deploy path grants it). Keep the security group to 22 (ssh, ideally pinned to
GitHub Actions' IP ranges) + 80/443, key-only ssh, and treat `main` as protected.
The single-writer lease decides who streams: once the EC2 daemon claims the lease,
any local `npm start` correctly exits instead of double-metering.

**Idle stretches (data-plane off):** Substreams egress bills per byte streamed (~80 GB/month
head-streaming Ethereum), whether or not anyone is watching. For idle periods, set
`SUBSTREAMS_ENABLED=false` in the box's `.env` and restart — the daemon keeps serving
reads, intents and sweeps with **zero egress** (MONITORING intents simply time out
honestly, unbilled). `/healthz` carries the data-plane state: `stream: "disabled"`,
`"streaming"`, or `"degraded"` (last error included) — check it after toggling.

## 2. HTTPS in front of the backend (mandatory)

The Netlify pages are `https` — browsers block them from fetching a plain-`http` API
(mixed content). Two paths:

**a) Real domain (primary, once you have DNS):** point an A record at the EC2 IP and
put Caddy in front (auto-TLS, no cert ceremony):

```bash
sudo apt install caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

The repo's `deploy/Caddyfile` proxies `api.<domain>` → `localhost:8080` and adds an
HSTS header (api subdomain only — the apex/www live on Netlify). Ports 80/443 must be
open in the security group (ACME + TLS); `:8080` stays loopback-only. The express app
sets `trust proxy = loopback` (src/index.ts), so the per-IP rate limits key on the real
client IP from Caddy's `X-Forwarded-For`. Set
`PUBLIC_BASE_URL=https://api.<your-domain>` in the backend `.env`.

The **bootstrap (§1) does both steps automatically** — and it's safe to run before
DNS exists: Caddy's ACME fetch retries in the background, so TLS comes up the moment
the `api` A record resolves. Config refresh is bootstrap-only (same as the systemd
unit file): re-run `sudo bash bootstrap-ec2.sh` after changing the repo Caddyfile.
The manual commands above remain for out-of-band changes.

**b) No DNS yet (interim):** a Cloudflare tunnel gives you an https URL in one command:

```bash
cloudflared tunnel --url http://localhost:8080   # prints https://<random>.trycloudflare.com
```
Set `PUBLIC_BASE_URL` to that URL. Tunnels are ephemeral on the free tier — fine for a
demo session, replace with (a) for anything persistent.

## 3. Web on Netlify

The site is Git-imported: `config.js` is committed and **host-aware** — the production
base (`https://api.<domain>`) on any non-local host, `http://localhost:8080` when
served locally (`netlify dev` :8888, plain http servers, `file://`). Deploying is
`git push` (Netlify builds on main); `npx netlify deploy --prod --dir web` remains the
manual fallback.

Then set the backend's `PUBLIC_SITE_URL` to the web tier's https base
(`https://<domain>` or `https://<site>.netlify.app`) and restart the service — report
links in the 202 bodies and webhooks point there. The `/w/:id` deep links work via the
rewrite in `netlify.toml`; `?api=` still overrides per URL (pointing a deployed site at
a tunnelled local backend needs no redeploy).

## 4. Production env matrix

| Var | Tier | Purpose |
|---|---|---|
| `PUBLIC_SITE_URL` | backend | where report links point (the web tier) |
| `PUBLIC_BASE_URL` | backend | the backend's own https base (tunnel/domain) |
| `RECENT_INTENTS_LIMIT` | backend | home-page recent list size (query param caps at 20) |
| `SUBSTREAMS_ENABLED` | backend | `false` = run API-only, data plane off — zero Substreams egress (no matching; oneshot capture frozen). `/healthz` reports `stream: "disabled"`. Restart the service after changing it. |
| `web/config.js` | web tier | the API base the pages fetch (host-aware: prod base on non-local hosts, localhost when served locally; `?api=` overrides) |
| `RATE_LIMIT_WRITES_PER_MIN` | backend | per-IP cap on `POST /stream` (402 + verify) + annotate — public-surface abuse guard (default 30) |
| `RATE_LIMIT_READS_PER_MIN` | backend | per-IP cap on report/recent GETs — the hosted pages fetch these on every view (default 120) |

## 5. Local, still-first

Nothing above is required to develop: backend `npm start` (API-only on `:8080`), web
`npx netlify dev` (`:8888`) with `?api=http://localhost:8080`, agent on demand — see
the README's Services table.
