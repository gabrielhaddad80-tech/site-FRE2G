'use strict';

const express = require('express');
const { round2 } = require('../../public/js/calc');

const CLIENT_FIELDS = ['kind', 'code', 'company', 'civility', 'first_name', 'last_name', 'address', 'postal_code', 'city', 'country',
  'email', 'phone', 'siret', 'vat_number', 'payment_days', 'discount_pct', 'notes'];
const ITEM_FIELDS = ['type', 'reference', 'designation', 'description', 'unit', 'purchase_price', 'sale_price', 'vat_rate',
  'category_id', 'supplier', 'catalog', 'active'];
const NUMERIC_ITEM_FIELDS = ['purchase_price', 'sale_price', 'vat_rate'];

function pick(obj, fields) {
  const out = {};
  for (const f of fields) out[f] = obj[f] === undefined || obj[f] === '' ? null : obj[f];
  return out;
}

function toNumber(v, def = 0) {
  if (v === null || v === undefined || v === '') return def;
  const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : def;
}

function normalizeItem(body) {
  const it = pick(body, ITEM_FIELDS);
  for (const f of NUMERIC_ITEM_FIELDS) it[f] = toNumber(it[f], f === 'vat_rate' ? 20 : 0);
  it.type = it.type || 'prestation';
  it.unit = it.unit || 'u';
  it.active = it.active === null ? 1 : (['0', 'false', 'non', 'no'].includes(String(it.active).toLowerCase()) || it.active === false ? 0 : 1);
  it.category_id = it.category_id ? Number(it.category_id) : null;
  return it;
}

module.exports = function catalogRoutes(db) {
  const r = express.Router();

  // ---------- Clients ----------
  r.get('/clients', (req, res) => {
    const q = `%${req.query.q || ''}%`;
    res.json(db.prepare(`SELECT c.*,
        (SELECT COUNT(*) FROM documents d WHERE d.client_id = c.id) AS documents_count,
        (SELECT COALESCE(SUM(CASE WHEN d.type = 'facture' THEN d.total_ttc ELSE -d.total_ttc END), 0) FROM documents d
          WHERE d.client_id = c.id AND d.type IN ('facture','avoir') AND d.number IS NOT NULL) AS invoiced
      FROM clients c
      WHERE COALESCE(company,'') || ' ' || COALESCE(first_name,'') || ' ' || COALESCE(last_name,'') || ' ' || COALESCE(code,'') || ' ' || COALESCE(city,'') || ' ' || COALESCE(email,'') LIKE ?
      ORDER BY COALESCE(NULLIF(company,''), last_name) COLLATE NOCASE`).all(q));
  });

  r.get('/clients/:id', (req, res) => {
    const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Client introuvable' });
    res.json(c);
  });

  function nextClientCode() {
    const row = db.prepare("SELECT MAX(CAST(SUBSTR(code, 3) AS INTEGER)) AS n FROM clients WHERE code GLOB 'CL[0-9]*'").get();
    return 'CL' + String((row.n || 0) + 1).padStart(4, '0');
  }

  r.post('/clients', (req, res) => {
    const c = pick(req.body, CLIENT_FIELDS);
    if (!c.company && !c.last_name) return res.status(400).json({ error: 'Indiquez une raison sociale ou un nom.' });
    c.code = c.code || nextClientCode();
    c.kind = c.kind || 'professionnel';
    c.discount_pct = toNumber(c.discount_pct);
    const cols = Object.keys(c);
    const info = db.prepare(`INSERT INTO clients (${cols.join(',')}) VALUES (${cols.map((k) => '@' + k).join(',')})`).run(c);
    res.status(201).json(db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid));
  });

  r.put('/clients/:id', (req, res) => {
    const c = pick(req.body, CLIENT_FIELDS);
    c.discount_pct = toNumber(c.discount_pct);
    c.id = Number(req.params.id);
    db.prepare(`UPDATE clients SET ${CLIENT_FIELDS.map((k) => `${k} = @${k}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`).run(c);
    res.json(db.prepare('SELECT * FROM clients WHERE id = ?').get(c.id));
  });

  r.delete('/clients/:id', (req, res) => {
    const used = db.prepare('SELECT COUNT(*) AS n FROM documents WHERE client_id = ?').get(req.params.id).n;
    if (used) return res.status(409).json({ error: `Ce client est utilisé dans ${used} document(s) et ne peut pas être supprimé.` });
    db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // ---------- Catégories ----------
  r.get('/categories', (req, res) => {
    res.json(db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id) AS items_count
      FROM categories c ORDER BY position, name COLLATE NOCASE`).all());
  });
  r.post('/categories', (req, res) => {
    if (!req.body.name) return res.status(400).json({ error: 'Nom obligatoire' });
    const info = db.prepare('INSERT INTO categories (name, parent_id, position) VALUES (?, ?, ?)')
      .run(req.body.name, req.body.parent_id || null, toNumber(req.body.position));
    res.status(201).json(db.prepare('SELECT * FROM categories WHERE id = ?').get(info.lastInsertRowid));
  });
  r.put('/categories/:id', (req, res) => {
    db.prepare('UPDATE categories SET name = ?, parent_id = ?, position = ? WHERE id = ?')
      .run(req.body.name, req.body.parent_id || null, toNumber(req.body.position), req.params.id);
    res.json(db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id));
  });
  r.delete('/categories/:id', (req, res) => {
    db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // ---------- Articles du catalogue ----------
  function getComponents(id) {
    return db.prepare(`SELECT c.id, c.child_id, c.quantity, c.position, i.reference, i.designation, i.unit, i.sale_price, i.purchase_price, i.type
      FROM item_components c JOIN items i ON i.id = c.child_id WHERE c.parent_id = ? ORDER BY c.position, c.id`).all(id);
  }

  r.get('/items', (req, res) => {
    const where = [];
    const params = {};
    if (req.query.q) {
      where.push("(COALESCE(i.reference,'') || ' ' || i.designation || ' ' || COALESCE(i.description,'') || ' ' || COALESCE(i.catalog,'')) LIKE @q");
      params.q = `%${req.query.q}%`;
    }
    if (req.query.type) { where.push('i.type = @type'); params.type = req.query.type; }
    if (req.query.category_id) { where.push('i.category_id = @cat'); params.cat = req.query.category_id; }
    if (req.query.catalog) { where.push('i.catalog = @catalog'); params.catalog = req.query.catalog; }
    if (req.query.active !== 'all') where.push('i.active = 1');
    const sql = `SELECT i.*, c.name AS category_name FROM items i LEFT JOIN categories c ON c.id = i.category_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.position, c.name, i.reference, i.designation COLLATE NOCASE
      LIMIT ${Math.min(Number(req.query.limit) || 1000, 5000)}`;
    res.json(db.prepare(sql).all(params));
  });

  r.get('/items/catalogs', (req, res) => {
    res.json(db.prepare("SELECT DISTINCT catalog FROM items WHERE catalog IS NOT NULL AND catalog <> '' ORDER BY catalog").all().map((r) => r.catalog));
  });

  r.get('/items/export.csv', (req, res) => {
    const rows = db.prepare(`SELECT i.type, i.reference, i.designation, i.description, i.unit, i.purchase_price, i.sale_price, i.vat_rate,
      c.name AS category, i.catalog, i.supplier, i.active FROM items i LEFT JOIN categories c ON c.id = i.category_id ORDER BY i.id`).all();
    const cols = ['type', 'reference', 'designation', 'description', 'unit', 'purchase_price', 'sale_price', 'vat_rate', 'category', 'catalog', 'supplier', 'active'];
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      let s = typeof v === 'number' ? String(v).replace('.', ',') : String(v);
      // Texte commençant par = + - @ : neutralisé pour qu'Excel ne l'exécute pas comme une formule
      if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = '﻿' + [cols.join(';'), ...rows.map((r) => cols.map((c) => esc(r[c])).join(';'))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="catalogue.csv"');
    res.send(csv);
  });

  // Import en masse (lignes déjà analysées côté navigateur). Met à jour si la référence existe.
  r.post('/items/import', (req, res) => {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    const catalogName = req.body.catalog || null;
    let created = 0, updated = 0, skipped = 0;
    const findCat = db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE');
    const insCat = db.prepare('INSERT INTO categories (name) VALUES (?)');
    const findRef = db.prepare('SELECT * FROM items WHERE reference = ?');
    const cols = ITEM_FIELDS;
    const ins = db.prepare(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map((k) => '@' + k).join(',')})`);
    const upd = db.prepare(`UPDATE items SET ${cols.map((k) => `${k} = @${k}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`);
    const tx = db.transaction(() => {
      for (const raw of rows) {
        if (!raw.designation) { skipped++; continue; }
        const existing = raw.reference ? findRef.get(raw.reference) : null;
        // Mise à jour : seules les colonnes renseignées dans le fichier remplacent les valeurs existantes
        const provided = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => [k, typeof v === 'string' && /^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v])); // retour d'un export CSV
        if (!provided.catalog && catalogName) provided.catalog = catalogName;
        if (provided.category) {
          const c = findCat.get(provided.category);
          provided.category_id = c ? c.id : insCat.run(provided.category).lastInsertRowid;
        }
        const it = normalizeItem(existing ? { ...existing, ...provided } : provided);
        if (existing) { upd.run({ ...it, id: existing.id }); updated++; } else { ins.run(it); created++; }
      }
    });
    tx();
    res.json({ created, updated, skipped });
  });

  // Mise à jour des prix en masse (ex. hausse fournisseur de 5 %)
  r.post('/items/reprice', (req, res) => {
    const pct = toNumber(req.body.percent);
    const field = req.body.field === 'purchase_price' ? 'purchase_price' : 'sale_price';
    const where = [];
    const params = { factor: 1 + pct / 100 };
    if (req.body.type) { where.push('type = @type'); params.type = req.body.type; }
    if (req.body.category_id) { where.push('category_id = @cat'); params.cat = req.body.category_id; }
    if (req.body.catalog) { where.push('catalog = @catalog'); params.catalog = req.body.catalog; }
    where.push("type <> 'ouvrage'");
    const info = db.prepare(`UPDATE items SET ${field} = ROUND(${field} * @factor, 2), updated_at = datetime('now') WHERE ${where.join(' AND ')}`).run(params);
    res.json({ updated: info.changes });
  });

  r.get('/items/:id', (req, res) => {
    const it = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
    if (!it) return res.status(404).json({ error: 'Article introuvable' });
    it.components = getComponents(it.id);
    res.json(it);
  });

  function saveComponents(id, components) {
    if (!Array.isArray(components)) return;
    db.prepare('DELETE FROM item_components WHERE parent_id = ?').run(id);
    const ins = db.prepare('INSERT INTO item_components (parent_id, child_id, quantity, position) VALUES (?, ?, ?, ?)');
    components.forEach((c, i) => {
      if (c.child_id && Number(c.child_id) !== Number(id)) ins.run(id, c.child_id, toNumber(c.quantity, 1), i);
    });
  }

  r.post('/items', (req, res) => {
    const it = normalizeItem(req.body);
    if (!it.designation) return res.status(400).json({ error: 'Désignation obligatoire' });
    const id = db.transaction(() => {
      const newId = db.prepare(`INSERT INTO items (${ITEM_FIELDS.join(',')}) VALUES (${ITEM_FIELDS.map((k) => '@' + k).join(',')})`).run(it).lastInsertRowid;
      saveComponents(newId, req.body.components);
      return newId;
    })();
    res.status(201).json({ ...db.prepare('SELECT * FROM items WHERE id = ?').get(id), components: getComponents(id) });
  });

  r.put('/items/:id', (req, res) => {
    const it = normalizeItem(req.body);
    it.id = Number(req.params.id);
    db.transaction(() => {
      db.prepare(`UPDATE items SET ${ITEM_FIELDS.map((k) => `${k} = @${k}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`).run(it);
      saveComponents(it.id, req.body.components);
    })();
    res.json({ ...db.prepare('SELECT * FROM items WHERE id = ?').get(it.id), components: getComponents(it.id) });
  });

  r.post('/items/:id/duplicate', (req, res) => {
    const src = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
    if (!src) return res.status(404).json({ error: 'Article introuvable' });
    const it = pick(src, ITEM_FIELDS);
    it.designation += ' (copie)';
    it.reference = it.reference ? it.reference + '-COPIE' : null;
    const id = db.transaction(() => {
      const newId = db.prepare(`INSERT INTO items (${ITEM_FIELDS.join(',')}) VALUES (${ITEM_FIELDS.map((k) => '@' + k).join(',')})`).run(it).lastInsertRowid;
      saveComponents(newId, getComponents(src.id));
      return newId;
    })();
    res.status(201).json(db.prepare('SELECT * FROM items WHERE id = ?').get(id));
  });

  r.delete('/items/:id', (req, res) => {
    const usedIn = db.prepare('SELECT COUNT(*) AS n FROM item_components WHERE child_id = ?').get(req.params.id).n;
    if (usedIn) return res.status(409).json({ error: `Cet article est utilisé dans ${usedIn} ouvrage(s). Désactivez-le plutôt.` });
    db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // Prix calculé d'un ouvrage à partir de ses composants
  r.get('/items/:id/computed-price', (req, res) => {
    const comps = getComponents(req.params.id);
    const sale = round2(comps.reduce((s, c) => s + c.quantity * c.sale_price, 0));
    const purchase = round2(comps.reduce((s, c) => s + c.quantity * c.purchase_price, 0));
    res.json({ sale_price: sale, purchase_price: purchase });
  });

  return r;
};

module.exports.toNumber = toNumber;
