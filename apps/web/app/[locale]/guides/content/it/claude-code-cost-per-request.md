«Quanto costa Claude Code?» ha due risposte oneste. Con un abbonamento Claude il prezzo è quello del piano, e il costo per token conta solo quando ne superi i limiti. Con una chiave API o un provider cloud paghi a token, e il costo di una sessione dipende da quante richieste invia Claude Code, da quanto è grande ciascuna e da quanta parte viene letta dalla cache dei prompt. Questa guida mostra cosa pubblica Anthropic, quali strumenti integrati danno i totali e come vedere il costo di ogni singola richiesta sulla tua macchina, gratis, per trovare i turni che rendono cara una sessione.

## Quanto costa secondo Anthropic

La [pagina sui costi di Claude Code](https://code.claude.com/docs/en/costs) di Anthropic riporta medie ricavate da installazioni aziendali: circa $13 per sviluppatore per giorno di attività e da $150 a $250 per sviluppatore al mese, con il 90 % degli utenti sotto i $30 per giorno di attività. Sono medie su molti team. Il tuo numero dipende dal modello che scegli, dalle dimensioni del repository e da come lavori, ed è per questo che il resto della guida parla di come misurarlo.

## Gli strumenti integrati, e cosa non mostrano

- **`/usage` in Claude Code.** Il blocco Session mostra un costo *stimato* a prezzo di listino, con i token per modello suddivisi in input, output, letture e scritture di cache. Le versioni recenti aggiungono una riga sulla cache dei prompt con la percentuale di hit e il numero di miss. È un totale di sessione, calcolato in locale.
- **La Claude Console.** Per le chiavi API, le pagine Cost e Usage mostrano quanto è stato fatturato, per giorno, workspace e modello. Questo è il numero con cui riconciliare.
- **L'esportazione OpenTelemetry.** Claude Code può inviare metriche di token e di costo al tuo stack di osservabilità, per utente e per sessione ([documentazione sul monitoraggio](https://code.claude.com/docs/en/monitoring-usage)).

Quello che nessuno di questi rende facile è la **vista per richiesta**: quale turno è stato quello caro, e perché. Una sessione è fatta di decine o centinaia di chiamate API, e quelle costose hanno cause riconoscibili:

- **Una cache fredda.** Il primo turno dopo una pausa più lunga della durata della cache rilegge tutta la conversazione a prezzo pieno, e la riscrive.
- **Un cambio di modello.** Ogni modello ha la sua cache, quindi cambiare modello a metà sessione rielabora tutto.
- **Risultati dei tool enormi.** Un log dei test o un file grande letto una volta resta nel contesto di tutti i turni successivi.
- **Troppe definizioni di tool.** I server MCP possono aggiungere molti kilobyte di definizioni a ogni richiesta.
- **La compattazione.** Riassumere una lunga conversazione è di per sé una richiesta grande.

## Misura ogni richiesta con un gateway locale

Un gateway è un piccolo proxy tra Claude Code e l'API che legge i contatori di utilizzo di ogni risposta. Claude Code lo supporta ufficialmente tramite `ANTHROPIC_BASE_URL`. [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) ne include uno nel suo pacchetto npm: Apache-2.0, **senza chiave, senza registrazione**, e a BiVelio non viene inviato nulla. Richiede Node.js 20 o successivo.

Il modo con un solo comando:

```bash
# Starts a local gateway on a free port, runs Claude Code through it, and stops it on exit.
npx @bivelio/savings-layer claude
```

Il wrapper tiene silenzioso il log per richiesta, così non si sovrappone all'interfaccia di Claude Code. Quando esci, stampa quante richieste ha misurato, quali ha inoltrato senza misurarle e perché. Per vedere ogni richiesta mentre avviene, puoi chiedere il log su stderr:

```bash
BVSALA_GATEWAY_LOG=1 npx @bivelio/savings-layer claude
```

oppure avviare il gateway in un terminale a parte, su una porta fissa:

```bash
# Terminal 1: the gateway (Anthropic is the default upstream, port 8402)
npx @bivelio/savings-layer gateway

# Terminal 2: Claude Code, pointed at it (no /v1 at the end).
# ENABLE_TOOL_SEARCH=true only matters before Claude Code v2.1.304 (see below).
ENABLE_TOOL_SEARCH=true ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude
```

Ogni richiesta diventa una riga. Queste due vengono da un test locale contro un server sostitutivo, con traffico inventato, quindi la forma è reale e i numeri non sono i tuoi:

```text
[gateway] POST /v1/messages  · claude-sonnet-5 · $0.007700 (in 40, cache↑3000 cache↓0, out 12)
[gateway] POST /v1/messages  · claude-sonnet-5 · $0.000800 (in 40, cache↑0 cache↓3000, out 12)
```

Si legge da sinistra a destra: il modello, il costo al prezzo di listino standard del modello (i turni in modalità veloce sono l'eccezione, vedi sotto), poi i token di input fatturati per intero, i token scritti in cache (`cache↑`), i token letti dalla cache (`cache↓`) e i token di output. La prima riga è un turno a freddo che scrive il prefisso; la seconda lo rilegge a una frazione del prezzo. Una sessione in cui `cache↑` resta alto turno dopo turno ha un problema di cache: vedi [perché il prompt caching di Claude smette di funzionare](/it/guides/claude-prompt-caching-not-working).

`ENABLE_TOOL_SEARCH=true` dipende dalla tua versione di Claude Code. Dalla v2.1.304 la ricerca dei tool resta attiva dietro un gateway ([documentazione MCP di Claude Code](https://code.claude.com/docs/en/mcp)), e la variabile non cambia nulla. Prima della v2.1.304, Claude Code disattivava la ricerca dei tool dietro qualsiasi base URL diversa da quella di Anthropic e metteva tutte le definizioni dei tool in ogni richiesta. In quelle versioni più vecchie costava caro: la guida a Claude Code del gateway, inclusa nel pacchetto npm, documenta una configurazione con 226 tool MCP, misurata il 9 settembre 2026, in cui questo significava 450 KB per richiesta e un quarto della fattura di quel giorno. Il wrapper `claude` imposta la variabile per te, a meno che tu non l'abbia già impostata.

## Cosa vede il gateway, e cosa no

- **Inoltra ciò che invia Claude Code.** Se nessuna leva agisce su una richiesta, il corpo arriva ad Anthropic byte per byte, compresi i marcatori `cache_control` e l'header `anthropic-beta`, quindi la cache funziona esattamente come senza gateway. Un test nel repository lo verifica contro un upstream fittizio a ogni modifica.
- **Due piccole chiamate lo saltano.** Secondo la [guida alla compatibilità dei gateway](https://code.claude.com/docs/en/llm-gateway-protocol) di Claude Code, il controllo di disponibilità della modalità veloce e il controllo di sicurezza dei domini di WebFetch chiamano direttamente `api.anthropic.com` invece di seguire `ANTHROPIC_BASE_URL`. Nessuno dei due è una richiesta al modello: l'inferenza in modalità veloce vera e propria segue la base URL e passa dal gateway.
- **I turni in modalità veloce vengono registrati a prezzo standard.** Anthropic marca una richiesta in modalità veloce con `speed: "fast"` e la fattura con un sovrapprezzo: $8 di input e $40 di output per milione di token su Claude Opus 5.5, il doppio della tariffa standard, con in più i moltiplicatori della cache ([documentazione della modalità veloce](https://platform.claude.com/docs/en/build-with-claude/fast-mode)). La versione 1.2.3 del gateway non legge `speed`, quindi conta correttamente quei token ma li valorizza come turni standard: su Opus 5.5, la metà di quanto fattura Anthropic. Se usi `/fast`, il totale del gateway per quei turni è troppo basso.
- **Il traffico in abbonamento viene misurato, non fatturato.** Con un accesso Claude Pro o Max non c'è una fattura a token; il gateway valorizza quel traffico all'equivalente del prezzo di listino, così puoi vederlo, e non gli attribuisce alcun risparmio.

## Il gateway fa anche risparmiare?

Così com'è, con Claude Code su una chiave API, misura e non risparmia nulla. Non prendere il messaggio di avvio della versione 1.2.3 come una promessa: dice che tutte le leve di risparmio locali sono attive, e il suo riepilogo in uscita conta solo le richieste che ha misurato, quindi nessuno dei due ti dice che il risparmio è stato zero. La leva predefinita del gateway abbassa la durata delle scritture in cache da un'ora a cinque minuti nei turni in cui gran parte della richiesta è nuova, perché una scrittura da un'ora costa il doppio del prezzo di input e una da cinque minuti 1.25 volte. Claude Code su una chiave API chiede già cinque minuti, a meno che tu non imposti `promptCacheTtl` su `1h`, quindi non c'è nulla da abbassare.

Quando entra in gioco la cache da un'ora, il risparmio è piccolo e dipende dal tuo traffico. La [pagina del banco di prova](/it/benchmarks#gateway-ttl) pubblica un replay del traffico Claude Code di una singola organizzazione: netto **+2.49 %** della fattura a prezzo di listino ($113.45 su $4,563.61), con un intervallo al 95 % tra +1.50 % e +3.57 % ricampionando per sessione, e un tetto del 7.2 % per qualsiasi politica di questo tipo. Su un modello il risultato è stato quasi nullo, e in un periodo ci ha rimesso. È un replay con una baseline in parte ricostruita, non una fattura, e la pagina elenca ogni limite.

## Confronta i numeri del gateway con la tua fattura

1. **Con `/usage`.** Per una sessione, somma i costi per richiesta del gateway e confrontali con il blocco Session di `/usage`. Entrambi valorizzano gli stessi contatori a prezzo di listino, quindi dovrebbero essere vicini, tranne per i turni in modalità veloce, che `/usage` valorizza alla tariffa veloce e il gateway 1.2.3 a quella standard.
2. **Con la Console.** Usa una chiave API o un workspace dedicato per un giorno, poi confronta i totali per modello del gateway con la pagina Usage della Console per quella chiave: input, output, scritture e letture di cache, prima in token, poi in dollari.
3. **Spiega ogni scostamento.** Il prezzo di listino non è sempre il tuo prezzo: sconti contrattuali, residenza dei dati o livelli di priorità cambiano gli importi ma non i conteggi dei token. Anche la modalità veloce: con `/fast` attivo, il totale del gateway è inferiore a quello della Console, perché la 1.2.3 valorizza i turni in modalità veloce alla tariffa standard. Il traffico che non è passato da questo gateway, come un'altra macchina, uno script o un job di CI che usa la stessa chiave, compare solo nella Console.

Se i token coincidono e i dollari no, la differenza sta nei prezzi, non nella misura. Per il metodo completo, leggi [come verificare i risparmi LLM con la fattura del tuo provider](/it/guides/verify-llm-savings-against-provider-bill).

## Tagliare la fattura una volta che la vedi

Con i numeri per richiesta davanti, le correzioni abituali sono semplici: ripulisci il contesto tra attività non collegate invece di trascinarti dietro una lunga cronologia, scegli il modello prima della sessione e mantienilo, compatta nelle pause naturali, tieni i log grandi fuori dal contesto e togli i server MCP che non usi. Come usare il modello di un altro provider dietro Claude Code è spiegato in [costi API di DeepSeek e Qwen](/it/guides/deepseek-qwen-api-cost-local-gateway).

Il codice sorgente del gateway, la sua guida a Claude Code e i test che verificano che inoltri le tue richieste senza modificarle sono su [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
