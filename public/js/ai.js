/*
 * Assistant IA de rédaction : prépare la demande envoyée à Claude (dictée, note, photos)
 * et transforme sa réponse en lignes de devis/facture rapprochées du catalogue.
 * Partagé entre le serveur (logiciel installé) et le navigateur (démo en ligne).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AiDraft = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_CATALOG_ITEMS = 400;

  // Format de réponse attendu (schéma JSON compatible avec les sorties structurées de l'API)
  const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'site_address', 'summary', 'lines', 'questions'],
    properties: {
      title: { type: 'string', description: "Objet court du document, ex. « Rénovation de la salle de bain »" },
      site_address: { type: 'string', description: "Adresse du chantier si elle est mentionnée, sinon chaîne vide" },
      summary: { type: 'string', description: 'Ce qui a été compris de la demande, en une ou deux phrases' },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'item_id', 'designation', 'description', 'quantity', 'unit', 'unit_price', 'vat_rate'],
          properties: {
            kind: { type: 'string', enum: ['section', 'item', 'text'] },
            item_id: { type: 'integer', description: "Identifiant de l'article du catalogue, 0 si hors catalogue" },
            designation: { type: 'string' },
            description: { type: 'string' },
            quantity: { type: 'number' },
            unit: { type: 'string' },
            unit_price: { type: 'number', description: 'Prix unitaire HT en euros' },
            vat_rate: { type: 'number' }
          }
        }
      },
      questions: { type: 'array', items: { type: 'string' }, description: 'Informations manquantes à vérifier avec le client' }
    }
  };

  const TYPE_LABELS = { prestation: 'prestation', main_oeuvre: "main d'œuvre", fourniture: 'fourniture', materiel: 'matériel', ouvrage: 'ouvrage' };

  function catalogText(items) {
    return items.slice(0, MAX_CATALOG_ITEMS).map((it) =>
      [it.id, it.reference || '', it.designation, TYPE_LABELS[it.type] || it.type, it.unit, it.sale_price, it.vat_rate].join(' | ')
    ).join('\n');
  }

  /**
   * @param {object} p { text, imageCount, docType: 'devis'|'facture', catalog: items[], vatExempt, defaultVat, units }
   */
  function buildPrompt(p) {
    const doc = p.docType === 'facture' ? 'une facture' : 'un devis';
    return [
      `Tu aides un artisan français à rédiger ${doc} à partir de sa demande${p.imageCount ? ` et de ${p.imageCount} photo(s) jointe(s)` : ''}.`,
      '',
      'Règles :',
      "- Utilise en priorité les articles du CATALOGUE ci-dessous : reprends leur item_id, leur désignation, leur unité et leur prix de vente. N'invente jamais un item_id.",
      "- Si un travail nécessaire n'existe pas dans le catalogue, ajoute une ligne avec item_id 0 et un prix HT réaliste pour le marché français ; indique « Prix estimé, à vérifier » dans sa description.",
      "- Pense à tout ce qu'implique la demande : main d'œuvre (en heures), fournitures, préparation, déplacement, évacuation des gravats si pertinent.",
      '- Regroupe les lignes en sections (kind « section », seule la désignation compte) quand il y a plusieurs lots de travaux.',
      "- Quantités : reprends celles qui sont dites. Sinon estime-les (surfaces d'après les photos, durées) et précise « quantité estimée » dans la description.",
      `- TVA : ${p.vatExempt ? 'franchise de TVA, mets 0' : `taux du catalogue ; ${p.defaultVat || 20} % par défaut ; 10 % pour des travaux de rénovation dans un logement de plus de 2 ans si la demande le précise`}.`,
      `- Unités possibles : ${(p.units || []).join(', ') || 'u, h, m², ml, forfait'}.`,
      '- Ne mets pas de coordonnées client dans les lignes. Liste dans « questions » ce qui manque pour chiffrer précisément.',
      '- Écris en français, désignations courtes et professionnelles.',
      '',
      'CATALOGUE (item_id | référence | désignation | type | unité | prix HT | TVA %) :',
      catalogText(p.catalog || []) || '(catalogue vide)',
      '',
      'DEMANDE :',
      (p.text || '').trim() || '(aucun texte, travaille à partir des photos)',
      '',
      'Réponds uniquement avec un objet JSON de la forme :',
      '{"title": string, "site_address": string, "summary": string, "lines": [{"kind": "section"|"item"|"text", "item_id": integer, "designation": string, "description": string, "quantity": number, "unit": string, "unit_price": number, "vat_rate": number}], "questions": [string]}'
    ].join('\n');
  }

  function num(v, def) {
    const n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : Number(v);
    return Number.isFinite(n) ? n : def;
  }

  /** Transforme la réponse de Claude en lignes prêtes pour l'éditeur. */
  function normalize(result, catalog, opts) {
    opts = opts || {};
    const byId = new Map((catalog || []).map((it) => [Number(it.id), it]));
    const r = result && typeof result === 'object' ? result : {};
    const lines = (Array.isArray(r.lines) ? r.lines : []).map((l) => {
      const kind = ['section', 'item', 'text'].includes(l && l.kind) ? l.kind : 'item';
      const designation = String((l && l.designation) || '').trim();
      if (kind !== 'item') return { kind, designation, description: '', quantity: 0, unit: '', unit_price: 0, discount_pct: 0, vat_rate: 0, purchase_price: 0, from_catalog: false };
      const it = byId.get(Number(l.item_id));
      const vat = opts.vatExempt ? 0 : num(l.vat_rate, it ? it.vat_rate : num(opts.defaultVat, 20));
      return {
        kind: 'item',
        item_id: it ? it.id : null,
        item_type: it ? it.type : null,
        reference: it ? it.reference || '' : '',
        designation: designation || (it ? it.designation : 'Prestation'),
        description: String(l.description || (it && it.description) || ''),
        quantity: Math.max(0, num(l.quantity, 1)),
        unit: String(l.unit || (it && it.unit) || 'u'),
        unit_price: it ? it.sale_price : Math.max(0, num(l.unit_price, 0)),
        discount_pct: 0,
        vat_rate: vat,
        purchase_price: it ? it.purchase_price || 0 : 0,
        from_catalog: !!it
      };
    }).filter((l) => l.designation);
    return {
      title: String(r.title || '').trim(),
      site_address: String(r.site_address || '').trim(),
      summary: String(r.summary || '').trim(),
      questions: (Array.isArray(r.questions) ? r.questions : []).map(String).filter(Boolean),
      lines
    };
  }

  return { SCHEMA, buildPrompt, normalize, MAX_CATALOG_ITEMS };
});
