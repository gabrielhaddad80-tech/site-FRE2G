// Base de données SQLite (module node:sqlite intégré à Node.js 22).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Fournisseurs à qui l'agent envoie les confirmations de commande
CREATE TABLE IF NOT EXISTS suppliers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  email      TEXT,
  contact    TEXT,
  phone      TEXT,
  account_number TEXT,          -- n° de compte client FRE2G chez le fournisseur
  notes      TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Fiches clients : créées uniquement quand le client signe son devis
CREATE TABLE IF NOT EXISTS clients (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT UNIQUE,
  kind         TEXT NOT NULL DEFAULT 'particulier',   -- particulier | professionnel
  civility     TEXT,
  first_name   TEXT,
  last_name    TEXT,
  company      TEXT,
  email        TEXT,
  phone        TEXT,
  address      TEXT,
  postal_code  TEXT,
  city         TEXT,
  siret        TEXT,
  vat_number   TEXT,
  status       TEXT NOT NULL DEFAULT 'en_cours',      -- en_cours | installe
  notes        TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  installed_at TEXT
);

-- Un devis = un dossier, suivi de la rédaction jusqu'au solde encaissé
CREATE TABLE IF NOT EXISTS quotes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  number         TEXT UNIQUE,
  status         TEXT NOT NULL DEFAULT 'brouillon',
  date           TEXT NOT NULL,
  validity_days  INTEGER NOT NULL DEFAULT 30,
  prospect       TEXT NOT NULL DEFAULT '{}',   -- coordonnées du prospect (JSON) avant signature
  client_id      INTEGER REFERENCES clients(id),
  object         TEXT,
  site_address   TEXT,
  letter         TEXT NOT NULL DEFAULT '{}',   -- lettre d'accompagnement (JSON)
  materiel       TEXT NOT NULL DEFAULT '[]',   -- matériel proposé (JSON), avec fournisseur
  travaux        TEXT NOT NULL DEFAULT '[]',   -- description des travaux par phase (JSON)
  lines          TEXT NOT NULL DEFAULT '[]',   -- lignes chiffrées (JSON)
  conditions     TEXT NOT NULL DEFAULT '{}',   -- délai, non compris, garantie, note TVA (JSON)
  deposit_pct    REAL NOT NULL DEFAULT 50,
  total_ht       REAL DEFAULT 0,
  total_vat      REAL DEFAULT 0,
  total_ttc      REAL DEFAULT 0,
  notes_internes TEXT,
  sign_token     TEXT UNIQUE,
  sign_otp_hash  TEXT,
  sign_otp_expires TEXT,
  sign_otp_attempts INTEGER DEFAULT 0,
  signature      TEXT,                         -- preuve de signature (JSON)
  original_pdf   TEXT,                         -- PDF envoyé pour signature
  original_sha256 TEXT,
  signed_pdf     TEXT,                         -- PDF signé avec certificat
  signed_sha256  TEXT,
  automation     TEXT NOT NULL DEFAULT '{}',   -- avancement des étapes automatiques (JSON)
  sent_for_signature_at TEXT,
  signed_at      TEXT,
  deposit_paid_at TEXT,
  installed_at   TEXT,
  closed_at      TEXT,
  created_at     TEXT DEFAULT (datetime('now')),
  updated_at     TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  number      TEXT UNIQUE NOT NULL,
  kind        TEXT NOT NULL,                  -- acompte | solde
  quote_id    INTEGER NOT NULL REFERENCES quotes(id),
  client_id   INTEGER NOT NULL REFERENCES clients(id),
  date        TEXT NOT NULL,
  due_date    TEXT,
  total_ht    REAL NOT NULL,
  total_vat   REAL NOT NULL,
  total_ttc   REAL NOT NULL,
  amount_due  REAL NOT NULL,                  -- montant à payer sur cette facture
  details     TEXT NOT NULL DEFAULT '{}',     -- ventilation TVA, déductions (JSON)
  status      TEXT NOT NULL DEFAULT 'emise',  -- emise | payee
  paid_at     TEXT,
  payment_method TEXT,
  payment_ref TEXT,
  pdf_path    TEXT,
  sent_at     TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS supplier_orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id    INTEGER NOT NULL REFERENCES quotes(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  number      TEXT,
  items       TEXT NOT NULL DEFAULT '[]',
  pdf_path    TEXT,
  sent_at     TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  UNIQUE (quote_id, supplier_id)
);

-- Journal de tout ce que fait l'agent, dossier par dossier
CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id  INTEGER REFERENCES quotes(id),
  at        TEXT DEFAULT (datetime('now')),
  level     TEXT NOT NULL DEFAULT 'info',     -- info | success | warning | error
  type      TEXT NOT NULL,
  message   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS emails (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id   INTEGER REFERENCES quotes(id),
  kind       TEXT NOT NULL,
  recipient  TEXT NOT NULL,
  subject    TEXT NOT NULL,
  status     TEXT NOT NULL,                   -- envoye | erreur
  message_id TEXT,
  file       TEXT,                            -- fichier .eml en mode « outbox »
  error      TEXT,
  at         TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
CREATE INDEX IF NOT EXISTS idx_events_quote ON events(quote_id, id);
CREATE INDEX IF NOT EXISTS idx_invoices_quote ON invoices(quote_id);
`;

// Valeurs par défaut, reprises du modèle de devis FRE2G et de la procédure ADV
export const DEFAULT_SETTINGS = {
  company_name: 'FRE2G',
  company_legal_form: '',
  company_capital: '',
  company_address: '42, rue du Port',
  company_postal_code: '93300',
  company_city: 'Aubervilliers',
  company_phone: '',
  company_email: '',
  company_website: '',
  company_siret: '',
  company_vat_number: '',
  company_rcs: '',
  company_ape: '',
  company_insurance: '',        // assurance décennale : obligatoire sur les devis de travaux
  company_signatory: 'FRE2G',
  bank_name: '',
  bank_iban: '',
  bank_bic: '',
  quote_next_number: '261185',  // les devis FRE2G sont numérotés 261182, 261183, 261184…
  invoice_prefix: 'FA-{AAAA}-',
  invoice_digits: '4',
  order_prefix: 'BC-',
  quote_validity_days: '30',
  deposit_pct: '50',            // acompte à la commande (procédure ADV)
  payment_days_particulier: '0',
  payment_days_professionnel: '30',
  default_vat_rate: '20',
  default_delai: "Intervention à planifier après réception de l'acompte, selon la disponibilité du matériel.",
  default_non_compris: "Travaux d'étanchéité, de maçonnerie, de faux plafonds et de peinture ; pompe de relevage si l'évacuation des condensats ne peut pas se faire en gravitaire (250,00 € HT par pompe).",
  default_garantie: 'Garantie constructeur sur le matériel, compresseur garanti 3 ans.',
  default_closing: "Nous restons à votre disposition pour toute précision et pour organiser le planning d'intervention.",
  late_penalties: "En cas de retard de paiement, application de pénalités au taux de 3 fois le taux d'intérêt légal. Pour les professionnels, indemnité forfaitaire pour frais de recouvrement de 40 € (art. L441-10 du Code de commerce). Pas d'escompte pour paiement anticipé.",
  signature_otp: '1',           // code envoyé par e-mail avant la signature
  notify_on_deposit: '1',       // mail au client quand l'acompte est encaissé
  delivery_address: '',         // adresse de livraison du matériel (vide = adresse du chantier)
  ai_price_list: ''             // tarifs internes que Claude peut utiliser pour chiffrer
};

export function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'fre2g.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insert.run(k, v);
  return db;
}

export function getSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value ?? '';
  return out;
}

export function saveSettings(db, values) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(values)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    stmt.run(k, v == null ? '' : String(v));
  }
}

// Exécute fn dans une transaction (BEGIN IMMEDIATE pour sérialiser les numérotations)
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function logEvent(db, quoteId, type, message, level = 'info') {
  db.prepare('INSERT INTO events (quote_id, type, message, level) VALUES (?, ?, ?, ?)').run(quoteId ?? null, type, message, level);
}
