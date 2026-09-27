# Electroclim — site vitrine

Site d'Electroclim (SASU FRE2G) : installation, entretien et dépannage de climatisation, pompes à chaleur et traitement d'air à Paris et en Île-de-France. Particuliers et professionnels.

Site statique : HTML5, **Tailwind CSS** (compilé à l'avance, aucun script CSS chargé au runtime) et JavaScript vanille, sans framework.
Le dossier s'héberge tel quel (Netlify, OVH, o2switch, GitHub Pages…) : `assets/site.css` est déjà compilé et versionné.

## Charte graphique

`brand-book.html` présente la charte (version 2, registre haut de gamme) : 5 couleurs (Nuit `#0E1A2B`, Ivoire `#F7F3EC`,
Bleu Electroclim `#1B3F8F`, Rouge Éclair `#D7262E` en touche rare, Ardoise `#55617A`), 2 typographies
(Cormorant Garamond pour les titres, Inter pour le texte), le kit de composants et les règles d'animation.
La palette Tailwind est **fermée** dans `tailwind.config.js` : pas de noir pur ni de gris génériques.

## Structure

```
index.html              page principale
mentions-legales.html   mentions légales
brand-book.html         charte graphique (non indexée)
src/site.css            source Tailwind : base, composants (boutons, cartes, galerie…), animations
assets/site.css         CSS compilé et minifié (à régénérer après modification)
tailwind.config.js      jetons de la charte : couleurs, polices
script.js               menu mobile, en-tête, apparitions au défilement, vidéo, formulaire
fonts/                  Cormorant Garamond et Inter hébergées localement (pas d'appel à Google)
images/                 photos de chantiers (WebP + JPEG, 900 et 1600 px)
videos/                 vidéo de chantier (MP4 + WebM) et son image d'aperçu
logo/                   logo Electroclim et icônes
logos-marques/          logos des marques installées (fond transparent, PNG + WebP)
```

## Modifier les styles

```
npm install        # une seule fois
npm run dev        # recompile à chaque modification
npm run build      # version minifiée avant mise en ligne
```

Les animations (apparition au défilement, survols) respectent l'option système « réduire les animations ».

## Photos

Photos de chantiers fournies par l'entreprise, recadrées et optimisées :

- `hero-toiture` — groupe extérieur et gaines en toiture (non utilisée actuellement)
- `chambre-gainable` — gainable intégré sous les moulures (grande photo d'accueil)
- `gainable-haussmannien` — caisson avec deux grilles de soufflage
- `console-habillage` — console et son habillage sur mesure
- `centrale-traitement-air` — centrale de traitement d'air en local industriel
- `diffuseur-lineaire` — fente de soufflage intégrée à la boiserie
- `mural-chambre` — split mural en chambre (non utilisée actuellement)
- `gainable-cuisine` — grille de gainable au-dessus d'une baie
- `liaisons-facade` — goulottes des liaisons en façade

- `mural-eclairage` — split mural sous éclairage indirect
- `unite-exterieure` — groupe extérieur sur supports antivibratiles
- `plenum-chantier` — plénum de soufflage en construction neuve
- `toiture-groupe` — groupe extérieur et gaines en toiture

Les photos sont recadrées pour retirer le filigrane « Galaxy S23 » et l'interface de messagerie.

## Vidéo

`videos/cassettes-batiment` — cassettes en cours de pose dans un bâtiment d'activité (9 s, sans le son).
Source iPhone HEVC HDR convertie en SDR, 720 × 1280, en deux formats : MP4 H.264 (Safari, Chrome, Edge, Firefox) et WebM VP9 (repli).
La vidéo se lance en muet quand elle est visible et se met en pause sinon ; avec l'option système « réduire les animations », elle ne démarre pas seule et affiche ses contrôles.

Pour en ajouter : exporter en 900 et 1600 px de large, en `.webp` et `.jpg`, avec le même schéma de nom.

## Logo

Nouveau logo Electroclim : un flocon à six branches dans un anneau fin, dont la branche haute devient un éclair rouge
(le froid et l'électricité). Nom en Cormorant Garamond, capitales espacées ; slogan « De père en fils · depuis 30 ans ».
Tous les textes sont vectorisés : les SVG s'agrandissent sans perte pour l'impression.

- `logo.svg` / `logo-white.svg` — horizontal avec slogan (fond clair / fond foncé)
- `logo-compact*.svg` — horizontal sans slogan (en-tête et pied de page du site)
- `logo-vertical*.svg` — emblème au-dessus du nom (enseigne, carte de visite, véhicule)
- `emblem*.svg` — emblème seul
- `icon.svg`, `icon-blue.svg`, `favicon.svg`, `apple-touch-icon.png`, `icon-512.png` — icônes (onglet, réseaux sociaux, Google)
- Chaque SVG existe aussi en PNG transparent.

## Avant la mise en ligne

- Compléter dans `mentions-legales.html` le nom du directeur de la publication et l'hébergeur.
- Le formulaire ouvre la messagerie du visiteur (`mailto:`). Pour recevoir les demandes directement, brancher un service de formulaire (Formspree, formulaire Netlify…).
- Une fois le domaine connu, passer les URL de `og:image` et du bloc JSON-LD en adresses absolues (`https://…`).
