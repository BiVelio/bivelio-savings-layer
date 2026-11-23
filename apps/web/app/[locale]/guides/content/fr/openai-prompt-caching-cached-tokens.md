OpenAI met automatiquement en cache les prompts longs : quand le début d'une requête correspond à celui d'une requête traitée récemment, ces tokens d'entrée sont facturés avec une remise et la réponse commence plus tôt. Vous n'avez rien à activer. C'est aussi pour cela qu'on ne remarque pas facilement quand le cache cesse de fonctionner. Si `cached_tokens` revient à `0` à chaque requête, ce guide liste les causes dans l'ordre où les vérifier, montre comment suivre le taux de succès du cache à chaque requête et comment le confronter aux données d'usage d'OpenAI elles-mêmes.

## Où le lire

Chaque réponse vous dit combien de tokens d'entrée viennent du cache :

- **Chat Completions :** `usage.prompt_tokens_details.cached_tokens`, sur un total de `usage.prompt_tokens`.
- **Responses API :** `usage.input_tokens_details.cached_tokens`, sur un total de `usage.input_tokens`.

Les tokens en cache font partie du total d'entrée, ils ne s'y ajoutent pas. Le [guide du prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) d'OpenAI fait référence pour les règles en vigueur. Il distingue désormais les modèles récents, qui déclarent et facturent aussi les écritures en cache et acceptent des options de cache explicites, des modèles plus anciens, pour lesquels écrire dans le cache est gratuit. Vérifiez ce qu'il dit pour le modèle que vous utilisez.

## Pourquoi cached_tokens vaut 0

1. **Le prompt est trop court.** La mise en cache démarre à environ 1,024 tokens de prompt ; le seuil exact et l'arrondi du nombre de tokens en cache dépendent du modèle. Un prompt système de 600 tokens suivi d'une question courte n'atteint jamais le cache, et rien ne vous le signale.
2. **Le début du prompt change.** Le cache compare à partir du tout premier token. Un horodatage, un identifiant de requête ou le nom de l'utilisateur dans le premier message rend chaque requête unique dès le premier token. Les outils, les images et les formats de réponse font aussi partie du préfixe : des outils listés dans un autre ordre, ou un schéma sérialisé différemment, cassent la correspondance.
3. **L'entrée a été évincée du cache.** Les entrées sont conservées peu de temps après leur dernière utilisation, généralement quelques minutes quand le trafic est calme. Des requêtes espacées d'une heure tombent rarement dans le cache.
4. **Le trafic est dispersé.** Les requêtes sont routées selon un hash du début du prompt. Un très gros volume avec le même préfixe déborde vers d'autres machines qui ne détiennent pas l'entrée. Le paramètre `prompt_cache_key` d'OpenAI regroupe les requêtes qui partagent un préfixe ; utilisez une clé par template de prompt, pas par utilisateur, et gardez un débit modéré pour chaque clé, comme l'explique le guide.
5. **Vous ne lisez pas le champ.** Une requête Chat Completions en streaming ne transporte aucun usage, sauf si vous le demandez avec `stream_options: { include_usage: true }`. Beaucoup de wrappers suppriment `prompt_tokens_details`. Certains fournisseurs compatibles OpenAI et certains déploiements Azure déclarent la mise en cache différemment, voire pas du tout.

## Testez-le en deux minutes

Avant de déboguer votre application, vérifiez que la mise en cache fonctionne tout court pour votre compte et votre modèle. Envoyez deux fois le même prompt long, à quelques secondes d'intervalle, et lisez l'usage de chaque réponse :

```bash
# A system prompt well above the threshold, sent twice. The second answer should report cached tokens.
BODY=$(python3 -c 'import json; print(json.dumps({"model": "gpt-4o-mini", "messages": [{"role": "system", "content": "You are a careful assistant for an invented shop. " * 200}, {"role": "user", "content": "Say OK."}]}))')
for i in 1 2; do
  curl -s https://api.openai.com/v1/chat/completions \
    -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" \
    -d "$BODY" | python3 -c 'import json, sys; u = json.load(sys.stdin)["usage"]; print(u["prompt_tokens"], u.get("prompt_tokens_details"))'
done
```

Si la seconde ligne affiche des tokens en cache, le côté fournisseur fonctionne et le problème vient de la façon dont votre application construit ses prompts : lisez la suite. Si elle n'en affiche aucun, réessayez quelques fois (la mise en cache est assurée au mieux, et la première requête peut atterrir sur une autre machine), puis consultez la fiche du modèle dans le guide de mise en cache d'OpenAI. Remplacez le modèle par celui que vous utilisez en production ; un test sur un autre modèle ne prouve pas grand-chose.

Ce test vous donne aussi une référence pour les sections suivantes. Une fois que vous avez changé l'ordre de votre prompt ou ajouté une `prompt_cache_key`, refaites la même comparaison sur un vrai template de votre application et gardez les chiffres. Un taux de succès mesuré avant et après le changement, sur un template que vos utilisateurs sollicitent vraiment, est un résultat que vous pouvez montrer ; « le cache devrait aider » n'en est pas un.

## Mettez à la fin ce qui change

Dans la plupart des cas, la solution tient à l'ordre. Tout ce qui est identique pour chaque requête va en premier et reste identique à l'octet près ; tout ce qui change va à la fin.

```ts
type Message = { role: "system" | "user"; content: string };

const INSTRUCTIONS = "You answer questions about an invented product, Acme Notes. Rules: …"; // long, never changes
const EXAMPLES = "Example question: … Example answer: …"; // long, never changes

export function buildMessages(question: string, userName: string): Message[] {
  return [
    { role: "system", content: INSTRUCTIONS }, // cached
    { role: "system", content: EXAMPLES }, // cached
    // Everything that changes goes in the last message, after the cached part.
    { role: "user", content: `Date: ${new Date().toISOString().slice(0, 10)}. User: ${userName}.\n${question}` },
  ];
}
```

Suivez ensuite la part de chaque prompt qui a été servie depuis le cache, pour qu'une régression se voie le jour même de sa mise en production :

```ts
interface OpenAIUsage {
  prompt_tokens?: number; // Chat Completions
  prompt_tokens_details?: { cached_tokens?: number };
  input_tokens?: number; // Responses API
  input_tokens_details?: { cached_tokens?: number };
}

/** Share of this request's input tokens that OpenAI served from its cache. */
export function cachedShare(u: OpenAIUsage): number {
  const total = u.prompt_tokens ?? u.input_tokens ?? 0;
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? 0;
  return total === 0 ? 0 : cached / total;
}
```

Regroupez-la par template de prompt. Un template dont la part reste à 0 % alors que ses prompts dépassent 1,024 tokens a quelque chose qui change près du début : enregistrez deux requêtes et comparez-les caractère par caractère, comme le montre [la version Claude de ce guide](/fr/guides/claude-prompt-caching-not-working#trouvez-loctet-qui-casse-votre-cache).

## Comment BV-SALA aide

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) est une couche d'économies sous licence Apache-2.0 pour TypeScript, qui enveloppe n'importe quel endpoint compatible OpenAI, gratuitement et sans clé. Le cache d'OpenAI est automatique : la couche ne marque donc rien chez OpenAI. Ce qu'elle fait pour la mise en cache :

- **Elle demande toujours l'usage sur les streams,** pour qu'une requête en streaming soit mesurée au lieu de perdre son compteur sans que personne ne le remarque.
- **Elle affiche la remise d'OpenAI à chaque appel,** dans `report.nativeSavings`, d'après le compteur d'OpenAI lui-même, et la garde à part de ses propres économies : la remise est celle d'OpenAI, pas celle de la couche.
- **Elle peut sortir les lignes volatiles du préfixe.** Avec `savings: { cachePrefix: true }`, à activer explicitement, les lignes du prompt système qui changent à chaque requête (horodatages ISO, UUID, temps epoch) passent à la fin, pour que la partie stable puisse être mise en cache. Le modèle lit les mêmes lignes dans un autre ordre : c'est pourquoi la décision vous revient et que l'option n'est jamais activée par défaut.

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY }),
});

const INSTRUCTIONS = "You write one-line summaries of release notes for an invented app. Style rules: …";

const stream = layer.generateStream({
  model: "openai/gpt-4o-mini",
  messages: [
    { role: "system", content: `Generated at ${new Date().toISOString()}\n${INSTRUCTIONS}` },
    { role: "user", content: "Summarize: fixed the export button; faster search; new dark theme." },
  ],
  savings: { cachePrefix: true }, // the timestamp line moves after the stable instructions
});
for await (const event of stream) {
  if (event.type === "text") process.stdout.write(event.delta);
}
const { report } = await stream.result;
console.log(report.tokens.providerCachedInput); // OpenAI's cached_tokens for this request
console.log(report.nativeSavings?.readDiscountUsd); // what those cached tokens saved at list price
```

Les leviers propres à la couche (éviter les répétitions exactes et les requêtes identiques en vol) sont distincts du cache d'OpenAI et sont expliqués dans [dédupliquer les requêtes LLM identiques](/fr/guides/deduplicate-llm-requests).

## Vérifiez avec les chiffres d'OpenAI

1. **Par requête :** enregistrez `cached_tokens` et le total d'entrée de chaque réponse, ou `report.tokens.providerCachedInput` avec la couche.
2. **Par jour :** l'[API Usage](https://developers.openai.com/api/reference/resources/organization/subresources/usage) d'OpenAI renvoie l'usage des completions par tranches quotidiennes qui incluent les tokens d'entrée en cache, par modèle et, si vous le demandez, par clé d'API ou par projet. Additionnez vos logs pour la même clé, le même modèle et le même jour UTC : les totaux en cache et hors cache doivent concorder.
3. **En argent :** valorisez séparément l'entrée en cache et l'entrée hors cache. Sur les modèles qui facturent les écritures en cache, incluez-les aussi, sinon votre estimation de l'économie sera trop élevée.

Pour la méthode complète, lisez [comment vérifier les économies LLM sur la facture de votre fournisseur](/fr/guides/verify-llm-savings-against-provider-bill). Pour les autres leviers d'une facture OpenAI, voyez [comment réduire les coûts de l'API OpenAI](/fr/guides/reduce-openai-api-costs). Les résultats mesurés, y compris là où la couche n'économise rien, sont sur la [page du banc public](/fr/benchmarks), et le code est sur [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
