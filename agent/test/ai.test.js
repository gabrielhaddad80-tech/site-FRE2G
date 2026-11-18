// Rédaction par Claude : forme de la requête et conversion du résultat (sans appel réel à l'API).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAi } from '../src/ai.js';

const DRAFT = {
  objet: 'Climatisation du salon', adresse_travaux: '3 rue Test, 93300 Aubervilliers',
  client: { type: 'particulier', civilite: 'M.', prenom: 'Alexis', nom: 'Mariage', societe: '', email: '', telephone: '', adresse: '', code_postal: '', ville: '' },
  lettre: { formule_appel: 'Monsieur,', paragraphes: ['Suite à votre demande…', "L'installation est prévue sur 1 jour."], conclusion: 'Nous restons à votre disposition.' },
  materiel: { introduction: '', articles: [{ quantite: 1, reference: 'Daikin FTXM35R', designation: 'Unité murale Perfera', caracteristiques: '3,5 kW froid' }], note: '' },
  travaux: { introduction: '', phases: [{ titre: 'Salon', etapes: ["Pose de l'unité murale", 'Mise en service'] }] },
  lignes: [{ poste: 'Fourniture et pose', quantite: 1, prix_unitaire_ht: 0, tva: 10 }],
  conditions: { delai: 'Sous 3 semaines', non_compris: 'Peinture', garantie: '3 ans', note_tva: 'TVA à 10 % : logement de plus de 2 ans' },
  points_a_verifier: ['Prix de la fourniture et pose']
};

test('la requête part sur Claude Opus 5.5 en sortie structurée, et le résultat remplit l\'éditeur', async () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), body: JSON.parse(init.body), headers: new Headers(init.headers) };
    return new Response(JSON.stringify({
      id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: JSON.stringify(DRAFT) }], usage: { input_tokens: 1, output_tokens: 1 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  try {
    const ai = createAi({ aiEnabled: true, anthropicModel: 'claude-opus-5-5' });
    const r = await ai.draftQuote({ notes: 'M. Mariage, salon 30 m², Daikin Perfera 3,5 kW, groupe en façade.', priceList: "Main d'œuvre : 900 € HT/jour" });
    assert.equal(captured.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(captured.body.model, 'claude-opus-5-5');
    assert.equal(captured.body.fallbacks, 'default');
    assert.equal(captured.body.output_config.format.type, 'json_schema');
    assert.match(captured.headers.get('anthropic-beta'), /server-side-fallback-2026-07-01/);
    assert.match(captured.body.messages[0].content, /900 € HT\/jour/);
    assert.equal(r.prospect.last_name, 'Mariage');
    assert.equal(r.letter.body, "Suite à votre demande…\n\nL'installation est prévue sur 1 jour.");
    assert.equal(r.materiel.items[0].reference, 'Daikin FTXM35R');
    assert.deepEqual(r.travaux.phases[0].steps, ["Pose de l'unité murale", 'Mise en service']);
    assert.equal(r.lines[0].vat_rate, 10);
    assert.deepEqual(r.points_a_verifier, ['Prix de la fourniture et pose']);
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = realKey;
  }
});

test('sans clé API, la rédaction par Claude est désactivée proprement', async () => {
  const ai = createAi({ aiEnabled: false });
  assert.equal(ai.enabled, false);
  await assert.rejects(ai.draftQuote({ notes: 'x'.repeat(50) }), /ANTHROPIC_API_KEY/);
});
