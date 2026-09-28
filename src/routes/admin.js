'use strict';

const express = require('express');
const { getSettings, DEFAULT_SETTINGS } = require('../db');
const { renderDocument, pageHtml, handlebars } = require('../render');
const { peekNumber } = require('../numbering');

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const CLIENT_NAME_SQL = "COALESCE(NULLIF(c.company,''), TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')))";

const BACKUP_TABLES = ['settings', 'clients', 'categories', 'items', 'item_components', 'templates', 'documents', 'document_lines', 'payments', 'counters'];

module.exports = function adminRoutes(db) {
  const r = express.Router();

  // ---------- Paramètres ----------
// La clé API n'est jamais renvoyée au navigateur ni incluse dans les sauvegardes
  const publicSettings = () => {
    const s = getSettings(db);
    s.ai_key_configured = !!s.anthropic_api_key;
    delete s.anthropic_api_key;
    return s;
  };

  r.get('/settings', (req, res) => res.json(publicSettings()));

  r.put('/settings', (req, res) => {
    const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    db.transaction(() => {
      for (const [k, v] of Object.entries(req.body || {})) {
        if (!(k in DEFAULT_SETTINGS)) continue;
        const value = v === null || v === undefined ? '' : String(v);
        up.run(k, k === 'anthropic_api_key' ? value.trim() : value);
      }
    })();
    res.json(publicSettings());
  });

  // ---------- Modèles de document ----------
  r.get('/templates', (req, res) => {
    res.json(db.prepare('SELECT id, name, is_default, updated_at, background IS NOT NULL AND background <> \'\' AS has_background FROM templates ORDER BY is_default DESC, name').all());
  });
  r.get('/templates/:id', (req, res) => {
    const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Modèle introuvable' });
    res.json(t);
  });
  r.post('/templates', (req, res) => {
    const src = req.body.copy_of ? db.prepare('SELECT * FROM templates WHERE id = ?').get(req.body.copy_of) : null;
    const html = req.body.html ?? src?.html ?? '<div>{{doc.type_label}} {{doc.number}}</div>';
    const css = req.body.css ?? src?.css ?? '';
    const name = req.body.name || (src ? `${src.name} (copie)` : 'Nouveau modèle');
    const background = req.body.background ?? src?.background ?? null;
    try { handlebars.precompile(html); handlebars.precompile(css); } catch (e) {
      return res.status(400).json({ error: 'Erreur dans le modèle : ' + e.message });
    }
    const info = db.prepare('INSERT INTO templates (name, html, css, background, is_default) VALUES (?, ?, ?, ?, 0)').run(name, html, css, background);
    res.status(201).json(db.prepare('SELECT * FROM templates WHERE id = ?').get(info.lastInsertRowid));
  });
  r.put('/templates/:id', (req, res) => {
    const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Modèle introuvable' });
    // Vérifie la syntaxe avant d'enregistrer
    try {
      handlebars.precompile(req.body.html ?? t.html);
      handlebars.precompile(req.body.css ?? t.css ?? '');
    } catch (e) {
      return res.status(400).json({ error: 'Erreur dans le modèle : ' + e.message });
    }
    db.transaction(() => {
      db.prepare("UPDATE templates SET name = ?, html = ?, css = ?, background = ?, updated_at = datetime('now') WHERE id = ?")
        .run(req.body.name ?? t.name, req.body.html ?? t.html, req.body.css ?? t.css, req.body.background !== undefined ? (req.body.background || null) : t.background, t.id);
      if (req.body.is_default) {
        db.prepare('UPDATE templates SET is_default = 0').run();
        db.prepare('UPDATE templates SET is_default = 1 WHERE id = ?').run(t.id);
      }
    })();
    res.json(db.prepare('SELECT * FROM templates WHERE id = ?').get(t.id));
  });
  r.delete('/templates/:id', (req, res) => {
    const n = db.prepare('SELECT COUNT(*) AS n FROM templates').get().n;
    if (n <= 1) return res.status(409).json({ error: 'Il faut conserver au moins un modèle.' });
    const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
    db.transaction(() => {
      db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
      if (t?.is_default) db.prepare('UPDATE templates SET is_default = 1 WHERE id = (SELECT MIN(id) FROM templates)').run();
    })();
    res.json({ ok: true });
  });

  // Aperçu d'un modèle (non enregistré) sur un document existant, ou sur un document de démonstration
  r.post('/templates/preview', (req, res) => {
    let doc = req.body.document_id ? db.prepare('SELECT * FROM documents WHERE id = ?').get(req.body.document_id) : null;
    if (!doc) doc = db.prepare("SELECT * FROM documents ORDER BY (type = 'devis') DESC, id DESC LIMIT 1").get();
    if (!doc) {
      return res.type('html').send(pageHtml({ title: 'Aperçu', css: '', body: '<p style="font-family:sans-serif">Créez d\'abord un devis ou une facture pour prévisualiser le modèle.</p>' }));
    }
    try {
      const { body, css } = renderDocument(db, doc, { html: req.body.html || '', css: req.body.css || '', background: req.body.background || '' });
      res.type('html').send(pageHtml({ title: 'Aperçu', body, css }));
    } catch (e) {
      res.type('html').send(pageHtml({ title: 'Erreur', css: '', body: `<pre style="color:#b00;white-space:pre-wrap">Erreur dans le modèle :\n${String(e.message).replace(/</g, '&lt;')}</pre>` }));
    }
  });

  // ---------- Page d'accueil ----------
  const money = (v) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(v || 0);
  const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);

  // Conseil du jour : l'action la plus utile à faire maintenant
  function insight(today) {
    const base = `SELECT d.*, ${CLIENT_NAME_SQL} AS client_name FROM documents d LEFT JOIN clients c ON c.id = d.client_id`;
    const late = db.prepare(`${base} WHERE d.type = 'facture' AND d.status IN ('emise','partielle') AND d.due_date < ? ORDER BY d.due_date LIMIT 1`).get(today);
    if (late) {
      return { tone: 'danger', title: 'Facture en retard', href: `document.html?id=${late.id}`,
        text: `Relancez ${late.client_name} : la facture ${late.number} (${money(late.total_ttc)}) est échue depuis ${daysBetween(late.due_date, today)} jour(s).` };
    }
    const won = db.prepare(`${base} WHERE d.type = 'devis' AND d.status = 'accepte' ORDER BY d.date LIMIT 1`).get();
    if (won) {
      return { tone: 'ok', title: 'Devis accepté', href: `document.html?id=${won.id}`,
        text: `${won.client_name} a accepté le devis ${won.number} (${money(won.total_ht)} HT). Transformez-le en facture.` };
    }
    const sent = db.prepare(`${base} WHERE d.type = 'devis' AND d.status = 'envoye' ORDER BY d.date LIMIT 1`).get();
    if (sent) {
      const days = daysBetween(sent.date, today);
      return { tone: 'info', title: 'À relancer', href: `document.html?id=${sent.id}`,
        text: `Contactez ${sent.client_name} ${days > 0 ? `: devis ${sent.number} envoyé il y a ${days} jour(s)` : `au sujet du devis ${sent.number}`} (${money(sent.total_ht)} HT).` };
    }
    const any = db.prepare('SELECT COUNT(*) AS n FROM documents').get().n;
    return any
      ? { tone: 'ok', title: 'Tout est à jour', href: 'document.html?new=devis', text: 'Aucune relance en attente. Préparez votre prochain devis.' }
      : { tone: 'info', title: 'Premier pas', href: 'document.html?new=devis', text: 'Créez votre premier devis à partir du catalogue.' };
  }

  // Activité récente : documents modifiés et règlements reçus
  function activity() {
    const docs = db.prepare(`SELECT d.id, d.type, d.number, d.status, d.total_ttc, d.updated_at AS at, ${CLIENT_NAME_SQL} AS client_name
      FROM documents d LEFT JOIN clients c ON c.id = d.client_id ORDER BY d.updated_at DESC, d.id DESC LIMIT 8`).all();
    const pays = db.prepare(`SELECT p.id, p.amount, p.created_at AS at, d.id AS doc_id, d.number, ${CLIENT_NAME_SQL} AS client_name
      FROM payments p JOIN documents d ON d.id = p.document_id LEFT JOIN clients c ON c.id = d.client_id ORDER BY p.created_at DESC, p.id DESC LIMIT 4`).all();
    const label = { devis: 'Devis', facture: 'Facture', avoir: 'Avoir' };
    const verb = { brouillon: 'en préparation', envoye: 'envoyé', accepte: 'accepté', refuse: 'refusé', facture: 'facturé',
      emise: 'émise', partielle: 'partiellement réglée', payee: 'réglée', annulee: 'annulée' };
    return [
      ...docs.map((d) => ({ kind: d.type, at: d.at, href: `document.html?id=${d.id}`,
        text: `${label[d.type]} ${d.number || ''} ${verb[d.status] || ''}`.replace(/\s+/g, ' ').trim(), sub: d.client_name || '', amount: d.total_ttc })),
      ...pays.map((p) => ({ kind: 'payment', at: p.at, href: `document.html?id=${p.doc_id}`,
        text: `Règlement reçu sur ${p.number}`, sub: p.client_name || '', amount: p.amount }))
    ].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 6);
  }

  r.get('/home', (req, res) => {
    const s = getSettings(db);
    const today = localToday();
    const n = (sql, ...p) => db.prepare(sql).get(...p).n || 0;
    const open = db.prepare(`SELECT d.total_ttc, d.due_date,
        (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.document_id = d.id) AS paid,
        (SELECT COALESCE(SUM(total_ttc),0) FROM documents a WHERE a.type = 'avoir' AND a.source_id = d.id AND a.number IS NOT NULL) AS credited
      FROM documents d WHERE d.type = 'facture' AND d.status IN ('emise','partielle')`).all();
    const byType = {};
    for (const row of db.prepare('SELECT type, COUNT(*) AS n FROM items WHERE active = 1 GROUP BY type').all()) byType[row.type] = row.n;
    res.json({
      company: { name: s.company_name, city: s.company_city, logo: s.company_logo },
      company_missing: [['company_siret', 'SIRET'], ['company_address', 'adresse'], ['company_email', 'e-mail'], ['bank_iban', 'IBAN']]
        .filter(([k]) => !s[k]).map(([, label]) => label),
      today,
      counts: {
        quotes: n("SELECT COUNT(*) AS n FROM documents WHERE type = 'devis'"),
        quotes_waiting: n("SELECT COUNT(*) AS n FROM documents WHERE type = 'devis' AND status IN ('brouillon','envoye')"),
        quotes_accepted: n("SELECT COUNT(*) AS n FROM documents WHERE type = 'devis' AND status = 'accepte'"),
        quotes_pending_ht: Math.round((db.prepare("SELECT COALESCE(SUM(total_ht),0) AS n FROM documents WHERE type = 'devis' AND status IN ('brouillon','envoye','accepte')").get().n) * 100) / 100,
        invoices: n("SELECT COUNT(*) AS n FROM documents WHERE type = 'facture' AND number IS NOT NULL"),
        invoices_draft: n("SELECT COUNT(*) AS n FROM documents WHERE type = 'facture' AND number IS NULL"),
        invoices_open: open.length,
        invoices_overdue: open.filter((d) => d.due_date && d.due_date < today).length,
        credits: n("SELECT COUNT(*) AS n FROM documents WHERE type = 'avoir'"),
        clients: n('SELECT COUNT(*) AS n FROM clients'),
        clients_pro: n("SELECT COUNT(*) AS n FROM clients WHERE kind = 'professionnel'"),
        items: Object.values(byType).reduce((a, b) => a + b, 0),
        items_by_type: byType,
        categories: n('SELECT COUNT(*) AS n FROM categories'),
        catalogs: n("SELECT COUNT(DISTINCT catalog) AS n FROM items WHERE catalog IS NOT NULL AND catalog <> ''"),
        templates: n('SELECT COUNT(*) AS n FROM templates')
      },
      receivable: Math.round(open.reduce((sum, d) => sum + d.total_ttc - d.paid - d.credited, 0) * 100) / 100,
      next_numbers: { devis: peekNumber(db, 'devis', today), facture: peekNumber(db, 'facture', today), avoir: peekNumber(db, 'avoir', today) },
      template_default: db.prepare('SELECT name FROM templates ORDER BY is_default DESC, id LIMIT 1').get()?.name || '',
      recent: db.prepare(`SELECT d.id, d.type, d.number, d.status, d.date, d.title, d.total_ttc, ${CLIENT_NAME_SQL} AS client_name
        FROM documents d LEFT JOIN clients c ON c.id = d.client_id ORDER BY d.updated_at DESC, d.id DESC LIMIT 6`).all(),
      insight: insight(today),
      activity: activity()
    });
  });

  // ---------- Tableau de bord ----------
  r.get('/dashboard', (req, res) => {
    const year = String(req.query.year || new Date().getFullYear());
    const sum = (sql, ...p) => db.prepare(sql).get(...p).s || 0;
    const invoiced = sum("SELECT SUM(total_ht) AS s FROM documents WHERE type = 'facture' AND number IS NOT NULL AND substr(date,1,4) = ?", year);
    const credited = sum("SELECT SUM(total_ht) AS s FROM documents WHERE type = 'avoir' AND number IS NOT NULL AND substr(date,1,4) = ?", year);
    const collected = sum('SELECT SUM(p.amount) AS s FROM payments p WHERE substr(p.date,1,4) = ?', year);
    const openInvoices = db.prepare(`SELECT d.id, d.number, d.date, d.due_date, d.total_ttc, d.status,
        COALESCE(NULLIF(c.company,''), TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,''))) AS client_name,
        (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.document_id = d.id) AS paid,
        (SELECT COALESCE(SUM(total_ttc),0) FROM documents a WHERE a.type = 'avoir' AND a.source_id = d.id AND a.number IS NOT NULL) AS credited
      FROM documents d LEFT JOIN clients c ON c.id = d.client_id
      WHERE d.type = 'facture' AND d.status IN ('emise','partielle') ORDER BY d.due_date`).all();
    const receivable = openInvoices.reduce((s, d) => s + d.total_ttc - d.paid - d.credited, 0);
    const today = new Date().toISOString().slice(0, 10);
    const overdue = openInvoices.filter((d) => d.due_date && d.due_date < today);
    const pendingQuotes = db.prepare(`SELECT d.id, d.number, d.date, d.validity_date, d.total_ht, d.total_ttc, d.status, d.title,
        COALESCE(NULLIF(c.company,''), TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,''))) AS client_name
      FROM documents d LEFT JOIN clients c ON c.id = d.client_id
      WHERE d.type = 'devis' AND d.status IN ('brouillon','envoye','accepte') ORDER BY d.date DESC`).all();
    const quotesYear = db.prepare("SELECT status, COUNT(*) AS n FROM documents WHERE type = 'devis' AND substr(date,1,4) = ? GROUP BY status").all(year);
    const qTotal = quotesYear.reduce((s, q) => s + q.n, 0);
    const qWon = quotesYear.filter((q) => ['accepte', 'facture'].includes(q.status)).reduce((s, q) => s + q.n, 0);
    const monthly = db.prepare(`SELECT substr(date,6,2) AS m,
        SUM(CASE WHEN type = 'facture' THEN total_ht ELSE -total_ht END) AS ht
      FROM documents WHERE type IN ('facture','avoir') AND number IS NOT NULL AND substr(date,1,4) = ? GROUP BY m ORDER BY m`).all(year);
    const months = Array.from({ length: 12 }, (_, i) => {
      const m = String(i + 1).padStart(2, '0');
      return { month: m, ht: Math.round((monthly.find((x) => x.m === m)?.ht || 0) * 100) / 100 };
    });
    res.json({
      year,
      revenue_ht: Math.round((invoiced - credited) * 100) / 100,
      collected: Math.round(collected * 100) / 100,
      receivable: Math.round(receivable * 100) / 100,
      overdue,
      open_invoices: openInvoices,
      pending_quotes: pendingQuotes,
      pending_quotes_total: Math.round(pendingQuotes.reduce((s, q) => s + q.total_ht, 0) * 100) / 100,
      conversion_rate: qTotal ? Math.round(qWon / qTotal * 1000) / 10 : 0,
      months
    });
  });

  // ---------- Sauvegarde / restauration ----------
  r.get('/backup', (req, res) => {
    const dump = { app: 'fre2g-facturation', version: 1, exported_at: new Date().toISOString(), tables: {} };
    for (const t of BACKUP_TABLES) dump.tables[t] = db.prepare(`SELECT * FROM ${t}`).all();
    dump.tables.settings = dump.tables.settings.filter((row) => row.key !== 'anthropic_api_key');
    res.setHeader('Content-Disposition', `attachment; filename="sauvegarde-facturation-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(dump);
  });

  r.post('/restore', (req, res) => {
    const dump = req.body;
    if (!dump || dump.app !== 'fre2g-facturation' || !dump.tables) return res.status(400).json({ error: 'Fichier de sauvegarde invalide.' });
    const keptKey = getSettings(db).anthropic_api_key || '';
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        for (const t of [...BACKUP_TABLES].reverse()) db.prepare(`DELETE FROM ${t}`).run();
        for (const t of BACKUP_TABLES) {
          const rows = dump.tables[t] || [];
          const validCols = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
          for (const row of rows) {
            const cols = Object.keys(row).filter((c) => validCols.has(c));
            db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`).run(Object.fromEntries(cols.map((c) => [c, row[c]])));
          }
        }
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('anthropic_api_key', keptKey);
      })();
    } finally {
      db.pragma('foreign_keys = ON');
    }
    res.json({ ok: true });
  });

  return r;
};
