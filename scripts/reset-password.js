'use strict';
// Réinitialise le mot de passe d'un compte (ou le crée s'il n'existe pas).
// Usage : npm run reset-password -- adresse@email.fr NouveauMotDePasse
const { openDatabase } = require('../src/db');
const { resetPassword } = require('../src/auth');

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage : npm run reset-password -- adresse@email.fr NouveauMotDePasse');
  process.exit(1);
}
try {
  const db = openDatabase();
  const result = resetPassword(db, email, password);
  console.log(result === 'created' ? `Compte créé pour ${email}.` : `Mot de passe de ${email} réinitialisé (ses sessions ouvertes sont fermées).`);
} catch (e) {
  console.error('Erreur : ' + e.message);
  process.exit(1);
}
