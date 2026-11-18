# Guide de mise en service — ADV FRE2G avec agent IA

Ce guide explique **comment fonctionne** l'ADV et **comment la rendre opérationnelle**, étape par étape.

---

## 1. Ce que fait le système

L'ADV (Administration des Ventes) couvre tout le cycle de vente :

```
Demande client ─► Devis ─► Commande ─► Confirmation ─► Préparation ─► Expédition ─► Livraison ─► Facture ─► Encaissement
                    │                      │                                                       │             │
                    └ relance si pas de    └ accusé de réception                                   └ envoi       └ relances
                      réponse                (e-mail)                                                facture       impayés
```

**L'agent ADV** (basé sur Claude, d'Anthropic) fait ce travail à votre place :

| Vous lui donnez… | Il fait… |
|---|---|
| « Fais un devis pour Dupont SA : 20 PRD-001 + livraison » | Trouve le client, applique les prix du catalogue et sa remise, crée le devis, prépare l'e-mail d'envoi |
| Un e-mail ou un bon de commande PDF collé/joint | Identifie le client (ou le crée), enregistre la commande, signale les références inconnues et les stocks insuffisants, prépare l'accusé de réception |
| « Le client a accepté le devis DEV-2026-0012, son BC est 4587 » | Transforme le devis en commande, prépare l'accusé de réception |
| « La commande CMD-2026-0008 est partie chez DHL, suivi 123 » | Met à jour la commande, prépare l'avis d'expédition |
| « Facture les commandes livrées » | Émet les factures, prépare les envois |
| « Virement reçu de 1 200 € de Martin pour FAC-2026-0003 » | Enregistre le règlement (partiel ou total) |
| « Où en sommes-nous ? » | Synthèse : retards, devis en attente, commandes à facturer… |

**Chaque jour ouvré** (à 8 h par défaut), l'agent lance seul une **routine** : il met à jour les échéances, prépare les relances
d'impayés (ton gradué : courtoise → ferme → mise en demeure à faire valider), relance les devis sans réponse et rédige une synthèse.

### Garde-fous

- **Rien ne part chez un client sans votre validation** : chaque e-mail préparé arrive dans la **Boîte d'envoi**, où vous pouvez le relire,
  le corriger, l'envoyer ou le rejeter. (L'envoi automatique existe mais est désactivé par défaut.)
- L'agent **ne peut pas inventer de prix** : les lignes viennent du catalogue ; une référence inconnue est refusée.
- Les **règles métier sont dans le logiciel**, pas dans l'IA : numérotation continue, calcul HT/TVA/TTC, transitions de statut autorisées
  (une commande « reçue » ne peut pas être « livrée » sans être confirmée, on ne facture pas deux fois, un paiement ne peut pas dépasser le reste dû…).
- Tout est tracé dans le **Journal** (qui a fait quoi : utilisateur, agent, import, système).

---

## 2. Installation (15 minutes)

### Prérequis
- **Node.js 22.13 ou plus récent** (https://nodejs.org), ou Docker.
- Une **clé API Anthropic** : créez un compte sur https://platform.claude.com, ajoutez un moyen de paiement, puis *API Keys → Create Key*.

### Étapes

```bash
git clone <ce dépôt> adv-fre2g
cd adv-fre2g
npm install
cp .env.example .env        # puis éditez .env (voir section 3)
npm run seed                # facultatif : données de démonstration pour essayer
npm start
```

Ouvrez http://localhost:3000 — le navigateur demande un mot de passe : celui défini dans `ADMIN_PASSWORD`
(l'identifiant peut être n'importe quoi).

En bas à gauche de l'écran, l'état doit afficher **Agent : ✅ actif**.

> Pour démarrer « à vide » en production, supprimez le fichier `data/adv.db` créé par les essais (ou ne lancez pas `npm run seed`).

---

## 3. Configuration (fichier `.env`)

| Variable | Rôle |
|---|---|
| `ANTHROPIC_API_KEY` | **Obligatoire.** Clé API de l'agent. |
| `ADMIN_PASSWORD` | **Obligatoire en production.** Mot de passe de l'interface. |
| `SOCIETE_*` | Identité légale de FRE2G imprimée sur devis et factures : raison sociale, adresse, SIRET, TVA intracom., RCS, capital, IBAN/BIC. **À compléter impérativement** (mentions obligatoires sur les factures). |
| `SOCIETE_ACTIVITE` | Une phrase décrivant l'activité de FRE2G : l'agent s'en sert pour comprendre le contexte. |
| `SIGNATURE_EMAIL` | Signature des e-mails rédigés par l'agent. |
| `CONDITIONS_VENTE` | Texte de bas de page (pénalités de retard, escompte…). |
| `SMTP_*` | Serveur d'envoi des e-mails (voir 3.1). Sans SMTP : mode simulation. |
| `AGENT_EFFORT` | Profondeur de réflexion : `low` (rapide, économique), `medium` (défaut), `high` (dossiers complexes). |
| `AGENT_ENVOI_AUTO` | `true` = l'agent envoie sans validation. **Laisser `false`** tant que vous n'avez pas confiance dans ses e-mails. |
| `ROUTINE_HEURE`, `ROUTINE_ACTIVE` | Heure de la routine quotidienne (jours ouvrés). |
| `JOURS_RELANCE_DEVIS` | Délai avant de relancer un devis envoyé sans réponse (défaut 7). |
| `JOURS_ENTRE_RELANCES` | Délai minimum entre deux relances d'une même facture (défaut 7). |
| `WEBHOOK_TOKEN` | Jeton secret pour brancher les e-mails entrants (voir 5). |

### 3.1 Envoi réel des e-mails (SMTP)

Utilisez la boîte de l'ADV (ex. `adv@fre2g.fr`) :

- **Microsoft 365** : `SMTP_HOST=smtp.office365.com`, `SMTP_PORT=587`, identifiant = adresse complète (l'« authentification SMTP » doit être activée pour la boîte dans le centre d'administration).
- **Google Workspace** : `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, mot de passe = *mot de passe d'application*.
- **OVH** : `SMTP_HOST=ssl0.ovh.net`, `SMTP_PORT=465`.

Mettez `SMTP_COPIE=adv@fre2g.fr` pour garder une copie de chaque envoi. Le devis / la facture est joint automatiquement
(au format HTML imprimable).

---

## 4. Charger vos données

1. **Catalogue** → *Importer un CSV* (cliquez sur *Modèle CSV* pour le format).
   Colonnes : `reference;designation;unite;prix_ht;tva_taux;stock;delai_jours`. Réimporter met à jour les prix existants.
2. **Clients** → *Importer un CSV*. Colonnes : `code;raison_sociale;siret;tva_intra;contact;email;telephone;adresse;code_postal;ville;delai_paiement_jours;remise_pct`.
   La remise par défaut et le délai de paiement de chaque client sont appliqués automatiquement par l'agent.
3. Export depuis Excel : *Enregistrer sous → CSV UTF-8 (séparateur point-virgule)*.

---

## 5. Brancher les e-mails entrants (automatisation complète)

Pour que l'agent traite **tout seul** les e-mails reçus sur `commandes@…` ou `adv@…` :

1. Dans `.env`, définissez `WEBHOOK_TOKEN` (une longue chaîne aléatoire).
2. Dans **Make**, **Zapier**, **n8n** ou **Power Automate**, créez un scénario :
   *Nouvel e-mail reçu dans la boîte ADV* → *Requête HTTP* :
   - `POST https://<votre-adresse>/api/entrant/email`
   - En-tête : `X-ADV-Token: <votre jeton>`
   - Corps JSON :
     ```json
     {
       "de": "{{expéditeur}}",
       "objet": "{{objet}}",
       "texte": "{{corps en texte}}",
       "pieces_jointes": [ { "nom": "bc.pdf", "type_mime": "application/pdf", "base64": "{{contenu en base64}}" } ]
     }
     ```
3. Chaque e-mail crée une conversation « E-mail : … » dans l'écran **Agent ADV** : vous voyez ce que l'agent a compris et fait,
   et les réponses qu'il propose attendent dans la **Boîte d'envoi**.

Formats de pièces jointes lus : PDF, images (scan/photo de bon de commande), texte.

---

## 6. Mise en ligne (accès depuis n'importe où)

L'application doit tourner en continu (pour la routine quotidienne et les e-mails entrants). Options :

- **Hébergeur simple (Render, Railway, Fly.io, Scalingo, Clever Cloud)** : connectez le dépôt Git, ajoutez les variables du `.env`
  dans le tableau de bord de l'hébergeur, et **un disque persistant monté sur `/app/data`** (sinon la base est perdue à chaque redéploiement).
  Le `Dockerfile` fourni est utilisable tel quel.
- **Serveur / VPS (OVH, Scaleway…)** :
  ```bash
  docker build -t adv-fre2g .
  docker run -d --restart=always --env-file .env -p 3000:3000 -v /srv/adv-data:/app/data adv-fre2g
  ```
  puis un reverse-proxy HTTPS (Caddy : `adv.fre2g.fr { reverse_proxy localhost:3000 }`).
- **Toujours en HTTPS** dès que l'application est accessible sur Internet.

### Sauvegardes
Toutes les données sont dans **un seul fichier** : `data/adv.db`. Sauvegardez-le chaque nuit
(ex. `sqlite3 data/adv.db ".backup /sauvegardes/adv-$(date +%F).db"` dans une tâche cron, ou les snapshots de l'hébergeur).

---

## 7. Démarrage progressif recommandé

| Semaine | Ce qu'on fait |
|---|---|
| 1 | Charger catalogue + clients. Utiliser l'agent en « copilote » : vous lui demandez, vous vérifiez chaque devis/commande et chaque e-mail. SMTP en simulation ou vers vous-même. |
| 2 | Activer le SMTP réel. Activer la routine quotidienne. Valider les e-mails depuis la Boîte d'envoi chaque matin. |
| 3 | Brancher les e-mails entrants (section 5). L'agent saisit les commandes reçues ; vous contrôlez. |
| Ensuite | Si les e-mails proposés sont systématiquement bons, envisager `AGENT_ENVOI_AUTO=true` (sauf mises en demeure, qui restent à valider). |

**Rituel quotidien (5–10 min)** : ouvrir le *Tableau de bord* → lire la synthèse de la routine dans *Agent ADV* → valider la *Boîte d'envoi*
→ traiter les points nécessitant une décision.

---

## 8. Coûts

- Hébergement : 0 à ~15 €/mois selon l'option.
- API Claude : facturée à l'usage par Anthropic (au volume de texte traité). Une ADV de PME représente typiquement quelques dizaines
  d'euros par mois ; suivez la consommation réelle dans la console Anthropic et fixez-y une limite de dépense.
  `AGENT_EFFORT=low` réduit le coût pour les tâches simples.

---

## 9. Sécurité et conformité

- Mot de passe fort dans `ADMIN_PASSWORD`, HTTPS obligatoire, `.env` jamais partagé ni versionné (il est dans `.gitignore`).
- Les données envoyées à l'agent (clients, commandes) transitent par l'API Anthropic ; mentionnez ce sous-traitant dans votre registre RGPD.
- Numérotation des factures continue et sans trou (gérée par le logiciel). Une facture émise ne se supprime pas : faire un avoir
  (à ajouter si besoin, voir ci-dessous).
- **Facturation électronique** : la réforme française impose la réception des factures électroniques à toutes les entreprises
  à partir du 1er septembre 2026, et l'émission aux PME/micro-entreprises à partir du 1er septembre 2027, via une plateforme agréée (PA).
  Cette ADV produit des factures imprimables ; pour l'émission au format Factur-X/UBL via une PA, il faudra brancher la plateforme choisie
  par FRE2G (évolution prévue à planifier avant l'échéance).

---

## 10. Évolutions possibles

Avoirs, bons de livraison séparés et livraisons partielles, export comptable (FEC / CSV pour l'expert-comptable), synchronisation avec
l'ERP ou le logiciel de comptabilité, lecture automatique des relevés bancaires pour lettrer les paiements, multi-utilisateurs avec droits,
génération PDF native, connecteur Factur-X.

---

## Annexe — Architecture technique

```
public/          Interface web (HTML/JS sans framework)
src/server.js    API HTTP, authentification, webhook e-mails entrants, planification de la routine
src/adv.js       Règles métier ADV (numérotation, calculs, statuts, relances) — utilisées par l'interface ET par l'agent
src/agent.js     Agent : consignes, 15 outils métier, boucle d'appel à Claude (Messages API, modèle claude-opus-5-5)
src/mailer.js    Envoi SMTP de la boîte d'envoi
src/documents.js Rendu des devis / AR de commande / factures
src/db.js        Base SQLite (fichier data/adv.db)
```

L'agent tourne **dans votre application** (vos données restent dans votre base ; seules les informations nécessaires à chaque tâche
sont transmises au modèle). Il utilise la réflexion adaptative de Claude et un modèle de repli automatique côté serveur si le modèle
principal décline une requête.
