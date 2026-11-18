'use strict';
/* Interface d'administration de l'agent FRE2G (sans dépendance) */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const money = (v) => eur.format(Number(v) || 0);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const numVal = (v) => { const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const fdate = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');
const fdt = (s) => {
  if (!s) return '';
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${String(s).replace(' ', 'T')}Z`);
  return d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
};
const today = () => new Date().toISOString().slice(0, 10);
const VAT = [20, 10, 5.5, 2.1, 0];
const METHODS = { virement: 'Virement', cheque: 'Chèque', cb: 'Carte bancaire', especes: 'Espèces', prelevement: 'Prélèvement', autre: 'Autre' };
const STEP_LABELS = {
  signed_pdf: 'Exemplaire signé (PDF + certificat)',
  client: 'Fiche client créée',
  signed_copy: 'Exemplaire signé envoyé au client',
  supplier_orders: 'Commande envoyée au(x) fournisseur(s)',
  deposit_invoice: "Facture d'acompte envoyée",
  notify_signed: 'Notification interne FRE2G',
  deposit_received_mail: "Confirmation d'acompte envoyée au client",
  balance_invoice: 'Facture de solde envoyée',
  client_installed: 'Client classé « installé »'
};

let ME = null;
let SUPPLIERS = [];
const app = $('#app');

// ---------------------------------------------------------------------------
async function api(url, opts = {}) {
  const init = { method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'), headers: {} };
  if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  const res = await fetch(`/api${url}`, init);
  const data = await res.json().catch(() => null);
  if (res.status === 401 && data?.code === 'auth') { showLogin(); throw new Error('auth'); }
  if (!res.ok) throw new Error(data?.error || `Erreur ${res.status}`);
  return data;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 8000 : 4000);
}

async function run(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  document.body.classList.add('busy');
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    if (e.message !== 'auth') toast(e.message, 'error');
    return undefined;
  } finally {
    if (btn) btn.disabled = false;
    document.body.classList.remove('busy');
  }
}

// Fenêtre modale avec formulaire ; renvoie les valeurs saisies, ou null si annulé
function modal(title, bodyHtml, { ok = 'Valider', okClass = 'primary', cancel = 'Annuler' } = {}) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<form class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h2>${esc(title)}</h2>${bodyHtml}
      <div class="row-actions">${cancel ? `<button type="button" data-cancel>${esc(cancel)}</button>` : ''}${ok ? `<button type="submit" class="${okClass}">${esc(ok)}</button>` : ''}</div></form>`;
    const close = (v) => { bg.remove(); resolve(v); };
    bg.addEventListener('click', (e) => { if (e.target === bg) close(null); });
    bg.querySelector('[data-cancel]')?.addEventListener('click', () => close(null));
    bg.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      close(Object.fromEntries(new FormData(e.target).entries()));
    });
    document.body.appendChild(bg);
    (bg.querySelector('input, select, textarea, button[type=submit]'))?.focus();
  });
}

// ---------------------------------------------------------------------------
function showLogin() {
  $('#nav').hidden = true;
  app.innerHTML = `<form class="card login" id="login"><h1>Agent FRE2G</h1>
    <label for="pw">Mot de passe</label><input type="password" id="pw" name="password" autocomplete="current-password" required>
    <p style="margin-top:14px"><button class="primary" type="submit">Se connecter</button></p></form>`;
  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#pw').value }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast(data.error || 'Connexion impossible', 'error'); return; }
    await boot().catch((err) => toast(err.message, 'error'));
  });
  $('#pw').focus();
}

$('#logout').addEventListener('click', async () => { await fetch('/api/logout', { method: 'POST' }); showLogin(); });

async function boot() {
  ME = await api('/me');
  SUPPLIERS = await api('/suppliers');
  $('#nav').hidden = false;
  route();
}

window.addEventListener('hashchange', route);

function setActive(name) {
  $$('#nav a[data-route]').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
}

async function route() {
  if (!ME) return;
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [a, b] = parts;
  try {
    if (!a) { setActive('dashboard'); return await viewDashboard(); }
    if (a === 'devis' && b === 'nouveau') {
      const q = await api('/quotes', { body: {} });
      location.replace(`#/devis/${q.id}`);
      return;
    }
    if (a === 'devis' && b) { setActive('devis'); return await viewQuote(Number(b)); }
    if (a === 'devis') { setActive('devis'); return await viewQuotes(); }
    if (a === 'clients') { setActive('clients'); return await viewClients(b || 'en_cours'); }
    if (a === 'factures') { setActive('factures'); return await viewInvoices(); }
    if (a === 'fournisseurs') { setActive('fournisseurs'); return await viewSuppliers(); }
    if (a === 'parametres') { setActive('parametres'); return await viewSettings(); }
    app.innerHTML = '<p class="empty">Page introuvable.</p>';
  } catch (e) {
    if (e.message !== 'auth') app.innerHTML = `<div class="notice err">${esc(e.message)}</div>`;
  }
}

const badge = (status, label) => `<span class="badge ${esc(status)}">${esc(label || ME.statuses[status] || status)}</span>`;

// ---------------------------------------------------------------------------
// Tableau de bord
// ---------------------------------------------------------------------------
async function viewDashboard() {
  const [d, quotes] = await Promise.all([api('/dashboard'), api('/quotes')]);
  const col = (status, title) => {
    const rows = quotes.filter((q) => (Array.isArray(status) ? status.includes(q.status) : q.status === status));
    return `<div class="col"><h3>${esc(title)} <span>${rows.length}</span></h3>${rows.slice(0, 12).map((q) => `
      <a class="dcard" href="#/devis/${q.id}"><div class="t">${esc(q.number)} · ${esc(q.client_name || 'Prospect à compléter')}</div>
      <div class="m">${money(q.total_ttc)} TTC${q.automation_errors ? ' · <span class="badge err">étape en échec</span>' : ''}</div></a>`).join('') || '<div class="m muted small">Aucun</div>'}</div>`;
  };
  app.innerHTML = `
    <div class="toolbar"><h1 style="margin:0">Tableau de bord</h1><span class="spacer"></span><a class="btn primary" href="#/devis/nouveau">+ Nouveau devis</a></div>
    ${ME.mail_mode !== 'smtp' ? '<div class="notice warn">Mode essai : les e-mails ne partent pas réellement, ils sont enregistrés dans le dossier <code>data/outbox</code>. Configurez le SMTP dans le fichier <code>.env</code> pour les envoyer.</div>' : ''}
    ${d.automation_errors ? `<div class="notice err">${d.automation_errors} dossier(s) ont une étape automatique en échec : ouvrez-les pour corriger et relancer.</div>` : ''}
    <div class="kpis">
      <a class="kpi" href="#/devis"><div class="l">En attente de signature</div><div class="v">${d.counts.attente_signature}</div><div class="s">${money(d.pending_signature_ht)} HT</div></a>
      <a class="kpi" href="#/devis"><div class="l">Acomptes à encaisser</div><div class="v">${d.counts.acompte_attendu + d.counts.signe}</div><div class="s">aucun chantier sans acompte</div></a>
      <a class="kpi" href="#/devis"><div class="l">Travaux à réaliser</div><div class="v">${d.counts.travaux}</div><div class="s">acompte encaissé</div></a>
      <a class="kpi" href="#/factures"><div class="l">Reste à encaisser</div><div class="v">${money(d.unpaid_ttc)}</div><div class="s">${d.unpaid_count} facture(s)</div></a>
      <a class="kpi ${d.overdue_count ? 'alert' : ''}" href="#/factures"><div class="l">Factures en retard</div><div class="v">${money(d.overdue_ttc)}</div><div class="s">${d.overdue_count} facture(s)</div></a>
    </div>
    <div class="card"><h2>Dossiers en cours</h2><div class="pipeline">
      ${col('attente_signature', 'Signature')}${col(['signe', 'acompte_attendu'], 'Acompte')}${col('travaux', 'Travaux')}${col('solde_attendu', 'Solde')}${col('brouillon', 'Brouillons')}
    </div></div>
    <div class="card"><h2>Activité de l'agent</h2><ul class="timeline">${d.recent_events.map((e) => `
      <li class="${esc(e.level)}"><div class="at">${fdt(e.at)}${e.number ? ` · <a href="#/devis/${e.quote_id}">devis ${esc(e.number)}</a>` : ''}</div>${esc(e.message)}</li>`).join('') || '<li class="muted">Rien pour le moment.</li>'}</ul></div>`;
}

// ---------------------------------------------------------------------------
// Liste des devis
// ---------------------------------------------------------------------------
let quoteFilter = 'tous';
async function viewQuotes() {
  const quotes = await api('/quotes');
  const filters = { tous: 'Tous', brouillon: 'Brouillons', attente_signature: 'À signer', acompte_attendu: 'Acompte', travaux: 'Travaux', solde_attendu: 'Solde', solde: 'Soldés', refuse: 'Sans suite' };
  const render = () => {
    const rows = quotes.filter((q) => quoteFilter === 'tous' || q.status === quoteFilter || (quoteFilter === 'acompte_attendu' && q.status === 'signe'));
    app.innerHTML = `<div class="toolbar"><h1 style="margin:0">Devis &amp; dossiers</h1><span class="spacer"></span><a class="btn primary" href="#/devis/nouveau">+ Nouveau devis</a></div>
      <div class="pills">${Object.entries(filters).map(([k, v]) => `<button type="button" data-f="${k}" class="${k === quoteFilter ? 'active' : ''}">${v}</button>`).join('')}</div>
      <div class="card scroll"><table class="list"><thead><tr><th>N°</th><th>Date</th><th>Client</th><th>Objet</th><th class="num">Total TTC</th><th>Statut</th></tr></thead><tbody>
      ${rows.map((q) => `<tr class="click" data-id="${q.id}"><td><strong>${esc(q.number)}</strong></td><td>${fdate(q.date)}</td><td>${esc(q.client_name || '—')}</td>
        <td class="muted">${esc((q.object || '').slice(0, 70))}</td><td class="num">${money(q.total_ttc)}</td><td>${badge(q.status)}${q.automation_errors ? ' <span class="badge err">échec</span>' : ''}</td></tr>`).join('')}
      </tbody></table>${rows.length ? '' : '<p class="empty">Aucun devis.</p>'}</div>`;
    $$('.pills button').forEach((b) => b.addEventListener('click', () => { quoteFilter = b.dataset.f; render(); }));
    $$('tr.click').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/devis/${tr.dataset.id}`; }));
  };
  render();
}

// ---------------------------------------------------------------------------
// Éditeur de devis / suivi du dossier
// ---------------------------------------------------------------------------
let Q = null;

async function viewQuote(id) {
  Q = await api(`/quotes/${id}`);
  renderQuote();
}

function field(name, label, value, { type = 'text', cls = '', attrs = '' } = {}) {
  return `<div class="${cls}"><label for="f-${name}">${esc(label)}</label><input id="f-${name}" name="${name}" type="${type}" value="${esc(value)}" ${attrs}></div>`;
}
function area(name, label, value, { cls = '', rows = 3 } = {}) {
  return `<div class="${cls}"><label for="f-${name}">${esc(label)}</label><textarea id="f-${name}" name="${name}" rows="${rows}">${esc(value)}</textarea></div>`;
}
function select(name, label, value, options, { cls = '' } = {}) {
  return `<div class="${cls}"><label for="f-${name}">${esc(label)}</label><select id="f-${name}" name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
}

function supplierOptions(selected) {
  return `<option value="">— à commander à la main —</option>${SUPPLIERS.map((s) => `<option value="${s.id}" ${Number(selected) === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}`;
}

function matRow(i, it) {
  return `<tr data-mat="${i}">
    <td style="width:62px"><input data-f="qty" value="${esc(it.qty ?? 1)}" inputmode="decimal"></td>
    <td><input data-f="reference" value="${esc(it.reference)}" placeholder="Daikin FTXA25CW"></td>
    <td><input data-f="designation" value="${esc(it.designation)}"></td>
    <td><input data-f="caracteristiques" value="${esc(it.caracteristiques)}"></td>
    <td style="width:170px"><select data-f="supplier_id">${supplierOptions(it.supplier_id)}</select></td>
    <td style="width:96px"><input data-f="purchase_price" value="${esc(it.purchase_price || '')}" inputmode="decimal" placeholder="Achat HT"></td>
    <td style="width:40px"><button type="button" class="small" data-del-mat="${i}" aria-label="Supprimer">✕</button></td></tr>`;
}

function lineRow(i, l) {
  return `<tr data-line="${i}">
    <td><input data-f="designation" value="${esc(l.designation)}"><textarea data-f="description" placeholder="Précision (facultatif)" rows="1">${esc(l.description)}</textarea></td>
    <td style="width:70px"><input data-f="qty" value="${esc(l.qty ?? 1)}" inputmode="decimal"></td>
    <td style="width:110px"><input data-f="unit_price" value="${esc(l.unit_price ?? '')}" inputmode="decimal"></td>
    <td style="width:86px"><select data-f="vat_rate">${VAT.map((v) => `<option value="${v}" ${Number(l.vat_rate ?? 20) === v ? 'selected' : ''}>${String(v).replace('.', ',')} %</option>`).join('')}</select></td>
    <td class="num" style="width:110px" data-lt>${money(round2(numVal(l.qty) * numVal(l.unit_price)))}</td>
    <td style="width:40px"><button type="button" class="small" data-del-line="${i}" aria-label="Supprimer">✕</button></td></tr>`;
}

function phaseBlock(i, p) {
  return `<div class="phase" data-phase="${i}"><div class="toolbar" style="margin-bottom:6px"><strong>Phase ${i + 1}</strong><span class="spacer"></span><button type="button" class="small" data-del-phase="${i}">Supprimer la phase</button></div>
    <input data-f="title" value="${esc(p.title)}" placeholder="Ex. Grand bureau, Mise en service…">
    <textarea data-f="steps" rows="3" placeholder="Une étape par ligne" style="margin-top:6px">${esc((p.steps || []).join('\n'))}</textarea></div>`;
}

function automationPanel() {
  const keys = Object.keys(STEP_LABELS).filter((k) => Q.automation[k]);
  if (!keys.length) return '';
  return `<div class="card"><h2>Ce que l'agent a fait</h2><ul class="steps">${keys.map((k) => {
    const s = Q.automation[k];
    const cls = s.done ? 'done' : s.error ? 'fail' : 'todo';
    return `<li class="${cls}"><span class="ic">${s.done ? '✓' : s.error ? '✕' : '…'}</span><div><div>${esc(STEP_LABELS[k])}${s.detail ? ` <span class="muted small">(${esc(s.detail)})</span>` : ''}</div>
      ${s.error ? `<div class="small" style="color:var(--err)">${esc(s.error)}</div>` : ''}<div class="small muted">${fdt(s.at)}</div></div></li>`;
  }).join('')}</ul></div>`;
}

function documentsPanel() {
  const links = [];
  links.push(`<a href="/api/quotes/${Q.id}/preview.pdf" target="_blank" rel="noopener">Aperçu du devis (PDF)</a>`);
  if (Q.original_sha256) links.push(`<a href="/api/quotes/${Q.id}/original.pdf" target="_blank" rel="noopener">Devis envoyé pour signature</a>`);
  if (Q.signed_sha256) links.push(`<a href="/api/quotes/${Q.id}/signe.pdf" target="_blank" rel="noopener">Devis signé + certificat</a>`);
  for (const o of Q.supplier_orders) links.push(`<a href="/api/orders/${o.id}/pdf" target="_blank" rel="noopener">Bon de commande ${esc(o.number)} — ${esc(o.supplier_name)}</a>${o.sent_at ? '' : ' <span class="badge err">non envoyé</span>'}`);
  for (const i of Q.invoices) links.push(`<a href="/api/invoices/${i.id}/pdf" target="_blank" rel="noopener">Facture ${i.kind === 'acompte' ? "d'acompte" : 'de solde'} ${esc(i.number)} — ${money(i.amount_due)}</a> ${badge(i.status === 'payee' ? 'payee' : 'acompte_attendu', i.status === 'payee' ? 'Payée' : 'À encaisser')}`);
  return `<div class="card docs"><h2>Documents</h2>${links.map((l) => `<div>${l}</div>`).join('')}</div>`;
}

function statusNotice() {
  const s = Q.status;
  if (s === 'brouillon') return `<div class="notice">Rédigez le devis (ou faites-le rédiger par Claude), vérifiez l'aperçu PDF, puis cliquez sur <strong>« Le client accepte : envoyer pour signature »</strong>. La fiche client ne sera créée qu'à la signature.</div>`;
  if (s === 'attente_signature') return `<div class="notice">Envoyé pour signature le ${fdt(Q.sent_for_signature_at)} à <strong>${esc(Q.prospect.email)}</strong>. Dès que le client signe, l'agent crée sa fiche, commande le matériel et envoie la facture d'acompte. <br><span class="small">Lien de signature : <a href="${esc(Q.sign_url)}" target="_blank" rel="noopener">${esc(Q.sign_url)}</a></span></div>`;
  if (s === 'signe') return '<div class="notice warn">Devis signé : des étapes automatiques restent à terminer (voir ci-dessous).</div>';
  if (s === 'acompte_attendu') return `<div class="notice">Signé le ${fdt(Q.signed_at)} par ${esc(Q.signature?.name)}. <strong>En attente de l'acompte</strong> : aucun chantier ne démarre avant son encaissement.</div>`;
  if (s === 'travaux') return `<div class="notice ok">Acompte encaissé le ${fdate(Q.deposit_paid_at)} : <strong>les travaux peuvent commencer.</strong> Une fois l'installation terminée, cliquez sur « Installation terminée ».</div>`;
  if (s === 'solde_attendu') return `<div class="notice">Installation terminée le ${fdate(Q.installed_at)}. Facture de solde envoyée, client classé « installé ». En attente du règlement du solde.</div>`;
  if (s === 'solde') return `<div class="notice ok">Dossier soldé le ${fdt(Q.closed_at)}. Pensez à proposer un contrat d'entretien.</div>`;
  if (s === 'refuse') return '<div class="notice warn">Devis classé sans suite.</div>';
  return '';
}

function actionButtons() {
  const s = Q.status;
  const b = [];
  if (s === 'brouillon') {
    b.push('<button type="button" class="primary" data-act="save">Enregistrer</button>');
    b.push('<button type="button" data-act="preview">Aperçu PDF</button>');
    b.push('<button type="button" class="accent" data-act="send">✓ Le client accepte : envoyer pour signature</button>');
  }
  if (s === 'attente_signature') {
    b.push('<button type="button" data-act="copy">Copier le lien de signature</button>');
    b.push('<button type="button" data-act="draft">Repasser en brouillon</button>');
  }
  if (s === 'acompte_attendu') b.push('<button type="button" class="ok" data-act="deposit">Acompte encaissé</button>');
  if (s === 'travaux') b.push('<button type="button" class="accent" data-act="installed">Installation terminée : envoyer le solde</button>');
  if (s === 'solde_attendu') b.push('<button type="button" class="ok" data-act="balance">Solde encaissé</button>');
  if (Object.values(Q.automation || {}).some((x) => x && !x.done)) b.push('<button type="button" class="accent" data-act="retry">Relancer les étapes en échec</button>');
  if (['brouillon', 'attente_signature'].includes(s)) b.push('<button type="button" class="danger" data-act="refuse">Sans suite</button>');
  if (s === 'refuse') b.push('<button type="button" data-act="draft">Repasser en brouillon</button>');
  b.push('<button type="button" data-act="duplicate">Dupliquer</button>');
  if (['brouillon', 'refuse'].includes(s) && !Q.invoices.length) b.push('<button type="button" class="danger" data-act="delete">Supprimer</button>');
  return b.join('');
}

function renderQuote() {
  const p = Q.prospect || {};
  const editable = Q.status === 'brouillon';
  const m = Q.materiel || { items: [] };
  const t = Q.travaux || { phases: [] };
  const c = Q.conditions || {};
  const l = Q.letter || {};
  app.innerHTML = `
  <div class="status-bar"><h1>Devis N° ${esc(Q.number)}</h1>${badge(Q.status)}<span class="spacer" style="flex:1"></span><a href="#/devis" class="btn small">← Tous les devis</a></div>
  ${statusNotice()}
  <div class="actions" style="margin-bottom:16px">${actionButtons()}</div>
  <div class="layout">
    <form id="editor" autocomplete="off">
      ${editable ? `<div class="card ai-box"><h2>Rédiger avec Claude</h2>
        <p class="small muted">Collez vos notes de visite technique (pièces, surfaces, matériel envisagé, emplacement des groupes, contraintes, prix connus). Claude rédige le devis au format FRE2G ; vous relisez avant l'envoi.</p>
        <textarea id="ai-notes" placeholder="Ex. : Mme Bellaiche, Alternative Finance, 1 bd du Montparnasse 75006. Bureaux pro. Grand bureau 25 m² : monosplit Daikin Stylish 5 kW, groupe en toiture, prise existante. Bureaux du fond : multisplit 2MXM40 sur balcon + FTXA25 + CTXA15. 2,5 jours de MO à 900 €/j…"></textarea>
        <p style="margin:10px 0 0"><button type="button" class="primary" id="ai-go" ${ME.ai_enabled ? '' : 'disabled'}>Rédiger le devis</button>
        ${ME.ai_enabled ? '' : '<span class="small muted"> Ajoutez ANTHROPIC_API_KEY dans le fichier .env pour activer Claude.</span>'}</p>
        <div id="ai-out"></div></div>` : ''}

      <div class="card"><h2>Client</h2><div class="grid g4">
        ${select('p.kind', 'Type', p.kind || 'particulier', [['particulier', 'Particulier'], ['professionnel', 'Professionnel']])}
        ${select('p.civility', 'Civilité', p.civility || '', [['', '—'], ['Mme', 'Mme'], ['M.', 'M.']])}
        ${field('p.first_name', 'Prénom', p.first_name)}${field('p.last_name', 'Nom', p.last_name)}
        ${field('p.company', 'Société', p.company, { cls: 'span2' })}${field('p.email', 'E-mail (pour la signature)', p.email, { type: 'email', cls: 'span2' })}
        ${field('p.phone', 'Téléphone', p.phone)}${field('p.address', 'Adresse', p.address, { cls: 'span2' })}${field('p.postal_code', 'Code postal', p.postal_code)}
        ${field('p.city', 'Ville', p.city)}${field('p.siret', 'SIRET (pro)', p.siret)}${field('p.vat_number', 'N° TVA (pro)', p.vat_number, { cls: 'span2' })}
      </div>${Q.client ? `<p class="small muted" style="margin:10px 0 0">Fiche client : <a href="#/clients">${esc(Q.client.code)}</a></p>` : ''}</div>

      <div class="card"><h2>Devis</h2><div class="grid g4">
        ${field('date', 'Date', Q.date, { type: 'date' })}${field('validity_days', 'Validité (jours)', Q.validity_days, { type: 'number', attrs: 'min="1"' })}
        ${field('deposit_pct', 'Acompte à la commande (%)', Q.deposit_pct, { type: 'number', attrs: 'min="0" max="100" step="any"' })}<div></div>
        ${field('object', 'Objet', Q.object, { cls: 'span2' })}${field('site_address', 'Adresse des travaux', Q.site_address, { cls: 'span2' })}
      </div></div>

      <div class="card"><h2>Lettre d'accompagnement</h2><div class="grid">
        ${field('l.greeting', 'Formule d\'appel (vide = automatique)', l.greeting, { attrs: 'placeholder="Madame,"' })}
        ${area('l.body', 'Corps de la lettre (un paragraphe par ligne)', l.body, { rows: 7 })}
        ${area('l.closing', 'Conclusion', l.closing, { rows: 2 })}
      </div></div>

      <div class="card"><h2>Matériel proposé</h2>
        ${area('m.intro', 'Introduction', m.intro, { rows: 2 })}
        <div class="scroll" style="margin-top:10px"><table class="edit"><thead><tr><th>Qté</th><th>Référence</th><th>Désignation</th><th>Caractéristiques</th><th>Fournisseur</th><th>Prix d'achat</th><th></th></tr></thead>
        <tbody id="mat-body">${(m.items || []).map((it, i) => matRow(i, it)).join('')}</tbody></table></div>
        <p><button type="button" class="small" id="add-mat">+ Ajouter un équipement</button> <span class="small muted">Le fournisseur reçoit la commande à la signature (références et quantités, jamais vos prix de vente).</span></p>
        ${area('m.note', 'Note technique', m.note, { rows: 2 })}
      </div>

      <div class="card"><h2>Description des travaux</h2>
        ${area('t.intro', 'Introduction', t.intro, { rows: 2 })}
        <div id="phases" style="margin-top:10px">${(t.phases || []).map((ph, i) => phaseBlock(i, ph)).join('')}</div>
        <button type="button" class="small" id="add-phase">+ Ajouter une phase</button>
      </div>

      <div class="card"><h2>Montant</h2>
        <div class="scroll"><table class="edit"><thead><tr><th>Poste</th><th>Qté</th><th>P.U. HT</th><th>TVA</th><th class="num">Total HT</th><th></th></tr></thead>
        <tbody id="line-body">${(Q.lines || []).map((ln, i) => lineRow(i, ln)).join('')}</tbody></table></div>
        <p><button type="button" class="small" id="add-line">+ Ajouter une ligne</button></p>
        <table class="totals" id="totals"></table>
        ${field('c.vat_note', 'Note sur la TVA', c.vat_note, { attrs: 'placeholder="Le taux de TVA de 20 % s\'applique car…"' })}
      </div>

      <div class="card"><h2>Conditions</h2><div class="grid">
        ${area('c.delai', 'Délai', c.delai, { rows: 2 })}${area('c.non_compris', 'Non compris', c.non_compris, { rows: 2 })}${area('c.garantie', 'Garantie', c.garantie, { rows: 2 })}
        ${area('notes_internes', 'Notes internes (jamais sur le devis)', Q.notes_internes, { rows: 2 })}
      </div></div>
      ${editable ? '<div class="actions"><button type="button" class="primary" data-act="save">Enregistrer</button></div>' : ''}
    </form>
    <aside>
      ${automationPanel()}
      ${documentsPanel()}
      ${Q.signature ? `<div class="card"><h2>Signature</h2><p>${esc(Q.signature.name)}${Q.signature.quality ? ` — ${esc(Q.signature.quality)}` : ''}<br><span class="small muted">${esc(Q.signature.signed_at_text)} · IP ${esc(Q.signature.ip)}${Q.signature.otp_verified ? ' · e-mail vérifié par code' : ''}</span></p>
        <img src="${esc(Q.signature.image)}" alt="Signature" style="max-width:100%;max-height:90px;background:#fff;border-radius:8px"><p class="small muted" style="word-break:break-all">SHA-256 du PDF signé : ${esc(Q.signed_sha256 || '')}</p></div>` : ''}
      <div class="card"><h2>Journal</h2><ul class="timeline">${Q.events.map((e) => `<li class="${esc(e.level)}"><div class="at">${fdt(e.at)}</div>${esc(e.message)}</li>`).join('') || '<li class="muted">—</li>'}</ul></div>
      <div class="card"><h2>E-mails</h2><ul class="timeline">${Q.emails.map((e) => `<li class="${e.status === 'erreur' ? 'error' : 'success'}"><div class="at">${fdt(e.at)} · ${esc(e.recipient)}</div>${esc(e.subject)}${e.error ? `<div class="small">${esc(e.error)}</div>` : ''}</li>`).join('') || '<li class="muted">Aucun e-mail envoyé.</li>'}</ul></div>
    </aside>
  </div>`;

  const form = $('#editor');
  if (!editable) $$('input, select, textarea', form).forEach((el) => { el.disabled = true; });
  $$('#add-mat, #add-phase, #add-line, [data-del-mat], [data-del-line], [data-del-phase]', form).forEach((el) => { el.hidden = !editable; });
  updateTotals();
  form.addEventListener('input', (e) => { if (e.target.closest('#line-body')) updateTotals(); });
  $('#add-mat')?.addEventListener('click', () => { collect(); Q.materiel.items.push({ qty: 1 }); renderQuote(); });
  $('#add-line')?.addEventListener('click', () => { collect(); Q.lines.push({ qty: 1, vat_rate: 20 }); renderQuote(); });
  $('#add-phase')?.addEventListener('click', () => { collect(); Q.travaux.phases.push({ title: '', steps: [] }); renderQuote(); });
  form.addEventListener('click', (e) => {
    const t = e.target;
    if (t.dataset.delMat !== undefined) { collect(); Q.materiel.items.splice(Number(t.dataset.delMat), 1); renderQuote(); }
    if (t.dataset.delLine !== undefined) { collect(); Q.lines.splice(Number(t.dataset.delLine), 1); renderQuote(); }
    if (t.dataset.delPhase !== undefined) { collect(); Q.travaux.phases.splice(Number(t.dataset.delPhase), 1); renderQuote(); }
  });
  $$('[data-act]').forEach((btn) => btn.addEventListener('click', () => onAction(btn.dataset.act, btn)));
  $('#ai-go')?.addEventListener('click', aiDraft);
}

function updateTotals() {
  const rows = $$('#line-body tr');
  const groups = new Map();
  let ht = 0;
  for (const tr of rows) {
    const lt = round2(numVal($('[data-f=qty]', tr).value) * numVal($('[data-f=unit_price]', tr).value));
    $('[data-lt]', tr).textContent = money(lt);
    const rate = numVal($('[data-f=vat_rate]', tr).value);
    groups.set(rate, round2((groups.get(rate) || 0) + lt));
    ht = round2(ht + lt);
  }
  let vat = 0;
  const vatRows = [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([r, base]) => { const a = round2((base * r) / 100); vat = round2(vat + a); return `<tr><td>TVA ${String(r).replace('.', ',')} %</td><td class="num">${money(a)}</td></tr>`; }).join('');
  const ttc = round2(ht + vat);
  const pct = numVal($('[name=deposit_pct]')?.value);
  $('#totals').innerHTML = `<tr><td>Total HT</td><td class="num">${money(ht)}</td></tr>${vatRows}<tr class="grand"><td>Total TTC</td><td class="num">${money(ttc)}</td></tr>
    ${pct > 0 ? `<tr><td class="muted">Acompte ${pct} %</td><td class="num muted">${money(round2((ttc * pct) / 100))}</td></tr>` : ''}`;
}

// Lit le formulaire dans Q
function collect() {
  const form = $('#editor');
  const val = (n) => form.elements.namedItem(n)?.value ?? '';
  Q.prospect = Object.fromEntries(['kind', 'civility', 'first_name', 'last_name', 'company', 'email', 'phone', 'address', 'postal_code', 'city', 'siret', 'vat_number'].map((k) => [k, val(`p.${k}`)]));
  Object.assign(Q, { date: val('date'), validity_days: val('validity_days'), deposit_pct: val('deposit_pct'), object: val('object'), site_address: val('site_address'), notes_internes: val('notes_internes') });
  Q.letter = { greeting: val('l.greeting'), body: val('l.body'), closing: val('l.closing') };
  const rowData = (tr) => Object.fromEntries($$('[data-f]', tr).map((el) => [el.dataset.f, el.value]));
  Q.materiel = { intro: val('m.intro'), note: val('m.note'), items: $$('#mat-body tr').map(rowData) };
  Q.travaux = { intro: val('t.intro'), phases: $$('#phases .phase').map((ph) => ({ title: $('[data-f=title]', ph).value, steps: $('[data-f=steps]', ph).value.split('\n').map((s) => s.trim()).filter(Boolean) })) };
  Q.lines = $$('#line-body tr').map(rowData);
  Q.conditions = { delai: val('c.delai'), non_compris: val('c.non_compris'), garantie: val('c.garantie'), vat_note: val('c.vat_note') };
  return Q;
}

async function save(silent) {
  collect();
  const body = { prospect: Q.prospect, date: Q.date, validity_days: Q.validity_days, deposit_pct: Q.deposit_pct, object: Q.object, site_address: Q.site_address, notes_internes: Q.notes_internes, letter: Q.letter, materiel: Q.materiel, travaux: Q.travaux, lines: Q.lines, conditions: Q.conditions };
  Q = await api(`/quotes/${Q.id}`, { method: 'PUT', body });
  if (!silent) toast('Devis enregistré');
  return Q;
}

async function onAction(act, btn) {
  const id = Q.id;
  if (act === 'save') return run(btn, async () => { await save(); renderQuote(); });
  if (act === 'preview') {
    const w = window.open('', '_blank');
    await run(btn, async () => { await save(true); renderQuote(); });
    if (w) w.location = `/api/quotes/${id}/preview.pdf?t=${Date.now()}`;
    return;
  }
  if (act === 'send') {
    await run(null, () => save(true));
    const ok = await modal('Envoyer pour signature', `<p>Le client a donné son accord ? L'agent envoie le devis N° <strong>${esc(Q.number)}</strong> (${money(Q.totals.ttc)} TTC) à <strong>${esc(Q.prospect.email || '— e-mail manquant —')}</strong>, avec un lien de signature électronique.</p>
      <p class="small muted">Le devis est ensuite figé. Après la signature : fiche client, commande fournisseur et facture d'acompte partent automatiquement.</p>`, { ok: 'Envoyer', okClass: 'accent' });
    if (!ok) { renderQuote(); return; }
    return run(btn, async () => { Q = await api(`/quotes/${id}/send-for-signature`, { body: {} }); renderQuote(); }, 'Devis envoyé pour signature');
  }
  if (act === 'copy') { await navigator.clipboard?.writeText(Q.sign_url); toast('Lien copié'); return; }
  if (act === 'draft') {
    if (!(await modal('Repasser en brouillon', '<p>Le lien de signature déjà envoyé au client sera désactivé. Il faudra renvoyer le devis.</p>', { ok: 'Repasser en brouillon' }))) return;
    return run(btn, async () => { Q = await api(`/quotes/${id}/back-to-draft`, { body: {} }); renderQuote(); });
  }
  if (act === 'refuse') {
    const r = await modal('Classer sans suite', '<label for="m-reason">Raison (prix, délai, concurrent…)</label><input id="m-reason" name="reason">', { ok: 'Classer sans suite', okClass: 'danger' });
    if (!r) return;
    return run(btn, async () => { Q = await api(`/quotes/${id}/refuse`, { body: r }); renderQuote(); });
  }
  if (act === 'deposit' || act === 'balance') {
    const inv = Q.invoices.find((i) => i.kind === (act === 'deposit' ? 'acompte' : 'solde'));
    const r = await modal(act === 'deposit' ? 'Acompte encaissé' : 'Solde encaissé', `<p>Facture ${esc(inv?.number || '')} : <strong>${money(inv?.amount_due)}</strong></p>
      <div class="grid g2"><div><label for="m-date">Date d'encaissement</label><input id="m-date" type="date" name="date" value="${today()}" required></div>
      <div><label for="m-method">Mode</label><select id="m-method" name="method">${Object.entries(METHODS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
      <div class="span2"><label for="m-ref">Référence (n° de virement, de chèque…)</label><input id="m-ref" name="reference"></div></div>
      ${act === 'deposit' ? '<p class="small muted">Le dossier passe en « Travaux à réaliser » : le chantier peut être planifié.</p>' : ''}`, { ok: 'Enregistrer', okClass: 'ok' });
    if (!r) return;
    return run(btn, async () => { Q = await api(`/quotes/${id}/${act === 'deposit' ? 'deposit-paid' : 'balance-paid'}`, { body: r }); renderQuote(); }, 'Encaissement enregistré');
  }
  if (act === 'installed') {
    const r = await modal('Installation terminée', `<label for="m-date">Date de mise en service</label><input id="m-date" type="date" name="date" value="${today()}" required>
      <p class="small muted">L'agent émet et envoie aussitôt la facture du reste à payer (${money(Q.totals.ttc - Q.invoices.filter((i) => i.kind === 'acompte').reduce((s, i) => s + i.amount_due, 0))} TTC) et classe le client dans « Clients installés ».</p>`, { ok: 'Envoyer la facture de solde', okClass: 'accent' });
    if (!r) return;
    return run(btn, async () => { Q = await api(`/quotes/${id}/installation-done`, { body: r }); renderQuote(); }, 'Facture de solde envoyée');
  }
  if (act === 'retry') return run(btn, async () => { SUPPLIERS = await api('/suppliers'); Q = await api(`/quotes/${id}/retry`, { body: {} }); renderQuote(); }, 'Étapes relancées');
  if (act === 'duplicate') return run(btn, async () => { const c = await api(`/quotes/${id}/duplicate`, { body: {} }); location.hash = `#/devis/${c.id}`; }, 'Copie créée');
  if (act === 'delete') {
    if (!(await modal('Supprimer le devis', `<p>Supprimer définitivement le devis N° ${esc(Q.number)} ?</p>`, { ok: 'Supprimer', okClass: 'danger' }))) return;
    return run(btn, async () => { await api(`/quotes/${id}`, { method: 'DELETE' }); location.hash = '#/devis'; }, 'Devis supprimé');
  }
}

async function aiDraft() {
  const notes = $('#ai-notes').value;
  const btn = $('#ai-go');
  collect();
  const hasContent = Q.lines.some((l) => l.designation) || Q.materiel.items.some((i) => i.reference || i.designation) || Q.letter.body;
  if (hasContent && !(await modal('Remplacer le contenu ?', '<p>Le devis contient déjà du texte. Claude va remplacer la lettre, le matériel, les travaux, le chiffrage et les conditions. Les coordonnées du client déjà saisies sont conservées.</p>', { ok: 'Remplacer' }))) return;
  btn.textContent = 'Claude rédige le devis… (environ une minute)';
  const draft = await run(btn, () => api('/ai/draft', { body: { notes } }));
  btn.textContent = 'Rédiger le devis';
  if (!draft) return;
  // Les coordonnées déjà saisies l'emportent sur celles déduites des notes
  const p = { ...Q.prospect };
  for (const [k, v] of Object.entries(draft.prospect || {})) if (!p[k] && v) p[k] = v;
  Object.assign(Q, {
    prospect: p, object: draft.object || Q.object, site_address: draft.site_address || Q.site_address,
    letter: draft.letter, materiel: draft.materiel, travaux: draft.travaux, lines: draft.lines,
    conditions: { ...Q.conditions, ...Object.fromEntries(Object.entries(draft.conditions).filter(([, v]) => v)) }
  });
  renderQuote();
  await run(null, () => save(true));
  renderQuote();
  const points = draft.points_a_verifier || [];
  $('#ai-notes').value = notes;
  $('#ai-out').innerHTML = points.length ? `<div class="notice warn" style="margin-top:12px"><strong>À vérifier avant l'envoi :</strong><ul>${points.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '<div class="notice ok" style="margin-top:12px">Devis rédigé. Relisez-le avant l\'envoi.</div>';
  toast('Devis rédigé par Claude et enregistré');
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
async function viewClients(tab) {
  const status = tab === 'installe' ? 'installe' : tab === 'tous' ? '' : 'en_cours';
  const rows = await api(`/clients${status ? `?status=${status}` : ''}`);
  app.innerHTML = `<h1>Clients</h1>
    <p class="muted">Une fiche client est créée automatiquement à la signature d'un devis. Les prospects restent sur leurs devis tant qu'ils n'ont pas signé.</p>
    <div class="pills"><button type="button" data-t="en_cours" class="${tab === 'en_cours' ? 'active' : ''}">Clients en cours</button><button type="button" data-t="installe" class="${tab === 'installe' ? 'active' : ''}">Clients installés</button><button type="button" data-t="tous" class="${tab === 'tous' ? 'active' : ''}">Tous</button></div>
    <div class="card scroll"><table class="list"><thead><tr><th>Code</th><th>Client</th><th>Contact</th><th>Ville</th><th class="num">Signé TTC</th><th class="num">Reste dû</th><th>Statut</th></tr></thead><tbody>
    ${rows.map((c) => `<tr class="click" data-id="${c.id}"><td>${esc(c.code)}</td><td><strong>${esc(c.name)}</strong></td><td>${esc(c.email)}<br><span class="muted small">${esc(c.phone)}</span></td><td>${esc(c.city)}</td>
      <td class="num">${money(c.signed_ttc)}</td><td class="num">${money(c.due_ttc)}</td><td>${badge(c.status, c.status === 'installe' ? `Installé le ${fdate(c.installed_at)}` : 'En cours')}</td></tr>`).join('')}
    </tbody></table>${rows.length ? '' : '<p class="empty">Aucun client dans cette liste.</p>'}</div>`;
  $$('.pills button').forEach((b) => b.addEventListener('click', () => { location.hash = `#/clients/${b.dataset.t}`; }));
  $$('tr.click').forEach((tr) => tr.addEventListener('click', () => clientModal(Number(tr.dataset.id))));
}

async function clientModal(id) {
  const c = await api(`/clients/${id}`);
  const fields = [['civility', 'Civilité'], ['first_name', 'Prénom'], ['last_name', 'Nom'], ['company', 'Société'], ['email', 'E-mail'], ['phone', 'Téléphone'], ['address', 'Adresse'], ['postal_code', 'Code postal'], ['city', 'Ville'], ['siret', 'SIRET'], ['vat_number', 'N° TVA']];
  const r = await modal(`${c.code} — ${c.name}`, `<div class="grid g2">${fields.map(([k, l]) => `<div><label for="c-${k}">${l}</label><input id="c-${k}" name="${k}" value="${esc(c[k])}"></div>`).join('')}
    <div class="span2"><label for="c-notes">Notes</label><textarea id="c-notes" name="notes">${esc(c.notes)}</textarea></div></div>
    <h3>Dossiers</h3>${c.quotes.map((q) => `<div><a href="#/devis/${q.id}" data-close>Devis ${esc(q.number)}</a> — ${money(q.total_ttc)} — ${badge(q.status)}</div>`).join('')}
    <h3>Factures</h3>${c.invoices.map((i) => `<div><a href="/api/invoices/${i.id}/pdf" target="_blank" rel="noopener">${esc(i.number)}</a> — ${i.kind === 'acompte' ? 'acompte' : 'solde'} — ${money(i.amount_due)} — ${i.status === 'payee' ? 'payée' : `à payer avant le ${fdate(i.due_date)}`}</div>`).join('') || '<div class="muted">Aucune</div>'}`, { ok: 'Enregistrer', cancel: 'Fermer' });
  if (r) await run(null, () => api(`/clients/${id}`, { method: 'PUT', body: r }), 'Fiche client enregistrée');
}
document.addEventListener('click', (e) => { if (e.target.matches('[data-close]')) e.target.closest('.modal-bg')?.remove(); });

// ---------------------------------------------------------------------------
// Factures
// ---------------------------------------------------------------------------
async function viewInvoices() {
  const rows = await api('/invoices');
  const t = today();
  app.innerHTML = `<h1>Factures</h1><div class="card scroll"><table class="list"><thead><tr><th>N°</th><th>Type</th><th>Date</th><th>Client</th><th>Devis</th><th class="num">Montant TTC</th><th>Échéance</th><th>Statut</th></tr></thead><tbody>
    ${rows.map((i) => {
      const late = i.status === 'emise' && i.due_date < t;
      return `<tr><td><a href="/api/invoices/${i.id}/pdf" target="_blank" rel="noopener"><strong>${esc(i.number)}</strong></a></td><td>${i.kind === 'acompte' ? 'Acompte' : 'Solde'}</td><td>${fdate(i.date)}</td><td>${esc(i.client_name)}</td>
      <td><a href="#/devis/${i.quote_id}">${esc(i.quote_number)}</a></td><td class="num">${money(i.amount_due)}</td><td>${fdate(i.due_date)}</td>
      <td>${i.status === 'payee' ? badge('payee', `Payée le ${fdate(i.paid_at)}`) : late ? '<span class="badge err">En retard</span>' : badge('acompte_attendu', 'À encaisser')}</td></tr>`;
    }).join('')}</tbody></table>${rows.length ? '' : '<p class="empty">Aucune facture : elles sont émises automatiquement à la signature (acompte) et à la fin de l\'installation (solde).</p>'}</div>`;
}

// ---------------------------------------------------------------------------
// Fournisseurs
// ---------------------------------------------------------------------------
async function viewSuppliers() {
  SUPPLIERS = await api('/suppliers');
  app.innerHTML = `<div class="toolbar"><h1 style="margin:0">Fournisseurs</h1><span class="spacer"></span><button type="button" class="primary" id="add-sup">+ Ajouter un fournisseur</button></div>
    <p class="muted">À la signature d'un devis, l'agent envoie à chaque fournisseur un bon de commande avec le matériel qui lui est affecté dans le devis.</p>
    <div class="card scroll"><table class="list"><thead><tr><th>Nom</th><th>E-mail des commandes</th><th>Contact</th><th>Téléphone</th><th>N° de compte FRE2G</th></tr></thead><tbody>
    ${SUPPLIERS.map((s) => `<tr class="click" data-id="${s.id}"><td><strong>${esc(s.name)}</strong></td><td>${s.email ? esc(s.email) : '<span class="badge err">manquant</span>'}</td><td>${esc(s.contact)}</td><td>${esc(s.phone)}</td><td>${esc(s.account_number)}</td></tr>`).join('')}
    </tbody></table>${SUPPLIERS.length ? '' : '<p class="empty">Ajoutez vos fournisseurs (grossistes, distributeurs Daikin, Airwell…).</p>'}</div>`;
  $('#add-sup').addEventListener('click', () => supplierModal());
  $$('tr.click').forEach((tr) => tr.addEventListener('click', () => supplierModal(SUPPLIERS.find((s) => s.id === Number(tr.dataset.id)))));
}

async function supplierModal(s = {}) {
  const f = [['name', 'Nom'], ['email', 'E-mail des commandes'], ['contact', 'Contact'], ['phone', 'Téléphone'], ['account_number', 'N° de compte FRE2G']];
  const r = await modal(s.id ? s.name : 'Nouveau fournisseur', `<div class="grid g2">${f.map(([k, l]) => `<div><label for="s-${k}">${l}</label><input id="s-${k}" name="${k}" value="${esc(s[k])}" ${k === 'name' ? 'required' : ''}${k === 'email' ? ' type="email"' : ''}></div>`).join('')}
    <div class="span2"><label for="s-notes">Notes</label><textarea id="s-notes" name="notes">${esc(s.notes)}</textarea></div></div>`, { ok: 'Enregistrer' });
  if (!r) return;
  await run(null, () => api(s.id ? `/suppliers/${s.id}` : '/suppliers', { method: s.id ? 'PUT' : 'POST', body: r }), 'Fournisseur enregistré');
  viewSuppliers();
}

// ---------------------------------------------------------------------------
// Paramètres
// ---------------------------------------------------------------------------
async function viewSettings() {
  const s = await api('/settings');
  const f = (k, l, o = {}) => field(k, l, s[k], o);
  const a = (k, l, o = {}) => area(k, l, s[k], o);
  const yes = (k, l) => `<label class="check" style="display:flex;gap:8px;align-items:center;font-size:14px;color:var(--text)"><input type="checkbox" name="${k}" ${s[k] === '1' ? 'checked' : ''}> ${esc(l)}</label>`;
  app.innerHTML = `<h1>Paramètres</h1><form id="settings">
    <div class="card"><h2>Entreprise (mentions des devis et factures)</h2><div class="grid g4">
      ${f('company_name', 'Nom')}${f('company_legal_form', 'Forme juridique')}${f('company_capital', 'Capital')}${f('company_signatory', 'Signature des courriers')}
      ${f('company_address', 'Adresse', { cls: 'span2' })}${f('company_postal_code', 'Code postal')}${f('company_city', 'Ville')}
      ${f('company_phone', 'Téléphone')}${f('company_email', 'E-mail (réponses des clients)')}${f('company_website', 'Site web')}${f('company_siret', 'SIRET')}
      ${f('company_vat_number', 'N° TVA intracommunautaire')}${f('company_rcs', 'RCS')}${f('company_ape', 'Code APE')}<div></div>
      ${f('company_insurance', 'Assurance décennale (assureur, n° de contrat, zone couverte) — obligatoire', { cls: 'span2' })}${f('delivery_address', 'Adresse de livraison du matériel (vide = chantier)', { cls: 'span2' })}
    </div></div>
    <div class="card"><h2>Banque (affichée sur les factures)</h2><div class="grid g3">${f('bank_name', 'Banque')}${f('bank_iban', 'IBAN')}${f('bank_bic', 'BIC')}</div></div>
    <div class="card"><h2>Numérotation et règles</h2><div class="grid g4">
      ${f('quote_next_number', 'Prochain n° de devis')}${f('invoice_prefix', 'Préfixe des factures ({AAAA} = année)')}${f('invoice_digits', 'Chiffres du n° de facture', { type: 'number' })}${f('order_prefix', 'Préfixe des bons de commande')}
      ${f('quote_validity_days', 'Validité des devis (jours)', { type: 'number' })}${f('deposit_pct', 'Acompte par défaut (%)', { type: 'number' })}
      ${f('payment_days_particulier', 'Délai de paiement particulier (jours, 0 = à réception)', { type: 'number' })}${f('payment_days_professionnel', 'Délai de paiement professionnel (jours)', { type: 'number' })}
    </div><div style="margin-top:10px">${yes('signature_otp', 'Exiger un code reçu par e-mail avant la signature (recommandé)')}${yes('notify_on_deposit', "Prévenir le client par e-mail quand l'acompte est encaissé")}</div></div>
    <div class="card"><h2>Textes par défaut des devis</h2><div class="grid">
      ${a('default_closing', 'Conclusion de la lettre')}${a('default_delai', 'Délai')}${a('default_non_compris', 'Non compris')}${a('default_garantie', 'Garantie')}${a('late_penalties', 'Mentions de retard de paiement (factures)')}
    </div></div>
    <div class="card"><h2>Tarifs pour Claude</h2>${a('ai_price_list', 'Grille tarifaire interne (prix de vente HT), utilisée par Claude pour chiffrer les devis', { rows: 8 })}
      <p class="small muted">Exemple : « Main d'œuvre : 900 € HT/jour (équipe de 2) — Liaison frigorifique cuivre isolée avec câble : 500 € HT — Disjoncteur dans le tableau : 180 € HT — Pompe de relevage : 250 € HT ». Sans tarif, Claude laisse les prix à 0 et vous le signale.</p></div>
    <div class="actions"><button type="submit" class="primary">Enregistrer les paramètres</button></div></form>
    <div class="card" style="margin-top:16px"><h2>Tester l'envoi des e-mails</h2><p class="muted small">Mode actuel : ${ME.mail_mode === 'smtp' ? 'envoi réel (SMTP)' : 'essai — e-mails enregistrés dans data/outbox'}${ME.notify ? ` · notifications internes à ${esc(ME.notify)}` : ''}.</p>
      <div class="toolbar"><input id="test-to" type="email" placeholder="votre@adresse.fr" style="max-width:300px"><button type="button" id="test-mail">Envoyer un e-mail de test</button></div></div>`;
  $('#settings').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    data.signature_otp = e.target.signature_otp.checked ? '1' : '0';
    data.notify_on_deposit = e.target.notify_on_deposit.checked ? '1' : '0';
    await run(e.submitter, () => api('/settings', { method: 'PUT', body: data }), 'Paramètres enregistrés');
  });
  $('#test-mail').addEventListener('click', (e) => run(e.target, () => api('/mail/test', { body: { to: $('#test-to').value } }), 'E-mail de test envoyé'));
}

// ---------------------------------------------------------------------------
boot().catch((e) => { if (e.message !== 'auth') app.innerHTML = `<div class="notice err">${esc(e.message)}</div>`; });
