„Was kostet Claude Code?“ hat zwei ehrliche Antworten. Mit einem Claude-Abo zahlst du den Preis des Abos, und Kosten pro Token spielen erst eine Rolle, wenn du über dessen Limits hinausgehst. Mit einem API-Schlüssel oder über einen Cloud-Anbieter zahlst du pro Token, und die Kosten einer Session hängen davon ab, wie viele Anfragen Claude Code sendet, wie groß jede einzelne ist und wie viel davon aus dem Prompt-Cache gelesen wird. Dieser Leitfaden zeigt, was Anthropic veröffentlicht, welche eingebauten Werkzeuge dir Summen liefern und wie du auf deinem eigenen Rechner kostenlos die Kosten jeder einzelnen Anfrage siehst, damit du die Runden findest, die eine Session teuer machen.

## Was Claude Code laut Anthropic kostet

Anthropics eigene [Kostenseite zu Claude Code](https://code.claude.com/docs/en/costs) nennt Durchschnittswerte aus Enterprise-Deployments: etwa 13 $ pro Entwickler und aktivem Tag und 150 $ bis 250 $ pro Entwickler und Monat, wobei 90 % der Nutzer unter 30 $ pro aktivem Tag bleiben. Das sind Durchschnitte über viele Teams. Deine Zahl hängt vom gewählten Modell, von der Größe deines Repositorys und von deiner Arbeitsweise ab, und deshalb geht es im Rest dieses Leitfadens darum, sie zu messen.

## Die eingebauten Werkzeuge und was sie nicht zeigen

- **`/usage` in Claude Code.** Der Session-Block zeigt *geschätzte* Kosten zum Listenpreis, mit Tokens pro Modell, aufgeteilt in Eingabe, Ausgabe, Cache-Lesevorgänge und Cache-Schreibvorgänge. Neuere Versionen ergänzen eine Zeile zum Prompt-Cache mit Trefferquote und Zahl der Misses. Es ist eine Summe für die Session, lokal berechnet.
- **Die Claude Console.** Für API-Schlüssel zeigen die Seiten Cost und Usage, was abgerechnet wurde, pro Tag, Workspace und Modell. Das ist die Zahl, mit der du abgleichst.
- **OpenTelemetry-Export.** Claude Code kann Token- und Kostenmetriken pro Nutzer und Session in deinen eigenen Observability-Stack streamen ([Monitoring-Dokumentation](https://code.claude.com/docs/en/monitoring-usage)).

Was keines davon leicht macht, ist die **Sicht pro Anfrage**: welche Runde die teure war und warum. Eine Session besteht aus Dutzenden oder Hunderten API-Aufrufen, und die teuren haben erkennbare Ursachen:

- **Ein kalter Cache.** Die erste Runde nach einer Pause, die länger ist als die Cache-Lebensdauer, liest die ganze Unterhaltung zum vollen Preis neu ein und schreibt sie erneut.
- **Ein Modellwechsel.** Jedes Modell hat seinen eigenen Cache, ein Wechsel mitten in der Session verarbeitet also alles neu.
- **Riesige Tool-Ergebnisse.** Ein Testlog oder eine große Datei, einmal gelesen, steckt im Kontext jeder späteren Runde.
- **Zu viele Tool-Definitionen.** MCP-Server können jeder Anfrage viele Kilobyte an Definitionen hinzufügen.
- **Komprimierung (Compaction).** Das Zusammenfassen einer langen Unterhaltung ist selbst eine große Anfrage.

## Jede Anfrage mit einem lokalen Gateway messen

Ein Gateway ist ein kleiner Proxy zwischen Claude Code und der API, der die Nutzungszähler jeder Antwort ausliest. Claude Code unterstützt das offiziell über `ANTHROPIC_BASE_URL`. [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) liefert eines in seinem npm-Paket mit: Apache-2.0, **ohne Schlüssel, ohne Registrierung**, und nichts wird an BiVelio gesendet. Es braucht Node.js 20 oder neuer.

Der Weg mit einem einzigen Befehl:

```bash
# Starts a local gateway on a free port, runs Claude Code through it, and stops it on exit.
npx @bivelio/savings-layer claude
```

Der Wrapper unterdrückt das Log pro Anfrage, damit es nicht über die Oberfläche von Claude Code schreibt. Beim Beenden gibt er aus, wie viele Anfragen er gemessen hat und welche er ohne Messung weitergeleitet hat, und warum. Um jede Anfrage live zu sehen, fordere entweder das Log auf stderr an:

```bash
BVSALA_GATEWAY_LOG=1 npx @bivelio/savings-layer claude
```

oder starte das Gateway in einem eigenen Terminal auf einem festen Port:

```bash
# Terminal 1: the gateway (Anthropic is the default upstream, port 8402)
npx @bivelio/savings-layer gateway

# Terminal 2: Claude Code, pointed at it (no /v1 at the end).
# ENABLE_TOOL_SEARCH=true only matters before Claude Code v2.1.304 (see below).
ENABLE_TOOL_SEARCH=true ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude
```

Jede Anfrage wird zu einer Zeile. Diese beiden stammen aus einem lokalen Test gegen einen Ersatzserver mit erfundenem Traffic: Die Form ist echt, die Zahlen sind nicht deine.

```text
[gateway] POST /v1/messages  · claude-sonnet-5 · $0.007700 (in 40, cache↑3000 cache↓0, out 12)
[gateway] POST /v1/messages  · claude-sonnet-5 · $0.000800 (in 40, cache↑0 cache↓3000, out 12)
```

Lies sie von links nach rechts: das Modell, die Kosten zum Standard-Listenpreis des Modells (Runden im Fast Mode sind die Ausnahme, siehe unten), dann die voll berechneten Eingabe-Tokens, die in den Cache geschriebenen Tokens (`cache↑`), die daraus gelesenen (`cache↓`) und die Ausgabe-Tokens. Die erste Zeile ist eine kalte Runde, die das Präfix schreibt; die zweite liest es für einen Bruchteil des Preises zurück. Eine Session, in der `cache↑` Runde für Runde groß bleibt, hat ein Cache-Problem: siehe [warum Claudes Prompt-Caching nicht mehr funktioniert](/de/guides/claude-prompt-caching-not-working).

`ENABLE_TOOL_SEARCH=true` hängt von deiner Version von Claude Code ab. Seit v2.1.304 bleibt Tool Search hinter einem Gateway aktiv ([MCP-Dokumentation von Claude Code](https://code.claude.com/docs/en/mcp)), und die Variable ändert nichts. Vor v2.1.304 schaltete Claude Code Tool Search hinter jeder Base-URL ab, die nicht die von Anthropic war, und packte jede Tool-Definition in jede Anfrage. Auf diesen älteren Versionen war das teuer: Der Claude-Code-Leitfaden des Gateways, der im npm-Paket enthalten ist, dokumentiert ein Setup mit 226 MCP-Tools, gemessen am 9. September 2026, bei dem das 450 KB pro Anfrage und ein Viertel der Tagesrechnung bedeutete. Der Wrapper `claude` setzt die Variable für dich, sofern du sie nicht schon selbst gesetzt hast.

## Was das Gateway sieht und was nicht

- **Es leitet weiter, was Claude Code sendet.** Wirkt kein Hebel auf eine Anfrage, erreicht der Body Anthropic Byte für Byte, einschließlich der `cache_control`-Markierungen und des Headers `anthropic-beta`, sodass Caching genauso funktioniert wie ohne Gateway. Ein Test im Repository prüft das bei jeder Änderung gegen einen simulierten Upstream.
- **Zwei kleine Aufrufe umgehen es.** Laut dem [Leitfaden zur Gateway-Kompatibilität](https://code.claude.com/docs/en/llm-gateway-protocol) von Claude Code rufen die Verfügbarkeitsprüfung für den Fast Mode und die Domain-Sicherheitsprüfung von WebFetch `api.anthropic.com` direkt auf, statt `ANTHROPIC_BASE_URL` zu folgen. Keiner der beiden ist eine Modellanfrage: Die Inferenz im Fast Mode selbst folgt der Base-URL und läuft durch das Gateway.
- **Runden im Fast Mode werden zum Standardpreis protokolliert.** Anthropic kennzeichnet eine Anfrage im Fast Mode mit `speed: "fast"` und berechnet sie mit Aufschlag: 8 $ für Eingabe und 40 $ für Ausgabe pro Million Tokens bei Claude Opus 5.5, das Doppelte des Standardtarifs, plus die Cache-Multiplikatoren obendrauf ([Dokumentation zum Fast Mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode)). Version 1.2.3 des Gateways liest `speed` nicht, zählt diese Tokens also korrekt, bepreist sie aber wie Standardrunden: bei Opus 5.5 die Hälfte dessen, was Anthropic berechnet. Wenn du `/fast` nutzt, ist die Summe des Gateways für diese Runden zu niedrig.
- **Abo-Traffic wird gemessen, nicht abgerechnet.** Mit einem Login für Claude Pro oder Max gibt es keine Rechnung pro Token; das Gateway bepreist diesen Traffic mit dem Gegenwert zum Listenpreis, damit du ihn siehst, und schreibt ihm keine Einsparung gut.

## Spart das Gateway auch Geld?

Ab Werk, mit Claude Code und einem API-Schlüssel, misst es nur und spart nichts. Lies die Startmeldung von Version 1.2.3 nicht als Versprechen: Sie sagt, dass alle lokalen Sparhebel aktiv sind, und die Zusammenfassung beim Beenden zählt nur die gemessenen Anfragen, sodass dir keine von beiden verrät, dass die Einsparung null war. Der Standardhebel des Gateways senkt die Lebensdauer von Cache-Schreibvorgängen von einer Stunde auf fünf Minuten bei Runden, in denen ein großer Teil der Anfrage neu ist, denn ein Schreibvorgang mit einer Stunde kostet das Doppelte des Eingabepreises und einer mit fünf Minuten das 1,25-Fache. Claude Code mit einem API-Schlüssel fordert ohnehin fünf Minuten an, sofern du `promptCacheTtl` nicht auf `1h` setzt, es gibt also nichts zu senken.

Ist der Cache mit einer Stunde im Spiel, ist die Einsparung klein und hängt von deinem Traffic ab. Die [Benchmark-Seite](/de/benchmarks#gateway-ttl) veröffentlicht ein Replay des eigenen Claude-Code-Traffics einer Organisation: netto **+2,49 %** der Rechnung zum Listenpreis (113,45 $ von 4.563,61 $), mit einem 95 %-Intervall von +1,50 % bis +3,57 % beim Resampling nach Session und einer Obergrenze von 7,2 % für jede Regel dieser Art. Bei einem Modell lag das Ergebnis nahe null, und in einem Zeitraum war es ein Verlustgeschäft. Es ist ein Replay mit einer teilweise rekonstruierten Basislinie, keine Rechnung, und die Seite nennt jede Einschränkung.

## Die Zahlen des Gateways mit deiner Rechnung abgleichen

1. **Mit `/usage`.** Addiere für eine Session die Kosten pro Anfrage aus dem Gateway und vergleiche sie mit dem Session-Block von `/usage`. Beide bepreisen dieselben Zähler zum Listenpreis und sollten daher nah beieinanderliegen, außer bei Runden im Fast Mode, die `/usage` zum Fast-Tarif bepreist und das Gateway 1.2.3 zum Standardtarif.
2. **Mit der Console.** Nutze einen Tag lang einen eigenen API-Schlüssel oder Workspace und vergleiche dann die Summen des Gateways pro Modell mit der Usage-Seite der Console für diesen Schlüssel: Eingabe, Ausgabe, Cache-Schreibvorgänge und Cache-Lesevorgänge, zuerst in Tokens, dann in Dollar.
3. **Erkläre jede Abweichung.** Der Listenpreis ist nicht immer dein Preis: Vertragsrabatte, Datenresidenz oder Priority Tiers ändern den Betrag, aber nicht die Token-Zahlen. Der Fast Mode ebenfalls: Mit aktivem `/fast` liegt die Summe des Gateways unter der der Console, weil 1.2.3 Runden im Fast Mode zum Standardtarif bepreist. Traffic, der nicht durch dieses Gateway lief, etwa von einem anderen Rechner, einem Skript oder einem CI-Job mit demselben Schlüssel, erscheint nur in der Console.

Stimmen die Token-Zahlen überein, die Dollarbeträge aber nicht, liegt der Unterschied im Preis, nicht in der Messung. Die vollständige Methode findest du in [LLM-Einsparungen mit der Rechnung deines Anbieters abgleichen](/de/guides/verify-llm-savings-against-provider-bill).

## Die Rechnung senken, sobald du sie siehst

Mit Zahlen pro Anfrage vor Augen sind die üblichen Maßnahmen schlicht: zwischen unabhängigen Aufgaben den Kontext leeren, statt einen langen Kontext mitzuschleppen, das Modell vor der Session wählen und dabei bleiben, an natürlichen Pausen komprimieren, große Logs aus dem Kontext heraushalten und die MCP-Server ausmisten, die du nicht nutzt. Wie du das Modell eines anderen Anbieters hinter Claude Code einsetzt, behandelt [API-Kosten von DeepSeek und Qwen](/de/guides/deepseek-qwen-api-cost-local-gateway).

Der Quellcode des Gateways, sein Leitfaden für Claude Code und die Tests, die prüfen, dass es deine Anfragen unverändert weiterleitet, liegen auf [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
