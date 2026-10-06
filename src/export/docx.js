'use strict';

/*
 * Export Word (.docx) d'un devis, d'une facture ou d'un avoir.
 * Document modifiable : en-tête entreprise / client, tableau des lignes, TVA, totaux, conditions,
 * mentions légales et pied de page, aux couleurs de l'entreprise (Paramètres → Apparence).
 */

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType,
  AlignmentType, ImageRun, Footer, PageNumber, TableLayoutType, VerticalAlign, HeightRule
} = require('docx');

const PAGE_W = 11906; // A4 en DXA
const MARGIN = 850;   // 1,5 cm
const CONTENT_W = PAGE_W - 2 * MARGIN;

const moneyFmt = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const numFmt = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 });
const money = (v) => moneyFmt.format(Number(v) || 0);
const num = (v) => numFmt.format(Number(v) || 0);
const pct = (v) => `${num(v)} %`;
const date = (v) => {
  if (!v) return '';
  const [y, m, d] = String(v).slice(0, 10).split('-');
  return d ? `${d}/${m}/${y}` : String(v);
};
const hex = (c, def) => (/^#?[0-9a-f]{6}$/i.test(String(c || '')) ? String(c).replace('#', '').toUpperCase() : def);

const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE };
const line = (color = 'D9DEE4') => ({ style: BorderStyle.SINGLE, size: 4, color });

function textRuns(text, opts = {}) {
  return [new TextRun({ text: String(text ?? ''), font: 'Arial', size: opts.size || 19, bold: opts.bold, italics: opts.italics, color: opts.color })];
}

// Un paragraphe par ligne de texte (pas de « \n » dans Word)
function paragraphs(text, opts = {}) {
  const lines = String(text || '').split(/\r?\n/);
  return lines.map((l) => new Paragraph({ alignment: opts.align, spacing: { after: opts.after ?? 0 }, children: textRuns(l, opts) }));
}

function cell(children, { width, shade, borders, span, align, vAlign, margins } = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    columnSpan: span,
    shading: shade ? { type: ShadingType.CLEAR, color: 'auto', fill: shade } : undefined,
    borders,
    verticalAlign: vAlign || VerticalAlign.TOP,
    margins: margins || { top: 60, bottom: 60, left: 100, right: 100 },
    children: (Array.isArray(children) ? children : [children]).map((c) => (typeof c === 'string' ? new Paragraph({ alignment: align, children: textRuns(c) }) : c))
  });
}

function logoRun(dataUrl) {
  const m = /^data:image\/(png|jpe?g|gif|bmp);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  const type = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  // Dimensions réelles (PNG / JPEG) pour garder les proportions, 160 × 70 px maximum
  let w = 160, h = 70;
  try {
    if (type === 'png') { w = buf.readUInt32BE(16); h = buf.readUInt32BE(20); }
    if (type === 'jpg') {
      for (let i = 2; i < buf.length - 9;) {
        const len = buf.readUInt16BE(i + 2);
        if (buf[i + 1] >= 0xc0 && buf[i + 1] <= 0xc3) { h = buf.readUInt16BE(i + 5); w = buf.readUInt16BE(i + 7); break; }
        i += 2 + len;
      }
    }
  } catch (e) { /* dimensions par défaut */ }
  const scale = Math.min(160 / w, 70 / h, 1);
  return new ImageRun({ type, data: buf, transformation: { width: Math.round(w * scale), height: Math.round(h * scale) } });
}

/** @param ctx contexte de rendu (src/render.js buildContext) */
async function buildDocx(ctx) {
  const P = hex(ctx.colors && ctx.colors.primary, '1F4E79');
  const A = hex(ctx.colors && ctx.colors.accent, 'F2F6FA');
  const GRAY = '6B7686';
  const c = ctx.company || {};
  const cl = ctx.client || {};
  const d = ctx.doc;
  const t = ctx.totals;
  const vatCol = !ctx.vat_exempt;

  // ---------- En-tête : entreprise | titre et références ----------
  const left = [];
  const logo = logoRun(c.logo);
  if (logo) left.push(new Paragraph({ spacing: { after: 80 }, children: [logo] }));
  left.push(new Paragraph({ children: textRuns(c.name, { bold: true, size: 26, color: P }) }));
  for (const l of [c.address, [c.postal_code, c.city].filter(Boolean).join(' '), c.phone && `Tél. : ${c.phone}`, c.email, c.website].filter(Boolean)) {
    left.push(...paragraphs(l, { size: 18 }));
  }
  const meta = [['N°', d.number], ['Date', date(d.date)]];
  if (ctx.isQuote && d.validity_date) meta.push(["Valable jusqu'au", date(d.validity_date)]);
  if (ctx.isInvoice && d.due_date) meta.push(['Échéance', date(d.due_date)]);
  if (cl.code) meta.push(['Code client', cl.code]);
  if (ctx.source) meta.push([ctx.isCredit ? "Facture d'origine" : 'Réf. devis', ctx.source.number]);
  const right = [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { after: 120 }, children: textRuns(String(d.type_label).toUpperCase(), { bold: true, size: 44, color: P }) })];
  for (const [k, v] of meta) {
    right.push(new Paragraph({ alignment: AlignmentType.RIGHT, children: [...textRuns(k + ' : ', { size: 18, color: GRAY }), ...textRuns(v, { size: 18, bold: true })] }));
  }
  const header = new Table({
    width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [CONTENT_W / 2, CONTENT_W / 2], borders: NO_BORDERS, layout: TableLayoutType.FIXED,
    rows: [new TableRow({ children: [cell(left, { width: CONTENT_W / 2, margins: { top: 0, bottom: 0, left: 0, right: 0 } }), cell(right, { width: CONTENT_W / 2, margins: { top: 0, bottom: 0, left: 0, right: 0 } })] })]
  });

  // ---------- Adresse d'intervention | client ----------
  const half = CONTENT_W / 2;
  const site = d.site_address ? [new Paragraph({ children: textRuns("ADRESSE D'INTERVENTION", { size: 15, bold: true, color: P }) }), ...paragraphs(d.site_address, { size: 19 })] : [new Paragraph({ children: [] })];
  const clientBox = [new Paragraph({ children: textRuns('CLIENT', { size: 15, bold: true, color: P }) }),
    new Paragraph({ children: textRuns(cl.display_name, { bold: true, size: 22 }) })];
  if (cl.contact_name) clientBox.push(...paragraphs(cl.contact_name));
  if (cl.full_address) clientBox.push(...paragraphs(cl.full_address));
  if (cl.vat_number) clientBox.push(...paragraphs('TVA : ' + cl.vat_number, { size: 17, color: GRAY }));
  const boxBorder = { top: line('C9D0D8'), bottom: line('C9D0D8'), left: line('C9D0D8'), right: line('C9D0D8') };
  const parties = new Table({
    width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [half - 200, 200, half], borders: NO_BORDERS, layout: TableLayoutType.FIXED,
    rows: [new TableRow({ children: [
      cell(site, { width: half - 200, margins: { top: 0, bottom: 0, left: 0, right: 0 } }),
      cell('', { width: 200 }),
      cell(clientBox, { width: half, borders: boxBorder, margins: { top: 120, bottom: 120, left: 160, right: 160 } })
    ] })]
  });

  const body = [header, new Paragraph({ spacing: { after: 200 }, children: [] }), parties, new Paragraph({ spacing: { after: 160 }, children: [] })];
  if (d.title) body.push(new Paragraph({ spacing: { after: 100 }, children: [...textRuns('Objet : ', { bold: true }), ...textRuns(d.title)] }));
  if (d.intro) body.push(...paragraphs(d.intro, { after: 60 }));
  body.push(new Paragraph({ spacing: { after: 80 }, children: [] }));

  // ---------- Tableau des lignes ----------
  const cols = vatCol ? [950, 4056, 800, 800, 1300, 800, 1500] : [950, 4856, 800, 800, 1300, 1500];
  const heads = vatCol ? ['Réf.', 'Désignation', 'Qté', 'Unité', 'P.U. HT', 'TVA', 'Total HT'] : ['Réf.', 'Désignation', 'Qté', 'Unité', 'P.U. HT', 'Total HT'];
  const numeric = (i) => i === 2 || i >= 4;
  const rowBorder = { top: NONE, left: NONE, right: NONE, bottom: line('E3E7EC') };
  const rows = [new TableRow({
    tableHeader: true,
    children: heads.map((h, i) => cell(new Paragraph({ alignment: numeric(i) ? AlignmentType.RIGHT : AlignmentType.LEFT, children: textRuns(h, { bold: true, color: 'FFFFFF', size: 17 }) }), { width: cols[i], shade: P, borders: { top: NONE, left: NONE, right: NONE, bottom: NONE } }))
  })];
  const full = cols.reduce((a, b) => a + b, 0);
  for (const l of ctx.lines) {
    if (l.isSection) {
      rows.push(new TableRow({ cantSplit: true, children: [cell(new Paragraph({ children: textRuns(l.designation, { bold: true, color: P }) }), { width: full, span: cols.length, shade: A, borders: rowBorder })] }));
    } else if (l.isText) {
      rows.push(new TableRow({ cantSplit: true, children: [cell('', { width: cols[0], borders: rowBorder }), cell(paragraphs(l.designation, { italics: true, color: GRAY }), { width: full - cols[0], span: cols.length - 1, borders: rowBorder })] }));
    } else if (l.isItem) {
      const des = [new Paragraph({ children: textRuns(l.designation) })];
      if (l.description) des.push(...paragraphs(l.description, { size: 16, color: GRAY }));
      if (Number(l.discount_pct) > 0) des.push(...paragraphs('Remise ' + pct(l.discount_pct), { size: 16, color: GRAY }));
      const values = [l.reference || '', des, num(l.quantity), l.unit || '', money(l.unit_price)];
      if (vatCol) values.push(pct(l.vat_rate));
      values.push(money(l.total_ht));
      rows.push(new TableRow({ cantSplit: true, children: values.map((v, i) => cell(Array.isArray(v) ? v : new Paragraph({ alignment: numeric(i) ? AlignmentType.RIGHT : AlignmentType.LEFT, children: textRuns(v, { size: i === 0 ? 16 : 19, color: i === 0 ? GRAY : undefined }) }), { width: cols[i], borders: rowBorder })) }));
    }
    if (l.closing_section) {
      rows.push(new TableRow({ cantSplit: true, children: [
        cell(new Paragraph({ alignment: AlignmentType.RIGHT, children: textRuns('Sous-total ' + l.closing_section, { bold: true }) }), { width: full - cols[cols.length - 1], span: cols.length - 1, borders: rowBorder }),
        cell(new Paragraph({ alignment: AlignmentType.RIGHT, children: textRuns(money(l.closing_section_total), { bold: true }) }), { width: cols[cols.length - 1], borders: rowBorder })
      ] }));
    }
  }
  body.push(new Table({ width: { size: full, type: WidthType.DXA }, columnWidths: cols, borders: NO_BORDERS, layout: TableLayoutType.FIXED, rows }));
  body.push(new Paragraph({ spacing: { after: 160 }, children: [] }));

  // ---------- TVA | totaux ----------
  const vatW = [1100, 1600, 1600];
  let leftBlock;
  if (ctx.vat_exempt) {
    leftBlock = paragraphs(ctx.vat_exempt_mention, { italics: true });
  } else {
    const vb = { top: line(), bottom: line(), left: line(), right: line() };
    leftBlock = [new Table({
      width: { size: vatW.reduce((a, b) => a + b, 0), type: WidthType.DXA }, columnWidths: vatW, layout: TableLayoutType.FIXED,
      rows: [
        new TableRow({ children: ['Taux TVA', 'Base HT', 'Montant TVA'].map((h, i) => cell(new Paragraph({ alignment: AlignmentType.RIGHT, children: textRuns(h, { bold: true, size: 16 }) }), { width: vatW[i], shade: A, borders: vb })) }),
        ...t.vat.map((v) => new TableRow({ children: [pct(v.rate), money(v.base), money(v.amount)].map((x, i) => cell(new Paragraph({ alignment: AlignmentType.RIGHT, children: textRuns(x, { size: 17 }) }), { width: vatW[i], borders: vb })) }))
      ]
    })];
  }
  const totW = [2700, 1800];
  const totRows = [];
  const addTot = (label, value, strong) => totRows.push(new TableRow({ cantSplit: true, children: [
    cell(new Paragraph({ children: textRuns(label, { bold: strong, color: strong ? 'FFFFFF' : undefined, size: strong ? 22 : 19 }) }), { width: totW[0], shade: strong ? P : undefined, borders: { top: NONE, left: NONE, right: NONE, bottom: strong ? NONE : line('EEF1F4') } }),
    cell(new Paragraph({ alignment: AlignmentType.RIGHT, children: textRuns(value, { bold: strong, color: strong ? 'FFFFFF' : undefined, size: strong ? 22 : 19 }) }), { width: totW[1], shade: strong ? P : undefined, borders: { top: NONE, left: NONE, right: NONE, bottom: strong ? NONE : line('EEF1F4') } })
  ] }));
  if (t.discount_amount > 0) { addTot('Total HT brut', money(t.ht_brut)); addTot('Remise ' + pct(t.discount_pct), '- ' + money(t.discount_amount)); }
  addTot('Total HT', money(t.ht));
  if (!ctx.vat_exempt) addTot('Total TVA', money(t.total_vat));
  addTot(ctx.vat_exempt ? 'Net à payer' : 'Total TTC', money(t.ttc), true);
  if (ctx.isQuote && t.deposit_pct > 0) addTot(`Acompte à la commande (${pct(t.deposit_pct)})`, money(t.deposit_amount));
  if (ctx.isInvoice && t.paid > 0) { addTot('Déjà réglé', '- ' + money(t.paid)); addTot('Reste à payer', money(t.due), true); }
  const totalsTable = new Table({ width: { size: totW[0] + totW[1], type: WidthType.DXA }, columnWidths: totW, borders: NO_BORDERS, layout: TableLayoutType.FIXED, rows: totRows });
  const leftW = CONTENT_W - (totW[0] + totW[1]);
  body.push(new Table({
    width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [leftW, totW[0] + totW[1]], borders: NO_BORDERS, layout: TableLayoutType.FIXED,
    rows: [new TableRow({ cantSplit: true, children: [
      cell(leftBlock, { width: leftW, margins: { top: 0, bottom: 0, left: 0, right: 200 } }),
      cell([totalsTable, new Paragraph({ children: [] })], { width: totW[0] + totW[1], margins: { top: 0, bottom: 0, left: 0, right: 0 } })
    ] })]
  }));

  // ---------- Notes, conditions, banque, signature, mentions ----------
  const label = (txt) => new Paragraph({ spacing: { before: 200 }, children: textRuns(txt.toUpperCase(), { bold: true, size: 15, color: P }) });
  if (d.notes) body.push(new Paragraph({ spacing: { before: 200 }, children: [] }), ...paragraphs(d.notes));
  if (d.conditions) body.push(label('Conditions'), ...paragraphs(d.conditions));
  if (ctx.isInvoice && c.iban) {
    body.push(label('Coordonnées bancaires'), ...paragraphs([c.bank_name, 'IBAN : ' + c.iban, c.bic && 'BIC : ' + c.bic].filter(Boolean).join(' — ')));
  }
  if (ctx.isQuote) {
    const sb = { top: line('C9D0D8'), bottom: line('C9D0D8'), left: line('C9D0D8'), right: line('C9D0D8') };
    body.push(new Paragraph({ spacing: { before: 240 }, children: [] }), new Table({
      width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [half, half], borders: NO_BORDERS, layout: TableLayoutType.FIXED,
      rows: [new TableRow({ cantSplit: true, height: { value: 1600, rule: HeightRule.ATLEAST }, children: [
        cell('', { width: half }),
        cell([new Paragraph({ children: textRuns('BON POUR ACCORD', { bold: true, size: 16, color: P }) }), ...paragraphs('Date, signature et cachet précédés de la mention « Bon pour accord »', { size: 16, color: GRAY })], { width: half, borders: sb, margins: { top: 120, bottom: 120, left: 160, right: 160 } })
      ] })]
    }));
  }
  if (!ctx.isQuote && ctx.legal_mentions) body.push(new Paragraph({ spacing: { before: 240 }, children: [] }), ...paragraphs(ctx.legal_mentions, { size: 15, color: GRAY }));

  // ---------- Pied de page ----------
  const legal = [c.name, c.legal_form, c.capital && 'au capital de ' + c.capital, c.siret && 'SIRET ' + c.siret, c.rcs && 'RCS ' + c.rcs, c.ape && 'APE ' + c.ape, c.vat_number && 'TVA intracom. ' + c.vat_number].filter(Boolean).join(' — ');
  const footerParas = [new Paragraph({ alignment: AlignmentType.CENTER, border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'C9D0D8', space: 4 } }, children: textRuns(legal, { size: 14, color: GRAY }) })];
  if (c.insurance) footerParas.push(...paragraphs(c.insurance, { size: 14, color: GRAY, align: AlignmentType.CENTER }));
  if (ctx.footer_text) footerParas.push(...paragraphs(ctx.footer_text, { size: 14, color: GRAY, align: AlignmentType.CENTER }));
  footerParas.push(new Paragraph({ style: 'Footer', alignment: AlignmentType.CENTER, children: [
    ...[`${d.type_label} ${d.number} — page `, PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES]
      .map((part) => new TextRun({ font: 'Arial', size: 14, color: GRAY, children: [part] }))
  ] }));

  const docx = new Document({
    creator: c.name || 'Facturation',
    title: `${d.type_label} ${d.number}`,
    styles: {
      default: { document: { run: { font: 'Arial', size: 19 } } },
      // Style du pied de page : taille aussi appliquée aux numéros de page calculés par le traitement de texte
      paragraphStyles: [{ id: 'Footer', name: 'footer', basedOn: 'Normal', run: { font: 'Arial', size: 14, color: GRAY } }]
    },
    sections: [{
      properties: { page: { size: { width: PAGE_W, height: 16838 }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN, footer: 400 } } },
      footers: { default: new Footer({ children: footerParas }) },
      children: body
    }]
  });
  return Packer.toBuffer(docx);
}

module.exports = { buildDocx };
