// Calculs des montants : devis, facture d'acompte, facture de solde.
// Tous les montants sont arrondis au centime, TVA calculée par taux.

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function toNumber(v, fallback = 0) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

// Lignes chiffrées du devis -> totaux et ventilation par taux de TVA
export function computeQuoteTotals(lines) {
  const groups = new Map();
  const computed = (lines || []).map((l) => {
    const qty = toNumber(l.qty, 0);
    const pu = toNumber(l.unit_price, 0);
    const rate = toNumber(l.vat_rate, 20);
    const ht = round2(qty * pu);
    const g = groups.get(rate) || { rate, base: 0 };
    g.base = round2(g.base + ht);
    groups.set(rate, g);
    return { ...l, qty, unit_price: pu, vat_rate: rate, total_ht: ht };
  });
  const vat = [...groups.values()]
    .sort((a, b) => b.rate - a.rate)
    .map((g) => ({ rate: g.rate, base: g.base, amount: round2((g.base * g.rate) / 100) }));
  const ht = round2(vat.reduce((s, g) => s + g.base, 0));
  const totalVat = round2(vat.reduce((s, g) => s + g.amount, 0));
  return { lines: computed, vat, ht, total_vat: totalVat, ttc: round2(ht + totalVat) };
}

// Répartit un montant TTC entre les taux de TVA du devis, au prorata.
// Le dernier groupe reçoit le reste pour que la somme tombe juste au centime.
function splitTtc(vatGroups, ttcAmount) {
  const totalTtc = vatGroups.reduce((s, g) => s + g.base + g.amount, 0);
  const out = [];
  let remaining = round2(ttcAmount);
  vatGroups.forEach((g, i) => {
    const groupTtc = i === vatGroups.length - 1
      ? remaining
      : round2((ttcAmount * (g.base + g.amount)) / (totalTtc || 1));
    remaining = round2(remaining - groupTtc);
    const base = round2(groupTtc / (1 + g.rate / 100));
    out.push({ rate: g.rate, base, amount: round2(groupTtc - base) });
  });
  return out;
}

// Échéancier : acompte à la commande et solde à la mise en route
export function computeSchedule(totals, depositPct) {
  const pct = Math.min(Math.max(toNumber(depositPct, 0), 0), 100);
  const deposit = round2((totals.ttc * pct) / 100);
  return { deposit_pct: pct, deposit_ttc: deposit, balance_pct: round2(100 - pct), balance_ttc: round2(totals.ttc - deposit) };
}

// Facture d'acompte : pourcentage du TTC du devis, TVA ventilée par taux
export function computeDepositInvoice(totals, depositPct) {
  const { deposit_ttc, deposit_pct } = computeSchedule(totals, depositPct);
  const vat = totals.vat.length ? splitTtc(totals.vat, deposit_ttc) : [];
  const ht = round2(vat.reduce((s, g) => s + g.base, 0));
  const totalVat = round2(vat.reduce((s, g) => s + g.amount, 0));
  return { pct: deposit_pct, vat, ht, total_vat: totalVat, ttc: round2(ht + totalVat), amount_due: round2(ht + totalVat) };
}

// Facture de solde : total des travaux moins les acomptes déjà facturés
export function computeBalanceInvoice(totals, depositInvoices) {
  const deducted = new Map();
  for (const inv of depositInvoices) {
    for (const g of inv.details?.vat || []) {
      const d = deducted.get(g.rate) || { rate: g.rate, base: 0, amount: 0 };
      d.base = round2(d.base + g.base);
      d.amount = round2(d.amount + g.amount);
      deducted.set(g.rate, d);
    }
  }
  const depositsTtc = round2(depositInvoices.reduce((s, i) => s + i.total_ttc, 0));
  const vat = totals.vat.map((g) => {
    const d = deducted.get(g.rate) || { base: 0, amount: 0 };
    return { rate: g.rate, base: g.base, amount: g.amount, deducted_base: d.base, deducted_amount: d.amount, due_base: round2(g.base - d.base), due_amount: round2(g.amount - d.amount) };
  });
  return {
    vat,
    ht: totals.ht,
    total_vat: totals.total_vat,
    ttc: totals.ttc,
    deposits: depositInvoices.map((i) => ({ number: i.number, date: i.date, ttc: i.total_ttc, ht: i.total_ht, vat: i.total_vat })),
    deposits_ttc: depositsTtc,
    amount_due: round2(totals.ttc - depositsTtc)
  };
}

const eur = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const num = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 });
const pctFmt = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });

// Intl utilise des espaces insécables fines : on les remplace par des espaces insécables simples
export function formatMoney(v) { return eur.format(toNumber(v)).replace(/ /g, ' '); }
export function formatNumber(v) { return num.format(toNumber(v)).replace(/ /g, ' '); }
export function formatPct(v) { return `${pctFmt.format(toNumber(v))} %`; }
