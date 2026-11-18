// Test de bout en bout : du devis au client installé, avec de vrais PDF et des e-mails en mode « outbox ».
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { computeQuoteTotals, computeDepositInvoice, computeBalanceInvoice } from '../src/money.js';

let ctx, server, base, cookie;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fre2g-test-'));

async function call(method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data, res };
}

function outbox() {
  const dir = path.join(dataDir, 'outbox');
  return fs.readdirSync(dir).sort().map((f) => ({ file: f, raw: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

function decodedSubject(raw) {
  const m = raw.match(/^Subject: (.+(?:\n\s+.+)*)/m);
  if (!m) return '';
  return m[1].replace(/\n\s+/g, ' ').replace(/\?=\s+=\?/g, '?==?').replace(/=\?UTF-8\?([QB])\?([^?]*)\?=/gi, (_, enc, txt) =>
    enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64').toString('utf8')
      : Buffer.from(txt.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (__, hx) => String.fromCharCode(parseInt(hx, 16))), 'latin1').toString('utf8'));
}

// Petite image PNG valide servant de signature
const SIGNATURE = 'data:image/png;base64,' + Buffer.alloc(900, 'a').toString('base64');

before(async () => {
  ctx = createApp({ dataDir, adminPassword: 'secret-test', sessionSecret: 'x', mailMode: 'outbox', mailNotify: 'bureau@fre2g.test', aiEnabled: false, port: 0 });
  await new Promise((r) => { server = ctx.app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  ctx.config.baseUrl = base;
});

after(async () => {
  server.close();
  await ctx.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('les montants du devis 261182 (Alternative Finance) tombent juste', () => {
  const totals = computeQuoteTotals([
    { qty: 1, unit_price: 4215.83, vat_rate: 20 }, { qty: 1, unit_price: 2332.5, vat_rate: 20 },
    { qty: 1, unit_price: 762.5, vat_rate: 20 }, { qty: 1, unit_price: 715, vat_rate: 20 },
    { qty: 3, unit_price: 500, vat_rate: 20 }, { qty: 1, unit_price: 150, vat_rate: 20 },
    { qty: 1, unit_price: 180, vat_rate: 20 }, { qty: 2.5, unit_price: 900, vat_rate: 20 },
    { qty: 2, unit_price: 7.67, vat_rate: 20 }
  ]);
  assert.equal(totals.ht, 12121.17);
  assert.equal(totals.total_vat, 2424.23);
  assert.equal(totals.ttc, 14545.4);
  const dep = computeDepositInvoice(totals, 50);
  assert.equal(dep.ttc, 7272.7);
  assert.equal(dep.ht + dep.total_vat, 7272.7);
  const bal = computeBalanceInvoice(totals, [{ number: 'FA-1', date: '2026-01-01', total_ttc: dep.ttc, total_ht: dep.ht, total_vat: dep.total_vat, details: dep }]);
  assert.equal(bal.amount_due, 7272.7);
});

test('acompte avec deux taux de TVA : la somme tombe au centime', () => {
  const totals = computeQuoteTotals([{ qty: 1, unit_price: 1000, vat_rate: 20 }, { qty: 1, unit_price: 333.33, vat_rate: 10 }]);
  const dep = computeDepositInvoice(totals, 30);
  assert.equal(dep.ttc, Math.round(totals.ttc * 30) / 100);
});

test('le circuit complet : devis → signature → client → fournisseur → acompte → travaux → solde → client installé', async () => {
  // Connexion
  assert.equal((await call('GET', '/api/quotes')).status, 401);
  assert.equal((await call('POST', '/api/login', { password: 'mauvais' })).status, 401);
  const login = await call('POST', '/api/login', { password: 'secret-test' });
  assert.equal(login.status, 200);
  cookie = login.res.headers.get('set-cookie').split(';')[0];

  // Paramètres de l'entreprise
  await call('PUT', '/api/settings', { company_siret: '123 456 789 00012', bank_iban: 'FR76 0000 0000 0000 0000 0000 000', company_email: 'contact@fre2g.test', company_phone: '01 00 00 00 00' });

  // Fournisseur
  const sup = (await call('POST', '/api/suppliers', { name: 'Clim Distribution', email: 'commandes@climdistri.test', contact: 'Paul', account_number: 'C-778' })).data;
  assert.ok(sup.id);

  // Devis
  const created = await call('POST', '/api/quotes', {
    prospect: { kind: 'professionnel', civility: 'Mme', last_name: 'Bellaiche', company: 'Alternative Finance', email: 'mme.bellaiche@altfinance.test', address: '1, boulevard du Montparnasse', postal_code: '75006', city: 'Paris' },
    object: 'Fourniture et pose de climatisations réversibles Daikin Stylish',
    site_address: '1, boulevard du Montparnasse, 75006 Paris',
    letter: { greeting: 'Madame,', body: 'Suite à votre demande, nous avons le plaisir de vous adresser notre proposition.\n\nL\'installation est prévue sur 2,5 jours de main d\'œuvre.' },
    materiel: { items: [
      { qty: 1, reference: 'Daikin RXA50B', designation: 'Groupe extérieur monosplit Stylish', caracteristiques: '5 kW · R32', supplier_id: sup.id, purchase_price: 1500 },
      { qty: 1, reference: 'Daikin FTXA50CW', designation: 'Unité murale Stylish blanche', caracteristiques: '5,0 kW froid · 5,8 kW chaud', supplier_id: sup.id },
      { qty: 2, reference: 'Support mural', designation: 'Console murale', caracteristiques: '' }
    ] },
    travaux: { phases: [{ title: 'Grand bureau', steps: ['Pose de l\'unité murale', 'Pose du groupe extérieur'] }, { title: 'Mise en service', steps: ['Test d\'étanchéité à l\'azote et tirage au vide'] }] },
    lines: [
      { designation: 'Ensemble monosplit Daikin Stylish FTXA50CW + RXA50B', qty: 1, unit_price: 4215.83, vat_rate: 20 },
      { designation: 'Main d\'œuvre (jours)', qty: 2.5, unit_price: 900, vat_rate: 20 }
    ],
    deposit_pct: 50
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const q = created.data;
  assert.equal(q.number, '261185');
  assert.equal(q.status, 'brouillon');
  assert.equal(q.client_id, null, 'pas de fiche client tant que le devis n\'est pas signé');
  assert.equal((await call('GET', '/api/clients')).data.length, 0);

  // Aperçu PDF
  const preview = await call('GET', `/api/quotes/${q.id}/preview.pdf`);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.subarray(0, 4).toString(), '%PDF');

  // Le client accepte → envoi pour signature
  const sent = await call('POST', `/api/quotes/${q.id}/send-for-signature`);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(sent.data.status, 'attente_signature');
  assert.equal((await call('PUT', `/api/quotes/${q.id}`, { object: 'x' })).status, 409, 'un devis envoyé est figé');
  const signUrl = sent.data.sign_url;
  assert.ok(signUrl.startsWith(base + '/signer/'));
  const token = signUrl.split('/signer/')[1];
  let mails = outbox();
  assert.equal(mails.length, 1);
  assert.match(decodedSubject(mails[0].raw), /devis FRE2G N° 261185 à signer/);
  assert.ok(mails[0].raw.includes('mme.bellaiche@altfinance.test'));
  assert.ok(mails[0].raw.includes('Devis-261185.pdf'));

  // Page de signature publique
  cookie = null;
  const page = await call('GET', `/signer/${token}`);
  assert.equal(page.status, 200);
  assert.ok(page.data.toString().includes('Devis N° 261185'));
  assert.equal((await call('GET', `/signer/${token}/devis.pdf`)).data.subarray(0, 4).toString(), '%PDF');
  assert.equal((await call('GET', '/signer/faux-lien')).status, 404);

  // Signature sans code → refusée ; avec mauvais code → refusée
  const noCode = await call('POST', `/signer/${token}/sign`, { name: 'Sarah Bellaiche', mention: 'Bon pour accord', accept: true, signature: SIGNATURE });
  assert.equal(noCode.status, 400);
  assert.equal((await call('POST', `/signer/${token}/code`)).status, 200);
  mails = outbox();
  const codeMail = mails.find((m) => decodedSubject(m.raw).startsWith('Votre code de signature'));
  const code = decodedSubject(codeMail.raw).match(/(\d{6})/)[1];
  assert.equal((await call('POST', `/signer/${token}/sign`, { name: 'Sarah Bellaiche', mention: 'Bon pour accord', accept: true, signature: SIGNATURE, code: '000000' === code ? '111111' : '000000' })).status, 400);
  assert.equal((await call('POST', `/signer/${token}/sign`, { name: 'Sarah Bellaiche', mention: 'Bon pour', accept: true, signature: SIGNATURE, code })).status, 400, 'mention obligatoire');

  // Signature valide → toute la chaîne automatique
  const signed = await call('POST', `/signer/${token}/sign`, { name: 'Sarah Bellaiche', quality: 'Gérante', mention: 'bon pour accord', accept: true, signature: SIGNATURE, code }, { 'User-Agent': 'TestBrowser/1.0' });
  assert.equal(signed.status, 200, JSON.stringify(signed.data));
  assert.equal((await call('POST', `/signer/${token}/sign`, { name: 'X', mention: 'Bon pour accord', accept: true, signature: SIGNATURE, code })).status, 410, 'une seule signature');
  const signedPage = await call('GET', `/signer/${token}`);
  assert.ok(signedPage.data.toString().includes('votre devis est signé'));
  const signedPdf = await call('GET', `/signer/${token}/signe.pdf`);
  assert.equal(signedPdf.data.subarray(0, 4).toString(), '%PDF');

  cookie = (await call('POST', '/api/login', { password: 'secret-test' })).res.headers.get('set-cookie').split(';')[0];
  let d = (await call('GET', `/api/quotes/${q.id}`)).data;
  assert.equal(d.status, 'acompte_attendu', JSON.stringify(d.automation));
  for (const stepName of ['signed_pdf', 'client', 'signed_copy', 'supplier_orders', 'deposit_invoice', 'notify_signed']) {
    assert.equal(d.automation[stepName]?.done, true, `étape ${stepName} : ${JSON.stringify(d.automation[stepName])}`);
  }
  // Fiche client créée à la signature
  assert.ok(d.client_id);
  assert.equal(d.client.code, 'CL0001');
  assert.equal(d.client.status, 'en_cours');
  assert.ok(d.signed_sha256 && d.original_sha256 && d.signed_sha256 !== d.original_sha256);
  assert.equal(d.signature.ip.length > 0, true);
  assert.equal(d.signature.otp_verified, true);
  // Commande fournisseur : un seul fournisseur, l'article sans fournisseur est signalé
  assert.equal(d.supplier_orders.length, 1);
  assert.equal(d.supplier_orders[0].items.length, 2);
  assert.ok(d.supplier_orders[0].sent_at);
  assert.ok(d.events.some((e) => e.level === 'warning' && e.message.includes('Support mural')));
  // Facture d'acompte
  assert.equal(d.invoices.length, 1);
  const dep = d.invoices[0];
  assert.equal(dep.kind, 'acompte');
  assert.match(dep.number, /^FA-\d{4}-0001$/);
  assert.equal(dep.amount_due, Math.round(d.totals.ttc * 50) / 100);
  assert.equal(dep.due_date > dep.date, true, 'client professionnel : paiement à 30 jours');

  mails = outbox();
  const subjects = mails.map((m) => decodedSubject(m.raw));
  const supplierMail = mails.find((m) => decodedSubject(m.raw).startsWith('Commande FRE2G'));
  assert.ok(supplierMail, subjects.join(' | '));
  assert.ok(supplierMail.raw.includes('commandes@climdistri.test'));
  assert.ok(!supplierMail.raw.includes('4215') && !supplierMail.raw.includes('4 215'), 'le prix de vente ne part pas chez le fournisseur');
  assert.ok(subjects.some((s) => s.startsWith('Devis N° 261185 signé')));
  assert.ok(subjects.some((s) => s.startsWith("Facture d'acompte FA-")));
  assert.ok(subjects.some((s) => s.includes('Devis 261185 signé par')));

  // Rien ne démarre avant l'acompte
  assert.equal((await call('POST', `/api/quotes/${q.id}/installation-done`)).status, 409);

  // Acompte encaissé → travaux
  d = (await call('POST', `/api/quotes/${q.id}/deposit-paid`, { date: '2026-11-20', method: 'virement', reference: 'VIR 123' })).data;
  assert.equal(d.status, 'travaux');
  assert.equal(d.invoices[0].status, 'payee');
  assert.ok(outbox().some((m) => decodedSubject(m.raw).startsWith('Acompte reçu')));

  // Installation terminée → facture de solde + client installé
  d = (await call('POST', `/api/quotes/${q.id}/installation-done`, { date: '2026-11-27' })).data;
  assert.equal(d.status, 'solde_attendu', JSON.stringify(d.automation));
  const bal = d.invoices.find((i) => i.kind === 'solde');
  assert.match(bal.number, /^FA-2026-0002$/);
  assert.equal(Math.round((bal.amount_due + dep.amount_due) * 100) / 100, d.totals.ttc);
  assert.ok(outbox().some((m) => decodedSubject(m.raw).startsWith('Facture de solde FA-2026-0002')));
  const installed = (await call('GET', '/api/clients?status=installe')).data;
  assert.equal(installed.length, 1);
  assert.equal(installed[0].code, 'CL0001');
  assert.equal((await call('GET', '/api/clients?status=en_cours')).data.length, 0);
  const invPdf = await call('GET', `/api/invoices/${bal.id}/pdf`);
  assert.equal(invPdf.data.subarray(0, 4).toString(), '%PDF');

  // Solde encaissé → dossier soldé
  d = (await call('POST', `/api/quotes/${q.id}/balance-paid`, { date: '2026-12-01' })).data;
  assert.equal(d.status, 'solde');
});

test('un fournisseur sans e-mail bloque l\'étape, qui se relance après correction', async () => {
  const sup = (await call('POST', '/api/suppliers', { name: 'Grossiste sans mail' })).data;
  const q = (await call('POST', '/api/quotes', {
    prospect: { kind: 'particulier', civility: 'M.', first_name: 'Alexis', last_name: 'Mariage', email: 'alexis@test.test', address: '3 rue Test', postal_code: '93300', city: 'Aubervilliers' },
    materiel: { items: [{ qty: 1, reference: 'Airwell HDLW', designation: 'Unité murale', supplier_id: sup.id }] },
    lines: [{ designation: 'Fourniture et pose', qty: 1, unit_price: 2000, vat_rate: 10 }]
  })).data;
  assert.equal(q.number, '261186');
  const token = (await call('POST', `/api/quotes/${q.id}/send-for-signature`)).data.sign_url.split('/signer/')[1];
  await call('POST', `/signer/${token}/code`);
  const codeMail = outbox().reverse().find((m) => decodedSubject(m.raw).startsWith('Votre code de signature') && m.raw.includes('alexis@test.test'));
  const code = decodedSubject(codeMail.raw).match(/(\d{6})/)[1];
  const r = await call('POST', `/signer/${token}/sign`, { name: 'Alexis Mariage', mention: 'Bon pour accord', accept: true, signature: SIGNATURE, code });
  assert.equal(r.status, 200);
  let d = (await call('GET', `/api/quotes/${q.id}`)).data;
  assert.equal(d.status, 'acompte_attendu', "l'acompte est attendu même si une commande fournisseur reste à relancer");
  assert.equal(d.automation.supplier_orders.done, false);
  assert.match(d.automation.supplier_orders.error, /pas d'adresse e-mail/);
  assert.equal(d.automation.deposit_invoice.done, true, "la facture d'acompte part quand même");
  // Particulier : payable à réception
  assert.equal(d.invoices[0].due_date, d.invoices[0].date);
  // Correction puis relance
  await call('PUT', `/api/suppliers/${sup.id}`, { name: 'Grossiste sans mail', email: 'ventes@grossiste.test' });
  d = (await call('POST', `/api/quotes/${q.id}/retry`)).data;
  assert.equal(d.automation.supplier_orders.done, true);
  assert.equal(d.status, 'acompte_attendu');
});

test('un devis incomplet ne part pas', async () => {
  const q = (await call('POST', '/api/quotes', { prospect: { last_name: 'Sans mail' }, lines: [{ designation: 'Poste', qty: 1, unit_price: 0 }] })).data;
  const r = await call('POST', `/api/quotes/${q.id}/send-for-signature`);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /adresse e-mail du client/);
  assert.match(r.data.error, /prix sur chaque ligne/);
});
