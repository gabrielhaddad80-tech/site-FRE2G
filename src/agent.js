// Agent ADV FRE2G : Claude + outils métier. Boucle d'outils gérée ici (Messages API),
// pour que l'agent travaille directement sur la base de l'ADV hébergée chez vous.
import Anthropic from "@anthropic-ai/sdk";
import { get, run } from "./db.js";
import * as adv from "./adv.js";
import { AGENT, SOCIETE } from "./config.js";
import { envoyerEmail } from "./mailer.js";

const client = new Anthropic(); // lit ANTHROPIC_API_KEY dans l'environnement
const MAX_TOURS = 30;

// ---------------------------------------------------------------------------
// Outils mis à disposition de l'agent
// ---------------------------------------------------------------------------
const ligneSchema = {
  type: "object",
  properties: {
    reference: { type: "string", description: "Référence catalogue du produit (préférée)" },
    produit_id: { type: "integer" },
    designation: { type: "string", description: "Uniquement pour une ligne hors catalogue" },
    quantite: { type: "number" },
    prix_ht: { type: "number", description: "Ne renseigner que pour un prix négocié/explicitement demandé ; sinon le prix catalogue s'applique" },
    remise_pct: { type: "number", description: "Remise en %, sinon la remise par défaut du client s'applique" },
    tva_taux: { type: "number" },
  },
  required: ["quantite"],
};

const TOOLS = [
  {
    name: "rechercher_clients",
    description: "Recherche des clients par nom, code, e-mail, contact, ville ou SIRET. Chaîne vide = liste.",
    input_schema: { type: "object", properties: { recherche: { type: "string" } }, required: ["recherche"] },
    run: (i) => adv.rechercherClients(i.recherche),
  },
  {
    name: "enregistrer_client",
    description: "Crée un client (sans id) ou met à jour un client existant (avec id). Vérifier d'abord qu'il n'existe pas déjà.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer" }, raison_sociale: { type: "string" }, siret: { type: "string" }, tva_intra: { type: "string" },
        contact: { type: "string" }, email: { type: "string" }, telephone: { type: "string" }, adresse: { type: "string" },
        code_postal: { type: "string" }, ville: { type: "string" }, pays: { type: "string" },
        delai_paiement_jours: { type: "integer" }, remise_pct: { type: "number" }, notes: { type: "string" },
      },
    },
    run: (i) => adv.enregistrerClient(i, "agent"),
  },
  {
    name: "rechercher_produits",
    description: "Recherche dans le catalogue (référence ou désignation). Retourne prix HT, TVA, stock, délai.",
    input_schema: { type: "object", properties: { recherche: { type: "string" } }, required: ["recherche"] },
    run: (i) => adv.rechercherProduits(i.recherche),
  },
  {
    name: "creer_devis",
    description: "Crée un devis (statut brouillon) pour un client existant.",
    input_schema: {
      type: "object",
      properties: {
        client_id: { type: "integer" }, lignes: { type: "array", items: ligneSchema },
        validite_jours: { type: "integer" }, objet: { type: "string" }, notes: { type: "string" },
      },
      required: ["client_id", "lignes"],
    },
    run: (i) => adv.creerDevis(i, "agent"),
  },
  {
    name: "changer_statut_devis",
    description: "Change le statut d'un devis : brouillon, envoye, accepte, refuse, expire.",
    input_schema: {
      type: "object",
      properties: { devis: { type: "string", description: "id ou numéro" }, statut: { type: "string", enum: adv.STATUTS.devis } },
      required: ["devis", "statut"],
    },
    run: (i) => adv.changerStatutDevis(i.devis, i.statut, "agent"),
  },
  {
    name: "transformer_devis_en_commande",
    description: "Le client accepte le devis : crée la commande correspondante aux prix du devis.",
    input_schema: {
      type: "object",
      properties: {
        devis: { type: "string", description: "id ou numéro" }, ref_client: { type: "string", description: "N° de bon de commande du client" },
        date_livraison_prevue: { type: "string", description: "AAAA-MM-JJ" }, adresse_livraison: { type: "string" },
      },
      required: ["devis"],
    },
    run: (i) => adv.convertirDevis(i.devis, { ref_client: i.ref_client, date_livraison_prevue: i.date_livraison_prevue, adresse_livraison: i.adresse_livraison }, "agent"),
  },
  {
    name: "creer_commande",
    description: "Enregistre une commande client reçue directement (sans devis préalable), statut « recue ».",
    input_schema: {
      type: "object",
      properties: {
        client_id: { type: "integer" }, lignes: { type: "array", items: ligneSchema }, ref_client: { type: "string" },
        date_livraison_prevue: { type: "string", description: "AAAA-MM-JJ" }, adresse_livraison: { type: "string" }, notes: { type: "string" },
      },
      required: ["client_id", "lignes"],
    },
    run: (i) => adv.creerCommande(i, "agent"),
  },
  {
    name: "mettre_a_jour_commande",
    description: "Fait avancer une commande (recue → confirmee → en_preparation → expediee → livree, ou annulee) et/ou met à jour date de livraison, transporteur, n° de suivi, note.",
    input_schema: {
      type: "object",
      properties: {
        commande: { type: "string", description: "id ou numéro" },
        statut: { type: "string", enum: adv.STATUTS.commande.filter((s) => s !== "facturee") },
        date_livraison_prevue: { type: "string" }, transporteur: { type: "string" }, numero_suivi: { type: "string" }, note: { type: "string" },
      },
      required: ["commande"],
    },
    run: (i) => adv.changerStatutCommande(i.commande, i, "agent"),
  },
  {
    name: "facturer_commande",
    description: "Émet la facture d'une commande (échéance selon le délai de paiement du client).",
    input_schema: { type: "object", properties: { commande: { type: "string", description: "id ou numéro" } }, required: ["commande"] },
    run: (i) => adv.facturerCommande(i.commande, "agent"),
  },
  {
    name: "enregistrer_paiement",
    description: "Enregistre un règlement reçu sur une facture.",
    input_schema: {
      type: "object",
      properties: {
        facture: { type: "string", description: "id ou numéro" }, montant: { type: "number", description: "TTC" },
        mode: { type: "string", description: "virement, chèque, CB, LCR, prélèvement…" }, date: { type: "string" }, reference: { type: "string" },
      },
      required: ["facture", "montant"],
    },
    run: (i) => adv.enregistrerPaiement({ ...i, facture_id: i.facture }, "agent"),
  },
  {
    name: "lister_documents",
    description: "Liste devis, commandes ou factures, filtrables par statut, client ou texte (numéro, nom client).",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["devis", "commande", "facture"] }, statut: { type: "string" },
        client_id: { type: "integer" }, recherche: { type: "string" }, limite: { type: "integer" },
      },
      required: ["type"],
    },
    run: (i) => adv.listerDocuments(i.type, { statut: i.statut, client_id: i.client_id, q: i.recherche, limit: i.limite || 30 }),
  },
  {
    name: "consulter_document",
    description: "Détail complet d'un devis, d'une commande ou d'une facture (lignes, client, paiements).",
    input_schema: {
      type: "object",
      properties: { type: { type: "string", enum: ["devis", "commande", "facture"] }, document: { type: "string", description: "id ou numéro" } },
      required: ["type", "document"],
    },
    run: (i) => adv.getDocument(i.type, i.document),
  },
  {
    name: "preparer_email",
    description: "Rédige un e-mail au client (envoi de devis, accusé de réception de commande, avis d'expédition, envoi de facture, relance…). " +
      "Il est placé dans la boîte d'envoi pour validation humaine (sauf si l'envoi automatique est activé). Le document lié est joint automatiquement.",
    input_schema: {
      type: "object",
      properties: {
        client_id: { type: "integer" }, destinataire: { type: "string", description: "Par défaut : e-mail du client" },
        objet: { type: "string" }, corps: { type: "string", description: "Texte brut, avec formule de politesse et signature" },
        doc_type: { type: "string", enum: ["devis", "commande", "facture"] }, doc_id: { type: "integer" },
        motif: { type: "string", enum: ["envoi_devis", "relance_devis", "accuse_reception", "expedition", "envoi_facture", "relance", "information"] },
      },
      required: ["client_id", "objet", "corps", "motif"],
    },
    run: async (i) => {
      const c = adv.getClient(i.client_id);
      const dest = i.destinataire || c.email;
      if (!dest) throw new adv.AdvError(`Pas d'adresse e-mail pour ${c.raison_sociale} : la demander ou l'ajouter à la fiche client`);
      if (i.motif === "relance" && i.doc_type === "facture") {
        const f = adv.getDocument("facture", i.doc_id);
        const deja = get("SELECT id FROM emails WHERE doc_type='facture' AND doc_id=? AND motif='relance' AND statut='a_valider'", f.id);
        if (deja) throw new adv.AdvError(`Une relance pour ${f.numero} attend déjà validation (e-mail #${deja.id})`);
      }
      const r = run(`INSERT INTO emails(client_id, destinataire, objet, corps, doc_type, doc_id, motif) VALUES(?,?,?,?,?,?,?)`,
        c.id, dest, i.objet, i.corps, i.doc_type ?? null, i.doc_id ?? null, i.motif);
      const id = Number(r.lastInsertRowid);
      adv.journaliser("agent", "email_prepare", { id, a: dest, objet: i.objet });
      if (AGENT.envoiAuto) {
        await envoyerEmail(id, "agent");
        return { id, statut: "envoye" };
      }
      return { id, statut: "a_valider", info: "En attente de validation dans la boîte d'envoi" };
    },
  },
  {
    name: "points_de_vigilance",
    description: "Liste ce qui demande une action : factures en retard, devis envoyés sans réponse, commandes à confirmer, livraisons en retard, commandes livrées à facturer.",
    input_schema: { type: "object", properties: {} },
    run: () => ({ ...adv.pointsDeVigilance({ jours_relance_devis: AGENT.joursRelanceDevis }), jours_minimum_entre_relances: AGENT.joursEntreRelances }),
  },
  {
    name: "tableau_de_bord",
    description: "Indicateurs ADV : CA facturé du mois, prises de commandes, encours, retards, devis en attente, taux de transformation.",
    input_schema: { type: "object", properties: {} },
    run: () => adv.tableauDeBord(),
  },
];

const TOOL_DEFS = TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// Consignes de l'agent (stables → mises en cache)
// ---------------------------------------------------------------------------
const SYSTEM = `Tu es l'agent d'Administration des Ventes (ADV) de la société ${SOCIETE.nom}${SOCIETE.activite ? ` (${SOCIETE.activite})` : ""}.
Tu gères de bout en bout le cycle de vente : demande client → devis → commande → confirmation → préparation/expédition → livraison → facturation → encaissement → relances.
Tu travailles uniquement via tes outils, qui écrivent dans la base ADV de l'entreprise.

Règles :
- Avant de créer un client, cherche-le (nom, SIRET, e-mail) pour éviter les doublons. Crée-le seulement s'il est introuvable, avec les informations disponibles.
- Les prix viennent du catalogue. N'invente jamais un prix, une référence, une quantité ou une date : si une information indispensable manque ou est ambiguë, demande-la (ou, pour une demande arrivée par e-mail, prépare un e-mail au client pour la demander).
- Une référence demandée absente du catalogue : signale-le ; ne crée une ligne libre que si le prix est explicitement fourni.
- Signale les stocks insuffisants et les délais de fabrication/livraison du catalogue.
- Toute communication client passe par l'outil preparer_email : ton professionnel, vouvoiement, en français, précis (numéros de documents, montants TTC, dates), signé « ${SOCIETE.signature} ».
- Après chaque commande enregistrée, prépare l'accusé de réception (motif accuse_reception). Après chaque facture, prépare l'envoi de la facture.
- Relances d'impayés graduées : 1re relance courtoise ; 2e ferme rappelant les pénalités de retard et l'indemnité forfaitaire de 40 € ; à partir de la 3e, mise en demeure à faire valider par un responsable (le signaler). Respecte un délai minimum entre deux relances d'une même facture.
- Ne facture que des commandes livrées, sauf instruction contraire explicite.
- Montants : précise toujours HT ou TTC. Dates au format JJ/MM/AAAA dans les textes, AAAA-MM-JJ dans les outils.
- Si un outil renvoie une erreur, corrige ou explique ; ne prétends jamais avoir fait une action qui a échoué.
- Termine chaque tâche par un compte rendu court : actions réalisées (avec numéros), e-mails en attente de validation, points nécessitant une décision humaine.`;

// ---------------------------------------------------------------------------
// Boucle agent
// ---------------------------------------------------------------------------
const verrous = new Map(); // une seule exécution à la fois par conversation

export function creerConversation(titre, origine = "chat") {
  const r = run("INSERT INTO conversations(titre, origine) VALUES(?, ?)", titre || "Nouvelle conversation", origine);
  return Number(r.lastInsertRowid);
}

export function getConversation(id) {
  const c = get("SELECT * FROM conversations WHERE id = ?", id);
  if (!c) throw new Error("Conversation introuvable");
  return { ...c, messages: JSON.parse(c.messages) };
}

export async function executerOutil(block) {
  const outil = TOOL_MAP[block.name];
  try {
    if (!outil) throw new Error(`Outil inconnu : ${block.name}`);
    const res = await outil.run(block.input || {});
    return { type: "tool_result", tool_use_id: block.id, content: JSON.stringify(res) };
  } catch (err) {
    return { type: "tool_result", tool_use_id: block.id, content: `Erreur : ${err.message}`, is_error: true };
  }
}

/**
 * Envoie un message à l'agent dans une conversation et le laisse travailler jusqu'au bout.
 * @param {number} convId
 * @param {string|Array} contenu  texte, ou blocs de contenu (texte + PDF/images)
 */
export async function demanderAgent(convId, contenu) {
  if (verrous.get(convId)) throw new Error("L'agent travaille déjà sur cette conversation, patientez.");
  verrous.set(convId, true);
  try {
    const conv = getConversation(convId);
    const messages = conv.messages;
    const debut = messages.length;
    const contexte = `[Date du jour : ${adv.today()}]`;
    // Si le tour précédent s'est interrompu sur des appels d'outils sans réponse, on les clôt proprement.
    const dernier = messages.at(-1);
    const orphelins = dernier?.role === "assistant" && Array.isArray(dernier.content)
      ? dernier.content.filter((b) => b.type === "tool_use").map((b) => ({ type: "tool_result", tool_use_id: b.id, content: "Interrompu", is_error: true }))
      : [];
    const blocs = typeof contenu === "string" ? [{ type: "text", text: contenu }] : contenu;
    messages.push({ role: "user", content: [...orphelins, { type: "text", text: contexte }, ...blocs] });

    let fin = "";
    for (let tour = 0; tour < MAX_TOURS; tour++) {
      const res = await client.beta.messages.create({
        model: AGENT.model,
        max_tokens: 16000,
        system: SYSTEM,
        tools: TOOL_DEFS,
        messages,
        thinking: { type: "adaptive" },
        output_config: { effort: AGENT.effort },
        cache_control: { type: "ephemeral" },
        // Si le modèle principal décline une requête, l'API bascule sur un modèle de repli adapté.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      // On renvoie le contenu tel quel aux tours suivants (blocs de réflexion inclus).
      messages.push({ role: "assistant", content: res.content });

      if (res.stop_reason === "pause_turn") continue;
      if (res.stop_reason === "refusal") { fin = "refus"; break; }
      if (res.stop_reason === "max_tokens") { fin = "max_tokens"; break; }
      if (res.stop_reason !== "tool_use") break;

      const appels = res.content.filter((b) => b.type === "tool_use");
      const resultats = await Promise.all(appels.map(executerOutil));
      messages.push({ role: "user", content: resultats });
      // Sauvegarde intermédiaire : rien n'est perdu si le serveur s'arrête en cours de route.
      run("UPDATE conversations SET messages = ?, updated_at = datetime('now','localtime') WHERE id = ?", JSON.stringify(messages), convId);
      if (tour === MAX_TOURS - 1) fin = "limite_tours";
    }

    run("UPDATE conversations SET messages = ?, updated_at = datetime('now','localtime') WHERE id = ?", JSON.stringify(messages), convId);
    return { conversation_id: convId, nouveaux: vueMessages(messages.slice(debut)), fin };
  } finally {
    verrous.delete(convId);
  }
}

/** Transforme l'historique brut en éléments lisibles pour l'interface. */
export function vueMessages(messages) {
  const out = [];
  for (const m of messages) {
    const blocs = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    for (const b of blocs) {
      if (b.type === "text" && b.text.trim() && !b.text.startsWith("[Date du jour")) {
        out.push({ role: m.role, type: "texte", texte: b.text });
      } else if (b.type === "document" || b.type === "image") out.push({ role: m.role, type: "piece_jointe" });
      else if (b.type === "tool_use") out.push({ role: "agent", type: "action", outil: b.name, entree: b.input });
      else if (b.type === "tool_result" && b.is_error) out.push({ role: "agent", type: "erreur", texte: String(b.content) });
    }
  }
  return out.filter((x) => !(x.role === "user" && x.type === "texte" && !x.texte.trim()));
}

// ---------------------------------------------------------------------------
// Tâches automatiques
// ---------------------------------------------------------------------------
export async function routineQuotidienne() {
  const maj = adv.mettreAJourEcheances();
  const id = creerConversation(`Routine du ${new Date().toLocaleDateString("fr-FR")}`, "routine");
  adv.journaliser("systeme", "routine", maj);
  return demanderAgent(id, `Routine quotidienne ADV. Mise à jour automatique : ${JSON.stringify(maj)}.
1. Consulte les points de vigilance.
2. Prépare les relances des factures en retard (sauf si une relance a eu lieu il y a moins de ${AGENT.joursEntreRelances} jours ; adapte le ton au nombre de relances déjà faites).
3. Prépare une relance pour les devis envoyés sans réponse.
4. Signale les commandes à confirmer, les livraisons en retard et les commandes livrées à facturer (ne facture pas sans instruction).
5. Termine par une synthèse pour l'équipe.`);
}

export async function traiterEmailEntrant({ de, objet, texte, pieces = [] }) {
  const id = creerConversation(`E-mail : ${objet || de || "sans objet"}`.slice(0, 120), "email");
  const contenu = [
    ...pieces,
    { type: "text", text: `Nouvel e-mail reçu à traiter.\nDe : ${de || "?"}\nObjet : ${objet || ""}\n\n${texte || ""}\n\n` +
      "Identifie la demande (demande de devis, commande, réclamation, question sur une commande/facture, avis de paiement…) et traite-la avec tes outils. " +
      "Si des informations manquent, prépare un e-mail au client pour les demander." },
  ];
  return demanderAgent(id, contenu);
}
