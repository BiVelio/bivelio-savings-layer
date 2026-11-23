Ogni strumento per i costi degli LLM mostra un numero di risparmio. Pochi mostrano come verificarlo, ed è proprio nella verifica che la maggior parte delle promesse crolla: la dashboard mostra un grande risparmio e la fattura si muove appena. Questa guida dà un metodo che puoi applicare con qualsiasi strumento, o senza: cosa registrare, come riconciliarlo con i dati di utilizzo del provider, come distinguere un risparmio reale da una stima e come assicurarti che il risparmio venga dalla modifica che hai fatto. Alla fine vedrai come l'SDK open source BV-SALA etichetta ogni importo per rendere possibile questa verifica.

## Perché i numeri di risparmio e le fatture non tornano

Lo scostamento viene quasi sempre da una di queste cause:

- **Prezzo di listino contro il tuo prezzo.** Gli strumenti valorizzano i token ai prezzi di listino pubblici. La tua fattura può includere sconti, contratti di impegno di spesa, tariffe regionali o di residenza dei dati, livelli di priorità e tasse.
- **Stime presentate come misure.** Se uno strumento ha tolto 2000 token da un prompt, il provider non li ha mai contati. La cifra «risparmiata» è il conteggio dello strumento stesso, fatto con un tokenizer che potrebbe non essere quello del provider.
- **Lo sconto del provider spacciato per quello dello strumento.** Il prompt caching di OpenAI, Anthropic, DeepSeek o Gemini è fatturato dal provider a una tariffa più bassa. Uno strumento che conta quello sconto come risparmio proprio gonfia il suo numero.
- **Traffico che lo strumento non ha mai visto.** Chiamate da un altro servizio, lo script di un collega, le richieste secondarie di un agente di codice o un job batch compaiono tutte in fattura e non nello strumento.
- **Utilizzo mancante.** Una richiesta in streaming senza l'evento finale di utilizzo non ha alcun conteggio di token. Contarla in silenzio come zero fa sembrare più economico tutto ciò che viene dopo.
- **Il tempo.** I provider raggruppano l'utilizzo per giorno UTC, e una parte dell'utilizzo compare in ritardo.

## Il metodo, passo per passo

### 1. Registra i contatori del provider stesso per ogni richiesta

Non la tua stima: il blocco `usage` restituito dal provider. Input, input in cache (e scritture in cache, dove esistono), output, token di ragionamento, l'id del modello riportato dal provider, la chiave API o il progetto e il timestamp UTC. Segna una richiesta il cui utilizzo non è arrivato come **non misurata**, mai come zero.

### 2. Riconcilia i token prima dei dollari

Esporta l'utilizzo giornaliero del provider per le stesse chiavi e gli stessi giorni: la [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) di OpenAI, la [Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) di Anthropic, o le pagine di utilizzo delle console di DeepSeek e Model Studio. Poi confronta voce per voce:

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

Se i token coincidono, la tua registrazione è completa e puoi fidarti del resto dell'analisi. Se il provider ne mostra di più, trova il traffico che non stai registrando prima di andare avanti.

### 3. Poi valorizzalo, con un listino prezzi datato

Moltiplica ogni voce per la sua tariffa, conserva la data in cui hai copiato le tariffe e confronta con il report dei costi del provider. Una differenza costante di qualche punto percentuale è di solito uno sconto o una tariffa regionale, ed è la stessa con e senza la tua ottimizzazione, quindi non cambia il risparmio.

### 4. Tieni separati tre tipi di numeri

- **Misurato:** letto dal contatore del provider per una chiamata che è stata eseguita.
- **Misurato per riferimento:** una chiamata che non è avvenuta (un hit di cache, una richiesta deduplicata), valorizzata con il contatore del provider per la chiamata identica che invece è stata eseguita. È la prova migliore disponibile per una chiamata che non è mai avvenuta.
- **Stimato:** tutto ciò che il provider non ha mai contato, come i token che uno strumento ha tolto da un prompt.

Somma ogni tipo per conto suo. Non aggiungere mai importi stimati a quelli misurati, e non fare mai la media delle percentuali tra le richieste: somma il denaro, poi dividi.

### 5. Separa lo sconto del provider dal tuo

I token di input in cache costano meno grazie al provider. Se non hai cambiato nulla e la tua percentuale di hit era già alta, quello sconto non è un risparmio del tuo progetto. Valorizza i token in cache alla tariffa della cache su entrambi i lati del confronto; quello che resta è tuo.

## È stata la modifica a produrre il risparmio?

Una fattura che scende dopo un deploy può anche essere solo una settimana tranquilla. Per attribuire un risparmio:

- **Esegui due bracci in contemporanea.** Invia le stesse richieste con e senza la modifica, nello stesso momento, con la stessa chiave, e confronta i contatori del provider per entrambi. Ripartire le richieste a caso tra i bracci ne è la versione pulita.
- **Riporta un intervallo, non un valore puntuale.** Ricampiona conversazioni o giorni interi e di' «tra X e Y %». Un intervallo che attraversa lo zero significa che non puoi distinguere la differenza dal rumore, ed è un risultato legittimo.
- **Controlla la qualità nella stessa esecuzione.** Una risposta più economica ma sbagliata non è un risparmio. Misura l'accuratezza, o una verifica specifica del compito, in entrambi i bracci.

## Come BV-SALA rende possibile questa verifica

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) è un layer di risparmio con licenza Apache-2.0, gratis e senza chiave. Ogni richiesta restituisce un `SavingsReport` pensato proprio per questo metodo:

- `cost.basis` vale `measured`, `reference`, `estimated` o `unmeasured`, secondo le definizioni viste sopra. Una ripetizione è valorizzata per riferimento solo quando la chiamata eseguita è andata direttamente all'API di OpenAI, di Anthropic o di Gemini di Google; altrove resta `estimated`.
- Il risparmio è tenuto in quattro registri separati che non vengono mai sommati in un'unica cifra: `avoided_calls`, `eliminated_tokens`, `compressed_tokens` e `provider_cached_tokens`.
- Lo sconto della cache del provider è riportato a parte, in `report.nativeSavings`, e non viene mai contato come risparmio del layer.
- Uno stream che termina senza il suo utilizzo è `unmeasured`, mai valorizzato a zero.

Sommare i report per base richiede poche righe:

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

Da Python, il client del pacchetto legge gli stessi report dal gateway locale e mantiene la stessa separazione:

```python
# pip install bivelio-savings-layer
import bvsala

gw = bvsala.Gateway("http://127.0.0.1:8403")
# ... send requests with gw.wrap(client) and read each one with gw.report(response) ...
t = gw.totals()
print(t.requests, t.metered, t.not_metered, t.actual_cost_usd)
print(t.net_savings_usd_by_basis)  # one amount per basis, never added together
```

Poi applica il passo 2 qui sopra a questi totali: la spesa `measured` del layer deve corrispondere all'utilizzo del provider per la stessa chiave e lo stesso giorno, esattamente in token e, in dollari, a meno dei tuoi sconti. I report valorizzano a prezzo di listino; non sono una fattura.

## Lo stesso metodo, applicato in pubblico

Il progetto pubblica le sue esecuzioni A/B sulla [pagina del banco di prova](/it/benchmarks): due bracci sulle stesse richieste, uno diretto al provider e uno attraverso il layer, entrambi misurati con il contatore di utilizzo del provider stesso, con intervalli al 95% e la data e la versione di ogni esecuzione. I risultati che non hanno fatto risparmiare nulla, o che sono costati di più, sono sulla stessa pagina. Il metodo completo, lo stimatore e i suoi limiti sono nell'[articolo di ricerca](/it/paper).

Per i dettagli specifici di ogni provider, vedi [perché cached_tokens di OpenAI è 0](/it/guides/openai-prompt-caching-cached-tokens), [perché il prompt caching di Claude non funziona](/it/guides/claude-prompt-caching-not-working) e [misurare il costo di Claude Code richiesta per richiesta](/it/guides/claude-code-cost-per-request). Il codice e i report grezzi sono su [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
