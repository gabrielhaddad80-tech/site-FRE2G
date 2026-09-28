/* Utilitaires partagés par toutes les pages */
'use strict';

const LABELS = {
  type: { devis: 'Devis', facture: 'Facture', avoir: 'Avoir' },
  status: {
    brouillon: 'Brouillon', envoye: 'Envoyé', accepte: 'Accepté', refuse: 'Refusé', facture: 'Facturé',
    emise: 'Émise', partielle: 'Partiellement réglée', payee: 'Réglée', annulee: 'Annulée'
  },
  itemType: { prestation: 'Prestation', main_oeuvre: "Main d'œuvre", fourniture: 'Fourniture', materiel: 'Matériel', ouvrage: 'Ouvrage' },
  paymentMethod: { virement: 'Virement', cheque: 'Chèque', especes: 'Espèces', cb: 'Carte bancaire', prelevement: 'Prélèvement', autre: 'Autre' }
};

async function api(url, options = {}) {
  const opts = { method: options.method || (options.body ? 'POST' : 'GET'), headers: {} };
  if (options.body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(options.body);
  }
  const res = await fetch('/api' + url, opts);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (data && data.error) || `Erreur ${res.status}`;
    toast(msg, 'error');
    throw new Error(msg);
  }
  return data;
}

const moneyFormatter = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const numberFormatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 });
function money(v) { return moneyFormatter.format(Number(v) || 0); }
function num(v) { return numberFormatter.format(Number(v) || 0); }
function fdate(v) { if (!v) return ''; const [y, m, d] = String(v).slice(0, 10).split('-'); return `${d}/${m}/${y}`; }
function todayIso() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function clientName(c) { if (!c) return ''; return c.company || [c.first_name, c.last_name].filter(Boolean).join(' '); }
function qs(name) { return new URLSearchParams(location.search).get(name); }

function toast(message, kind = 'ok') {
  let box = document.getElementById('toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 2500);
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Analyse CSV (séparateur ; ou , détecté automatiquement, guillemets gérés)
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/)[0] || '';
  const sep = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === sep) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const NAV = [
  ['index.html', 'Tableau de bord'],
  ['documents.html?type=devis', 'Devis'],
  ['documents.html?type=facture', 'Factures'],
  ['documents.html?type=avoir', 'Avoirs'],
  ['clients.html', 'Clients'],
  ['catalogue.html', 'Catalogue & tarifs'],
  ['modeles.html', 'Modèles'],
  ['parametres.html', 'Paramètres']
];

function renderNav() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  const current = location.pathname.split('/').pop() || 'index.html';
  const type = qs('type');
  nav.innerHTML = '<div class="brand">Facturation</div>' + NAV.map(([href, label]) => {
    const [page, query] = href.split('?');
    let active = page === current || (current === '' && page === 'index.html');
    if (active && query) active = query === `type=${type}`;
    if (current === 'document.html' && query) active = false;
    return `<a href="${href}" class="${active ? 'active' : ''}">${label}</a>`;
  }).join('') + '<div class="nav-actions"><a class="btn-new" href="document.html?new=devis">+ Nouveau devis</a><a class="btn-new" href="document.html?new=facture">+ Nouvelle facture</a></div>';
}

document.addEventListener('DOMContentLoaded', renderNav);
