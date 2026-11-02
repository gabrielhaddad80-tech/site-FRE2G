'use strict';

// Téléchargement des devis / factures / avoirs en PDF ou en Word (.docx).
// Séparé de documents.js : ce module dépend de Chrome et de la bibliothèque docx (absents de la démo).
const express = require('express');
const { renderDocument, buildContext, pageHtml } = require('../render');
const { htmlToPdf } = require('../export/pdf');
const { buildDocx } = require('../export/docx');

function fileName(ctx, ext) {
  const name = `${ctx.doc.type_label} ${ctx.doc.number}${ctx.client.display_name ? ' - ' + ctx.client.display_name : ''}`;
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) + '.' + ext;
}

function sendFile(res, buf, name, type, inline) {
  const ascii = name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  res.set({
    'Content-Type': type,
    'Content-Length': buf.length,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store'
  });
  res.end(buf);
}

module.exports = function exportRoutes(db) {
  const r = express.Router();
  const getDoc = (id) => db.prepare('SELECT * FROM documents WHERE id = ?').get(id);

  r.get('/documents/:id/pdf', async (req, res, next) => {
    try {
      const doc = getDoc(req.params.id);
      if (!doc) return res.status(404).json({ error: 'Document introuvable' });
      const { body, css, ctx } = renderDocument(db, doc);
      const name = fileName(ctx, 'pdf');
      const pdf = await htmlToPdf(pageHtml({ title: name.slice(0, -4), body, css, toolbar: false }));
      sendFile(res, pdf, name, 'application/pdf', req.query.inline === '1');
    } catch (err) { next(err); }
  });

  r.get('/documents/:id/docx', async (req, res, next) => {
    try {
      const doc = getDoc(req.params.id);
      if (!doc) return res.status(404).json({ error: 'Document introuvable' });
      const ctx = buildContext(db, doc);
      const buf = await buildDocx(ctx);
      sendFile(res, buf, fileName(ctx, 'docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    } catch (err) { next(err); }
  });

  return r;
};

module.exports.fileName = fileName;
