'use strict';

const path = require('path');
const express = require('express');
const { openDatabase } = require('./src/db');

function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  app.use('/api', require('./src/routes/catalog')(db));
  app.use('/api', require('./src/routes/documents')(db));
  app.use('/api', require('./src/routes/admin')(db));

  app.use('/vendor/alpine.js', (req, res) => res.sendFile(require.resolve('alpinejs/dist/cdn.min.js')));
  app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

  // Gestion des erreurs : message lisible en JSON pour l'interface
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
    if (status === 500) console.error(err);
    res.status(status).json({ error: err.message || 'Erreur interne' });
  });
  return app;
}

if (require.main === module) {
  const db = openDatabase();
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  createApp(db).listen(port, host, () => {
    console.log(`Logiciel de facturation démarré : http://localhost:${port}`);
  });
}

module.exports = { createApp };
