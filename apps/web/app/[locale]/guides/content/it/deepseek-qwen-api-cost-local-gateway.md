DeepSeek e Qwen costano poco a token, ed è facile smettere di tenere d'occhio la fattura. Entrambi i provider mettono in cache i prompt dal loro lato, e l'input servito dalla cache (hit) è fatturato molto meno di quello che va in miss. Quindi il costo reale del tuo traffico dipende da un numero che la maggior parte delle dashboard nasconde: quanti token di input vengono serviti dalla cache in ogni richiesta. Questa guida spiega come i due provider fatturano e gestiscono la cache, come calcolare il costo di una richiesta dai suoi campi di utilizzo e come vederlo richiesta per richiesta con un gateway locale gratuito.

## Come DeepSeek fattura una richiesta

DeepSeek divide l'input di ogni richiesta in due: i token serviti dalla sua cache di contesto (hit) e quelli che vanno in miss, ciascuno con il suo prezzo, più i token di output. Il suo [context caching](https://api-docs.deepseek.com/guides/kv_cache) è attivo per impostazione predefinita su ogni account. Perché ci sia un hit, l'inizio della richiesta deve corrispondere esattamente a quello di una precedente; la cache funziona secondo il principio del best effort, e le voci inutilizzate vengono cancellate dopo alcune ore o alcuni giorni. La risposta ti dice cosa è successo:

- `usage.prompt_cache_hit_tokens`: token di input serviti dalla cache.
- `usage.prompt_cache_miss_tokens`: token di input elaborati per intero.
- `usage.prompt_tokens_details.cached_tokens`: lo stesso conteggio di hit, nel campo che leggono gli strumenti compatibili con OpenAI.

La [pagina dei prezzi](https://api-docs.deepseek.com/quick_start/pricing) di DeepSeek elenca per ogni modello i prezzi di hit, miss e output, e una fascia oraria di bassa domanda a prezzo ridotto. I prezzi cambiano; copiali insieme alla data in cui li hai letti.

## Come Qwen fattura una richiesta

I modelli Qwen su Alibaba Cloud Model Studio hanno due tipi di [cache di contesto](https://www.alibabacloud.com/help/en/model-studio/context-cache). La cache implicita è automatica per i prompt oltre una lunghezza minima, e i suoi hit sono fatturati con uno sconto. La cache esplicita funziona come quella di Anthropic: marchi un blocco con `cache_control`, la voce dura qualche minuto, e scriverla costa un po' più dell'input normale mentre leggerla costa molto meno. Nell'API compatibile con OpenAI, il conteggio degli hit arriva in `usage.prompt_tokens_details.cached_tokens`. Model Studio ha endpoint regionali, quindi controlla a quale appartiene la tua chiave.

## Fai funzionare la cache, con l'uno o con l'altro

Le regole sono le stesse di qualsiasi cache di prefisso:

1. Metti per primo ciò che non cambia mai: il system prompt, le definizioni dei tool, i testi di riferimento lunghi, gli esempi few-shot.
2. Mantienilo identico byte per byte tra una richiesta e l'altra: niente timestamp, id di richiesta o nomi utente al suo interno, e definizioni dei tool in un ordine fisso.
3. Metti per ultimo ciò che cambia: la domanda dell'utente, l'ultimo risultato di un tool.
4. Per gli agenti, aggiungi in coda alla cronologia invece di riscriverla. Modificare un vecchio messaggio a metà invalida tutto ciò che segue.

## Calcola il costo di una richiesta

Non ti serve alcuno strumento per calcolare il costo di una richiesta. Leggi il blocco di utilizzo e moltiplica ogni voce per il suo prezzo:

```python
def request_cost(usage: dict, price_miss: float, price_hit: float, price_out: float) -> float:
    """USD cost of one chat completion. Prices are per million tokens, from the provider's pricing page."""
    details = usage.get("prompt_tokens_details") or {}
    hit = usage.get("prompt_cache_hit_tokens", details.get("cached_tokens", 0)) or 0
    miss = usage["prompt_tokens"] - hit
    return (miss * price_miss + hit * price_hit + usage["completion_tokens"] * price_out) / 1_000_000
```

Registra quel numero insieme al modello, alla quota di hit (`hit / prompt_tokens`) e a un timestamp per ogni richiesta, e potrai rispondere alle domande che contano: quale funzionalità costa di più, se la percentuale di hit della cache è calata dopo un deploy e quanta parte del tuo traffico cade nella fascia di bassa domanda.

## Vedi ogni richiesta con un gateway locale

Per non dover toccare ogni punto del codice che fa una chiamata, metti un gateway davanti al provider. [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) ne include uno nel suo pacchetto npm: Apache-2.0, locale, **senza chiave e senza registrazione**, e a BiVelio non viene inviato nulla. Avvia un gateway per provider, ciascuno sulla sua porta:

```bash
# DeepSeek
npx @bivelio/savings-layer gateway --upstream deepseek --port 8403

# Qwen on Model Studio's international endpoint (`--upstream qwen` is the Beijing one)
npx @bivelio/savings-layer gateway --upstream https://dashscope-intl.aliyuncs.com --port 8404
```

Il gateway inoltra al provider il percorso inviato dal tuo client, quindi la tua base URL è quella del provider con il gateway come host:

| Provider | `--upstream` | Base URL per il tuo client OpenAI |
| --- | --- | --- |
| DeepSeek | `deepseek` | `http://127.0.0.1:8403` |
| Qwen (Pechino) | `qwen` | `http://127.0.0.1:<port>/compatible-mode/v1` |
| Qwen (internazionale) | `https://dashscope-intl.aliyuncs.com` | `http://127.0.0.1:8404/compatible-mode/v1` |
| GLM | `glm` | `http://127.0.0.1:<port>/api/paas/v4` |

`npx @bivelio/savings-layer --help` elenca gli altri upstream (Moonshot, MiniMax, OpenRouter, Gemini, Ollama, vLLM, LM Studio).

In Python, il piccolo client del pacchetto sistema la base URL al posto tuo: crea il solito client OpenAI per il provider, e `wrap()` ne restituisce una copia che passa dal gateway, mantenendo il percorso del provider.

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

Lo stesso funziona per Qwen con l'altro gateway e `OpenAI(base_url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1", ...)`. Se è impostata una variabile di proxy HTTP, aggiungi `NO_PROXY=127.0.0.1,localhost` prima di creare il client, altrimenti le richieste al gateway locale, chiave del provider compresa, passano dal proxy; la versione 1.2.5 avvisa quando succederebbe. Se nessun gateway è in esecuzione, `wrap()` solleva `GatewayUnavailable` invece di chiamare direttamente il provider, e dice come avviarne uno, senza chiave.

Funziona anche qualsiasi altro linguaggio o strumento: punta la sua base URL OpenAI al gateway, e ogni richiesta diventa una riga nel log del gateway, con il modello, il costo a prezzo di listino e l'input suddiviso tra token a prezzo pieno e letture dalla cache (`cache↓`).

Un'eccezione conta per gli strumenti di chat e gli agenti: una richiesta **in streaming** che non chiede l'utilizzo (`stream_options: {"include_usage": true}`) non ne riceve dal provider, quindi la versione 1.2.5 la registra come `not metered: the request did not ask for usage`. Chiedi l'utilizzo nel tuo client, oppure avvia il gateway con `BVSALA_GATEWAY_USAGE_INJECT=1`, che aggiunge quell'opzione agli stream che non ce l'hanno. L'ultimo chunk di quegli stream ha allora un elenco `choices` vuoto, cosa che il codice che legge `choices[0]` senza controlli non si aspetta.

## Agenti di codice su DeepSeek o Qwen

DeepSeek pubblica anche un endpoint in formato Anthropic e documenta come usarlo con Claude Code. Con `--upstream deepseek`, il gateway invia da solo le richieste in formato Anthropic a quell'endpoint:

```bash
npx @bivelio/savings-layer gateway --upstream deepseek --port 8402
ANTHROPIC_BASE_URL=http://127.0.0.1:8402 ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY" ANTHROPIC_MODEL=deepseek-flash claude
```

Su questo percorso il gateway misura ma non risparmia nulla: l'endpoint in formato Anthropic di DeepSeek ignora `cache_control` e non riporta scritture in cache ([la sua guida](https://api-docs.deepseek.com/guides/anthropic_api)), quindi la leva predefinita non ha nulla da abbassare. Usare un modello diverso da Claude dietro Claude Code è un'integrazione di DeepSeek, non una configurazione supportata da Anthropic, e la qualità del modello per il tuo lavoro sta a te valutarla.

**Qwen Code con i modelli Qwen** richiede un percorso diverso: nella versione 1.2.5, `npx @bivelio/savings-layer qwen` esige che Qwen Code usi il tipo di autenticazione Anthropic e inoltra all'API di Anthropic, quindi misura solo i modelli Claude usati con una chiave Anthropic, e rifiuta una base URL DashScope in formato Anthropic. Per i modelli Qwen, usa la modalità compatibile con OpenAI di Qwen Code, che [la sua documentazione](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/) configura con `OPENAI_API_KEY`, `OPENAI_BASE_URL` e `OPENAI_MODEL`, e punta quella base URL a un gateway. Imposta `DASHSCOPE_PROXY_BASE_URL` esattamente sullo stesso URL:

```bash
npx @bivelio/savings-layer gateway --upstream https://dashscope-intl.aliyuncs.com --port 8404

GW=http://127.0.0.1:8404/compatible-mode/v1
OPENAI_BASE_URL="$GW" DASHSCOPE_PROXY_BASE_URL="$GW" OPENAI_API_KEY="$DASHSCOPE_API_KEY" OPENAI_MODEL=qwen-plus qwen
```

La seconda variabile conta per la fattura. Qwen Code decide in base all'host della base URL se sta parlando con DashScope, e `127.0.0.1` non è un host DashScope. Senza la variabile ripiega sul suo provider OpenAI generico, che non invia marcatori di cache esplicita (`cache_control` e l'header `X-DashScope-CacheControl`). Le tue richieste ricadono allora sulla cache implicita di Model Studio, dove gli hit costano tipicamente il 20% del prezzo di input e funzionano secondo il principio del best effort, invece del 10% della cache esplicita ([cache di contesto](https://www.alibabacloud.com/help/en/model-studio/context-cache)). Qwen Code tratta come DashScope una base URL che corrisponde esattamente a `DASHSCOPE_PROXY_BASE_URL`, e mantiene i marcatori ([il suo provider DashScope](https://github.com/QwenLM/qwen-code/blob/8fab857da5/packages/core/src/core/openaiContentGenerator/provider/dashscope.ts), consultato il 23 novembre 2026).

Abbiamo verificato il lato gateway di questo percorso con la versione 1.2.5 (entrambi i marcatori passano senza modifiche), non Qwen Code in sé, quindi leggi il log del gateway: una riga con un costo per richiesta. Una riga `not metered` dice il perché: di solito uno stream che non chiede l'utilizzo (riavvia il gateway con `BVSALA_GATEWAY_USAGE_INJECT=1`), oppure un modello senza una voce nel catalogo 1.2.5, che include `qwen-plus`, `qwen-flash`, `qwen3.7-flash`, `qwen3.8-flash` e `qwen3.8-max` ma non, per esempio, `qwen3-coder-plus`.

Due scarti di prezzo nella 1.2.5 dipendono dalla seconda variabile. **Con `DASHSCOPE_PROXY_BASE_URL` impostata**, come sopra, Model Studio fattura ogni scrittura nella cache esplicita al 125% del prezzo di input e la riporta in `usage.prompt_tokens_details.cache_creation_input_tokens`. Il gateway 1.2.5 non legge quel campo: registra quei token come input normale, con `cache↑0`, all'80% di quanto costano. Il suo prezzo di hit per `qwen-plus` è il 10% della cache esplicita, e corrisponde. **Senza la variabile** non ci sono scritture esplicite, ma gli hit sono impliciti, fatturati circa il 20%, e il gateway li registra allo stesso 10%, circa la metà del loro costo.

## Cosa misura il gateway, e cosa no

- **L'importo in dollari viene da un catalogo, non dai prezzi orari di DeepSeek.** La versione 1.2.5 ha voci per `deepseek-flash` e `deepseek-v4-pro`. Per i miss e l'output usano il prezzo di punta di DeepSeek, quindi nelle ore di bassa domanda quelle voci mostrano il doppio di quanto fattura DeepSeek. Per gli hit, entrambe le voci usano 0,003 USD per milione di token, che è il prezzo di hit di DeepSeek in fascia di bassa domanda per `deepseek-flash` (il suo prezzo di hit di punta è il doppio) e sta sotto entrambi i prezzi di hit che DeepSeek pubblica per `deepseek-v4-pro` ([pagina dei prezzi](https://api-docs.deepseek.com/quick_start/pricing), consultata il 23 novembre 2026). A seconda dell'ora e di quanta parte del tuo input viene servita dalla cache, il totale del gateway può risultare sopra o sotto la fattura. I conteggi dei token sono esatti; confronta prima quelli. Lo storico alias `deepseek-chat` non ha una voce: viene inoltrato, e il log dice che non è stato misurato.
- **Non modifica queste richieste.** Sul traffico compatibile con OpenAI il gateway misura e inoltra (l'unica eccezione è l'iniezione opzionale dell'utilizzo vista sopra); le sue leve di risparmio sono per il traffico in formato Anthropic. Il risparmio su DeepSeek e Qwen viene dalle loro cache, ed è per questo che il conteggio degli hit è il numero da tenere d'occhio.

## Se chiami DeepSeek o Qwen da TypeScript

L'SDK BV-SALA dialoga con qualsiasi endpoint compatibile con OpenAI e salta le ripetizioni esatte e le richieste identiche in volo, gratis e senza chiave ([come funziona](/it/guides/deduplicate-llm-requests)). Su DeepSeek quelle chiamate evitate sono riportate come `estimated`, non `reference`: la versione 1.2.5 valorizza una ripetizione per riferimento solo quando la chiamata eseguita è andata all'API di OpenAI, di Anthropic o di Google. Una cautela per i loop di agenti: il taglio predefinito dei risultati dei tool superati riscrive la parte centrale della cronologia, e con un provider che mette da solo in cache l'intero prompt questo può costare più di quanto fa risparmiare. Il changelog del progetto riporta +166% su un loop di agenti di 60 passi su DeepSeek, misurato contro un provider fittizio con le versioni 1.2.3 e 1.2.4 e senza chiave; la 1.2.5 taglia allo stesso modo. Per i loop di agenti, disattivalo richiesta per richiesta:

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

## Confronta i numeri con il tuo provider

Una volta al giorno, confronta i totali per modello del gateway (input, hit di cache, output) con la pagina di utilizzo della piattaforma DeepSeek o di Model Studio per la stessa chiave. I conteggi totali dei token devono coincidere, con un'eccezione nella suddivisione: su Qwen, la versione 1.2.5 conta le scritture nella cache esplicita come input normale, non come scritture in cache. Gli importi in dollari possono differire, in un senso o nell'altro: il catalogo ignora i prezzi orari di DeepSeek, su Qwen valorizza le scritture nella cache esplicita come input normale e gli hit impliciti alla tariffa esplicita, e anche i prezzi regionali e gli sconti cambiano gli importi. Per un metodo passo per passo, vedi [come verificare i risparmi LLM con la fattura del tuo provider](/it/guides/verify-llm-savings-against-provider-bill). Il codice del gateway e le sue guide per ogni terminale sono su [GitHub](https://github.com/BiVelio/bivelio-savings-layer), e ciò che il progetto ha misurato, e ciò che non ha misurato, è sulla [pagina del banco di prova](/it/benchmarks).
