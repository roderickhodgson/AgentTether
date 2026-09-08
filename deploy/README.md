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

## 1. Backend on EC2 (Ubuntu)

```bash
# one-time server prep (Ubuntu 24.04 LTS; t3.micro is plenty)
sudo apt update && sudo apt install -y git curl
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash   # or nodesource
nvm install 25 && nvm alias default 25

# app
sudo useradd -r -m -d /opt/agenttether -s /usr/sbin/nologin agenttether
sudo git clone <repo-url> /opt/agenttether && sudo chown -R agenttether: /opt/agenttether
cd /opt/agenttether
sudo -u agenttether npm ci && sudo -u agenttether npx prisma generate

# secrets + env (NEVER commit .env) — this server's own database, not your laptop's
sudo -u agenttether cp .env.example .env    # then edit:
#   DATABASE_URL=<production Neon url>   SUBSTREAMS_API_KEY=<key>
#   EVM_PRIVATE_KEY=<payer key>          PAY_TO_ADDRESS=<receiver>
#   PUBLIC_SITE_URL=https://<your-netlify-site>     # report links point at the web tier
#   PUBLIC_BASE_URL=https://api.<your-domain>       # the backend's own https base
#   RECENT_INTENTS_LIMIT=5

sudo -u agenttether npx prisma db push      # schema onto the production database
```

Service: `sudo cp deploy/agenttether.system.service /etc/systemd/system/agenttether.service`
(edit `User=`/paths if yours differ), then `daemon-reload` + `enable --now` — see the
unit header for commands. Security group: **22** (ssh), **80 + 443** (TLS redirect +
proxy). The single-writer lease decides who streams: once the EC2 daemon claims the
lease, any local `npm start` correctly exits instead of double-metering.

## 2. HTTPS in front of the backend (mandatory)

The Netlify pages are `https` — browsers block them from fetching a plain-`http` API
(mixed content). Two paths:

**a) Real domain (primary, once you have DNS):** point an A record at the EC2 IP and
put Caddy in front (auto-TLS, no cert ceremony):

```
# /etc/caddy/Caddyfile
api.your-domain.xyz {
    reverse_proxy localhost:8080
}
```
`sudo apt install caddy`, paste, `sudo systemctl reload caddy`. Set
`PUBLIC_BASE_URL=https://api.your-domain.xyz` in the backend `.env`.

**b) No DNS yet (interim):** a Cloudflare tunnel gives you an https URL in one command:

```bash
cloudflared tunnel --url http://localhost:8080   # prints https://<random>.trycloudflare.com
```
Set `PUBLIC_BASE_URL` to that URL. Tunnels are ephemeral on the free tier — fine for a
demo session, replace with (a) for anything persistent.

## 3. Web on Netlify

```bash
# set the API base the pages will use in production:
$EDITOR web/config.js    # window.AGENTTETHER_API = "https://api.your-domain.xyz";
npx netlify deploy --prod --dir web
```
Then set the backend's `PUBLIC_SITE_URL` to the Netlify URL (`https://<site>.netlify.app`)
and restart the service — report links in the 202 bodies and webhooks point there. The
`/w/:id` deep links work via the rewrite in `netlify.toml`; `?api=` still overrides per
URL (pointing a deployed site at a tunnelled local backend needs no redeploy).

## 4. Production env matrix

| Var | Tier | Purpose |
|---|---|---|
| `PUBLIC_SITE_URL` | backend | where report links point (the web tier) |
| `PUBLIC_BASE_URL` | backend | the backend's own https base (tunnel/domain) |
| `RECENT_INTENTS_LIMIT` | backend | home-page recent list size (query param caps at 20) |
| `web/config.js` | web tier | the API base the pages fetch |

## 5. Local, still-first

Nothing above is required to develop: backend `npm start` (API-only on `:8080`), web
`npx netlify dev` (`:8888`) with `?api=http://localhost:8080`, agent on demand — see
the README's Services table.
