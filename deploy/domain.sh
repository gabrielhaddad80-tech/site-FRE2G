#!/usr/bin/env bash
# Change l'adresse du logiciel (votre nom de domaine) ; le certificat HTTPS est obtenu automatiquement.
# Avant : créez chez votre registraire un enregistrement DNS de type A vers l'adresse IP du serveur.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Lancez : sudo facturation-domaine factures.mon-domaine.fr" >&2; exit 1; }
DOMAIN="${1:-}"
[[ "$DOMAIN" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$ ]] || { echo "Usage : facturation-domaine factures.mon-domaine.fr" >&2; exit 1; }
IP="$(curl -4 -fsS --max-time 10 https://api.ipify.org || true)"
RESOLVED="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
if [ -n "$IP" ] && [ "$RESOLVED" != "$IP" ]; then
  echo "Attention : $DOMAIN pointe vers « ${RESOLVED:-rien} » et non vers ce serveur ($IP)."
  echo "Créez l'enregistrement DNS A puis attendez sa propagation (souvent moins d'une heure)."
  exit 1
fi
printf '%s' "$DOMAIN" > /etc/facturation/domain
sed -i "0,/^[^#[:space:]].* {$/s//$DOMAIN {/" /etc/caddy/Caddyfile
systemctl reload caddy
echo "Le logiciel est maintenant accessible à l'adresse : https://$DOMAIN"
