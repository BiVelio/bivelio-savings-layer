Totes les eines de costos de LLM mostren una xifra d'estalvi. Poques mostren com comprovar-la, i és en la comprovació on s'ensorren la majoria de promeses: el tauler mostra un gran estalvi i la factura amb prou feines es mou. Aquesta guia dona un mètode que pots aplicar amb qualsevol eina, o sense cap: què registrar, com conciliar-ho amb les dades d'ús del proveïdor, com distingir un estalvi real d'una estimació i com assegurar-te que l'estalvi ve del canvi que has fet. Al final veuràs com l'SDK open source BV-SALA etiqueta cada import perquè aquesta comprovació sigui possible.

## Per què no quadren les xifres d'estalvi i les factures

La diferència gairebé sempre ve d'una d'aquestes causes:

- **Preu de llista davant del teu preu.** Les eines valoren els tokens als preus de llista públics. La teva factura pot incloure descomptes, contractes de consum compromès, tarifes regionals o de residència de dades, nivells de prioritat i impostos.
- **Estimacions presentades com a mesures.** Si una eina ha tret 2,000 tokens d'un prompt, el proveïdor no els ha comptat mai. La xifra «estalviada» és el recompte de la mateixa eina, fet amb un tokenitzador que pot no ser el del proveïdor.
- **El descompte del proveïdor atribuït a l'eina.** La memòria cau de prompts d'OpenAI, Anthropic, DeepSeek o Gemini la factura el proveïdor a una tarifa més baixa. Una eina que compta aquest descompte com a estalvi propi n'infla la xifra.
- **Trànsit que l'eina no ha vist mai.** Les crides d'un altre servei, l'script d'un company, les peticions secundàries d'un agent de programació o un procés batch apareixen totes a la factura i no a l'eina.
- **Ús que no arriba.** Una petició en streaming sense el seu esdeveniment final d'ús no té cap recompte de tokens. Comptar-la com a zero sense avisar fa que tot el que ve després sembli més barat.
- **El temps.** Els proveïdors agrupen l'ús per dia UTC, i part de l'ús apareix amb retard.

## El mètode, pas a pas

### 1. Registra els comptadors del mateix proveïdor a cada petició

No la teva estimació: el bloc `usage` que ha retornat el proveïdor. Entrada, entrada en memòria cau (i escriptures a la memòria cau on n'hi hagi), sortida, tokens de raonament, l'id de model que indica el proveïdor, la clau d'API o el projecte, i el timestamp UTC. Marca una petició l'ús de la qual no ha arribat com a **sense mesurar**, mai com a zero.

### 2. Concilia els tokens abans que els dòlars

Exporta l'ús diari del proveïdor per a les mateixes claus i els mateixos dies: la [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) d'OpenAI, la [Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) d'Anthropic o les pàgines d'ús de les consoles de DeepSeek i Model Studio. Després compara partida per partida:

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

Si els tokens quadren, el teu registre és complet i et pots refiar de la resta de l'anàlisi. Si el proveïdor en mostra més, troba el trànsit que no estàs registrant abans de continuar.

### 3. Després posa-hi preu, amb una taula de preus datada

Multiplica cada partida per la seva tarifa, guarda la data en què vas copiar les tarifes i compara amb l'informe de costos del proveïdor. Una diferència estable d'un petit percentatge sol ser un descompte o una tarifa regional, i és la mateixa amb la teva optimització i sense, així que no canvia l'estalvi.

### 4. Mantén separades tres classes de xifres

- **Mesurat:** llegit del comptador del proveïdor per a una crida que s'ha executat.
- **Mesurat per referència:** una crida que no s'ha fet (un encert de memòria cau, una petició deduplicada), valorada amb el comptador del proveïdor de la crida idèntica que sí que s'ha executat. És la millor prova disponible d'una crida que no ha passat mai.
- **Estimat:** tot el que el proveïdor no ha comptat mai, com els tokens que una eina ha tret d'un prompt.

Suma cada classe per separat. No sumis mai imports estimats als mesurats, i no facis mai la mitjana de percentatges entre peticions: suma els diners i després divideix.

### 5. Separa el descompte del proveïdor del teu

Els tokens d'entrada en memòria cau són més barats gràcies al proveïdor. Si no has canviat res i la teva taxa d'encerts ja era alta, aquest descompte no és un estalvi del teu projecte. Valora els tokens en memòria cau a la tarifa de memòria cau als dos costats de la comparació; el que queda és teu.

## L'estalvi l'ha causat el canvi?

Una factura que baixa després d'un desplegament també pot ser una setmana tranquil·la. Per atribuir un estalvi:

- **Executa dos braços alhora.** Envia les mateixes peticions amb el canvi i sense, al mateix temps i amb la mateixa clau, i compara els comptadors del proveïdor de tots dos. Repartir les peticions a l'atzar entre els braços és la versió neta.
- **Dona un interval, no un punt.** Remostreja converses o dies sencers i digues «entre X i Y %». Un interval que travessa el zero vol dir que no pots distingir la diferència del soroll, i això és un resultat legítim.
- **Comprova la qualitat en la mateixa execució.** Una resposta més barata però errònia no és un estalvi. Mesura la precisió, o una comprovació pròpia de la tasca, als dos braços.

## Com fa possible BV-SALA aquesta comprovació

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) és una capa d'estalvi Apache-2.0, gratis i sense clau. Cada petició retorna un `SavingsReport` pensat exactament per a aquest mètode:

- `cost.basis` és `measured`, `reference`, `estimated` o `unmeasured`, amb les definicions de més amunt. Una repetició només es valora per referència quan la crida que es va executar va anar directament a l'API d'OpenAI, d'Anthropic o de Gemini de Google; en qualsevol altre cas es queda en `estimated`.
- L'estalvi es porta en quatre llibres comptables separats que no se sumen mai en una sola xifra: `avoided_calls`, `eliminated_tokens`, `compressed_tokens` i `provider_cached_tokens`.
- El descompte de memòria cau del mateix proveïdor es dona a part, a `report.nativeSavings`, i no es compta mai com a estalvi de la capa.
- Un stream que acaba sense el seu ús és `unmeasured`, i no es valora mai com a zero.

Sumar els informes per base només demana unes quantes línies:

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

Des de Python, el client del paquet llegeix els mateixos informes del gateway local i manté la mateixa separació:

```python
# pip install bivelio-savings-layer
import bvsala

gw = bvsala.Gateway("http://127.0.0.1:8403")
# ... send requests with gw.wrap(client) and read each one with gw.report(response) ...
t = gw.totals()
print(t.requests, t.metered, t.not_metered, t.actual_cost_usd)
print(t.net_savings_usd_by_basis)  # one amount per basis, never added together
```

Després aplica el pas 2 de més amunt a aquests totals: la despesa `measured` de la capa hauria de coincidir amb l'ús del proveïdor per a la mateixa clau i el mateix dia, exactament en tokens i, en dòlars, llevat dels teus descomptes. Els informes valoren a preu de llista; no són una factura.

## El mateix mètode, aplicat en públic

El projecte publica les seves pròpies execucions A/B a la [pàgina del banc públic](/ca/benchmarks): dos braços amb les mateixes peticions, un directe al proveïdor i un altre a través de la capa, tots dos mesurats amb el comptador d'ús del mateix proveïdor, amb intervals del 95 % i la data i la versió de cada execució. Els resultats que no van estalviar res, o que van costar més, són a la mateixa pàgina. El mètode complet, l'estimador i els seus límits són al [paper](/ca/paper).

Per als detalls de cada proveïdor, consulta [per què cached_tokens és 0 a OpenAI](/ca/guides/openai-prompt-caching-cached-tokens), [per què no funciona el prompt caching de Claude](/ca/guides/claude-prompt-caching-not-working) i [com mesurar el cost de Claude Code per petició](/ca/guides/claude-code-cost-per-request). El codi i els informes en brut són a [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
