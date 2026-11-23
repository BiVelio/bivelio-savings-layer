Każde API LLM rozlicza się za wywołanie. Jeśli Twoja aplikacja wysyła to samo żądanie dwa razy, płacisz dwa razy, choć druga odpowiedź nic nie wnosi. Ten poradnik pokazuje dwie techniki, które temu zapobiegają: **cache odpowiedzi z dokładnym dopasowaniem** dla powtórzeń, które przychodzą później, i **scalanie żądań w locie** dla identycznych żądań, które przychodzą w tej samej chwili. Obie działają w każdym języku i z każdym dostawcą. Na końcu zobaczysz, jak otwartoźródłowe SDK BV-SALA domyślnie robi jedno i drugie, i jak sprawdzić oszczędność z danymi o użyciu od samego dostawcy.

## Skąd biorą się zduplikowane żądania

Duplikaty są częstsze, niż się wydaje, bo rzadko pochodzą z jednego oczywistego miejsca:

- **Ponowienia i podwójne kliknięcia.** Użytkownik klika „Generuj” dwa razy albo biblioteka klienta ponawia żądanie po timeoucie, na które dostawca w rzeczywistości już odpowiedział.
- **Zadania wsadowe i crony.** Nocne zadanie klasyfikuje te same opisy produktów, wpisy FAQ albo szablony odpowiedzi supportu, które klasyfikowało wczoraj.
- **Fan-out.** Dwa workery, dwie karty przeglądarki albo efekt Reacta, który w trybie deweloperskim uruchamia się dwa razy, wysyłają ten sam prompt w odstępie milisekund.
- **Agenty i pipeline'y.** Wieloetapowy pipeline zadaje to samo pytanie pomocnicze w kilku gałęziach.
- **Testy i ewaluacje.** CI przy każdym pushu uruchamia te same fixtures na produkcyjnym API.

Pierwsza i ostatnia grupa to powtórzenia rozłożone w czasie; fan-out to współbieżność. Wymagają różnych rozwiązań, dlatego ten poradnik omawia oba.

## Najpierw zmierz odsetek duplikatów

Zanim cokolwiek zbudujesz, sprawdź, jaka część Twojego ruchu się powtarza. Przez jeden dzień licz hash z body każdego żądania i zliczaj powtórzenia. Klucz musi być **kanoniczny**: to samo żądanie musi dawać te same bajty bez względu na kolejność kluczy JSON.

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

Jeśli odsetek jest bliski zera, cache odpowiedzi niewiele Ci zaoszczędzi i lepiej przyjrzeć się [prompt cachingowi](/pl/guides/claude-prompt-caching-not-working) albo [wyborowi modelu](/pl/guides/reduce-openai-api-costs). Jeśli zauważalna część żądań się powtarza, czytaj dalej.

## Zbuduj klucz cache, który jest naprawdę bezpieczny

Dokładny cache jest tak dobry jak jego klucz. Zasada jest prosta: **wszystko, co może zmienić odpowiedź, trafia do klucza, i nic nie jest usuwane przez normalizację.**

- Identyfikator modelu, pełna lista wiadomości, prompt systemowy, definicje narzędzi, format odpowiedzi lub schemat JSON i każdy parametr próbkowania (`temperature`, `top_p`, `max_tokens`, `seed`, poziom rozumowania).
- **Zakres** (scope), gdy prompt zawiera dane użytkownika. Dwóch użytkowników pytających „ile mam na koncie?” wysyła ten sam tekst i potrzebuje różnych odpowiedzi. Dodaj do klucza identyfikator użytkownika lub tenanta albo w ogóle nie cache'uj takich żądań.
- Żadnej „sprytnej” normalizacji. Zamiana na małe litery, obcinanie białych znaków albo usuwanie interpunkcji, żeby uzyskać więcej trafień, zamienia dokładny cache w rozmyty, a rozmyty cache może zwrócić odpowiedź na inne pytanie.

## Czego nigdy nie podawać z cache

Niektóre żądania się powtarzają, ale mimo to za każdym razem muszą trafić do modelu:

- **Odpowiedzi, które muszą się zmieniać**: „wybierz losowe imię”, „wygeneruj hasło”, „która jest godzina”, „dzisiejsza cena”. Odpowiedź z cache jest tu błędem, a nie oszczędnością.
- **Narzędzia ze skutkami ubocznymi.** Jeśli odpowiedź prosi o wywołanie `send_email` albo `create_order`, odtworzenie jej z cache pomija tę akcję. Cache'uj tylko żądania, których narzędzia wyłącznie odczytują dane, albo te bez narzędzi.
- **Próbkowane wyjście, po którym użytkownicy oczekują różnorodności.** Przy wysokiej `temperature` odpowiedź z cache to tylko jedna próbka, podawana w nieskończoność.
- **Błędy, puste odpowiedzi, odmowy i ucięte odpowiedzi.** Nigdy nie zapisuj ich do cache; pozwól, żeby następne żądanie spróbowało ponownie.
- **Tematy wrażliwe.** Bot supportu nie powinien cache'ować odpowiedzi o samookaleczeniu ani o nagłym przypadku medycznym; takie żądania za każdym razem wysyłaj do modelu.

## Scalaj identyczne żądania w locie

Cache pomaga dopiero wtedy, gdy dotrze pierwsza odpowiedź. Jeśli dziesięć identycznych żądań wystartuje w tych samych 300 ms, wszystkie dziesięć chybi. Rozwiązaniem jest mały wzorzec często nazywany *singleflight*: pierwszy wywołujący wykonuje wywołanie, a pozostali czekają na ten sam promise.

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

Na produkcji liczą się trzy szczegóły. Błędy muszą docierać do każdego czekającego wywołującego (powyższy wzorzec to zapewnia). Anulowanie przez jednego wywołującego nie może anulować wspólnego wywołania dla pozostałych. A strumieniowanie jest trudniejsze: strumienia, który już się zaczął, nie da się po prostu przekazać drugiemu wywołującemu, więc większość implementacji pozwala zwykłemu żądaniu dołączyć do wywołania w locie, ale do strumienia nie pozwala dołączyć niczemu.

## Jak robi to BV-SALA

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) to warstwa oszczędności dla TypeScriptu na licencji Apache-2.0. Jej SDK opakowuje Twojego dostawcę i **bez klucza i bez rejestracji** domyślnie włącza obie techniki: dokładną pamięć podręczną i deduplikację w locie. Stosuje też powyższe zasady „nigdy nie cache'uj”: żądania dotyczące bieżących lub losowych treści, osobiste sformułowania bez sesji, tematy wrażliwe, odmowy i błędy pozostają poza cache.

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

Żądanie, które brzmi osobiście („moje zamówienie”, „nasza faktura”), nie trafia do cache, dopóki nie powiesz, do kogo należy. Przekaż zakres, a cache znów zadziała, osobno dla każdej sesji:

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

Domyślny cache żyje w pamięci jednego procesu. Żeby współdzielić go między kilkoma serwerami lub instancjami serverless, przekaż przez opcję `exactCache` magazyn, który sam utrzymujesz. Potrzebuje trzech metod, więc zadziała dowolny magazyn klucz–wartość:

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

Odpowiedzi z cache zostają w Twojej infrastrukturze. Gdy działasz bez klucza, nic nie jest wysyłane do BiVelio.

## Sprawdź oszczędność z liczbami dostawcy

Oszczędność z cache łatwo sprawdzić, bo to liczba wywołań, które się nie odbyły.

1. **Policz wywołania po obu stronach.** Przez jeden dzień licz wywołania `generate()` w swojej aplikacji i porównaj je z liczbą żądań, którą Twój dostawca pokazuje dla tego samego klucza API i modelu (strona użycia w konsoli OpenAI lub Anthropic albo ich API użycia). Różnica powinna być równa sumie `report.calls.avoidedLlm`.
2. **Odczytaj, jak wyceniono każde powtórzenie.** `report.cost.basis` mówi, skąd pochodzi liczba. Powtórzenie ma wartość `reference`, gdy identyczne wywołanie, które się odbyło, trafiło bezpośrednio do API OpenAI, Anthropic albo Google Gemini (`api.openai.com`, `api.anthropic.com` lub `generativelanguage.googleapis.com`): jego linią bazową jest licznik użycia tego wywołania, wyceniony ostrożnie po stawce za wejście z cache. Pozostaje `estimated`, gdy wywołanie, które się odbyło, trafiło gdziekolwiek indziej, także do własnego API innego dostawcy, takiego jak DeepSeek, do proxy, Azure albo gatewaya, bo tylko w przypadku tych trzech API wiadomo, że ceny katalogowe warstwy zgadzają się z fakturą. Kwoty szacowane są zawsze raportowane osobno.
3. **Porównuj wydatki, nie tylko wywołania.** Sumuj `report.cost.netSavingsUsd` według podstawy. Nigdy nie dodawaj do siebie kwot zmierzonych i szacowanych i nigdy nie uśredniaj `netSavingsRatio` po żądaniach.

Jeśli chcesz czystszego testu, uruchom to samo obciążenie dwa razy: raz z wyłączonymi na ten przebieg dźwigniami (`savings: { exactCache: false, singleflight: false }` w każdym żądaniu) i raz z ustawieniami domyślnymi, i porównaj oba rachunki.

## Co mówią publiczne liczby

Repozytorium publikuje swoje przebiegi benchmarków. Na publicznym obciążeniu zbudowanym z pytań GSM8K, w którym 30% żądań stanowiły dokładne powtórzenia, zmierzona łączna redukcja dla `gpt-4o-mini` wyniosła **31,50%**, z przedziałem 95% od 25,7% do 36,7% (artefakty SDK 0.4.31 z września 2026; źródło: [strona benchmarków](/pl/benchmarks#savings) i README). Przy ruchu, który nigdy się nie powtarza, oszczędność wynosi około 0%, a [strona benchmarków](/pl/benchmarks#no-savings) pokazuje także te płaskie wyniki. Liczy też błąd, który dla cache ma największe znaczenie: **0 z 198** wariantów pytań otrzymało odpowiedź na inne pytanie ([gwarancje](/pl/benchmarks#guarantees)).

Twoja oszczędność zależy od Twojego odsetka duplikatów, więc najpierw zmierz go fragmentem kodu z początku tej strony. Kod, artykuł i surowe raporty są na [GitHubie](https://github.com/BiVelio/bivelio-savings-layer).
