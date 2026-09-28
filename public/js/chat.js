/* Chat avec l'assistant IA : bulle flottante présente sur toutes les pages du logiciel. */
'use strict';

const CHAT_KEY = 'fre2g-chat-v1';
const CHAT_SUGGESTIONS = [
  'Quelles factures sont en retard ?',
  "Quel est mon chiffre d'affaires cette année ?",
  'Quels devis dois-je relancer ?',
  'Prépare un devis pour la pose de 20 m² de carrelage'
];

const chat = { messages: [], busy: false, ctl: null, available: null, rec: null };

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
    log.innerHTML = '<div class="chat-hello"><strong>Bonjour !</strong><p>Posez-moi une question sur votre activité, demandez un devis ou un texte de relance. Je consulte vos clients, votre catalogue, vos devis et vos factures.</p></div>';
  }
  for (const m of chat.messages) {
    const b = document.createElement('div');
    b.className = 'bubble ' + m.role;
    if (m.role === 'assistant') b.innerHTML = chatFormat(m.content);
    else b.textContent = m.content;
    log.appendChild(b);
  }
  if (chat.busy) {
    const t = document.createElement('div');
    t.className = 'bubble assistant typing';
    t.innerHTML = chat.streaming ? chatFormat(chat.streaming) : '<span class="dots"><i></i><i></i><i></i></span> Je consulte vos données…';
    log.appendChild(t);
  }
  document.getElementById('chat-suggest').hidden = chat.messages.length > 0 || chat.available === false;
  const send = document.getElementById('chat-send');
  send.hidden = chat.busy;
  document.getElementById('chat-stop').hidden = !chat.busy;
  log.scrollTop = log.scrollHeight;
}

async function chatSend(text) {
  text = String(text || '').trim();
  if (!text || chat.busy) return;
  const input = document.getElementById('chat-input');
  input.value = '';
  input.style.height = '';
  chat.messages.push({ role: 'user', content: text });
  chat.busy = true;
  chat.streaming = '';
  chat.ctl = new AbortController();
  chatRender();
  try {
    const r = await aiChat({
      messages: chat.messages.slice(-20), context: chatContext(), signal: chat.ctl.signal,
      onText: (t) => { chat.streaming = t; chatRender(); }
    });
    chat.messages.push({ role: 'assistant', content: r.reply });
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
      <button type="button" class="icon-btn" id="chat-reset" aria-label="Nouvelle conversation" title="Nouvelle conversation">${icon('edit')}</button>
      <button type="button" class="icon-btn" id="chat-close" aria-label="Fermer l'assistant">${icon('x')}</button>
    </header>
    <div class="chat-log" id="chat-log" aria-live="polite"></div>
    <div class="chat-suggest" id="chat-suggest">${CHAT_SUGGESTIONS.map((s) => `<button type="button">${s}</button>`).join('')}</div>
    <p class="chat-off" id="chat-off" hidden></p>
    <form class="chat-form" id="chat-form">
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
  const mic = panel.querySelector('#chat-mic');
  if (mic) mic.addEventListener('click', () => chatDictate(mic));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend(input.value); } });
  input.addEventListener('input', () => { input.style.height = ''; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; });
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); chatToggle(false); fab.focus(); } });
  chatRender();
}

document.addEventListener('DOMContentLoaded', initChat);
