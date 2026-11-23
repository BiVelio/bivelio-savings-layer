DeepSeek und Qwen sind pro Token günstig, und gerade deshalb verliert man die Rechnung leicht aus den Augen. Beide Anbieter cachen Prompts auf ihrer Seite, und Eingabe, die den Cache trifft, wird weit unter Eingabe berechnet, die ihn verfehlt. Die echten Kosten deines Traffics hängen also an einer Zahl, die die meisten Dashboards verstecken: wie viele Eingabe-Tokens bei jeder Anfrage den Cache treffen. Dieser Leitfaden erklärt, wie beide Anbieter abrechnen und cachen, wie du eine Anfrage anhand ihrer Usage-Felder bepreist und wie du das pro Anfrage mit einem kostenlosen lokalen Gateway siehst.

## Wie DeepSeek eine Anfrage abrechnet

DeepSeek teilt die Eingabe jeder Anfrage in zwei Teile: Tokens, die seinen Kontext-Cache treffen, und Tokens, die ihn verfehlen, jeweils mit eigenem Preis, dazu die Ausgabe-Tokens. Sein [Context Caching](https://api-docs.deepseek.com/guides/kv_cache) ist für jedes Konto standardmäßig aktiv. Für einen Treffer muss der Anfang der Anfrage exakt mit einer früheren übereinstimmen, der Cache arbeitet nach Best Effort, und ungenutzte Einträge werden nach einigen Stunden oder Tagen gelöscht. Die Antwort sagt dir, was passiert ist:

- `usage.prompt_cache_hit_tokens`: Eingabe-Tokens, die aus dem Cache kamen.
- `usage.prompt_cache_miss_tokens`: Eingabe-Tokens, die vollständig verarbeitet wurden.
- `usage.prompt_tokens_details.cached_tokens`: dieselbe Trefferzahl, in dem Feld, das OpenAI-kompatible Tools auslesen.

DeepSeeks [Preisseite](https://api-docs.deepseek.com/quick_start/pricing) nennt für jedes Modell die Preise für Treffer, Miss und Ausgabe sowie ein Nebenzeitfenster mit niedrigerem Preis. Preise ändern sich; übernimm sie mit dem Datum, an dem du sie gelesen hast.

## Wie Qwen eine Anfrage abrechnet

Qwen-Modelle auf Alibaba Cloud Model Studio haben zwei Arten von [Kontext-Cache](https://www.alibabacloud.com/help/en/model-studio/context-cache). Der implizite Cache arbeitet automatisch für Prompts ab einer Mindestlänge, und seine Treffer werden vergünstigt abgerechnet. Der explizite Cache funktioniert wie der von Anthropic: Du markierst einen Block mit `cache_control`, der Eintrag lebt ein paar Minuten, und das Schreiben kostet etwas mehr als normale Eingabe, während das Lesen deutlich weniger kostet. In der OpenAI-kompatiblen API kommt die Trefferzahl in `usage.prompt_tokens_details.cached_tokens` an. Model Studio hat regionale Endpunkte, prüf also, zu welchem dein Schlüssel gehört.

## Den Cache treffen, bei beiden Anbietern

Die Regeln sind dieselben wie bei jedem Präfix-Cache:

1. Stell an den Anfang, was sich nie ändert: den System-Prompt, die Tool-Definitionen, langen Referenztext, Few-Shot-Beispiele.
2. Halte es zwischen Anfragen Byte für Byte identisch: keine Zeitstempel, Request-IDs oder Benutzernamen darin und Tool-Definitionen in fester Reihenfolge.
3. Stell ans Ende, was sich ändert: die Frage des Nutzers, das letzte Tool-Ergebnis.
4. Hänge bei Agents an den Verlauf an, statt ihn umzuschreiben. Eine alte Nachricht in der Mitte zu bearbeiten macht alles danach ungültig.

## Die Kosten einer Anfrage berechnen

Um eine Anfrage zu bepreisen, brauchst du kein Tool. Lies den Usage-Block und multipliziere jeden Posten mit seinem Preis:

```python
def request_cost(usage: dict, price_miss: float, price_hit: float, price_out: float) -> float:
    """USD cost of one chat completion. Prices are per million tokens, from the provider's pricing page."""
    details = usage.get("prompt_tokens_details") or {}
    hit = usage.get("prompt_cache_hit_tokens", details.get("cached_tokens", 0)) or 0
    miss = usage["prompt_tokens"] - hit
    return (miss * price_miss + hit * price_hit + usage["completion_tokens"] * price_out) / 1_000_000
```

Protokolliere diese Zahl für jede Anfrage mit dem Modell, dem Trefferanteil (`hit / prompt_tokens`) und einem Zeitstempel, und du kannst die Fragen beantworten, auf die es ankommt: welches Feature am meisten kostet, ob die Cache-Trefferquote nach einem Deployment gefallen ist und wie viel deines Traffics ins Nebenzeitfenster fällt.

## Jede Anfrage mit einem lokalen Gateway sehen

Damit du nicht jede Aufrufstelle anfassen musst, stell ein Gateway vor den Anbieter. [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) liefert eines in seinem npm-Paket mit: Apache-2.0, lokal, **ohne Schlüssel und ohne Registrierung**, und nichts wird an BiVelio gesendet. Starte ein Gateway pro Anbieter, jedes auf seinem eigenen Port:

```bash
# DeepSeek
npx @bivelio/savings-layer gateway --upstream deepseek --port 8403

# Qwen on Model Studio's international endpoint (`--upstream qwen` is the Beijing one)
npx @bivelio/savings-layer gateway --upstream https://dashscope-intl.aliyuncs.com --port 8404
```

Das Gateway leitet den Pfad, den dein Client sendet, an den Anbieter weiter. Deine Base-URL ist also die des Anbieters, mit dem Gateway als Host:

| Anbieter | `--upstream` | Base-URL für deinen OpenAI-Client |
| --- | --- | --- |
| DeepSeek | `deepseek` | `http://127.0.0.1:8403` |
| Qwen (Peking) | `qwen` | `http://127.0.0.1:<port>/compatible-mode/v1` |
| Qwen (international) | `https://dashscope-intl.aliyuncs.com` | `http://127.0.0.1:8404/compatible-mode/v1` |
| GLM | `glm` | `http://127.0.0.1:<port>/api/paas/v4` |

`npx @bivelio/savings-layer --help` listet die übrigen Upstreams auf (Moonshot, MiniMax, OpenRouter, Gemini, Ollama, vLLM, LM Studio).

In Python erledigt der kleine Client des Pakets die Base-URL für dich: Bau wie gewohnt deinen OpenAI-Client für den Anbieter, und `wrap()` gibt eine Kopie zurück, die durch das Gateway geht und den Pfad des Anbieters beibehält.

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

Für Qwen funktioniert dasselbe mit dem anderen Gateway und `OpenAI(base_url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1", ...)`. Wenn dein Traffic über einen HTTP-Proxy läuft, setz `NO_PROXY=127.0.0.1,localhost`, damit Anfragen an das lokale Gateway nicht darüber gehen. Läuft kein Gateway, wirft `wrap()` `GatewayUnavailable`, statt den Anbieter direkt aufzurufen. In Version 1.2.3 behauptet diese Fehlermeldung außerdem, das Gateway brauche einen Service-Schlüssel: Das stimmt nicht, es startet ohne.

Jede andere Sprache und jedes andere Tool funktioniert auch: Richte die OpenAI-Base-URL auf das Gateway, und jede Anfrage wird zu einer Zeile im Log des Gateways, mit dem Modell, den Kosten zum Listenpreis und der Eingabe, aufgeteilt in voll berechnete Tokens und Cache-Lesevorgänge (`cache↓`).

Eine Ausnahme ist für Chat-Tools und Agents wichtig: Eine **gestreamte** Anfrage, die keine Nutzungsdaten anfordert (`stream_options: {"include_usage": true}`), bekommt vom Anbieter keine, und Version 1.2.3 protokolliert sie deshalb als `not metered: the request did not ask for usage`. Fordere die Nutzungsdaten in deinem Client an oder starte das Gateway mit `BVSALA_GATEWAY_USAGE_INJECT=1`, das diese Option bei Streams ergänzt, denen sie fehlt. Der letzte Chunk dieser Streams hat dann eine leere `choices`-Liste, mit der Code, der ungeprüft `choices[0]` liest, nicht rechnet.

## Coding-Agents mit DeepSeek oder Qwen

DeepSeek bietet außerdem einen Endpunkt im Anthropic-Format an und dokumentiert, wie man ihn mit Claude Code nutzt. Mit `--upstream deepseek` schickt das Gateway Anfragen im Anthropic-Format von selbst an diesen Endpunkt:

```bash
npx @bivelio/savings-layer gateway --upstream deepseek --port 8402
ANTHROPIC_BASE_URL=http://127.0.0.1:8402 ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY" ANTHROPIC_MODEL=deepseek-flash claude
```

Ein Nicht-Claude-Modell hinter Claude Code zu betreiben ist DeepSeeks Integration, kein Setup, das Anthropic unterstützt, und ob das Modell für deine Arbeit taugt, musst du selbst beurteilen.

**Qwen Code mit Qwen-Modellen** braucht einen anderen Weg. Der Wrapper `qwen` des Pakets deckt ihn nicht ab: In Version 1.2.3 startet `npx @bivelio/savings-layer qwen` Qwen Code mit seinem Anthropic-Authentifizierungstyp und leitet an Anthropics API weiter, misst also nur Claude-Modelle, die mit einem Anthropic-Schlüssel genutzt werden, und lehnt eine DashScope-Base-URL im Anthropic-Format ab. Für Qwen-Modelle nutzt du den OpenAI-kompatiblen Modus von Qwen Code, den [seine Dokumentation](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/) mit `OPENAI_API_KEY`, `OPENAI_BASE_URL` und `OPENAI_MODEL` konfiguriert, und richtest diese Base-URL auf ein Gateway. Setz `DASHSCOPE_PROXY_BASE_URL` auf genau dieselbe URL:

```bash
npx @bivelio/savings-layer gateway --upstream https://dashscope-intl.aliyuncs.com --port 8404

GW=http://127.0.0.1:8404/compatible-mode/v1
OPENAI_BASE_URL="$GW" DASHSCOPE_PROXY_BASE_URL="$GW" OPENAI_API_KEY="$DASHSCOPE_API_KEY" OPENAI_MODEL=qwen-plus qwen
```

Die zweite Variable ist für die Rechnung wichtig. Qwen Code entscheidet anhand des Hosts der Base-URL, ob es mit DashScope spricht, und `127.0.0.1` ist kein DashScope-Host. Ohne die Variable fällt es auf seinen generischen OpenAI-Provider zurück, der keine Markierungen für den expliziten Cache sendet (`cache_control` und den Header `X-DashScope-CacheControl`). Deine Anfragen landen dann beim impliziten Cache von Model Studio, bei dem Treffer typischerweise 20 % des Eingabepreises kosten und nach Best Effort arbeiten, statt bei den 10 % des expliziten Caches ([Kontext-Cache](https://www.alibabacloud.com/help/en/model-studio/context-cache)). Qwen Code behandelt eine Base-URL, die exakt mit `DASHSCOPE_PROXY_BASE_URL` übereinstimmt, als DashScope und behält die Markierungen bei ([sein DashScope-Provider](https://github.com/QwenLM/qwen-code/blob/8fab857da5/packages/core/src/core/openaiContentGenerator/provider/dashscope.ts), abgerufen am 23. November 2026). Das Gateway leitet beide unverändert weiter: Das haben wir mit Version 1.2.3 geprüft.

Wir haben die Gateway-Seite dieses Wegs mit Version 1.2.3 geprüft, nicht Qwen Code selbst, also lies das Log des Gateways: eine Zeile mit Kosten pro Anfrage. Eine Zeile mit `not metered` sagt dir, warum: meist ein Stream, der keine Nutzungsdaten anfordert (starte das Gateway mit `BVSALA_GATEWAY_USAGE_INJECT=1` neu), oder ein Modell ohne Zeile im Katalog von 1.2.3, der `qwen-plus`, `qwen-flash`, `qwen3.7-flash`, `qwen3.8-flash` und `qwen3.8-max` enthält, aber zum Beispiel nicht `qwen3-coder-plus`.

Zwei Preislücken in 1.2.3 hängen von der zweiten Variable ab. **Mit gesetzter `DASHSCOPE_PROXY_BASE_URL`**, wie oben, berechnet Model Studio jeden Schreibvorgang in den expliziten Cache mit 125 % des Eingabepreises und meldet ihn in `usage.prompt_tokens_details.cache_creation_input_tokens`. Das Gateway 1.2.3 liest dieses Feld nicht: Es protokolliert diese Tokens als normale Eingabe, mit `cache↑0`, zu 80 % dessen, was sie kosten. Sein Trefferpreis für `qwen-plus` sind die 10 % des expliziten Caches, und das passt. **Ohne die Variable** gibt es keine expliziten Schreibvorgänge, aber die Treffer sind implizite, mit etwa 20 % berechnet, und das Gateway protokolliert sie mit denselben 10 %, also etwa der Hälfte ihrer Kosten.

## Was das Gateway misst und was nicht

- **Der Dollarbetrag stammt aus einem Katalog, nicht aus DeepSeeks tageszeitabhängigen Preisen.** Version 1.2.3 hat Zeilen für `deepseek-flash` und `deepseek-v4-pro`. Für Cache-Misses und Ausgabe nutzen sie DeepSeeks Preis zur Hauptzeit, in der Nebenzeit zeigen diese Posten also das Doppelte dessen, was DeepSeek berechnet. Für Cache-Treffer nutzen beide Zeilen 0,003 $ pro Million Tokens. Das ist DeepSeeks Trefferpreis in der Nebenzeit für `deepseek-flash` (zur Hauptzeit ist er doppelt so hoch) und liegt unter beiden Trefferpreisen, die DeepSeek für `deepseek-v4-pro` veröffentlicht ([Preisseite](https://api-docs.deepseek.com/quick_start/pricing), abgerufen am 23. November 2026). Je nach Uhrzeit und je nachdem, wie viel deiner Eingabe den Cache trifft, kann die Summe des Gateways über oder unter der Rechnung liegen. Die Token-Zahlen sind exakt; vergleiche zuerst diese. Der klassische Alias `deepseek-chat` hat keine Zeile: Er wird weitergeleitet, und das Log sagt, dass er nicht gemessen wurde.
- **Es verändert diese Anfragen nicht.** Bei OpenAI-kompatiblem Traffic misst das Gateway und leitet weiter (die einzige Ausnahme ist die optionale Usage-Injektion von oben); seine Sparhebel sind für Traffic im Anthropic-Format gedacht. Die Einsparung bei DeepSeek und Qwen kommt aus deren eigenen Caches, und deshalb ist die Trefferzahl die Zahl, die du beobachten solltest.

## Wenn du DeepSeek oder Qwen aus TypeScript aufrufst

Das SDK von BV-SALA spricht mit jedem OpenAI-kompatiblen Endpunkt und überspringt exakte Wiederholungen und gleichzeitig laufende identische Anfragen, kostenlos und ohne Schlüssel ([so funktioniert das](/de/guides/deduplicate-llm-requests)). Bei DeepSeek werden diese vermiedenen Aufrufe als `estimated` gemeldet, nicht als `reference`: Version 1.2.3 bewertet eine Wiederholung nur dann per Referenz, wenn der Aufruf, der lief, an die eigene API von OpenAI, Anthropic oder Google ging. Eine Warnung für Agent-Schleifen: Das standardmäßige Kürzen überholter Tool-Ergebnisse schreibt die Mitte des Verlaufs um, und bei einem Anbieter, der von sich aus den ganzen Prompt cacht, kann das mehr kosten, als es spart. Das Changelog des Projekts meldet +166 % bei einer Agent-Schleife mit 60 Schritten auf DeepSeek, gemessen gegen einen simulierten Anbieter mit den Versionen 1.2.3 und 1.2.4 und ohne Schlüssel. Schalte es bei Agent-Schleifen pro Anfrage ab:

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

## Die Zahlen mit deinem Anbieter abgleichen

Vergleiche einmal am Tag die Summen des Gateways pro Modell (Eingabe, Cache-Treffer, Ausgabe) mit der Usage-Seite der DeepSeek-Plattform oder von Model Studio für denselben Schlüssel. Die gesamten Token-Zahlen sollten übereinstimmen, mit einer Ausnahme bei ihrer Aufteilung: Bei Qwen zählt Version 1.2.3 Schreibvorgänge in den expliziten Cache als normale Eingabe, nicht als Cache-Schreibvorgänge. Die Dollarbeträge können aus bekannten Gründen in beide Richtungen abweichen. Die Preise des Katalogs sind nicht DeepSeeks tageszeitabhängige Preise. Bei Qwen bepreist 1.2.3 Schreibvorgänge in den expliziten Cache als normale Eingabe, unter dem, was Model Studio berechnet, und implizite Treffer zum expliziten Tarif (beides oben beschrieben). Regionale Preise und Rabatte ändern die Beträge ebenfalls. Eine Schritt-für-Schritt-Methode findest du in [LLM-Einsparungen mit der Rechnung deines Anbieters abgleichen](/de/guides/verify-llm-savings-against-provider-bill). Der Code des Gateways und seine Leitfäden für jedes Terminal liegen auf [GitHub](https://github.com/BiVelio/bivelio-savings-layer), und was das Projekt gemessen hat und was nicht, steht auf der [Benchmark-Seite](/de/benchmarks).
