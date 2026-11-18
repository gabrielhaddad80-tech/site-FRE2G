// Paramètres de la société, lus depuis le fichier .env (voir .env.example).
const e = process.env;
export const SOCIETE = {
  nom: e.SOCIETE_NOM || "FRE2G",
  forme: e.SOCIETE_FORME || "",
  adresse: e.SOCIETE_ADRESSE || "",
  code_postal: e.SOCIETE_CP || "",
  ville: e.SOCIETE_VILLE || "",
  siret: e.SOCIETE_SIRET || "",
  tva_intra: e.SOCIETE_TVA || "",
  rcs: e.SOCIETE_RCS || "",
  capital: e.SOCIETE_CAPITAL || "",
  telephone: e.SOCIETE_TEL || "",
  email: e.SOCIETE_EMAIL || "",
  site: e.SOCIETE_SITE || "",
  iban: e.SOCIETE_IBAN || "",
  bic: e.SOCIETE_BIC || "",
  activite: e.SOCIETE_ACTIVITE || "",
  signature: e.SIGNATURE_EMAIL || `L'équipe ADV ${e.SOCIETE_NOM || "FRE2G"}`,
  conditions: e.CONDITIONS_VENTE ||
    "Pénalités de retard : 3 fois le taux d'intérêt légal. Indemnité forfaitaire pour frais de recouvrement : 40 €. Pas d'escompte pour paiement anticipé.",
};

export const AGENT = {
  model: e.AGENT_MODELE || "claude-opus-5-5",
  effort: e.AGENT_EFFORT || "medium",
  envoiAuto: e.AGENT_ENVOI_AUTO === "true",
  routineHeure: Number(e.ROUTINE_HEURE ?? 8),
  routineActive: e.ROUTINE_ACTIVE !== "false",
  joursRelanceDevis: Number(e.JOURS_RELANCE_DEVIS ?? 7),
  joursEntreRelances: Number(e.JOURS_ENTRE_RELANCES ?? 7),
};
