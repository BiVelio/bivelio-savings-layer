Tous les outils de suivi des coûts LLM affichent un chiffre d'économies. Rares sont ceux qui montrent comment le vérifier, et c'est à la vérification que la plupart des promesses s'effondrent : le tableau de bord affiche une grosse économie et la facture bouge à peine. Ce guide donne une méthode applicable avec n'importe quel outil, ou sans aucun : quoi enregistrer, comment le rapprocher des données d'usage du fournisseur, comment distinguer une économie réelle d'une estimation, et comment vous assurer que l'économie vient bien du changement que vous avez fait. À la fin, vous verrez comment le SDK open source BV-SALA étiquette chaque montant pour rendre cette vérification possible.

## Pourquoi chiffres d'économies et factures ne concordent pas

L'écart vient presque toujours de l'une de ces causes :

- **Le prix catalogue contre votre prix.** Les outils valorisent les tokens aux prix catalogue publics. Votre facture peut inclure des remises, des contrats d'engagement, des tarifs régionaux ou liés à la résidence des données, des niveaux de priorité et des taxes.
- **Des estimations présentées comme des mesures.** Si un outil a retiré 2 000 tokens d'un prompt, le fournisseur ne les a jamais comptés. Le chiffre « économisé » est le propre décompte de l'outil, fait avec un tokenizer qui n'est peut-être pas celui du fournisseur.
- **La remise du fournisseur revendiquée par l'outil.** Le prompt caching d'OpenAI, d'Anthropic, de DeepSeek ou de Gemini est facturé par le fournisseur à un tarif réduit. Un outil qui compte cette remise comme sa propre économie gonfle son chiffre.
- **Du trafic que l'outil n'a jamais vu.** Les appels d'un autre service, le script d'un collègue, les requêtes annexes d'un agent de code ou un job batch apparaissent tous sur la facture, et pas dans l'outil.
- **L'usage manquant.** Une requête en streaming privée de son événement d'usage final n'a aucun nombre de tokens. La compter silencieusement comme zéro fait paraître moins cher tout ce qui en découle.
- **Le temps.** Les fournisseurs regroupent l'usage par jour UTC, et une partie de l'usage apparaît avec du retard.

## La méthode, étape par étape

### 1. Enregistrez les compteurs du fournisseur lui-même pour chaque requête

Pas votre estimation : le bloc `usage` renvoyé par le fournisseur. L'entrée, l'entrée en cache (et les écritures en cache quand elles existent), la sortie, les tokens de raisonnement, l'id de modèle que déclare le fournisseur, la clé d'API ou le projet, et l'horodatage UTC. Marquez une requête dont l'usage n'est pas arrivé comme **non mesurée**, jamais comme zéro.

### 2. Rapprochez les tokens avant les dollars

Exportez l'usage quotidien du fournisseur pour les mêmes clés et les mêmes jours : l'[API Usage](https://developers.openai.com/api/reference/resources/organization/subresources/usage) d'OpenAI, l'[API Usage and Cost](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) d'Anthropic, ou les pages d'usage des consoles DeepSeek et Model Studio. Comparez ensuite poste par poste :

```ts
interface Row { day: string; model: string; input: number; cachedInput: number; output: number }

function byDayAndModel(rows: Row[]): Map<string, Row> {
  const totals = new Map<string, Row>();
  for (const r of rows) {
    const k = `${r.day}|${r.model}`;
    const t = totals.get(k) ?? { day: r.day, model: r.model, input: 0, cachedInput: 0, output: 0 };
    t.input += r.input;
    t.cachedInput += r.cachedInput;
    t.output += r.output;
    totals.set(k, t);
  }
  return totals;
}

/** Lines where your log and the provider disagree by more than the tolerance. Empty means they agree. */
export function reconcile(mine: Row[], provider: Row[], tolerance = 0.01): string[] {
  const a = byDayAndModel(mine);
  const b = byDayAndModel(provider);
  const gaps: string[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    for (const field of ["input", "cachedInput", "output"] as const) {
      const yours = a.get(k)?.[field] ?? 0;
      const theirs = b.get(k)?.[field] ?? 0;
      const gap = theirs === 0 ? (yours === 0 ? 0 : 1) : Math.abs(yours - theirs) / theirs;
      if (gap > tolerance) gaps.push(`${k} ${field}: yours ${yours}, provider ${theirs}`);
    }
  }
  return gaps;
}
```

Si les tokens concordent, votre journalisation est complète et vous pouvez vous fier au reste de l'analyse. Si le fournisseur en affiche davantage, trouvez le trafic que vous n'enregistrez pas avant d'aller plus loin.

### 3. Valorisez ensuite, avec une grille de prix datée

Multipliez chaque poste par son tarif, conservez la date à laquelle les tarifs ont été copiés, et comparez avec le rapport de coûts du fournisseur. Un écart stable de quelques pour cent est en général une remise ou un tarif régional, et il est le même avec et sans votre optimisation : il ne change donc pas l'économie.

### 4. Gardez séparés trois types de chiffres

- **Mesuré :** lu dans le compteur du fournisseur pour un appel qui a été exécuté.
- **Mesuré par référence :** un appel qui n'a pas eu lieu (un hit de cache, une requête dédupliquée), valorisé avec le compteur du fournisseur pour l'appel identique qui, lui, a été exécuté. C'est la meilleure preuve disponible pour un appel qui n'a jamais eu lieu.
- **Estimé :** tout ce que le fournisseur n'a jamais compté, comme les tokens qu'un outil a retirés d'un prompt.

Additionnez chaque type séparément. N'ajoutez jamais des montants estimés à des montants mesurés, et ne faites jamais la moyenne de pourcentages entre requêtes : additionnez l'argent, puis divisez.

### 5. Séparez la remise du fournisseur de la vôtre

Les tokens d'entrée en cache coûtent moins cher grâce au fournisseur. Si vous n'avez rien changé et que votre taux de succès du cache était déjà élevé, cette remise n'est pas une économie de votre projet. Valorisez les tokens en cache au tarif du cache des deux côtés de la comparaison ; ce qui reste vous revient.

## Le changement a-t-il causé l'économie ?

Une facture qui baisse après un déploiement peut aussi s'expliquer par une semaine calme. Pour attribuer une économie :

- **Faites tourner deux bras en même temps.** Envoyez les mêmes requêtes avec et sans le changement, au même moment, avec la même clé, et comparez les compteurs du fournisseur pour les deux. Répartir les requêtes au hasard entre les bras en est la version propre.
- **Donnez un intervalle, pas une valeur ponctuelle.** Rééchantillonnez des conversations ou des journées entières, et dites « entre X et Y % ». Un intervalle qui traverse zéro signifie que vous ne pouvez pas distinguer la différence du bruit, et c'est un résultat légitime.
- **Vérifiez la qualité dans le même passage.** Une réponse moins chère mais fausse n'est pas une économie. Mesurez la précision, ou un contrôle propre à la tâche, dans les deux bras.

## Comment BV-SALA rend cette vérification possible

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) est une couche d'économies sous licence Apache-2.0, gratuite et sans clé. Chaque requête renvoie un `SavingsReport` conçu précisément pour cette méthode :

- `cost.basis` vaut `measured`, `reference`, `estimated` ou `unmeasured`, selon les définitions ci-dessus. Une répétition n'est valorisée par référence que si l'appel exécuté est allé directement à l'API d'OpenAI, d'Anthropic ou de Gemini de Google ; partout ailleurs, elle reste `estimated`.
- L'économie est tenue dans quatre registres distincts qui ne sont jamais additionnés en un seul chiffre : `avoided_calls`, `eliminated_tokens`, `compressed_tokens` et `provider_cached_tokens`.
- La remise de cache propre au fournisseur est présentée à part, dans `report.nativeSavings`, et n'est jamais comptée comme une économie de la couche.
- Un stream qui se termine sans son usage est `unmeasured`, jamais valorisé à zéro.

Additionner les rapports par base tient en quelques lignes :

```ts
import type { SavingsReport } from "@bivelio/savings-layer";

/** Spend and saving per basis. Never mix bases, never average ratios. */
export function totalsByBasis(reports: SavingsReport[]) {
  const totals: Record<string, { requests: number; spendUsd: number; savedUsd: number }> = {};
  for (const r of reports) {
    const t = (totals[r.cost.basis] ??= { requests: 0, spendUsd: 0, savedUsd: 0 });
    t.requests += 1;
    t.spendUsd += r.cost.actual;
    t.savedUsd += r.cost.netSavingsUsd;
  }
  return totals;
}
```

Depuis Python, le client du paquet lit les mêmes rapports depuis le gateway local et conserve la même séparation :

```python
# pip install bivelio-savings-layer
import bvsala

gw = bvsala.Gateway("http://127.0.0.1:8403")
# ... send requests with gw.wrap(client) and read each one with gw.report(response) ...
t = gw.totals()
print(t.requests, t.metered, t.not_metered, t.actual_cost_usd)
print(t.net_savings_usd_by_basis)  # one amount per basis, never added together
```

Appliquez ensuite l'étape 2 ci-dessus à ces totaux : la dépense `measured` de la couche doit correspondre à l'usage du fournisseur pour la même clé et le même jour, exactement en tokens et, en dollars, aux remises près. Les rapports valorisent au prix catalogue ; ce ne sont pas des factures.

## La même méthode, appliquée en public

Le projet publie ses propres passages A/B sur la [page du banc public](/fr/benchmarks) : deux bras sur les mêmes requêtes, l'un directement vers le fournisseur et l'autre à travers la couche, tous deux mesurés avec le compteur d'usage du fournisseur lui-même, avec des intervalles à 95 %, ainsi que la date et la version de chaque passage. Les résultats qui n'ont rien économisé, ou qui ont coûté plus cher, sont sur la même page. La méthode complète, l'estimateur et ses limites sont dans [l'article de recherche](/fr/paper).

Pour les détails propres à chaque fournisseur, voyez [pourquoi cached_tokens vaut 0 chez OpenAI](/fr/guides/openai-prompt-caching-cached-tokens), [pourquoi le prompt caching de Claude ne fonctionne pas](/fr/guides/claude-prompt-caching-not-working) et [mesurer le coût de Claude Code requête par requête](/fr/guides/claude-code-cost-per-request). Le code et les rapports bruts sont sur [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
