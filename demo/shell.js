/* Démo en ligne : le « serveur » tourne dans la page, les écrans sont chargés sans rechargement. */
(function () {
  'use strict';
  const PAGES = window.__PAGES;
  const STORE_KEY = 'fre2g-facturation-demo-v1';
  const nativeFetch = window.fetch.bind(window);
  let VLOC = { page: 'index.html', search: '' };

  // ---------- Stockage local ----------
  function b64encode(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64decode(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function loadStored() {
    try { const s = localStorage.getItem(STORE_KEY); return s ? b64decode(s) : null; } catch (e) { return null; }
  }
  let saveTimer = null;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, b64encode(DemoBackend.exportDb())); } catch (e) { /* données conservées en mémoire seulement */ }
    }, 250);
  }

  // ---------- Données d'exemple ----------
  function call(method, url, body) {
    const r = DemoBackend.handle(method, url, body === undefined ? undefined : JSON.parse(JSON.stringify(body)));
    return r.body ? JSON.parse(r.body) : null;
  }
  function seed() {
    const items = call('GET', '/api/items?limit=100');
    const byRef = Object.fromEntries(items.map((i) => [i.reference, i]));
    const line = (ref, qty) => {
      const it = byRef[ref];
      return { kind: 'item', item_id: it.id, item_type: it.type, reference: it.reference, designation: it.designation, description: it.description || '',
        quantity: qty, unit: it.unit, unit_price: it.sale_price, discount_pct: 0, vat_rate: it.vat_rate, purchase_price: it.purchase_price };
    };
    const client1 = call('GET', '/api/clients')[0];
    const client2 = call('POST', '/api/clients', { kind: 'particulier', civility: 'Mme', first_name: 'Claire', last_name: 'Martin',
      address: '8 chemin des Vignes', postal_code: '33000', city: 'Bordeaux', country: 'France', email: 'claire.martin@exemple.fr', phone: '06 00 00 00 00' });

    const q1 = call('POST', '/api/documents', { type: 'devis', client_id: client1.id, title: 'Réfection des bureaux du 2e étage',
      site_address: '10 avenue des Tests\n69000 Lyon', deposit_pct: 30,
      lines: [{ kind: 'section', designation: 'Préparation du chantier' }, line('P-DEP', 1), line('M-ECH', 2),
        { kind: 'section', designation: 'Revêtements de sol' }, line('OUV-01', 42), line('F-200', 1)] });
    call('POST', `/api/documents/${q1.id}/status`, { status: 'accepte' });
    const inv = call('POST', `/api/documents/${q1.id}/convert`, {});
    const issued = call('POST', `/api/documents/${inv.id}/issue`, {});
    call('POST', `/api/documents/${inv.id}/payments`, { amount: Math.round(issued.total_ttc * 30) / 100, method: 'virement', reference: 'Acompte 30 %' });

    const q2 = call('POST', '/api/documents', { type: 'devis', client_id: client2.id, title: 'Rénovation de la salle de bain', discount_pct: 5,
      lines: [line('MO-01', 16), line('MO-02', 4), line('F-100', 9), { kind: 'text', designation: 'Évacuation des gravats comprise.' }, line('P-DEP', 2)] });
    call('POST', `/api/documents/${q2.id}/status`, { status: 'envoye' });
  }

  function startDatabase(bytes) {
    DemoBackend.init(bytes);
    if (!bytes) { seed(); persist(); }
  }

  const ready = (async () => {
    globalThis.__SQL = await initSqlJs();
    const stored = loadStored();
    try { startDatabase(stored); } catch (e) { console.error(e); startDatabase(null); }
  })();

  // ---------- API servie localement ----------
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/api/')) return nativeFetch(input, init);
    await ready;
    init = init || {};
    const method = (init.method || 'GET').toUpperCase();
    const r = DemoBackend.handle(method, url, init.body ? JSON.parse(init.body) : undefined);
    if (method !== 'GET' && r.statusCode < 400) persist();
    return new Response(r.body, { status: r.statusCode, headers: { 'Content-Type': r.contentType } });
  };

  // ---------- Navigation entre les écrans ----------
  const tracked = [];
  for (const target of [window, document]) {
    const add = target.addEventListener.bind(target);
    target.addEventListener = function (type, fn, opts) {
      if (type === 'keydown' || type === 'beforeunload') tracked.push([target, type, fn, opts]);
      return add(type, fn, opts);
    };
  }

  async function canLeave() {
    const ev = { defaultPrevented: false, returnValue: undefined, preventDefault() { this.defaultPrevented = true; } };
    for (const [t, type, fn] of tracked) if (type === 'beforeunload') { try { fn.call(t, ev); } catch (e) { /* ignore */ } }
    if (!ev.defaultPrevented && ev.returnValue === undefined) return true;
    return uiConfirm('Des modifications ne sont pas enregistrées. Quitter cette page quand même ?', 'Quitter sans enregistrer');
  }

  function parse(url) {
    const [page, search] = String(url).split('?');
    return { page: page.split('/').pop() || 'index.html', search: search ? '?' + search : '' };
  }

  const pageStyle = document.createElement('style');
  document.head.appendChild(pageStyle);

  async function navigate(url, force) {
    const target = parse(url);
    if (!PAGES[target.page]) return;
    if (!force && !(await canLeave())) return;
    await ready;
    for (const [t, type, fn, o] of tracked.splice(0)) t.removeEventListener(type, fn, o);
    document.querySelectorAll('body > .modal-bg').forEach((m) => m.remove());
    VLOC = target;
    const P = PAGES[target.page];
    const app = document.getElementById('app');
    app.querySelectorAll('main, #boot').forEach((m) => m.remove());
    pageStyle.textContent = P.style || '';
    document.title = P.title;
    app.insertAdjacentHTML('beforeend', P.main);
    renderNav();
    window.scrollTo(0, 0);
  }

  window.qs = (name) => new URLSearchParams(VLOC.search).get(name);
  window.currentPage = () => VLOC.page;
  window.go = (url) => { navigate(url); };
  window.setUrl = (url) => { VLOC = parse(url); };

  // Aperçu du document dans la page (l'impression PDF est réservée à la version installée)
  window.openPrint = function (id) {
    const r = DemoBackend.handle('GET', `/api/documents/${id}/print?toolbar=0`);
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = '<div class="modal wide print-modal" role="dialog" aria-modal="true" aria-label="Aperçu du document">'
      + '<div class="toolbar"><h2 style="margin:0">Aperçu du document</h2><span class="spacer"></span><button type="button" class="primary" data-close>Fermer</button></div>'
      + '<p class="small muted">Dans la version installée, ce bouton ouvre le document prêt à imprimer ou à enregistrer en PDF (A4).</p>'
      + '<iframe class="preview-frame" title="Aperçu du document"></iframe></div>';
    bg.querySelector('iframe').srcdoc = r.body;
    const close = () => { document.removeEventListener('keydown', onKey, true); bg.remove(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(bg);
    bg.querySelector('[data-close]').focus();
  };

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (/^\/api\//.test(href)) {
      e.preventDefault();
      toast('Les téléchargements (sauvegarde, export CSV) fonctionnent dans la version installée.', 'error');
    } else if (/^[\w-]+\.html/.test(href)) {
      e.preventDefault();
      navigate(href);
    }
  });

  // ---------- Assistant IA : Claude via la page (compte de la personne qui consulte) ----------
  window.IS_DEMO = true;
  const AI_MESSAGES = {
    not_granted: "L'assistant IA n'a pas été autorisé pour cette page.",
    sampling_disabled: "Claude n'est pas disponible pour ce compte.",
    rate_limited: "Trop de demandes pour le moment : réessayez dans quelques minutes.",
    refused: "L'IA n'a pas pu traiter cette demande : reformulez-la ou retirez une photo.",
    invalid_json: "La réponse de l'IA était illisible : réessayez.",
    image_rejected: 'Une photo a été refusée : essayez un autre fichier (JPEG ou PNG).',
    images_unavailable: 'Les photos ne peuvent pas être envoyées depuis cette vue : décrivez le chantier par écrit.',
    prompt_too_large: 'La demande est trop longue : raccourcissez la note.',
    session_expired: 'Votre session Claude a expiré : reconnectez-vous.'
  };
  let samplePromise = null;
  const getSample = () => samplePromise || (samplePromise = (window.claude && typeof window.claude.use === 'function')
    ? window.claude.use('sample').catch(() => null) : Promise.resolve(null));
  window.aiAvailable = async () => !!(await getSample());
  window.aiUnavailableHint = () => "L'assistant IA n'est pas disponible dans cette vue de la démo (il fonctionne quand la page est ouverte dans Claude). Dans la version installée, il s'active avec une clé API.";
  window.aiDraft = async ({ text, images, docType, signal }) => {
    const sample = await getSample();
    if (!sample) throw { code: 'not_granted', message: AI_MESSAGES.not_granted };
    const settings = call('GET', '/api/settings');
    const catalog = call('GET', '/api/items?limit=' + AiDraft.MAX_CATALOG_ITEMS);
    const vatExempt = settings.vat_exempt === '1';
    const opts = { signal, cache: false };
    if (images && images.length) {
      const limits = await sample.limits().catch(() => null);
      if (!limits || !limits.images) throw { code: 'images_unavailable', message: AI_MESSAGES.images_unavailable };
      opts.images = images.slice(0, limits.images.maxCount).map((im) => im.blob);
    }
    const prompt = AiDraft.buildPrompt({
      text, imageCount: opts.images ? opts.images.length : 0, docType, catalog, vatExempt,
      defaultVat: settings.default_vat_rate, units: (settings.units || '').split(',').map((u) => u.trim()).filter(Boolean)
    });
    try {
      const result = await sample.json(prompt, opts);
      return AiDraft.normalize(result, catalog, { vatExempt, defaultVat: settings.default_vat_rate });
    } catch (e) {
      const code = e && e.code;
      throw { code, message: AI_MESSAGES[code] || "L'assistant IA n'a pas pu répondre : réessayez." };
    }
  };

  // Conversion d'un modèle existant par Claude (image ou 1re page de PDF)
  PDFJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  window.aiTemplate = async ({ image, signal }) => {
    const sample = await getSample();
    if (!sample) throw { code: 'not_granted', message: AI_MESSAGES.not_granted };
    const limits = await sample.limits().catch(() => null);
    if (!limits || !limits.images) throw { code: 'images_unavailable', message: "L'image du modèle ne peut pas être envoyée depuis cette vue." };
    const prompt = AiDraft.buildTemplatePrompt({ exampleHtml: window.__DEMO_FILES['classique.hbs'], exampleCss: window.__DEMO_FILES['classique.css'] });
    let tpl;
    try {
      tpl = AiDraft.normalizeTemplate(await sample.json(prompt, { images: [image.blob], signal, cache: false }));
    } catch (e) {
      const code = e && e.code;
      throw { code, message: AI_MESSAGES[code] || "L'IA n'a pas pu reproduire ce modèle : réessayez." };
    }
    try { Handlebars.precompile(tpl.html); Handlebars.precompile(tpl.css); } catch (e) {
      throw { code: 'invalid_template', message: 'Le modèle généré contient une erreur de syntaxe : réessayez.' };
    }
    return tpl;
  };

  document.getElementById('demo-reset').addEventListener('click', async () => {
    if (!(await uiConfirm('Effacer toutes les données saisies et repartir des exemples ?', 'Réinitialiser'))) return;
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
    await ready;
    startDatabase(null);
    navigate('index.html', true);
    toast('Démo réinitialisée');
  });

  ready.then(() => navigate('index.html', true)).catch((e) => {
    console.error(e);
    const boot = document.getElementById('boot');
    if (boot) boot.textContent = 'Le chargement a échoué. Rechargez la page.';
  });
})();
