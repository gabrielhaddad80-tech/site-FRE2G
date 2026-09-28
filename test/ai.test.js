'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { openDatabase } = require('../src/db');
const { createApp } = require('../server');
const AiDraft = require('../public/js/ai');

let server, base, lastRequest, nextReply;
const saved = process.env.ANTHROPIC_API_KEY;

// Faux client Anthropic : enregistre la requête et renvoie une réponse préparée
const fakeClient = (apiKey) => ({
  beta: { messages: { create: async (params) => { lastRequest = { apiKey, params }; return nextReply; } } }
});

before(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const db = openDatabase(':memory:');
  server = createApp(db, { ai: { createClient: fakeClient } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => { server.close(); if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; });

async function call(path, method = 'GET', body) {
  const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

test('sans clé API, l\'assistant est désactivé', async () => {
  assert.strictEqual((await call('/ai/status')).body.available, false);
  const r = await call('/ai/draft', 'POST', { text: 'Pose de carrelage' });
  assert.strictEqual(r.status, 503);
  assert.match(r.body.error, /clé API/);
});

test('la clé API est enregistrée mais jamais renvoyée ni sauvegardée', async () => {
  const s = (await call('/settings', 'PUT', { anthropic_api_key: '  sk-ant-test  ' })).body;
  assert.strictEqual(s.anthropic_api_key, undefined);
  assert.strictEqual(s.ai_key_configured, true);
  assert.strictEqual((await call('/ai/status')).body.available, true);
  const dump = (await call('/backup')).body;
  assert.ok(!dump.tables.settings.some((r) => r.key === 'anthropic_api_key'));
  await call('/restore', 'POST', dump);
  assert.strictEqual((await call('/ai/status')).body.available, true, 'la restauration conserve la clé');
});

test('génère des lignes rapprochées du catalogue', async () => {
  const items = (await call('/items?limit=100')).body;
  const mo = items.find((i) => i.reference === 'MO-01');
  nextReply = {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify({
      title: 'Salle de bain', site_address: '12 rue des Lilas, Lyon', summary: 'Rénovation',
      lines: [
        { kind: 'section', item_id: 0, designation: 'Démolition', description: '', quantity: 0, unit: '', unit_price: 0, vat_rate: 0 },
        { kind: 'item', item_id: mo.id, designation: "Main d'œuvre", description: 'quantité estimée', quantity: 6, unit: 'h', unit_price: 999, vat_rate: 20 },
        { kind: 'item', item_id: 99999, designation: 'Receveur de douche', description: 'Prix estimé, à vérifier', quantity: 1, unit: 'u', unit_price: 320, vat_rate: 10 }
      ],
      questions: ['Dimensions exactes ?']
    }) }]
  };
  const r = await call('/ai/draft', 'POST', { text: 'Refaire la salle de bain', doc_type: 'devis', images: [{ media_type: 'image/jpeg', data: 'AAAA' }, { media_type: 'text/html', data: 'x' }] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(lastRequest.apiKey, 'sk-ant-test');
  assert.strictEqual(lastRequest.params.model, 'claude-opus-5-5');
  assert.strictEqual(lastRequest.params.output_config.format.type, 'json_schema');
  const content = lastRequest.params.messages[0].content;
  assert.strictEqual(content.filter((c) => c.type === 'image').length, 1, 'seules les images valides sont envoyées');
  assert.match(content.at(-1).text, /MO-01/, 'le catalogue est dans la demande');
  assert.strictEqual(r.body.title, 'Salle de bain');
  const [sec, fromCat, estimated] = r.body.lines;
  assert.strictEqual(sec.kind, 'section');
  assert.strictEqual(fromCat.from_catalog, true);
  assert.strictEqual(fromCat.unit_price, mo.sale_price, 'le prix du catalogue prime');
  assert.strictEqual(fromCat.reference, 'MO-01');
  assert.strictEqual(estimated.from_catalog, false);
  assert.strictEqual(estimated.item_id, null);
  assert.strictEqual(estimated.unit_price, 320);
  assert.deepStrictEqual(r.body.questions, ['Dimensions exactes ?']);
});

test('refus et demande vide', async () => {
  nextReply = { stop_reason: 'refusal', content: [] };
  assert.strictEqual((await call('/ai/draft', 'POST', { text: 'x' })).status, 422);
  assert.strictEqual((await call('/ai/draft', 'POST', { text: '  ' })).status, 400);
});

test('le texte de la demande reprend les règles et le format', () => {
  const p = AiDraft.buildPrompt({ text: 'Peinture 30 m²', imageCount: 2, docType: 'facture', catalog: [], vatExempt: true });
  assert.match(p, /une facture/);
  assert.match(p, /2 photo/);
  assert.match(p, /franchise de TVA/);
  assert.match(p, /Peinture 30 m²/);
});
