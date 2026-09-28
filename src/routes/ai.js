'use strict';

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { getSettings } = require('../db');
const AiDraft = require('../../public/js/ai');

const AnthropicClient = Anthropic.default || Anthropic;
const MODEL = 'claude-opus-5-5';
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_IMAGES = 5;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
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
      if (e instanceof AnthropicClient.AuthenticationError) return next(httpError(401, 'Clé API Anthropic refusée : vérifiez-la dans Paramètres.'));
      if (e instanceof AnthropicClient.PermissionDeniedError) return next(httpError(403, "Cette clé API n'a pas accès au modèle demandé."));
      if (e instanceof AnthropicClient.RateLimitError) return next(httpError(429, "Trop de demandes à l'IA pour le moment : réessayez dans une minute."));
      if (e instanceof AnthropicClient.APIConnectionError) return next(httpError(502, "Impossible de joindre le service d'IA : vérifiez la connexion Internet."));
      if (e instanceof AnthropicClient.APIError) return next(httpError(502, `Le service d'IA a renvoyé une erreur (${e.status || 'inconnue'}).`));
      next(e);
    }
  });

  return r;
};
