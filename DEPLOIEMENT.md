# Mettre le logiciel en ligne sur un VPS Hostinger

Durée : environ 20 minutes, dont 5 à 10 minutes d'installation automatique.
Résultat : le logiciel accessible en **HTTPS** depuis n'importe quel appareil, protégé par votre mot de passe,
avec une sauvegarde automatique chaque nuit.

---

## 1. Commander le VPS

1. Sur hostinger.fr, choisissez **VPS → KVM 1** (largement suffisant ; KVM 2 si vous voulez plus de marge).
2. Système d'exploitation : **Ubuntu 24.04** (la version « simple », **sans** panneau de contrôle).
3. Emplacement du serveur : **France** (ou un autre pays d'Europe).
4. Définissez un **mot de passe root** solide et notez-le.
5. Attendez que le VPS soit prêt, puis notez son **adresse IP** (dans hPanel → VPS → Vue d'ensemble).

## 2. Créer un jeton GitHub (lecture seule)

Le dépôt du logiciel est privé : le serveur a besoin d'un jeton pour le télécharger.

1. Sur github.com : votre photo → **Settings** → **Developer settings** → **Personal access tokens** →
   **Fine-grained tokens** → **Generate new token**.
2. Nom : `VPS facturation` — Expiration : 1 an (ou plus).
3. **Repository access** : *Only select repositories* → `site-FRE2G`.
4. **Permissions** → *Repository permissions* → **Contents : Read-only**. Rien d'autre.
5. **Generate token**, puis copiez le jeton (il commence par `github_pat_`). Il ne sera plus affiché ensuite.

Ce jeton ne peut que **lire** ce dépôt. Il est conservé sur le serveur (lisible par l'administrateur seulement)
pour les mises à jour ; vous pouvez le révoquer à tout moment sur GitHub.

## 3. Lancer l'installation

1. Ouvrez un terminal sur le VPS : hPanel → VPS → **Terminal du navigateur**
   (ou, depuis votre ordinateur : `ssh root@ADRESSE_IP`).
2. Copiez-collez ces deux lignes, en remplaçant `VOTRE_JETON` par le jeton de l'étape 2 :

```bash
export GITHUB_TOKEN="VOTRE_JETON"
curl -fsSL -H "Authorization: token $GITHUB_TOKEN" https://raw.githubusercontent.com/gabrielhaddad80-tech/site-FRE2G/claude/invoice-quote-software-tdb10o/deploy/install.sh | bash
```

3. Patientez. À la fin, le script affiche :

```
✔ Installation terminée

  Adresse du logiciel :  https://72-61-10-20.sslip.io
  Code de première connexion :  4833-3817
```

Sans nom de domaine, l'adresse est construite à partir de l'IP du serveur (service gratuit **sslip.io**) :
c'est ce qui permet d'avoir le HTTPS tout de suite.

## 4. Première connexion

1. Ouvrez l'adresse affichée (le cadenas peut mettre jusqu'à une minute à apparaître la toute première fois).
2. Saisissez le **code de première connexion**, votre nom, votre e-mail et un mot de passe (10 caractères minimum).
3. Dans **Paramètres** : renseignez votre entreprise (SIRET, adresse, IBAN, logo…) et, si vous voulez l'assistant IA,
   votre clé API Anthropic.
4. Ajoutez des comptes pour vos collègues dans **Paramètres → Utilisateurs et sécurité**.

Le code a disparu de l'écran ? Dans le terminal : `journalctl -u facturation -n 20`.

## 5. Plus tard : votre nom de domaine

1. Achetez un domaine (chez Hostinger ou ailleurs), par exemple `fre2g.fr`.
2. Dans la zone DNS du domaine, créez un enregistrement **A** : nom `factures` → valeur : **l'adresse IP du VPS**.
3. Une fois le DNS propagé (souvent moins d'une heure), dans le terminal du VPS :

```bash
facturation-domaine factures.fre2g.fr
```

Le certificat HTTPS est obtenu automatiquement. Vos données ne changent pas.

## Au quotidien

| Besoin | Commande (terminal du VPS) |
|---|---|
| Installer la dernière version du logiciel | `facturation-update` (sauvegarde la base avant) |
| Voir si le logiciel tourne | `systemctl status facturation` |
| Voir les derniers messages / erreurs | `journalctl -u facturation -n 50` |
| Redémarrer le logiciel | `systemctl restart facturation` |
| Mot de passe oublié | `facturation-mot-de-passe vous@email.fr NouveauMotDePasse` |
| Sauvegardes (30 derniers jours) | dossier `/var/backups/facturation` |

**Récupérer une sauvegarde sur votre ordinateur** (depuis votre ordinateur) :
`scp root@ADRESSE_IP:/var/backups/facturation/facturation-AAAA-MM-JJ.db .`
Vous pouvez aussi utiliser **Paramètres → Télécharger une sauvegarde** dans le logiciel.

**Clé de l'assistant IA par le serveur** (au lieu de Paramètres) : ajoutez `ANTHROPIC_API_KEY=...` dans
`/etc/facturation/facturation.env`, puis `systemctl restart facturation`.

## En cas de problème

- **La page ne s'ouvre pas / pas de cadenas** : si vous avez activé le pare-feu dans hPanel (VPS → Sécurité →
  Pare-feu), autorisez les ports **80** et **443** (TCP). Puis `journalctl -u caddy -n 50` pour le détail.
- **« impossible de récupérer le dépôt »** : jeton expiré ou sans accès au dépôt `site-FRE2G` (refaites l'étape 2,
  puis relancez l'étape 3 : le script peut être relancé sans risque).
- **Le logiciel ne démarre pas** : `journalctl -u facturation -n 50` et envoyez-moi le message.
- **« Export PDF indisponible »** (installation faite avant l'arrivée de l'export PDF) :
  `sudo bash /opt/facturation/deploy/chrome.sh` puis `sudo systemctl restart facturation`.

## Ce que fait le script (pour information)

- installe Node.js 22, Caddy (serveur web HTTPS automatique), SQLite et le pare-feu ;
- installe Google Chrome sans interface et des polices, utilisés pour créer les **PDF** des devis et factures
  (`deploy/chrome.sh`) ;
- télécharge le logiciel dans `/opt/facturation` ; les données sont dans `/var/lib/facturation` ;
- le lance comme service système (redémarrage automatique, utilisateur dédié sans privilèges) ;
- configure Caddy en HTTPS devant le logiciel, n'ouvre que SSH, HTTP et HTTPS ;
- programme une sauvegarde de la base chaque nuit (conservée 30 jours) ;
- installe les commandes `facturation-update`, `facturation-domaine` et `facturation-mot-de-passe`.

Il peut être relancé à tout moment : il met l'installation à jour sans toucher aux données.
