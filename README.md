# ADV FRE2G — Administration des Ventes avec agent IA

Application web d'Administration des Ventes pour FRE2G : clients, catalogue, devis, commandes, livraisons, factures,
règlements et relances — pilotée par un **agent IA (Claude)** qui fait le travail courant de l'ADV et vous soumet chaque
e-mail client pour validation.

## Démarrage rapide

```bash
npm install
cp .env.example .env   # renseigner au minimum ANTHROPIC_API_KEY et ADMIN_PASSWORD
npm run seed           # facultatif : données de démonstration
npm start              # http://localhost:3000
```

Prérequis : Node.js ≥ 22.13 (ou Docker, voir `Dockerfile`).

## Documentation

👉 **[docs/GUIDE.md](docs/GUIDE.md)** — fonctionnement, configuration, import des données, branchement des e-mails entrants,
mise en ligne, démarrage progressif, coûts et sécurité.
