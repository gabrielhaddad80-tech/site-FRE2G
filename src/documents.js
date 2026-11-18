// Rendu HTML imprimable (Ctrl+P → PDF) des devis, accusés de réception de commande et factures.
import { SOCIETE } from "./config.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const eur = (n) => Number(n || 0).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
const dfr = (iso) => (iso ? new Date(iso + "T12:00:00").toLocaleDateString("fr-FR") : "");
const TITRES = { devis: "DEVIS", commande: "ACCUSÉ DE RÉCEPTION DE COMMANDE", facture: "FACTURE" };

export function renderDocument(doc) {
  const s = SOCIETE, c = doc.client || {};
  const lignes = doc.lignes.map((l) => {
    const mt = l.quantite * l.prix_ht * (1 - (l.remise_pct || 0) / 100);
    return `<tr><td>${esc(l.reference)}</td><td>${esc(l.designation)}</td><td class=n>${l.quantite} ${esc(l.unite)}</td>
      <td class=n>${eur(l.prix_ht)}</td><td class=n>${l.remise_pct ? l.remise_pct + " %" : ""}</td><td class=n>${l.tva_taux} %</td><td class=n>${eur(mt)}</td></tr>`;
  }).join("");
  const infos = [
    `<b>Date :</b> ${dfr(doc.date)}`,
    doc.type === "devis" && `<b>Valable jusqu'au :</b> ${dfr(doc.date_fin_validite)}`,
    doc.ref_client && `<b>Votre référence :</b> ${esc(doc.ref_client)}`,
    doc.date_livraison_prevue && `<b>Livraison prévue :</b> ${dfr(doc.date_livraison_prevue)}`,
    doc.type === "facture" && `<b>Échéance :</b> ${dfr(doc.echeance)}`,
  ].filter(Boolean).join("<br>");
  return `<!doctype html><html lang=fr><head><meta charset=utf-8><title>${esc(doc.numero)}</title><style>
  body{font:13px/1.45 system-ui,Arial,sans-serif;color:#222;max-width:820px;margin:24px auto;padding:0 16px}
  header{display:flex;justify-content:space-between;gap:24px}h1{font-size:20px;margin:0 0 4px}
  .box{border:1px solid #ccc;padding:10px 14px;border-radius:6px;min-width:260px}
  table{width:100%;border-collapse:collapse;margin-top:20px}th,td{padding:6px;border-bottom:1px solid #e3e3e3;text-align:left;vertical-align:top}
  th{background:#f3f5f8}.n{text-align:right;white-space:nowrap}.tot{margin-left:auto;width:300px;margin-top:12px}
  .tot td{border:0}.tot tr:last-child td{font-weight:700;font-size:15px;border-top:2px solid #222}
  footer{margin-top:36px;font-size:11px;color:#555;border-top:1px solid #ddd;padding-top:8px}
  @media print{body{margin:0}.noprint{display:none}}</style></head><body>
  <p class=noprint><button onclick=print()>Imprimer / Enregistrer en PDF</button></p>
  <header><div><h1>${esc(s.nom)} ${esc(s.forme)}</h1>${esc(s.adresse)}<br>${esc(s.code_postal)} ${esc(s.ville)}<br>
  ${esc(s.telephone)} ${s.email ? "· " + esc(s.email) : ""}<br>${s.siret ? "SIRET " + esc(s.siret) : ""} ${s.tva_intra ? "· TVA " + esc(s.tva_intra) : ""}</div>
  <div class=box><b>${esc(c.raison_sociale)}</b><br>${esc(c.contact)}<br>${esc(c.adresse)}<br>${esc(c.code_postal)} ${esc(c.ville)}
  ${c.tva_intra ? "<br>TVA " + esc(c.tva_intra) : ""}</div></header>
  <h2>${TITRES[doc.type]} N° ${esc(doc.numero)}</h2><p>${infos}</p>${doc.objet ? `<p><b>Objet :</b> ${esc(doc.objet)}</p>` : ""}
  <table><thead><tr><th>Réf.</th><th>Désignation</th><th class=n>Qté</th><th class=n>PU HT</th><th class=n>Remise</th><th class=n>TVA</th><th class=n>Total HT</th></tr></thead>
  <tbody>${lignes}</tbody></table>
  <table class=tot><tr><td>Total HT</td><td class=n>${eur(doc.total_ht)}</td></tr><tr><td>TVA</td><td class=n>${eur(doc.total_tva)}</td></tr>
  ${doc.type === "facture" && doc.montant_paye ? `<tr><td>Déjà réglé</td><td class=n>${eur(doc.montant_paye)}</td></tr>` : ""}
  <tr><td>${doc.type === "facture" && doc.montant_paye ? "Reste à payer" : "Total TTC"}</td><td class=n>${eur(doc.type === "facture" ? doc.total_ttc - doc.montant_paye : doc.total_ttc)}</td></tr></table>
  ${doc.notes ? `<p><b>Notes :</b><br>${esc(doc.notes).replace(/\n/g, "<br>")}</p>` : ""}
  ${doc.type === "devis" ? "<p>Bon pour accord (date, cachet et signature) :</p><div style='height:70px'></div>" : ""}
  ${doc.type === "facture" && s.iban ? `<p><b>Règlement par virement</b> — IBAN ${esc(s.iban)} ${s.bic ? "· BIC " + esc(s.bic) : ""}</p>` : ""}
  <footer>${esc(s.conditions)}<br>${esc(s.nom)} ${esc(s.forme)} ${s.capital ? "au capital de " + esc(s.capital) : ""} ${s.rcs ? "· RCS " + esc(s.rcs) : ""}</footer>
  </body></html>`;
}
