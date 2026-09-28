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

  // ---------- Conversion d'un modèle existant (image / page de PDF) en modèle d'impression ----------
  const TEMPLATE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'html', 'css', 'notes'],
    properties: {
      name: { type: 'string', description: 'Nom court du modèle, ex. « Modèle Dupont Rénovation »' },
      html: { type: 'string', description: 'Gabarit Handlebars (contenu de la page, sans html/head/body/style/script)' },
      css: { type: 'string', description: 'Feuille de style, règles préfixées par .doc' },
      notes: { type: 'string', description: "Ce qui n'a pas pu être reproduit fidèlement, en une ou deux phrases (chaîne vide sinon)" }
    }
  };

  const TEMPLATE_VARIABLES = [
    'Entreprise : company.name, company.legal_form, company.capital, company.address, company.postal_code, company.city, company.phone, company.email, company.website, company.siret, company.rcs, company.ape, company.vat_number, company.insurance, company.logo (image en data: URL), company.bank_name, company.iban, company.bic',
    'Client : client.display_name, client.contact_name, client.full_address (multi-lignes : {{nl2br client.full_address}}), client.code, client.email, client.phone, client.siret, client.vat_number',
    'Document : doc.type_label (« Devis », « Facture » ou « Avoir »), doc.number, doc.date, doc.validity_date (devis), doc.due_date (facture), doc.title (objet), doc.site_address, doc.intro, doc.notes, doc.conditions ; booléens isQuote, isInvoice, isCredit ; source.number (devis ou facture d\'origine)',
    'Lignes : {{#each lines}} … {{/each}} ; chaque ligne a isSection, isText ou isItem ; pour isItem : reference, designation, description, quantity, unit, unit_price, discount_pct, vat_rate, total_ht, index ; fin de section : closing_section et closing_section_total. Dans la boucle, les variables globales se lisent avec ../ (ex. {{#unless ../vat_exempt}})',
    'Totaux : totals.ht_brut, totals.discount_pct, totals.discount_amount, totals.ht, totals.total_vat, totals.ttc, totals.deposit_pct, totals.deposit_amount, totals.paid, totals.due ; détail TVA : {{#each totals.vat}} rate, base, amount {{/each}}',
    'Divers : vat_exempt (franchise de TVA), vat_exempt_mention, legal_mentions, footer_text, colors.primary, colors.accent',
    'Fonctions : {{money x}} (montant en euros), {{number x}}, {{percent x}}, {{date x}} (jj/mm/aaaa), {{nl2br x}} (retours à la ligne), {{upper x}}, conditions {{#if (gt x 0)}}, {{#if (eq a b)}}'
  ].join('\n');

  function buildTemplatePrompt(p) {
    return [
      "Voici l'image d'un devis ou d'une facture qu'utilise déjà un artisan. Recrée sa mise en page sous forme de gabarit Handlebars (HTML + CSS) pour son logiciel de facturation, afin que ses futurs documents ressemblent le plus possible à l'original.",
      '',
      'Exigences :',
      "- Reproduis fidèlement la disposition (position de l'en-tête, du bloc client, des références, du tableau, des totaux, du pied de page), les couleurs (codes hexadécimaux relevés sur l'image), les graisses, tailles relatives, bordures, fonds et colonnes du tableau.",
      "- Remplace TOUTES les informations variables de l'image par les variables ci-dessous (nom et adresse de l'entreprise, client, numéro, dates, lignes, montants…). Ne recopie aucune donnée de l'exemple (aucun nom de client, montant ou ligne en dur).",
      "- Garde les libellés fixes de l'original (ex. « Désignation », « Total HT », « Bon pour accord ») et leur ordre.",
      "- Si l'original a un logo, place {{#if company.logo}}<img class=\"logo\" src=\"{{company.logo}}\" alt=\"\">{{/if}} au même endroit.",
      '- Le gabarit sert pour les devis, factures et avoirs : titre avec {{upper doc.type_label}} ou {{doc.type_label}}, validité seulement si isQuote, échéance et coordonnées bancaires si isInvoice, zone de signature seulement pour isQuote si l\'original en a une, mentions légales pour les factures.',
      '- La boucle des lignes doit gérer les sections (avec sous-total en fin de section), les lignes de texte et les articles ; le détail de TVA et les totaux doivent disparaître proprement si vat_exempt (afficher alors vat_exempt_mention).',
      "- HTML : un seul élément racine <div class=\"doc\"> ; pas de <html>, <head>, <body>, <style> ni <script>, aucune ressource externe (pas d'URL d'image ou de police). CSS : toutes les règles commencent par .doc ; polices web sûres (Arial, Helvetica, Georgia, « Times New Roman »…) ; largeur utile A4 de 186 mm ; ajoute page-break-inside: avoid sur les lignes et les totaux.",
      "- Si un élément de l'original ne peut pas être reproduit, dis-le dans « notes ».",
      '',
      'VARIABLES DISPONIBLES :',
      TEMPLATE_VARIABLES,
      '',
      "EXEMPLE d'un autre gabarit qui fonctionne (pour la syntaxe et les variables, PAS pour le style) :",
      '--- HTML ---',
      p.exampleHtml || '',
      '--- CSS ---',
      p.exampleCss || '',
      '',
      'Réponds uniquement avec un objet JSON : {"name": string, "html": string, "css": string, "notes": string}'
    ].join('\n');
  }

  function normalizeTemplate(result) {
    const r = result && typeof result === 'object' ? result : {};
    const clean = (html) => String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<\/?(html|head|body)[^>]*>/gi, '')
      .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .trim();
    const css = String(r.css || '').replace(/<\/?style[^>]*>/gi, '').replace(/@import[^;]*;/gi, '').trim();
    return { name: String(r.name || 'Mon modèle').trim().slice(0, 80), html: clean(r.html), css, notes: String(r.notes || '').trim() };
  }

  return { SCHEMA, buildPrompt, normalize, MAX_CATALOG_ITEMS, TEMPLATE_SCHEMA, buildTemplatePrompt, normalizeTemplate };
});
