Toutes les API de LLM facturent à l'appel. Si votre app envoie deux fois la même requête, vous payez deux fois, alors que la seconde réponse n'apporte rien. Ce guide présente deux techniques qui l'évitent : un **cache de réponses à correspondance exacte** pour les répétitions qui arrivent plus tard, et la **fusion des requêtes en vol** pour les requêtes identiques qui arrivent au même moment. Les deux fonctionnent dans n'importe quel langage et avec n'importe quel fournisseur. À la fin, vous verrez comment le SDK open source BV-SALA fait les deux par défaut, et comment vérifier l'économie avec les chiffres d'usage de votre fournisseur lui-même.

## D'où viennent les requêtes en double

Les doublons sont plus fréquents qu'il n'y paraît, parce qu'ils viennent rarement d'un seul endroit évident :

- **Nouvelles tentatives et doubles clics.** Un utilisateur appuie deux fois sur « Générer », ou une bibliothèque cliente réessaie après un timeout alors que le fournisseur avait bel et bien répondu.
- **Jobs batch et crons.** Une tâche nocturne classe les mêmes descriptions de produits, entrées de FAQ ou macros de support qu'elle a déjà classées la veille.
- **Fan-out.** Deux workers, deux onglets de navigateur ou un effet React qui s'exécute deux fois en développement envoient le même prompt à quelques millisecondes d'intervalle.
- **Agents et pipelines.** Un pipeline en plusieurs étapes pose la même sous-question dans plusieurs branches.
- **Tests et évaluations.** La CI rejoue les mêmes fixtures contre l'API réelle à chaque push.

Le premier et le dernier groupe sont des répétitions dans le temps ; le fan-out relève de la concurrence. Ils demandent des correctifs différents, et c'est pourquoi ce guide couvre les deux.

## Mesurez d'abord votre taux de doublons

Avant de construire quoi que ce soit, découvrez quelle part de votre trafic se répète. Hachez chaque corps de requête pendant une journée et comptez. La clé doit être **canonique** : une même requête doit donner les mêmes octets, quel que soit l'ordre des clés JSON.

```ts
import { createHash } from "node:crypto";

// Canonical JSON: the same object gives the same text, whatever the key order.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function requestKey(body: object, scope = "global"): string {
  return createHash("sha256").update(`${scope}\n${canonical(body)}`).digest("hex");
}

// Feed it one day of request bodies, then read the share that repeated.
const seen = new Map<string, number>();
export function record(body: object): void {
  const key = requestKey(body);
  seen.set(key, (seen.get(key) ?? 0) + 1);
}
export function duplicateRate(): number {
  let total = 0;
  for (const n of seen.values()) total += n;
  return total === 0 ? 0 : (total - seen.size) / total;
}
```

Si le taux est proche de zéro, un cache de réponses ne vous fera pas économiser grand-chose, et mieux vaut regarder du côté du [prompt caching](/fr/guides/claude-prompt-caching-not-working) ou du [choix du modèle](/fr/guides/reduce-openai-api-costs). Si une part notable de vos requêtes se répète, lisez la suite.

## Construisez une clé de cache vraiment sûre

Un cache exact ne vaut que ce que vaut sa clé. La règle est simple : **tout ce qui peut changer la réponse entre dans la clé, et rien n'est normalisé au passage.**

- L'id du modèle, la liste complète des messages, le prompt système, les définitions d'outils, le format de réponse ou le schéma JSON, et chaque paramètre d'échantillonnage (`temperature`, `top_p`, `max_tokens`, `seed`, effort de raisonnement).
- Une **portée** quand le prompt contient des données utilisateur. Deux utilisateurs qui demandent « quel est mon solde ? » envoient le même texte et attendent des réponses différentes. Mettez l'id de l'utilisateur ou du tenant dans la clé, ou ne mettez pas du tout ces requêtes en cache.
- Pas de normalisation « astucieuse ». Passer en minuscules, supprimer les espaces ou retirer la ponctuation pour obtenir plus de hits transforme un cache exact en cache approximatif, et un cache approximatif peut renvoyer la réponse à une autre question.

## Ce qu'il ne faut jamais servir depuis un cache

Certaines requêtes se répètent mais doivent quand même atteindre le modèle à chaque fois :

- **Les réponses qui doivent changer** : « choisis un prénom au hasard », « génère un mot de passe », « quelle heure est-il », « le prix du jour ». Ici, une réponse en cache est un bug, pas une économie.
- **Les outils à effets de bord.** Si la réponse demande d'appeler `send_email` ou `create_order`, la rejouer fait sauter l'action. Ne mettez en cache que les requêtes dont les outils sont en lecture seule, ou qui n'en ont aucun.
- **Les sorties échantillonnées que les utilisateurs s'attendent à voir varier.** Avec une `temperature` élevée, une réponse en cache n'est qu'un échantillon, servi pour toujours.
- **Les erreurs, réponses vides, refus et réponses tronquées.** Ne les écrivez jamais dans le cache ; laissez la requête suivante retenter sa chance.
- **Les sujets sensibles.** Un bot de support ne devrait pas mettre en cache des réponses sur l'automutilation ou une urgence médicale ; envoyez ces requêtes au modèle à chaque fois.

## Fusionnez les requêtes identiques en vol

Un cache n'aide qu'une fois la première réponse arrivée. Si dix requêtes identiques partent dans les mêmes 300 ms, toutes les dix ratent le cache. La solution est un petit motif souvent appelé *singleflight* : le premier appelant fait l'appel, les autres attendent la même promesse.

```ts
const inFlight = new Map<string, Promise<unknown>>();

export function singleflight<T>(key: string, call: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key) as Promise<T> | undefined;
  if (running) return running; // join the call that is already on its way
  const p = call().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p; // an error reaches every caller that joined, so nobody waits forever
}
```

Trois détails comptent en production. Les erreurs doivent atteindre chaque appelant en attente (le motif ci-dessus le fait). L'annulation par un appelant ne doit pas annuler l'appel partagé pour les autres. Et le streaming est plus délicat : un stream déjà commencé ne peut pas simplement être confié à un second appelant, si bien que la plupart des implémentations laissent une requête simple rejoindre un appel en vol mais ne laissent rien rejoindre un stream.

## Comment BV-SALA s'y prend

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) est une couche d'économies sous licence Apache-2.0 pour TypeScript. Son SDK enveloppe votre fournisseur et, **sans clé et sans inscription**, active par défaut les deux techniques : un cache exact et la déduplication des requêtes en vol. Il applique aussi les règles « à ne jamais mettre en cache » vues plus haut : les requêtes dont la formulation demande de l'actualité ou du hasard, les formulations personnelles sans session, les sujets sensibles, les refus et les erreurs restent hors du cache.

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({
    baseUrl: "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY,
  }),
  // Nothing else is required: the exact cache and deduplication are on by default.
});

const request = {
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user" as const, content: "Classify the sentiment as positive or negative: The battery lasts two days." }],
  temperature: 0,
};

const first = await layer.generate(request);
const again = await layer.generate(request);
console.log(first.report.cache.result, again.report.cache.result); // "miss" "exact"
console.log(again.report.calls.avoidedLlm); // 1: the repeat never reached the provider

// Two identical requests at the same moment: one call, shared by both.
const other = { ...request, messages: [{ role: "user" as const, content: "Classify the sentiment as positive or negative: Shipping took a month." }] };
const [a, b] = await Promise.all([layer.generate(other), layer.generate(other)]);
console.log(a.report.cache.result, b.report.cache.result); // "miss" "singleflight"
```

Une requête qui semble personnelle (« ma commande », « notre facture ») n'est pas mise en cache tant que vous ne dites pas à qui elle appartient. Passez une portée et le cache fonctionne de nouveau, séparément pour chaque session :

```ts
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY }),
});

const answer = await layer.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "Translate to French: the invoice for my order is attached." }],
  context: { sessionId: "user-42" }, // cached for this session only
});
console.log(answer.report.cache.result);
```

Le cache par défaut vit dans la mémoire d'un seul processus. Pour le partager entre plusieurs serveurs ou instances serverless, passez par l'option `exactCache` un store que vous exploitez vous-même. Il ne lui faut que trois méthodes, donc n'importe quel store clé-valeur fait l'affaire :

```ts
import { createSavingsLayer, OpenAICompatibleProvider, type ExactCache } from "@bivelio/savings-layer";

// The three calls a Redis client offers; adapt the names to yours.
interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export function sharedLayer(redis: RedisLike) {
  const exactCache: ExactCache = {
    async get(key) {
      const raw = await redis.get(`bvsala:${key}`);
      return raw ? JSON.parse(raw) : null;
    },
    async set(key, value, ttlMs) {
      await redis.set(`bvsala:${key}`, JSON.stringify(value), "PX", ttlMs ?? 3_600_000);
    },
    async delete(key) {
      await redis.del(`bvsala:${key}`);
    },
  };
  return createSavingsLayer({
    provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY }),
    exactCache,
  });
}
```

Les réponses en cache restent dans votre infrastructure. Rien n'est envoyé à BiVelio quand vous fonctionnez sans clé.

## Vérifiez l'économie avec les chiffres de votre fournisseur

Une économie de cache est facile à vérifier, car c'est un nombre d'appels qui n'ont pas eu lieu.

1. **Comptez les appels des deux côtés.** Pendant une journée, comptez les appels `generate()` faits par votre app et comparez-les au nombre de requêtes que votre fournisseur affiche pour la même clé d'API et le même modèle (la page d'usage de la console OpenAI ou Anthropic, ou leurs API d'usage). La différence doit être égale à la somme des `report.calls.avoidedLlm`.
2. **Regardez comment chaque répétition a été valorisée.** `report.cost.basis` dit d'où vient le chiffre. Une répétition est `reference` quand l'appel identique qui a été exécuté est allé directement à l'API d'OpenAI, d'Anthropic ou de Gemini de Google (`api.openai.com`, `api.anthropic.com` ou `generativelanguage.googleapis.com`) : sa base de comparaison est le compteur d'usage de cet appel lui-même, valorisé prudemment au tarif d'entrée en cache. Elle reste `estimated` quand l'appel exécuté est allé ailleurs, y compris vers l'API propre d'un autre fournisseur, comme celle de DeepSeek, vers un proxy, Azure ou un gateway, car ce n'est que sur ces trois API que les prix catalogue de la couche sont connus pour correspondre à la facture. L'argent estimé est toujours présenté à part.
3. **Comparez les dépenses, pas seulement les appels.** Additionnez `report.cost.netSavingsUsd` par base. N'additionnez jamais montants mesurés et montants estimés, et ne faites jamais la moyenne de `netSavingsRatio` entre requêtes.

Pour un test plus propre, exécutez deux fois la même charge, une fois avec les leviers désactivés pour ce passage (`savings: { exactCache: false, singleflight: false }` sur chaque requête) et une fois avec les réglages par défaut, puis comparez les deux factures.

## Ce que disent les chiffres publics

Le dépôt publie ses passages de benchmark. Sur une charge publique construite à partir de questions GSM8K, où 30 % des requêtes étaient des répétitions exactes, la réduction agrégée mesurée a été de **31,50 %** pour `gpt-4o-mini`, avec un intervalle à 95 % de 25,7 % à 36,7 % (artefacts du SDK 0.4.31 de septembre 2026 ; source : la [page du banc public](/fr/benchmarks#savings) et le README). Sur un trafic qui ne se répète jamais, l'économie est d'environ 0 %, et la [page du banc public](/fr/benchmarks#no-savings) montre aussi ces résultats nuls. Elle compte également l'échec qui importe le plus pour un cache : **0 sur 198** variantes de questions ont été servies avec la réponse d'une autre question ([garanties](/fr/benchmarks#guarantees)).

Votre économie dépend de votre taux de doublons : mesurez-le d'abord avec l'extrait en haut de cette page. Le code, l'article de recherche et les rapports bruts sont sur [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
