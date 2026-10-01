#!/usr/bin/env bash
# Installation du logiciel de facturation FRE2G sur un VPS Ubuntu 22.04 / 24.04 (Hostinger ou autre).
# À lancer en root. Réexécutable sans risque : il met à jour l'installation existante.
#
#   export GITHUB_TOKEN=...     (jeton GitHub en lecture seule, dépôt privé)
#   export DOMAIN=...           (facultatif : votre nom de domaine ; sinon adresse <ip>.sslip.io)
#   curl -fsSL -H "Authorization: token $GITHUB_TOKEN" \
#     https://raw.githubusercontent.com/gabrielhaddad80-tech/site-FRE2G/claude/invoice-quote-software-tdb10o/deploy/install.sh | bash
set -euo pipefail

main() {
REPO="${REPO:-gabrielhaddad80-tech/site-FRE2G}"
BRANCH="${BRANCH:-claude/invoice-quote-software-tdb10o}"
APP_DIR=/opt/facturation
DATA_DIR=/var/lib/facturation
CONF_DIR=/etc/facturation
BACKUP_DIR=/var/backups/facturation
APP_USER=facturation
PORT=3000

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mErreur : %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "lancez ce script en root (ou avec sudo)."
. /etc/os-release 2>/dev/null || true
[ "${ID:-}" = "ubuntu" ] || [ "${ID:-}" = "debian" ] || fail "système non pris en charge (${PRETTY_NAME:-inconnu}) : utilisez Ubuntu 22.04 ou 24.04."

mkdir -p "$CONF_DIR"
chmod 700 "$CONF_DIR"
# Jeton GitHub : conservé (lisible par root uniquement) pour les mises à jour
if [ -n "${GITHUB_TOKEN:-}" ]; then
  printf '%s' "$GITHUB_TOKEN" > "$CONF_DIR/github-token"
  chmod 600 "$CONF_DIR/github-token"
fi
[ -s "$CONF_DIR/github-token" ] || fail "jeton GitHub manquant : faites « export GITHUB_TOKEN=... » avant de lancer le script (voir DEPLOIEMENT.md)."
TOKEN="$(cat "$CONF_DIR/github-token")"

say "Installation des paquets système"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git build-essential python3 sqlite3 ufw debian-keyring debian-archive-keyring apt-transport-https >/dev/null

if ! command -v node >/dev/null || ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)'; then
  say "Installation de Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

if ! command -v caddy >/dev/null; then
  say "Installation de Caddy (serveur web HTTPS)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi

say "Récupération du logiciel (branche $BRANCH)"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
AUTH_HEADER="Authorization: Basic $(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" -c http.extraHeader="$AUTH_HEADER" fetch -q origin "$BRANCH"
  git -C "$APP_DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
else
  rm -rf "$APP_DIR"
  git -c http.extraHeader="$AUTH_HEADER" clone -q --branch "$BRANCH" "https://github.com/$REPO.git" "$APP_DIR" \
    || fail "impossible de récupérer le dépôt : vérifiez le jeton GitHub (accès en lecture au dépôt $REPO)."
fi
cd "$APP_DIR"
say "Installation des dépendances"
npm ci --omit=dev --no-audit --no-fund --loglevel=error

say "Navigateur pour l'export PDF"
bash "$APP_DIR/deploy/chrome.sh"

mkdir -p "$DATA_DIR" "$BACKUP_DIR"
chown "$APP_USER:$APP_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

# Adresse du site : domaine fourni, domaine déjà configuré, ou <ip>.sslip.io (HTTPS sans nom de domaine)
if [ -z "${DOMAIN:-}" ] && [ -s "$CONF_DIR/domain" ]; then DOMAIN="$(cat "$CONF_DIR/domain")"; fi
if [ -z "${DOMAIN:-}" ]; then
  IP="$(curl -4 -fsS --max-time 10 https://api.ipify.org || true)"
  [ -n "$IP" ] || fail "adresse IP publique introuvable : relancez avec « export DOMAIN=votre-domaine.fr »."
  DOMAIN="${IP//./-}.sslip.io"
fi
printf '%s' "$DOMAIN" > "$CONF_DIR/domain"

say "Configuration du service"
ENV_FILE="$CONF_DIR/facturation.env"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<ENV
# Réglages du logiciel (relancez « systemctl restart facturation » après modification)
NODE_ENV=production
HOST=127.0.0.1
PORT=$PORT
DB_FILE=$DATA_DIR/facturation.db
TRUST_PROXY=1
# Clé de l'assistant IA (sinon, à saisir dans Paramètres) :
# ANTHROPIC_API_KEY=
ENV
fi
chown root:"$APP_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

cat > /etc/systemd/system/facturation.service <<UNIT
[Unit]
Description=Logiciel de facturation FRE2G
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/caddy/Caddyfile <<CADDY
# Généré par deploy/install.sh
$DOMAIN {
	encode zstd gzip
	request_body {
		max_size 30MB
	}
	header Strict-Transport-Security "max-age=31536000"
	reverse_proxy 127.0.0.1:$PORT
}
CADDY

say "Sauvegarde automatique chaque nuit"
cat > /etc/cron.daily/facturation-backup <<'CRON'
#!/bin/sh
# Copie cohérente de la base, conservée 30 jours
set -e
mkdir -p /var/backups/facturation
sqlite3 /var/lib/facturation/facturation.db ".backup '/var/backups/facturation/facturation-$(date +%F).db'"
find /var/backups/facturation -name 'facturation-*.db' -mtime +30 -delete
CRON
chmod 755 /etc/cron.daily/facturation-backup

# Commandes pratiques
install -m 755 "$APP_DIR/deploy/update.sh" /usr/local/bin/facturation-update
install -m 755 "$APP_DIR/deploy/domain.sh" /usr/local/bin/facturation-domaine
cat > /usr/local/bin/facturation-mot-de-passe <<'PW'
#!/bin/sh
# Réinitialise le mot de passe d'un compte : facturation-mot-de-passe vous@email.fr NouveauMotDePasse
[ "$(id -u)" -eq 0 ] || { echo "Lancez : sudo facturation-mot-de-passe vous@email.fr NouveauMotDePasse" >&2; exit 1; }
set -a; . /etc/facturation/facturation.env; set +a
cd /opt/facturation && exec runuser -u facturation -- node scripts/reset-password.js "$@"
PW
chmod 755 /usr/local/bin/facturation-mot-de-passe

say "Pare-feu (SSH, HTTP, HTTPS)"
# Ports SSH réellement utilisés (pour ne jamais couper l'accès en cours)
for p in $(sshd -T 2>/dev/null | awk '$1=="port"{print $2}'); do ufw allow "$p/tcp" >/dev/null; done
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

say "Démarrage"
systemctl daemon-reload
systemctl enable -q facturation caddy
systemctl restart facturation
systemctl reload caddy 2>/dev/null || systemctl restart caddy

for _ in $(seq 1 20); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/login.html" && break
  sleep 1
done
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/login.html" || fail "le logiciel ne démarre pas : consultez « journalctl -u facturation -n 50 »."

CODE="$(journalctl -u facturation -n 30 --no-pager 2>/dev/null | grep -o '[0-9]\{4\}-[0-9]\{4\}' | tail -1 || true)"

printf '\n\033[1;32m✔ Installation terminée\033[0m\n\n'
printf '  Adresse du logiciel :  https://%s\n' "$DOMAIN"
if [ -n "$CODE" ]; then
  printf '  Code de première connexion :  %s\n' "$CODE"
  printf '  (ouvrez l’adresse, saisissez ce code puis créez votre compte)\n'
else
  printf '  Un compte existe déjà : connectez-vous avec votre e-mail et votre mot de passe.\n'
fi
printf '\n  Le certificat HTTPS est obtenu automatiquement (jusqu’à 1 minute la première fois).\n'
printf '  Mettre à jour le logiciel :      facturation-update\n'
printf '  Passer à votre nom de domaine :  facturation-domaine factures.mon-domaine.fr\n'
  printf '  Mot de passe oublié :            facturation-mot-de-passe vous@email.fr NouveauMotDePasse\n'
printf '  Sauvegardes quotidiennes :       %s\n\n' "$BACKUP_DIR"
}

main "$@"
