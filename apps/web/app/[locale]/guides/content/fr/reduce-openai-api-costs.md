Une facture OpenAI est la somme de quelques chiffres par requête : les tokens d'entrée hors cache, les tokens d'entrée en cache, les écritures en cache (sur GPT-5.6 et les modèles suivants), les tokens de sortie (raisonnement compris) et le prix du modèle. Toute façon de la réduire agit sur l'un de ces chiffres. Ce guide passe en revue les leviers dans l'ordre où ils rapportent le plus souvent, dit quand chacun ne rapporte rien, et montre comment prouver chaque économie avec les données d'usage d'OpenAI elles-mêmes plutôt qu'avec une projection. L'essentiel ne demande aucun outil ; là où le SDK open source BV-SALA automatise un levier, vous verrez comment.

## Commencez par mesurer chaque requête

Avant de changer quoi que ce soit, enregistrez le bloc `usage` de chaque réponse avec la fonctionnalité ou le template de prompt qui l'a produite : `prompt_tokens`, `prompt_tokens_details.cached_tokens`, `cache_write_tokens` quand le modèle le renvoie, `completion_tokens` et, pour les modèles de raisonnement, `completion_tokens_details.reasoning_tokens`. Valorisez chaque poste avec les tarifs de la page de prix d'OpenAI et notez la date à laquelle vous les avez copiés. Sur GPT-5.6 et les modèles suivants, les écritures en cache forment un poste à part : OpenAI les facture 1.25 fois le tarif d'entrée hors cache avec la durée de vie par défaut de 30 minutes, et 2.5 fois avec la durée de vie de 12 heures ([guide du prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), consulté le 23 novembre 2026). Comptez-les comme de l'entrée ordinaire et vous sous-estimez la facture. Une semaine de ce suivi répond à la seule question qui compte au départ : **quelles sont les deux ou trois fonctionnalités qui font l'essentiel de la facture.** Optimisez celles-là ; ignorez le reste.

## 1. Ne payez pas deux fois la même requête

Les nouvelles tentatives, les doubles clics, les tâches nocturnes qui reclassent les éléments de la veille et les workers parallèles qui envoient le même prompt coûtent chacun un appel complet. Un cache de réponses à correspondance exacte et la déduplication des requêtes en vol les éliminent sans changer une seule réponse. Ce que vous économisez dépend entièrement de la fréquence à laquelle vos requêtes se répètent : mesurez donc d'abord votre taux de doublons. Guide complet : [dédupliquer les requêtes LLM identiques](/fr/guides/deduplicate-llm-requests).

## 2. Laissez travailler le cache de prompts d'OpenAI

Les prompts d'environ 1,024 tokens ou plus sont mis en cache automatiquement, et les tokens d'entrée en cache sont facturés avec une remise. Sur GPT-5.6 et les modèles suivants, remplir le cache n'est pas gratuit : la partie qui y est écrite est facturée au-dessus du tarif hors cache, comme décrit plus haut. Un prompt écrit puis jamais relu coûte donc plus cher que sans cache, et un prompt relu peu après coûte beaucoup moins. Les modèles antérieurs ne facturent rien de plus pour les écritures. La correspondance du cache part toujours du premier token : il ne fonctionne donc que si le début de votre prompt est identique d'une requête à l'autre. Placez en tête les instructions, les définitions d'outils et les exemples, et à la fin les dates, les noms d'utilisateur et la question. Si `cached_tokens` reste bloqué à 0, voyez [pourquoi cached_tokens vaut 0 chez OpenAI](/fr/guides/openai-prompt-caching-cached-tokens).

## 3. Envoyez à l'API Batch le travail qui peut attendre

Les évaluations, les retraitements d'historique, les embeddings d'un corpus de documents et la classification nocturne n'ont pas besoin d'une réponse en deux secondes. L'[API Batch](https://developers.openai.com/api/docs/guides/batch) d'OpenAI prend un fichier de requêtes, renvoie les résultats en moins d'une journée et les facture à un tarif inférieur à celui des mêmes requêtes envoyées une par une (voir le [guide d'optimisation des coûts](https://developers.openai.com/api/docs/guides/cost-optimization) pour les conditions actuelles). C'est souvent, à elle seule, la plus grosse économie pour le travail hors ligne, et elle ne change rien aux réponses.

## 4. Utilisez le plus petit modèle qui réussit votre évaluation

Les écarts de prix entre gammes de modèles sont importants, et beaucoup de tâches (classification, extraction, reformulations courtes, routage) n'ont pas besoin du plus gros modèle. Constituez un petit jeu d'évaluation à partir de requêtes réelles, passez-le sur deux ou trois modèles et choisissez le moins cher qui le réussit. Relancez-le à chaque sortie de modèle. Sans évaluation, descendre de gamme est un pari, et le coût des mauvaises réponses n'apparaît pas sur la facture de l'API.

## 5. Maîtrisez la sortie

Les tokens de sortie coûtent généralement plusieurs fois plus cher que les tokens d'entrée, et les tokens de raisonnement sont facturés comme de la sortie.

- Réglez `max_completion_tokens` sur ce dont la fonctionnalité a réellement besoin.
- Pour les modèles de raisonnement, baissez l'effort de raisonnement sur les tâches qui n'exigent pas de raisonnement approfondi, et mesurez `reasoning_tokens` avant et après.
- Demandez une sortie structurée avec un schéma JSON quand votre code analyse la réponse. Un échec d'analyse suivi d'une nouvelle tentative fait payer deux fois la requête entière.

## 6. Envoyez moins d'entrée

- Ne renvoyez pas toute la conversation quand la tâche n'a besoin que des derniers tours.
- Retirez des tours suivants les grosses sorties d'outils (logs, contenus de fichiers, résultats de recherche) une fois qu'elles ont servi.
- Envoyez les données structurées sous forme compacte : un JSON indenté dépense des tokens en espaces.
- Récupérez les trois paragraphes pertinents au lieu de coller le document entier.

Attention aux deux derniers points dans les longues boucles d'agent : modifier le milieu d'un historique qu'OpenAI a déjà mis en cache fait refacturer tout ce qui suit la modification, au tarif hors cache ou, sur GPT-5.6 et les modèles suivants, au tarif d'écriture en cache, plus élevé, lorsqu'il est remis en cache. Raccourcissez ce qui est nouveau, pas ce qui est déjà en cache.

## Comment BV-SALA en automatise une partie

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) est une couche d'économies sous licence Apache-2.0 qui enveloppe n'importe quel endpoint compatible OpenAI en TypeScript. Elle économise avec tous les leviers **gratuitement, sans clé et sans inscription**, et n'envoie rien à BiVelio, sauf si vous ajoutez une clé pour le tableau de bord cloud facultatif. Activés par défaut : le cache exact, la déduplication des requêtes identiques en vol, la réponse locale aux calculs arithmétiques simples et la sérialisation compacte des données structurées que vous transmettez. À activer explicitement, avec une option chacun : la cascade de modèles, le compactage des sorties d'outils et la réorganisation du préfixe pour le cache. Chaque requête renvoie un rapport qui dit ce qui a été économisé et d'où vient le chiffre.

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({
    baseUrl: "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY,
  }),
});

const { text, report } = await layer.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
});
console.log(text); // "8": computed on your machine, no call to OpenAI
console.log(report.calls.avoidedLlm); // 1: a whole call you did not pay for
console.log(report.cost.basis); // "estimated": nothing ran, so there is no provider counter to read
```

Deux limites, en toute honnêteté. D'abord, un trafic qui ne se répète jamais économise environ 0 % grâce au cache et à la déduplication, et c'est voulu. Ensuite, l'élagage par défaut des résultats d'outils devenus obsolètes peut coûter plus qu'il ne rapporte dans les longues boucles d'agent, chez un fournisseur qui met tout le prompt en cache : le changelog du projet rapporte +12.2 % sur une boucle de 60 étapes avec `gpt-5`, mesuré contre un faux fournisseur avec les versions 1.2.3 et 1.2.4, sans clé. Pour les longues boucles d'agent, passez `savings: { elision: false }` dans la requête et comparez.

## Prouvez chaque économie avec les chiffres d'OpenAI

Une économie que vous ne pouvez pas vérifier n'est qu'une projection. Pour chaque levier :

1. **Choisissez le compteur qu'il doit faire bouger.** Le cache et la déduplication font bouger le nombre de requêtes. Le prompt caching fait bouger `cached_tokens` et, sur GPT-5.6 et les modèles suivants, `cache_write_tokens` aussi. Batch fait bouger le prix. Le choix du modèle fait bouger le prix par token. La maîtrise de la sortie fait bouger `completion_tokens`.
2. **Lisez ce compteur chez OpenAI.** L'[API Usage](https://developers.openai.com/api/reference/resources/organization/subresources/usage) renvoie les requêtes et les tokens d'entrée, d'entrée en cache et de sortie par jour, modèle, projet et clé. L'endpoint Costs et le tableau de bord d'usage donnent les montants.
3. **Comparez ce qui est comparable.** Même fonctionnalité, mêmes jours de la semaine, avant et après, ou mieux : deux bras du même trafic au même moment. Regardez d'abord les tokens, ensuite les dollars : les dollars bougent aussi avec les prix.

Avec la couche, chaque rapport porte `cost.basis` : les montants `measured` et `reference` viennent du compteur d'OpenAI lui-même, les montants `estimated` sont présentés à part et jamais mélangés aux autres. La méthode complète : [vérifier les économies LLM sur la facture de votre fournisseur](/fr/guides/verify-llm-savings-against-provider-bill).

## Ce que disent les chiffres publiés

La [page du banc public](/fr/benchmarks) du projet mesure les deux bras de chaque test avec le compteur d'usage du fournisseur lui-même. Sur une charge publique construite à partir de questions GSM8K, où 30 % des requêtes étaient des répétitions exactes, la réduction agrégée sur `gpt-4o-mini` a été de **31.50 %**, avec un intervalle à 95 % de 25.7 % à 36.7 % (artefacts du SDK 0.4.31, septembre 2026 ; également dans le README). Sur du chat en deux tours sans répétition (MT-Bench), les différences étaient impossibles à distinguer de zéro ou non attribuables à la couche, et la page le dit. La méthode, les intervalles et toutes les limites sont dans [l'article de recherche](/fr/paper). Le code est sur [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
