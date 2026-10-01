#!/usr/bin/env bash
# Durcissement du serveur : lancé par install.sh et à chaque facturation-update (sans risque de le relancer).
#  - fail2ban : bloque 1 h les adresses qui échouent 5 fois à se connecter en SSH
#  - correctifs de sécurité d'Ubuntu installés automatiquement chaque jour
#  - sauvegardes de la base lisibles par l'administrateur seulement (elles contiennent toutes les données)
set -uo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Lancez : sudo bash $0" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

if ! command -v fail2ban-client >/dev/null || ! dpkg -s unattended-upgrades >/dev/null 2>&1; then
  apt-get install -y -qq fail2ban unattended-upgrades >/dev/null 2>&1 || echo "Attention : fail2ban / unattended-upgrades non installés." >&2
fi
if [ -d /etc/fail2ban ]; then
  mkdir -p /etc/fail2ban/jail.d
  cat > /etc/fail2ban/jail.d/facturation.local <<'F2B'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
F2B
  systemctl enable -q fail2ban 2>/dev/null
  systemctl restart fail2ban 2>/dev/null || echo "Attention : fail2ban n'a pas démarré (journalctl -u fail2ban)." >&2
fi
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'APT'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT

mkdir -p /var/backups/facturation
chmod 700 /var/backups/facturation
chmod 600 /var/backups/facturation/*.db 2>/dev/null || true
cat > /etc/cron.daily/facturation-backup <<'CRON'
#!/bin/sh
# Copie cohérente de la base, conservée 30 jours, lisible par l'administrateur seulement
set -e
umask 077
mkdir -p /var/backups/facturation
chmod 700 /var/backups/facturation
sqlite3 /var/lib/facturation/facturation.db ".backup '/var/backups/facturation/facturation-$(date +%F).db'"
find /var/backups/facturation -name 'facturation-*.db' -mtime +30 -delete
CRON
chmod 755 /etc/cron.daily/facturation-backup
# Fichier de réglages (clé API éventuelle) : root et le service uniquement
[ -f /etc/facturation/facturation.env ] && chmod 640 /etc/facturation/facturation.env
exit 0
