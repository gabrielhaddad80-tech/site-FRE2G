import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { all, get, run, getMeta, setMeta } from "./db.js";
import * as adv from "./adv.js";
import { AGENT, SOCIETE } from "./config.js";
import { renderDocument } from "./documents.js";
import { envoyerEmail, smtpConfigure } from "./mailer.js";
import { creerConversation, demanderAgent, getConversation, vueMessages, routineQuotidienne, traiterEmailEntrant } from "./agent.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "25mb" }));

// ---------- Sécurité ----------
const egal = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Webhook e-mails entrants (Make, Zapier, n8n, Power Automate…) : protégé par un jeton.
app.post("/api/entrant/email", async (req, res) => {
  const jeton = req.get("x-adv-token") || req.query.token || "";
  if (!process.env.WEBHOOK_TOKEN || !egal(String(jeton), process.env.WEBHOOK_TOKEN)) return res.status(401).json({ erreur: "Jeton invalide" });
  const { de, objet, texte, pieces_jointes = [] } = req.body || {};
  res.json({ ok: true, info: "Pris en charge par l'agent" });
  traiterEmailEntrant({ de, objet, texte, pieces: pieces_jointes.map(versBloc).filter(Boolean) })
    .catch((e) => adv.journaliser("systeme", "erreur_email_entrant", String(e.message)));
});

// Interface et API : mot de passe unique (authentification HTTP Basic).
app.use((req, res, next) => {
  const mdp = process.env.ADMIN_PASSWORD;
  if (!mdp) return next();
  const [type, val] = (req.get("authorization") || "").split(" ");
  if (type === "Basic" && val) {
    const [, pass] = Buffer.from(val, "base64").toString().split(/:(.*)/s);
    if (pass && egal(pass, mdp)) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="ADV"').status(401).send("Authentification requise");
});

app.use(express.static(path.join(here, "..", "public")));

const h = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (e) {
    const status = e instanceof adv.AdvError ? 400 : e.status || 500;
    if (status >= 500) console.error(e);
    res.status(status).json({ erreur: e.message });
  }
};

function versBloc(p) {
  // { nom, type_mime, base64 } → bloc de contenu Claude
  if (!p?.base64) return null;
  if (p.type_mime === "application/pdf") return { type: "document", source: { type: "base64", media_type: "application/pdf", data: p.base64 } };
  if (/^image\/(png|jpeg|gif|webp)$/.test(p.type_mime)) return { type: "image", source: { type: "base64", media_type: p.type_mime, data: p.base64 } };
  if (/^text\//.test(p.type_mime)) return { type: "text", text: `Pièce jointe ${p.nom || ""} :\n` + Buffer.from(p.base64, "base64").toString("utf8") };
  return null;
}

// ---------- Infos ----------
app.get("/api/statut", h(() => ({
  societe: SOCIETE.nom,
  agent_configure: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  smtp_configure: smtpConfigure(),
  envoi_auto: AGENT.envoiAuto,
  routine: AGENT.routineActive ? `tous les jours à ${AGENT.routineHeure} h` : "désactivée",
  derniere_routine: getMeta("derniere_routine"),
})));
app.get("/api/tableau-de-bord", h(() => { adv.mettreAJourEcheances(); return { kpi: adv.tableauDeBord(), vigilance: adv.pointsDeVigilance({ jours_relance_devis: AGENT.joursRelanceDevis }) }; }));
app.get("/api/journal", h(() => all("SELECT * FROM journal ORDER BY id DESC LIMIT 200")));

// ---------- Clients & catalogue ----------
app.get("/api/clients", h((req) => adv.rechercherClients(req.query.q || "", 500)));
app.post("/api/clients", h((req) => adv.enregistrerClient(req.body)));
app.get("/api/produits", h((req) => adv.rechercherProduits(req.query.q || "", 1000)));
app.post("/api/produits", h((req) => adv.enregistrerProduit(req.body)));

// Import CSV (séparateur ; ou ,) — première ligne = en-têtes correspondant aux champs.
function parseCSV(txt) {
  const lignes = txt.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  const sep = (lignes[0].match(/;/g) || []).length >= (lignes[0].match(/,/g) || []).length ? ";" : ",";
  const split = (l) => {
    const out = []; let cur = "", q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (ch === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === sep && !q) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const head = split(lignes[0]).map((s) => s.toLowerCase());
  return lignes.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i], v === "" ? undefined : v])));
}
const num = (v) => (v === undefined ? undefined : Number(String(v).replace(/\s/g, "").replace(",", ".")));
app.post("/api/import/:type", express.text({ type: "*/*", limit: "10mb" }), h((req) => {
  const rows = parseCSV(String(req.body || ""));
  const erreurs = []; let ok = 0;
  rows.forEach((r, i) => {
    try {
      if (req.params.type === "produits") adv.enregistrerProduit({ ...r, prix_ht: num(r.prix_ht), tva_taux: num(r.tva_taux), stock: num(r.stock), delai_jours: num(r.delai_jours) }, "import");
      else if (req.params.type === "clients") {
        const ex = r.code && get("SELECT id FROM clients WHERE code = ?", r.code);
        adv.enregistrerClient({ ...r, id: ex?.id, delai_paiement_jours: num(r.delai_paiement_jours), remise_pct: num(r.remise_pct) }, "import");
      } else throw new Error("type inconnu");
      ok++;
    } catch (e) { erreurs.push(`Ligne ${i + 2} : ${e.message}`); }
  });
  return { importes: ok, erreurs };
}));

// ---------- Documents ----------
const TYPES = { devis: "devis", commandes: "commande", factures: "facture" };
app.get("/api/:docs(devis|commandes|factures)", h((req) => adv.listerDocuments(TYPES[req.params.docs], { statut: req.query.statut, q: req.query.q, limit: 500 })));
app.get("/api/:docs(devis|commandes|factures)/:id", h((req) => adv.getDocument(TYPES[req.params.docs], req.params.id)));
app.post("/api/devis/:id/statut", h((req) => adv.changerStatutDevis(req.params.id, req.body.statut)));
app.post("/api/devis/:id/commande", h((req) => adv.convertirDevis(req.params.id, req.body || {})));
app.post("/api/commandes/:id/maj", h((req) => adv.changerStatutCommande(req.params.id, req.body || {})));
app.post("/api/commandes/:id/facturer", h((req) => adv.facturerCommande(req.params.id)));
app.post("/api/factures/:id/paiement", h((req) => adv.enregistrerPaiement({ ...req.body, facture_id: req.params.id })));
app.get("/doc/:type(devis|commande|facture)/:id", (req, res) => {
  try { res.type("html").send(renderDocument(adv.getDocument(req.params.type, req.params.id))); }
  catch (e) { res.status(404).send(e.message); }
});

// ---------- Boîte d'envoi ----------
app.get("/api/emails", h((req) => all(`SELECT e.*, c.raison_sociale client FROM emails e LEFT JOIN clients c ON c.id = e.client_id
  ${req.query.statut ? "WHERE e.statut = ?" : ""} ORDER BY e.id DESC LIMIT 300`, ...(req.query.statut ? [req.query.statut] : []))));
app.post("/api/emails/:id", h((req) => {
  const { objet, corps, destinataire } = req.body;
  run("UPDATE emails SET objet = COALESCE(?, objet), corps = COALESCE(?, corps), destinataire = COALESCE(?, destinataire) WHERE id = ? AND statut != 'envoye'",
    objet ?? null, corps ?? null, destinataire ?? null, req.params.id);
  return get("SELECT * FROM emails WHERE id = ?", req.params.id);
}));
app.post("/api/emails/:id/envoyer", h((req) => envoyerEmail(Number(req.params.id))));
app.post("/api/emails/:id/rejeter", h((req) => { run("UPDATE emails SET statut = 'rejete' WHERE id = ? AND statut != 'envoye'", req.params.id); return { ok: true }; }));

// ---------- Agent ----------
app.get("/api/conversations", h(() => all("SELECT id, titre, origine, created_at, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 100")));
app.get("/api/conversations/:id", h((req) => { const c = getConversation(Number(req.params.id)); return { ...c, messages: vueMessages(c.messages) }; }));
app.post("/api/agent", h(async (req) => {
  const { conversation_id, message, pieces_jointes = [] } = req.body || {};
  if (!message?.trim() && !pieces_jointes.length) throw new adv.AdvError("Message vide");
  const id = conversation_id || creerConversation((message || "Pièce jointe").slice(0, 80));
  const blocs = [...pieces_jointes.map(versBloc).filter(Boolean), { type: "text", text: message || "Traite le document joint." }];
  return demanderAgent(Number(id), blocs);
}));
app.post("/api/agent/routine", h(() => routineQuotidienne()));

// ---------- Planificateur : routine quotidienne ----------
setInterval(async () => {
  if (!AGENT.routineActive) return;
  const now = new Date();
  const jour = adv.today();
  const ouvre = now.getDay() !== 0 && now.getDay() !== 6;
  if (ouvre && now.getHours() >= AGENT.routineHeure && getMeta("derniere_routine") !== jour) {
    setMeta("derniere_routine", jour);
    try { await routineQuotidienne(); } catch (e) { adv.journaliser("systeme", "erreur_routine", String(e.message)); }
  }
}, 60_000);

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`ADV ${SOCIETE.nom} démarrée sur http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn("⚠ ANTHROPIC_API_KEY absente : l'agent ne pourra pas répondre (voir .env.example).");
  if (!process.env.ADMIN_PASSWORD) console.warn("⚠ ADMIN_PASSWORD absent : l'interface n'est pas protégée.");
});
