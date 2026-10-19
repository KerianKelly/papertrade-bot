#!/usr/bin/env bash
# Deploy the bot from this Mac to the Hetzner server.
#
#   deploy/deploy.sh <server-ip> [--setup] [--with-secrets] [--start]
#
#   --setup         first time only: install Node, firewall, the systemd service
#   --with-secrets  copy .env (wallet key) and state/ (session key) over SSH; they never touch GitHub
#   --start         (re)start the bot. A restart closes any open cycle first.
#
# Never run the bot on the Mac and the server at the same time: each closes the other's positions on start.
set -euo pipefail

HOST="${1:?usage: deploy/deploy.sh <server-ip> [--setup] [--with-secrets] [--start]}"; shift
SETUP=0; SECRETS=0; START=0
for a in "$@"; do
  case "$a" in
    --setup) SETUP=1 ;; --with-secrets) SECRETS=1 ;; --start) START=1 ;;
    *) echo "unknown option $a"; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."
SSH=(ssh -o StrictHostKeyChecking=accept-new "root@$HOST")
DIR=/opt/papertrade-bot

npm run -s typecheck

"${SSH[@]}" "mkdir -p $DIR"
rsync -az --delete -e "ssh -o StrictHostKeyChecking=accept-new" \
  --exclude node_modules --exclude .git --exclude logs --exclude state --exclude .env --exclude research \
  ./ "root@$HOST:$DIR/"

if [ "$SETUP" = 1 ]; then "${SSH[@]}" "bash $DIR/deploy/setup-server.sh"; fi

if [ "$SECRETS" = 1 ]; then
  rsync -az -e "ssh -o StrictHostKeyChecking=accept-new" .env "root@$HOST:$DIR/.env"
  if [ -d state ]; then rsync -az -e "ssh -o StrictHostKeyChecking=accept-new" state/ "root@$HOST:$DIR/state/"; fi
fi

"${SSH[@]}" "set -e; cd $DIR; chown -R bot:bot .; chmod 600 .env 2>/dev/null || true; chmod 700 state; \
  install -m 644 deploy/papertrade-bot.service /etc/systemd/system/papertrade-bot.service; systemctl daemon-reload; \
  sudo -u bot -H npm ci --no-audit --no-fund --loglevel=error"

if [ "$START" = 1 ]; then
  "${SSH[@]}" "systemctl restart papertrade-bot && sleep 15 && journalctl -u papertrade-bot -n 15 --no-pager"
fi
echo "deployed to $HOST"
