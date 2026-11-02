'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { openDatabase } = require('../src/db');
const { createApp } = require('../server');
const { DOC_CSP, TOOLBAR_SCRIPT } = require('../src/render');

async function start(options = {}) {
  const db = openDatabase(':memory:');
  const srv = createApp(db, options).listen(0);
  await new Promise((r) => srv.once('listening', r));
  return { db, srv, base: `http://127.0.0.1:${srv.address().port}` };
}
const json = (method, body, headers = {}) => ({ method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('en-têtes de sécurité et CSP sur les pages et l\'API', async () => {
  const { srv, base } = await start();
  try {
    for (const path of ['/login.html', '/api/auth/status']) {
      const res = await fetch(base + path);
      const csp = res.headers.get('content-security-policy');
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /connect-src 'self'/);
      assert.match(csp, /object-src 'none'/);
      assert.match(csp, /frame-ancestors 'self'/);
      assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
      assert.strictEqual(res.headers.get('cross-origin-opener-policy'), 'same-origin');
    }
  } finally { srv.close(); }
});

test('page de document : aucun script du modèle, seule la barre d\'outils est autorisée', async () => {
  const hash = crypto.createHash('sha256').update(TOOLBAR_SCRIPT).digest('base64');
  assert.ok(DOC_CSP.includes(`'sha256-${hash}'`), 'empreinte de la barre d\'outils à jour');
  assert.match(DOC_CSP, /default-src 'none'/);
  assert.doesNotMatch(DOC_CSP, /unsafe-inline'[^;]*script|script-src[^;]*unsafe/);

  const { db, srv, base } = await start({ auth: false });
  try {
    db.prepare("UPDATE templates SET html = html || '<script>alert(1)</script><img src=x onerror=alert(2)>'").run();
    const doc = await (await fetch(base + '/api/documents', json('POST', { type: 'devis', lines: [] }))).json();
    const res = await fetch(`${base}/api/documents/${doc.id}/print`);
    assert.strictEqual(res.headers.get('content-security-policy'), DOC_CSP);
    const html = await res.text();
    assert.ok(html.includes(`<script>${TOOLBAR_SCRIPT}</script>`));
    assert.doesNotMatch(html, /javascript:|onclick=/, 'pas de script en ligne dans la barre d\'outils');
    const prev = await fetch(base + '/api/templates/preview', json('POST', { html: '<script>alert(1)</script>' }));
    assert.strictEqual(prev.headers.get('content-security-policy'), DOC_CSP);
  } finally { srv.close(); }
});

test('avant connexion : gros envois refusés, aucune donnée lue', async () => {
  const { srv, base } = await start();
  try {
    const big = 'x'.repeat(100 * 1024);
    const login = await fetch(base + '/api/auth/login', json('POST', { email: big, password: big }));
    assert.strictEqual(login.status, 413);
    const write = await fetch(base + '/api/documents', json('POST', { type: 'devis', title: 'x'.repeat(5 * 1024 * 1024) }));
    assert.strictEqual(write.status, 401);
  } finally { srv.close(); }
});

test('connexion : blocage par compte même depuis des adresses IP différentes', async () => {
  process.env.TRUST_PROXY = '1';
  const db = openDatabase(':memory:');
  require('../src/auth').resetPassword(db, 'gerant@fre2g.fr', 'MotDePasse-Solide-1');
  const srv2 = createApp(db).listen(0);
  delete process.env.TRUST_PROXY;
  await new Promise((r) => srv2.once('listening', r));
  const base2 = `http://127.0.0.1:${srv2.address().port}`;
  const login = (password, ip) => fetch(base2 + '/api/auth/login', json('POST', { email: 'gerant@fre2g.fr', password }, { 'X-Forwarded-For': ip }));
  try {
    for (let i = 0; i < 10; i++) assert.strictEqual((await login('mauvais-mot-de-passe', `203.0.113.${i + 1}`)).status, 401);
    const locked = await login('MotDePasse-Solide-1', '198.51.100.7');
    assert.strictEqual(locked.status, 429, 'compte bloqué malgré une nouvelle adresse IP');
  } finally { srv2.close(); }
});

test('export CSV : les formules Excel sont neutralisées puis restaurées à l\'import', async () => {
  const { srv, base } = await start({ auth: false });
  try {
    await fetch(base + '/api/items/import', json('POST', { rows: [{ reference: 'XLS-9', designation: '=HYPERLINK("http://x","clic")', sale_price: -5 }] }));
    const csv = await (await fetch(base + '/api/items/export.csv')).text();
    const line = csv.split('\r\n').find((l) => l.includes('XLS-9'));
    assert.match(line, /;"'=HYPERLINK\(""http:\/\/x"",""clic""\)";/);
    assert.match(line, /;-5;/, 'les nombres négatifs restent des nombres');
    await fetch(base + '/api/items/import', json('POST', { rows: [{ reference: 'XLS-9', designation: "'=SOMME(A1)" }] }));
    const items = await (await fetch(base + '/api/items?q=XLS-9')).json();
    assert.strictEqual(items[0].designation, '=SOMME(A1)');
  } finally { srv.close(); }
});
