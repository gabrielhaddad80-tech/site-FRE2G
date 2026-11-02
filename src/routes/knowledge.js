'use strict';

/*
 * Connaissances de l'assistant IA (comme un « projet » Claude) :
 * des instructions permanentes et des fichiers de référence (PDF, images, textes)
 * utilisés par le chat et par l'assistant de rédaction.
 */

const express = require('express');

const MAX_FILES = 20;
const MAX_INSTRUCTIONS = 20000;
const MAX_BINARY = 10 * 1024 * 1024;     // PDF ou image : 10 Mo
const MAX_TEXT = 1024 * 1024;            // fichier texte : 1 Mo
const MAX_TOTAL = 30 * 1024 * 1024;      // total des fichiers : 30 Mo
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ai_files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,          -- pdf | image | text
  media_type TEXT,
  size       INTEGER NOT NULL DEFAULT 0,
  data       TEXT,                   -- contenu binaire en base64 (pdf, image)
  text       TEXT,                   -- contenu texte (fichier texte, ou texte extrait d'un PDF)
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);`;

const ensureSchema = (db) => db.exec(SCHEMA);

function getInstructions(db) {
  return (db.prepare("SELECT value FROM settings WHERE key = 'ai_instructions'").get() || {}).value || '';
}

/** Instructions + fichiers actifs, avec leur contenu (pour construire les requêtes à l'IA). */
function loadKnowledge(db) {
  ensureSchema(db);
  return {
    instructions: getInstructions(db),
    files: db.prepare('SELECT id, name, kind, media_type, size, data, text FROM ai_files WHERE active = 1 ORDER BY id').all()
  };
}

/** Texte à ajouter aux consignes : instructions et fichiers texte (ou texte extrait des PDF si demandé). */
function knowledgeText(k, { pdfAsText = false } = {}) {
  const parts = [];
  if (k.instructions.trim()) {
    parts.push("INSTRUCTIONS DE L'ENTREPRISE (à suivre dans toutes tes réponses, sauf si elles contredisent la loi ou les règles ci-dessus) :\n" + k.instructions.trim());
  }
  const texts = k.files.filter((f) => f.kind === 'text' || (pdfAsText && f.kind === 'pdf' && f.text));
  if (texts.length) {
    parts.push('DOCUMENTS DE RÉFÉRENCE fournis par l\'entreprise (à utiliser quand ils sont utiles) :\n'
      + texts.map((f) => `--- ${f.name} ---\n${(f.text || '').slice(0, 200000)}`).join('\n\n'));
  }
  return parts.join('\n\n');
}

function publicFile(f) {
  return { id: f.id, name: f.name, kind: f.kind, media_type: f.media_type, size: f.size, active: !!f.active, created_at: f.created_at, has_text: !!f.has_text };
}

module.exports = function knowledgeRoutes(db) {
  ensureSchema(db);
  const r = express.Router();
  const list = () => db.prepare("SELECT id, name, kind, media_type, size, active, created_at, (text IS NOT NULL AND text <> '') AS has_text FROM ai_files ORDER BY id").all().map(publicFile);

  r.get('/knowledge', (req, res) => {
    res.json({ instructions: getInstructions(db), files: list(), limits: { files: MAX_FILES, total: MAX_TOTAL, binary: MAX_BINARY, text: MAX_TEXT, instructions: MAX_INSTRUCTIONS } });
  });

  r.put('/knowledge/instructions', (req, res) => {
    const text = String((req.body && req.body.instructions) || '');
    if (text.length > MAX_INSTRUCTIONS) throw httpError(400, `Instructions trop longues (${MAX_INSTRUCTIONS} caractères maximum).`);
    db.prepare("INSERT INTO settings (key, value) VALUES ('ai_instructions', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(text);
    res.json({ instructions: text });
  });

  r.post('/knowledge/files', (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 150);
    if (!name) throw httpError(400, 'Nom de fichier manquant.');
    if (db.prepare('SELECT COUNT(*) AS n FROM ai_files').get().n >= MAX_FILES) throw httpError(400, `${MAX_FILES} fichiers maximum : supprimez-en un d'abord.`);
    let size, data = null, text = null, mediaType = null;
    if (b.kind === 'pdf' || b.kind === 'image') {
      mediaType = b.kind === 'pdf' ? 'application/pdf' : b.media_type;
      if (b.kind === 'image' && !IMAGE_TYPES.includes(mediaType)) throw httpError(400, 'Image non prise en charge (JPEG, PNG, WebP ou GIF).');
      if (typeof b.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(b.data)) throw httpError(400, 'Contenu du fichier illisible.');
      size = Math.floor(b.data.length * 3 / 4);
      if (size > MAX_BINARY) throw httpError(413, `« ${name} » dépasse 10 Mo.`);
      data = b.data;
      if (b.kind === 'pdf' && typeof b.text === 'string') text = b.text.slice(0, 2 * MAX_TEXT);
    } else if (b.kind === 'text') {
      if (typeof b.text !== 'string') throw httpError(400, 'Contenu du fichier illisible.');
      size = new TextEncoder().encode(b.text).length;
      if (size > MAX_TEXT) throw httpError(413, `« ${name} » dépasse 1 Mo.`);
      text = b.text;
    } else {
      throw httpError(400, 'Type de fichier non pris en charge (PDF, image ou texte).');
    }
    const total = db.prepare('SELECT COALESCE(SUM(size), 0) AS s FROM ai_files').get().s;
    if (total + size > MAX_TOTAL) throw httpError(413, 'Espace des fichiers plein (30 Mo au total) : supprimez des fichiers.');
    const id = db.prepare('INSERT INTO ai_files (name, kind, media_type, size, data, text) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, b.kind, mediaType, size, data, text).lastInsertRowid;
    res.status(201).json(list().find((f) => f.id === id));
  });

  r.get('/knowledge/files/:id', (req, res) => {
    const f = db.prepare('SELECT * FROM ai_files WHERE id = ?').get(req.params.id);
    if (!f) throw httpError(404, 'Fichier introuvable.');
    res.json({ ...publicFile({ ...f, has_text: !!f.text }), text: f.text ? f.text.slice(0, 20000) : '', data: f.kind === 'image' ? f.data : undefined });
  });

  r.put('/knowledge/files/:id', (req, res) => {
    const f = db.prepare('SELECT * FROM ai_files WHERE id = ?').get(req.params.id);
    if (!f) throw httpError(404, 'Fichier introuvable.');
    const active = req.body.active === undefined ? f.active : (req.body.active ? 1 : 0);
    const name = req.body.name ? String(req.body.name).trim().slice(0, 150) : f.name;
    db.prepare('UPDATE ai_files SET active = ?, name = ? WHERE id = ?').run(active, name, f.id);
    res.json(list().find((x) => x.id === f.id));
  });

  r.delete('/knowledge/files/:id', (req, res) => {
    const info = db.prepare('DELETE FROM ai_files WHERE id = ?').run(req.params.id);
    if (!info.changes) throw httpError(404, 'Fichier introuvable.');
    res.json({ ok: true });
  });

  // Contexte prêt à l'emploi pour les vues sans accès serveur à l'IA (démo) : instructions, textes, images
  r.get('/knowledge/context', (req, res) => {
    const k = loadKnowledge(db);
    res.json({
      text: knowledgeText(k, { pdfAsText: true }),
      images: k.files.filter((f) => f.kind === 'image').map((f) => ({ name: f.name, media_type: f.media_type, data: f.data })),
      pdf_without_text: k.files.filter((f) => f.kind === 'pdf' && !f.text).map((f) => f.name)
    });
  });

  return r;
};

module.exports.loadKnowledge = loadKnowledge;
module.exports.knowledgeText = knowledgeText;
module.exports.ensureSchema = ensureSchema;
