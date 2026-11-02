'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { openDatabase } = require('../src/db');
const { createApp } = require('../server');
const { findChrome, closeBrowser } = require('../src/export/pdf');

let server, base, quote;

before(async () => {
  const db = openDatabase(':memory:');
  server = createApp(db, { auth: false }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const client = await post('/clients', { company: 'Société Élan', city: 'Lyon' });
  quote = await post('/documents', {
    type: 'devis', client_id: client.id, title: 'Rénovation salle de bain',
    lines: [
      { kind: 'section', designation: 'Démolition' },
      { kind: 'item', designation: 'Dépose carrelage', description: 'Évacuation des gravats', quantity: 12, unit: 'm²', unit_price: 25, vat_rate: 10 },
      { kind: 'text', designation: 'Accès par l\'escalier' },
      { kind: 'section', designation: 'Pose' },
      { kind: 'item', designation: 'Carrelage grès cérame', quantity: 12, unit: 'm²', unit_price: 55, vat_rate: 20, discount_pct: 5 }
    ]
  });
});
after(async () => { server.close(); await closeBrowser(); });

// Texte de word/document.xml dans l'archive .docx (lecture minimale du zip)
function docxXml(buf) {
  let off = 0;
  while ((off = buf.indexOf('PK\u0003\u0004', off, 'latin1')) !== -1) {
    const method = buf.readUInt16LE(off + 8);
    const size = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extra = buf.readUInt16LE(off + 28);
    const name = buf.toString('utf8', off + 30, off + 30 + nameLen);
    const start = off + 30 + nameLen + extra;
    if (name === 'word/document.xml') {
      const data = buf.subarray(start, start + size);
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    }
    off = start;
  }
  return '';
}

test('export Word : fichier .docx avec le contenu du devis', async () => {
  const res = await fetch(`${base}/documents/${quote.id}/docx`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /wordprocessingml/);
  const cd = res.headers.get('content-disposition');
  assert.match(cd, /^attachment; filename="Devis DEV-\d{4}-0001 - Societe Elan\.docx"/);
  assert.match(cd, /filename\*=UTF-8''Devis%20DEV-\d{4}-0001%20-%20Soci%C3%A9t%C3%A9%20%C3%89lan\.docx/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.strictEqual(buf.toString('latin1', 0, 2), 'PK');
  const xml = docxXml(buf);
  for (const t of ['DEVIS', 'Société Élan', 'Dépose carrelage', 'Évacuation des gravats', 'Démolition', 'Rénovation salle de bain']) {
    assert.ok(xml.includes(t), `texte manquant : ${t}`);
  }
});

test('export : document introuvable', async () => {
  assert.strictEqual((await fetch(`${base}/documents/9999/docx`)).status, 404);
  assert.strictEqual((await fetch(`${base}/documents/9999/pdf`)).status, 404);
});

test('export PDF (si un navigateur Chrome est disponible)', { skip: !findChrome() && 'aucun navigateur Chrome trouvé (CHROME_PATH)' }, async () => {
  const res = await fetch(`${base}/documents/${quote.id}/pdf`);
  assert.strictEqual(res.status, 200, await res.clone().text());
  assert.strictEqual(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="Devis DEV-/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.strictEqual(buf.toString('latin1', 0, 5), '%PDF-');
  assert.ok(buf.length > 5000);
});
