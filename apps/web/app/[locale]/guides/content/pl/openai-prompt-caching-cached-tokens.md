OpenAI automatycznie cache'uje długie prompty: gdy początek żądania pasuje do takiego, które niedawno przetworzył, te tokeny wejściowe są rozliczane ze zniżką, a odpowiedź zaczyna się szybciej. Nie trzeba niczego włączać. Właśnie dlatego łatwo przeoczyć moment, w którym przestaje to działać. Jeśli `cached_tokens` przy każdym żądaniu wraca jako `0`, ten poradnik podaje przyczyny w kolejności sprawdzania, pokazuje, jak śledzić odsetek trafień dla każdego żądania i jak sprawdzić go z danymi o użyciu od samego OpenAI.

## Gdzie to odczytać

Każda odpowiedź mówi, ile tokenów wejściowych pochodziło z cache:

- **Chat Completions:** `usage.prompt_tokens_details.cached_tokens`, z puli `usage.prompt_tokens`.
- **Responses API:** `usage.input_tokens_details.cached_tokens`, z puli `usage.input_tokens`.

Tokeny z cache są częścią sumy wejścia, a nie są do niej doliczane. [Przewodnik po prompt cachingu](https://developers.openai.com/api/docs/guides/prompt-caching) od OpenAI jest punktem odniesienia dla aktualnych zasad. Rozróżnia teraz nowsze modele, które także raportują i naliczają zapisy do cache i przyjmują jawne opcje cache, od starszych, w których zapis do cache jest darmowy. Sprawdź tam model, którego używasz.

## Dlaczego cached_tokens wynosi 0

1. **Prompt jest za krótki.** Cache'owanie zaczyna się od około 1024 tokenów promptu; dokładny próg i sposób zaokrąglania liczby tokenów z cache zależą od modelu. Prompt systemowy z 600 tokenami i krótkie pytanie nigdy nie trafiają w cache i nic Cię o tym nie informuje.
2. **Początek promptu się zmienia.** Cache dopasowuje od pierwszego tokena. Znacznik czasu, identyfikator żądania albo imię użytkownika w pierwszej wiadomości sprawiają, że każde żądanie jest unikalne od pierwszego tokena. Narzędzia, obrazy i formaty odpowiedzi też są częścią prefiksu, więc narzędzia wymienione w innej kolejności albo inaczej zserializowany schemat psują dopasowanie.
3. **Wpis został usunięty z cache.** Wpisy są przechowywane krótko po ostatnim użyciu, przy spokojnym ruchu zwykle przez kilka minut. Żądania oddalone o godzinę rzadko trafiają w cache.
4. **Ruch jest rozproszony.** Żądania są kierowane według hasha początku promptu. Bardzo duży wolumen z tym samym prefiksem przelewa się na inne maszyny, które nie mają tego wpisu. Parametr `prompt_cache_key` w OpenAI grupuje żądania o wspólnym prefiksie; używaj jednego klucza na szablon promptu, a nie na użytkownika, i utrzymuj umiarkowane tempo żądań na klucz, jak wyjaśnia przewodnik.
5. **Nie odczytujesz tego pola.** Strumieniowane żądanie Chat Completions w ogóle nie zawiera danych o użyciu, jeśli o nie nie poprosisz przez `stream_options: { include_usage: true }`. Wiele wrapperów gubi `prompt_tokens_details`. Niektórzy dostawcy zgodni z OpenAI i niektóre wdrożenia Azure raportują cache'owanie inaczej albo wcale.

## Test w dwie minuty

Zanim zaczniesz debugować aplikację, sprawdź, czy cache'owanie w ogóle działa dla Twojego konta i modelu. Wyślij ten sam długi prompt dwa razy, w odstępie kilku sekund, i odczytaj dane o użyciu z każdej odpowiedzi:

```bash
# A system prompt well above the threshold, sent twice. The second answer should report cached tokens.
BODY=$(python3 -c 'import json; print(json.dumps({"model": "gpt-4o-mini", "messages": [{"role": "system", "content": "You are a careful assistant for an invented shop. " * 200}, {"role": "user", "content": "Say OK."}]}))')
for i in 1 2; do
  curl -s https://api.openai.com/v1/chat/completions \
    -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" \
    -d "$BODY" | python3 -c 'import json, sys; u = json.load(sys.stdin)["usage"]; print(u["prompt_tokens"], u.get("prompt_tokens_details"))'
done
```

Jeśli druga linia pokazuje tokeny z cache, strona dostawcy działa, a problem tkwi w tym, jak Twoja aplikacja buduje prompty: czytaj dalej. Jeśli nie pokazuje żadnych, spróbuj kilka razy (cache'owanie działa w trybie best effort, a pierwsze żądanie mogło trafić na inną maszynę), a potem sprawdź wpis modelu w przewodniku OpenAI po cache'owaniu. Podstaw model, którego używasz na produkcji; test na innym modelu niewiele dowodzi.

Ten test daje też punkt odniesienia dla kolejnych sekcji. Gdy zmienisz kolejność w prompcie albo dodasz `prompt_cache_key`, wykonaj to samo porównanie na prawdziwym szablonie z Twojej aplikacji i zachowaj liczby. Odsetek trafień zmierzony przed zmianą i po niej, na szablonie, którego użytkownicy naprawdę używają, to wynik, który można pokazać; „cache'owanie powinno pomóc” nim nie jest.

## To, co się zmienia, na koniec

W większości przypadków rozwiązaniem jest kolejność. Wszystko, co jest takie samo dla każdego żądania, idzie na początek i pozostaje identyczne bajt w bajt; wszystko, co się zmienia, idzie na koniec.

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

Potem śledź, jaka część każdego promptu pochodziła z cache, żeby regresja wyszła na jaw w dniu wdrożenia:

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

Grupuj to według szablonu promptu. Szablon, którego udział stoi na 0%, choć jego prompty mają ponad 1024 tokenów, ma coś zmiennego blisko początku: zaloguj dwa żądania i porównaj je znak po znaku, jak pokazano w [wersji tego poradnika dla Claude](/pl/guides/claude-prompt-caching-not-working#znajdź-bajt-który-psuje-twój-cache).

## Jak pomaga BV-SALA

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) to warstwa oszczędności dla TypeScriptu na licencji Apache-2.0, która opakowuje dowolny endpoint zgodny z OpenAI, za darmo i bez klucza. Cache OpenAI działa automatycznie, więc warstwa niczego nie oznacza w OpenAI. Co robi w sprawie cache'owania:

- **Przy strumieniach zawsze prosi o dane o użyciu,** więc strumieniowane żądanie jest mierzone, zamiast po cichu tracić licznik.
- **Pokazuje rabat OpenAI przy każdym wywołaniu,** w `report.nativeSavings`, na podstawie licznika samego OpenAI, i trzyma go osobno od własnych oszczędności: rabat należy do OpenAI, nie do warstwy.
- **Potrafi wynieść zmienne linie z prefiksu.** Przy opcjonalnym `savings: { cachePrefix: true }` linie promptu systemowego, które zmieniają się przy każdym żądaniu (znaczniki czasu ISO, UUID, czasy epoch), trafiają na koniec, żeby stabilna część mogła trafić do cache. Model czyta te same linie w innej kolejności, dlatego to Twoja decyzja i nigdy nie jest to włączone domyślnie.

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

Własne dźwignie warstwy (pomijanie dokładnych powtórzeń i identycznych żądań w locie) są niezależne od cache OpenAI i opisuje je poradnik [deduplikacja identycznych żądań do LLM](/pl/guides/deduplicate-llm-requests).

## Sprawdź z liczbami OpenAI

1. **Dla każdego żądania:** loguj `cached_tokens` i sumę wejścia z każdej odpowiedzi albo, z warstwą, `report.tokens.providerCachedInput`.
2. **Dla każdego dnia:** [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) od OpenAI zwraca użycie completions w dziennych przedziałach, które obejmują tokeny wejściowe z cache, w podziale na model i, jeśli o to poprosisz, na klucz API lub projekt. Zsumuj swoje logi dla tego samego klucza, modelu i dnia UTC: sumy wejścia z cache i bez cache powinny się zgadzać.
3. **W pieniądzach:** wyceniaj wejście z cache i bez cache osobno. W modelach, które naliczają zapisy do cache, uwzględnij również je, bo inaczej Twoje oszacowanie oszczędności będzie za wysokie.

Pełną metodę opisuje [jak sprawdzić oszczędności na LLM z rachunkiem dostawcy](/pl/guides/verify-llm-savings-against-provider-bill). Pozostałe dźwignie rachunku od OpenAI omawia [jak obniżyć koszty API OpenAI](/pl/guides/reduce-openai-api-costs). Zmierzone wyniki, łącznie z tymi, w których warstwa nic nie oszczędza, są na [stronie benchmarków](/pl/benchmarks), a kod jest na [GitHubie](https://github.com/BiVelio/bivelio-savings-layer).
