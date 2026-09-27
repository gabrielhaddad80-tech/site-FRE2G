# Electroclim — site vitrine

Site d'Electroclim (SASU FRE2G) : installation, entretien et dépannage de climatisation, pompes à chaleur et traitement d'air à Paris et en Île-de-France. Particuliers et professionnels.

Site statique (HTML, CSS, JavaScript), sans dépendance ni outil de build : le dossier s'héberge tel quel (OVH, o2switch, Netlify, GitHub Pages…).

## Structure

```
index.html              page principale
mentions-legales.html   mentions légales
styles.css              styles
script.js               menu mobile, en-tête, formulaire
fonts/                  polices Archivo et Inter hébergées localement (pas d'appel à Google)
images/                 photos de chantiers (WebP + JPEG, 900 et 1600 px)
logo/                   logo Electroclim et icônes
```

## Photos

Photos de chantiers fournies par l'entreprise, recadrées et optimisées :

- `chambre-gainable` — gainable intégré sous les moulures (image d'accueil)
- `gainable-haussmannien` — caisson avec deux grilles de soufflage
- `console-habillage` — console et son habillage sur mesure
- `centrale-traitement-air` — centrale de traitement d'air en local industriel

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
