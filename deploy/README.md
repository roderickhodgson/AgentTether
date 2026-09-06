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
