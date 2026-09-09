#!/usr/bin/env bash
# Server-side deploy step for the GitHub auto-deploy (see deploy/README.md, §1).
# Runs as root — the workflow SSHes in as `ubuntu` and calls this via sudo.
#
#   deploy.sh <sha>
#
# Order matters: the app is BUILT before the restart, so the old process keeps
# streaming while npm/prisma run — the actual downtime is just the restart
# (graceful SIGTERM → the single-writer lease is released instantly and the new
# stream resumes from the persisted cursor). The healthz gate fails the deploy
# job loudly instead of leaving a broken box green. Idempotent + safe to re-run.
set -euo pipefail

SHA="${1:?usage: deploy.sh <sha>}"
APP_DIR="/opt/agenttether"
APP_USER="agenttether"
SERVICE="agenttether"
HEALTH_URL="http://127.0.0.1:8080/healthz"

# ── 1. swapfile if the box has none ──────────────────────────────────────────
# Micro instances ship without swap; the downtime catch-up replay can spike
# memory. Created once, persisted in fstab, kept lazy (swappiness=10).
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

# ── 2. build as the app user — the running process is untouched until step 3 ─
cd "$APP_DIR"
sudo -u "$APP_USER" git fetch origin main --quiet
sudo -u "$APP_USER" git checkout --force --quiet "$SHA"
echo "deploying $(git rev-parse --short HEAD)"
sudo -u "$APP_USER" npm ci --no-audit --no-fund
sudo -u "$APP_USER" npx prisma generate
sudo -u "$APP_USER" npx prisma db push --skip-generate

# ── 3. restart: graceful SIGTERM (stream stop → lease release) then re-exec ──
systemctl restart "$SERVICE"

# ── 4. health gate ───────────────────────────────────────────────────────────
for _ in $(seq 1 15); do
  if curl -fsS --max-time 3 "$HEALTH_URL" > /dev/null 2>&1; then
    echo "healthz OK — deploy complete at $(git rev-parse --short HEAD)"
    exit 0
  fi
  sleep 2
done
echo "healthz FAILED after restart — last 30 service log lines:" >&2
journalctl -u "$SERVICE" -n 30 --no-pager >&2 || true
exit 1
