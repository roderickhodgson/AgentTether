#!/usr/bin/env bash
# One-time server bootstrap for the GitHub auto-deploy (see deploy/README.md, §1).
# Run as the default EC2 user via sudo:
#
#   scp deploy/bootstrap-ec2.sh ubuntu@<ec2-host>:
#   ssh ubuntu@<ec2-host> 'sudo bash bootstrap-ec2.sh'
#
# IDEMPOTENT — safe to re-run. The intended sequence is: run → fill .env and add
# the printed deploy key on GitHub → run again (every step skips what's done;
# the second run finishes prisma + the service). Secrets never pass through
# GitHub: the payer key and DATABASE_URL are typed straight into the box's .env.
set -euo pipefail

APP_DIR="/opt/agenttether"
APP_USER="agenttether"
REPO_SSH="git@github.com:roderickhodgson/AgentTether.git"
NODE_MAJOR=25

# ── 1. packages: git + node (nodesource) ─────────────────────────────────────
if ! command -v node > /dev/null 2>&1 || ! node -p 'process.versions.node' 2>/dev/null | grep -q "^${NODE_MAJOR}\."; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi
echo "node $(node -v)"

# ── 2. app user — home IS the app dir, matching the systemd unit ─────────────
if ! id -u "$APP_USER" > /dev/null 2>&1; then
  useradd -r -m -d "$APP_DIR" -s /usr/sbin/nologin "$APP_USER"
fi

# ── 3. read-only deploy keypair — the repo's read credential on this box ─────
KEY_DIR="$APP_DIR/.ssh"
install -d -m 700 -o "$APP_USER" -g "$APP_USER" "$KEY_DIR"
if [ ! -f "$KEY_DIR/id_ed25519" ]; then
  sudo -u "$APP_USER" ssh-keygen -t ed25519 -N '' -f "$KEY_DIR/id_ed25519" -q
fi
ssh-keyscan -t ed25519,rsa github.com > "$KEY_DIR/known_hosts" 2>/dev/null
chown "$APP_USER:$APP_USER" "$KEY_DIR/known_hosts"
echo "──────────────────────────────────────────────────────────────"
echo "add this READ-ONLY deploy key at:"
echo "  https://github.com/roderickhodgson/AgentTether/settings/keys"
sudo -u "$APP_USER" cat "$KEY_DIR/id_ed25519.pub"
echo "──────────────────────────────────────────────────────────────"

# ── 4. clone (git init + fetch — the .ssh dir above would block plain clone) ─
if [ ! -d "$APP_DIR/.git" ]; then
  sudo -u "$APP_USER" git init -q "$APP_DIR"
  sudo -u "$APP_USER" git -C "$APP_DIR" remote add origin "$REPO_SSH"
fi
if ! sudo -u "$APP_USER" git -C "$APP_DIR" fetch -q origin main; then
  echo "fetch failed — add the deploy key printed above to GitHub, then re-run this script" >&2
  exit 1
fi
sudo -u "$APP_USER" git -C "$APP_DIR" checkout -qf -B main origin/main

# ── 5. .env scaffold (from the freshly fetched tree) ─────────────────────────
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
fi

# ── 6. install + migrate, but only once DATABASE_URL is real ─────────────────
PRISMA_DONE=0
if grep -qE '^DATABASE_URL=(postgresql|postgres)://' "$APP_DIR/.env"; then
  sudo -u "$APP_USER" bash -c "cd '$APP_DIR' && npm ci --no-audit --no-fund && npx prisma generate && npx prisma db push --skip-generate"
  PRISMA_DONE=1
else
  echo "→ DATABASE_URL is still a placeholder — fill $APP_DIR/.env now, then re-run this script."
fi

# ── 7. swapfile if the box has none (same policy as deploy.sh) ───────────────
if [ ! -f /swapfile ] && [ -z "$(swapon --show --noheadings 2>/dev/null || true)" ]; then
  echo "no swap active — creating /swapfile (2G)"
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap -q /swapfile
  swapon /swapfile
fi
if [ -f /swapfile ] && ! swapon --show=NAME --noheadings 2>/dev/null | grep -q '^/swapfile$'; then
  swapon /swapfile 2>/dev/null || true
fi
if ! grep -qE '^/swapfile ' /etc/fstab; then
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
if [ ! -e /etc/sysctl.d/99-agenttether-swap.conf ]; then
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-agenttether-swap.conf
fi
sysctl -qw vm.swappiness=10 2>/dev/null || true

# ── 8. systemd unit + start ──────────────────────────────────────────────────
cp "$APP_DIR/deploy/agenttether.system.service" /etc/systemd/system/agenttether.service
systemctl daemon-reload
systemctl enable -q agenttether
if [ "$PRISMA_DONE" = 1 ]; then
  systemctl restart agenttether
  sleep 3
  if curl -fsS --max-time 3 http://127.0.0.1:8080/healthz > /dev/null 2>&1; then
    echo "backend is up — pushes to main now deploy automatically"
  else
    echo "service started but healthz not green yet — check: journalctl -u agenttether -f"
  fi
else
  echo "service installed (not started yet) — re-run after filling .env"
fi
