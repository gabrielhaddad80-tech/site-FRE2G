#!/usr/bin/env bash
# Met à jour le logiciel depuis GitHub puis le redémarre (sauvegarde de la base avant).
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Lancez : sudo facturation-update" >&2; exit 1; }
APP_DIR=/opt/facturation
TOKEN="$(cat /etc/facturation/github-token)"
BRANCH="$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD)"
AUTH_HEADER="Authorization: Basic $(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)"

mkdir -p /var/backups/facturation
if [ -f /var/lib/facturation/facturation.db ]; then
  sqlite3 /var/lib/facturation/facturation.db ".backup '/var/backups/facturation/avant-mise-a-jour-$(date +%F-%H%M).db'"
fi
git -C "$APP_DIR" -c http.extraHeader="$AUTH_HEADER" fetch -q origin "$BRANCH"
BEFORE="$(git -C "$APP_DIR" rev-parse HEAD)"
git -C "$APP_DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
AFTER="$(git -C "$APP_DIR" rev-parse HEAD)"
if [ "$BEFORE" = "$AFTER" ]; then
  # Navigateur pour l'export PDF (installations faites avant cette fonction)
  [ -f "$APP_DIR/deploy/chrome.sh" ] && bash "$APP_DIR/deploy/chrome.sh" >/dev/null
  echo "Déjà à jour."; exit 0
fi
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
bash deploy/chrome.sh
install -m 755 deploy/update.sh /usr/local/bin/facturation-update
install -m 755 deploy/domain.sh /usr/local/bin/facturation-domaine
systemctl restart facturation
echo "Mis à jour : $(git -C "$APP_DIR" log -1 --format='%h %s')"
