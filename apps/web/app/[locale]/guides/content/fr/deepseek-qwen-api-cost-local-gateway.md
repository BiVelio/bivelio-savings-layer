DeepSeek et Qwen sont bon marché au token, ce qui incite vite à ne plus surveiller la facture. Les deux fournisseurs mettent les prompts en cache de leur côté, et l'entrée qui tombe dans le cache est facturée bien en dessous de celle qui le rate. Le coût réel de votre trafic dépend donc d'un chiffre que la plupart des tableaux de bord masquent : combien de tokens d'entrée tombent dans le cache à chaque requête. Ce guide explique comment les deux fournisseurs facturent et mettent en cache, comment valoriser une requête à partir de ses champs d'usage, et comment voir tout cela requête par requête avec un gateway local gratuit.

## Comment DeepSeek facture une requête

DeepSeek coupe l'entrée de chaque requête en deux : les tokens qui tombent dans son cache de contexte et ceux qui le ratent, chacun avec son propre prix, plus les tokens de sortie. Son [context caching](https://api-docs.deepseek.com/guides/kv_cache) est activé par défaut sur tous les comptes. Un hit exige que le début de la requête corresponde exactement à celui d'une requête antérieure ; le cache fonctionne au mieux, et les entrées inutilisées sont effacées au bout de quelques heures ou de quelques jours. La réponse vous dit ce qui s'est passé :

- `usage.prompt_cache_hit_tokens` : les tokens d'entrée servis depuis le cache.
- `usage.prompt_cache_miss_tokens` : les tokens d'entrée traités entièrement.
- `usage.prompt_tokens_details.cached_tokens` : le même nombre de hits, dans le champ que lisent les outils compatibles OpenAI.

La [page de tarifs](https://api-docs.deepseek.com/quick_start/pricing) de DeepSeek indique, pour chaque modèle, les prix des hits, des miss et de la sortie, ainsi qu'une plage d'heures creuses à prix réduit. Les prix changent ; notez-les avec la date à laquelle vous les avez lus.

## Comment Qwen facture une requête

Les modèles Qwen sur Alibaba Cloud Model Studio ont deux types de [cache de contexte](https://www.alibabacloud.com/help/en/model-studio/context-cache). Le cache implicite est automatique pour les prompts qui dépassent une longueur minimale, et ses hits sont facturés avec une remise. Le cache explicite fonctionne comme celui d'Anthropic : vous marquez un bloc avec `cache_control`, l'entrée vit quelques minutes, et l'écrire coûte un peu plus que l'entrée ordinaire tandis que la lire coûte beaucoup moins. Dans l'API compatible OpenAI, le nombre de hits arrive dans `usage.prompt_tokens_details.cached_tokens`. Model Studio a des endpoints régionaux : vérifiez celui auquel votre clé est rattachée.

## Faire fonctionner le cache, chez l'un comme chez l'autre

Les règles sont les mêmes que pour tout cache de préfixe :

1. Mettez en premier ce qui ne change jamais : le prompt système, les définitions d'outils, les longs textes de référence, les exemples few-shot.
2. Gardez-le identique à l'octet près d'une requête à l'autre : pas d'horodatage, d'identifiant de requête ni de nom d'utilisateur à l'intérieur, et des définitions d'outils dans un ordre fixe.
3. Mettez en dernier ce qui change : la question de l'utilisateur, le dernier résultat d'outil.
4. Pour les agents, ajoutez à l'historique au lieu de le réécrire. Modifier un ancien message au milieu invalide tout ce qui suit.

## Calculez le coût d'une requête

Vous n'avez besoin d'aucun outil pour valoriser une requête. Lisez le bloc d'usage et multipliez chaque poste par son prix :

```python
def request_cost(usage: dict, price_miss: float, price_hit: float, price_out: float) -> float:
    """USD cost of one chat completion. Prices are per million tokens, from the provider's pricing page."""
    details = usage.get("prompt_tokens_details") or {}
    hit = usage.get("prompt_cache_hit_tokens", details.get("cached_tokens", 0)) or 0
    miss = usage["prompt_tokens"] - hit
    return (miss * price_miss + hit * price_hit + usage["completion_tokens"] * price_out) / 1_000_000
```

Enregistrez ce chiffre avec le modèle, la part de hits (`hit / prompt_tokens`) et un horodatage pour chaque requête, et vous pourrez répondre aux questions qui comptent : quelle fonctionnalité coûte le plus, si le taux de succès du cache a chuté après un déploiement, et quelle part de votre trafic tombe dans les heures creuses.

## Voyez chaque requête avec un gateway local

Pour ne pas avoir à toucher chaque point d'appel, placez un gateway devant le fournisseur. [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) en fournit un dans son paquet npm : Apache-2.0, local, **sans clé et sans inscription**, et rien n'est envoyé à BiVelio. Lancez un gateway par fournisseur, chacun sur son propre port :

```bash
# DeepSeek
npx @bivelio/savings-layer gateway --upstream deepseek --port 8403

# Qwen on Model Studio's international endpoint (`--upstream qwen` is the Beijing one)
npx @bivelio/savings-layer gateway --upstream https://dashscope-intl.aliyuncs.com --port 8404
```

Le gateway transmet au fournisseur le chemin qu'envoie votre client : votre base URL est donc celle du fournisseur, avec le gateway comme hôte.

| Fournisseur | `--upstream` | Base URL pour votre client OpenAI |
| --- | --- | --- |
| DeepSeek | `deepseek` | `http://127.0.0.1:8403` |
| Qwen (Pékin) | `qwen` | `http://127.0.0.1:<port>/compatible-mode/v1` |
| Qwen (international) | `https://dashscope-intl.aliyuncs.com` | `http://127.0.0.1:8404/compatible-mode/v1` |
| GLM | `glm` | `http://127.0.0.1:<port>/api/paas/v4` |

`npx @bivelio/savings-layer --help` liste les autres upstreams (Moonshot, MiniMax, OpenRouter, Gemini, Ollama, vLLM, LM Studio).

En Python, le petit client du paquet s'occupe de la base URL pour vous : construisez votre client OpenAI habituel pour le fournisseur, et `wrap()` en renvoie une copie qui passe par le gateway, en conservant le chemin du fournisseur.

```python
# pip install bivelio-savings-layer openai
import os

import bvsala
from openai import OpenAI

gw = bvsala.Gateway("http://127.0.0.1:8403")  # the DeepSeek gateway started above
deepseek = gw.wrap(OpenAI(base_url="https://api.deepseek.com", api_key=os.environ["DEEPSEEK_API_KEY"]))

resp = deepseek.chat.completions.create(
    model="deepseek-flash",
    messages=[
        {"role": "system", "content": "You review Python diffs for an invented team. House rules: ..."},
        {"role": "user", "content": "Review this diff: ..."},
    ],
)
report = gw.report(resp)
print(report.summary())  # model · basis · cost (in, cached, out)
print(report.tokens.provider_cached_input, report.cost.actual)
```

La même chose fonctionne pour Qwen avec l'autre gateway et `OpenAI(base_url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1", ...)`. Si une variable de proxy HTTP est définie, ajoutez `NO_PROXY=127.0.0.1,localhost` avant de créer le client, sinon les requêtes vers le gateway local, clé du fournisseur comprise, traversent le proxy ; la version 1.2.5 avertit quand ce serait le cas. Si aucun gateway ne tourne, `wrap()` lève `GatewayUnavailable` au lieu d'appeler directement le fournisseur, et indique comment en lancer un, sans clé.

Tout autre langage ou outil fonctionne aussi : pointez sa base URL OpenAI vers le gateway, et chaque requête devient une ligne dans le log du gateway, avec le modèle, le coût au prix catalogue et l'entrée répartie entre tokens plein tarif et lectures de cache (`cache↓`).

Une exception compte pour les outils de chat et les agents : une requête **en streaming** qui ne demande pas l'usage (`stream_options: {"include_usage": true}`) n'en reçoit aucun du fournisseur, si bien que la version 1.2.5 l'enregistre comme `not metered: the request did not ask for usage`. Demandez l'usage dans votre client, ou lancez le gateway avec `BVSALA_GATEWAY_USAGE_INJECT=1`, qui ajoute cette option aux streams qui ne l'ont pas. Le dernier chunk de ces streams a alors une liste `choices` vide, ce à quoi ne s'attend pas un code qui lit `choices[0]` sans vérification.

## Agents de code sur DeepSeek ou Qwen

DeepSeek publie aussi un endpoint au format Anthropic et documente son utilisation avec Claude Code. Avec `--upstream deepseek`, le gateway envoie de lui-même les requêtes au format Anthropic vers cet endpoint :

```bash
npx @bivelio/savings-layer gateway --upstream deepseek --port 8402
ANTHROPIC_BASE_URL=http://127.0.0.1:8402 ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY" ANTHROPIC_MODEL=deepseek-flash claude
```

Sur cette route, le gateway mesure mais n'économise rien : l'endpoint au format Anthropic de DeepSeek ignore `cache_control` et ne déclare aucune écriture en cache ([son guide](https://api-docs.deepseek.com/guides/anthropic_api)), donc le levier par défaut n'a rien à abaisser. Faire tourner un modèle autre que Claude derrière Claude Code relève de l'intégration proposée par DeepSeek, pas d'une configuration prise en charge par Anthropic, et c'est à vous de juger la qualité du modèle pour votre travail.

**Qwen Code sur des modèles Qwen** demande une autre route : dans la version 1.2.5, `npx @bivelio/savings-layer qwen` lance Qwen Code avec son type d'authentification Anthropic et transmet à l'API d'Anthropic ; elle ne mesure donc que les modèles Claude utilisés avec une clé Anthropic, et elle refuse une base URL DashScope au format Anthropic. Pour les modèles Qwen, utilisez le mode compatible OpenAI de Qwen Code, que [sa documentation](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/) configure avec `OPENAI_API_KEY`, `OPENAI_BASE_URL` et `OPENAI_MODEL`, et pointez cette base URL vers un gateway. Donnez à `DASHSCOPE_PROXY_BASE_URL` exactement la même URL :

```bash
npx @bivelio/savings-layer gateway --upstream https://dashscope-intl.aliyuncs.com --port 8404

GW=http://127.0.0.1:8404/compatible-mode/v1
OPENAI_BASE_URL="$GW" DASHSCOPE_PROXY_BASE_URL="$GW" OPENAI_API_KEY="$DASHSCOPE_API_KEY" OPENAI_MODEL=qwen-plus qwen
```

La seconde variable compte pour la facture. Qwen Code décide d'après l'hôte de la base URL s'il parle à DashScope, et `127.0.0.1` n'est pas un hôte DashScope. Sans la variable, il se rabat sur son fournisseur OpenAI générique, qui n'envoie aucun marqueur de cache explicite (`cache_control` et l'en-tête `X-DashScope-CacheControl`). Vos requêtes retombent alors sur le cache implicite de Model Studio, où les hits coûtent généralement 20 % du prix d'entrée et sont assurés au mieux, au lieu des 10 % du cache explicite ([cache de contexte](https://www.alibabacloud.com/help/en/model-studio/context-cache)). Qwen Code traite comme DashScope une base URL qui correspond exactement à `DASHSCOPE_PROXY_BASE_URL`, et conserve alors les marqueurs ([son fournisseur DashScope](https://github.com/QwenLM/qwen-code/blob/8fab857da5/packages/core/src/core/openaiContentGenerator/provider/dashscope.ts), consulté le 23 novembre 2026).

Nous avons vérifié le côté gateway de cette route avec la version 1.2.5 (les deux marqueurs passent sans modification), pas Qwen Code lui-même : lisez donc le log du gateway, qui doit montrer une ligne avec un coût par requête. Une ligne `not metered` dit pourquoi : en général un stream qui ne demande pas l'usage (relancez le gateway avec `BVSALA_GATEWAY_USAGE_INJECT=1`), ou un modèle sans entrée dans le catalogue 1.2.5, qui contient `qwen-plus`, `qwen-flash`, `qwen3.7-flash`, `qwen3.8-flash` et `qwen3.8-max`, mais pas, par exemple, `qwen3-coder-plus`.

Deux écarts de tarification de la 1.2.5 dépendent de la seconde variable. **Avec `DASHSCOPE_PROXY_BASE_URL` définie**, comme ci-dessus, Model Studio facture chaque écriture dans le cache explicite à 125 % du prix d'entrée et la déclare dans `usage.prompt_tokens_details.cache_creation_input_tokens`. Le gateway 1.2.5 ne lit pas ce champ : il enregistre ces tokens comme de l'entrée ordinaire, avec `cache↑0`, à 80 % de ce qu'ils coûtent. Son prix de hit pour `qwen-plus` est celui du cache explicite, 10 %, ce qui correspond. **Sans la variable**, il n'y a pas d'écritures explicites, mais les hits sont implicites, facturés environ 20 %, et le gateway les enregistre aux mêmes 10 %, soit environ la moitié de leur coût.

## Ce que le gateway mesure, et ce qu'il ne mesure pas

- **Le montant en dollars vient d'un catalogue, pas des prix horaires de DeepSeek.** La version 1.2.5 a des entrées pour `deepseek-flash` et `deepseek-v4-pro`. Pour les miss et la sortie, elles utilisent le prix de DeepSeek en heures pleines : en heures creuses, ces postes affichent donc le double de ce que facture DeepSeek. Pour les hits, les deux entrées utilisent 0,003 $US par million de tokens, soit le prix de hit de DeepSeek en heures creuses pour `deepseek-flash` (son prix de hit en heures pleines est le double), et moins que les deux prix de hit que DeepSeek publie pour `deepseek-v4-pro` ([page de tarifs](https://api-docs.deepseek.com/quick_start/pricing), consultée le 23 novembre 2026). Selon l'heure et la part de votre entrée qui tombe dans le cache, le total du gateway peut être supérieur ou inférieur à la facture. Les nombres de tokens sont exacts ; comparez-les en premier. L'alias historique `deepseek-chat` n'a pas d'entrée : il est transmis, et le log indique qu'il n'a pas été mesuré.
- **Il ne modifie pas ces requêtes.** Sur le trafic compatible OpenAI, le gateway mesure et transmet (la seule exception est l'injection d'usage optionnelle vue plus haut) ; ses leviers d'économie concernent le trafic au format Anthropic. Sur DeepSeek et Qwen, l'économie vient de leurs propres caches, et c'est pourquoi le nombre de hits est le chiffre à surveiller.

## Si vous appelez DeepSeek ou Qwen depuis TypeScript

Le SDK BV-SALA dialogue avec n'importe quel endpoint compatible OpenAI et évite les répétitions exactes et les requêtes identiques en vol, gratuitement et sans clé ([comment ça marche](/fr/guides/deduplicate-llm-requests)). Sur DeepSeek, ces appels évités sont déclarés `estimated`, pas `reference` : la version 1.2.5 ne valorise une répétition par référence que si l'appel exécuté est allé à l'API propre d'OpenAI, d'Anthropic ou de Google. Une mise en garde pour les boucles d'agent : son élagage par défaut des résultats d'outils devenus obsolètes réécrit le milieu de l'historique, et chez un fournisseur qui met de lui-même tout le prompt en cache, cela peut coûter plus que cela ne rapporte. Le changelog du projet rapporte +166 % sur une boucle d'agent de 60 étapes sur DeepSeek, mesuré contre un faux fournisseur avec les versions 1.2.3 et 1.2.4, sans clé ; la 1.2.5 élague de la même façon. Pour les boucles d'agent, désactivez-le requête par requête :

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({ baseUrl: "https://api.deepseek.com/v1", apiKey: process.env.DEEPSEEK_API_KEY }),
});

const { text, report } = await layer.generate({
  model: "deepseek-flash",
  messages: [{ role: "user", content: "Explain what a race condition is in two sentences." }],
  savings: { elision: false }, // keep the history byte-identical for DeepSeek's own cache
});
console.log(text, report.tokens.providerCachedInput, report.cost.basis);
```

## Rapprochez les chiffres de ceux de votre fournisseur

Une fois par jour, comparez les totaux du gateway par modèle (entrée, hits de cache, sortie) avec la page d'usage de la plateforme DeepSeek ou de Model Studio pour la même clé. Les totaux de tokens doivent concorder, avec une exception dans leur répartition : sur Qwen, la version 1.2.5 compte les écritures dans le cache explicite comme de l'entrée ordinaire, pas comme des écritures en cache. Les montants en dollars peuvent différer, dans un sens comme dans l'autre : le catalogue ignore les prix horaires de DeepSeek, sur Qwen il valorise les écritures dans le cache explicite comme de l'entrée ordinaire et les hits implicites au tarif du cache explicite, et les prix régionaux et les remises changent aussi les montants. Pour une méthode pas à pas, voyez [comment vérifier les économies LLM sur la facture de votre fournisseur](/fr/guides/verify-llm-savings-against-provider-bill). Le code du gateway et ses guides par terminal sont sur [GitHub](https://github.com/BiVelio/bivelio-savings-layer), et ce que le projet a mesuré, comme ce qu'il n'a pas mesuré, est sur la [page du banc public](/fr/benchmarks).
