'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { openDatabase } = require('../src/db');
const { createApp } = require('../server');
const { computeTotals } = require('../public/js/calc');
const { formatNumber } = require('../src/numbering');

let server, base;

before(async () => {
  const db = openDatabase(':memory:');
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

async function call(path, method = 'GET', body) {
  const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
}

test('calcul des totaux : remise, TVA multi-taux, acompte', () => {
  const t = computeTotals([
    { kind: 'section', designation: 'Lot 1' },
    { kind: 'item', quantity: 2, unit_price: 100, vat_rate: 20, discount_pct: 10, purchase_price: 50 },
    { kind: 'text', designation: 'commentaire' },
    { kind: 'item', quantity: 3, unit_price: 10, vat_rate: 5.5 }
  ], { discount_pct: 5, deposit_pct: 30 });
  assert.strictEqual(t.ht_brut, 210);
  assert.strictEqual(t.discount_amount, 10.5);
  assert.strictEqual(t.ht, 199.5);
  assert.deepStrictEqual(t.vat.map((v) => [v.rate, v.base, v.amount]), [[20, 171, 34.2], [5.5, 28.5, 1.57]]);
  assert.strictEqual(t.ttc, 235.27);
  assert.strictEqual(t.deposit_amount, 70.58);
  assert.strictEqual(t.sections[0].total, 210);
  assert.strictEqual(t.cost, 100);
});

test('franchise de TVA : aucun montant de TVA', () => {
  const t = computeTotals([{ kind: 'item', quantity: 1, unit_price: 100, vat_rate: 20 }], { vat_exempt: true });
  assert.strictEqual(t.total_vat, 0);
  assert.strictEqual(t.ttc, 100);
});

test('format de numérotation', () => {
  assert.strictEqual(formatNumber('FAC-{AAAA}-{NUM:4}', '2026-03-05', 7), 'FAC-2026-0007');
  assert.strictEqual(formatNumber('F{AA}{MM}-{NUM}', '2026-03-05', 12), 'F2603-12');
});

test('cycle complet devis → facture → règlement → avoir', async () => {
  const client = (await call('/clients', 'POST', { company: 'ACME', city: 'Lyon' })).body;
  assert.match(client.code, /^CL\d{4}$/);

  const quote = await call('/documents', 'POST', {
    type: 'devis', client_id: client.id,
    lines: [{ kind: 'item', designation: 'Pose', quantity: 10, unit_price: 45, vat_rate: 10 }]
  });
  assert.strictEqual(quote.status, 201);
  assert.match(quote.body.number, /^DEV-\d{4}-0001$/);
  assert.strictEqual(quote.body.total_ttc, 495);

  const inv = (await call(`/documents/${quote.body.id}/convert`, 'POST', {})).body;
  assert.strictEqual(inv.type, 'facture');
  assert.strictEqual(inv.number, null, 'une facture brouillon n\'a pas de numéro');
  assert.strictEqual((await call(`/documents/${quote.body.id}`)).body.status, 'facture');

  const issued = (await call(`/documents/${inv.id}/issue`, 'POST', {})).body;
  assert.match(issued.number, /^FAC-\d{4}-0001$/);
  assert.strictEqual(issued.locked, true);

  const edit = await call(`/documents/${inv.id}`, 'PUT', { lines: [] });
  assert.strictEqual(edit.status, 409, 'une facture émise est verrouillée');
  assert.strictEqual((await call(`/documents/${inv.id}`, 'DELETE')).status, 409);

  let paid = (await call(`/documents/${inv.id}/payments`, 'POST', { amount: 200 })).body;
  assert.strictEqual(paid.status, 'partielle');
  paid = (await call(`/documents/${inv.id}/payments`, 'POST', { amount: 295 })).body;
  assert.strictEqual(paid.status, 'payee');
  assert.strictEqual(paid.totals.due, 0);

  const credit = (await call(`/documents/${inv.id}/credit`, 'POST', {})).body;
  const creditIssued = (await call(`/documents/${credit.id}/issue`, 'POST', {})).body;
  assert.match(creditIssued.number, /^AV-\d{4}-0001$/);
  assert.strictEqual((await call(`/documents/${inv.id}`)).body.status, 'annulee');

  const html = (await call(`/documents/${inv.id}/print`)).body;
  assert.match(html, /FACTURE/);
  assert.match(html, /ACME/);
  assert.match(html, /495,00/);
});

test('catalogue : ouvrage composé et import CSV', async () => {
  const items = (await call('/items?type=ouvrage')).body;
  assert.ok(items.length >= 1);
  const ouv = (await call(`/items/${items[0].id}`)).body;
  assert.ok(ouv.components.length > 0);
  const computed = (await call(`/items/${ouv.id}/computed-price`)).body;
  assert.strictEqual(computed.sale_price, ouv.sale_price);

  const imp = (await call('/items/import', 'POST', {
    catalog: 'Tarif test',
    rows: [
      { reference: 'T-1', designation: 'Tube', sale_price: '12,50', purchase_price: '8', category: 'Plomberie', type: 'fourniture' },
      { reference: 'T-2', designation: '', sale_price: '1' }
    ]
  })).body;
  assert.deepStrictEqual(imp, { created: 1, updated: 0, skipped: 1 });
  const again = (await call('/items/import', 'POST', { rows: [{ reference: 'T-1', designation: 'Tube', sale_price: '13' }] })).body;
  assert.strictEqual(again.updated, 1);
  const tube = (await call('/items?q=T-1')).body[0];
  assert.strictEqual(tube.sale_price, 13);

  await call('/items/reprice', 'POST', { percent: 10, catalog: 'Tarif test' });
  assert.strictEqual((await call(`/items/${tube.id}`)).body.sale_price, 14.3);
});

test('modèles : aperçu et refus d\'un modèle invalide', async () => {
  const tpls = (await call('/templates')).body;
  const bad = await call(`/templates/${tpls[0].id}`, 'PUT', { html: '{{#if x}}' });
  assert.strictEqual(bad.status, 400);
  const prev = await call('/templates/preview', 'POST', { html: '<b>{{doc.number}} {{client.display_name}}</b>', css: '' });
  assert.match(prev.body, /<b>.+<\/b>/);
});

test('page d\'accueil : compteurs et prochains numéros', async () => {
  const home = (await call('/home')).body;
  assert.ok(home.company.name);
  assert.ok(home.counts.items > 0);
  assert.match(home.next_numbers.devis, /^DEV-\d{4}-\d{4}$/);
  // Le prochain numéro affiché n'est pas consommé
  assert.strictEqual((await call('/home')).body.next_numbers.devis, home.next_numbers.devis);
  const q = (await call('/documents', 'POST', { type: 'devis', lines: [] })).body;
  assert.strictEqual(q.number, home.next_numbers.devis);
  assert.ok(Array.isArray(home.company_missing));
});

test('sauvegarde et restauration', async () => {
  const dump = (await call('/backup')).body;
  assert.strictEqual(dump.app, 'fre2g-facturation');
  const n = dump.tables.documents.length;
  assert.strictEqual((await call('/restore', 'POST', dump)).status, 200);
  assert.strictEqual((await call('/documents')).body.length, n);
});
