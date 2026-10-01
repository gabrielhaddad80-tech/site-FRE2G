/* Chat avec l'assistant IA : bulle flottante présente sur toutes les pages du logiciel. */
'use strict';

const CHAT_KEY = 'fre2g-chat-v1';
const CHAT_SUGGESTIONS = [
  'Quelles factures sont en retard ?',
  "Quel est mon chiffre d'affaires cette année ?",
  'Quels devis dois-je relancer ?',
  'Prépare un devis pour la pose de 20 m² de carrelage'
];

const chat = { messages: [], files: [], busy: false, ctl: null, available: null, rec: null };
const CHAT_MAX_FILES = 5;

function chatLoad() {
  try { chat.messages = JSON.parse(localStorage.getItem(CHAT_KEY) || '[]').filter((m) => m && m.role && m.content).slice(-40); } catch (e) { chat.messages = []; }
}
function chatSave() {
  try { localStorage.setItem(CHAT_KEY, JSON.stringify(chat.messages.slice(-40))); } catch (e) { /* stockage indisponible */ }
}

// Mise en forme sûre : texte échappé, **gras**, listes, liens internes au logiciel seulement
function chatFormat(text) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (t) => esc(t)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(((?:document|documents|clients|catalogue|index|tableau-de-bord|modeles|parametres)\.html(?:\?[\w=&;.-]*)?)\)/g, '<a href="$2">$1</a>');
  const out = [];
  let list = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trimEnd();
    const item = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (item) { if (!list) { list = []; out.push(list); } list.push(inline(item[1])); continue; }
    list = null;
    out.push(line.trim() ? `<p>${inline(line.replace(/^#+\s*/, ''))}</p>` : '');
  }
  return out.map((b) => (Array.isArray(b) ? `<ul>${b.map((li) => `<li>${li}</li>`).join('')}</ul>` : b)).join('');
}

function chatContext() {
  return { page: currentPage(), id: qs('id') ? Number(qs('id')) : null, type: qs('type') || null };
}

function chatRender() {
  const log = document.getElementById('chat-log');
  if (!log) return;
  log.innerHTML = '';
  if (!chat.messages.length) {
    log.innerHTML = '<div class="chat-hello"><strong>Bonjour !</strong><p>Posez-moi une question sur votre activité, demandez un devis ou un texte de relance. Je consulte vos clients, votre catalogue, vos devis et vos factures.</p><p>Vous pouvez aussi joindre une photo de chantier, un PDF (devis ou tarif fournisseur…) ou un fichier : trombone, glisser-déposer ou coller.</p></div>';
  }
  for (const m of chat.messages) {
    const b = document.createElement('div');
    b.className = 'bubble ' + m.role;
    if (m.role === 'assistant') {
      b.innerHTML = chatFormat(m.content);
      (m.imports || []).forEach((imp) => b.appendChild(chatImportCard(imp)));
    } else {
      if (m.content) b.textContent = m.content;
      if (m.files && m.files.length) {
        const list = document.createElement('div');
        list.className = 'bubble-files';
        for (const f of m.files) {
          const chip = document.createElement('span');
          chip.className = 'file-chip';
          chip.innerHTML = icon(f.kind === 'image' ? 'camera' : 'file');
          chip.append(f.name);
          list.appendChild(chip);
        }
        b.appendChild(list);
      }
    }
    log.appendChild(b);
  }
  if (chat.busy) {
    const t = document.createElement('div');
    t.className = 'bubble assistant typing';
    t.innerHTML = chat.streaming ? chatFormat(chat.streaming) : '<span class="dots"><i></i><i></i><i></i></span> Je consulte vos données…';
    log.appendChild(t);
  }
  document.getElementById('chat-suggest').hidden = chat.messages.length > 0 || chat.available === false || chat.files.length > 0;
  chatRenderFiles();
  const send = document.getElementById('chat-send');
  send.hidden = chat.busy;
  document.getElementById('chat-stop').hidden = !chat.busy;
  log.scrollTop = log.scrollHeight;
}

// Import de catalogue proposé par l'assistant : rien n'est enregistré sans le clic de l'utilisateur
function chatImportCard(imp) {
  const card = document.createElement('div');
  card.className = 'chat-import';
  const title = document.createElement('strong');
  title.textContent = `${imp.rows.length} article(s) à importer${imp.catalog ? ' — catalogue « ' + imp.catalog + ' »' : ''}`;
  const details = document.createElement('details');
  const sum = document.createElement('summary');
  sum.textContent = 'Voir la liste';
  const list = document.createElement('ul');
  for (const r of imp.rows.slice(0, 200)) {
    const li = document.createElement('li');
    const price = r.sale_price !== '' && r.sale_price !== undefined ? ` — ${money(r.sale_price)} HT` : '';
    li.textContent = `${r.reference ? r.reference + ' · ' : ''}${r.designation}${price}`;
    list.appendChild(li);
  }
  details.append(sum, list);
  const note = document.createElement('p');
  note.className = 'small';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'primary';
  if (imp.result) {
    note.textContent = `Importé : ${imp.result.created} créé(s), ${imp.result.updated} mis à jour.`;
    card.append(title, details, note);
    return card;
  }
  note.textContent = 'Vérifiez la liste : les références déjà présentes au catalogue seront mises à jour.';
  btn.textContent = 'Importer dans le catalogue';
  btn.addEventListener('click', async () => {
    if (!(await uiConfirm(`Importer ${imp.rows.length} article(s) dans le catalogue ? Les références existantes seront mises à jour.`))) return;
    btn.disabled = true;
    try {
      imp.result = await api('/items/import', { body: { rows: imp.rows, catalog: imp.catalog || '' } });
      toast(`Catalogue mis à jour : ${imp.result.created} créé(s), ${imp.result.updated} mis à jour`);
      chatSave();
      chatRender();
    } catch (e) { btn.disabled = false; }
  });
  card.append(title, details, note, btn);
  return card;
}

function chatRenderFiles() {
  const box = document.getElementById('chat-files');
  if (!box) return;
  box.hidden = !chat.files.length;
  box.innerHTML = '';
  chat.files.forEach((f, i) => {
    const chip = document.createElement('span');
    chip.className = 'file-chip';
    if (f.kind === 'image') {
      const img = document.createElement('img');
      img.src = f.preview;
      img.alt = '';
      chip.appendChild(img);
    } else chip.innerHTML = icon('file');
    chip.append(f.name);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.setAttribute('aria-label', 'Retirer ' + f.name);
    rm.innerHTML = icon('x');
    rm.disabled = chat.busy;
    rm.addEventListener('click', () => { chat.files.splice(i, 1); chatRender(); });
    chip.appendChild(rm);
    box.appendChild(chip);
  });
}

async function chatAddFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length || chat.busy) return;
  for (const file of files) {
    if (chat.files.length >= CHAT_MAX_FILES) { toast(CHAT_MAX_FILES + ' fichiers maximum par message', 'error'); break; }
    try { chat.files.push(await prepareAttachment(file)); } catch (e) { toast(e.message, 'error'); }
  }
  chatRender();
  document.getElementById('chat-input').focus();
}

// L'historique envoyé mentionne les fichiers des messages précédents (seul le dernier message les transmet)
function chatHistoryForApi() {
  return chat.messages.slice(-20).map((m) => ({
    role: m.role,
    content: (m.content || '') + (m.files && m.files.length ? `\n[Pièces jointes : ${m.files.map((f) => f.name).join(', ')}]` : '')
  })).filter((m) => m.content.trim());
}

async function chatSend(text) {
  text = String(text || '').trim();
  if ((!text && !chat.files.length) || chat.busy) return;
  const input = document.getElementById('chat-input');
  input.value = '';
  input.style.height = '';
  const attachments = chat.files;
  chat.files = [];
  if (!text) text = attachments.length > 1 ? 'Voici des fichiers.' : 'Voici un fichier.';
  chat.messages.push({ role: 'user', content: text, files: attachments.map((f) => ({ name: f.name, kind: f.kind })) });
  chat.busy = true;
  chat.streaming = '';
  chat.ctl = new AbortController();
  chatRender();
  try {
    const r = await aiChat({
      messages: chatHistoryForApi(), context: chatContext(), attachments, signal: chat.ctl.signal,
      onText: (t) => { chat.streaming = t; chatRender(); }
    });
    const msg = { role: 'assistant', content: r.reply };
    if (Array.isArray(r.imports) && r.imports.length) {
      msg.imports = r.imports.filter((i) => i && Array.isArray(i.rows)).map((i) => ({ catalog: String(i.catalog || ''), rows: i.rows }));
    }
    chat.messages.push(msg);
  } catch (e) {
    if (e && e.code === 'cancelled') chat.messages.push({ role: 'assistant', content: '(Réponse interrompue.)' });
    else chat.messages.push({ role: 'assistant', content: '⚠ ' + ((e && e.message) || "L'assistant n'a pas pu répondre.") });
  } finally {
    chat.busy = false;
    chat.streaming = '';
    chat.ctl = null;
    chatSave();
    chatRender();
  }
}

function chatToggle(open) {
  const panel = document.getElementById('chat-panel');
  const show = open === undefined ? panel.hidden : open;
  panel.hidden = !show;
  document.getElementById('chat-fab').setAttribute('aria-expanded', String(show));
  document.body.classList.toggle('chat-open', show);
  if (show) {
    if (chat.available === null) {
      aiAvailable().then((v) => {
        chat.available = v;
        document.getElementById('chat-off').hidden = v;
        document.getElementById('chat-form').hidden = !v;
        document.getElementById('chat-off').innerHTML = v ? '' : aiUnavailableHint();
        chatRender();
      });
    }
    chatRender();
    setTimeout(() => document.getElementById('chat-input').focus(), 50);
  }
}

function chatDictate(btn) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (chat.rec) { chat.rec.stop(); return; }
  const input = document.getElementById('chat-input');
  const rec = new SR();
  rec.lang = 'fr-FR';
  rec.interimResults = true;
  const base = input.value ? input.value.replace(/\s*$/, ' ') : '';
  rec.onresult = (e) => { input.value = base + [...e.results].map((r) => r[0].transcript).join(''); };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      toast('Micro indisponible ici : utilisez le micro du clavier de votre téléphone.', 'error');
      btn.hidden = true;
    }
  };
  rec.onend = () => { chat.rec = null; btn.classList.remove('on'); };
  try { rec.start(); chat.rec = rec; btn.classList.add('on'); } catch (e) { chat.rec = null; }
}

function initChat() {
  if (document.getElementById('chat-fab')) return;
  chatLoad();
  const fab = document.createElement('button');
  fab.id = 'chat-fab';
  fab.type = 'button';
  fab.setAttribute('aria-controls', 'chat-panel');
  fab.setAttribute('aria-expanded', 'false');
  fab.innerHTML = icon('sparkle') + '<span>Assistant</span>';
  fab.addEventListener('click', () => chatToggle());

  const panel = document.createElement('section');
  panel.id = 'chat-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Assistant IA');
  const canDictate = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  panel.innerHTML = `
    <header class="chat-head">
      <span class="tile-ic violet">${icon('sparkle')}</span>
      <div class="chat-title"><strong>Assistant IA</strong><small>Vos clients, devis, factures et chiffres</small></div>
      <a class="icon-btn" href="assistant.html" id="chat-knowledge" aria-label="Instructions et fichiers de l'assistant" title="Instructions et fichiers">${icon('settings')}</a>
      <button type="button" class="icon-btn" id="chat-reset" aria-label="Nouvelle conversation" title="Nouvelle conversation">${icon('edit')}</button>
      <button type="button" class="icon-btn" id="chat-close" aria-label="Fermer l'assistant">${icon('x')}</button>
    </header>
    <div class="chat-log" id="chat-log" aria-live="polite"></div>
    <div class="chat-suggest" id="chat-suggest">${CHAT_SUGGESTIONS.map((s) => `<button type="button">${s}</button>`).join('')}</div>
    <p class="chat-off" id="chat-off" hidden></p>
    <div class="chat-files" id="chat-files" hidden></div>
    <form class="chat-form" id="chat-form">
      <button type="button" class="icon-btn" id="chat-attach" aria-label="Joindre un fichier ou une photo" title="Joindre un fichier ou une photo">${icon('clip')}</button>
      <input type="file" id="chat-file-input" multiple accept="image/*,application/pdf,.pdf,.txt,.csv,.md,.json,.xml" hidden>
      <textarea id="chat-input" rows="1" placeholder="Écrivez votre question…" aria-label="Votre message"></textarea>
      ${canDictate ? `<button type="button" class="icon-btn" id="chat-mic" aria-label="Dicter">${icon('mic')}</button>` : ''}
      <button type="submit" class="icon-btn send" id="chat-send" aria-label="Envoyer">${icon('arrow')}</button>
      <button type="button" class="icon-btn" id="chat-stop" aria-label="Arrêter" hidden>${icon('x')}</button>
    </form>`;
  document.body.append(fab, panel);

  const input = panel.querySelector('#chat-input');
  panel.querySelector('#chat-close').addEventListener('click', () => chatToggle(false));
  panel.querySelector('#chat-reset').addEventListener('click', () => { if (!chat.busy) { chat.messages = []; chatSave(); chatRender(); input.focus(); } });
  panel.querySelector('#chat-suggest').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) chatSend(b.textContent); });
  panel.querySelector('#chat-form').addEventListener('submit', (e) => { e.preventDefault(); chatSend(input.value); });
  panel.querySelector('#chat-stop').addEventListener('click', () => chat.ctl && chat.ctl.abort());
  const fileInput = panel.querySelector('#chat-file-input');
  panel.querySelector('#chat-attach').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { chatAddFiles(fileInput.files); fileInput.value = ''; });
  panel.addEventListener('dragover', (e) => { if (chat.available !== false) { e.preventDefault(); panel.classList.add('drop'); } });
  panel.addEventListener('dragleave', (e) => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('drop'); });
  panel.addEventListener('drop', (e) => { e.preventDefault(); panel.classList.remove('drop'); if (chat.available !== false) chatAddFiles(e.dataTransfer.files); });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData ? e.clipboardData.files : [])];
    if (files.length) { e.preventDefault(); chatAddFiles(files); }
  });
  const mic = panel.querySelector('#chat-mic');
  if (mic) mic.addEventListener('click', () => chatDictate(mic));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend(input.value); } });
  input.addEventListener('input', () => { input.style.height = ''; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; });
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); chatToggle(false); fab.focus(); } });
  chatRender();
}

document.addEventListener('DOMContentLoaded', initChat);
