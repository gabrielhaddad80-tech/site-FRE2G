// Base de données SQLite (module natif node:sqlite, aucune dépendance à compiler).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const DB_PATH = process.env.DB_PATH || "./data/adv.db";
mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,
  raison_sociale TEXT NOT NULL,
  siret TEXT, tva_intra TEXT,
  contact TEXT, email TEXT, telephone TEXT,
  adresse TEXT, code_postal TEXT, ville TEXT, pays TEXT DEFAULT 'France',
  delai_paiement_jours INTEGER DEFAULT 30,
  remise_pct REAL DEFAULT 0,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS produits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT UNIQUE NOT NULL,
  designation TEXT NOT NULL,
  unite TEXT DEFAULT 'u',
  prix_ht REAL NOT NULL DEFAULT 0,
  tva_taux REAL NOT NULL DEFAULT 20,
  stock REAL,
  delai_jours INTEGER,
  actif INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS devis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT UNIQUE NOT NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  date TEXT NOT NULL,
  validite_jours INTEGER DEFAULT 30,
  statut TEXT NOT NULL DEFAULT 'brouillon', -- brouillon, envoye, accepte, refuse, expire
  objet TEXT, notes TEXT,
  total_ht REAL DEFAULT 0, total_tva REAL DEFAULT 0, total_ttc REAL DEFAULT 0,
  commande_id INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS commandes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT UNIQUE NOT NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  devis_id INTEGER,
  date TEXT NOT NULL,
  ref_client TEXT,
  date_livraison_prevue TEXT,
  adresse_livraison TEXT,
  statut TEXT NOT NULL DEFAULT 'recue', -- recue, confirmee, en_preparation, expediee, livree, facturee, annulee
  transporteur TEXT, numero_suivi TEXT,
  notes TEXT,
  total_ht REAL DEFAULT 0, total_tva REAL DEFAULT 0, total_ttc REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS factures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT UNIQUE NOT NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  commande_id INTEGER,
  date TEXT NOT NULL,
  echeance TEXT NOT NULL,
  statut TEXT NOT NULL DEFAULT 'emise', -- emise, partiellement_payee, payee, en_retard, annulee
  total_ht REAL DEFAULT 0, total_tva REAL DEFAULT 0, total_ttc REAL DEFAULT 0,
  montant_paye REAL DEFAULT 0,
  nb_relances INTEGER DEFAULT 0,
  derniere_relance TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS lignes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type TEXT NOT NULL, -- devis, commande, facture
  doc_id INTEGER NOT NULL,
  produit_id INTEGER,
  reference TEXT, designation TEXT NOT NULL,
  quantite REAL NOT NULL, unite TEXT DEFAULT 'u',
  prix_ht REAL NOT NULL, remise_pct REAL DEFAULT 0, tva_taux REAL DEFAULT 20
);
CREATE INDEX IF NOT EXISTS idx_lignes_doc ON lignes(doc_type, doc_id);
CREATE TABLE IF NOT EXISTS paiements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  facture_id INTEGER NOT NULL REFERENCES factures(id),
  date TEXT NOT NULL, montant REAL NOT NULL,
  mode TEXT, reference TEXT
);
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER,
  destinataire TEXT NOT NULL,
  objet TEXT NOT NULL, corps TEXT NOT NULL,
  doc_type TEXT, doc_id INTEGER,
  motif TEXT,
  statut TEXT NOT NULL DEFAULT 'a_valider', -- a_valider, envoye, rejete, erreur
  erreur TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  sent_at TEXT
);
CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT DEFAULT (datetime('now','localtime')),
  acteur TEXT, action TEXT, details TEXT
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titre TEXT,
  origine TEXT DEFAULT 'chat', -- chat, email, routine
  messages TEXT NOT NULL DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS meta (cle TEXT PRIMARY KEY, valeur TEXT);
`);

export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

// Transaction réentrante (une transaction imbriquée rejoint la transaction englobante).
let depth = 0;
export function tx(fn) {
  if (depth > 0) return fn();
  db.exec("BEGIN");
  depth++;
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    depth--;
  }
}

export function getMeta(cle) {
  return get("SELECT valeur FROM meta WHERE cle = ?", cle)?.valeur ?? null;
}
export function setMeta(cle, valeur) {
  run("INSERT INTO meta(cle, valeur) VALUES(?, ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur", cle, String(valeur));
}
