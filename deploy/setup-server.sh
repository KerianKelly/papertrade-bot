#!/usr/bin/env bash
# One-time setup of a fresh Hetzner Ubuntu 24.04 server. Run as root (deploy.sh --setup does this for you).
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get -yq upgrade
apt-get install -yq curl ca-certificates rsync ufw unattended-upgrades chrony

# Node 22
if ! node --version 2>/dev/null | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
fi

# Unprivileged user that runs the bot
id bot >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin bot
mkdir -p /opt/papertrade-bot/logs /opt/papertrade-bot/state
chown -R bot:bot /opt/papertrade-bot

# Accurate clock (intents carry deadlines) and security updates
timedatectl set-timezone UTC
systemctl enable --now chrony
dpkg-reconfigure -f noninteractive unattended-upgrades

# Firewall: SSH only. SSH by key only.
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable
cat > /etc/ssh/sshd_config.d/99-papertrade.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
systemctl reload ssh

install -m 644 /opt/papertrade-bot/deploy/papertrade-bot.service /etc/systemd/system/papertrade-bot.service
systemctl daemon-reload
systemctl enable papertrade-bot   # starts on boot; not started here
echo "server ready (node $(node --version))"
