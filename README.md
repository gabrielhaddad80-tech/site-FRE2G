# FRE2G — Logiciel de devis et factures

Application web locale pour créer des **devis**, **factures** et **avoirs** à partir d'une **base de données**
(catalogue, tarifs, prestations, main d'œuvre, fournitures, ouvrages composés, clients),
avec des **modèles d'impression entièrement personnalisables** pour reproduire votre modèle existant.

Les données restent sur votre ordinateur (fichier SQLite `data/facturation.db`).

## Installation

> **Mise en ligne sur un serveur (VPS Hostinger ou autre)** : voir le guide pas à pas [DEPLOIEMENT.md](DEPLOIEMENT.md)
> (installation automatique en une commande : HTTPS, service, pare-feu, sauvegardes).

Prérequis : [Node.js](https://nodejs.org) 22.12 ou plus récent (version LTS) ; Google Chrome ou Microsoft Edge pour l'export PDF.

```bash
npm install
npm start
```

Puis ouvrez <http://localhost:3000>.
Sous Windows, double-cliquez simplement sur `demarrer.bat`.

Options : `PORT=8080 npm start` pour changer de port, `DB_FILE=/chemin/base.db` pour utiliser un autre fichier de données,
`HOST=0.0.0.0` pour y accéder depuis d'autres postes du réseau local.

## Connexion et sécurité

Le logiciel est protégé par une connexion (e-mail + mot de passe).

- **Premier démarrage** : aucun compte n'existe ; la console du serveur affiche un **code de première connexion**
  (ex. `4833-3817`). Ouvrez le logiciel, saisissez ce code et créez le compte administrateur. Le code ne sert
  qu'une fois : personne d'autre ne peut créer ce compte à votre place.
  Installation automatisée : `INITIAL_ADMIN_EMAIL` et `INITIAL_ADMIN_PASSWORD` créent ce compte directement.
- **Autres utilisateurs** : `Paramètres → Utilisateurs et sécurité` (ajout, suppression, changement de mot de passe,
  déconnexion des autres appareils). Mot de passe de 10 caractères minimum.
- **Mot de passe oublié** : sur le serveur, `npm run reset-password -- adresse@email.fr NouveauMotDePasse`
  (ferme aussi les sessions ouvertes de ce compte ; crée le compte s'il n'existe pas).
- **Ce qui est protégé** : mots de passe hachés (scrypt) ; session dans un cookie HttpOnly / SameSite=Lax, valable
  30 jours (seule son empreinte est stockée) ; toutes les pages et l'API exigent une session ; écritures refusées
  depuis un autre site ; 10 tentatives de connexion incorrectes bloquent l'adresse IP **et le compte visé** 15 minutes ;
  avant connexion, seuls de petits envois sont acceptés.
- **Pages** : politique de sécurité du contenu (CSP) — rien n'est chargé ni envoyé vers un autre site. Les modèles de
  document (HTML modifiable ou créé par l'IA) s'affichent sans pouvoir exécuter de script (aperçus isolés, page
  d'impression sans script autre que sa barre d'outils).
- **Assistant IA** : il ne peut pas modifier le catalogue de lui-même ; un import proposé s'enregistre seulement après
  un clic sur « Importer dans le catalogue » (un PDF piégé ne peut pas changer vos prix).
- **Export CSV** : les textes commençant par `=`, `+`, `-`, `@` sont neutralisés pour qu'Excel ne les exécute pas.
- **Serveur (installation automatique)** : fail2ban (SSH), correctifs de sécurité Ubuntu automatiques, sauvegardes
  lisibles par l'administrateur seulement (`deploy/harden.sh`, relancé à chaque `facturation-update`).
- Tous les comptes ont les mêmes droits (ajout d'utilisateurs, restauration d'une sauvegarde) : ne créez de compte
  que pour des personnes de confiance.
- **En ligne derrière HTTPS** (Caddy, Nginx…) : lancez avec `TRUST_PROXY=1` pour que le cookie soit marqué
  « Secure » et que le blocage utilise la vraie adresse IP des visiteurs.

## Fonctionnalités

### Accueil
Écran d'accueil façon application mobile : conseil du jour (relance d'une facture en retard, devis accepté à
facturer, devis à relancer), compteurs, actions rapides, accès à toutes les rubriques et activité récente.
Sur mobile, une barre d'onglets en bas donne accès aux écrans principaux.

### Base de données / catalogue (`Catalogue & tarifs`)
- Articles typés : **prestation**, **main d'œuvre**, **fourniture**, **matériel**, **ouvrage**.
- Référence, désignation, description, unité, prix d'achat, coefficient, prix de vente, TVA, catégorie, catalogue/fournisseur.
- Calcul de la marge (montant et %) et du prix TTC.
- **Ouvrages composés** : un ouvrage regroupe plusieurs articles (ex. 1 m² de fourniture + 0,5 h de main d'œuvre) ;
  son prix est calculé à partir des composants. Il s'insère dans un devis en une ligne ou détaillé composant par composant.
- Catégories ordonnables.
- **Import CSV / Excel** avec correspondance automatique des colonnes (exemple : `exemples/catalogue-exemple.csv`).
  Un article dont la référence existe déjà est mis à jour → idéal pour charger un nouveau tarif fournisseur.
- **Export CSV** et **mise à jour des prix en masse** (ex. +3,5 % sur un catalogue).

### Clients
Professionnels et particuliers en fiches cartes, code client automatique, SIRET, TVA intracommunautaire, délai de
paiement et remise habituelle. Fiche client détaillée : chiffre d'affaires facturé, appel et e-mail en un clic,
coordonnées, notes et activité récente.

### Devis, factures, avoirs
- Ajout de lignes depuis le catalogue (recherche, filtres), lignes libres, **sections avec sous-totaux**, lignes de texte.
- Glisser-déposer pour réordonner, duplication de ligne, remise par ligne et **remise globale**, **multi-taux de TVA**,
  **acompte** sur devis, franchise de TVA (auto-entrepreneur).
- Marge du document affichée en interne (jamais imprimée).
- Cycle de vie : devis *brouillon → envoyé → accepté/refusé* → **transformation en facture** en un clic.
- Factures conformes : **numéro définitif attribué à l'émission**, numérotation continue, facture émise **verrouillée**
  (non modifiable, non supprimable) ; correction par **avoir**.
- Suivi des **règlements** (partiels ou totaux), statut automatique, factures en retard.
- Numérotation personnalisable (`FAC-{AAAA}-{NUM:4}`, `F{AA}{MM}-{NUM}`, …).
- **Téléchargement en PDF ou en Word** : boutons « PDF » et « Word » de l'éditeur (et dans l'aperçu). Le fichier est
  nommé automatiquement (`Devis DEV-2026-0001 - Client.pdf`).
  - **PDF** : identique à l'aperçu (votre modèle, logo, papier à en-tête), format A4. Il est créé avec Google Chrome,
    Microsoft Edge ou Chromium installé sur l'ordinateur / le serveur (détecté automatiquement ; sinon variable
    `CHROME_PATH=/chemin/vers/chrome`). Le script d'installation serveur installe Chrome.
  - **Word (.docx)** : document modifiable (Word, LibreOffice, Google Docs) avec la même structure : en-tête, client,
    lignes et sections avec sous-totaux, TVA, totaux, acompte, règlements, conditions, RIB, bon pour accord,
    mentions légales, pied de page et numéros de page, aux couleurs de Paramètres. La mise en page Word est une
    version standard : un modèle HTML très personnalisé (ou un papier à en-tête) n'est reproduit fidèlement qu'en PDF.
- **Aperçu** : document prêt à imprimer (format A4).

### Assistant IA (dictée, note, photos)
Dans l'éditeur de devis et de factures, la carte **Assistant IA** prépare les lignes à votre place :
- **dictez** la demande (bouton micro, reconnaissance vocale du navigateur en français — Chrome, Edge, Safari),
  ou écrivez / collez une **note** ;
- ajoutez jusqu'à 5 **photos** du chantier (réduites automatiquement avant l'envoi) ;
- l'IA (Claude, d'Anthropic) propose l'objet, l'adresse du chantier et les lignes en **reprenant vos articles et vos prix
  du catalogue** ; ce qui n'existe pas au catalogue est marqué « Prix estimé » ; les points à vérifier avec le client
  sont listés ;
- vous cochez les lignes à garder, puis « Ajouter au document » ou « Remplacer les lignes ». Rien n'est enregistré
  sans votre validation.

Activation : créez une clé API sur <https://console.anthropic.com/settings/keys> (usage facturé par Anthropic) et
collez-la dans **Paramètres → Assistant IA**, ou lancez le logiciel avec la variable d'environnement `ANTHROPIC_API_KEY`.
La clé reste sur l'ordinateur : elle n'est jamais renvoyée au navigateur ni incluse dans les sauvegardes. Les textes
et photos soumis à l'assistant sont transmis à Anthropic pour être traités.

### Chat avec l'assistant IA
Le bouton **Assistant** (en bas à droite de chaque page) ouvre une discussion avec l'IA. Elle consulte vos données
pour répondre — clients, catalogue, devis, factures, tableau de bord — et peut **préparer un devis brouillon**
à partir de votre catalogue (à vérifier avant envoi). Exemples : « Quelles factures sont en retard ? »,
« Quel est mon CA de mars ? », « Rédige une relance pour la facture FAC-2026-0004 », « Prépare un devis pour
20 m² de carrelage chez Mme Martin ». Elle sait sur quelle page vous êtes (« ce devis », « ce client »),
répond avec des liens vers les documents, et accepte la dictée.
**Fichiers et photos dans le chat** : trombone, glisser-déposer ou coller une capture (5 fichiers par message) —
photos (réduites avant l'envoi), PDF de 10 Mo maximum (lus en entier : devis ou tarif fournisseur, plan, ancien
devis…) et fichiers texte/CSV. Exemples : « Fais-moi un devis d'après cette photo », « Compare ce devis
fournisseur avec mes prix », « Ajoute ce tarif à mon catalogue » (l'assistant montre la liste et attend votre accord
avant d'importer ; les références existantes sont mises à jour). Elle ne peut ni émettre une facture, ni
enregistrer un règlement, ni supprimer quoi que ce soit. La conversation est conservée dans le navigateur ;
le bouton crayon en démarre une nouvelle. Même clé API que l'assistant de rédaction.

### Instructions et fichiers de l'assistant (comme un projet Claude)
Page **Assistant IA** du menu :
- **Instructions** permanentes (20 000 caractères) : votre façon de travailler, vos taux, vos règles de chiffrage,
  votre ton… Des exemples s'ajoutent en un clic.
- **Fichiers de référence** (20 fichiers, 30 Mo au total) : PDF (10 Mo), images, textes/CSV — tarifs fournisseurs,
  conditions générales, anciens devis, fiches techniques. Chaque fichier peut être activé ou désactivé ; aperçu du texte.

Instructions et fichiers actifs accompagnent **chaque** demande à l'IA : le chat et l'assistant de rédaction
de devis/factures. Ils sont mis en cache (prompt caching de l'API Claude) pour réduire le coût des messages
suivants. Ils sont inclus dans les sauvegardes.

### Modèles personnalisables (`Modèles`)
Chaque modèle est une page HTML + CSS avec des variables (`{{client.display_name}}`, `{{money totals.ttc}}`, …)
éditable directement dans l'application avec **aperçu en direct**. Plusieurs modèles possibles, un par défaut,
choix du modèle document par document. La liste complète des variables est affichée dans l'éditeur.

**Importer votre modèle existant (image ou PDF)** — bouton « Importer mon modèle » de la page Modèles
(pour un PDF, la première page est utilisée) :
- **Reproduire la mise en page avec l'IA** : l'IA recrée la disposition, les couleurs, le tableau et les totaux de
  votre modèle, puis le remplit avec vos données ; l'original et la reproduction s'affichent côte à côte avant
  l'enregistrement. Le modèle obtenu reste modifiable (HTML/CSS). Nécessite la clé API de l'assistant IA.
- **Utiliser comme papier à en-tête** : l'image ou le PDF est imprimé en fond de la première page et le document
  s'écrit par-dessus ; marges haute et basse réglables, option pour masquer vos coordonnées déjà présentes sur le papier.

Vous pouvez aussi charger un fichier HTML ou modifier directement le modèle classique ; logo, couleurs, coordonnées,
mentions légales et pied de page se règlent aussi dans `Paramètres`.

### Tableau de bord
CA HT de l'année, encaissements, reste à encaisser, factures en retard, devis en cours, taux de transformation,
graphique mensuel.

### Sauvegarde
`Paramètres → Télécharger une sauvegarde` (fichier JSON complet) et restauration. Vous pouvez aussi copier
le fichier `data/facturation.db`.

## Structure du projet

```
server.js               serveur Express
src/db.js               schéma SQLite, paramètres par défaut, données d'exemple
src/numbering.js        numérotation des documents
src/render.js           rendu des modèles (Handlebars)
src/export/             export PDF (Chrome sans interface) et Word (.docx)
src/routes/ai.js        assistant IA (API Claude)
public/js/ai.js         consignes envoyées à l'IA et rapprochement avec le catalogue
src/routes/             API : catalogue & clients, documents, paramètres / modèles / sauvegarde
templates/              modèle d'impression par défaut (HTML + CSS)
public/                 interface web (Alpine.js), police Plus Jakarta Sans hébergée localement (public/fonts, licence OFL)
public/js/calc.js       calcul des totaux (partagé navigateur / serveur)
public/vendor/pdfjs/    pdf.js 3.11 (lecture des PDF importés, exécuté avec isEvalSupported: false)
test/                   tests automatisés (npm test)
```

## Démo en ligne

Le dossier `demo/` construit une version autonome du logiciel (une seule page HTML) où le serveur et la base SQLite
tournent directement dans le navigateur. Elle sert à essayer le logiciel sans rien installer.

```bash
cd demo && npm install && npm run build   # produit demo/dist/facturation-demo.html
```

## Tests

```bash
npm test
```
