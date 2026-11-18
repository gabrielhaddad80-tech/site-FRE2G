// Logique métier ADV : clients, catalogue, devis, commandes, factures, paiements, relances.
// Toutes les règles (numérotation, calculs, transitions de statut) sont ici, partagées
// par l'interface web et par l'agent : l'agent ne peut rien faire que l'ADV ne permette.
import { all, get, run, tx } from "./db.js";

export const STATUTS = {
  devis: ["brouillon", "envoye", "accepte", "refuse", "expire"],
  commande: ["recue", "confirmee", "en_preparation", "expediee", "livree", "facturee", "annulee"],
  facture: ["emise", "partiellement_payee", "payee", "en_retard", "annulee"],
};

const TABLE = { devis: "devis", commande: "commandes", facture: "factures" };
const PREFIXE = { devis: "DEV", commande: "CMD", facture: "FAC" };

export const today = () => new Date().toLocaleDateString("sv-SE"); // AAAA-MM-JJ
export const addDays = (iso, n) => {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + Number(n || 0));
  return d.toLocaleDateString("sv-SE");
};
const r2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;

export class AdvError extends Error {}

export function journaliser(acteur, action, details) {
  run("INSERT INTO journal(acteur, action, details) VALUES(?,?,?)", acteur, action,
    typeof details === "string" ? details : JSON.stringify(details));
}

function prochainNumero(type) {
  const annee = new Date().getFullYear();
  const prefix = `${PREFIXE[type]}-${annee}-`;
  const last = get(`SELECT numero FROM ${TABLE[type]} WHERE numero LIKE ? ORDER BY numero DESC LIMIT 1`, prefix + "%");
  const n = last ? parseInt(last.numero.slice(prefix.length), 10) + 1 : 1;
  return prefix + String(n).padStart(4, "0");
}

// ---------- Clients ----------
export function rechercherClients(q = "", limit = 20) {
  const like = `%${q}%`;
  return all(`SELECT * FROM clients WHERE raison_sociale LIKE ? OR code LIKE ? OR email LIKE ? OR contact LIKE ? OR ville LIKE ? OR siret LIKE ?
              ORDER BY raison_sociale LIMIT ?`, like, like, like, like, like, like, limit);
}
export function getClient(id) {
  const c = get("SELECT * FROM clients WHERE id = ?", id);
  if (!c) throw new AdvError(`Client ${id} introuvable`);
  return c;
}
const CHAMPS_CLIENT = ["code", "raison_sociale", "siret", "tva_intra", "contact", "email", "telephone", "adresse",
  "code_postal", "ville", "pays", "delai_paiement_jours", "remise_pct", "notes"];

export function enregistrerClient(data, acteur = "utilisateur") {
  const champs = CHAMPS_CLIENT.filter((k) => data[k] !== undefined && data[k] !== null);
  if (data.id) {
    getClient(data.id);
    if (!champs.length) return getClient(data.id);
    run(`UPDATE clients SET ${champs.map((k) => k + " = ?").join(", ")} WHERE id = ?`, ...champs.map((k) => data[k]), data.id);
    journaliser(acteur, "client_modifie", { id: data.id, champs });
    return getClient(data.id);
  }
  if (!data.raison_sociale) throw new AdvError("raison_sociale obligatoire");
  if (!data.code) {
    const n = (get("SELECT COUNT(*) n FROM clients").n || 0) + 1;
    data.code = "CL" + String(n).padStart(4, "0");
    while (get("SELECT 1 FROM clients WHERE code = ?", data.code)) data.code += "B";
  }
  const c2 = CHAMPS_CLIENT.filter((k) => data[k] !== undefined && data[k] !== null);
  const r = run(`INSERT INTO clients(${c2.join(",")}) VALUES(${c2.map(() => "?").join(",")})`, ...c2.map((k) => data[k]));
  journaliser(acteur, "client_cree", { id: r.lastInsertRowid, raison_sociale: data.raison_sociale });
  return getClient(r.lastInsertRowid);
}

// ---------- Catalogue ----------
export function rechercherProduits(q = "", limit = 30) {
  const like = `%${q}%`;
  return all(`SELECT * FROM produits WHERE actif = 1 AND (reference LIKE ? OR designation LIKE ?) ORDER BY reference LIMIT ?`, like, like, limit);
}
export function enregistrerProduit(p, acteur = "utilisateur") {
  if (!p.reference || !p.designation) throw new AdvError("reference et designation obligatoires");
  run(`INSERT INTO produits(reference, designation, unite, prix_ht, tva_taux, stock, delai_jours, actif)
       VALUES(?,?,?,?,?,?,?,1)
       ON CONFLICT(reference) DO UPDATE SET designation=excluded.designation, unite=excluded.unite, prix_ht=excluded.prix_ht,
         tva_taux=excluded.tva_taux, stock=excluded.stock, delai_jours=excluded.delai_jours, actif=1`,
    p.reference, p.designation, p.unite || "u", Number(p.prix_ht) || 0, p.tva_taux ?? 20, p.stock ?? null, p.delai_jours ?? null);
  journaliser(acteur, "produit_enregistre", { reference: p.reference });
  return get("SELECT * FROM produits WHERE reference = ?", p.reference);
}

// ---------- Lignes & totaux ----------
function resoudreLignes(lignes, client) {
  if (!Array.isArray(lignes) || !lignes.length) throw new AdvError("Au moins une ligne est requise");
  return lignes.map((l, i) => {
    let prod = null;
    if (l.produit_id) prod = get("SELECT * FROM produits WHERE id = ?", l.produit_id);
    else if (l.reference) prod = get("SELECT * FROM produits WHERE reference = ?", l.reference);
    if (!prod && !l.designation) throw new AdvError(`Ligne ${i + 1} : produit « ${l.reference || l.produit_id} » introuvable au catalogue (donner une designation et un prix_ht pour une ligne libre)`);
    const prix = l.prix_ht ?? prod?.prix_ht;
    if (prix === undefined || prix === null) throw new AdvError(`Ligne ${i + 1} : prix_ht manquant`);
    const qte = Number(l.quantite);
    if (!(qte > 0)) throw new AdvError(`Ligne ${i + 1} : quantité invalide`);
    return {
      produit_id: prod?.id ?? null,
      reference: prod?.reference ?? l.reference ?? null,
      designation: l.designation || prod.designation,
      quantite: qte,
      unite: prod?.unite || l.unite || "u",
      prix_ht: Number(prix),
      remise_pct: Number(l.remise_pct ?? client?.remise_pct ?? 0),
      tva_taux: Number(l.tva_taux ?? prod?.tva_taux ?? 20),
    };
  });
}

function totaux(lignes) {
  let ht = 0, tva = 0;
  for (const l of lignes) {
    const mt = r2(l.quantite * l.prix_ht * (1 - (l.remise_pct || 0) / 100));
    ht += mt;
    tva += mt * l.tva_taux / 100;
  }
  ht = r2(ht); tva = r2(tva);
  return { total_ht: ht, total_tva: tva, total_ttc: r2(ht + tva) };
}

function insererLignes(type, id, lignes) {
  for (const l of lignes) {
    run(`INSERT INTO lignes(doc_type, doc_id, produit_id, reference, designation, quantite, unite, prix_ht, remise_pct, tva_taux)
         VALUES(?,?,?,?,?,?,?,?,?,?)`, type, id, l.produit_id, l.reference, l.designation, l.quantite, l.unite, l.prix_ht, l.remise_pct, l.tva_taux);
  }
}
const lignesDe = (type, id) => all("SELECT * FROM lignes WHERE doc_type = ? AND doc_id = ? ORDER BY id", type, id);

// ---------- Documents ----------
export function getDocument(type, idOuNumero) {
  if (!TABLE[type]) throw new AdvError(`Type inconnu : ${type}`);
  const doc = typeof idOuNumero === "string" && isNaN(Number(idOuNumero))
    ? get(`SELECT * FROM ${TABLE[type]} WHERE numero = ?`, idOuNumero)
    : get(`SELECT * FROM ${TABLE[type]} WHERE id = ?`, Number(idOuNumero));
  if (!doc) throw new AdvError(`${type} ${idOuNumero} introuvable`);
  doc.type = type;
  doc.client = get("SELECT * FROM clients WHERE id = ?", doc.client_id);
  doc.lignes = lignesDe(type, doc.id);
  if (type === "facture") {
    doc.paiements = all("SELECT * FROM paiements WHERE facture_id = ? ORDER BY date", doc.id);
    doc.reste_a_payer = r2(doc.total_ttc - doc.montant_paye);
  }
  if (type === "devis") doc.date_fin_validite = addDays(doc.date, doc.validite_jours);
  return doc;
}

export function listerDocuments(type, { statut, client_id, q, limit = 50 } = {}) {
  if (!TABLE[type]) throw new AdvError(`Type inconnu : ${type}`);
  const where = [], p = [];
  if (statut) { where.push("d.statut = ?"); p.push(statut); }
  if (client_id) { where.push("d.client_id = ?"); p.push(client_id); }
  if (q) { where.push("(d.numero LIKE ? OR c.raison_sociale LIKE ?)"); p.push(`%${q}%`, `%${q}%`); }
  return all(`SELECT d.*, c.raison_sociale AS client FROM ${TABLE[type]} d JOIN clients c ON c.id = d.client_id
              ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY d.id DESC LIMIT ?`, ...p, limit);
}

export function creerDevis({ client_id, lignes, validite_jours = 30, objet, notes }, acteur = "utilisateur") {
  const client = getClient(client_id);
  const L = resoudreLignes(lignes, client);
  const t = totaux(L);
  return tx(() => {
    const numero = prochainNumero("devis");
    const r = run(`INSERT INTO devis(numero, client_id, date, validite_jours, objet, notes, total_ht, total_tva, total_ttc)
                   VALUES(?,?,?,?,?,?,?,?,?)`, numero, client_id, today(), validite_jours, objet ?? null, notes ?? null, t.total_ht, t.total_tva, t.total_ttc);
    insererLignes("devis", r.lastInsertRowid, L);
    journaliser(acteur, "devis_cree", { numero, client: client.raison_sociale, total_ht: t.total_ht });
    return getDocument("devis", r.lastInsertRowid);
  });
}

export function changerStatutDevis(id, statut, acteur = "utilisateur") {
  const d = getDocument("devis", id);
  if (!STATUTS.devis.includes(statut)) throw new AdvError(`Statut devis invalide : ${statut}`);
  if (d.commande_id && statut !== "accepte") throw new AdvError("Ce devis a déjà été transformé en commande");
  run("UPDATE devis SET statut = ? WHERE id = ?", statut, d.id);
  journaliser(acteur, "devis_statut", { numero: d.numero, de: d.statut, vers: statut });
  return getDocument("devis", d.id);
}

export function creerCommande({ client_id, lignes, ref_client, date_livraison_prevue, adresse_livraison, notes, devis_id }, acteur = "utilisateur") {
  const client = getClient(client_id);
  const L = resoudreLignes(lignes, client);
  const t = totaux(L);
  return tx(() => {
    const numero = prochainNumero("commande");
    const r = run(`INSERT INTO commandes(numero, client_id, devis_id, date, ref_client, date_livraison_prevue, adresse_livraison, notes, total_ht, total_tva, total_ttc)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?)`, numero, client_id, devis_id ?? null, today(), ref_client ?? null, date_livraison_prevue ?? null,
      adresse_livraison ?? null, notes ?? null, t.total_ht, t.total_tva, t.total_ttc);
    insererLignes("commande", r.lastInsertRowid, L);
    journaliser(acteur, "commande_creee", { numero, client: client.raison_sociale, total_ht: t.total_ht, ref_client });
    return getDocument("commande", r.lastInsertRowid);
  });
}

export function convertirDevis(devis_id, extra = {}, acteur = "utilisateur") {
  const d = getDocument("devis", devis_id);
  if (d.commande_id) throw new AdvError(`Devis ${d.numero} déjà transformé en commande`);
  if (["refuse", "expire"].includes(d.statut)) throw new AdvError(`Devis ${d.numero} au statut ${d.statut}`);
  return tx(() => {
    const cmd = creerCommande({
      client_id: d.client_id,
      lignes: d.lignes.map((l) => ({ ...l, produit_id: null })), // reprend les prix du devis tels quels
      devis_id: d.id, notes: d.notes, ...extra,
    }, acteur);
    run("UPDATE devis SET statut = 'accepte', commande_id = ? WHERE id = ?", cmd.id, d.id);
    return cmd;
  });
}

const TRANSITIONS_COMMANDE = {
  recue: ["confirmee", "annulee"],
  confirmee: ["en_preparation", "expediee", "livree", "annulee"],
  en_preparation: ["expediee", "livree", "annulee"],
  expediee: ["livree"],
  livree: [],
  facturee: [],
  annulee: [],
};

export function changerStatutCommande(id, { statut, date_livraison_prevue, transporteur, numero_suivi, note }, acteur = "utilisateur") {
  const c = getDocument("commande", id);
  if (statut && statut !== c.statut) {
    if (statut === "facturee") throw new AdvError("Utiliser la facturation pour passer une commande en « facturee »");
    if (!TRANSITIONS_COMMANDE[c.statut]?.includes(statut))
      throw new AdvError(`Transition impossible : ${c.statut} → ${statut} (possibles : ${TRANSITIONS_COMMANDE[c.statut].join(", ") || "aucune"})`);
  }
  run(`UPDATE commandes SET statut = COALESCE(?, statut), date_livraison_prevue = COALESCE(?, date_livraison_prevue),
       transporteur = COALESCE(?, transporteur), numero_suivi = COALESCE(?, numero_suivi),
       notes = CASE WHEN ? IS NULL THEN notes ELSE trim(COALESCE(notes,'') || char(10) || ?) END WHERE id = ?`,
    statut ?? null, date_livraison_prevue ?? null, transporteur ?? null, numero_suivi ?? null, note ?? null, note ?? null, c.id);
  journaliser(acteur, "commande_maj", { numero: c.numero, de: c.statut, vers: statut ?? c.statut, date_livraison_prevue, numero_suivi });
  return getDocument("commande", c.id);
}

export function facturerCommande(commande_id, acteur = "utilisateur") {
  const c = getDocument("commande", commande_id);
  if (c.statut === "facturee") throw new AdvError(`Commande ${c.numero} déjà facturée`);
  if (c.statut === "annulee") throw new AdvError(`Commande ${c.numero} annulée`);
  const delai = c.client.delai_paiement_jours ?? 30;
  return tx(() => {
    const numero = prochainNumero("facture");
    const date = today();
    const r = run(`INSERT INTO factures(numero, client_id, commande_id, date, echeance, total_ht, total_tva, total_ttc)
                   VALUES(?,?,?,?,?,?,?,?)`, numero, c.client_id, c.id, date, addDays(date, delai), c.total_ht, c.total_tva, c.total_ttc);
    insererLignes("facture", r.lastInsertRowid, c.lignes);
    run("UPDATE commandes SET statut = 'facturee' WHERE id = ?", c.id);
    journaliser(acteur, "facture_emise", { numero, commande: c.numero, total_ttc: c.total_ttc });
    return getDocument("facture", r.lastInsertRowid);
  });
}

export function enregistrerPaiement({ facture_id, montant, mode, date, reference }, acteur = "utilisateur") {
  const f = getDocument("facture", facture_id);
  if (f.statut === "annulee") throw new AdvError("Facture annulée");
  const m = r2(montant);
  if (!(m > 0)) throw new AdvError("Montant invalide");
  if (m > r2(f.reste_a_payer + 0.01)) throw new AdvError(`Montant (${m}) supérieur au reste à payer (${f.reste_a_payer})`);
  return tx(() => {
    run("INSERT INTO paiements(facture_id, date, montant, mode, reference) VALUES(?,?,?,?,?)", f.id, date || today(), m, mode ?? null, reference ?? null);
    const paye = r2(f.montant_paye + m);
    const statut = paye >= f.total_ttc - 0.009 ? "payee" : "partiellement_payee";
    run("UPDATE factures SET montant_paye = ?, statut = ? WHERE id = ?", paye, statut, f.id);
    journaliser(acteur, "paiement", { facture: f.numero, montant: m, mode });
    return getDocument("facture", f.id);
  });
}

export function marquerRelance(facture_id) {
  run("UPDATE factures SET nb_relances = nb_relances + 1, derniere_relance = ? WHERE id = ?", today(), facture_id);
}

// ---------- Suivi / alertes ----------
export function mettreAJourEcheances() {
  const r1 = run(`UPDATE factures SET statut = 'en_retard' WHERE statut IN ('emise','partiellement_payee') AND echeance < ?`, today());
  const r2_ = run(`UPDATE devis SET statut = 'expire' WHERE statut IN ('brouillon','envoye') AND date(date, '+' || validite_jours || ' days') < ?`, today());
  return { factures_en_retard: Number(r1.changes), devis_expires: Number(r2_.changes) };
}

export function pointsDeVigilance({ jours_relance_devis = 7 } = {}) {
  const t = today();
  return {
    factures_en_retard: all(`SELECT f.id, f.numero, c.raison_sociale client, c.email, f.echeance, f.total_ttc, f.montant_paye,
        round(f.total_ttc - f.montant_paye, 2) reste, f.nb_relances, f.derniere_relance,
        CAST(julianday(?) - julianday(f.echeance) AS INTEGER) jours_retard
      FROM factures f JOIN clients c ON c.id = f.client_id WHERE f.statut = 'en_retard' ORDER BY f.echeance`, t),
    devis_sans_reponse: all(`SELECT d.id, d.numero, c.raison_sociale client, c.email, d.date, d.total_ht,
        CAST(julianday(?) - julianday(d.date) AS INTEGER) age_jours
      FROM devis d JOIN clients c ON c.id = d.client_id WHERE d.statut = 'envoye' AND julianday(?) - julianday(d.date) >= ?`, t, t, jours_relance_devis),
    commandes_a_confirmer: all(`SELECT d.id, d.numero, c.raison_sociale client, d.date, d.total_ht FROM commandes d JOIN clients c ON c.id = d.client_id WHERE d.statut = 'recue'`),
    livraisons_en_retard: all(`SELECT d.id, d.numero, c.raison_sociale client, d.date_livraison_prevue, d.statut FROM commandes d JOIN clients c ON c.id = d.client_id
      WHERE d.statut IN ('confirmee','en_preparation','expediee') AND d.date_livraison_prevue < ?`, t),
    commandes_a_facturer: all(`SELECT d.id, d.numero, c.raison_sociale client, d.total_ttc FROM commandes d JOIN clients c ON c.id = d.client_id WHERE d.statut = 'livree'`),
  };
}

export function tableauDeBord() {
  const mois = today().slice(0, 7);
  const one = (sql, ...p) => Object.values(get(sql, ...p))[0] ?? 0;
  return {
    date: today(),
    ca_facture_mois_ht: r2(one("SELECT COALESCE(SUM(total_ht),0) FROM factures WHERE statut != 'annulee' AND substr(date,1,7) = ?", mois)),
    commandes_mois_ht: r2(one("SELECT COALESCE(SUM(total_ht),0) FROM commandes WHERE statut != 'annulee' AND substr(date,1,7) = ?", mois)),
    encours_clients_ttc: r2(one("SELECT COALESCE(SUM(total_ttc - montant_paye),0) FROM factures WHERE statut IN ('emise','partiellement_payee','en_retard')")),
    retard_ttc: r2(one("SELECT COALESCE(SUM(total_ttc - montant_paye),0) FROM factures WHERE statut = 'en_retard'")),
    devis_en_attente: one("SELECT COUNT(*) FROM devis WHERE statut IN ('brouillon','envoye')"),
    devis_en_attente_ht: r2(one("SELECT COALESCE(SUM(total_ht),0) FROM devis WHERE statut IN ('brouillon','envoye')")),
    commandes_en_cours: one("SELECT COUNT(*) FROM commandes WHERE statut IN ('recue','confirmee','en_preparation','expediee')"),
    commandes_a_facturer: one("SELECT COUNT(*) FROM commandes WHERE statut = 'livree'"),
    emails_a_valider: one("SELECT COUNT(*) FROM emails WHERE statut = 'a_valider'"),
    taux_transformation_devis_pct: (() => {
      const tot = one("SELECT COUNT(*) FROM devis WHERE statut IN ('accepte','refuse','expire')");
      return tot ? Math.round(one("SELECT COUNT(*) FROM devis WHERE statut = 'accepte'") * 100 / tot) : null;
    })(),
  };
}
