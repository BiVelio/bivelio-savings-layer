Una fattura OpenAI è la somma di pochi numeri per richiesta: token di input non in cache, token di input in cache, scritture in cache (su GPT-5.6 e modelli successivi), token di output (ragionamento incluso) e il prezzo del modello. Qualsiasi modo di ridurla agisce su uno di questi numeri. Questa guida passa in rassegna le leve nell'ordine in cui di solito rendono di più, dice quando ciascuna non conviene e mostra come dimostrare ogni risparmio con i dati di utilizzo di OpenAI stessa invece che con una proiezione. Per la maggior parte non serve alcuno strumento; dove l'SDK open source BV-SALA automatizza una leva, vedrai come.

## Parti misurando ogni richiesta

Prima di cambiare qualsiasi cosa, registra il blocco `usage` di ogni risposta insieme alla funzionalità o al template di prompt che l'ha prodotta: `prompt_tokens`, `prompt_tokens_details.cached_tokens`, `cache_write_tokens` quando il modello lo riporta, `completion_tokens` e, per i modelli di ragionamento, `completion_tokens_details.reasoning_tokens`. Dai un prezzo a ogni voce con le tariffe della pagina prezzi di OpenAI e annota la data in cui le hai copiate. Su GPT-5.6 e modelli successivi le scritture in cache sono una voce a sé: OpenAI le fattura 1,25 volte la tariffa di input non in cache con la durata predefinita di 30 minuti, e 2,5 volte con la durata di 12 ore ([guida al prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), consultata il 23 novembre 2026). Se le conteggi come input normale, sottostimi il costo. Una settimana di questi dati risponde all'unica domanda che conta all'inizio: **quali due o tre funzionalità fanno la maggior parte della fattura.** Ottimizza quelle; ignora il resto.

## 1. Non pagare due volte la stessa richiesta

I retry, i doppi clic, i job notturni che riclassificano gli elementi del giorno prima e i worker paralleli che inviano lo stesso prompt costano ciascuno una chiamata intera. Una cache delle risposte a corrispondenza esatta e la deduplicazione delle richieste in volo li eliminano senza cambiare nemmeno una risposta. Quanto risparmi dipende interamente da quanto spesso le tue richieste si ripetono, quindi misura prima la tua percentuale di duplicati. Guida completa: [deduplicare le richieste LLM identiche](/it/guides/deduplicate-llm-requests).

## 2. Lascia lavorare la cache dei prompt di OpenAI

I prompt da circa 1024 token in su vanno in cache automaticamente, e i token di input in cache sono fatturati con uno sconto. Su GPT-5.6 e modelli successivi riempire la cache non è gratis: la parte che ci viene scritta è fatturata sopra la tariffa non in cache, come descritto sopra, quindi un prompt scritto e mai più riletto costa più che senza cache, e uno riletto poco dopo costa molto meno. I modelli precedenti non fanno pagare nulla in più per le scritture. La cache trova corrispondenze solo a partire dal primo token, quindi funziona solo quando l'inizio del prompt è identico da una richiesta all'altra. Metti all'inizio istruzioni, definizioni dei tool ed esempi, e alla fine date, nomi utente e la domanda. Se `cached_tokens` resta fermo a 0, leggi [perché cached_tokens di OpenAI è 0](/it/guides/openai-prompt-caching-cached-tokens).

## 3. Manda alla Batch API il lavoro che può aspettare

Valutazioni, backfill, embedding di un insieme di documenti e classificazione notturna non hanno bisogno di una risposta in due secondi. La [Batch API](https://developers.openai.com/api/docs/guides/batch) di OpenAI prende un file di richieste, restituisce i risultati entro un giorno e li fattura a una tariffa più bassa rispetto alle stesse richieste inviate una per una (vedi la [guida all'ottimizzazione dei costi](https://developers.openai.com/api/docs/guides/cost-optimization) per le condizioni attuali). Spesso è il risparmio singolo più grande per il lavoro offline, e non cambia nulla nelle risposte.

## 4. Usa il modello più piccolo che supera la tua valutazione

Le differenze di prezzo tra le fasce di modelli sono grandi, e molti compiti (classificazione, estrazione, brevi riscritture, routing) non hanno bisogno del modello più grande. Costruisci un piccolo set di valutazione a partire da richieste reali, eseguilo su due o tre modelli e scegli il più economico che lo supera. Ripetilo quando esce un nuovo modello. Senza valutazione, passare a un modello inferiore è una scommessa, e il costo delle risposte sbagliate non compare nella fattura dell'API.

## 5. Tieni sotto controllo l'output

I token di output costano di solito parecchie volte più di quelli di input, e i token di ragionamento sono fatturati come output.

- Imposta `max_completion_tokens` su quello che serve davvero alla funzionalità.
- Per i modelli di ragionamento, abbassa lo sforzo di ragionamento nei compiti che non richiedono un ragionamento profondo, e misura `reasoning_tokens` prima e dopo.
- Chiedi un output strutturato con uno schema JSON quando il tuo codice fa il parsing della risposta. Un parsing fallito seguito da un retry fa pagare due volte l'intera richiesta.

## 6. Invia meno input

- Non reinviare tutta la conversazione quando al compito servono solo gli ultimi turni.
- Togli dai turni successivi i grandi output dei tool (log, contenuti di file, risultati di ricerca) una volta che sono stati usati.
- Invia i dati strutturati in forma compatta: un JSON formattato spreca token in spazi.
- Recupera i tre paragrafi pertinenti invece di incollare l'intero documento.

Attenzione agli ultimi due nei lunghi loop di agenti: modificare la parte centrale di una cronologia che OpenAI ha già messo in cache fa rifatturare tutto ciò che segue la modifica, alla tariffa non in cache oppure, su GPT-5.6 e modelli successivi, alla tariffa più alta di scrittura in cache quando torna in cache. Accorcia ciò che è nuovo, non ciò che è in cache.

## Come BV-SALA ne automatizza alcune

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) è un layer di risparmio con licenza Apache-2.0 che avvolge qualsiasi endpoint compatibile con OpenAI in TypeScript. Risparmia con tutte le leve **gratis, senza chiave e senza registrazione**, e non invia nulla a BiVelio a meno che tu non aggiunga una chiave per la dashboard cloud opzionale. Attive per impostazione predefinita: la cache esatta, la deduplicazione delle richieste identiche in volo, la risposta in locale ai semplici calcoli aritmetici e la serializzazione compatta dei dati strutturati che passi. Da attivare, con un'opzione ciascuna: la cascata di modelli, la compattazione degli output dei tool e il riordino del prefisso per la cache. Ogni richiesta restituisce un report che dice cosa è stato risparmiato e da dove viene il numero.

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

Due limiti, detti con onestà. Primo: il traffico che non si ripete mai risparmia circa lo 0% con la cache e la deduplicazione, ed è voluto. Secondo: il taglio predefinito che il layer applica ai risultati dei tool superati può costare più di quanto fa risparmiare nei lunghi loop di agenti, con un provider che mette in cache l'intero prompt: il changelog del progetto riporta +12,2% su un loop di 60 passi con `gpt-5`, misurato contro un provider fittizio con le versioni 1.2.3 e 1.2.4 e senza chiave. Per i lunghi loop di agenti, passa `savings: { elision: false }` nella richiesta e confronta.

## Dimostra ogni risparmio con i numeri di OpenAI

Un risparmio che non puoi verificare è una proiezione. Per ogni leva:

1. **Scegli il contatore su cui la leva deve agire.** Cache e deduplicazione agiscono sul numero di richieste. Il prompt caching agisce su `cached_tokens` e, su GPT-5.6 e modelli successivi, anche su `cache_write_tokens`. Batch agisce sul prezzo. La scelta del modello agisce sul prezzo per token. Il controllo dell'output agisce su `completion_tokens`.
2. **Leggi quel contatore da OpenAI.** La [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) restituisce richieste, token di input, di input in cache e di output per giorno, modello, progetto e chiave. L'endpoint Costs e la dashboard di utilizzo danno gli importi.
3. **Confronta cose confrontabili.** Stessa funzionalità, stessi giorni della settimana, prima e dopo, o meglio ancora due bracci dello stesso traffico nello stesso momento. Guarda prima i token e poi i dollari: i dollari si muovono anche con i prezzi.

Con il layer, ogni report riporta `cost.basis`: gli importi `measured` e `reference` vengono dal contatore di OpenAI stessa, gli importi `estimated` sono riportati a parte e mai mescolati. Il metodo completo: [verificare i risparmi sui costi LLM con la fattura del tuo provider](/it/guides/verify-llm-savings-against-provider-bill).

## Cosa dicono i numeri pubblicati

La [pagina del banco di prova](/it/benchmarks) del progetto misura entrambi i bracci di ogni test con il contatore di utilizzo del provider stesso. Su un carico pubblico costruito con domande GSM8K in cui il 30% delle richieste erano ripetizioni esatte, la riduzione aggregata su `gpt-4o-mini` è stata del **31,50%**, con un intervallo al 95% tra 25,7% e 36,7% (artefatti dell'SDK 0.4.31, settembre 2026; anche nel README). Su chat a due turni senza ripetizioni (MT-Bench), le differenze erano indistinguibili da zero o non attribuibili al layer, e la pagina lo dice. Il metodo, gli intervalli e ogni limite sono nell'[articolo di ricerca](/it/paper). Il codice è su [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
