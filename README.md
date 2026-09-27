# Electroclim — site vitrine

Site d'Electroclim (SASU FRE2G) : installation, entretien et dépannage de climatisation, pompes à chaleur et traitement d'air à Paris et en Île-de-France. Particuliers et professionnels.

Site statique : HTML5, **Tailwind CSS** (compilé à l'avance, aucun script CSS chargé au runtime) et JavaScript vanille, sans framework.
Le dossier s'héberge tel quel (Netlify, OVH, o2switch, GitHub Pages…) : `assets/site.css` est déjà compilé et versionné.

## Charte graphique

`brand-book.html` présente la charte : 5 couleurs (Bleu Electroclim `#1B3F8F`, Rouge Éclair `#D7262E`, Nuit `#0E1A2B`,
Ardoise `#55617A`, Sable `#F5F3EF`), 2 typographies (Archivo pour les titres, Inter pour le texte), le kit de composants
et les règles d'animation. La palette Tailwind est **fermée** dans `tailwind.config.js` : pas de noir pur ni de gris génériques.

## Structure

```
index.html              page principale
mentions-legales.html   mentions légales
brand-book.html         charte graphique (non indexée)
src/site.css            source Tailwind : base, composants (boutons, cartes, galerie…), animations
assets/site.css         CSS compilé et minifié (à régénérer après modification)
tailwind.config.js      jetons de la charte : couleurs, polices
script.js               menu mobile, en-tête, apparitions au défilement, vidéo, formulaire
fonts/                  Archivo et Inter hébergées localement (pas d'appel à Google)
images/                 photos de chantiers (WebP + JPEG, 900 et 1600 px)
videos/                 vidéo de chantier (MP4 + WebM) et son image d'aperçu
logo/                   logo Electroclim et icônes
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

- `chambre-gainable` — gainable intégré sous les moulures (image d'accueil)
- `gainable-haussmannien` — caisson avec deux grilles de soufflage
- `console-habillage` — console et son habillage sur mesure
- `centrale-traitement-air` — centrale de traitement d'air en local industriel
- `diffuseur-lineaire` — fente de soufflage intégrée à la boiserie
- `mural-chambre` — split mural en chambre
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

Le logo reprend le logo Electroclim existant (éclair rouge, lettres dégradé rouge vers bleu, stalactites, flocon sur le M), redessiné en vectoriel avec un nom incliné pour plus de dynamisme.

- `logo.svg` / `.png` — complet avec le slogan, fond clair
- `logo-white.svg` / `.png` — pour fond foncé
- `logo-compact*.svg` / `.png` — sans slogan (en-tête, pied de page)
- `icon*.svg` / `.png`, `apple-touch-icon.png` — éclair et flocon (favicon, réseaux sociaux)

## Avant la mise en ligne

- Compléter dans `mentions-legales.html` le nom du directeur de la publication et l'hébergeur.
- Le formulaire ouvre la messagerie du visiteur (`mailto:`). Pour recevoir les demandes directement, brancher un service de formulaire (Formspree, formulaire Netlify…).
- Une fois le domaine connu, passer les URL de `og:image` et du bloc JSON-LD en adresses absolues (`https://…`).
