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
  beta: { messages: {
    create: async (params) => { lastRequest = { apiKey, params }; return nextReply; },
    stream: (params) => ({ finalMessage: async () => { lastRequest = { apiKey, params }; return nextReply; } })
  } }
});

before(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const db = openDatabase(':memory:');
  server = createApp(db, { ai: { createClient: fakeClient }, auth: false }).listen(0);
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

test('reproduit un modèle à partir d\'une image', async () => {
  nextReply = { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({
    name: 'Modèle Dupont', notes: '',
    html: '<div class="doc" onclick="alert(1)"><h1>{{upper doc.type_label}} {{doc.number}}</h1><script>alert(1)</script>{{#each lines}}{{#if isItem}}<p>{{designation}} {{money total_ht}}</p>{{/if}}{{/each}}<b>{{money totals.ttc}}</b></div>',
    css: '<style>.doc h1 { color: #c0392b; }</style>'
  }) }] };
  const bad = await call('/ai/template', 'POST', { image: { media_type: 'application/pdf', data: 'x' } });
  assert.strictEqual(bad.status, 400);
  const r = await call('/ai/template', 'POST', { image: { media_type: 'image/jpeg', data: 'AAAA' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(lastRequest.params.messages[0].content[0].type, 'image');
  assert.match(lastRequest.params.messages[0].content[1].text, /\{\{#each lines\}\}/, 'le modèle d\'exemple est fourni');
  assert.doesNotMatch(r.body.html, /<script|onclick/, 'scripts et attributs on* retirés');
  assert.doesNotMatch(r.body.css, /<style/);
  const saved = (await call('/templates', 'POST', { name: r.body.name, html: r.body.html, css: r.body.css })).body;
  const invalid = await call('/templates', 'POST', { name: 'x', html: '{{#if x}}', css: '' });
  assert.strictEqual(invalid.status, 400);
  assert.ok(saved.id);
  nextReply = { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ name: 'x', notes: '', html: '{{#if}}', css: '' }) }] };
  assert.strictEqual((await call('/ai/template', 'POST', { image: { media_type: 'image/png', data: 'AAAA' } })).status, 502);
});

test('papier à en-tête : image de fond non échappée à l\'impression', async () => {
  const bg = 'data:image/jpeg;base64,/9j/AA+b==';
  const tpl = (await call('/templates', 'POST', { name: 'En-tête', html: '<div class="doc">{{doc.number}}</div>', css: '.doc { background: url({{{template.background}}}); }', background: bg })).body;
  assert.strictEqual(tpl.background, bg);
  const doc = (await call('/documents', 'POST', { type: 'devis', template_id: tpl.id, lines: [] })).body;
  const html = await (await fetch(`${base}/documents/${doc.id}/print`)).text();
  assert.ok(html.includes(`url(${bg})`), 'l\'URL data: est intacte');
  const list = (await call('/templates')).body;
  assert.strictEqual(list.find((t) => t.id === tpl.id).has_background, 1);
  const cleared = (await call(`/templates/${tpl.id}`, 'PUT', { background: '' })).body;
  assert.strictEqual(cleared.background, null);
});

test('chat : Claude utilise les outils puis répond', async () => {
  const items = (await call('/items?limit=100')).body;
  const mo = items.find((i) => i.reference === 'MO-01');
  const replies = [
    { stop_reason: 'tool_use', content: [
      { type: 'text', text: 'Je regarde.' },
      { type: 'tool_use', id: 't1', name: 'rechercher_catalogue', input: { recherche: 'MO-01' } },
      { type: 'tool_use', id: 't2', name: 'lire_document', input: { id: 999999 } }
    ] },
    { stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 't3', name: 'creer_devis', input: { client_id: 1, objet: 'Pose carrelage', lignes: [{ type_ligne: 'item', item_id: mo.id, designation: mo.designation, quantite: 10, unite: 'h', prix_unitaire_ht: mo.sale_price, tva: 20 }] } }
    ] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Voici le devis [DEV](document.html?id=1).' }] }
  ];
  const seen = [];
  const scripted = () => ({ beta: { messages: { create: async (params) => { seen.push(JSON.parse(JSON.stringify(params))); return replies.shift(); } } } });
  const db = openDatabase(':memory:');
  const srv = createApp(db, { ai: { createClient: scripted }, auth: false }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}/api`;
  try {
    await fetch(url + '/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ anthropic_api_key: 'sk-ant-x' }) });
    const res = await fetch(url + '/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'assistant', content: 'Bonjour' }, { role: 'user', content: 'Fais un devis de pose' }], context: { page: 'clients.html', id: 1 } }) });
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.match(body.reply, /Voici le devis/);
    assert.strictEqual(body.created.length, 1);
    assert.match(body.created[0].number, /^DEV-/);
    assert.strictEqual(seen.length, 3);
    assert.strictEqual(seen[0].messages[0].role, 'user', 'l\'historique commence par un message utilisateur');
    assert.match(seen[0].messages.at(-1).content, /fiche du client id 1/, 'le contexte de la page est transmis');
    assert.ok(seen[0].tools.some((t) => t.name === 'creer_devis'));
    const round1 = seen[1].messages.at(-1).content;
    assert.strictEqual(round1.length, 2, 'tous les résultats dans un seul message');
    assert.match(round1[0].content, /MO-01/);
    assert.strictEqual(round1[1].is_error, true, 'document introuvable signalé comme erreur');
    const docs = await (await fetch(url + '/documents?type=devis')).json();
    assert.strictEqual(docs.length, 1);
    assert.strictEqual(docs[0].total_ht, mo.sale_price * 10);
    assert.strictEqual(docs[0].status, 'brouillon');
  } finally {
    srv.close();
  }
});

test('chat : pièces jointes et ajout d\'articles au catalogue', async () => {
  const replies = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a1', name: 'ajouter_articles', input: { catalogue: 'Tarif Leroy 2026', articles: [
      { reference: 'LR-10', designation: 'Colle carrelage 25 kg', type: 'fourniture', unite: 'u', prix_achat_ht: 18.9, prix_vente_ht: 27.5, tva: 20 },
      { reference: 'MO-01', designation: "Main d'œuvre ouvrier qualifié", prix_vente_ht: 48 }
    ] } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Catalogue mis à jour.' }] }
  ];
  const seen = [];
  const scripted = () => ({ beta: { messages: { create: async (params) => { seen.push(JSON.parse(JSON.stringify(params))); return replies.shift(); } } } });
  const db = openDatabase(':memory:');
  const srv = createApp(db, { ai: { createClient: scripted }, auth: false }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}/api`;
  const post = (path, body) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    await fetch(url + '/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ anthropic_api_key: 'sk-ant-x' }) });
    const bad = await post('/ai/chat', { messages: [{ role: 'user', content: 'x' }], attachments: [{ kind: 'exe', name: 'virus.exe', data: 'AA' }] });
    assert.strictEqual(bad.status, 400);
    const res = await post('/ai/chat', {
      messages: [{ role: 'user', content: 'Ancien message\n[Pièces jointes : plan.jpg]' }, { role: 'assistant', content: 'OK' }, { role: 'user', content: 'Ajoute ce tarif' }],
      attachments: [
        { kind: 'image', name: 'photo.jpg', media_type: 'image/jpeg', data: 'AAAA' },
        { kind: 'pdf', name: 'tarif.pdf', media_type: 'application/pdf', data: 'JVBERi0=' },
        { kind: 'text', name: 'prix.csv', text: 'ref;prix\nLR-10;27,5' }
      ]
    });
    const body = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(body));
    const last = seen[0].messages.at(-1).content;
    assert.deepStrictEqual(last.map((b) => b.type), ['image', 'text', 'document', 'text', 'text']);
    assert.strictEqual(last[2].source.media_type, 'application/pdf');
    assert.strictEqual(last[2].title, 'tarif.pdf');
    assert.match(last[3].text, /LR-10;27,5/);
    assert.match(last[4].text, /Ajoute ce tarif/);
    assert.strictEqual(typeof seen[0].messages[0].content, 'string', 'les anciens messages restent du texte');
    // L'IA ne fait que proposer l'import : rien n'est enregistré sans la confirmation de l'utilisateur
    const result = JSON.parse(seen[1].messages.at(-1).content[0].content);
    assert.strictEqual(result.en_attente_de_confirmation, true);
    assert.strictEqual(result._import, undefined, "la liste n'est pas renvoyée à l'IA");
    const before = await (await fetch(url + '/items?limit=100')).json();
    assert.strictEqual(before.find((i) => i.reference === 'LR-10'), undefined, 'aucun article créé avant confirmation');
    assert.strictEqual(before.find((i) => i.reference === 'MO-01').sale_price !== 48, true, 'prix existant inchangé');
    assert.strictEqual(body.imports.length, 1);
    assert.strictEqual(body.imports[0].catalog, 'Tarif Leroy 2026');
    // Clic sur « Importer dans le catalogue »
    const done = await (await post('/items/import', { rows: body.imports[0].rows, catalog: body.imports[0].catalog })).json();
    assert.deepStrictEqual([done.created, done.updated], [1, 1]);
    const items = await (await fetch(url + '/items?limit=100')).json();
    assert.strictEqual(items.find((i) => i.reference === 'LR-10').catalog, 'Tarif Leroy 2026');
    assert.strictEqual(items.find((i) => i.reference === 'MO-01').sale_price, 48);
  } finally {
    srv.close();
  }
});

test('import au catalogue : lecture d\'un tarif PDF par l\'IA, sans rien enregistrer', async () => {
  let request;
  const reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({
    articles: [
      { reference: 'LR-10', designation: 'Colle carrelage 25 kg', description: 'Sac', type: 'fourniture', unite: 'u', prix_achat_ht: 18.9, prix_vente_ht: null, tva: 20, categorie: 'Colles' },
      { reference: '', designation: 'Livraison', description: '', type: 'prestation', unite: 'forfait', prix_achat_ht: null, prix_vente_ht: 45, tva: null, categorie: '' },
      { reference: 'X', designation: '   ', description: '', type: 'fourniture', unite: 'u', prix_achat_ht: 1, prix_vente_ht: 2, tva: 20, categorie: '' }
    ],
    remarques: 'Page 3 illisible.'
  }) }] };
  const fake = () => ({ beta: { messages: { stream: (params) => ({ finalMessage: async () => { request = params; return reply; } }) } } });
  const db = openDatabase(':memory:');
  const srv = createApp(db, { ai: { createClient: fake }, auth: false }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}/api`;
  const post = (path, body) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.strictEqual((await post('/ai/catalog-extract', { file: { kind: 'pdf', data: 'JVBERi0=' } })).status, 503, 'clé API requise');
    await fetch(url + '/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ anthropic_api_key: 'sk-ant-x', default_margin_coef: '1.5' }) });
    assert.strictEqual((await post('/ai/catalog-extract', { file: { kind: 'exe', data: 'AA' } })).status, 400);
    const before = (await (await fetch(url + '/items?limit=1000')).json()).length;
    const res = await post('/ai/catalog-extract', { file: { kind: 'pdf', data: 'JVBERi0=' } });
    const body = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(body));
    assert.strictEqual(request.messages[0].content[0].type, 'document');
    assert.strictEqual(request.output_config.format.schema, require('../public/js/ai').CATALOG_SCHEMA);
    assert.strictEqual(body.rows.length, 2, 'ligne sans libellé ignorée');
    assert.deepStrictEqual(body.rows[0], { reference: 'LR-10', designation: 'Colle carrelage 25 kg', description: 'Sac', type: 'fourniture', unit: 'u',
      purchase_price: '18.9', sale_price: '28.35', vat_rate: '20', category: 'Colles' });
    assert.strictEqual(body.rows[1].sale_price, '45');
    assert.strictEqual(body.notes, 'Page 3 illisible.');
    assert.strictEqual((await (await fetch(url + '/items?limit=1000')).json()).length, before, 'aucun article enregistré par la lecture');
    // Photo d'un tarif
    const img = await post('/ai/catalog-extract', { file: { kind: 'image', media_type: 'image/jpeg', data: 'AAAA' } });
    assert.strictEqual(img.status, 200);
    assert.strictEqual(request.messages[0].content[0].type, 'image');
  } finally {
    srv.close();
  }
});
