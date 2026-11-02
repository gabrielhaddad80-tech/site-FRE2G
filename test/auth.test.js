'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { openDatabase } = require('../src/db');
const { createApp } = require('../server');
const { resetPassword, hashPassword, verifyPassword } = require('../src/auth');

let server, base, app, db;
const PASSWORD = 'Chantier-2026!';

before(async () => {
  db = openDatabase(':memory:');
  app = createApp(db, { ai: { createClient: () => ({ beta: { messages: { create: async () => ({ stop_reason: 'tool_use', content: [
    { type: 'tool_use', id: 't', name: 'creer_devis', input: { objet: 'Test', lignes: [{ designation: 'Pose', quantite: 2, prix_unitaire_ht: 50 }] } }
  ] }) } } }) } });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// Petit client HTTP qui garde son cookie de session
function client() {
  let cookie = '';
  return async (path, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, setCookie: set, body: ct.includes('json') ? await res.json() : await res.text() };
  };
}

test('hachage des mots de passe', () => {
  const h = hashPassword('motdepasse-test');
  assert.match(h, /^scrypt\$/);
  assert.notStrictEqual(hashPassword('motdepasse-test'), h, 'sel aléatoire');
  assert.ok(verifyPassword('motdepasse-test', h));
  assert.ok(!verifyPassword('autre', h));
});

test('sans compte : tout est fermé, création protégée par le code', async () => {
  const anon = client();
  assert.strictEqual((await anon('/api/documents')).status, 401);
  const page = await anon('/index.html');
  assert.strictEqual(page.status, 302);
  assert.match(page.headers.get('location'), /^\/login\.html\?next=/);
  assert.strictEqual((await anon('/')).status, 302);
  assert.strictEqual((await anon('/js/common.js')).status, 401, 'le code de l\'application est protégé');
  assert.strictEqual((await anon('/login.html')).status, 200);
  assert.strictEqual((await anon('/css/app.css')).status, 200);
  assert.strictEqual((await anon('/api/auth/status')).body.setup_required, true);

  const wrong = await anon('/api/auth/setup', { method: 'POST', body: { email: 'pirate@x.fr', password: PASSWORD, code: '0000-0000' } });
  assert.strictEqual(wrong.status, 403);
  const code = app.locals.auth.setupCode;
  assert.match(code, /^\d{4}-\d{4}$/);
  const weak = await anon('/api/auth/setup', { method: 'POST', body: { email: 'gerant@fre2g.fr', password: 'court', code } });
  assert.strictEqual(weak.status, 400);
  const ok = await anon('/api/auth/setup', { method: 'POST', body: { name: 'Gérant', email: 'Gerant@FRE2G.fr', password: PASSWORD, code } });
  assert.strictEqual(ok.status, 201);
  assert.match(ok.setCookie, /HttpOnly/);
  assert.match(ok.setCookie, /SameSite=Lax/);
  assert.strictEqual(ok.body.user.email, 'gerant@fre2g.fr');
  assert.strictEqual((await anon('/api/documents')).status, 200, 'connecté après la création');
  assert.strictEqual(app.locals.auth.setupCode, null, 'code utilisable une seule fois');
  const again = await client()('/api/auth/setup', { method: 'POST', body: { email: 'b@x.fr', password: PASSWORD, code } });
  assert.strictEqual(again.status, 409);
});

test('connexion, déconnexion et mauvais mot de passe', async () => {
  const c = client();
  const bad = await c('/api/auth/login', { method: 'POST', body: { email: 'gerant@fre2g.fr', password: 'mauvais-mot-de-passe' } });
  assert.strictEqual(bad.status, 401);
  assert.strictEqual((await c('/api/auth/login', { method: 'POST', body: { email: 'inconnu@fre2g.fr', password: PASSWORD } })).status, 401);
  const ok = await c('/api/auth/login', { method: 'POST', body: { email: ' GERANT@fre2g.fr ', password: PASSWORD } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await c('/api/auth/me')).body.user.name, 'Gérant');
  assert.strictEqual((await c('/index.html')).status, 200);
  const stored = db.prepare('SELECT token_hash FROM sessions').all();
  assert.ok(stored.every((s) => /^[0-9a-f]{64}$/.test(s.token_hash)), 'seule l\'empreinte du jeton est stockée');
  await c('/api/auth/logout', { method: 'POST', body: {} });
  assert.strictEqual((await c('/api/documents')).status, 401);
});

test('protections : autre site et formulaire', async () => {
  const c = client();
  await c('/api/auth/login', { method: 'POST', body: { email: 'gerant@fre2g.fr', password: PASSWORD } });
  const cross = await c('/api/documents', { method: 'POST', body: { type: 'devis' }, headers: { Origin: 'https://site-pirate.example' } });
  assert.strictEqual(cross.status, 403);
  const form = await fetch(base + '/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'type=devis' });
  assert.strictEqual(form.status, 415);
  const same = await c('/api/documents', { method: 'POST', body: { type: 'devis', lines: [] }, headers: { Origin: base } });
  assert.strictEqual(same.status, 201);
  const r = await c('/index.html');
  assert.strictEqual(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.strictEqual(r.headers.get('x-powered-by'), null);
});

test('comptes : ajout, changement de mot de passe, suppression', async () => {
  const owner = client();
  await owner('/api/auth/login', { method: 'POST', body: { email: 'gerant@fre2g.fr', password: PASSWORD } });
  const other = client();
  await other('/api/auth/login', { method: 'POST', body: { email: 'gerant@fre2g.fr', password: PASSWORD } });

  assert.strictEqual((await owner('/api/auth/users', { method: 'POST', body: { email: 'pas-un-email', password: PASSWORD } })).status, 400);
  const added = await owner('/api/auth/users', { method: 'POST', body: { name: 'Secrétaire', email: 'compta@fre2g.fr', password: 'Compta-2026!' } });
  assert.strictEqual(added.status, 201);
  assert.strictEqual((await owner('/api/auth/users', { method: 'POST', body: { email: 'compta@fre2g.fr', password: 'Compta-2026!' } })).status, 409);
  const list = (await owner('/api/auth/users')).body;
  assert.deepStrictEqual(list.map((u) => u.email), ['gerant@fre2g.fr', 'compta@fre2g.fr']);
  assert.ok(list.every((u) => !('password_hash' in u)), 'jamais d\'empreinte de mot de passe dans les réponses');

  const compta = client();
  assert.strictEqual((await compta('/api/auth/login', { method: 'POST', body: { email: 'compta@fre2g.fr', password: 'Compta-2026!' } })).status, 200);
  assert.strictEqual((await owner(`/api/auth/users/${(await owner('/api/auth/me')).body.user.id}`, { method: 'DELETE' })).status, 400, 'pas de suppression de son propre compte');
  assert.strictEqual((await owner(`/api/auth/users/${added.body.id}`, { method: 'DELETE' })).status, 200);
  assert.strictEqual((await compta('/api/documents')).status, 401, 'les sessions du compte supprimé sont fermées');

  assert.strictEqual((await owner('/api/auth/password', { method: 'POST', body: { current: 'faux', password: 'Nouveau-2026!' } })).status, 403);
  assert.strictEqual((await owner('/api/auth/password', { method: 'POST', body: { current: PASSWORD, password: 'Nouveau-2026!' } })).status, 200);
  assert.strictEqual((await owner('/api/documents')).status, 200, 'la session courante reste ouverte');
  assert.strictEqual((await other('/api/documents')).status, 401, 'les autres sessions sont fermées');
  assert.strictEqual((await client()('/api/auth/login', { method: 'POST', body: { email: 'gerant@fre2g.fr', password: PASSWORD } })).status, 401);
  assert.strictEqual((await owner('/api/auth/password', { method: 'POST', body: { current: 'Nouveau-2026!', password: PASSWORD } })).status, 200);
});

test('le chat agit avec la session de la personne connectée', async () => {
  const c = client();
  await c('/api/auth/login', { method: 'POST', body: { email: 'gerant@fre2g.fr', password: PASSWORD } });
  await c('/api/settings', { method: 'PUT', body: { anthropic_api_key: 'sk-ant-x' } });
  const before = (await c('/api/documents?type=devis')).body.length;
  // Le faux Claude crée un devis à chaque tour : la boucle s'arrête au bout de 8 tours
  const r = await c('/api/ai/chat', { method: 'POST', body: { messages: [{ role: 'user', content: 'Crée un devis' }] } });
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.created.length > 0, 'les outils ont pu écrire avec la session transmise');
  assert.strictEqual((await c('/api/documents?type=devis')).body.length, before + r.body.created.length);
});

test('blocage après 10 tentatives incorrectes', async () => {
  const d = openDatabase(':memory:');
  resetPassword(d, 'gerant@fre2g.fr', PASSWORD);
  const a2 = createApp(d);
  assert.strictEqual(a2.locals.auth.setupCode, null, 'pas de code quand un compte existe');
  const s2 = a2.listen(0);
  await new Promise((r) => s2.once('listening', r));
  const url = `http://127.0.0.1:${s2.address().port}/api/auth/login`;
  const login = (password) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'gerant@fre2g.fr', password }) });
  try {
    let last;
    for (let i = 0; i < 10; i++) last = await login('essai-' + i);
    assert.strictEqual(last.status, 401);
    assert.strictEqual((await login(PASSWORD)).status, 429, 'même le bon mot de passe est refusé pendant le blocage');
  } finally {
    s2.close();
  }
});

test('réinitialisation du mot de passe en ligne de commande', () => {
  const d = openDatabase(':memory:');
  assert.strictEqual(resetPassword(d, 'nouveau@fre2g.fr', 'Mot-de-passe-1'), 'created');
  assert.strictEqual(resetPassword(d, 'nouveau@fre2g.fr', 'Mot-de-passe-2'), 'updated');
  assert.ok(verifyPassword('Mot-de-passe-2', d.prepare('SELECT password_hash FROM users').get().password_hash));
  assert.throws(() => resetPassword(d, 'nouveau@fre2g.fr', 'court'), /10 caractères/);
});
