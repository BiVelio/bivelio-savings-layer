« Combien coûte Claude Code ? » appelle deux réponses honnêtes. Avec un abonnement Claude, le prix est celui de la formule, et le coût par token ne compte qu'une fois ses limites dépassées. Avec une clé d'API ou un fournisseur cloud, vous payez au token, et le coût d'une session dépend du nombre de requêtes qu'envoie Claude Code, de la taille de chacune et de la part lue depuis le cache de prompts. Ce guide montre ce que publie Anthropic, quels outils intégrés donnent des totaux, et comment voir le coût de chaque requête sur votre propre machine, gratuitement, pour repérer les tours qui rendent une session chère.

## Ce qu'Anthropic annonce comme coût

La [page de coûts de Claude Code](https://code.claude.com/docs/en/costs) d'Anthropic donne des moyennes issues de déploiements en entreprise : environ 13 $US par développeur et par jour actif et de 150 $US à 250 $US par développeur et par mois, avec 90 % des utilisateurs sous les 30 $US par jour actif. Ce sont des moyennes sur de nombreuses équipes. Votre chiffre dépend du modèle choisi, de la taille de votre dépôt et de votre façon de travailler, et c'est pourquoi le reste de ce guide porte sur la façon de le mesurer.

## Les outils intégrés, et ce qu'ils ne montrent pas

- **`/usage` dans Claude Code.** Le bloc Session affiche un coût *estimé* au prix catalogue, avec les tokens par modèle répartis en entrée, sortie, lectures de cache et écritures de cache. Les versions récentes ajoutent une ligne sur le cache de prompts avec le taux de succès et le nombre de défauts de cache. C'est un total de session, calculé localement.
- **La Claude Console.** Pour les clés d'API, les pages Cost et Usage montrent ce qui a été facturé, par jour, workspace et modèle. C'est le chiffre de référence pour le rapprochement.
- **L'export OpenTelemetry.** Claude Code peut envoyer des métriques de tokens et de coût vers votre propre stack d'observabilité, par utilisateur et par session ([documentation de supervision](https://code.claude.com/docs/en/monitoring-usage)).

Ce qu'aucun de ces outils ne facilite, c'est la **vue par requête** : quel tour a coûté cher, et pourquoi. Une session représente des dizaines ou des centaines d'appels d'API, et les plus chers ont des causes reconnaissables :

- **Un cache froid.** Le premier tour après une pause plus longue que la durée de vie du cache relit toute la conversation au plein tarif, et la réécrit.
- **Un changement de modèle.** Chaque modèle a son propre cache : changer de modèle en cours de session fait tout retraiter.
- **D'énormes résultats d'outils.** Un log de tests ou un gros fichier lu une seule fois reste dans le contexte de tous les tours suivants.
- **Trop de définitions d'outils.** Les serveurs MCP peuvent ajouter de nombreux kilo-octets de définitions à chaque requête.
- **La compaction.** Résumer une longue conversation est en soi une grosse requête.

## Mesurez chaque requête avec un gateway local

Un gateway est un petit proxy placé entre Claude Code et l'API, qui lit les compteurs d'usage de chaque réponse. Claude Code le prend officiellement en charge via `ANTHROPIC_BASE_URL`. [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) en fournit un dans son paquet npm : Apache-2.0, **sans clé, sans inscription**, et rien n'est envoyé à BiVelio. Il faut Node.js 20 ou une version plus récente.

La méthode en une seule commande :

```bash
# Starts a local gateway on a free port, runs Claude Code through it, and stops it on exit.
npx @bivelio/savings-layer claude
```

L'enveloppe met en sourdine le log par requête pour ne pas écrire par-dessus l'interface de Claude Code. À la sortie, elle affiche combien de requêtes elle a mesurées, lesquelles elle a transmises sans les mesurer, et pourquoi. Pour voir chaque requête au moment où elle passe, vous pouvez soit demander le log sur stderr :

```bash
BVSALA_GATEWAY_LOG=1 npx @bivelio/savings-layer claude
```

soit lancer le gateway dans son propre terminal, sur un port fixe :

```bash
# Terminal 1: the gateway (Anthropic is the default upstream, port 8402)
npx @bivelio/savings-layer gateway

# Terminal 2: Claude Code, pointed at it (no /v1 at the end).
# ENABLE_TOOL_SEARCH=true only matters before Claude Code v2.1.304 (see below).
ENABLE_TOOL_SEARCH=true ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude
```

Chaque requête devient une ligne. Ces deux-là viennent d'un test local contre un serveur de substitution, avec du trafic inventé ; la forme est donc réelle, mais les chiffres ne sont pas les vôtres :

```text
[gateway] POST /v1/messages  · claude-sonnet-5 · $0.007700 (in 40, cache↑3000 cache↓0, out 12)
[gateway] POST /v1/messages  · claude-sonnet-5 · $0.000800 (in 40, cache↑0 cache↓3000, out 12)
```

Lisez de gauche à droite : le modèle, le coût au prix catalogue standard du modèle (les tours en mode rapide font exception, voir plus bas), puis les tokens d'entrée facturés plein tarif, les tokens écrits dans le cache (`cache↑`), les tokens lus depuis le cache (`cache↓`) et les tokens de sortie. La première ligne est un tour à froid qui écrit le préfixe ; la seconde le relit pour une fraction du prix. Une session où `cache↑` reste élevé tour après tour a un problème de cache : voyez [pourquoi le prompt caching de Claude cesse de fonctionner](/fr/guides/claude-prompt-caching-not-working).

`ENABLE_TOOL_SEARCH=true` dépend de votre version de Claude Code. Depuis la v2.1.304, la recherche d'outils reste active derrière un gateway ([documentation MCP de Claude Code](https://code.claude.com/docs/en/mcp)), et la variable ne change rien. Avant la v2.1.304, Claude Code désactivait la recherche d'outils derrière toute base URL autre que celle d'Anthropic et mettait toutes les définitions d'outils dans chaque requête. Sur ces anciennes versions, cela coûtait cher : le guide Claude Code du gateway, livré dans le paquet npm, documente une configuration avec 226 outils MCP, mesurée le 9 septembre 2026, où cela représentait 450 KB par requête et un quart de la facture de la journée. L'enveloppe `claude` définit la variable pour vous, sauf si vous l'avez déjà définie.

## Ce que le gateway voit, et ce qu'il ne voit pas

- **Il transmet ce qu'envoie Claude Code.** Quand aucun levier n'agit sur une requête, le corps arrive chez Anthropic octet pour octet, y compris les marqueurs `cache_control` et l'en-tête `anthropic-beta` : le cache fonctionne donc exactement comme sans le gateway. Un test du dépôt le vérifie contre un faux serveur amont à chaque modification.
- **Deux petits appels le contournent.** D'après le [guide de compatibilité des gateways](https://code.claude.com/docs/en/llm-gateway-protocol) de Claude Code, la vérification de disponibilité du mode rapide et la vérification de sécurité des domaines de WebFetch appellent directement `api.anthropic.com` au lieu de suivre `ANTHROPIC_BASE_URL`. Aucun des deux n'est une requête au modèle : l'inférence en mode rapide, elle, suit la base URL et passe par le gateway.
- **Les tours en mode rapide sont enregistrés au prix standard.** Anthropic marque une requête en mode rapide avec `speed: "fast"` et la facture avec un supplément : 8 $US en entrée et 40 $US en sortie par million de tokens sur Claude Opus 5.5, soit deux fois le tarif standard, avec les multiplicateurs de cache en plus ([documentation du mode rapide](https://platform.claude.com/docs/en/build-with-claude/fast-mode)). La version 1.2.3 du gateway ne lit pas `speed` : elle compte correctement ces tokens mais les valorise comme des tours standard, soit, sur Opus 5.5, la moitié de ce que facture Anthropic. Si vous utilisez `/fast`, le total du gateway pour ces tours est trop bas.
- **Le trafic d'abonnement est mesuré, pas facturé.** Avec une connexion Claude Pro ou Max, il n'y a pas de facture au token ; le gateway valorise ce trafic en équivalent prix catalogue pour que vous puissiez le voir, et ne lui attribue aucune économie.

## Le gateway fait-il aussi économiser ?

Tel quel, avec Claude Code sur une clé d'API, il mesure et n'économise rien. Ne prenez pas le message de démarrage de la version 1.2.3 pour une promesse : il dit que tous les leviers d'économie locaux sont actifs, et son résumé de sortie ne compte que les requêtes qu'il a mesurées ; ni l'un ni l'autre ne vous dit donc que l'économie a été nulle. Le levier par défaut du gateway ramène la durée de vie des écritures en cache d'une heure à cinq minutes sur les tours où une grande partie de la requête est nouvelle, car une écriture d'une heure coûte deux fois le prix d'entrée et une écriture de cinq minutes 1,25 fois. Claude Code sur une clé d'API demande déjà cinq minutes, sauf si vous réglez `promptCacheTtl` sur `1h` : il n'y a donc rien à abaisser.

Quand le cache d'une heure entre en jeu, l'économie est faible et dépend de votre trafic. La [page du banc public](/fr/benchmarks#gateway-ttl) publie un replay du propre trafic Claude Code d'une organisation : net **+2,49 %** de la facture au prix catalogue (113,45 $US sur 4 563,61 $US), avec un intervalle à 95 % de +1,50 % à +3,57 % en rééchantillonnant par session, et un plafond de 7,2 % pour toute politique de ce type. Sur un modèle, le résultat était proche de zéro, et sur une période, il a fait perdre de l'argent. C'est un replay avec une référence en partie reconstruite, pas une facture, et la page en liste toutes les limites.

## Rapprochez les chiffres du gateway de votre facture

1. **Avec `/usage`.** Pour une session, additionnez les coûts par requête du gateway et comparez-les au bloc Session de `/usage`. Les deux valorisent les mêmes compteurs au prix catalogue : ils doivent donc être proches, sauf pour les tours en mode rapide, que `/usage` valorise au tarif rapide et le gateway 1.2.3 au tarif standard.
2. **Avec la Console.** Utilisez une clé d'API ou un workspace dédié pendant une journée, puis comparez les totaux par modèle du gateway avec la page Usage de la Console pour cette clé : entrée, sortie, écritures et lectures de cache, d'abord en tokens, puis en dollars.
3. **Expliquez tout écart.** Le prix catalogue n'est pas toujours votre prix : les remises contractuelles, la résidence des données ou les niveaux de priorité changent les montants, mais pas le nombre de tokens. Le mode rapide aussi : avec `/fast` activé, le total du gateway est inférieur à celui de la Console, car la 1.2.3 valorise les tours en mode rapide au tarif standard. Le trafic qui n'est pas passé par ce gateway, comme une autre machine, un script ou un job de CI qui utilise la même clé, n'apparaît que dans la Console.

Si les tokens concordent et pas les dollars, l'écart vient des prix, pas de la mesure. Pour la méthode complète, lisez [comment vérifier les économies LLM sur la facture de votre fournisseur](/fr/guides/verify-llm-savings-against-provider-bill).

## Réduire la facture une fois qu'on la voit

Avec les chiffres par requête sous les yeux, les correctifs habituels sont simples : vider le contexte entre deux tâches sans rapport au lieu de traîner un long historique, choisir le modèle avant la session et s'y tenir, compacter aux pauses naturelles, garder les gros logs hors du contexte et retirer les serveurs MCP que vous n'utilisez pas. L'utilisation du modèle d'un autre fournisseur derrière Claude Code est traitée dans [coûts de l'API DeepSeek et Qwen](/fr/guides/deepseek-qwen-api-cost-local-gateway).

Le code source du gateway, son guide Claude Code et les tests qui vérifient qu'il transmet vos requêtes sans les modifier sont sur [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
