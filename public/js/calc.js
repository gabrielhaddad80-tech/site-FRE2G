/*
 * Calcul des totaux d'un devis / d'une facture.
 * Partagé entre le navigateur (calcul en direct) et le serveur (valeurs enregistrées et imprimées).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Calc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  function num(v) {
    const n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function lineTotal(line) {
    if ((line.kind || 'item') !== 'item') return 0;
    const gross = num(line.quantity) * num(line.unit_price);
    return round2(gross * (1 - num(line.discount_pct) / 100));
  }

  /**
   * @param {Array} lines lignes du document
   * @param {Object} opts { discount_pct, deposit_pct, vat_exempt, paid }
   */
  function computeTotals(lines, opts) {
    opts = opts || {};
    const discountPct = num(opts.discount_pct);
    const vatExempt = !!opts.vat_exempt;
    const byRate = {};
    let htBrut = 0;
    let cost = 0;
    const sections = [];
    let current = null;

    for (const line of lines || []) {
      const kind = line.kind || 'item';
      if (kind === 'section') {
        current = { designation: line.designation, total: 0 };
        sections.push(current);
        continue;
      }
      if (kind !== 'item') continue;
      const t = lineTotal(line);
      htBrut += t;
      cost += num(line.quantity) * num(line.purchase_price);
      if (current) current.total += t;
      const rate = vatExempt ? 0 : num(line.vat_rate);
      byRate[rate] = (byRate[rate] || 0) + t;
    }

    htBrut = round2(htBrut);
    // La remise globale est répartie par taux de TVA ; le total HT est la somme des bases
    // afin que « Total HT » et « bases de TVA » concordent toujours au centime près.
    const vat = Object.keys(byRate)
      .map(Number)
      .sort((a, b) => b - a)
      .map((rate) => {
        const gross = round2(byRate[rate]);
        const base = round2(gross - round2(gross * discountPct / 100));
        return { rate, base, amount: round2(base * rate / 100) };
      });
    const ht = round2(vat.reduce((s, v) => s + v.base, 0));
    const discountAmount = round2(htBrut - ht);
    const totalVat = round2(vat.reduce((s, v) => s + v.amount, 0));
    const ttc = round2(ht + totalVat);
    const depositPct = num(opts.deposit_pct);
    const paid = round2(num(opts.paid));

    for (const s of sections) s.total = round2(s.total);

    return {
      ht_brut: htBrut,
      discount_pct: discountPct,
      discount_amount: discountAmount,
      ht,
      vat: vatExempt ? [] : vat.filter((v) => v.rate > 0 || v.base !== 0),
      total_vat: totalVat,
      ttc,
      deposit_pct: depositPct,
      deposit_amount: round2(ttc * depositPct / 100),
      paid,
      due: round2(ttc - paid),
      cost: round2(cost),
      margin: round2(ht - cost),
      margin_pct: ht ? round2((ht - cost) / ht * 100) : 0,
      sections
    };
  }

  return { round2, num, lineTotal, computeTotals };
});
