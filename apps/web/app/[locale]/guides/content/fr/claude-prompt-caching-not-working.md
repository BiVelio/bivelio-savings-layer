Vous avez ajouté `cache_control` à vos requêtes Claude, et la facture n'a pas bougé. Ou bien `cache_read_input_tokens` revient à `0` à chaque appel. Ce guide explique pourquoi, comment trouver l'octet exact qui casse votre cache et comment vérifier le résultat avec les chiffres d'usage d'Anthropic eux-mêmes. Tout ce qui suit fonctionne avec n'importe quel SDK. À la fin, vous verrez comment le SDK open source BV-SALA place les points d'arrêt pour vous, et le seul cas où il faut lui dire de ne pas le faire.

## Lisez d'abord les trois champs d'usage

Chaque réponse de l'API Messages vous dit ce qui est arrivé au cache. Regardez trois nombres dans `usage` :

| Champ | Ce qu'il compte |
| --- | --- |
| `cache_creation_input_tokens` | Tokens écrits dans le cache lors de cet appel, facturés au-dessus du prix d'entrée normal |
| `cache_read_input_tokens` | Tokens servis depuis le cache, facturés à une fraction du prix d'entrée |
| `input_tokens` | Tokens situés après le dernier point d'arrêt, facturés au prix normal |

Les trois profils vous disent où chercher :

- **Les deux champs de cache sont à 0.** Rien n'a été mis en cache : le préfixe est plus court que le minimum du modèle, il n'y a pas de point d'arrêt, ou quelque chose entre vous et l'API l'a supprimé.
- **La création est élevée à chaque appel et les lectures restent à 0.** Le cache est écrit mais jamais réutilisé : le préfixe change d'un appel à l'autre, l'entrée a expiré, ou les appels partent vers un autre modèle ou un autre workspace.
- **Les lectures sont élevées.** Ça fonctionne. La seule question est alors de savoir quelle part du prompt se trouve avant le point d'arrêt.

## Le cache de prompts de Claude en six points

1. Il met en cache un **préfixe** : la requête depuis le début jusqu'à un point d'arrêt `cache_control`. La correspondance est exacte ; un seul octet différent, et tout ce qui suit est traité de nouveau.
2. L'ordre est **outils, puis système, puis messages**. Un changement dans la liste d'outils invalide le prompt système et les messages qui suivent.
3. Vous pouvez placer jusqu'à **quatre points d'arrêt**, et l'API remonte un nombre limité de blocs depuis chacun pour trouver une entrée antérieure (20 au moment où nous écrivons).
4. Les entrées vivent **cinq minutes** par défaut, durée renouvelée à chaque accès au cache. Une durée de vie d'une heure est disponible avec `"ttl": "1h"`.
5. Écrire coûte plus cher que lire : une écriture de cinq minutes est facturée 1,25 fois le prix d'entrée et une écriture d'une heure 2 fois ; une lecture coûte une petite fraction du prix d'entrée (0,1 fois sur la plupart des modèles). Consultez la [page de tarifs d'Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) pour votre modèle.
6. Il existe une **longueur minimale pour la mise en cache**, qui dépend du modèle, de 512 à 4 096 tokens. En dessous, la requête n'est tout simplement pas mise en cache, et aucune erreur ne le signale.

Tout cela figure dans la [documentation d'Anthropic sur le prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), la source qui fait foi quand un chiffre change.

## Les causes habituelles, dans l'ordre où les vérifier

1. **Le préfixe est trop court.** Un prompt système de 600 tokens est sous le minimum de plusieurs modèles. Regroupez les instructions stables, les exemples et le texte de référence pour que la partie en cache soit assez longue pour peser.
2. **Quelque chose dans le préfixe change à chaque appel.** Les grands classiques : un horodatage ou une ligne « Nous sommes le… » dans le prompt système, un identifiant de requête, le nom de l'utilisateur, un ordre d'exemples aléatoire, des définitions d'outils construites à partir d'un objet dont l'ordre des clés n'est pas fixe, ou un document JSON sérialisé avec un espacement différent.
3. **Le point d'arrêt porte sur du contenu qui change.** Si le dernier `cache_control` porte sur la question de l'utilisateur, chaque appel écrit une nouvelle entrée que personne ne lit. Le point d'arrêt se place à la fin de la partie qui ne change pas.
4. **L'entrée a expiré.** Des appels espacés de plus de cinq minutes ne lisent jamais l'entrée les uns des autres. Un batch nocturne qui traite un élément toutes les dix minutes paie le surcoût d'écriture à chaque fois et ne lit rien.
5. **Les appels ne partagent pas de cache.** Un autre modèle, un autre workspace ou un changement de modèle en cours de conversation repartent chacun d'un cache vide.
6. **Les appels parallèles se font la course.** Une entrée ne peut être lue qu'une fois que la première réponse a commencé. Dix appels identiques lancés en même temps écrivent tous. Envoyez-en un d'abord, puis les autres.
7. **Un proxy supprime le marqueur.** Un gateway qui retire `cache_control`, ou qui réduit à une simple chaîne un `system` sous forme de blocs, fait facturer tout le prompt comme entrée hors cache alors que chaque appel réussit. La documentation de Claude Code décrit exactement cette panne pour les [gateways LLM](https://code.claude.com/docs/en/prompt-caching).

## Trouvez l'octet qui casse votre cache

Quand les lectures restent à zéro, enregistrez deux corps de requête consécutifs et cherchez où ils diffèrent pour la première fois, dans l'ordre où le cache les lit :

```ts
type Body = { tools?: unknown[]; system?: unknown; messages: unknown[] };

// The cache reads tools, then system, then messages. Compare in that order.
const inCacheOrder = (b: Body) => JSON.stringify([b.tools ?? [], b.system ?? "", b.messages]);

export function firstDifference(a: Body, b: Body): string | null {
  const x = inCacheOrder(a);
  const y = inCacheOrder(b);
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  if (i === x.length && i === y.length) return null;
  return `differs at character ${i}:\n  ${x.slice(Math.max(0, i - 40), i + 40)}\n  ${y.slice(Math.max(0, i - 40), i + 40)}`;
}
```

Si la première différence se trouve dans le prompt système ou dans la liste d'outils, vous tenez la cause de votre défaut de cache. Déplacez cette partie à la fin de la requête, en général dans le message utilisateur.

Suivez ensuite le taux de succès du cache à chaque appel, pour qu'une régression se voie le jour même de sa mise en production :

```ts
interface ClaudeUsage {
  input_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Share of the input tokens that were read from the cache on this call. */
export function cacheHitRate(u: ClaudeUsage): number {
  const read = u.cache_read_input_tokens ?? 0;
  const written = u.cache_creation_input_tokens ?? 0;
  const total = read + written + u.input_tokens;
  return total === 0 ? 0 : read / total;
}
```

## La mise en cache est-elle rentable pour votre trafic ?

Comme les écritures coûtent plus cher que l'entrée ordinaire, mettre en cache revient à parier que le préfixe sera relu avant d'expirer. Avec la durée de vie de cinq minutes, une seule lecture rembourse déjà l'écriture. Un préfixe écrit et jamais lu coûte environ 25 % de plus que si vous l'envoyiez sans marqueur. Voilà pourquoi « mettre `cache_control` partout » n'est pas un réglage par défaut sûr : c'est rentable sur le trafic de chat et d'agent qui revient dans les minutes qui suivent, et perdant sur les requêtes ponctuelles ou sur les prompts qui changent à chaque fois.

## Comment BV-SALA s'en charge

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) est une couche d'économies sous licence Apache-2.0. Avec `AnthropicProvider`, elle place les points d'arrêt pour vous, gratuitement et sans clé : un à la fin du prompt système et un à la fin de la partie de la conversation qui ne change pas, jamais plus que ce que l'API autorise. Le rapport de chaque appel montre ce qu'a fait le cache, d'après les compteurs d'Anthropic eux-mêmes :

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, AnthropicProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
});

// Long and stable: no dates, no user names, no request ids in here.
const SYSTEM = "You are the support assistant for Acme Outdoor, an invented shop. Our return policy: …";

const { text, report } = await layer.generate({
  model: "anthropic/claude-haiku-4-5",
  messages: [
    { role: "system", content: SYSTEM },
    { role: "user", content: "Can I return hiking boots after 20 days?" },
  ],
});
console.log(text);
console.log(report.nativeSavings?.cacheReadTokens, report.nativeSavings?.cacheWriteTokens);
console.log(report.nativeSavings?.netUsd); // read discount minus write premium; negative on a cold write
```

`report.nativeSavings` est la remise d'Anthropic, présentée à part : la couche ne la compte jamais comme sa propre économie, si bien que votre rapport tombe juste avec la facture.

**Le cas où il faut désactiver le marquage.** Sans clé, si votre prompt système change à chaque requête (un horodatage, un id utilisateur), ou si vos appels sont espacés de plus de cinq minutes dans des processus neufs, le marquage par défaut écrit une entrée de cache que personne ne lit, et le README indique que cela coûte environ 20 % de plus que sans la couche. Déplacez ce qui change dans le message utilisateur, ou désactivez le marquage :

```ts
import { createSavingsLayer, AnthropicProvider } from "@bivelio/savings-layer";

// A system prompt that changes every time: no cache marks, no write premium.
export const noMarks = createSavingsLayer({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, maxCacheBreakpoints: 0 }),
});

// Or keep the marks and, per request, let the layer move timestamp and UUID
// lines to the end of the system prompt, outside the cached part (opt-in: the
// model reads the same lines in a different order).
const layer = createSavingsLayer({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
});
export const reply = await layer.generate({
  model: "anthropic/claude-haiku-4-5",
  messages: [
    { role: "system", content: `Today is ${new Date().toISOString()}\nYou are the support assistant for Acme Outdoor, an invented shop. …` },
    { role: "user", content: "Can I return hiking boots after 20 days?" },
  ],
  savings: { cachePrefix: true },
});
```

Cette réorganisation optionnelle est le levier derrière un test exploratoire en conditions réelles publié dans le README : sur `claude-haiku-4-5`, dans une séquence construite où un horodatage empoisonnait le cache, elle a fait passer le taux de succès de 0 % à 95 % et baisser le coût par requête de 82,76 %, par rapport à la couche elle-même sans l'option, avec 20 requêtes par bras, mesuré avec la version 1.2.0 le 15 novembre 2026. C'est un petit test construit, pas une prévision pour votre trafic.

## Vérifiez avec les chiffres d'Anthropic

1. **Par appel.** Enregistrez `usage` pour chaque réponse (ou `report.nativeSavings` si vous utilisez la couche) et calculez le taux de succès ci-dessus. Une charge de chat ou d'agent en bonne santé montre, après le premier appel, des lectures bien supérieures aux écritures.
2. **Par jour.** Dans la Claude Console, la page d'usage ventile l'entrée en écritures et en lectures de cache par modèle et par clé d'API. Additionnez les `cache_read_input_tokens` et `cache_creation_input_tokens` que vous avez enregistrés pour la même clé et le même jour UTC : les totaux doivent concorder. Pour une vérification automatisée, l'[API Admin Usage and Cost](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) renvoie les mêmes compteurs.
3. **En argent.** Valorisez séparément les lectures, les écritures et l'entrée ordinaire. Un rapport qui ne montre que les « tokens économisés » et pas le surcoût d'écriture passe sous silence la moitié du compromis.

Le [banc public](/fr/benchmarks) du dépôt mesure les deux bras de chaque test avec le compteur d'usage du fournisseur lui-même. Pour la méthode générale, voyez [comment vérifier les économies LLM sur votre facture](/fr/guides/verify-llm-savings-against-provider-bill). Pour le versant OpenAI du même problème, voyez [pourquoi cached_tokens vaut 0 chez OpenAI](/fr/guides/openai-prompt-caching-cached-tokens). Le code est sur [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
