'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { openDatabase } = require('../src/db');
const { createApp } = require('../server');

let server, base;
const seen = [];
let reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'OK' }] };
const fake = () => ({ beta: { messages: { create: async (params) => { seen.push(JSON.parse(JSON.stringify(params))); return reply; } } } });

before(async () => {
  const db = openDatabase(':memory:');
  server = createApp(db, { ai: { createClient: fake }, auth: false }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

async function call(path, method = 'GET', body) {
  const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

let pdfId, imgId, txtId;

test('instructions et fichiers : enregistrement et limites', async () => {
  const empty = (await call('/knowledge')).body;
  assert.strictEqual(empty.instructions, '');
  assert.deepStrictEqual(empty.files, []);
  assert.strictEqual((await call('/knowledge/instructions', 'PUT', { instructions: 'x'.repeat(20001) })).status, 400);
  assert.strictEqual((await call('/knowledge/instructions', 'PUT', { instructions: 'Taux horaire 45 € HT. Toujours compter le déplacement.' })).status, 200);

  assert.strictEqual((await call('/knowledge/files', 'POST', { name: 'virus.exe', kind: 'exe', data: 'AA' })).status, 400);
  assert.strictEqual((await call('/knowledge/files', 'POST', { name: 'img.bmp', kind: 'image', media_type: 'image/bmp', data: 'AAAA' })).status, 400);
  assert.strictEqual((await call('/knowledge/files', 'POST', { name: 'x.pdf', kind: 'pdf', data: 'pas du base64 !' })).status, 400);
  assert.strictEqual((await call('/knowledge/files', 'POST', { name: 'gros.txt', kind: 'text', text: 'é'.repeat(600000) })).status, 413, 'taille comptée en octets');

  const pdf = await call('/knowledge/files', 'POST', { name: 'CGV.pdf', kind: 'pdf', data: 'JVBERi0xLjQ=', text: 'Conditions générales de vente' });
  assert.strictEqual(pdf.status, 201);
  assert.strictEqual(pdf.body.has_text, true);
  assert.ok(!('data' in pdf.body), 'le contenu n\'est pas renvoyé dans la liste');
  pdfId = pdf.body.id;
  imgId = (await call('/knowledge/files', 'POST', { name: 'logo.png', kind: 'image', media_type: 'image/png', data: 'iVBORw0KGgo=' })).body.id;
  txtId = (await call('/knowledge/files', 'POST', { name: 'tarif.csv', kind: 'text', text: 'ref;prix\nLR-10;27,50' })).body.id;
  const k = (await call('/knowledge')).body;
  assert.strictEqual(k.files.length, 3);
  assert.ok(k.files.every((f) => f.active));
  assert.match((await call('/knowledge/files/' + txtId)).body.text, /LR-10/);
  assert.strictEqual((await call('/knowledge/files/' + imgId)).body.data, 'iVBORw0KGgo=');
});

test('le chat reçoit instructions et fichiers actifs, avec mise en cache', async () => {
  await call('/settings', 'PUT', { anthropic_api_key: 'sk-ant-x' });
  await call('/knowledge/files/' + imgId, 'PUT', { active: false });
  seen.length = 0;
  const r = await call('/ai/chat', 'POST', { messages: [{ role: 'user', content: 'Bonjour' }, { role: 'assistant', content: 'Bonjour !' }, { role: 'user', content: 'Mon taux ?' }] });
  assert.strictEqual(r.status, 200);
  const p = seen[0];
  assert.strictEqual(p.system.length, 1);
  assert.match(p.system[0].text, /INSTRUCTIONS DE L'ENTREPRISE[\s\S]*Taux horaire 45/);
  assert.match(p.system[0].text, /tarif\.csv[\s\S]*LR-10;27,50/, 'fichier texte dans les consignes');
  assert.deepStrictEqual(p.system[0].cache_control, { type: 'ephemeral' });
  const first = p.messages[0].content;
  assert.strictEqual(p.messages[0].role, 'user');
  const doc = first.find((b) => b.type === 'document');
  assert.strictEqual(doc.title, 'CGV.pdf');
  assert.deepStrictEqual(doc.cache_control, { type: 'ephemeral' }, 'point de cache après les documents');
  assert.ok(!first.some((b) => b.type === 'image'), 'fichier désactivé non envoyé');
  assert.strictEqual(first.at(-1).text, 'Bonjour', 'le premier message de la conversation suit les documents');
  assert.strictEqual(p.messages.at(-1).content, 'Mon taux ?');
});

test('l\'assistant de rédaction reçoit aussi les connaissances', async () => {
  await call('/knowledge/files/' + imgId, 'PUT', { active: true });
  reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ title: 'T', site_address: '', summary: '', lines: [], questions: [] }) }] };
  seen.length = 0;
  await call('/ai/draft', 'POST', { text: 'Pose de carrelage' });
  const p = seen[0];
  assert.match(p.system[0].text, /Taux horaire 45/);
  const content = p.messages[0].content;
  assert.ok(content.some((b) => b.type === 'image'), 'image de référence active envoyée');
  assert.match(content.at(-1).text, /Pose de carrelage/);
  const cached = content.filter((b) => b.cache_control);
  assert.strictEqual(cached.length, 1);
});

test('fichiers : désactivation, suppression, sauvegarde', async () => {
  const dump = (await call('/backup')).body;
  assert.strictEqual(dump.tables.ai_files.length, 3, 'les fichiers font partie de la sauvegarde');
  assert.ok(dump.tables.settings.some((s) => s.key === 'ai_instructions'));
  assert.strictEqual((await call('/knowledge/files/' + pdfId, 'DELETE')).status, 200);
  assert.strictEqual((await call('/knowledge/files/' + pdfId, 'DELETE')).status, 404);
  await call('/restore', 'POST', dump);
  assert.strictEqual((await call('/knowledge')).body.files.length, 3, 'restaurés avec la sauvegarde');
  const ctx = (await call('/knowledge/context')).body;
  assert.match(ctx.text, /Conditions générales de vente/, 'texte du PDF pour les vues sans lecture de PDF');
  assert.strictEqual(ctx.images.length, 1);
});
