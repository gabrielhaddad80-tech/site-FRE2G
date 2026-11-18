# Agent FRE2G — du devis au client installé

L'agent prend en charge tout le circuit administratif d'un chantier FRE2G, en suivant la procédure ADV :

| Étape | Qui déclenche | Ce que fait l'agent |
|---|---|---|
| 1. Devis | Vous (ou Claude, à partir des notes de visite) | Devis au modèle FRE2G : lettre d'accompagnement, matériel proposé, description des travaux, montant, échéancier, bon pour accord. Numérotation à la suite (261185, 261186…). |
| 2. Le client accepte | Vous : bouton **« Le client accepte : envoyer pour signature »** | Envoie au client le devis en PDF et un lien de **signature électronique** (code de vérification par e-mail, signature au doigt ou à la souris). |
| 3. Le client signe | Le client, en ligne | **Automatiquement** : exemplaire signé avec certificat → **fiche client créée** → copie signée envoyée au client → **bon de commande envoyé à chaque fournisseur** → **facture d'acompte** (50 %) envoyée au client → notification à FRE2G. |
| 4. Acompte encaissé | Vous : bouton **« Acompte encaissé »** | Facture d'acompte marquée payée, dossier en « Travaux à réaliser », confirmation envoyée au client. Aucun chantier ne passe en travaux sans acompte. |
| 5. Installation terminée | Vous : bouton **« Installation terminée »** | **Facture du reste à payer** émise et envoyée immédiatement, client classé dans **« Clients installés »**. |
| 6. Solde encaissé | Vous : bouton **« Solde encaissé »** | Dossier soldé. |

Tout est tracé dans le **journal** du dossier. Si une étape automatique échoue (fournisseur sans e-mail, SMTP en panne…), elle apparaît en rouge : corrigez, puis cliquez sur **« Relancer les étapes en échec »**. Rien n'est envoyé deux fois.

Règles importantes :
- **Pas de fiche client tant que le devis n'est pas signé** : avant, les coordonnées restent sur le devis (prospect).
- **Le fournisseur ne voit jamais vos prix de vente** : son bon de commande contient les références, quantités, désignations et, si vous les avez saisis, vos prix d'achat.
- **Un devis envoyé est figé.** Pour le modifier : « Repasser en brouillon » (le lien de signature envoyé est alors désactivé), puis renvoyer.
- **Factures numérotées en continu, sans trou** : FA-2026-0001, FA-2026-0002… Échéance : à réception pour un particulier, 30 jours pour un professionnel (réglable).

## Installation

Il faut [Node.js](https://nodejs.org) 22.13 ou plus récent.

```bash
cd agent
npm install
npm run install-browser     # Chromium, pour générer les PDF
cp .env.example .env        # puis complétez .env (au minimum ADMIN_PASSWORD)
npm start
```

Ouvrez http://localhost:3000, connectez-vous, puis dans **Paramètres** complétez : SIRET, n° de TVA, **assurance décennale** (mention obligatoire sur les devis de travaux), IBAN, téléphone et e-mail. Ajoutez vos **fournisseurs** avec l'adresse e-mail où envoyer les commandes. Dans chaque devis, choisissez le fournisseur de chaque équipement.

### Envoyer de vrais e-mails

Tant que `SMTP_HOST` est vide, l'agent est en **mode essai** : les e-mails sont écrits dans `data/outbox/` (fichiers `.eml` qu'on peut ouvrir avec Mail ou Outlook) au lieu de partir. Renseignez votre messagerie dans `.env` (exemples dans le fichier), redémarrez, puis utilisez **Paramètres → Tester l'envoi des e-mails**.

### Mettre l'agent en ligne

Les clients signent depuis le lien reçu par e-mail : l'agent doit donc être joignable sur internet, en **https**. Hébergez-le sur un petit serveur (VPS OVH, Scaleway, Render, Railway…) avec un nom de domaine du type `devis.fre2g.fr`, réglez `BASE_URL` sur cette adresse et `TRUST_PROXY=1` derrière un reverse proxy. Sauvegardez régulièrement le dossier `data/` : il contient la base, les PDF signés et les factures.

### Rédaction des devis par Claude

Avec une clé `ANTHROPIC_API_KEY` dans `.env`, l'éditeur de devis propose **« Rédiger avec Claude »** : collez vos notes de visite technique, Claude rédige le devis complet au format FRE2G (lettre, matériel, phases de travaux, chiffrage, conditions, note de TVA) et liste les **points à vérifier**. Il n'invente ni prix ni référence : sans tarif connu, le prix reste à 0 et c'est signalé. Renseignez votre grille tarifaire dans **Paramètres → Tarifs pour Claude** pour qu'il chiffre. Le devis reste en brouillon : vous relisez avant l'envoi.

Le modèle utilisé est Claude Opus 5.5, avec le repli automatique de l'API si une demande est refusée.

## La signature électronique

Il s'agit d'une **signature électronique simple** (article 1367 du Code civil, règlement eIDAS) : elle a valeur juridique et convient à un devis de travaux. Le PDF signé contient une page **certificat** avec les preuves : e-mail vérifié par code à usage unique, nom, mention « Bon pour accord », date et heure, adresse IP, navigateur, et l'empreinte SHA-256 du devis présenté. L'empreinte du PDF signé est conservée dans le journal.

Pour les gros montants ou les clients qui l'exigent, une signature **avancée** via un prestataire (Yousign, Docusign…) apporte une valeur probante plus forte ; elle peut être branchée à la place de la page de signature intégrée.

## Ce qu'il reste à savoir

- **Facture électronique** : à partir du 1er septembre 2027, FRE2G devra émettre ses factures par une plateforme agréée (PA). L'agent produit des factures PDF conformes aux mentions actuelles ; il faudra alors les transmettre via la plateforme choisie.
- **TVA à 10 % ou 5,5 %** chez un particulier : conservez l'attestation simplifiée signée par le client.
- Les relances (devis non signés, factures impayées) ne sont pas encore automatiques : le tableau de bord montre les factures en retard.

## Pour les développeurs

```
src/
  server.js       serveur Express : API d'administration, connexion, page de signature
  workflow.js     le circuit du dossier et toutes les étapes automatiques
  money.js        totaux, TVA par taux, acompte, solde
  render.js       Handlebars → HTML → PDF (Chromium via Playwright)
  mailer.js       envoi SMTP ou mode essai (outbox)
  ai.js           rédaction du devis par Claude (sortie structurée)
  signer-page.js  page publique de signature
  db.js           schéma SQLite (node:sqlite) et paramètres par défaut
templates/        modèles des PDF (devis, facture, bon de commande) et des e-mails
public/           interface d'administration
test/             tests de bout en bout (npm test)
```

`npm test` déroule le circuit complet (devis → signature avec code → fiche client → commande fournisseur → acompte → travaux → solde → client installé) avec de vrais PDF et des e-mails en mode essai.
