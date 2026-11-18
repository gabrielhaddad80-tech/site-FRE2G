// Le moteur de l'agent FRE2G : chaque dossier (devis) suit le circuit
//
//   brouillon ──(le client accepte)──► attente_signature ──(signature en ligne)──► signe
//      signe ──(automatique : fiche client, commande fournisseur, facture d'acompte)──► acompte_attendu
//      acompte_attendu ──(acompte encaissé)──► travaux
//      travaux ──(installation terminée : facture de solde, client « installé »)──► solde_attendu
//      solde_attendu ──(solde encaissé)──► solde
//
// Chaque étape automatique est idempotente et journalisée : si un envoi échoue
// (mail du fournisseur manquant, SMTP indisponible…), on corrige puis on relance l'étape.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getSettings, logEvent, transaction } from './db.js';
import { computeQuoteTotals, computeSchedule, computeDepositInvoice, computeBalanceInvoice, toNumber, round2, formatMoney } from './money.js';
import { documentHtml, htmlToPdf } from './render.js';
import { todayIso, addDays, sha256, randomToken, parseJson, partyName, defaultGreeting, isEmail, formatDateTimeParis } from './util.js';

export const STATUS = {
  brouillon: 'Brouillon',
  attente_signature: 'En attente de signature',
  signe: 'Signé',
  acompte_attendu: 'Acompte à encaisser',
  travaux: 'Travaux à réaliser',
  solde_attendu: 'Installé — solde à encaisser',
  solde: 'Soldé',
  refuse: 'Sans suite'
};

export class WorkflowError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const VAT_RATES = [20, 10, 5.5, 2.1, 0];

function str(v, max = 2000) {
  return v === null || v === undefined ? '' : String(v).trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// Nettoyage des données saisies dans l'éditeur de devis
// ---------------------------------------------------------------------------
function cleanParty(p = {}) {
  return {
    kind: p.kind === 'professionnel' ? 'professionnel' : 'particulier',
    civility: ['M.', 'Mme', ''].includes(p.civility) ? p.civility : '',
    first_name: str(p.first_name, 100),
    last_name: str(p.last_name, 100),
    company: str(p.company, 200),
    email: str(p.email, 200).toLowerCase(),
    phone: str(p.phone, 50),
    address: str(p.address, 300),
    postal_code: str(p.postal_code, 20),
    city: str(p.city, 100),
    siret: str(p.siret, 30),
    vat_number: str(p.vat_number, 30)
  };
}

function cleanQuoteInput(input, settings) {
  const defaultVat = toNumber(settings.default_vat_rate, 20);
  const vat = (v) => {
    const n = toNumber(v, defaultVat);
    return VAT_RATES.includes(n) ? n : defaultVat;
  };
  const materiel = input.materiel || {};
  const travaux = input.travaux || {};
  const letter = input.letter || {};
  const conditions = input.conditions || {};
  return {
    prospect: cleanParty(input.prospect),
    date: /^\d{4}-\d{2}-\d{2}$/.test(input.date || '') ? input.date : todayIso(),
    validity_days: Math.max(1, Math.round(toNumber(input.validity_days, toNumber(settings.quote_validity_days, 30)))),
    object: str(input.object, 500),
    site_address: str(input.site_address, 300),
    letter: { greeting: str(letter.greeting, 100), body: str(letter.body, 8000), closing: str(letter.closing, 1000) },
    materiel: {
      intro: str(materiel.intro, 2000),
      note: str(materiel.note, 2000),
      items: (Array.isArray(materiel.items) ? materiel.items : [])
        .map((i) => ({
          qty: toNumber(i.qty, 1),
          reference: str(i.reference, 120),
          designation: str(i.designation, 300),
          caracteristiques: str(i.caracteristiques, 500),
          supplier_id: i.supplier_id ? Number(i.supplier_id) : null,
          purchase_price: toNumber(i.purchase_price, 0)
        }))
        .filter((i) => i.reference || i.designation)
    },
    travaux: {
      intro: str(travaux.intro, 2000),
      phases: (Array.isArray(travaux.phases) ? travaux.phases : [])
        .map((p) => ({
          title: str(p.title, 200),
          steps: (Array.isArray(p.steps) ? p.steps : String(p.steps || '').split('\n')).map((s) => str(s, 500)).filter(Boolean)
        }))
        .filter((p) => p.title || p.steps.length)
    },
    lines: (Array.isArray(input.lines) ? input.lines : [])
      .map((l) => ({
        designation: str(l.designation, 300),
        description: str(l.description, 1000),
        qty: toNumber(l.qty, 1),
        unit_price: round2(toNumber(l.unit_price, 0)),
        vat_rate: vat(l.vat_rate)
      }))
      .filter((l) => l.designation),
    conditions: {
      delai: str(conditions.delai, 1000),
      non_compris: str(conditions.non_compris, 2000),
      garantie: str(conditions.garantie, 1000),
      vat_note: str(conditions.vat_note, 1000)
    },
    deposit_pct: Math.min(Math.max(toNumber(input.deposit_pct, toNumber(settings.deposit_pct, 50)), 0), 100),
    notes_internes: str(input.notes_internes, 5000)
  };
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------
function hydrate(row) {
  if (!row) return null;
  const materiel = parseJson(row.materiel, {});
  const travaux = parseJson(row.travaux, {});
  return {
    ...row,
    prospect: parseJson(row.prospect, {}),
    letter: parseJson(row.letter, {}),
    materiel: Array.isArray(materiel) ? { items: materiel } : { items: [], ...materiel },
    travaux: Array.isArray(travaux) ? { phases: travaux } : { phases: [], ...travaux },
    lines: parseJson(row.lines, []),
    conditions: parseJson(row.conditions, {}),
    signature: parseJson(row.signature, null),
    automation: parseJson(row.automation, {}),
    status_label: STATUS[row.status] || row.status
  };
}

export function createWorkflow({ db, config, mailer }) {
  const docsDir = path.join(config.dataDir, 'documents');

  const settings = () => getSettings(db);

  function company(s = settings()) {
    return {
      name: s.company_name, legal_form: s.company_legal_form, capital: s.company_capital,
      address: s.company_address, postal_code: s.company_postal_code, city: s.company_city,
      phone: s.company_phone, email: s.company_email, website: s.company_website,
      siret: s.company_siret, vat_number: s.company_vat_number, rcs: s.company_rcs, ape: s.company_ape,
      insurance: s.company_insurance, signatory: s.company_signatory || s.company_name,
      bank_name: s.bank_name, iban: s.bank_iban, bic: s.bank_bic
    };
  }

  function rawQuote(id) {
    const q = hydrate(db.prepare('SELECT * FROM quotes WHERE id = ?').get(Number(id)));
    if (!q) throw new WorkflowError('Devis introuvable', 404);
    return q;
  }

  function quoteByToken(token) {
    if (!token || typeof token !== 'string') return null;
    return hydrate(db.prepare('SELECT * FROM quotes WHERE sign_token = ?').get(token));
  }

  function clientRow(id) {
    return id ? db.prepare('SELECT * FROM clients WHERE id = ?').get(id) : null;
  }

  // Le client « officiel » (fiche) après signature, sinon le prospect saisi sur le devis
  function party(q) {
    return clientRow(q.client_id) || q.prospect || {};
  }

  function invoicesOf(quoteId) {
    return db.prepare('SELECT * FROM invoices WHERE quote_id = ? ORDER BY id').all(quoteId)
      .map((i) => ({ ...i, details: parseJson(i.details, {}) }));
  }

  function getQuote(id) {
    const q = rawQuote(id);
    const totals = computeQuoteTotals(q.lines);
    return {
      ...q,
      totals,
      schedule: computeSchedule(totals, q.deposit_pct),
      client: clientRow(q.client_id),
      invoices: invoicesOf(q.id),
      supplier_orders: db.prepare(`SELECT o.*, s.name AS supplier_name, s.email AS supplier_email FROM supplier_orders o
        JOIN suppliers s ON s.id = o.supplier_id WHERE o.quote_id = ? ORDER BY o.id`).all(q.id)
        .map((o) => ({ ...o, items: parseJson(o.items, []) })),
      events: db.prepare('SELECT * FROM events WHERE quote_id = ? ORDER BY id DESC').all(q.id),
      emails: db.prepare('SELECT id, kind, recipient, subject, status, error, at FROM emails WHERE quote_id = ? ORDER BY id DESC').all(q.id),
      sign_url: q.sign_token ? `${config.baseUrl}/signer/${q.sign_token}` : null,
      sign_otp_hash: undefined,
      sign_token: undefined
    };
  }

  function listQuotes() {
    return db.prepare(`SELECT q.id, q.number, q.status, q.date, q.object, q.prospect, q.client_id, q.total_ht, q.total_ttc,
        q.sent_for_signature_at, q.signed_at, q.deposit_paid_at, q.installed_at, q.closed_at, q.automation, q.updated_at
      FROM quotes q ORDER BY q.id DESC`).all()
      .map((r) => {
        const prospect = parseJson(r.prospect, {});
        const automation = parseJson(r.automation, {});
        const errors = Object.values(automation).filter((s) => s && s.error).length;
        return { ...r, prospect: undefined, automation: undefined, client_name: partyName(clientRow(r.client_id) || prospect), status_label: STATUS[r.status], automation_errors: errors };
      });
  }

  // ---------------------------------------------------------------------------
  // Contexte des documents
  // ---------------------------------------------------------------------------
  function partyForDoc(p) {
    const person = [p.civility, p.first_name, p.last_name].filter(Boolean).join(' ');
    const display = p.kind === 'professionnel' && p.company ? [person, p.company].filter(Boolean).join(' — ') : (person || p.company || '');
    return {
      ...p,
      display_name: display,
      address_line: [p.address, [p.postal_code, p.city].filter(Boolean).join(' ')].filter(Boolean).join(' — ')
    };
  }

  function letterFor(q, p) {
    const greeting = q.letter.greeting || defaultGreeting(p);
    const paragraphs = String(q.letter.body || '').split(/\n\s*\n|\r?\n/).map((s) => s.trim()).filter(Boolean);
    return {
      greeting,
      paragraphs,
      closing: q.letter.closing,
      politeness: `Veuillez agréer, ${greeting.replace(/,\s*$/, '')}, l'expression de nos salutations distinguées.`,
      has_body: paragraphs.length > 0
    };
  }

  function quoteContext(q, extra = {}) {
    const s = settings();
    const p = party(q);
    const totals = computeQuoteTotals(q.lines);
    const schedule = computeSchedule(totals, q.deposit_pct);
    return {
      company: company(s),
      quote: q,
      client: partyForDoc(p),
      letter: letterFor(q, p),
      materiel: q.materiel,
      travaux: q.travaux,
      totals,
      multiVat: totals.vat.length > 1,
      schedule: { ...schedule, single: schedule.deposit_pct === 0 },
      conditions: q.conditions,
      ...extra
    };
  }

  function docPath(q, filename) {
    const dir = path.join(docsDir, String(q.number || q.id));
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, filename);
  }

  async function renderQuotePdf(q, extra = {}) {
    const ctx = quoteContext(q, extra);
    const html = documentHtml('devis.hbs', ctx, `Devis ${q.number}`);
    return htmlToPdf(html, `${ctx.company.name} — Devis N° ${q.number}`);
  }

  function setAutomation(id, step, value) {
    const q = rawQuote(id);
    const automation = { ...q.automation, [step]: { ...(q.automation[step] || {}), ...value } };
    db.prepare("UPDATE quotes SET automation = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(automation), id);
  }

  function setStatus(id, status, extraSql = '', params = []) {
    db.prepare(`UPDATE quotes SET status = ?, updated_at = datetime('now')${extraSql} WHERE id = ?`).run(status, ...params, id);
  }

  // ---------------------------------------------------------------------------
  // Devis : création et modification (tant qu'il est en brouillon)
  // ---------------------------------------------------------------------------
  function nextQuoteNumber() {
    const s = settings();
    let n = Math.max(1, Math.round(toNumber(s.quote_next_number, 1)));
    while (db.prepare('SELECT 1 FROM quotes WHERE number = ?').get(String(n))) n += 1;
    db.prepare("UPDATE settings SET value = ? WHERE key = 'quote_next_number'").run(String(n + 1));
    return String(n);
  }

  function prefill(s) {
    return {
      validity_days: toNumber(s.quote_validity_days, 30),
      deposit_pct: toNumber(s.deposit_pct, 50),
      letter: { greeting: '', body: '', closing: s.default_closing },
      conditions: { delai: s.default_delai, non_compris: s.default_non_compris, garantie: s.default_garantie, vat_note: '' }
    };
  }

  function createQuote(input = {}) {
    const s = settings();
    const base = prefill(s);
    const data = cleanQuoteInput({
      ...base, ...input,
      letter: { ...base.letter, ...(input.letter || {}) },
      conditions: { ...base.conditions, ...(input.conditions || {}) }
    }, s);
    const totals = computeQuoteTotals(data.lines);
    const id = transaction(db, () => {
      const number = nextQuoteNumber();
      const r = db.prepare(`INSERT INTO quotes (number, status, date, validity_days, prospect, object, site_address, letter, materiel, travaux, lines, conditions, deposit_pct, total_ht, total_vat, total_ttc, notes_internes)
        VALUES (?, 'brouillon', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        number, data.date, data.validity_days, JSON.stringify(data.prospect), data.object, data.site_address,
        JSON.stringify(data.letter), JSON.stringify(data.materiel), JSON.stringify(data.travaux), JSON.stringify(data.lines),
        JSON.stringify(data.conditions), data.deposit_pct, totals.ht, totals.total_vat, totals.ttc, data.notes_internes);
      return Number(r.lastInsertRowid);
    });
    const q = rawQuote(id);
    logEvent(db, id, 'creation', `Devis N° ${q.number} créé (prospect : ${partyName(q.prospect) || 'à compléter'}).`);
    return getQuote(id);
  }

  function updateQuote(id, input) {
    const q = rawQuote(id);
    if (q.status !== 'brouillon') {
      throw new WorkflowError(`Le devis N° ${q.number} n'est plus modifiable (statut : ${STATUS[q.status]}). Repassez-le en brouillon pour le modifier.`, 409);
    }
    const data = cleanQuoteInput({ ...q, ...input }, settings());
    const totals = computeQuoteTotals(data.lines);
    db.prepare(`UPDATE quotes SET date = ?, validity_days = ?, prospect = ?, object = ?, site_address = ?, letter = ?, materiel = ?, travaux = ?, lines = ?, conditions = ?,
        deposit_pct = ?, total_ht = ?, total_vat = ?, total_ttc = ?, notes_internes = ?, updated_at = datetime('now') WHERE id = ?`).run(
      data.date, data.validity_days, JSON.stringify(data.prospect), data.object, data.site_address, JSON.stringify(data.letter),
      JSON.stringify(data.materiel), JSON.stringify(data.travaux), JSON.stringify(data.lines), JSON.stringify(data.conditions),
      data.deposit_pct, totals.ht, totals.total_vat, totals.ttc, data.notes_internes, q.id);
    return getQuote(q.id);
  }

  function duplicateQuote(id) {
    const q = rawQuote(id);
    const copy = createQuote({ ...q, date: todayIso() });
    logEvent(db, copy.id, 'creation', `Copie du devis N° ${q.number}.`);
    return copy;
  }

  function deleteQuote(id) {
    const q = rawQuote(id);
    if (q.status !== 'brouillon' && q.status !== 'refuse') throw new WorkflowError('Seul un devis en brouillon ou sans suite peut être supprimé.', 409);
    if (invoicesOf(q.id).length) throw new WorkflowError('Ce devis a des factures : il ne peut pas être supprimé.', 409);
    transaction(db, () => {
      db.prepare('DELETE FROM events WHERE quote_id = ?').run(q.id);
      db.prepare('DELETE FROM emails WHERE quote_id = ?').run(q.id);
      db.prepare('DELETE FROM supplier_orders WHERE quote_id = ?').run(q.id);
      db.prepare('DELETE FROM quotes WHERE id = ?').run(q.id);
    });
  }

  async function previewQuotePdf(id) {
    return renderQuotePdf(rawQuote(id));
  }

  // ---------------------------------------------------------------------------
  // Étape 1 — le client accepte : envoi du devis avec signature électronique
  // ---------------------------------------------------------------------------
  function checkReadyToSend(q) {
    const problems = [];
    const p = q.prospect;
    if (!partyName(p)) problems.push('le nom du client');
    if (!isEmail(p.email)) problems.push("l'adresse e-mail du client");
    if (!q.lines.length) problems.push('au moins une ligne chiffrée');
    const totals = computeQuoteTotals(q.lines);
    if (totals.ttc <= 0) problems.push('un montant total supérieur à 0');
    if (q.lines.some((l) => l.unit_price <= 0)) problems.push('un prix sur chaque ligne (certaines sont à 0 €)');
    if (problems.length) throw new WorkflowError(`Avant l'envoi, il manque : ${problems.join(', ')}.`);
  }

  async function sendForSignature(id) {
    const q = rawQuote(id);
    if (q.status !== 'brouillon') throw new WorkflowError(`Le devis est déjà « ${STATUS[q.status]} ».`, 409);
    checkReadyToSend(q);
    const pdf = await renderQuotePdf(q);
    const file = docPath(q, `Devis-${q.number}.pdf`);
    fs.writeFileSync(file, pdf);
    const hash = sha256(pdf);
    const token = randomToken();
    const ctx = quoteContext(q);
    const validUntil = linkExpiry(q.date, todayIso(), q.validity_days);
    await mailer.send({
      template: 'signature_request',
      to: q.prospect.email,
      quoteId: q.id,
      context: { ...ctx, greeting: helloFor(q.prospect), signUrl: `${config.baseUrl}/signer/${token}`, validUntil },
      attachments: [{ filename: `Devis-${q.number}.pdf`, content: pdf }],
      replyTo: settings().company_email || undefined
    });
    db.prepare(`UPDATE quotes SET status = 'attente_signature', sign_token = ?, original_pdf = ?, original_sha256 = ?, sent_for_signature_at = datetime('now'),
      sign_otp_hash = NULL, sign_otp_expires = NULL, sign_otp_attempts = 0, updated_at = datetime('now') WHERE id = ?`).run(token, file, hash, q.id);
    logEvent(db, q.id, 'envoi_signature', `Le client a accepté : devis envoyé pour signature électronique à ${q.prospect.email} (${formatMoney(ctx.totals.ttc)} TTC).`, 'success');
    return getQuote(q.id);
  }

  function backToDraft(id) {
    const q = rawQuote(id);
    if (!['attente_signature', 'refuse'].includes(q.status)) throw new WorkflowError('Seul un devis en attente de signature ou sans suite peut repasser en brouillon.', 409);
    db.prepare("UPDATE quotes SET status = 'brouillon', sign_token = NULL, sign_otp_hash = NULL, updated_at = datetime('now') WHERE id = ?").run(q.id);
    logEvent(db, q.id, 'brouillon', 'Devis repassé en brouillon : le lien de signature envoyé au client est désactivé.', 'warning');
    return getQuote(q.id);
  }

  function markRefused(id, reason = '') {
    const q = rawQuote(id);
    if (!['brouillon', 'attente_signature'].includes(q.status)) throw new WorkflowError('Un devis signé ne peut pas être classé sans suite.', 409);
    db.prepare("UPDATE quotes SET status = 'refuse', sign_token = NULL, updated_at = datetime('now') WHERE id = ?").run(q.id);
    logEvent(db, q.id, 'refus', `Devis classé sans suite${reason ? ` : ${str(reason, 300)}` : ''}.`, 'warning');
    return getQuote(q.id);
  }

  // ---------------------------------------------------------------------------
  // Page de signature (côté client)
  // ---------------------------------------------------------------------------
  function signingState(token) {
    const q = quoteByToken(token);
    if (!q) return { state: 'invalide' };
    if (q.status !== 'attente_signature') return { state: q.signed_at ? 'signe' : 'invalide', quote: q };
    if (todayIso() > linkExpiry(q.date, q.sent_for_signature_at?.slice(0, 10), q.validity_days)) return { state: 'expire', quote: q };
    return { state: 'ouvert', quote: q, otp: settings().signature_otp === '1' };
  }

  // Le lien reste valable pendant la durée de validité du devis, comptée depuis son envoi s'il est postérieur
  function linkExpiry(quoteDate, sentDate, days) {
    const start = sentDate && sentDate > quoteDate ? sentDate : quoteDate;
    return addDays(start, days);
  }

  function otpHash(token, code) {
    return crypto.createHash('sha256').update(`${token}:${code}`).digest('hex');
  }

  async function requestOtp(token) {
    const st = signingState(token);
    if (st.state !== 'ouvert') throw new WorkflowError("Ce lien de signature n'est plus valable.", 410);
    const q = st.quote;
    if (q.sign_otp_expires && Date.parse(q.sign_otp_expires) - 14 * 60 * 1000 > Date.now()) {
      throw new WorkflowError('Un code vient de vous être envoyé. Patientez une minute avant d\'en demander un autre.', 429);
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    db.prepare('UPDATE quotes SET sign_otp_hash = ?, sign_otp_expires = ?, sign_otp_attempts = 0 WHERE id = ?').run(otpHash(token, code), expires, q.id);
    await mailer.send({ template: 'signature_otp', to: q.prospect.email, quoteId: q.id, kind: 'signature_otp', bcc: false, context: { company: company(), quote: q, code } });
    logEvent(db, q.id, 'code_signature', `Code de signature envoyé à ${q.prospect.email}.`);
    return { sent_to: maskEmail(q.prospect.email) };
  }

  function maskEmail(e) {
    const [u, d] = String(e).split('@');
    return `${u.slice(0, 2)}${'•'.repeat(Math.max(1, u.length - 2))}@${d}`;
  }

  async function sign(token, input, meta = {}) {
    const st = signingState(token);
    if (st.state !== 'ouvert') throw new WorkflowError("Ce lien de signature n'est plus valable.", 410);
    const q = st.quote;
    const name = str(input.name, 150);
    const quality = str(input.quality, 150);
    const mention = str(input.mention, 100);
    const image = String(input.signature || '');
    if (!name) throw new WorkflowError('Indiquez vos nom et prénom.');
    if (!input.accept) throw new WorkflowError('Cochez la case « J\'ai lu le devis et je l\'accepte ».');
    if (mention.toLowerCase().replace(/[^a-zàâçéèêëîïôûùüÿœ ]/g, '').replace(/\s+/g, ' ').trim() !== 'bon pour accord') {
      throw new WorkflowError('Recopiez la mention « Bon pour accord ».');
    }
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image) || image.length > 600_000 || image.length < 800) {
      throw new WorkflowError('Tracez votre signature dans le cadre.');
    }
    let otpVerified = false;
    if (st.otp) {
      const code = String(input.code || '').replace(/\D/g, '');
      if (!q.sign_otp_hash) throw new WorkflowError('Demandez d\'abord votre code de signature par e-mail.');
      if (Date.parse(q.sign_otp_expires) < Date.now()) throw new WorkflowError('Ce code a expiré : demandez-en un nouveau.');
      if (q.sign_otp_attempts >= 5) throw new WorkflowError('Trop d\'essais : demandez un nouveau code.', 429);
      if (otpHash(token, code) !== q.sign_otp_hash) {
        db.prepare('UPDATE quotes SET sign_otp_attempts = sign_otp_attempts + 1 WHERE id = ?').run(q.id);
        throw new WorkflowError('Code incorrect.');
      }
      otpVerified = true;
    }

    const signedAt = new Date().toISOString();
    const signature = {
      name, quality, mention: 'Bon pour accord', image,
      signed_at: signedAt, signed_at_text: formatDateTimeParis(signedAt),
      ip: str(meta.ip, 100), user_agent: str(meta.userAgent, 400),
      email: q.prospect.email, otp_verified: otpVerified,
      transaction_id: crypto.randomUUID(), original_sha256: q.original_sha256
    };
    // On fige le devis comme signé avant toute autre chose : la signature ne doit jamais être perdue
    const claimed = db.prepare(`UPDATE quotes SET status = 'signe', signature = ?, signed_at = datetime('now'), sign_otp_hash = NULL, updated_at = datetime('now')
      WHERE id = ? AND status = 'attente_signature'`).run(JSON.stringify(signature), q.id);
    if (claimed.changes !== 1) throw new WorkflowError('Ce devis vient déjà d\'être signé.', 409);
    logEvent(db, q.id, 'signature', `Devis signé électroniquement par ${name}${quality ? ` (${quality})` : ''} — IP ${signature.ip || 'inconnue'}${otpVerified ? ', e-mail vérifié par code' : ''}.`, 'success');

    await runPostSignature(q.id);
    return getQuote(q.id);
  }

  async function signedPdf(q) {
    if (q.signed_pdf && fs.existsSync(q.signed_pdf)) return fs.readFileSync(q.signed_pdf);
    return null;
  }

  // ---------------------------------------------------------------------------
  // Étape 2 — automatique après signature
  // ---------------------------------------------------------------------------
  async function step(id, name, label, fn) {
    const q = rawQuote(id);
    if (q.automation[name]?.done) return true;
    try {
      const detail = await fn(q);
      setAutomation(id, name, { done: true, at: new Date().toISOString(), error: null, detail: detail || null });
      return true;
    } catch (e) {
      setAutomation(id, name, { done: false, at: new Date().toISOString(), error: e.message });
      logEvent(db, id, name, `${label} : échec — ${e.message}`, 'error');
      return false;
    }
  }

  async function runPostSignature(id) {
    // 2a. PDF signé avec certificat
    await step(id, 'signed_pdf', 'Exemplaire signé', async (q) => {
      const sig = q.signature;
      const pdf = await renderQuotePdf(q, {
        signature: sig,
        certificate: {
          original_sha256: q.original_sha256 || '—',
          sent_at_text: formatDateTimeParis(`${q.sent_for_signature_at.replace(' ', 'T')}Z`),
          sent_to: sig.email, email: sig.email, otp_verified: sig.otp_verified,
          ip: sig.ip || '—', user_agent: sig.user_agent || '—', transaction_id: sig.transaction_id
        }
      });
      const file = docPath(q, `Devis-${q.number}-signe.pdf`);
      fs.writeFileSync(file, pdf);
      const hash = sha256(pdf);
      db.prepare('UPDATE quotes SET signed_pdf = ?, signed_sha256 = ? WHERE id = ?').run(file, hash, q.id);
      logEvent(db, q.id, 'signed_pdf', `Exemplaire signé généré (empreinte SHA-256 ${hash.slice(0, 16)}…).`);
    });

    // 2b. Fiche client : créée seulement maintenant que le devis est signé
    await step(id, 'client', 'Création de la fiche client', async (q) => {
      const clientId = upsertClientFromProspect(q);
      db.prepare('UPDATE quotes SET client_id = ? WHERE id = ?').run(clientId, q.id);
      const c = clientRow(clientId);
      logEvent(db, q.id, 'client', `Fiche client ${c.code} — ${partyName(c)} créée / mise à jour.`, 'success');
    });

    // 2c. Exemplaire signé envoyé au client
    await step(id, 'signed_copy', "Envoi de l'exemplaire signé au client", async (q) => {
      const pdf = await signedPdf(q);
      if (!pdf) throw new Error("l'exemplaire signé n'a pas pu être généré");
      const ctx = quoteContext(q);
      await mailer.send({
        template: 'signed_copy', to: party(q).email, quoteId: q.id,
        context: { ...ctx, greeting: helloFor(party(q)) },
        attachments: [{ filename: `Devis-${q.number}-signe.pdf`, content: pdf }],
        replyTo: settings().company_email || undefined
      });
      logEvent(db, q.id, 'signed_copy', `Exemplaire signé envoyé à ${party(q).email}.`);
    });

    // 2d. Commande du matériel aux fournisseurs
    await step(id, 'supplier_orders', 'Commande fournisseur', (q) => sendSupplierOrders(q));

    // 2e. Facture d'acompte
    await step(id, 'deposit_invoice', "Facture d'acompte", (q) => issueDepositInvoice(q));

    // 2f. Notification interne
    if (config.mail.notify) {
      await step(id, 'notify_signed', 'Notification FRE2G', async (q) => {
        await mailer.send({
          template: 'internal_signed', to: config.mail.notify, quoteId: q.id, bcc: false,
          context: { ...quoteContext(q), signature: q.signature, clientName: partyName(party(q)), adminUrl: `${config.baseUrl}/#/devis/${q.id}` }
        });
      });
    }

    const q = rawQuote(id);
    if (q.status === 'signe' && q.automation.deposit_invoice?.done) {
      const next = q.deposit_pct > 0 ? 'acompte_attendu' : 'travaux';
      setStatus(id, next);
      logEvent(db, id, 'statut', next === 'travaux' ? 'Pas d\'acompte prévu : le chantier peut être planifié.' : "En attente de l'encaissement de l'acompte : aucun chantier ne démarre avant.");
    }
    return getQuote(id);
  }

  function helloFor(p) {
    if (p.civility === 'Mme') return `Bonjour Madame ${p.last_name || ''}`.trim() + ',';
    if (p.civility === 'M.') return `Bonjour Monsieur ${p.last_name || ''}`.trim() + ',';
    return 'Bonjour,';
  }

  function upsertClientFromProspect(q) {
    const p = cleanParty(q.prospect);
    const existing = p.email ? db.prepare('SELECT * FROM clients WHERE lower(email) = ?').get(p.email) : null;
    if (existing) {
      db.prepare(`UPDATE clients SET kind = ?, civility = ?, first_name = ?, last_name = ?, company = ?, phone = ?, address = ?, postal_code = ?, city = ?,
        siret = ?, vat_number = ?, status = 'en_cours' WHERE id = ?`).run(p.kind, p.civility, p.first_name, p.last_name, p.company, p.phone,
        p.address, p.postal_code, p.city, p.siret, p.vat_number, existing.id);
      return existing.id;
    }
    return transaction(db, () => {
      const max = db.prepare("SELECT MAX(CAST(SUBSTR(code, 3) AS INTEGER)) AS n FROM clients WHERE code GLOB 'CL[0-9]*'").get().n || 0;
      const code = `CL${String(max + 1).padStart(4, '0')}`;
      const r = db.prepare(`INSERT INTO clients (code, kind, civility, first_name, last_name, company, email, phone, address, postal_code, city, siret, vat_number, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'en_cours')`).run(code, p.kind, p.civility, p.first_name, p.last_name, p.company, p.email,
        p.phone, p.address, p.postal_code, p.city, p.siret, p.vat_number);
      return Number(r.lastInsertRowid);
    });
  }

  async function sendSupplierOrders(q) {
    const items = q.materiel.items || [];
    if (!items.length) {
      logEvent(db, q.id, 'supplier_orders', 'Aucun matériel sur le devis : pas de commande fournisseur.');
      return 'aucun matériel';
    }
    const s = settings();
    const orphans = items.filter((i) => !i.supplier_id);
    if (orphans.length) {
      logEvent(db, q.id, 'supplier_orders', `${orphans.length} article(s) sans fournisseur (${orphans.map((i) => i.reference || i.designation).join(', ')}) : à commander à la main.`, 'warning');
    }
    const bySupplier = new Map();
    for (const it of items.filter((i) => i.supplier_id)) {
      if (!bySupplier.has(it.supplier_id)) bySupplier.set(it.supplier_id, []);
      bySupplier.get(it.supplier_id).push(it);
    }
    const errors = [];
    let index = 0;
    for (const [supplierId, supplierItems] of bySupplier) {
      index += 1;
      const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId);
      if (!supplier) { errors.push(`fournisseur n° ${supplierId} introuvable`); continue; }
      const already = db.prepare('SELECT * FROM supplier_orders WHERE quote_id = ? AND supplier_id = ?').get(q.id, supplierId);
      if (already?.sent_at) continue;
      if (!isEmail(supplier.email)) { errors.push(`${supplier.name} n'a pas d'adresse e-mail`); continue; }
      const number = already?.number || `${s.order_prefix || 'BC-'}${q.number}-${index}`;
      const order = {
        number, date: todayIso(),
        delivery_address: s.delivery_address || q.site_address || [party(q).address, party(q).postal_code, party(q).city].filter(Boolean).join(' '),
        items: supplierItems.map(({ qty, reference, designation, caracteristiques, purchase_price }) => ({ qty, reference, designation, caracteristiques, purchase_price })),
        show_prices: supplierItems.some((i) => i.purchase_price > 0)
      };
      // Le bon de commande ne montre jamais les prix de vente du client
      const ctx = { company: company(s), quote: q, supplier, order };
      const pdf = await htmlToPdf(documentHtml('commande.hbs', ctx, `Bon de commande ${number}`), `${s.company_name} — Bon de commande ${number}`);
      const file = docPath(q, `${number}.pdf`);
      fs.writeFileSync(file, pdf);
      if (!already) {
        db.prepare('INSERT INTO supplier_orders (quote_id, supplier_id, number, items, pdf_path) VALUES (?, ?, ?, ?, ?)').run(q.id, supplierId, number, JSON.stringify(order.items), file);
      }
      try {
        await mailer.send({
          template: 'supplier_order', to: supplier.email, quoteId: q.id, context: ctx,
          attachments: [{ filename: `${number}.pdf`, content: pdf }], replyTo: s.company_email || undefined
        });
        db.prepare("UPDATE supplier_orders SET sent_at = datetime('now'), pdf_path = ? WHERE quote_id = ? AND supplier_id = ?").run(file, q.id, supplierId);
        logEvent(db, q.id, 'supplier_orders', `Commande ${number} envoyée à ${supplier.name} (${supplier.email}) : ${order.items.length} article(s).`, 'success');
      } catch (e) {
        errors.push(e.message);
      }
    }
    if (errors.length) throw new Error(errors.join(' ; '));
    return `${bySupplier.size} fournisseur(s)`;
  }

  // Numérotation des factures : continue et sans trou, par année
  function nextInvoiceNumber(date) {
    const s = settings();
    const year = date.slice(0, 4);
    const prefix = (s.invoice_prefix || 'FA-{AAAA}-').replace('{AAAA}', year).replace('{AA}', year.slice(2));
    const key = `invoice:${prefix}`;
    const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(key);
    const next = (row?.value || 0) + 1;
    db.prepare('INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(key, next);
    return `${prefix}${String(next).padStart(Math.max(1, toNumber(s.invoice_digits, 4)), '0')}`;
  }

  function dueDate(client, date) {
    const s = settings();
    const days = toNumber(client.kind === 'professionnel' ? s.payment_days_professionnel : s.payment_days_particulier, 0);
    return { due_date: addDays(date, days), due_on_receipt: days === 0 };
  }

  function invoiceContext(q, inv) {
    const s = settings();
    const client = clientRow(inv.client_id);
    const totals = computeQuoteTotals(q.lines);
    const { due_on_receipt } = dueDate(client, inv.date);
    return {
      company: company(s),
      client: partyForDoc(client),
      quote: { ...q, signed_date: q.signed_at?.slice(0, 10), installed_date: q.installed_at?.slice(0, 10) },
      invoice: { ...inv, due_on_receipt },
      details: inv.details,
      quoteTotals: totals,
      schedule: computeSchedule(totals, q.deposit_pct),
      multiVat: totals.vat.length > 1,
      isDeposit: inv.kind === 'acompte',
      isBalance: inv.kind === 'solde',
      docTitle: inv.kind === 'acompte' ? "FACTURE D'ACOMPTE" : 'FACTURE DE SOLDE',
      legal: s.late_penalties
    };
  }

  async function createInvoice(q, kind, details, date) {
    const client = clientRow(q.client_id);
    if (!client) throw new Error('fiche client manquante');
    const existing = db.prepare('SELECT * FROM invoices WHERE quote_id = ? AND kind = ?').get(q.id, kind);
    let inv;
    if (existing) {
      inv = { ...existing, details: parseJson(existing.details, {}) };
    } else {
      inv = transaction(db, () => {
        const number = nextInvoiceNumber(date);
        const { due_date } = dueDate(client, date);
        const r = db.prepare(`INSERT INTO invoices (number, kind, quote_id, client_id, date, due_date, total_ht, total_vat, total_ttc, amount_due, details)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(number, kind, q.id, client.id, date, due_date, details.ht, details.total_vat, details.ttc, details.amount_due, JSON.stringify(details));
        const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(Number(r.lastInsertRowid));
        return { ...row, details: parseJson(row.details, {}) };
      });
      logEvent(db, q.id, `facture_${kind}`, `Facture ${kind === 'acompte' ? "d'acompte" : 'de solde'} ${inv.number} émise : ${formatMoney(inv.amount_due)} TTC à payer.`);
    }
    const ctx = invoiceContext(q, inv);
    const pdf = await htmlToPdf(documentHtml('facture.hbs', ctx, `Facture ${inv.number}`), `${ctx.company.name} — Facture N° ${inv.number}`);
    const file = docPath(q, `${inv.number}.pdf`);
    fs.writeFileSync(file, pdf);
    db.prepare('UPDATE invoices SET pdf_path = ? WHERE id = ?').run(file, inv.id);
    return { inv: { ...inv, pdf_path: file }, pdf, ctx };
  }

  async function sendInvoice(q, inv, pdf, ctx, template) {
    if (inv.sent_at) return;
    const client = clientRow(inv.client_id);
    await mailer.send({
      template, to: client.email, quoteId: q.id,
      context: { ...ctx, greeting: helloFor(client) },
      attachments: [{ filename: `Facture-${inv.number}.pdf`, content: pdf }],
      replyTo: settings().company_email || undefined
    });
    db.prepare("UPDATE invoices SET sent_at = datetime('now') WHERE id = ?").run(inv.id);
    logEvent(db, q.id, `envoi_${inv.kind}`, `Facture ${inv.number} envoyée à ${client.email}.`, 'success');
  }

  async function issueDepositInvoice(q) {
    if (q.deposit_pct <= 0) {
      logEvent(db, q.id, 'deposit_invoice', "Pas d'acompte prévu sur ce devis.");
      return 'pas d\'acompte';
    }
    const totals = computeQuoteTotals(q.lines);
    const details = computeDepositInvoice(totals, q.deposit_pct);
    const { inv, pdf, ctx } = await createInvoice(rawQuote(q.id), 'acompte', details, todayIso());
    await sendInvoice(rawQuote(q.id), inv, pdf, ctx, 'deposit_invoice');
    return inv.number;
  }

  // ---------------------------------------------------------------------------
  // Étape 3 — acompte encaissé : les travaux peuvent commencer
  // ---------------------------------------------------------------------------
  function cleanPayment(input = {}) {
    return {
      date: /^\d{4}-\d{2}-\d{2}$/.test(input.date || '') ? input.date : todayIso(),
      method: ['virement', 'cheque', 'cb', 'especes', 'prelevement', 'autre'].includes(input.method) ? input.method : 'virement',
      reference: str(input.reference, 200)
    };
  }

  async function recordDeposit(id, input = {}) {
    const q = rawQuote(id);
    if (q.status !== 'acompte_attendu') throw new WorkflowError(`Ce dossier n'attend pas d'acompte (statut : ${STATUS[q.status]}).`, 409);
    const inv = db.prepare("SELECT * FROM invoices WHERE quote_id = ? AND kind = 'acompte'").get(q.id);
    if (!inv) throw new WorkflowError("La facture d'acompte n'a pas encore été émise.", 409);
    const pay = cleanPayment(input);
    db.prepare("UPDATE invoices SET status = 'payee', paid_at = ?, payment_method = ?, payment_ref = ? WHERE id = ?").run(pay.date, pay.method, pay.reference, inv.id);
    db.prepare("UPDATE quotes SET status = 'travaux', deposit_paid_at = ?, updated_at = datetime('now') WHERE id = ?").run(pay.date, q.id);
    logEvent(db, q.id, 'acompte', `Acompte encaissé le ${pay.date} (${formatMoney(inv.amount_due)}, ${pay.method}) : les travaux peuvent commencer.`, 'success');
    if (settings().notify_on_deposit === '1') {
      await step(q.id, 'deposit_received_mail', "Mail de confirmation d'acompte", async (qq) => {
        const client = clientRow(qq.client_id);
        await mailer.send({ template: 'deposit_received', to: client.email, quoteId: qq.id, context: { ...quoteContext(qq), greeting: helloFor(client), amount: inv.amount_due } });
      });
    }
    return getQuote(q.id);
  }

  // ---------------------------------------------------------------------------
  // Étape 4 — installation terminée : facture du reste à payer, client « installé »
  // ---------------------------------------------------------------------------
  async function completeInstallation(id, input = {}) {
    const q = rawQuote(id);
    if (q.status !== 'travaux') throw new WorkflowError(`L'installation ne peut être déclarée terminée que pour un dossier « ${STATUS.travaux} » (statut actuel : ${STATUS[q.status]}).`, 409);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(input.date || '') ? input.date : todayIso();
    db.prepare("UPDATE quotes SET installed_at = ?, updated_at = datetime('now') WHERE id = ?").run(date, q.id);
    logEvent(db, q.id, 'installation', `Installation terminée et mise en service le ${date}.`, 'success');
    return runPostInstallation(q.id);
  }

  async function runPostInstallation(id) {
    await step(id, 'balance_invoice', 'Facture de solde', async (q) => {
      const totals = computeQuoteTotals(q.lines);
      const deposits = invoicesOf(q.id).filter((i) => i.kind === 'acompte');
      const details = computeBalanceInvoice(totals, deposits);
      const { inv, pdf, ctx } = await createInvoice(q, 'solde', details, q.installed_at || todayIso());
      await sendInvoice(rawQuote(q.id), inv, pdf, ctx, 'balance_invoice');
      return inv.number;
    });
    await step(id, 'client_installed', 'Classement du client', async (q) => {
      db.prepare("UPDATE clients SET status = 'installe', installed_at = ? WHERE id = ?").run(q.installed_at || todayIso(), q.client_id);
      const c = clientRow(q.client_id);
      logEvent(db, q.id, 'client_installe', `${partyName(c)} (${c.code}) classé dans « Clients installés ».`, 'success');
    });
    const q = rawQuote(id);
    if (q.status === 'travaux' && q.automation.balance_invoice?.done) {
      const balance = db.prepare("SELECT * FROM invoices WHERE quote_id = ? AND kind = 'solde'").get(id);
      if (balance && balance.amount_due <= 0) {
        db.prepare("UPDATE invoices SET status = 'payee', paid_at = ? WHERE id = ?").run(todayIso(), balance.id);
        setStatus(id, 'solde', ", closed_at = datetime('now')");
        logEvent(db, id, 'solde', 'Rien à payer sur la facture de solde : dossier soldé.', 'success');
      } else {
        setStatus(id, 'solde_attendu');
      }
    }
    return getQuote(id);
  }

  function recordBalance(id, input = {}) {
    const q = rawQuote(id);
    if (q.status !== 'solde_attendu') throw new WorkflowError(`Ce dossier n'attend pas de solde (statut : ${STATUS[q.status]}).`, 409);
    const inv = db.prepare("SELECT * FROM invoices WHERE quote_id = ? AND kind = 'solde'").get(q.id);
    const pay = cleanPayment(input);
    db.prepare("UPDATE invoices SET status = 'payee', paid_at = ?, payment_method = ?, payment_ref = ? WHERE id = ?").run(pay.date, pay.method, pay.reference, inv.id);
    db.prepare("UPDATE quotes SET status = 'solde', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(q.id);
    logEvent(db, q.id, 'solde', `Solde encaissé le ${pay.date} (${formatMoney(inv.amount_due)}) : dossier soldé.`, 'success');
    return getQuote(q.id);
  }

  // Relance des étapes automatiques en échec (après correction : e-mail fournisseur, SMTP…)
  async function retryAutomation(id) {
    const q = rawQuote(id);
    const failed = Object.entries(q.automation).filter(([, v]) => v && !v.done).map(([k]) => k);
    if (!failed.length) throw new WorkflowError("Aucune étape en échec sur ce dossier.", 409);
    for (const k of failed) setAutomation(id, k, { error: null });
    logEvent(db, id, 'relance', `Relance des étapes : ${failed.join(', ')}.`);
    if (['signe', 'acompte_attendu', 'travaux'].includes(q.status) && failed.some((k) => ['signed_pdf', 'client', 'signed_copy', 'supplier_orders', 'deposit_invoice', 'notify_signed'].includes(k))) {
      await runPostSignature(id);
    }
    const after = rawQuote(id);
    if (after.installed_at && failed.some((k) => ['balance_invoice', 'client_installed'].includes(k))) await runPostInstallation(id);
    if (failed.includes('deposit_received_mail') && after.deposit_paid_at) {
      const client = clientRow(after.client_id);
      const inv = db.prepare("SELECT * FROM invoices WHERE quote_id = ? AND kind = 'acompte'").get(id);
      await step(id, 'deposit_received_mail', "Mail de confirmation d'acompte", async (qq) => {
        await mailer.send({ template: 'deposit_received', to: client.email, quoteId: qq.id, context: { ...quoteContext(qq), greeting: helloFor(client), amount: inv.amount_due } });
      });
    }
    return getQuote(id);
  }

  // Facture : PDF à la demande
  function invoiceFile(invoiceId) {
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(Number(invoiceId));
    if (!inv || !inv.pdf_path || !fs.existsSync(inv.pdf_path)) throw new WorkflowError('Facture introuvable', 404);
    return { file: inv.pdf_path, name: `Facture-${inv.number}.pdf` };
  }

  return {
    STATUS, settings, company, getQuote, listQuotes, createQuote, updateQuote, duplicateQuote, deleteQuote, previewQuotePdf,
    sendForSignature, backToDraft, markRefused, signingState, requestOtp, sign, runPostSignature,
    recordDeposit, completeInstallation, runPostInstallation, recordBalance, retryAutomation, invoiceFile, quoteByToken,
    quoteContext, prefill
  };
}
