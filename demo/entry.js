'use strict';
// Serveur de facturation exécuté dans le navigateur : mêmes modules que la version installée.
const { openDatabase } = require('APP/src/db');
const catalogRoutes = require('APP/src/routes/catalog');
const documentRoutes = require('APP/src/routes/documents');
const adminRoutes = require('APP/src/routes/admin');
const knowledgeRoutes = require('APP/src/routes/knowledge');

let db = null;
let routers = [];

function init(bytes) {
  globalThis.__DEMO_DB_BYTES = bytes || null;
  db = openDatabase(':memory:');
  globalThis.__DEMO_DB_BYTES = null;
  routers = [catalogRoutes(db), documentRoutes(db), adminRoutes(db), knowledgeRoutes(db)];
}

function handle(method, url, body) {
  const u = new URL(url, 'http://demo.local');
  const path = u.pathname.replace(/^\/api/, '');
  const query = Object.fromEntries(u.searchParams.entries());
  const res = {
    statusCode: 200, contentType: 'application/json', body: '',
    status(c) { this.statusCode = c; return this; },
    json(o) { this.contentType = 'application/json'; this.body = JSON.stringify(o); return this; },
    send(s) { this.body = String(s); return this; },
    type(t) { this.contentType = t === 'html' ? 'text/html' : t; return this; },
    setHeader() { return this; }
  };
  const fail = (err) => {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: err.message || 'Erreur interne' });
  };
  for (const r of routers) {
    for (const route of r.routes) {
      if (route.method !== method) continue;
      const m = route.re.exec(path);
      if (!m) continue;
      const params = {};
      route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      try {
        route.handler({ params, query, body: body || {} }, res, (err) => { if (err) fail(err); });
      } catch (e) { fail(e); }
      return res;
    }
  }
  return res.status(404).json({ error: 'Route inconnue : ' + method + ' ' + path });
}

function exportDb() {
  const bytes = db._db.export();
  db._db.run('PRAGMA foreign_keys = ON'); // export() rouvre la base et réinitialise les pragmas
  return bytes;
}

globalThis.DemoBackend = { init, handle, exportDb };
