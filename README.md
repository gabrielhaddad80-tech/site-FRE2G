# FRE2G — Logiciel de devis et factures

Application web locale pour créer des **devis**, **factures** et **avoirs** à partir d'une **base de données**
(catalogue, tarifs, prestations, main d'œuvre, fournitures, ouvrages composés, clients),
avec des **modèles d'impression entièrement personnalisables** pour reproduire votre modèle existant.

Les données restent sur votre ordinateur (fichier SQLite `data/facturation.db`).

## Installation

Prérequis : [Node.js](https://nodejs.org) 18 ou plus récent.

```bash
npm install
npm start
```

Puis ouvrez <http://localhost:3000>.
Sous Windows, double-cliquez simplement sur `demarrer.bat`.

Options : `PORT=8080 npm start` pour changer de port, `DB_FILE=/chemin/base.db` pour utiliser un autre fichier de données,
`HOST=0.0.0.0` pour y accéder depuis d'autres postes du réseau local.

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
- **Aperçu / PDF** : bouton « Imprimer / Enregistrer en PDF » (format A4).

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

### Modèles personnalisables (`Modèles`)
Chaque modèle est une page HTML + CSS avec des variables (`{{client.display_name}}`, `{{money totals.ttc}}`, …)
éditable directement dans l'application avec **aperçu en direct**. Plusieurs modèles possibles, un par défaut,
choix du modèle document par document. La liste complète des variables est affichée dans l'éditeur.

**Reproduire votre modèle existant** : chargez un fichier HTML via « Charger un fichier HTML… » ou modifiez le modèle
classique ; logo, couleurs, coordonnées, mentions légales et pied de page se règlent aussi dans `Paramètres`.

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
src/routes/ai.js        assistant IA (API Claude)
public/js/ai.js         consignes envoyées à l'IA et rapprochement avec le catalogue
src/routes/             API : catalogue & clients, documents, paramètres / modèles / sauvegarde
templates/              modèle d'impression par défaut (HTML + CSS)
public/                 interface web (Alpine.js), police Plus Jakarta Sans hébergée localement (public/fonts, licence OFL)
public/js/calc.js       calcul des totaux (partagé navigateur / serveur)
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
