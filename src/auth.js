'use strict';

/*
 * Connexion par mot de passe.
 * - Mots de passe hachés avec scrypt (sel aléatoire), comparaison en temps constant.
 * - Session : jeton aléatoire dans un cookie HttpOnly / SameSite=Lax (Secure en HTTPS) ; seule son empreinte
 *   SHA-256 est stockée en base. Validité 30 jours, prolongée à l'usage.
 * - Premier compte : protégé par un code à usage unique affiché dans la console du serveur
 *   (ou créé directement via INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD).
 * - Requêtes d'écriture : JSON obligatoire et même origine (protection contre les requêtes forgées depuis un autre site).
 * - Tentatives de connexion limitées par adresse IP.
 */

const crypto = require('crypto');
const express = require('express');

const COOKIE = 'fre2g_session';
const SESSION_DAYS = 30;
const MIN_PASSWORD = 10;
const MAX_FAILURES = 10;
const LOCK_MINUTES = 15;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  password_hash TEXT NOT NULL,
  created_at    TEXT DEFAULT (datetime('now')),
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password).normalize('NFKC'), salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [algo, salt, key] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = crypto.scryptSync(String(password).normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw httpError(400, `Le mot de passe doit contenir au moins ${MIN_PASSWORD} caractères.`);
  }
  if (password.length > 200) throw httpError(400, 'Mot de passe trop long.');
}

const DUMMY_HASH = hashPassword('compte-inexistant');

const publicUser = (u) => u && { id: u.id, email: u.email, name: u.name || '', created_at: u.created_at, last_login_at: u.last_login_at };

/**
 * Prépare l'authentification pour une base. Renvoie { router, protect, setupCode, userCount }.
 */
function createAuth(db) {
  db.exec(SCHEMA);
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();

  const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

  // Premier compte depuis l'environnement (installation automatisée)
  if (!userCount() && process.env.INITIAL_ADMIN_EMAIL && process.env.INITIAL_ADMIN_PASSWORD) {
    const email = process.env.INITIAL_ADMIN_EMAIL.trim().toLowerCase();
    checkPassword(process.env.INITIAL_ADMIN_PASSWORD);
    db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)').run(email, 'Administrateur', hashPassword(process.env.INITIAL_ADMIN_PASSWORD));
  }

  // Code de première connexion (à usage unique, valable tant qu'aucun compte n'existe)
  let setupCode = null;
  const newSetupCode = () => {
    const n = crypto.randomInt(0, 1e8).toString().padStart(8, '0');
    setupCode = `${n.slice(0, 4)}-${n.slice(4)}`;
    return setupCode;
  };
  if (!userCount()) newSetupCode();

  // Échecs par adresse IP et par compte (« ip:… », « mail:… ») : bloque aussi les essais venant de nombreuses adresses
  const failures = new Map(); // clé -> { count, until, last }
  const isLocked = (key) => {
    const f = failures.get(key);
    return !!(f && f.until && f.until > Date.now());
  };
  const fail = (key) => {
    const now = Date.now();
    if (failures.size > 10000) { // mémoire bornée : on oublie les entrées anciennes
      for (const [k, f] of failures) if (f.until < now && now - f.last > LOCK_MINUTES * 60000) failures.delete(k);
    }
    const f = failures.get(key) || { count: 0, until: 0, last: 0 };
    if (now - f.last > LOCK_MINUTES * 60000) f.count = 0; // les erreurs anciennes ne comptent plus
    f.count += 1;
    f.last = now;
    if (f.count >= MAX_FAILURES) { f.until = now + LOCK_MINUTES * 60000; f.count = 0; }
    failures.set(key, f);
  };

  function sessionUser(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const row = db.prepare(`SELECT s.token_hash, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > datetime('now')`).get(sha256(token));
    if (!row) return null;
    // Prolonge la session au-delà d'un jour d'utilisation
    if (new Date(row.expires_at.replace(' ', 'T') + 'Z') - Date.now() < (SESSION_DAYS - 1) * 86400000) {
      db.prepare(`UPDATE sessions SET expires_at = datetime('now', '+${SESSION_DAYS} days') WHERE token_hash = ?`).run(row.token_hash);
      req._renewCookie = token;
    }
    req.sessionHash = row.token_hash;
    return row;
  }

  function setCookie(req, res, token, maxAgeSeconds) {
    const parts = [`${COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
    if (req.secure) parts.push('Secure');
    res.append('Set-Cookie', parts.join('; '));
  }

  function startSession(req, res, user) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'), ?)`)
      .run(sha256(token), user.id, String(req.headers['user-agent'] || '').slice(0, 200));
    db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
    setCookie(req, res, token, SESSION_DAYS * 86400);
  }

  // Pages et ressources accessibles sans être connecté
  const PUBLIC = [/^\/login(\.html)?$/, /^\/css\//, /^\/fonts\//, /^\/favicon\.svg$/, /^\/api\/auth\/(status|login|setup|logout)$/];

  function protect(req, res, next) {
    // Écritures : JSON obligatoire et même origine (un formulaire d'un autre site ne peut pas l'imposer)
    if (req.path.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin) {
        let host = null;
        try { host = new URL(origin).host; } catch (e) { /* origine invalide */ }
        if (host !== req.headers.host) return res.status(403).json({ error: 'Requête refusée (origine différente).' });
      }
      const pdfUpload = req.path === '/api/ai/catalog-upload' && req.is('application/pdf'); // envoi d'un catalogue PDF
      if (req.method !== 'DELETE' && !req.is('application/json') && !pdfUpload) return res.status(415).json({ error: 'Format de requête non accepté.' });
    }
    if (PUBLIC.some((r) => r.test(req.path))) return next();
    const user = sessionUser(req);
    if (user) {
      req.user = user;
      if (req._renewCookie) setCookie(req, res, req._renewCookie, SESSION_DAYS * 86400);
      return next();
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Votre session a expiré : reconnectez-vous.', code: 'auth' });
    if (req.method === 'GET' && (req.path === '/' || /\.html$/.test(req.path) || !/\.[a-z0-9]+$/i.test(req.path))) {
      const nextUrl = req.originalUrl && req.originalUrl !== '/' ? '?next=' + encodeURIComponent(req.originalUrl) : '';
      return res.redirect(302, '/login.html' + nextUrl);
    }
    return res.status(401).type('text').send('Connexion requise');
  }

  const r = express.Router();

  r.get('/auth/status', (req, res) => {
    const user = sessionUser(req);
    res.json({ setup_required: userCount() === 0, user: publicUser(user) });
  });

  r.post('/auth/setup', (req, res) => {
    if (userCount() > 0) throw httpError(409, 'Le compte administrateur existe déjà : connectez-vous.');
    const ip = 'ip:' + req.ip;
    if (isLocked(ip) || isLocked('setup')) throw httpError(429, `Trop d'essais : réessayez dans ${LOCK_MINUTES} minutes.`);
    const { name, email, password, code } = req.body || {};
    if (!setupCode || !safeEqual(String(code || '').trim(), setupCode)) {
      fail(ip);
      fail('setup');
      throw httpError(403, 'Code de première connexion incorrect. Il est affiché dans la fenêtre du serveur au démarrage.');
    }
    const mail = String(email || '').trim().toLowerCase();
    if (!validEmail(mail)) throw httpError(400, 'Adresse e-mail invalide.');
    checkPassword(password);
    const id = db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)').run(mail, String(name || '').trim(), hashPassword(password)).lastInsertRowid;
    setupCode = null;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    startSession(req, res, user);
    res.status(201).json({ user: publicUser(user) });
  });

  r.post('/auth/login', (req, res) => {
    const ip = 'ip:' + req.ip;
    const mail = String((req.body && req.body.email) || '').trim().toLowerCase().slice(0, 200);
    const account = 'mail:' + mail;
    if (isLocked(ip) || isLocked(account)) throw httpError(429, `Trop de tentatives : réessayez dans ${LOCK_MINUTES} minutes.`);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(mail);
    // Vérification même si le compte n'existe pas (temps de réponse identique)
    const ok = verifyPassword(String((req.body && req.body.password) || '').slice(0, 200), user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) {
      fail(ip);
      fail(account);
      throw httpError(401, 'E-mail ou mot de passe incorrect.');
    }
    failures.delete(ip);
    failures.delete(account);
    startSession(req, res, user);
    res.json({ user: publicUser(user) });
  });

  r.post('/auth/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    setCookie(req, res, '', 0);
    res.json({ ok: true });
  });

  // ----- Routes réservées aux personnes connectées (protégées par `protect`) -----
  r.get('/auth/me', (req, res) => res.json({ user: publicUser(req.user) }));

  r.post('/auth/password', (req, res) => {
    const { current, password } = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const key = 'pw:' + user.id;
    if (isLocked(key)) throw httpError(429, `Trop d'essais : réessayez dans ${LOCK_MINUTES} minutes.`);
    if (!verifyPassword(String(current || '').slice(0, 200), user.password_hash)) {
      fail(key);
      throw httpError(403, 'Mot de passe actuel incorrect.');
    }
    checkPassword(password);
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(user.id, req.sessionHash);
    })();
    res.json({ ok: true });
  });

  r.post('/auth/sessions/revoke-others', (req, res) => {
    const n = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(req.user.id, req.sessionHash).changes;
    res.json({ revoked: n });
  });

  r.get('/auth/users', (req, res) => {
    res.json(db.prepare('SELECT * FROM users ORDER BY id').all().map(publicUser));
  });

  r.post('/auth/users', (req, res) => {
    const { name, email, password } = req.body || {};
    const mail = String(email || '').trim().toLowerCase();
    if (!validEmail(mail)) throw httpError(400, 'Adresse e-mail invalide.');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(mail)) throw httpError(409, 'Un compte existe déjà avec cette adresse.');
    checkPassword(password);
    const id = db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)').run(mail, String(name || '').trim(), hashPassword(password)).lastInsertRowid;
    res.status(201).json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
  });

  r.delete('/auth/users/:id', (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) throw httpError(400, 'Vous ne pouvez pas supprimer votre propre compte.');
    const info = db.prepare('DELETE FROM users WHERE id = ?').run(id);
    if (!info.changes) throw httpError(404, 'Utilisateur introuvable.');
    res.json({ ok: true });
  });

  return { router: r, protect, userCount, get setupCode() { return setupCode; } };
}

/** Réinitialise (ou crée) le mot de passe d'un compte — utilisé par scripts/reset-password.js. */
function resetPassword(db, email, password) {
  db.exec(SCHEMA);
  checkPassword(password);
  const mail = String(email).trim().toLowerCase();
  if (!validEmail(mail)) throw httpError(400, 'Adresse e-mail invalide.');
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(mail);
  if (user) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    return 'updated';
  }
  db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)').run(mail, 'Administrateur', hashPassword(password));
  return 'created';
}

module.exports = { createAuth, resetPassword, hashPassword, verifyPassword, MIN_PASSWORD };
