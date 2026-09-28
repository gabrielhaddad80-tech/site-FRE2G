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
function currentPage() { return location.pathname.split('/').pop() || 'index.html'; }

// Navigation et impression (redéfinissables, ex. pour la démo en ligne)
function go(url) { location.href = url; }
function setUrl(url) { history.replaceState(null, '', url); }
function openPrint(id) { window.open(`/api/documents/${id}/print`, '_blank'); }

// Fenêtre de confirmation intégrée à la page (remplace confirm())
function uiConfirm(message, okLabel = 'Confirmer') {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = '<div class="modal confirm" role="alertdialog" aria-modal="true"><p class="confirm-msg"></p>'
      + '<div class="actions"><button type="button" data-v="0">Annuler</button><button type="button" class="primary" data-v="1"></button></div></div>';
    bg.querySelector('.confirm-msg').textContent = message;
    bg.querySelector('[data-v="1"]').textContent = okLabel;
    const close = (v) => { document.removeEventListener('keydown', onKey, true); bg.remove(); resolve(v); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(false); }
      if (e.key === 'Enter') { e.preventDefault(); close(true); }
    };
    bg.addEventListener('click', (e) => {
      if (e.target === bg) close(false);
      const b = e.target.closest('button[data-v]');
      if (b) close(b.dataset.v === '1');
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(bg);
    bg.querySelector('[data-v="1"]').focus();
  });
}

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

// Icônes au trait (SVG), utilisables en HTML via icon('nom')
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/>',
  chart: '<path d="M4 20V11"/><path d="M10 20V5"/><path d="M16 20v-8"/><path d="M21 20H3"/>',
  quote: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 13h8M8 17h5"/>',
  invoice: '<path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  credit: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>',
  tag: '<path d="M20 12.5 12.5 20 3 10.5V3h7.5z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  layout: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 21V9"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
  arrow: '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  more: '<circle cx="12" cy="5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="19" r="1.2"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m3.5 7.5 8.5 6 8.5-6"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  trend: '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  pin: '<path d="M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  building: '<path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/><path d="M16 9h2a2 2 0 0 1 2 2v10M3 21h18M8 7h4M8 11h4M8 15h4"/>'
};
function icon(name, extra = '') {
  return `<svg class="i ${extra}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// Avatars à initiales (couleurs stables par nom)
const AVATAR_TONES = [['#dfe4ff', '#f1dcff'], ['#ffe1ea', '#ffeccf'], ['#d9f5e6', '#dcefff'], ['#fff0cf', '#ffdfe6'], ['#e6e0ff', '#d6f1ff']];
function initials(name) {
  return String(name || '?').split(/[\s-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}
function avatarStyle(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [a1, a2] = AVATAR_TONES[h % AVATAR_TONES.length];
  return `--a1:${a1};--a2:${a2}`;
}
function relDate(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
  const days = Math.round((new Date(todayIso() + 'T12:00:00') - d) / 86400000);
  if (days === 0) return "Aujourd'hui";
  if (days === 1) return 'Hier';
  if (days === -1) return 'Demain';
  if (days > 1) return days < 31 ? `Il y a ${days} jours` : fdate(iso);
  return -days < 31 ? `Dans ${-days} jours` : fdate(iso);
}

const NAV = [
  ['index.html', 'Accueil', 'home'],
  ['tableau-de-bord.html', 'Tableau de bord', 'chart'],
  ['documents.html?type=devis', 'Devis', 'quote'],
  ['documents.html?type=facture', 'Factures', 'invoice'],
  ['documents.html?type=avoir', 'Avoirs', 'credit'],
  ['clients.html', 'Clients', 'users'],
  ['catalogue.html', 'Catalogue & tarifs', 'box'],
  ['modeles.html', 'Modèles', 'layout'],
  ['parametres.html', 'Paramètres', 'settings']
];
const TABS = ['index.html', 'documents.html?type=devis', 'documents.html?type=facture', 'clients.html'];

function isActive(href) {
  const [page, query] = href.split('?');
  const current = currentPage();
  if (current === 'document.html') return false;
  let active = page === current || (current === '' && page === 'index.html');
  if (active && query) active = query === `type=${qs('type')}`;
  return active;
}

function renderNav() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  nav.classList.remove('open');
  nav.innerHTML = '<a class="brand" href="index.html"><span class="logo">F</span>Facturation</a>'
    + NAV.map(([href, label, ic]) => `<a href="${href}" class="${isActive(href) ? 'active' : ''}">${icon(ic)}${label}</a>`).join('')
    + `<div class="nav-actions"><a class="btn-new" href="document.html?new=devis">${icon('plus')}Nouveau devis</a><a class="btn-new alt" href="document.html?new=facture">${icon('plus')}Nouvelle facture</a></div>`;
  let bar = document.getElementById('tabbar');
  if (!bar) {
    bar = document.createElement('nav');
    bar.id = 'tabbar';
    bar.setAttribute('aria-label', 'Navigation rapide');
    document.body.appendChild(bar);
    bar.addEventListener('click', (e) => {
      if (e.target.closest('[data-menu]')) document.getElementById('nav').classList.toggle('open');
    });
  }
  const short = { 'index.html': 'Accueil', 'documents.html?type=devis': 'Devis', 'documents.html?type=facture': 'Factures', 'clients.html': 'Clients' };
  bar.innerHTML = TABS.map((href) => {
    const ic = NAV.find((n) => n[0] === href)[2];
    return `<a href="${href}" class="${isActive(href) ? 'active' : ''}">${icon(ic)}${short[href]}</a>`;
  }).join('') + `<button type="button" data-menu>${icon('menu')}Menu</button>`;
}

document.addEventListener('DOMContentLoaded', renderNav);
