'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS clients (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL DEFAULT 'professionnel', -- professionnel | particulier
  code        TEXT,
  company     TEXT,
  civility    TEXT,
  first_name  TEXT,
  last_name   TEXT,
  address     TEXT,
  postal_code TEXT,
  city        TEXT,
  country     TEXT DEFAULT 'France',
  email       TEXT,
  phone       TEXT,
  siret       TEXT,
  vat_number  TEXT,
  payment_days INTEGER,
  discount_pct REAL DEFAULT 0,
  notes       TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  position  INTEGER DEFAULT 0
);

-- Catalogue : prestations, main d'oeuvre, fournitures, matériel, ouvrages (composés)
CREATE TABLE IF NOT EXISTS items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  type           TEXT NOT NULL DEFAULT 'prestation', -- prestation | main_oeuvre | fourniture | materiel | ouvrage
  reference      TEXT,
  designation    TEXT NOT NULL,
  description    TEXT,
  unit           TEXT DEFAULT 'u',
  purchase_price REAL DEFAULT 0,
  sale_price     REAL DEFAULT 0,
  vat_rate       REAL DEFAULT 20,
  category_id    INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  supplier       TEXT,
  catalog        TEXT,           -- nom du catalogue / fournisseur d'origine
  active         INTEGER DEFAULT 1,
  created_at     TEXT DEFAULT (datetime('now')),
  updated_at     TEXT DEFAULT (datetime('now'))
);

-- Composition des ouvrages
CREATE TABLE IF NOT EXISTS item_components (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  child_id  INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  quantity  REAL NOT NULL DEFAULT 1,
  position  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  html       TEXT NOT NULL,
  css        TEXT,
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Devis, factures, avoirs
CREATE TABLE IF NOT EXISTS documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT NOT NULL,              -- devis | facture | avoir
  number        TEXT UNIQUE,                -- attribué à la création (devis) ou à l'émission (facture / avoir)
  status        TEXT NOT NULL DEFAULT 'brouillon',
  client_id     INTEGER REFERENCES clients(id) ON DELETE RESTRICT,
  client_snapshot TEXT,                     -- copie figée du client à l'émission
  template_id   INTEGER REFERENCES templates(id) ON DELETE SET NULL,
  source_id     INTEGER REFERENCES documents(id) ON DELETE SET NULL, -- devis d'origine / facture d'origine
  date          TEXT NOT NULL,
  due_date      TEXT,                       -- échéance (facture)
  validity_date TEXT,                       -- validité (devis)
  title         TEXT,                       -- objet
  site_address  TEXT,                       -- adresse du chantier / de la prestation
  intro         TEXT,
  notes         TEXT,
  conditions    TEXT,
  discount_pct  REAL DEFAULT 0,             -- remise globale
  deposit_pct   REAL DEFAULT 0,             -- acompte demandé (devis)
  total_ht      REAL DEFAULT 0,
  total_vat     REAL DEFAULT 0,
  total_ttc     REAL DEFAULT 0,
  issued_at     TEXT,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS document_lines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  kind         TEXT NOT NULL DEFAULT 'item',  -- item | section | text
  item_id      INTEGER REFERENCES items(id) ON DELETE SET NULL,
  item_type    TEXT,
  reference    TEXT,
  designation  TEXT,
  description  TEXT,
  quantity     REAL DEFAULT 1,
  unit         TEXT,
  unit_price   REAL DEFAULT 0,
  discount_pct REAL DEFAULT 0,
  vat_rate     REAL DEFAULT 20,
  purchase_price REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  amount      REAL NOT NULL,
  method      TEXT,
  reference   TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS counters (
  type  TEXT NOT NULL,
  scope TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (type, scope)
);

CREATE INDEX IF NOT EXISTS idx_lines_doc ON document_lines(document_id, position);
CREATE INDEX IF NOT EXISTS idx_docs_type ON documents(type, status);
CREATE INDEX IF NOT EXISTS idx_items_type ON items(type, active);
`;

const DEFAULT_SETTINGS = {
  company_name: 'Mon Entreprise',
  company_legal_form: 'SARL',
  company_capital: '',
  company_address: '1 rue de l\'Exemple',
  company_postal_code: '75000',
  company_city: 'Paris',
  company_country: 'France',
  company_phone: '',
  company_email: '',
  company_website: '',
  company_siret: '',
  company_rcs: '',
  company_ape: '',
  company_vat_number: '',
  company_insurance: '',
  company_logo: '',
  bank_name: '',
  bank_iban: '',
  bank_bic: '',
  vat_exempt: '0',
  vat_exempt_mention: 'TVA non applicable, art. 293 B du CGI',
  default_vat_rate: '20',
  vat_rates: '20,10,5.5,2.1,0',
  units: 'u,h,j,m,m²,m³,ml,kg,l,forfait,ens',
  default_margin_coef: '1.3',
  quote_validity_days: '30',
  invoice_payment_days: '30',
  quote_number_format: 'DEV-{AAAA}-{NUM:4}',
  invoice_number_format: 'FAC-{AAAA}-{NUM:4}',
  credit_number_format: 'AV-{AAAA}-{NUM:4}',
  quote_default_intro: 'Suite à votre demande, nous avons le plaisir de vous adresser notre meilleure offre.',
  invoice_default_intro: '',
  quote_default_conditions: 'Devis valable jusqu\'à la date de validité indiquée.\nBon pour accord : date, signature et mention « Bon pour accord ».',
  invoice_default_conditions: 'Paiement par virement bancaire à réception.',
  legal_mentions: 'En cas de retard de paiement, application de pénalités au taux de 3 fois le taux d\'intérêt légal, ainsi qu\'une indemnité forfaitaire pour frais de recouvrement de 40 € (art. L441-10 du Code de commerce). Pas d\'escompte pour paiement anticipé.',
  footer_text: '',
  primary_color: '#1f4e79',
  accent_color: '#f2f6fa',
  currency: 'EUR'
};

function openDatabase(file) {
  const dbFile = file || process.env.DB_FILE || path.join(__dirname, '..', 'data', 'facturation.db');
  if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  initData(db);
  return db;
}

function initData(db) {
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

  const tplCount = db.prepare('SELECT COUNT(*) AS n FROM templates').get().n;
  if (tplCount === 0) {
    const tplDir = path.join(__dirname, '..', 'templates');
    const html = fs.readFileSync(path.join(tplDir, 'classique.hbs'), 'utf8');
    const css = fs.readFileSync(path.join(tplDir, 'classique.css'), 'utf8');
    db.prepare('INSERT INTO templates (name, html, css, is_default) VALUES (?, ?, ?, 1)').run('Modèle classique', html, css);
  }

  const itemCount = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
  if (itemCount === 0 && process.env.NO_SEED !== '1') seedExamples(db);
}

// Quelques données d'exemple pour prendre en main le logiciel (supprimables).
function seedExamples(db) {
  const tx = db.transaction(() => {
    const cat = db.prepare('INSERT INTO categories (name, position) VALUES (?, ?)');
    const catMo = cat.run('Main d\'œuvre', 1).lastInsertRowid;
    const catFour = cat.run('Fournitures', 2).lastInsertRowid;
    const catPresta = cat.run('Prestations', 3).lastInsertRowid;

    const item = db.prepare(`INSERT INTO items (type, reference, designation, description, unit, purchase_price, sale_price, vat_rate, category_id, catalog)
      VALUES (@type, @reference, @designation, @description, @unit, @purchase_price, @sale_price, @vat_rate, @category_id, @catalog)`);
    const mo = item.run({ type: 'main_oeuvre', reference: 'MO-01', designation: 'Main d\'œuvre ouvrier qualifié', description: '', unit: 'h', purchase_price: 28, sale_price: 45, vat_rate: 20, category_id: catMo, catalog: 'Interne' }).lastInsertRowid;
    item.run({ type: 'main_oeuvre', reference: 'MO-02', designation: 'Main d\'œuvre chef d\'équipe', description: '', unit: 'h', purchase_price: 35, sale_price: 55, vat_rate: 20, category_id: catMo, catalog: 'Interne' });
    const f1 = item.run({ type: 'fourniture', reference: 'F-100', designation: 'Fourniture standard', description: 'Matériau de base', unit: 'm²', purchase_price: 12, sale_price: 18.5, vat_rate: 20, category_id: catFour, catalog: 'Fournisseur A' }).lastInsertRowid;
    const f2 = item.run({ type: 'fourniture', reference: 'F-200', designation: 'Petites fournitures', description: 'Visserie, colle, consommables', unit: 'forfait', purchase_price: 15, sale_price: 25, vat_rate: 20, category_id: catFour, catalog: 'Fournisseur A' }).lastInsertRowid;
    item.run({ type: 'prestation', reference: 'P-DEP', designation: 'Déplacement', description: 'Frais de déplacement', unit: 'forfait', purchase_price: 0, sale_price: 40, vat_rate: 20, category_id: catPresta, catalog: 'Interne' });
    item.run({ type: 'materiel', reference: 'M-ECH', designation: 'Location échafaudage', description: '', unit: 'j', purchase_price: 30, sale_price: 50, vat_rate: 20, category_id: catPresta, catalog: 'Interne' });

    const ouv = item.run({ type: 'ouvrage', reference: 'OUV-01', designation: 'Pose au m² (fourniture + main d\'œuvre)', description: 'Ouvrage composé', unit: 'm²', purchase_price: 0, sale_price: 0, vat_rate: 20, category_id: catPresta, catalog: 'Interne' }).lastInsertRowid;
    const comp = db.prepare('INSERT INTO item_components (parent_id, child_id, quantity, position) VALUES (?, ?, ?, ?)');
    comp.run(ouv, f1, 1, 0);
    comp.run(ouv, mo, 0.5, 1);
    comp.run(ouv, f2, 0.1, 2);
    // Prix de l'ouvrage = somme des composants
    const sums = db.prepare(`SELECT SUM(c.quantity * i.sale_price) AS sale, SUM(c.quantity * i.purchase_price) AS buy
      FROM item_components c JOIN items i ON i.id = c.child_id WHERE c.parent_id = ?`).get(ouv);
    db.prepare('UPDATE items SET sale_price = ?, purchase_price = ? WHERE id = ?').run(Math.round(sums.sale * 100) / 100, Math.round(sums.buy * 100) / 100, ouv);

    db.prepare(`INSERT INTO clients (kind, code, company, first_name, last_name, address, postal_code, city, email, phone)
      VALUES ('professionnel', 'CL0001', 'Client Exemple SAS', 'Jean', 'Dupont', '10 avenue des Tests', '69000', 'Lyon', 'contact@exemple.fr', '04 00 00 00 00')`).run();
  });
  tx();
}

function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  return s;
}

module.exports = { openDatabase, getSettings, DEFAULT_SETTINGS };
