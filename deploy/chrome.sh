#!/usr/bin/env bash
# Installe un navigateur Chrome sans interface pour l'export PDF des devis et factures (+ polices).
# Appelé par install.sh et facturation-update ; peut aussi être lancé seul : sudo bash deploy/chrome.sh
# Sans navigateur, le logiciel fonctionne normalement : seul le bouton « PDF » affiche un message.
set -uo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Lancez : sudo bash $0" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

# Polices compatibles Arial / Helvetica pour un rendu identique à l'aperçu
apt-get install -y -qq fonts-liberation fonts-dejavu-core >/dev/null 2>&1 || true

for b in /usr/bin/google-chrome-stable /usr/bin/google-chrome /usr/bin/chromium /usr/bin/chromium-browser; do
  # chromium-browser d'Ubuntu n'est qu'un raccourci vers snap : non utilisable par le service
  if [ -x "$b" ] && ! grep -qs snap "$b"; then echo "Navigateur pour l'export PDF : $b"; exit 0; fi
done

if [ "$(dpkg --print-architecture)" = "amd64" ]; then
  echo "Installation de Google Chrome (export PDF)…"
  tmp="$(mktemp --suffix=.deb)"
  if curl -fsSL -o "$tmp" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
     && apt-get install -y -qq "$tmp" >/dev/null; then
    rm -f "$tmp"
    echo "Navigateur pour l'export PDF : /usr/bin/google-chrome-stable"
    exit 0
  fi
  rm -f "$tmp"
fi

# Autres processeurs (ARM) : Chromium des dépôts Debian (sous Ubuntu, il n'existe qu'en snap)
. /etc/os-release 2>/dev/null || true
if [ "${ID:-}" = "debian" ] && apt-get install -y -qq chromium >/dev/null 2>&1; then
  echo "Navigateur pour l'export PDF : /usr/bin/chromium"
  exit 0
fi

echo "Attention : navigateur non installé, l'export PDF ne sera pas disponible (l'export Word fonctionne)." >&2
echo "Vous pouvez indiquer un navigateur existant avec CHROME_PATH=... dans /etc/facturation/facturation.env" >&2
exit 0
