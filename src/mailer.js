// Envoi des e-mails préparés (boîte d'envoi). SMTP configuré dans .env ; sinon mode « simulation ».
import nodemailer from "nodemailer";
import { get, run } from "./db.js";
import { journaliser, marquerRelance, changerStatutDevis, getDocument } from "./adv.js";
import { SOCIETE } from "./config.js";
import { renderDocument } from "./documents.js";

const e = process.env;
const transport = e.SMTP_HOST
  ? nodemailer.createTransport({
      host: e.SMTP_HOST,
      port: Number(e.SMTP_PORT || 587),
      secure: Number(e.SMTP_PORT) === 465,
      auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASS } : undefined,
    })
  : null;

export const smtpConfigure = () => Boolean(transport);

export async function envoyerEmail(id, acteur = "utilisateur") {
  const m = get("SELECT * FROM emails WHERE id = ?", id);
  if (!m) throw new Error("E-mail introuvable");
  if (m.statut === "envoye") throw new Error("Déjà envoyé");
  try {
    if (transport) {
      const attachments = [];
      if (m.doc_type && m.doc_id) {
        const doc = getDocument(m.doc_type, m.doc_id);
        attachments.push({ filename: `${doc.numero}.html`, content: renderDocument(doc), contentType: "text/html" });
      }
      await transport.sendMail({
        from: e.SMTP_FROM || SOCIETE.email,
        to: m.destinataire,
        bcc: e.SMTP_COPIE || undefined,
        subject: m.objet,
        text: m.corps,
        attachments,
      });
    }
    run("UPDATE emails SET statut = 'envoye', sent_at = datetime('now','localtime'), erreur = ? WHERE id = ?",
      transport ? null : "Mode simulation (SMTP non configuré) : e-mail non réellement envoyé", id);
    // Effets métier de l'envoi
    if (m.doc_type === "facture" && m.motif === "relance") marquerRelance(m.doc_id);
    if (m.doc_type === "devis" && m.motif === "envoi_devis") {
      const d = getDocument("devis", m.doc_id);
      if (d.statut === "brouillon") changerStatutDevis(d.id, "envoye", acteur);
    }
    journaliser(acteur, "email_envoye", { id, a: m.destinataire, objet: m.objet, simulation: !transport });
  } catch (err) {
    run("UPDATE emails SET statut = 'erreur', erreur = ? WHERE id = ?", String(err.message || err), id);
    throw err;
  }
  return get("SELECT * FROM emails WHERE id = ?", id);
}
