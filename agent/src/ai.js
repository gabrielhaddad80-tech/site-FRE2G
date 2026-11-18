// Rédaction assistée du devis par Claude, à partir des notes de visite technique.
// Claude renvoie un devis structuré selon le modèle FRE2G ; rien n'est envoyé au client
// sans relecture : le résultat remplit l'éditeur, en brouillon.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod/v4';

const DevisDraft = z.object({
  objet: z.string().describe("Objet du devis, une phrase (ex. « Fourniture et pose de climatisations réversibles Daikin Stylish — grand bureau et bureaux du fond »)"),
  adresse_travaux: z.string().describe("Adresse du chantier si elle figure dans les notes, sinon chaîne vide"),
  client: z.object({
    type: z.enum(['particulier', 'professionnel']),
    civilite: z.enum(['M.', 'Mme', '']),
    prenom: z.string(),
    nom: z.string(),
    societe: z.string(),
    email: z.string(),
    telephone: z.string(),
    adresse: z.string(),
    code_postal: z.string(),
    ville: z.string()
  }).describe('Coordonnées du client trouvées dans les notes ; chaînes vides si inconnues'),
  lettre: z.object({
    formule_appel: z.string().describe('« Madame, », « Monsieur, » ou « Madame, Monsieur, »'),
    paragraphes: z.array(z.string()).describe("Corps de la lettre d'accompagnement : contexte de la demande, solution proposée, durée d'intervention"),
    conclusion: z.string()
  }),
  materiel: z.object({
    introduction: z.string(),
    articles: z.array(z.object({
      quantite: z.number(),
      reference: z.string().describe('Marque et référence exacte, ex. « Daikin FTXA50CW »'),
      designation: z.string(),
      caracteristiques: z.string().describe('Puissances froid/chaud, fluide, alimentation, emplacement')
    })),
    note: z.string().describe('Remarque technique, ex. diamètres des liaisons frigorifiques ; vide sinon')
  }),
  travaux: z.object({
    introduction: z.string(),
    phases: z.array(z.object({ titre: z.string(), etapes: z.array(z.string()) }))
  }),
  lignes: z.array(z.object({
    poste: z.string(),
    quantite: z.number(),
    prix_unitaire_ht: z.number().describe('0 si le prix ne figure ni dans les notes ni dans les tarifs fournis'),
    tva: z.number().describe('20, 10 ou 5.5')
  })),
  conditions: z.object({
    delai: z.string(),
    non_compris: z.string(),
    garantie: z.string(),
    note_tva: z.string().describe('Justification du taux de TVA appliqué')
  }),
  points_a_verifier: z.array(z.string()).describe('Ce que FRE2G doit compléter ou vérifier avant envoi : prix manquants, informations absentes, hypothèses faites')
});

const SYSTEM = `Tu rédiges les devis de FRE2G, entreprise d'installation de climatisation et de pompes à chaleur (Aubervilliers, Île-de-France), à partir des notes de visite technique d'un technicien.

Le devis FRE2G suit toujours ce modèle :
1. Une lettre d'accompagnement courtoise et concrète (vouvoiement) : rappel de la demande et du lieu, solution proposée pièce par pièce (unités intérieures, groupe extérieur et leur emplacement, fluide R32, réversible froid/chaud), durée de main d'œuvre prévue.
2. « Matériel proposé » : un article par équipement avec quantité, référence exacte du fabricant, désignation et caractéristiques (puissance froid et chaud en kW, fluide, alimentation, emplacement).
3. « Description des travaux » : des phases numérotées (par zone ou par lot : pose des unités, liaisons frigorifiques, électricité et condensats, mise en service), chacune avec des étapes courtes. La mise en service comprend toujours le test d'étanchéité à l'azote, le tirage au vide, le contrôle de la charge et les essais froid/chaud. Pour un remplacement d'installation existante, prévoir la récupération du fluide avec traçabilité réglementaire et la dépose.
4. « Montant » : les postes chiffrés (équipements ou ensembles, liaisons frigorifiques, électricité, main d'œuvre en jours, éco-contribution DEEE si des équipements sont fournis).
5. « Conditions » : délai, ce qui n'est pas compris, garantie.

Règles :
- N'invente jamais un prix. Utilise uniquement les prix donnés dans les notes ou dans la grille tarifaire fournie ; sinon mets 0 et ajoute le poste dans « points_a_verifier ».
- N'invente pas de référence de matériel absente des notes : si le technicien n'en donne pas, décris le besoin (« Unité murale 2,5 kW, référence à préciser ») et signale-le dans « points_a_verifier ».
- TVA : 20 % pour les locaux professionnels et les logements de moins de 2 ans ; 10 % pour les travaux dans un logement de plus de 2 ans (attestation du client nécessaire) ; 5,5 % seulement pour les équipements éligibles (pompe à chaleur air/eau, etc.). Explique le taux retenu dans « note_tva ». En cas de doute, 20 % et un point à vérifier.
- Style sobre et professionnel, en français, sans superlatifs commerciaux.

Exemple de devis FRE2G réel (extrait, à imiter pour le ton et la structure) :
Objet : Fourniture et pose de climatisations réversibles Daikin Stylish — grand bureau et bureaux du fond.
Lettre : « Suite à votre demande, nous avons le plaisir de vous adresser notre proposition pour la climatisation de vos bureaux situés 1, boulevard du Montparnasse, à Paris 6e. Pour le grand bureau, nous proposons un monosplit Daikin Stylish de 5 kW : l'unité murale FTXA50 est posée au-dessus du radiateur et raccordée à son groupe extérieur installé en toiture. Pour les bureaux du fond, nous proposons un multisplit Daikin : un groupe extérieur 2MXM40 posé sur le balcon alimente deux unités murales Stylish, une CTXA15 et une FTXA25. Ces équipements au R32 assurent le rafraîchissement l'été et le chauffage l'hiver. L'installation est prévue sur 2,5 jours de main d'œuvre. »
Matériel : 1 × Daikin RXA50B — Groupe extérieur monosplit Stylish, inverter — 5 kW · R32 · monophasé · posé en toiture ; 1 × Daikin FTXA50CW — Unité murale Stylish blanche — 5,0 kW en froid · 5,8 kW en chaud.
Travaux : « 1. Grand bureau » : Pose de l'unité murale… ; Manutention et pose du groupe extérieur en toiture ; Réalisation d'une liaison frigorifique cuivre isolée avec câble d'interconnexion. « 4. Mise en service » : Test d'étanchéité à l'azote et tirage au vide des circuits ; Mise en service, contrôle de la charge R32 ; Essais en mode froid et chaud ; Explication du fonctionnement des télécommandes et du pilotage Wi-Fi.
Montant : Ensemble monosplit Daikin Stylish FTXA50CW + RXA50B — 1 × 4 215,83 € ; Liaison frigorifique cuivre isolée avec câble d'interconnexion — 3 × 500,00 € ; Main d'œuvre : pose, raccordements, mise en service (jours) — 2,5 × 900,00 € ; Éco-contribution DEEE — 2 × 7,67 €.
Conditions : Délai : intervention à planifier après réception de l'acompte, selon la disponibilité du matériel. Non compris : travaux d'étanchéité, de maçonnerie, de faux plafonds et de peinture ; pompe de relevage si l'évacuation des condensats ne peut pas se faire en gravitaire. Garantie : garantie constructeur Daikin sur le matériel, compresseur garanti 3 ans.`;

export class AiError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

export function createAi(config) {
  if (!config.aiEnabled) {
    return { enabled: false, async draftQuote() { throw new AiError("La rédaction par Claude n'est pas activée : ajoutez ANTHROPIC_API_KEY dans le fichier .env.", 503); } };
  }
  const client = new Anthropic();

  async function draftQuote({ notes, priceList = '', defaults = {} }) {
    const text = String(notes || '').trim();
    if (text.length < 20) throw new AiError('Décrivez la visite technique en quelques lignes (pièces, matériel, contraintes, prix connus).', 400);
    const userContent = [
      priceList.trim() ? `Grille tarifaire interne FRE2G (prix de vente HT) :\n${priceList.trim()}` : 'Aucune grille tarifaire fournie : ne chiffre que ce que les notes indiquent.',
      `Conditions par défaut de FRE2G (à reprendre sauf indication contraire) :\nDélai : ${defaults.delai || ''}\nNon compris : ${defaults.non_compris || ''}\nGarantie : ${defaults.garantie || ''}`,
      `Notes de la visite technique :\n${text}`
    ].join('\n\n---\n\n');

    let response;
    try {
      response = await client.beta.messages.parse({
        model: config.anthropicModel,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'high', format: betaZodOutputFormat(DevisDraft) },
        system: SYSTEM,
        messages: [{ role: 'user', content: userContent }]
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new AiError('Clé API Anthropic refusée : vérifiez ANTHROPIC_API_KEY.', 503);
      if (e instanceof Anthropic.RateLimitError) throw new AiError('Claude est très sollicité : réessayez dans une minute.', 429);
      if (e instanceof Anthropic.APIConnectionError) throw new AiError('Impossible de joindre Claude : vérifiez la connexion internet.', 502);
      if (e instanceof Anthropic.APIError) throw new AiError(`Erreur de Claude (${e.status}) : ${e.message}`, 502);
      throw e;
    }
    if (response.stop_reason === 'refusal') throw new AiError("Claude n'a pas pu rédiger ce devis à partir de ces notes.", 422);
    if (response.stop_reason === 'max_tokens') throw new AiError('Les notes sont trop longues pour un seul devis : découpez-les.', 422);
    const d = response.parsed_output;
    if (!d) throw new AiError("La réponse de Claude n'a pas pu être lue : réessayez.", 502);
    return toQuoteInput(d);
  }

  return { enabled: true, draftQuote };
}

// Format de Claude -> format de l'éditeur de devis
export function toQuoteInput(d) {
  return {
    object: d.objet,
    site_address: d.adresse_travaux,
    prospect: {
      kind: d.client.type, civility: d.client.civilite, first_name: d.client.prenom, last_name: d.client.nom,
      company: d.client.societe, email: d.client.email, phone: d.client.telephone,
      address: d.client.adresse, postal_code: d.client.code_postal, city: d.client.ville
    },
    letter: { greeting: d.lettre.formule_appel, body: d.lettre.paragraphes.join('\n\n'), closing: d.lettre.conclusion },
    materiel: {
      intro: d.materiel.introduction, note: d.materiel.note,
      items: d.materiel.articles.map((a) => ({ qty: a.quantite, reference: a.reference, designation: a.designation, caracteristiques: a.caracteristiques, supplier_id: null }))
    },
    travaux: { intro: d.travaux.introduction, phases: d.travaux.phases.map((p) => ({ title: p.titre, steps: p.etapes })) },
    lines: d.lignes.map((l) => ({ designation: l.poste, qty: l.quantite, unit_price: l.prix_unitaire_ht, vat_rate: l.tva })),
    conditions: { delai: d.conditions.delai, non_compris: d.conditions.non_compris, garantie: d.conditions.garantie, vat_note: d.conditions.note_tva },
    points_a_verifier: d.points_a_verifier
  };
}
