'use strict';

const express = require('express');
const { computeTotals, round2 } = require('../../public/js/calc');
const { getSettings } = require('../db');
const { nextNumber } = require('../numbering');
const { renderDocument, pageHtml } = require('../render');
const { toNumber } = require('./catalog');

const TYPES = ['devis', 'facture', 'avoir'];
const QUOTE_STATUSES = ['brouillon', 'envoye', 'accepte', 'refuse'];
const DOC_FIELDS = ['client_id', 'template_id', 'date', 'due_date', 'validity_date', 'title', 'site_address', 'intro', 'notes', 'conditions', 'discount_pct', 'deposit_pct'];
const LINE_FIELDS = ['kind', 'item_id', 'item_type', 'reference', 'designation', 'description', 'quantity', 'unit', 'unit_price', 'discount_pct', 'vat_rate', 'purchase_price'];

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(date, days) {
  const d = new Date(date + 'T12:00:00');
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = function documentRoutes(db) {
  const r = express.Router();

  const getDoc = (id) => db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  const getLines = (id) => db.prepare('SELECT * FROM document_lines WHERE document_id = ? ORDER BY position, id').all(id);
  const getPaid = (id) => db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE document_id = ?').get(id).s;

  function isLocked(doc) {
    if (doc.type === 'devis') return doc.status === 'facture';
    return !!doc.number; // facture / avoir émis : non modifiable (obligation légale)
  }

  function recomputeTotals(id) {
    const doc = getDoc(id);
    const settings = getSettings(db);
    const t = computeTotals(getLines(id), { discount_pct: doc.discount_pct, vat_exempt: settings.vat_exempt === '1' });
    db.prepare('UPDATE documents SET total_ht = ?, total_vat = ?, total_ttc = ? WHERE id = ?').run(t.ht, t.total_vat, t.ttc, id);
  }

  function refreshInvoiceStatus(id) {
    const doc = getDoc(id);
    if (!doc || doc.type !== 'facture' || !doc.number) return;
    const paid = getPaid(id);
    const credited = db.prepare("SELECT COALESCE(SUM(total_ttc), 0) AS s FROM documents WHERE type = 'avoir' AND source_id = ? AND number IS NOT NULL").get(id).s;
    let status = 'emise';
    if (credited > 0 && credited >= doc.total_ttc - 0.005) status = 'annulee';
    else if (paid + credited >= doc.total_ttc - 0.005 && doc.total_ttc > 0) status = 'payee';
    else if (paid > 0 || credited > 0) status = 'partielle';
    db.prepare('UPDATE documents SET status = ? WHERE id = ?').run(status, id);
  }

  function writeLines(id, lines) {
    db.prepare('DELETE FROM document_lines WHERE document_id = ?').run(id);
    const ins = db.prepare(`INSERT INTO document_lines (document_id, position, ${LINE_FIELDS.join(',')})
      VALUES (@document_id, @position, ${LINE_FIELDS.map((k) => '@' + k).join(',')})`);
    (lines || []).forEach((l, i) => {
      const row = { document_id: id, position: i };
      for (const f of LINE_FIELDS) row[f] = l[f] === undefined || l[f] === '' ? null : l[f];
      row.kind = ['item', 'section', 'text'].includes(row.kind) ? row.kind : 'item';
      for (const f of ['quantity', 'unit_price', 'discount_pct', 'vat_rate', 'purchase_price']) row[f] = toNumber(row[f], f === 'quantity' && row.kind === 'item' ? 1 : 0);
      row.item_id = row.item_id ? Number(row.item_id) : null;
      if (row.item_id && !db.prepare('SELECT 1 FROM items WHERE id = ?').get(row.item_id)) row.item_id = null;
      ins.run(row);
    });
  }

  function fullDoc(id) {
    const doc = getDoc(id);
    if (!doc) return null;
    const settings = getSettings(db);
    const lines = getLines(id);
    const payments = db.prepare('SELECT * FROM payments WHERE document_id = ? ORDER BY date, id').all(id);
    const paid = payments.reduce((s, p) => s + p.amount, 0);
    const client = doc.client_id ? db.prepare('SELECT * FROM clients WHERE id = ?').get(doc.client_id) : null;
    const source = doc.source_id ? db.prepare('SELECT id, type, number, status FROM documents WHERE id = ?').get(doc.source_id) : null;
    const children = db.prepare('SELECT id, type, number, status, total_ttc FROM documents WHERE source_id = ? ORDER BY id').all(id);
    const totals = computeTotals(lines, { discount_pct: doc.discount_pct, deposit_pct: doc.deposit_pct, vat_exempt: settings.vat_exempt === '1', paid });
    return { ...doc, locked: isLocked(doc), lines, payments, client, source, children, totals };
  }

  function createDoc(data, lines) {
    const settings = getSettings(db);
    const type = data.type;
    const date = data.date || today();
    const doc = { type, date, status: 'brouillon', number: null, source_id: data.source_id || null };
    for (const f of DOC_FIELDS) doc[f] = data[f] === undefined || data[f] === '' ? null : data[f];
    doc.date = date;
    doc.discount_pct = toNumber(doc.discount_pct);
    doc.deposit_pct = toNumber(doc.deposit_pct);
    if (type === 'devis') {
      doc.validity_date = doc.validity_date || addDays(date, settings.quote_validity_days || 30);
      if (doc.intro === null && data.intro === undefined) doc.intro = settings.quote_default_intro || null;
      if (doc.conditions === null && data.conditions === undefined) doc.conditions = settings.quote_default_conditions || null;
      doc.number = nextNumber(db, 'devis', date);
    } else {
      if (doc.intro === null && data.intro === undefined) doc.intro = type === 'facture' ? settings.invoice_default_intro || null : null;
      if (doc.conditions === null && data.conditions === undefined) doc.conditions = type === 'facture' ? settings.invoice_default_conditions || null : null;
    }
    if (type === 'facture' && !doc.due_date) {
      const client = doc.client_id ? db.prepare('SELECT payment_days FROM clients WHERE id = ?').get(doc.client_id) : null;
      doc.due_date = addDays(date, client?.payment_days ?? settings.invoice_payment_days ?? 30);
    }
    const cols = Object.keys(doc);
    const id = db.prepare(`INSERT INTO documents (${cols.join(',')}) VALUES (${cols.map((k) => '@' + k).join(',')})`).run(doc).lastInsertRowid;
    writeLines(id, lines);
    recomputeTotals(id);
    return id;
  }

  // ---------- Liste ----------
  r.get('/documents', (req, res) => {
    const where = [];
    const params = {};
    if (req.query.type) { where.push('d.type = @type'); params.type = req.query.type; }
    if (req.query.status) { where.push('d.status = @status'); params.status = req.query.status; }
    if (req.query.client_id) { where.push('d.client_id = @client_id'); params.client_id = req.query.client_id; }
    if (req.query.from) { where.push('d.date >= @from'); params.from = req.query.from; }
    if (req.query.to) { where.push('d.date <= @to'); params.to = req.query.to; }
    if (req.query.q) {
      where.push("(COALESCE(d.number,'') || ' ' || COALESCE(d.title,'') || ' ' || COALESCE(c.company,'') || ' ' || COALESCE(c.last_name,'') || ' ' || COALESCE(c.first_name,'')) LIKE @q");
      params.q = `%${req.query.q}%`;
    }
    const rows = db.prepare(`SELECT d.id, d.type, d.number, d.status, d.date, d.due_date, d.validity_date, d.title, d.total_ht, d.total_vat, d.total_ttc,
        d.client_id, d.source_id, d.updated_at, COALESCE(NULLIF(c.company,''), TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,''))) AS client_name,
        c.email AS client_email, c.phone AS client_phone, c.city AS client_city,
        (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.document_id = d.id) AS paid
      FROM documents d LEFT JOIN clients c ON c.id = d.client_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY d.date DESC, d.id DESC LIMIT 2000`).all(params);
    res.json(rows);
  });

  r.get('/documents/:id', (req, res) => {
    const doc = fullDoc(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document introuvable' });
    res.json(doc);
  });

  // ---------- Création / modification ----------
  r.post('/documents', (req, res) => {
    const type = req.body.type;
    if (!TYPES.includes(type)) return res.status(400).json({ error: 'Type de document invalide' });
    const id = db.transaction(() => createDoc(req.body, req.body.lines))();
    res.status(201).json(fullDoc(id));
  });

  r.put('/documents/:id', (req, res) => {
    const doc = getDoc(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document introuvable' });
    if (isLocked(doc)) return res.status(409).json({ error: 'Ce document est émis et ne peut plus être modifié. Créez un avoir pour le corriger.' });
    db.transaction(() => {
      const upd = { id: doc.id };
      for (const f of DOC_FIELDS) upd[f] = req.body[f] === undefined || req.body[f] === '' ? null : req.body[f];
      upd.date = upd.date || doc.date;
      upd.discount_pct = toNumber(upd.discount_pct);
      upd.deposit_pct = toNumber(upd.deposit_pct);
      db.prepare(`UPDATE documents SET ${DOC_FIELDS.map((k) => `${k} = @${k}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`).run(upd);
      if (Array.isArray(req.body.lines)) writeLines(doc.id, req.body.lines);
      recomputeTotals(doc.id);
    })();
    res.json(fullDoc(doc.id));
  });

  r.delete('/documents/:id', (req, res) => {
    const doc = getDoc(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document introuvable' });
    if (doc.type !== 'devis' && doc.number) {
      return res.status(409).json({ error: 'Une facture ou un avoir émis ne peut pas être supprimé (numérotation continue obligatoire). Créez un avoir.' });
    }
    db.transaction(() => {
      db.prepare('UPDATE documents SET source_id = NULL WHERE source_id = ?').run(doc.id);
      db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
    })();
    res.json({ ok: true });
  });

  // ---------- Cycle de vie ----------
  r.post('/documents/:id/status', (req, res) => {
    const doc = getDoc(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document introuvable' });
    if (doc.type !== 'devis' || !QUOTE_STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Statut invalide' });
    if (doc.status === 'facture') return res.status(409).json({ error: 'Ce devis a déjà été facturé.' });
    db.prepare("UPDATE documents SET status = ?, updated_at = datetime('now') WHERE id = ?").run(req.body.status, doc.id);
    res.json(fullDoc(doc.id));
  });

  // Émission d'une facture / d'un avoir : attribution du numéro définitif et verrouillage
  r.post('/documents/:id/issue', (req, res, next) => {
    try {
      db.transaction(() => {
        const doc = getDoc(req.params.id);
        if (!doc) throw httpError(404, 'Document introuvable');
        if (doc.type === 'devis') throw httpError(400, 'Utilisez le changement de statut pour un devis.');
        if (doc.number) throw httpError(409, 'Document déjà émis.');
        if (!doc.client_id) throw httpError(400, 'Sélectionnez un client avant d\'émettre le document.');
        if (!getLines(doc.id).some((l) => l.kind === 'item')) throw httpError(400, 'Le document ne contient aucune ligne.');
        const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(doc.client_id);
        const number = nextNumber(db, doc.type, doc.date);
        db.prepare("UPDATE documents SET number = ?, status = 'emise', client_snapshot = ?, issued_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
          .run(number, JSON.stringify(client), doc.id);
        recomputeTotals(doc.id);
        if (doc.type === 'avoir' && doc.source_id) refreshInvoiceStatus(doc.source_id);
      })();
      res.json(fullDoc(req.params.id));
    } catch (e) { next(e); }
  });

  function copyLines(id) {
    return getLines(id).map((l) => { const c = { ...l }; delete c.id; delete c.document_id; return c; });
  }
  function copyFields(doc) {
    const d = {};
    for (const f of DOC_FIELDS) d[f] = doc[f];
    return d;
  }

  // Devis -> facture
  r.post('/documents/:id/convert', (req, res, next) => {
    try {
      const newId = db.transaction(() => {
        const doc = getDoc(req.params.id);
        if (!doc || doc.type !== 'devis') throw httpError(400, 'Seul un devis peut être transformé en facture.');
        if (doc.status === 'facture') throw httpError(409, 'Ce devis a déjà été facturé.');
        const data = { ...copyFields(doc), type: 'facture', source_id: doc.id, date: today(), due_date: null, validity_date: null, deposit_pct: 0, intro: undefined, conditions: undefined };
        const id = createDoc(data, copyLines(doc.id));
        db.prepare("UPDATE documents SET status = 'facture', updated_at = datetime('now') WHERE id = ?").run(doc.id);
        return id;
      })();
      res.status(201).json(fullDoc(newId));
    } catch (e) { next(e); }
  });

  // Facture -> avoir
  r.post('/documents/:id/credit', (req, res, next) => {
    try {
      const newId = db.transaction(() => {
        const doc = getDoc(req.params.id);
        if (!doc || doc.type !== 'facture' || !doc.number) throw httpError(400, 'Un avoir se crée à partir d\'une facture émise.');
        const data = { ...copyFields(doc), type: 'avoir', source_id: doc.id, date: today(), due_date: null, intro: `Avoir sur la facture n° ${doc.number} du ${doc.date.split('-').reverse().join('/')}.`, conditions: null };
        return createDoc(data, copyLines(doc.id));
      })();
      res.status(201).json(fullDoc(newId));
    } catch (e) { next(e); }
  });

  r.post('/documents/:id/duplicate', (req, res, next) => {
    try {
      const newId = db.transaction(() => {
        const doc = getDoc(req.params.id);
        if (!doc) throw httpError(404, 'Document introuvable');
        const type = TYPES.includes(req.body.type) ? req.body.type : (doc.type === 'avoir' ? 'facture' : doc.type);
        const data = { ...copyFields(doc), type, date: today(), due_date: null, validity_date: null };
        return createDoc(data, copyLines(doc.id));
      })();
      res.status(201).json(fullDoc(newId));
    } catch (e) { next(e); }
  });

  // ---------- Règlements ----------
  r.post('/documents/:id/payments', (req, res) => {
    const doc = getDoc(req.params.id);
    if (!doc || doc.type !== 'facture' || !doc.number) return res.status(400).json({ error: 'Les règlements s\'enregistrent sur une facture émise.' });
    const amount = round2(toNumber(req.body.amount));
    if (!amount) return res.status(400).json({ error: 'Montant invalide' });
    db.prepare('INSERT INTO payments (document_id, date, amount, method, reference) VALUES (?, ?, ?, ?, ?)')
      .run(doc.id, req.body.date || today(), amount, req.body.method || null, req.body.reference || null);
    refreshInvoiceStatus(doc.id);
    res.status(201).json(fullDoc(doc.id));
  });

  r.delete('/payments/:id', (req, res) => {
    const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Règlement introuvable' });
    db.prepare('DELETE FROM payments WHERE id = ?').run(p.id);
    refreshInvoiceStatus(p.document_id);
    res.json(fullDoc(p.document_id));
  });

  // ---------- Impression ----------
  r.get('/documents/:id/print', (req, res) => {
    const doc = getDoc(req.params.id);
    if (!doc) return res.status(404).send('Document introuvable');
    const { body, css, ctx } = renderDocument(db, doc);
    const title = `${ctx.doc.type_label} ${ctx.doc.number} - ${ctx.client.display_name || ''}`.trim();
    res.type('html').send(pageHtml({ title, body, css, toolbar: req.query.toolbar !== '0' }));
  });

  return r;
};
