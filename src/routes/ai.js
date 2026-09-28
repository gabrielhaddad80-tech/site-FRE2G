'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { getSettings } = require('../db');
const AiDraft = require('../../public/js/ai');
const { handlebars } = require('../render');

const AnthropicClient = Anthropic.default || Anthropic;
const MODEL = 'claude-opus-5-5';
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_IMAGES = 5;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Traduit les erreurs de l'API en messages compréhensibles
function apiError(e) {
  if (e instanceof AnthropicClient.AuthenticationError) return httpError(401, 'Clé API Anthropic refusée : vérifiez-la dans Paramètres.');
  if (e instanceof AnthropicClient.PermissionDeniedError) return httpError(403, "Cette clé API n'a pas accès au modèle demandé.");
  if (e instanceof AnthropicClient.RateLimitError) return httpError(429, "Trop de demandes à l'IA pour le moment : réessayez dans une minute.");
  if (e instanceof AnthropicClient.APIConnectionError) return httpError(502, "Impossible de joindre le service d'IA : vérifiez la connexion Internet.");
  if (e instanceof AnthropicClient.APIError) return httpError(502, `Le service d'IA a renvoyé une erreur (${e.status || 'inconnue'}).`);
  return e;
}

/**
 * Assistant IA : génère des lignes de devis/facture à partir d'un texte dicté ou écrit et de photos.
 * La clé API vient de ANTHROPIC_API_KEY ou des paramètres ; elle n'est jamais renvoyée au navigateur.
 */
module.exports = function aiRoutes(db, options = {}) {
  const r = express.Router();
  const createClient = options.createClient || ((apiKey) => new AnthropicClient({ apiKey }));
  const apiKey = () => process.env.ANTHROPIC_API_KEY || getSettings(db).anthropic_api_key || '';

  r.get('/ai/status', (req, res) => {
    res.json({ available: !!apiKey(), source: process.env.ANTHROPIC_API_KEY ? 'environment' : (apiKey() ? 'settings' : null) });
  });

  r.post('/ai/draft', async (req, res, next) => {
    try {
      const key = apiKey();
      if (!key) throw httpError(503, "L'assistant IA n'est pas configuré : ajoutez votre clé API Anthropic dans Paramètres.");
      const text = String(req.body.text || '').slice(0, 20000);
      const images = (Array.isArray(req.body.images) ? req.body.images : []).slice(0, MAX_IMAGES)
        .filter((im) => im && IMAGE_TYPES.includes(im.media_type) && typeof im.data === 'string' && im.data.length);
      if (!text.trim() && !images.length) throw httpError(400, 'Dictez, écrivez une note ou ajoutez au moins une photo.');

      const settings = getSettings(db);
      const catalog = db.prepare('SELECT id, type, reference, designation, description, unit, sale_price, purchase_price, vat_rate FROM items WHERE active = 1 ORDER BY id LIMIT ?')
        .all(AiDraft.MAX_CATALOG_ITEMS);
      const vatExempt = settings.vat_exempt === '1';
      const prompt = AiDraft.buildPrompt({
        text, imageCount: images.length, docType: req.body.doc_type, catalog, vatExempt,
        defaultVat: settings.default_vat_rate, units: (settings.units || '').split(',').map((u) => u.trim()).filter(Boolean)
      });

      const response = await createClient(key).beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: AiDraft.SCHEMA } },
        messages: [{
          role: 'user',
          content: [
            ...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })),
            { type: 'text', text: prompt }
          ]
        }]
      });

      if (response.stop_reason === 'refusal') throw httpError(422, "L'IA n'a pas pu traiter cette demande. Reformulez-la ou retirez une photo.");
      if (response.stop_reason === 'max_tokens') throw httpError(502, 'La réponse de l\'IA est incomplète : découpez la demande en plusieurs parties.');
      const out = response.content.find((b) => b.type === 'text');
      let parsed;
      try { parsed = JSON.parse(out ? out.text : ''); } catch (e) { throw httpError(502, "La réponse de l'IA est illisible. Réessayez."); }
      res.json(AiDraft.normalize(parsed, catalog, { vatExempt, defaultVat: settings.default_vat_rate }));
    } catch (e) {
      next(apiError(e));
    }
  });

  // Conversion d'un modèle existant (image, ou 1re page d'un PDF convertie en image par le navigateur)
  r.post('/ai/template', async (req, res, next) => {
    try {
      const key = apiKey();
      if (!key) throw httpError(503, "L'assistant IA n'est pas configuré : ajoutez votre clé API Anthropic dans Paramètres.");
      const im = req.body.image;
      if (!im || !IMAGE_TYPES.includes(im.media_type) || typeof im.data !== 'string' || !im.data) throw httpError(400, 'Ajoutez une image (JPEG, PNG) ou un PDF de votre modèle.');
      const tplDir = path.join(__dirname, '..', '..', 'templates');
      const prompt = AiDraft.buildTemplatePrompt({
        exampleHtml: fs.readFileSync(path.join(tplDir, 'classique.hbs'), 'utf8'),
        exampleCss: fs.readFileSync(path.join(tplDir, 'classique.css'), 'utf8')
      });
      // Réponse longue (HTML + CSS) : le streaming évite les délais d'attente HTTP
      const response = await createClient(key).beta.messages.stream({
        model: MODEL,
        max_tokens: 32000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'high', format: { type: 'json_schema', schema: AiDraft.TEMPLATE_SCHEMA } },
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } },
          { type: 'text', text: prompt }
        ] }]
      }).finalMessage();
      if (response.stop_reason === 'refusal') throw httpError(422, "L'IA n'a pas pu traiter cette image. Essayez avec une autre page ou une photo plus nette.");
      if (response.stop_reason === 'max_tokens') throw httpError(502, "Le modèle généré est trop long : réessayez.");
      const out = response.content.find((b) => b.type === 'text');
      let tpl;
      try { tpl = AiDraft.normalizeTemplate(JSON.parse(out ? out.text : '')); } catch (e) { throw httpError(502, "La réponse de l'IA est illisible. Réessayez."); }
      if (!tpl.html) throw httpError(502, "L'IA n'a pas produit de modèle. Réessayez.");
      try { handlebars.precompile(tpl.html); handlebars.precompile(tpl.css); } catch (e) {
        throw httpError(502, "Le modèle généré contient une erreur de syntaxe. Réessayez.");
      }
      res.json(tpl);
    } catch (e) {
      next(apiError(e));
    }
  });

  // Chat avec l'assistant : Claude utilise les outils (lecture des données, création de devis brouillon)
  r.post('/ai/chat', async (req, res, next) => {
    try {
      const key = apiKey();
      if (!key) throw httpError(503, "L'assistant IA n'est pas configuré : ajoutez votre clé API Anthropic dans Paramètres.");
      const history = (Array.isArray(req.body.messages) ? req.body.messages : [])
        .filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content.trim())
        .slice(-20)
        .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
      while (history.length && history[0].role !== 'user') history.shift();
      if (!history.length || history[history.length - 1].role !== 'user') throw httpError(400, 'Écrivez un message.');
      const note = AiDraft.contextNote(req.body.context);
      if (note) history[history.length - 1] = { role: 'user', content: history[history.length - 1].content + '\n\n' + note };
      // Pièces jointes du dernier message : images, PDF (lus en entier par Claude) et fichiers texte
      const files = (Array.isArray(req.body.attachments) ? req.body.attachments : []).slice(0, MAX_IMAGES);
      if (files.length) {
        const blocks = [];
        for (const f of files) {
          const name = String((f && f.name) || 'fichier').slice(0, 120);
          if (f.kind === 'image' && IMAGE_TYPES.includes(f.media_type) && typeof f.data === 'string' && f.data) {
            blocks.push({ type: 'image', source: { type: 'base64', media_type: f.media_type, data: f.data } });
            blocks.push({ type: 'text', text: `(Image ci-dessus : « ${name} »)` });
          } else if (f.kind === 'pdf' && typeof f.data === 'string' && f.data) {
            if (f.data.length > 14 * 1024 * 1024) throw httpError(413, `Le PDF « ${name} » est trop volumineux (10 Mo maximum).`);
            blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data }, title: name });
          } else if (f.kind === 'text' && typeof f.text === 'string') {
            blocks.push({ type: 'text', text: `Contenu du fichier « ${name} » :\n${f.text.slice(0, 60000)}` });
          } else {
            throw httpError(400, `Type de fichier non pris en charge : « ${name} ».`);
          }
        }
        const last = history[history.length - 1];
        history[history.length - 1] = { role: 'user', content: [...blocks, { type: 'text', text: last.content }] };
      }

      const settings = getSettings(db);
      const d = new Date();
      const today = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      const system = AiDraft.chatSystemPrompt({ company: settings.company_name, today });

      // Les outils appellent l'API du logiciel lui-même (mêmes règles que l'interface)
      const port = req.socket.localPort;
      const request = async (method, url, body) => {
        const r2 = await fetch(`http://127.0.0.1:${port}/api${url}`, {
          method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined
        });
        const data = await r2.json().catch(() => null);
        if (!r2.ok) throw new Error((data && data.error) || `Erreur ${r2.status}`);
        return data;
      };

      const client = createClient(key);
      const messages = [...history];
      const created = [];
      for (let round = 0; round < 8; round++) {
        const response = await client.beta.messages.create({
          model: MODEL,
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'medium' },
          system,
          tools: AiDraft.CHAT_TOOLS,
          messages
        });
        if (response.stop_reason === 'refusal') throw httpError(422, "L'IA n'a pas pu répondre à cette demande. Reformulez-la.");
        if (response.stop_reason !== 'tool_use') {
          const reply = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n').trim();
          return res.json({ reply: reply || "Je n'ai pas de réponse à proposer. Pouvez-vous préciser ?", created });
        }
        // Tour d'outils : on renvoie tout le contenu de l'assistant, puis tous les résultats dans un seul message
        messages.push({ role: 'assistant', content: response.content });
        const results = [];
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;
          try {
            const out = await AiDraft.runChatTool(block.name, block.input, request);
            if (block.name === 'creer_devis') created.push({ number: out.numero, link: out.link });
            results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out).slice(0, 30000) });
          } catch (e) {
            results.push({ type: 'tool_result', tool_use_id: block.id, content: 'Erreur : ' + e.message, is_error: true });
          }
        }
        messages.push({ role: 'user', content: results });
      }
      res.json({ reply: "J'ai dû m'arrêter avant la fin : la demande demandait trop d'étapes. Pouvez-vous la découper ?", created });
    } catch (e) {
      next(apiError(e));
    }
  });

  return r;
};
