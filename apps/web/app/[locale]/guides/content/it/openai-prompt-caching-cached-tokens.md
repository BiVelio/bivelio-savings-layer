OpenAI mette in cache automaticamente i prompt lunghi: quando l'inizio di una richiesta corrisponde a quello di una elaborata di recente, quei token di input sono fatturati con uno sconto e la risposta parte prima. Non devi attivare nulla. Proprio per questo è facile non accorgersi di quando smette di funzionare. Se `cached_tokens` torna `0` a ogni richiesta, questa guida elenca le cause nell'ordine in cui controllarle, mostra come tenere traccia della percentuale di hit per richiesta e come verificarla con i dati di utilizzo di OpenAI stessa.

## Dove leggerlo

Ogni risposta ti dice quanti token di input sono arrivati dalla cache:

- **Chat Completions:** `usage.prompt_tokens_details.cached_tokens`, su un totale di `usage.prompt_tokens`.
- **Responses API:** `usage.input_tokens_details.cached_tokens`, su un totale di `usage.input_tokens`.

I token in cache fanno parte del totale di input, non si sommano a esso. La [guida al prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) di OpenAI è il riferimento per le regole attuali. Ora distingue i modelli più recenti, che riportano e fatturano anche le scritture in cache e accettano opzioni di cache esplicite, da quelli precedenti, per cui scrivere in cache è gratis. Controllala per il modello che usi.

## Perché cached_tokens è 0

1. **Il prompt è troppo corto.** La cache parte da circa 1,024 token di prompt; la soglia esatta e il modo in cui viene arrotondato il conteggio in cache dipendono dal modello. Un system prompt da 600 token più una domanda breve non arriva mai in cache, e niente te lo segnala.
2. **L'inizio del prompt cambia.** La cache cerca la corrispondenza a partire dal primissimo token. Un timestamp, un id di richiesta o il nome dell'utente nel primo messaggio rende ogni richiesta unica fin dal primo token. Anche tool, immagini e formati di risposta fanno parte del prefisso, quindi tool elencati in un ordine diverso, o uno schema serializzato in modo diverso, rompono la corrispondenza.
3. **La voce è stata rimossa dalla cache.** Le voci vengono conservate per poco tempo dopo l'ultimo utilizzo, di solito qualche minuto quando il traffico è basso. Richieste a un'ora di distanza raramente trovano la cache.
4. **Il traffico è sparpagliato.** Le richieste vengono instradate in base a un hash dell'inizio del prompt. Volumi molto alti con lo stesso prefisso traboccano su altre macchine che non hanno la voce. Il parametro `prompt_cache_key` di OpenAI raggruppa le richieste che condividono un prefisso; usa una chiave per template di prompt, non per utente, e mantieni moderato il ritmo di richieste di ciascuna chiave, come spiega la guida.
5. **Non stai leggendo il campo.** Una richiesta Chat Completions in streaming non riporta alcun utilizzo a meno che tu non lo chieda con `stream_options: { include_usage: true }`. Molti wrapper scartano `prompt_tokens_details`. Alcuni provider compatibili con OpenAI e alcuni deployment Azure riportano la cache in modo diverso, o non la riportano affatto.

## Provalo in due minuti

Prima di fare il debug della tua applicazione, controlla che la cache funzioni in assoluto per il tuo account e il tuo modello. Invia due volte lo stesso prompt lungo, a pochi secondi di distanza, e leggi l'utilizzo di ciascuna risposta:

```bash
# A system prompt well above the threshold, sent twice. The second answer should report cached tokens.
BODY=$(python3 -c 'import json; print(json.dumps({"model": "gpt-4o-mini", "messages": [{"role": "system", "content": "You are a careful assistant for an invented shop. " * 200}, {"role": "user", "content": "Say OK."}]}))')
for i in 1 2; do
  curl -s https://api.openai.com/v1/chat/completions \
    -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" \
    -d "$BODY" | python3 -c 'import json, sys; u = json.load(sys.stdin)["usage"]; print(u["prompt_tokens"], u.get("prompt_tokens_details"))'
done
```

Se la seconda riga mostra token in cache, il lato provider funziona e il problema è nel modo in cui la tua applicazione costruisce i prompt: continua a leggere. Se non ne mostra, riprova qualche volta (la cache funziona secondo il principio del best effort, e la prima richiesta può finire su un'altra macchina), poi controlla la scheda del modello nella guida alla cache di OpenAI. Sostituisci il modello con quello che usi in produzione; un test su un modello diverso dimostra poco.

Questo test ti dà anche una base di riferimento per le sezioni successive. Dopo aver cambiato l'ordine del prompt o aggiunto una `prompt_cache_key`, ripeti lo stesso confronto su un template reale della tua applicazione e conserva i numeri. Una percentuale di hit misurata prima e dopo la modifica, su un template che i tuoi utenti usano davvero, è un risultato che puoi mostrare; «la cache dovrebbe aiutare» non lo è.

## Metti in fondo ciò che cambia

Nella maggior parte dei casi la soluzione è l'ordine. Tutto ciò che è uguale per ogni richiesta va per primo e resta identico byte per byte; tutto ciò che cambia va alla fine.

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

Poi tieni traccia della quota di ogni prompt servita dalla cache, così una regressione salta fuori il giorno stesso del rilascio:

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

Raggruppala per template di prompt. Un template la cui quota resta allo 0 % mentre i suoi prompt superano i 1,024 token ha qualcosa che cambia vicino all'inizio: registra due richieste e confrontale carattere per carattere, come mostrato nella [versione Claude di questa guida](/it/guides/claude-prompt-caching-not-working#trova-il-byte-che-rompe-la-cache).

## Come aiuta BV-SALA

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) è un layer di risparmio con licenza Apache-2.0 per TypeScript che avvolge qualsiasi endpoint compatibile con OpenAI, gratis e senza chiave. La cache di OpenAI è automatica, quindi il layer non marca nulla su OpenAI. Ecco cosa fa per la cache:

- **Chiede sempre l'utilizzo sugli stream,** così una richiesta in streaming viene misurata invece di perdere in silenzio il suo contatore.
- **Mostra lo sconto di OpenAI a ogni chiamata,** in `report.nativeSavings`, dal contatore di OpenAI stessa, e lo tiene separato dai propri risparmi: lo sconto è di OpenAI, non del layer.
- **Può spostare fuori dal prefisso le righe volatili.** Con l'opzione `savings: { cachePrefix: true }`, da attivare esplicitamente, le righe del system prompt che cambiano a ogni richiesta (timestamp ISO, UUID, tempi epoch) si spostano in fondo, così la parte stabile può andare in cache. Il modello legge le stesse righe in un ordine diverso: per questo la decisione è tua e l'opzione non è mai attiva per impostazione predefinita.

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

Le leve proprie del layer (saltare le ripetizioni esatte e le richieste identiche in volo) sono distinte dalla cache di OpenAI e sono spiegate in [deduplicare le richieste LLM identiche](/it/guides/deduplicate-llm-requests).

## Verifica con i numeri di OpenAI

1. **Per richiesta:** registra `cached_tokens` e il totale di input di ogni risposta, oppure `report.tokens.providerCachedInput` con il layer.
2. **Per giorno:** la [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) di OpenAI restituisce l'utilizzo delle completion in intervalli giornalieri che includono i token di input in cache, per modello e, se lo chiedi, per chiave API o progetto. Somma i tuoi log per la stessa chiave, lo stesso modello e lo stesso giorno UTC: i totali in cache e non in cache devono coincidere.
3. **In denaro:** valorizza separatamente l'input in cache e quello non in cache. Sui modelli che fatturano le scritture in cache, includi anche quelle, altrimenti la tua stima del risparmio sarà troppo alta.

Per il metodo completo, leggi [come verificare i risparmi LLM con la fattura del tuo provider](/it/guides/verify-llm-savings-against-provider-bill). Per le altre leve di una fattura OpenAI, vedi [come ridurre i costi delle API di OpenAI](/it/guides/reduce-openai-api-costs). I risultati misurati, compresi i casi in cui il layer non fa risparmiare nulla, sono sulla [pagina del banco di prova](/it/benchmarks), e il codice è su [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
