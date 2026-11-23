Ogni API di LLM fattura a chiamata. Se la tua app invia due volte la stessa richiesta, paghi due volte, anche se la seconda risposta non aggiunge nulla. Questa guida mostra due tecniche che lo evitano: una **cache delle risposte a corrispondenza esatta** per le ripetizioni che arrivano più tardi, e l'**unione delle richieste in volo** per le richieste identiche che arrivano nello stesso istante. Entrambe funzionano in qualsiasi linguaggio e con qualsiasi provider. Alla fine vedrai come l'SDK open source BV-SALA le applica entrambe per impostazione predefinita, e come verificare il risparmio con i numeri di utilizzo del tuo provider stesso.

## Da dove arrivano le richieste duplicate

I duplicati sono più comuni di quanto sembri, perché raramente vengono da un unico punto evidente:

- **Retry e doppi clic.** Un utente preme due volte «Genera», oppure una libreria client ritenta dopo un timeout a cui il provider aveva in realtà già risposto.
- **Job batch e cron.** Un job notturno classifica le stesse descrizioni di prodotto, voci di FAQ o macro di supporto che aveva già classificato il giorno prima.
- **Fan-out.** Due worker, due schede del browser o un effect di React che in sviluppo gira due volte inviano lo stesso prompt a pochi millisecondi di distanza.
- **Agenti e pipeline.** Una pipeline a più passi pone la stessa sotto-domanda in più rami.
- **Test ed eval.** La CI esegue le stesse fixture contro l'API reale a ogni push.

Il primo e l'ultimo gruppo sono ripetizioni nel tempo; il fan-out è concorrenza. Richiedono soluzioni diverse, ed è per questo che la guida le copre entrambe.

## Misura prima la tua percentuale di duplicati

Prima di costruire qualsiasi cosa, scopri quanta parte del tuo traffico si ripete. Calcola l'hash di ogni corpo di richiesta per un giorno e conta. La chiave deve essere **canonica**: la stessa richiesta deve dare gli stessi byte, qualunque sia l'ordine delle chiavi JSON.

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

Se la percentuale è vicina a zero, una cache delle risposte non ti farà risparmiare molto, ed è meglio guardare al [prompt caching](/it/guides/claude-prompt-caching-not-working) o alla [scelta del modello](/it/guides/reduce-openai-api-costs). Se una quota significativa delle tue richieste si ripete, continua a leggere.

## Costruisci una chiave di cache davvero sicura

Una cache esatta vale quanto la sua chiave. La regola è semplice: **tutto ciò che può cambiare la risposta entra nella chiave, e nulla viene normalizzato.**

- L'id del modello, l'elenco completo dei messaggi, il system prompt, le definizioni dei tool, il formato di risposta o lo schema JSON, e ogni parametro di campionamento (`temperature`, `top_p`, `max_tokens`, `seed`, sforzo di ragionamento).
- Un **ambito** quando il prompt contiene dati dell'utente. Due utenti che chiedono «qual è il mio saldo?» inviano lo stesso testo e hanno bisogno di risposte diverse. Metti nella chiave l'id dell'utente o del tenant, oppure non mettere in cache quelle richieste.
- Nessuna normalizzazione «furba». Convertire in minuscolo, togliere gli spazi o eliminare la punteggiatura per ottenere più hit trasforma una cache esatta in una approssimativa, e una cache approssimativa può restituire la risposta a un'altra domanda.

## Cosa non va mai servito da una cache

Alcune richieste si ripetono ma devono comunque arrivare al modello ogni volta:

- **Risposte che devono cambiare**: «scegli un nome a caso», «genera una password», «che ore sono», «il prezzo di oggi». Qui una risposta in cache è un bug, non un risparmio.
- **Tool con effetti collaterali.** Se la risposta chiede di chiamare `send_email` o `create_order`, riprodurla salta l'azione. Metti in cache solo le richieste i cui tool sono di sola lettura, o che non ne hanno.
- **Output campionati che gli utenti si aspettano variabili.** Con una `temperature` alta, una risposta in cache è solo un campione, servito per sempre.
- **Errori, risposte vuote, rifiuti e risposte troncate.** Non scriverli mai in cache; lascia che la richiesta successiva riprovi.
- **Temi sensibili.** Un bot di assistenza non dovrebbe mettere in cache risposte su autolesionismo o emergenze mediche; invia quelle richieste al modello ogni volta.

## Unisci le richieste identiche in volo

Una cache aiuta solo dopo che è arrivata la prima risposta. Se dieci richieste identiche partono negli stessi 300 ms, tutte e dieci mancano la cache. La soluzione è un piccolo pattern spesso chiamato *singleflight*: il primo chiamante esegue la chiamata, gli altri aspettano la stessa promise.

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

In produzione contano tre dettagli. Gli errori devono arrivare a ogni chiamante in attesa (il pattern qui sopra lo fa). Se un chiamante annulla, la chiamata condivisa non deve annullarsi per gli altri. E lo streaming è più complicato: uno stream già iniziato non si può semplicemente passare a un secondo chiamante, quindi la maggior parte delle implementazioni lascia che una richiesta normale si agganci a una chiamata in volo, ma non lascia agganciare nulla a uno stream.

## Come lo fa BV-SALA

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) è un layer di risparmio con licenza Apache-2.0 per TypeScript. Il suo SDK avvolge il tuo provider e, **senza chiave e senza registrazione**, attiva per impostazione predefinita entrambe le tecniche: una cache esatta e la deduplicazione delle richieste in volo. Applica anche le regole «da non mettere mai in cache» viste sopra: le richieste che chiedono dati aggiornati o casualità, le formulazioni personali senza sessione, i temi sensibili, i rifiuti e gli errori restano fuori dalla cache.

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

Una richiesta che sembra personale («il mio ordine», «la nostra fattura») non va in cache finché non dici di chi è. Passa un ambito e la cache torna a funzionare, separatamente per ogni sessione:

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

La cache predefinita vive nella memoria di un solo processo. Per condividerla tra più server o istanze serverless, passa tramite l'opzione `exactCache` uno store gestito da te. Servono tre metodi, quindi va bene qualsiasi store chiave-valore:

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

Le risposte in cache restano nella tua infrastruttura. Quando usi il layer senza chiave, a BiVelio non viene inviato nulla.

## Verifica il risparmio con i numeri del tuo provider

Un risparmio da cache è facile da verificare, perché è un conteggio di chiamate che non sono avvenute.

1. **Conta le chiamate da entrambi i lati.** Per un giorno, conta le chiamate `generate()` fatte dalla tua app e confrontale con il numero di richieste che il provider mostra per la stessa chiave API e lo stesso modello (la pagina di utilizzo della console di OpenAI o di Anthropic, o le loro API di utilizzo). La differenza deve essere uguale alla somma di `report.calls.avoidedLlm`.
2. **Guarda come è stata valorizzata ogni ripetizione.** `report.cost.basis` dice da dove viene il numero. Una ripetizione è `reference` quando la chiamata identica che è stata eseguita è andata direttamente all'API di OpenAI, di Anthropic o di Gemini di Google (`api.openai.com`, `api.anthropic.com` o `generativelanguage.googleapis.com`): la sua base di riferimento è il contatore di utilizzo di quella chiamata, valorizzato in modo prudente alla tariffa dell'input in cache. Resta `estimated` quando la chiamata eseguita è andata altrove, compresa l'API di un altro provider come quella di DeepSeek, un proxy, Azure o un gateway, perché solo su quelle tre API è noto che i prezzi di listino del layer corrispondono alla fattura. Il denaro stimato è sempre riportato a parte.
3. **Confronta la spesa, non solo le chiamate.** Somma `report.cost.netSavingsUsd` per base. Non sommare mai importi misurati e stimati, e non fare mai la media di `netSavingsRatio` tra le richieste.

Se vuoi un test più pulito, esegui lo stesso carico due volte, una con le leve disattivate per quell'esecuzione (`savings: { exactCache: false, singleflight: false }` su ogni richiesta) e una con le impostazioni predefinite, e confronta le due fatture.

## Cosa dicono i numeri pubblici

Il repository pubblica le sue esecuzioni di benchmark. Su un carico pubblico costruito con domande GSM8K in cui il 30 % delle richieste erano ripetizioni esatte, la riduzione aggregata misurata è stata del **31.50 %** per `gpt-4o-mini`, con un intervallo al 95 % tra 25.7 % e 36.7 % (artefatti dell'SDK 0.4.31 di settembre 2026; fonte: la [pagina del banco di prova](/it/benchmarks#savings) e il README). Sul traffico che non si ripete mai il risparmio è circa dello 0 %, e la [pagina del banco di prova](/it/benchmarks#no-savings) mostra anche questi risultati piatti. Registra inoltre l'errore che per una cache pesa di più: **0 su 198** varianti di domanda sono state servite con la risposta di un'altra domanda ([garanzie](/it/benchmarks#guarantees)).

Il tuo risparmio dipende dalla tua percentuale di duplicati, quindi misurala prima con lo snippet all'inizio di questa pagina. Il codice, l'articolo di ricerca e i report grezzi sono su [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
