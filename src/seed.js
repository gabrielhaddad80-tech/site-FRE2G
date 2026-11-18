// Données de démonstration (à remplacer par votre catalogue et vos clients via l'import CSV).
// Usage : npm run seed
import * as adv from "./adv.js";
import { get } from "./db.js";

if (get("SELECT COUNT(*) n FROM clients").n > 0) {
  console.log("La base contient déjà des données : rien n'est fait.");
  process.exit(0);
}
const produits = [
  { reference: "PRD-001", designation: "Produit standard A", unite: "u", prix_ht: 120, tva_taux: 20, stock: 50, delai_jours: 3 },
  { reference: "PRD-002", designation: "Produit standard B", unite: "u", prix_ht: 89.5, tva_taux: 20, stock: 12, delai_jours: 5 },
  { reference: "PRD-010", designation: "Kit d'installation", unite: "kit", prix_ht: 45, tva_taux: 20, stock: 200, delai_jours: 2 },
  { reference: "SRV-INST", designation: "Prestation d'installation (heure)", unite: "h", prix_ht: 65, tva_taux: 20 },
  { reference: "SRV-LIV", designation: "Frais de livraison", unite: "forfait", prix_ht: 35, tva_taux: 20 },
];
produits.forEach((p) => adv.enregistrerProduit(p, "demo"));
const c1 = adv.enregistrerClient({ raison_sociale: "Client Démo SARL", contact: "Mme Martin", email: "achats@client-demo.example",
  adresse: "1 rue de l'Exemple", code_postal: "75001", ville: "Paris", delai_paiement_jours: 30 }, "demo");
adv.enregistrerClient({ raison_sociale: "Exemple Industrie SAS", contact: "M. Durand", email: "compta@exemple-industrie.example",
  adresse: "10 avenue des Tests", code_postal: "69000", ville: "Lyon", delai_paiement_jours: 45, remise_pct: 5 }, "demo");
adv.creerDevis({ client_id: c1.id, lignes: [{ reference: "PRD-001", quantite: 4 }, { reference: "SRV-LIV", quantite: 1 }], objet: "Devis de démonstration" }, "demo");
console.log("Données de démonstration créées.");
