'use strict';

/*
 * Numérotation des documents.
 * Jetons disponibles dans le format : {AAAA} année, {AA} année sur 2 chiffres, {MM} mois,
 * {NUM} compteur, {NUM:4} compteur sur 4 chiffres.
 * Le compteur repart à 1 chaque année si le format contient {AAAA} ou {AA}, chaque mois s'il contient {MM}.
 */

const FORMAT_KEYS = { devis: 'quote_number_format', facture: 'invoice_number_format', avoir: 'credit_number_format' };

function scopeFor(format, date) {
  const y = date.slice(0, 4);
  const m = date.slice(5, 7);
  if (/\{MM\}/.test(format)) return `${y}-${m}`;
  if (/\{AAAA\}|\{AA\}/.test(format)) return y;
  return 'all';
}

function formatNumber(format, date, n) {
  return format
    .replace(/\{AAAA\}/g, date.slice(0, 4))
    .replace(/\{AA\}/g, date.slice(2, 4))
    .replace(/\{MM\}/g, date.slice(5, 7))
    .replace(/\{NUM(?::(\d+))?\}/g, (_, w) => String(n).padStart(w ? Number(w) : 1, '0'));
}

// À appeler dans une transaction.
function nextNumber(db, type, date) {
  const format = db.prepare('SELECT value FROM settings WHERE key = ?').get(FORMAT_KEYS[type])?.value || `${type.toUpperCase()}-{NUM:4}`;
  const scope = scopeFor(format, date);
  db.prepare('INSERT OR IGNORE INTO counters (type, scope, value) VALUES (?, ?, 0)').run(type, scope);
  // Saute les numéros déjà utilisés (ex. import d'anciens documents)
  for (;;) {
    db.prepare('UPDATE counters SET value = value + 1 WHERE type = ? AND scope = ?').run(type, scope);
    const n = db.prepare('SELECT value FROM counters WHERE type = ? AND scope = ?').get(type, scope).value;
    const number = formatNumber(format, date, n);
    if (!db.prepare('SELECT 1 FROM documents WHERE number = ?').get(number)) return number;
  }
}

module.exports = { nextNumber, formatNumber, scopeFor };
