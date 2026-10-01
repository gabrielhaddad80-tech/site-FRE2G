'use strict';

const Handlebars = require('handlebars');
const { computeTotals } = require('../public/js/calc');
const { getSettings } = require('./db');

const hb = Handlebars.create();

const moneyFmt = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const numFmt = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 });

hb.registerHelper('money', (v) => moneyFmt.format(Number(v) || 0));
hb.registerHelper('number', (v) => numFmt.format(Number(v) || 0));
hb.registerHelper('percent', (v) => `${numFmt.format(Number(v) || 0)} %`);
hb.registerHelper('date', (v) => {
  if (!v) return '';
  const [y, m, d] = String(v).slice(0, 10).split('-');
  return d ? `${d}/${m}/${y}` : v;
});
hb.registerHelper('nl2br', (v) => new hb.SafeString(hb.escapeExpression(v || '').replace(/\r?\n/g, '<br>')));
hb.registerHelper('eq', (a, b) => a === b);
hb.registerHelper('ne', (a, b) => a !== b);
hb.registerHelper('gt', (a, b) => Number(a) > Number(b));
hb.registerHelper('or', (...args) => args.slice(0, -1).some(Boolean));
hb.registerHelper('and', (...args) => args.slice(0, -1).every(Boolean));
hb.registerHelper('upper', (v) => String(v || '').toUpperCase());

const TYPE_LABELS = { devis: 'Devis', facture: 'Facture', avoir: 'Avoir' };

function clientDisplay(c) {
  if (!c) return {};
  const person = [c.civility, c.first_name, c.last_name].filter(Boolean).join(' ');
  return {
    ...c,
    display_name: c.company || person,
    contact_name: c.company ? person : '',
    full_address: [c.address, [c.postal_code, c.city].filter(Boolean).join(' '), c.country && c.country !== 'France' ? c.country : '']
      .filter(Boolean).join('\n')
  };
}

function buildContext(db, doc) {
  const settings = getSettings(db);
  const lines = db.prepare('SELECT * FROM document_lines WHERE document_id = ? ORDER BY position, id').all(doc.id);
  const paid = db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE document_id = ?').get(doc.id).s;
  const vatExempt = settings.vat_exempt === '1';
  const totals = computeTotals(lines, { discount_pct: doc.discount_pct, deposit_pct: doc.deposit_pct, vat_exempt: vatExempt, paid });

  let client = doc.client_snapshot ? JSON.parse(doc.client_snapshot) : null;
  if (!client && doc.client_id) client = db.prepare('SELECT * FROM clients WHERE id = ?').get(doc.client_id);

  const source = doc.source_id ? db.prepare('SELECT id, type, number, date FROM documents WHERE id = ?').get(doc.source_id) : null;

  // Lignes enrichies + sous-totaux de section
  let sectionIndex = -1;
  const outLines = [];
  let itemCounter = 0;
  for (const l of lines) {
    if (l.kind === 'section') {
      sectionIndex++;
      outLines.push({ ...l, isSection: true, section_total: totals.sections[sectionIndex]?.total || 0 });
    } else if (l.kind === 'text') {
      outLines.push({ ...l, isText: true });
    } else {
      itemCounter++;
      const total = Math.round(l.quantity * l.unit_price * (1 - (l.discount_pct || 0) / 100) * 100) / 100;
      outLines.push({ ...l, isItem: true, index: itemCounter, total_ht: total, vat_rate: vatExempt ? 0 : l.vat_rate });
    }
  }
  // Marque la dernière ligne de chaque section pour afficher un sous-total
  for (let i = 0; i < outLines.length; i++) {
    const next = outLines[i + 1];
    if (!next || next.isSection) outLines[i].endOfSection = true;
  }
  let lastSection = null;
  for (const l of outLines) {
    if (l.isSection) lastSection = l;
    if (l.endOfSection && lastSection) { l.closing_section = lastSection.designation; l.closing_section_total = lastSection.section_total; }
  }

  const company = {
    name: settings.company_name,
    legal_form: settings.company_legal_form,
    capital: settings.company_capital,
    address: settings.company_address,
    postal_code: settings.company_postal_code,
    city: settings.company_city,
    country: settings.company_country,
    phone: settings.company_phone,
    email: settings.company_email,
    website: settings.company_website,
    siret: settings.company_siret,
    rcs: settings.company_rcs,
    ape: settings.company_ape,
    vat_number: settings.company_vat_number,
    insurance: settings.company_insurance,
    logo: settings.company_logo,
    bank_name: settings.bank_name,
    iban: settings.bank_iban,
    bic: settings.bank_bic
  };

  return {
    company,
    client: clientDisplay(client),
    doc: {
      ...doc,
      type_label: TYPE_LABELS[doc.type] || doc.type,
      number: doc.number || 'BROUILLON',
      isDraft: !doc.number
    },
    isQuote: doc.type === 'devis',
    isInvoice: doc.type === 'facture',
    isCredit: doc.type === 'avoir',
    source,
    lines: outLines,
    hasSections: totals.sections.length > 0,
    totals,
    vat_exempt: vatExempt,
    vat_exempt_mention: settings.vat_exempt_mention,
    legal_mentions: settings.legal_mentions,
    footer_text: settings.footer_text,
    colors: { primary: settings.primary_color, accent: settings.accent_color },
    template: { background: '' }
  };
}

function renderDocument(db, doc, templateOverride) {
  let tpl = templateOverride;
  if (!tpl && doc.template_id) tpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(doc.template_id);
  if (!tpl) tpl = db.prepare('SELECT * FROM templates ORDER BY is_default DESC, id LIMIT 1').get();
  const ctx = buildContext(db, doc);
  ctx.template = { background: tpl.background || '' };
  const body = hb.compile(tpl.html)(ctx);
  // Le CSS peut aussi utiliser les variables (ex. {{colors.primary}})
  const css = hb.compile(tpl.css || '')(ctx);
  return { body, css, ctx };
}

function pageHtml({ title, body, css, toolbar }) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${Handlebars.escapeExpression(title)}</title>
<link rel="icon" href="data:,">
<style>
@page { size: A4; margin: 12mm; }
body { margin: 0; }
.print-toolbar { position: sticky; top: 0; z-index: 10; display: flex; gap: 8px; padding: 10px; background: #222; font-family: system-ui, sans-serif; }
.print-toolbar button, .print-toolbar a { background: #fff; color: #222; border: 0; border-radius: 4px; padding: 6px 12px; font-size: 14px; cursor: pointer; text-decoration: none; }
@media screen { .sheet { max-width: 210mm; margin: 16px auto; background: #fff; box-shadow: 0 2px 12px rgba(0,0,0,.2); padding: 12mm; box-sizing: border-box; } html { background: #e5e5e5; } }
@media print { .print-toolbar { display: none; } }
${css}
</style>
</head>
<body>
${toolbar ? `<div class="print-toolbar"><button onclick="window.print()">Imprimer</button><a href="pdf">Télécharger en PDF</a><a href="docx">Télécharger en Word</a><a href="javascript:window.close()">Fermer</a></div>` : ''}
<div class="sheet">${body}</div>
</body>
</html>`;
}

module.exports = { renderDocument, buildContext, pageHtml, handlebars: hb };
