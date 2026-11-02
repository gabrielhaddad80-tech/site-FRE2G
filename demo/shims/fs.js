'use strict';
const FILES = globalThis.__DEMO_FILES || {};
module.exports = {
  mkdirSync() {},
  existsSync(p) { return p.split('/').pop() in FILES; },
  readFileSync(p) { const k = String(p).split('/').pop(); if (!(k in FILES)) throw new Error('Fichier absent : ' + k); return FILES[k]; }
};
