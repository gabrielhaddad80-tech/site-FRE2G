'use strict';

const path = require('path');
const express = require('express');
const { openDatabase } = require('./src/db');
const { createAuth } = require('./src/auth');

/**
 * @param db base ouverte
 * @param options { ai, auth: false pour désactiver la connexion (tests uniquement) }
 */
function createApp(db, options = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Derrière un proxy HTTPS (Caddy, Nginx…) : TRUST_PROXY=1 pour des cookies « Secure » et la bonne adresse IP
  if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' });
    next();
  });
  app.use(express.json({ limit: '25mb' }));

  if (options.auth !== false) {
    const auth = createAuth(db);
    app.locals.auth = auth;
    app.use(auth.protect);
    app.use('/api', auth.router);
  }

  app.use('/api', require('./src/routes/catalog')(db));
  app.use('/api', require('./src/routes/documents')(db));
  app.use('/api', require('./src/routes/export')(db));
  app.use('/api', require('./src/routes/admin')(db));
  app.use('/api', require('./src/routes/knowledge')(db));
  app.use('/api', require('./src/routes/ai')(db, options.ai));

  app.use('/vendor/alpine.js', (req, res) => res.sendFile(require.resolve('alpinejs/dist/cdn.min.js')));
  app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

  // Gestion des erreurs : message lisible en JSON pour l'interface
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? 'Erreur interne du serveur.' : err.message });
  });
  return app;
}

if (require.main === module) {
  const db = openDatabase();
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  const app = createApp(db);
  app.listen(port, host, () => {
    console.log(`Logiciel de facturation démarré : http://localhost:${port}`);
    const code = app.locals.auth && app.locals.auth.setupCode;
    if (code) {
      console.log('');
      console.log('  Aucun compte n\'existe encore. Ouvrez le logiciel et créez le compte administrateur');
      console.log(`  avec ce code de première connexion : ${code}`);
      console.log('');
    }
  });
}

module.exports = { createApp };
