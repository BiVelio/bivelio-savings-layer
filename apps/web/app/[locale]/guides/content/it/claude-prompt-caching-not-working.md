Hai aggiunto `cache_control` alle tue richieste a Claude e la fattura non si è mossa. Oppure `cache_read_input_tokens` torna `0` a ogni chiamata. Questa guida spiega perché succede, come trovare il byte esatto che rompe la cache e come verificare il risultato con i numeri di utilizzo di Anthropic stessa. Tutto ciò che vedrai qui funziona con qualsiasi SDK. Alla fine vedrai come l'SDK open source BV-SALA posiziona i breakpoint al posto tuo, e l'unico caso in cui devi dirgli di non farlo.

## Leggi prima i tre campi di utilizzo

Ogni risposta della Messages API ti dice cosa è successo alla cache. Guarda tre numeri in `usage`:

| Campo | Cosa conta |
| --- | --- |
| `cache_creation_input_tokens` | Token scritti in cache in questa chiamata, fatturati sopra il prezzo di input normale |
| `cache_read_input_tokens` | Token serviti dalla cache, fatturati a una frazione del prezzo di input |
| `input_tokens` | Token dopo l'ultimo breakpoint di cache, fatturati al prezzo normale |

I tre schemi ti dicono dove guardare:

- **Entrambi i campi della cache sono a 0.** Non è stato messo in cache nulla: il prefisso è più corto del minimo del modello, non c'è nessun breakpoint, oppure qualcosa tra te e l'API lo ha rimosso.
- **La creazione è alta a ogni chiamata e le letture restano a 0.** La cache viene scritta e mai riusata: il prefisso cambia tra una chiamata e l'altra, la voce è scaduta, oppure le chiamate vanno a un altro modello o workspace.
- **Le letture sono alte.** Funziona. A quel punto resta solo da capire quanta parte del prompt sta prima del breakpoint.

## Come funziona la cache dei prompt di Claude, in sei punti

1. Mette in cache un **prefisso**: la richiesta dall'inizio fino a un breakpoint `cache_control`. La corrispondenza è esatta; basta un byte diverso e tutto ciò che segue viene rielaborato.
2. L'ordine è **tool, poi system, poi messaggi**. Una modifica all'elenco dei tool invalida il system prompt e i messaggi successivi.
3. Puoi mettere fino a **quattro breakpoint**, e da ciascuno l'API guarda indietro di un numero limitato di blocchi alla ricerca di una voce precedente (20 nel momento in cui scriviamo).
4. Le voci durano **cinque minuti** per impostazione predefinita, e la durata si rinnova a ogni hit. Con `"ttl": "1h"` è disponibile una durata di un'ora.
5. Scrivere costa più che leggere: una scrittura da cinque minuti è fatturata 1,25 volte il prezzo di input e una da un'ora 2 volte; una lettura costa una piccola frazione del prezzo di input (0,1 volte sulla maggior parte dei modelli). Controlla la [pagina dei prezzi di Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) per il tuo modello.
6. Esiste una **lunghezza minima per la cache** che dipende dal modello, da 512 a 4096 token. Sotto quella soglia la richiesta semplicemente non va in cache, senza alcun errore.

Tutto questo è nella [documentazione di Anthropic sul prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), la fonte di cui fidarsi quando un numero cambia.

## Le cause più comuni, nell'ordine in cui controllarle

1. **Il prefisso è troppo corto.** Un system prompt da 600 token è sotto il minimo di diversi modelli. Raggruppa istruzioni stabili, esempi e testo di riferimento, così che la parte in cache sia abbastanza lunga da contare.
2. **Qualcosa nel prefisso cambia a ogni chiamata.** I classici: un timestamp o una riga «Oggi è…» nel system prompt, un id di richiesta, il nome dell'utente, un ordine casuale degli esempi, definizioni dei tool costruite da un oggetto con un ordine delle chiavi non fisso, o un documento JSON serializzato con spaziature diverse.
3. **Il breakpoint sta su un contenuto che cambia.** Se l'ultimo `cache_control` è sulla domanda dell'utente, ogni chiamata scrive una nuova voce che nessuno legge. Il breakpoint va alla fine della parte che non cambia.
4. **La voce è scaduta.** Chiamate a più di cinque minuti di distanza non leggono mai la voce l'una dell'altra. Un batch notturno che elabora un elemento ogni dieci minuti paga ogni volta il sovrapprezzo di scrittura e non legge nulla.
5. **Le chiamate non condividono la cache.** Un modello diverso, un workspace diverso o un cambio di modello a metà conversazione ripartono ciascuno da una cache vuota.
6. **Le chiamate parallele si fanno concorrenza.** Una voce può essere letta solo dopo che è iniziata la prima risposta. Dieci chiamate identiche lanciate insieme scrivono tutte. Mandane prima una, poi le altre.
7. **Un proxy rimuove il marcatore.** Un gateway che elimina `cache_control`, o che trasforma un `system` a blocchi in una semplice stringa, fa fatturare l'intero prompt come input non in cache mentre ogni chiamata va comunque a buon fine. La documentazione di Claude Code descrive proprio questo problema per i [gateway LLM](https://code.claude.com/docs/en/prompt-caching).

## Trova il byte che rompe la cache

Quando le letture restano a zero, registra due corpi di richiesta consecutivi e trova il primo punto in cui differiscono, nell'ordine in cui li legge la cache:

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

Se la prima differenza cade nel system prompt o nell'elenco dei tool, hai trovato il tuo cache miss. Sposta quella parte alla fine della richiesta, di solito nel messaggio dell'utente.

Poi tieni traccia della percentuale di hit per chiamata, così una regressione salta fuori il giorno stesso del rilascio:

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

## Al tuo traffico conviene la cache?

Dato che le scritture costano più dell'input normale, mettere in cache è una scommessa: che il prefisso venga riletto prima di scadere. Con la durata di cinque minuti basta una sola lettura a ripagare la scrittura. Un prefisso scritto e mai letto costa circa il 25% in più che inviarlo senza marcatore. Ecco perché «mettere `cache_control` ovunque» non è un'impostazione predefinita sicura: conviene sul traffico di chat e di agenti che si ripresenta nel giro di minuti, e ci perde sulle richieste isolate o sui prompt che cambiano ogni volta.

## Come la gestisce BV-SALA

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) è un layer di risparmio con licenza Apache-2.0. Con `AnthropicProvider` posiziona i breakpoint al posto tuo, gratis e senza chiave: uno alla fine del system prompt e uno alla fine della parte di conversazione che non cambia, mai più di quanti ne consenta l'API. Il report di ogni chiamata mostra cosa ha fatto la cache, dai contatori di Anthropic stessa:

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

`report.nativeSavings` è lo sconto di Anthropic, mostrato a parte: il layer non lo conta mai come risparmio proprio, così il tuo report torna con la fattura.

**Il caso in cui conviene disattivare la marcatura.** Senza chiave, se il tuo system prompt cambia a ogni richiesta (un timestamp, un id utente), o se le tue chiamate sono a più di cinque minuti di distanza in processi nuovi, la marcatura predefinita scrive una voce di cache che nessuno legge, e il README dichiara che questo costa circa il 20% in più che senza layer. Sposta ciò che cambia nel messaggio dell'utente, oppure disattiva la marcatura:

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

Quel riordino opzionale è la leva dietro un test esplorativo dal vivo pubblicato nel README: su `claude-haiku-4-5`, in una sequenza costruita in cui un timestamp avvelenava la cache, ha portato la percentuale di hit dallo 0% al 95% e ha ridotto il costo per richiesta dell'82,76%, rispetto allo stesso layer senza l'opzione, con 20 richieste per braccio, misurato con la versione 1.2.0 il 15 novembre 2026. È un test piccolo e costruito, non una previsione per il tuo traffico.

## Verifica con i numeri di Anthropic

1. **Per chiamata.** Registra `usage` di ogni risposta (o `report.nativeSavings` se usi il layer) e calcola la percentuale di hit come sopra. Un carico di chat o di agenti in salute mostra, dopo la prima chiamata, letture molto superiori alle scritture.
2. **Per giorno.** Nella Claude Console, la pagina di utilizzo suddivide l'input in scritture e letture di cache per modello e chiave API. Somma i `cache_read_input_tokens` e `cache_creation_input_tokens` che hai registrato per la stessa chiave e lo stesso giorno UTC: i totali devono coincidere. Per un controllo automatico, la [Usage and Cost Admin API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) restituisce gli stessi contatori.
3. **In denaro.** Valorizza separatamente letture, scritture e input normale. Un report che mostra solo i «token risparmiati» e non il sovrapprezzo di scrittura nasconde metà del bilancio.

I [benchmark pubblici](/it/benchmarks) del repository misurano entrambi i bracci di ogni test con il contatore di utilizzo del provider stesso. Per il metodo generale, vedi [come verificare i risparmi LLM con la tua fattura](/it/guides/verify-llm-savings-against-provider-bill). Per il lato OpenAI dello stesso problema, vedi [perché cached_tokens di OpenAI è 0](/it/guides/openai-prompt-caching-cached-tokens). Il codice è su [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
