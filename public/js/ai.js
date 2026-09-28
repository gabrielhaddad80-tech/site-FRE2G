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

  // ---------- Chat : outils que l'IA peut utiliser sur les données du logiciel ----------
  const obj = (properties, required) => ({ type: 'object', properties, required: required || [] });
  const CHAT_TOOLS = [
    { name: 'rechercher_clients', description: 'Recherche des clients par nom, ville, e-mail ou code. Renvoie au plus 15 clients avec leurs coordonnées et le montant facturé.',
      input_schema: obj({ recherche: { type: 'string', description: 'Texte recherché, vide pour tous' } }) },
    { name: 'rechercher_catalogue', description: "Recherche des articles du catalogue (prestations, main d'œuvre, fournitures, matériel, ouvrages). Renvoie au plus 20 articles avec id, référence, unité, prix HT et TVA.",
      input_schema: obj({ recherche: { type: 'string' }, type: { type: 'string', enum: ['', 'prestation', 'main_oeuvre', 'fourniture', 'materiel', 'ouvrage'] } }) },
    { name: 'lister_documents', description: "Liste des devis, factures ou avoirs (les 25 plus récents correspondant aux filtres). Statuts devis : brouillon, envoye, accepte, refuse, facture. Statuts factures : brouillon, emise, partielle, payee, annulee. Chaque facture indique paid (déjà réglé) et due_date.",
      input_schema: obj({ type: { type: 'string', enum: ['', 'devis', 'facture', 'avoir'] }, statut: { type: 'string' }, recherche: { type: 'string', description: 'N°, client ou objet' }, client_id: { type: 'integer' }, du: { type: 'string', description: 'Date AAAA-MM-JJ' }, au: { type: 'string', description: 'Date AAAA-MM-JJ' } }) },
    { name: 'lire_document', description: "Détail complet d'un devis, d'une facture ou d'un avoir : client, lignes, totaux, règlements.",
      input_schema: obj({ id: { type: 'integer' } }, ['id']) },
    { name: 'tableau_de_bord', description: "Chiffres de l'année : CA HT facturé, encaissé, reste à encaisser, factures en retard, devis en cours, taux de transformation, CA mensuel.",
      input_schema: obj({ annee: { type: 'integer' } }) },
    { name: 'creer_devis', description: "Crée un devis BROUILLON (modifiable, supprimable) avec des lignes. Utilise d'abord rechercher_catalogue et rechercher_clients pour reprendre les id et les prix existants. Renvoie son numéro et son lien.",
      input_schema: obj({
        client_id: { type: 'integer', description: 'Id du client, 0 si inconnu' },
        objet: { type: 'string' },
        adresse_chantier: { type: 'string' },
        lignes: { type: 'array', items: obj({
          type_ligne: { type: 'string', enum: ['item', 'section', 'text'] },
          item_id: { type: 'integer', description: 'Id catalogue, 0 si hors catalogue' },
          designation: { type: 'string' }, description: { type: 'string' },
          quantite: { type: 'number' }, unite: { type: 'string' }, prix_unitaire_ht: { type: 'number' }, tva: { type: 'number' }
        }, ['designation']) }
      }, ['objet', 'lignes']) }
  ];

  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== '').map((k) => [k, o[k]]));

  /**
   * Exécute un outil du chat. `request(method, path, body)` appelle l'API du logiciel et renvoie le JSON.
   * Renvoie des données compactes (et `link` quand un document est créé).
   */
  async function runChatTool(name, input, request) {
    input = input && typeof input === 'object' ? input : {};
    const q = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== 0)).toString();
    switch (name) {
      case 'rechercher_clients': {
        const rows = await request('GET', '/clients?' + q({ q: input.recherche }));
        return rows.slice(0, 15).map((c) => pick(c, ['id', 'code', 'kind', 'company', 'first_name', 'last_name', 'city', 'email', 'phone', 'documents_count', 'invoiced']));
      }
      case 'rechercher_catalogue': {
        const rows = await request('GET', '/items?' + q({ q: input.recherche, type: input.type, limit: 20 }));
        return rows.map((i) => pick(i, ['id', 'reference', 'designation', 'type', 'unit', 'sale_price', 'purchase_price', 'vat_rate', 'category_name']));
      }
      case 'lister_documents': {
        const rows = await request('GET', '/documents?' + q({ type: input.type, status: input.statut, q: input.recherche, client_id: input.client_id, from: input.du, to: input.au }));
        return { total: rows.length, documents: rows.slice(0, 25).map((d) => pick(d, ['id', 'type', 'number', 'status', 'date', 'due_date', 'validity_date', 'title', 'client_name', 'total_ht', 'total_ttc', 'paid'])) };
      }
      case 'lire_document': {
        const d = await request('GET', '/documents/' + Number(input.id));
        return {
          ...pick(d, ['id', 'type', 'number', 'status', 'date', 'due_date', 'validity_date', 'title', 'site_address', 'notes', 'discount_pct', 'deposit_pct']),
          client: d.client ? pick(d.client, ['id', 'company', 'first_name', 'last_name', 'city', 'email', 'phone']) : null,
          lignes: d.lines.map((l) => pick(l, ['kind', 'reference', 'designation', 'quantity', 'unit', 'unit_price', 'vat_rate'])),
          totaux: pick(d.totals, ['ht', 'total_vat', 'ttc', 'paid', 'due', 'margin', 'margin_pct']),
          reglements: d.payments.map((p) => pick(p, ['date', 'amount', 'method'])),
          link: 'document.html?id=' + d.id
        };
      }
      case 'tableau_de_bord': {
        const d = await request('GET', '/dashboard' + (input.annee ? '?year=' + Number(input.annee) : ''));
        return {
          ...pick(d, ['year', 'revenue_ht', 'collected', 'receivable', 'pending_quotes_total', 'conversion_rate', 'months']),
          factures_en_retard: d.overdue.map((f) => pick(f, ['id', 'number', 'client_name', 'due_date', 'total_ttc', 'paid'])),
          devis_en_cours: d.pending_quotes.slice(0, 15).map((x) => pick(x, ['id', 'number', 'client_name', 'status', 'total_ht']))
        };
      }
      case 'creer_devis': {
        const lines = (Array.isArray(input.lignes) ? input.lignes : []).map((l) => ({
          kind: ['item', 'section', 'text'].includes(l.type_ligne) ? l.type_ligne : 'item',
          item_id: Number(l.item_id) || null,
          designation: String(l.designation || ''),
          description: String(l.description || ''),
          quantity: Number(l.quantite) || (l.type_ligne && l.type_ligne !== 'item' ? 0 : 1),
          unit: String(l.unite || 'u'),
          unit_price: Number(l.prix_unitaire_ht) || 0,
          vat_rate: l.tva === undefined ? 20 : Number(l.tva)
        })).filter((l) => l.designation);
        if (!lines.length) throw new Error('Aucune ligne valide.');
        const d = await request('POST', '/documents', {
          type: 'devis', client_id: Number(input.client_id) || null, title: String(input.objet || ''), site_address: String(input.adresse_chantier || ''), lines
        });
        return { id: d.id, numero: d.number, total_ht: d.total_ht, total_ttc: d.total_ttc, link: 'document.html?id=' + d.id };
      }
      default:
        throw new Error('Outil inconnu : ' + name);
    }
  }

  function chatSystemPrompt(p) {
    return [
      `Tu es l'assistant intégré au logiciel de devis et factures de l'entreprise « ${p.company || 'l\'entreprise'} » (artisan / TPE en France). Nous sommes le ${p.today}.`,
      "Tu aides l'utilisateur à piloter son activité : retrouver un client ou un document, suivre les impayés et les devis, analyser son chiffre d'affaires, préparer des devis, rédiger des relances ou des e-mails, répondre à des questions de facturation (TVA, mentions obligatoires, acomptes, avoirs).",
      "- Pour toute donnée chiffrée ou nominative, utilise les outils : n'invente jamais un montant, un client ou un numéro.",
      "- Pour préparer un devis, cherche d'abord le client et les articles du catalogue, reprends leurs id et leurs prix, puis crée-le avec creer_devis. Dis que c'est un brouillon à vérifier.",
      "- Cite les documents par leur numéro. Quand un document est concerné, ajoute un lien Markdown vers le logiciel, par exemple [DEV-2026-0003](document.html?id=12). Liens possibles : document.html?id=…, clients.html?id=…, catalogue.html?id=…",
      "- Réponds en français, de façon brève et concrète (quelques phrases ou une courte liste). Montants au format français (1 234,50 €).",
      "- Tu ne peux ni émettre une facture, ni enregistrer un règlement, ni supprimer quoi que ce soit : indique à l'utilisateur où le faire dans le logiciel."
    ].join('\n');
  }

  function contextNote(ctx) {
    if (!ctx || !ctx.page) return '';
    const where = { 'document.html': ctx.id ? `la fiche du document id ${ctx.id}` : 'la création d\'un document', 'clients.html': ctx.id ? `la fiche du client id ${ctx.id}` : 'la liste des clients',
      'documents.html': 'la liste des ' + (ctx.type || 'documents'), 'catalogue.html': 'le catalogue', 'index.html': "l'accueil", 'tableau-de-bord.html': 'le tableau de bord', 'modeles.html': 'les modèles', 'parametres.html': 'les paramètres' }[ctx.page];
    return where ? `(L'utilisateur est actuellement sur ${where}.)` : '';
  }

  return { SCHEMA, buildPrompt, normalize, MAX_CATALOG_ITEMS, TEMPLATE_SCHEMA, buildTemplatePrompt, normalizeTemplate, CHAT_TOOLS, runChatTool, chatSystemPrompt, contextNote };
});
