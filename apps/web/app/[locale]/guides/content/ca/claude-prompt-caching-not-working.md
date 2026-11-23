Has afegit `cache_control` a les teves peticions a Claude i la factura no s'ha mogut. O bé `cache_read_input_tokens` torna com a `0` a cada crida. Aquesta guia explica per què passa, com trobar el byte exacte que trenca la memòria cau i com contrastar el resultat amb les xifres d'ús de la mateixa Anthropic. Tot el que hi ha aquí funciona amb qualsevol SDK. Al final veuràs com l'SDK open source BV-SALA col·loca els punts de tall (breakpoints) per tu, i l'únic cas en què li hauries de dir que no ho faci.

## Llegeix primer els tres camps d'ús

Cada resposta de la Messages API et diu què ha passat amb la memòria cau. Fixa't en tres xifres d'`usage`:

| Camp | Què compta |
| --- | --- |
| `cache_creation_input_tokens` | Tokens escrits a la memòria cau en aquesta crida, facturats per sobre del preu normal d'entrada |
| `cache_read_input_tokens` | Tokens servits des de la memòria cau, facturats a una fracció del preu d'entrada |
| `input_tokens` | Tokens posteriors a l'últim punt de tall de la memòria cau, facturats al preu normal |

Els tres patrons et diuen on mirar:

- **Els dos camps de memòria cau són a 0.** No s'ha desat res a la memòria cau: el prefix és més curt que el mínim del model, no hi ha cap punt de tall o alguna cosa entre tu i l'API l'ha tret.
- **La creació és alta a cada crida i les lectures es queden a 0.** La memòria cau s'escriu i no es reutilitza mai: el prefix canvia entre crides, l'entrada ha caducat o les crides van a un altre model o a un altre workspace.
- **Les lectures són altes.** Funciona. Ara l'única pregunta és quina part del prompt queda abans del punt de tall.

## Com funciona la memòria cau de prompts de Claude, en sis punts

1. Desa a la memòria cau un **prefix**: la petició des del principi fins a un punt de tall `cache_control`. La coincidència és exacta; n'hi ha prou amb un byte diferent perquè tot el que ve darrere es torni a processar.
2. L'ordre és **tools, després system, després messages**. Un canvi a la llista d'eines invalida el prompt de sistema i els missatges que hi ha darrere.
3. Pots col·locar fins a **quatre punts de tall**, i des de cadascun l'API busca enrere una entrada anterior en un nombre limitat de blocs (20 en el moment d'escriure això).
4. Les entrades duren **cinc minuts** per defecte i es renoven amb cada encert. Amb `"ttl": "1h"` tens una durada d'una hora.
5. Escriure costa més que llegir: una escriptura de cinc minuts es factura a 1,25 vegades el preu d'entrada i una d'una hora a 2 vegades; una lectura costa una petita fracció del preu d'entrada (0,1 vegades en la majoria de models). Consulta la [pàgina de preus d'Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) per al teu model.
6. Hi ha una **longitud mínima per entrar a la memòria cau** que depèn del model, de 512 a 4.096 tokens. Per sota, la petició simplement no es desa a la memòria cau, sense cap error.

Tot això és a la [documentació de prompt caching d'Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), que és la font fiable quan canvia alguna xifra.

## Les causes habituals, en l'ordre en què convé revisar-les

1. **El prefix és massa curt.** Un prompt de sistema de 600 tokens és per sota del mínim en diversos models. Ajunta les instruccions estables, els exemples i el text de referència perquè la part en memòria cau sigui prou llarga per notar-se.
2. **Alguna cosa del prefix canvia a cada crida.** Els clàssics: un timestamp o una línia «Avui és…» al prompt de sistema, un id de petició, el nom de l'usuari, un ordre aleatori dels exemples, definicions d'eines generades a partir d'un objecte amb un ordre de claus que no és fix, o un document JSON serialitzat amb un espaiat diferent.
3. **El punt de tall és en contingut que canvia.** Si l'últim `cache_control` és a la pregunta de l'usuari, cada crida escriu una entrada nova que ningú no llegeix. El punt de tall va al final de la part que no canvia.
4. **L'entrada ha caducat.** Dues crides separades per més de cinc minuts no llegeixen mai l'entrada de l'altra. Un batch nocturn que processa un element cada deu minuts paga el sobrecost d'escriptura cada vegada i no llegeix res.
5. **Les crides no comparteixen memòria cau.** Un altre model, un altre workspace o un canvi de model a mitja conversa comencen, cadascun, amb la memòria cau buida.
6. **Les crides en paral·lel competeixen.** Una entrada només es pot llegir quan ja ha començat la primera resposta. Deu crides idèntiques llançades alhora escriuen totes. Envia'n una primer i després la resta.
7. **Un proxy treu la marca.** Un gateway que elimina `cache_control`, o que converteix un `system` en forma de blocs en una cadena simple, fa que tot el prompt es facturi com a entrada sense memòria cau mentre totes les crides continuen funcionant. La documentació de Claude Code descriu exactament aquest error per als [gateways de LLM](https://code.claude.com/docs/en/prompt-caching).

## Troba el byte que trenca la memòria cau

Quan les lectures es queden a zero, registra dos cossos de petició consecutius i busca on difereixen per primera vegada, en l'ordre en què els llegeix la memòria cau:

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

Si la primera diferència és dins del prompt de sistema o de la llista d'eines, ja tens la fallada de memòria cau. Porta aquesta part al final de la petició, normalment al missatge de l'usuari.

Després, segueix la taxa d'encerts de cada crida, perquè una regressió aparegui el mateix dia que arriba a producció:

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

## Et surt a compte la memòria cau amb el teu trànsit?

Com que les escriptures costen més que l'entrada normal, fer servir la memòria cau és apostar que el prefix es tornarà a llegir abans de caducar. Amb la durada de cinc minuts, una sola lectura ja paga l'escriptura. Un prefix que s'escriu i no es llegeix mai costa prop d'un 25 % més que enviar-lo sense marca. Per això «posa `cache_control` a tot arreu» no és una opció per defecte segura: surt a compte en el trànsit de xat i d'agents que torna al cap de pocs minuts, i hi surt perdent en peticions soltes o en prompts que canvien cada vegada.

## Com ho resol BV-SALA

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) és una capa d'estalvi Apache-2.0. Amb `AnthropicProvider` col·loca els punts de tall per tu, gratis i sense clau: un al final del prompt de sistema i un altre al final de la part de la conversa que no canvia, mai més dels que permet l'API. L'informe de cada crida mostra què ha fet la memòria cau, a partir dels comptadors de la mateixa Anthropic:

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

`report.nativeSavings` és el descompte d'Anthropic, mostrat a part: la capa no el compta mai com a estalvi propi, de manera que el teu informe quadra amb la factura.

**El cas en què convé desactivar les marques.** Sense clau, si el teu prompt de sistema canvia a cada petició (un timestamp, un id d'usuari) o les teves crides estan separades per més de cinc minuts en processos nous, el marcatge per defecte escriu una entrada de memòria cau que ningú no llegeix, i el README indica que això costa prop d'un 20 % més que sense capa. Passa el que canvia al missatge de l'usuari o desactiva les marques:

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

Aquesta reordenació opcional és la palanca que hi ha darrere d'una prova exploratòria en viu publicada al README: amb `claude-haiku-4-5`, en una seqüència construïda en què un timestamp enverinava la memòria cau, va portar la taxa d'encerts del 0 % al 95 % i va abaixar el cost per petició un 82,76 %, en comparació amb la mateixa capa sense l'opció, amb 20 peticions per braç, mesurat amb la versió 1.2.0 el 15 de novembre de 2026. És una prova petita i construïda, no una previsió per al teu trànsit.

## Contrasta-ho amb les xifres d'Anthropic

1. **Per crida.** Registra `usage` de cada resposta (o `report.nativeSavings` si fas servir la capa) i calcula la taxa d'encerts de més amunt. Una càrrega sana de xat o d'agents mostra, després de la primera crida, moltes més lectures que escriptures.
2. **Per dia.** A la Claude Console, la pàgina d'ús desglossa l'entrada en escriptures i lectures de memòria cau per model i clau d'API. Suma els `cache_read_input_tokens` i `cache_creation_input_tokens` que has registrat per a la mateixa clau i el mateix dia UTC: els totals haurien de coincidir. Per comprovar-ho amb codi, la [Usage and Cost Admin API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) retorna els mateixos comptadors.
3. **En diners.** Posa preu per separat a les lectures, a les escriptures i a l'entrada normal. Un informe que només mostra «tokens estalviats» i no el sobrecost d'escriptura amaga la meitat del balanç.

El [banc públic](/ca/benchmarks) del repositori mesura els dos braços de cada prova amb el comptador d'ús del mateix proveïdor. Per al mètode general, consulta [com verificar l'estalvi en LLM amb la teva factura](/ca/guides/verify-llm-savings-against-provider-bill). Per a la part d'OpenAI del mateix problema, consulta [per què cached_tokens és 0 a OpenAI](/ca/guides/openai-prompt-caching-cached-tokens). El codi és a [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
