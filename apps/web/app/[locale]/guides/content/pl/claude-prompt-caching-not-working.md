Do żądań do Claude dodano `cache_control`, a rachunek ani drgnął. Albo `cache_read_input_tokens` przy każdym wywołaniu wraca jako `0`. Ten poradnik wyjaśnia, dlaczego tak się dzieje, jak znaleźć dokładnie ten bajt, który psuje cache, i jak sprawdzić wynik z danymi o użyciu od samego Anthropic. Wszystko tutaj działa z dowolnym SDK. Na końcu zobaczysz, jak otwartoźródłowe SDK BV-SALA samo rozmieszcza breakpointy i w jakim jednym przypadku należy mu tego zabronić.

## Najpierw odczytaj trzy pola użycia

Każda odpowiedź Messages API mówi, co stało się z cache. Spójrz na trzy liczby w `usage`:

| Pole | Co liczy |
| --- | --- |
| `cache_creation_input_tokens` | Tokeny zapisane do cache w tym wywołaniu, rozliczane powyżej zwykłej ceny wejścia |
| `cache_read_input_tokens` | Tokeny podane z cache, rozliczane za ułamek ceny wejścia |
| `input_tokens` | Tokeny po ostatnim breakpoincie cache, rozliczane po zwykłej cenie |

Trzy wzorce podpowiadają, gdzie szukać:

- **Oba pola cache wynoszą 0.** Nic nie zostało zapisane do cache: prefiks jest krótszy niż minimum modelu, nie ma breakpointu albo coś między Tobą a API go usunęło.
- **Zapis jest wysoki przy każdym wywołaniu, a odczyty stoją na 0.** Cache jest zapisywany i nigdy nie jest używany ponownie: prefiks zmienia się między wywołaniami, wpis wygasł albo wywołania trafiają do innego modelu lub workspace'u.
- **Odczyty są wysokie.** Działa. Teraz pytanie brzmi już tylko, jaka część promptu znajduje się przed breakpointem.

## Jak działa cache promptów w Claude, w sześciu faktach

1. Cache'uje **prefiks**: żądanie od początku do breakpointu `cache_control`. Dopasowanie jest dokładne; jeden inny bajt i wszystko po nim jest przetwarzane od nowa.
2. Kolejność to **tools, potem system, potem messages**. Zmiana na liście narzędzi unieważnia prompt systemowy i wiadomości po nim.
3. Możesz ustawić do **czterech breakpointów**, a API od każdego z nich szuka wstecz wcześniejszego wpisu przez ograniczoną liczbę bloków (w chwili pisania 20).
4. Wpisy żyją domyślnie **pięć minut** i są odświeżane przy każdym trafieniu. Czas życia jednej godziny jest dostępny przez `"ttl": "1h"`.
5. Zapis kosztuje więcej niż odczyt: zapis na pięć minut jest rozliczany jako 1.25 raza cena wejścia, a zapis na godzinę jako 2 razy; odczyt kosztuje mały ułamek ceny wejścia (w większości modeli 0.1 raza). Stawki dla swojego modelu sprawdź na [stronie z cennikiem Anthropic](https://platform.claude.com/docs/en/about-claude/pricing).
6. Istnieje **minimalna długość do cache'owania**, zależna od modelu, od 512 do 4,096 tokenów. Poniżej niej żądanie po prostu nie trafia do cache, bez żadnego błędu.

Wszystko to jest w [dokumentacji prompt cachingu od Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), która jest źródłem, któremu należy ufać, gdy jakaś liczba się zmieni.

## Typowe przyczyny, w kolejności sprawdzania

1. **Prefiks jest za krótki.** Prompt systemowy z 600 tokenami jest w kilku modelach poniżej minimum. Połącz stabilne instrukcje, przykłady i tekst referencyjny, żeby część w cache była na tyle długa, by miało to znaczenie.
2. **Coś w prefiksie zmienia się przy każdym wywołaniu.** Klasyka: znacznik czasu albo linia „Dziś jest…” w prompcie systemowym, identyfikator żądania, imię użytkownika, losowa kolejność przykładów, definicje narzędzi zbudowane z obiektu bez ustalonej kolejności kluczy albo dokument JSON serializowany z różnymi odstępami.
3. **Breakpoint stoi na treści, która się zmienia.** Jeśli ostatni `cache_control` jest na pytaniu użytkownika, każde wywołanie zapisuje nowy wpis, którego nikt nie czyta. Breakpoint należy postawić na końcu części, która się nie zmienia.
4. **Wpis wygasł.** Wywołania oddalone o więcej niż pięć minut nigdy nie odczytują nawzajem swoich wpisów. Nocny batch, który przetwarza jeden element co dziesięć minut, za każdym razem płaci dopłatę za zapis i niczego nie odczytuje.
5. **Wywołania nie współdzielą cache.** Inny model, inny workspace albo zmiana modelu w środku rozmowy zaczynają za każdym razem od pustego cache.
6. **Równoległe wywołania ścigają się.** Wpis można odczytać dopiero wtedy, gdy zacznie się pierwsza odpowiedź. Dziesięć identycznych wywołań wysłanych naraz zapisuje wszystkie. Wyślij najpierw jedno, potem resztę.
7. **Proxy usuwa znacznik.** Gateway, który wycina `cache_control` albo zamienia `system` w formie bloków na zwykły string, sprawia, że cały prompt jest rozliczany jako niecache'owane wejście, choć każde wywołanie nadal kończy się sukcesem. Dokumentacja Claude Code opisuje dokładnie tę awarię w przypadku [gatewayów LLM](https://code.claude.com/docs/en/prompt-caching).

## Znajdź bajt, który psuje Twój cache

Gdy odczyty stoją na zerze, zaloguj dwa kolejne body żądań i znajdź miejsce, w którym pierwszy raz się różnią, w kolejności, w jakiej czyta je cache:

```ts
type Body = { tools?: unknown[]; system?: unknown; messages: unknown[] };

// The cache reads tools, then system, then messages. Compare in that order.
const inCacheOrder = (b: Body) => JSON.stringify([b.tools ?? [], b.system ?? "", b.messages]);

export function firstDifference(a: Body, b: Body): string | null {
  const x = inCacheOrder(a);
  const y = inCacheOrder(b);
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  if (i === x.length && i === y.length) return null;
  return `differs at character ${i}:\n  ${x.slice(Math.max(0, i - 40), i + 40)}\n  ${y.slice(Math.max(0, i - 40), i + 40)}`;
}
```

Jeśli pierwsza różnica leży w prompcie systemowym albo na liście narzędzi, to właśnie tu jest przyczyna chybienia cache. Przenieś tę część na koniec żądania, zwykle do wiadomości użytkownika.

Potem śledź odsetek trafień w każdym wywołaniu, żeby regresja wyszła na jaw w dniu wdrożenia:

```ts
interface ClaudeUsage {
  input_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Share of the input tokens that were read from the cache on this call. */
export function cacheHitRate(u: ClaudeUsage): number {
  const read = u.cache_read_input_tokens ?? 0;
  const written = u.cache_creation_input_tokens ?? 0;
  const total = read + written + u.input_tokens;
  return total === 0 ? 0 : read / total;
}
```

## Czy cache'owanie opłaca się przy Twoim ruchu?

Ponieważ zapisy kosztują więcej niż zwykłe wejście, cache'owanie to zakład, że prefiks zostanie odczytany ponownie, zanim wygaśnie. Przy pięciominutowym czasie życia jeden odczyt już zwraca koszt zapisu. Prefiks zapisany i nigdy nieodczytany kosztuje około 25 % więcej niż wysłanie go bez znacznika. Dlatego „dodaj `cache_control` wszędzie” nie jest bezpiecznym ustawieniem domyślnym: opłaca się przy ruchu czatowym i agentowym, który wraca w ciągu minut, a traci przy jednorazowych żądaniach albo promptach, które zmieniają się za każdym razem.

## Jak radzi sobie z tym BV-SALA

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) to warstwa oszczędności na licencji Apache-2.0. Z `AnthropicProvider` sama rozmieszcza breakpointy, za darmo i bez klucza: jeden na końcu promptu systemowego i jeden na końcu tej części rozmowy, która się nie zmienia, nigdy więcej, niż pozwala API. Raport każdego wywołania pokazuje, co zrobił cache, na podstawie liczników samego Anthropic:

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, AnthropicProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
});

// Long and stable: no dates, no user names, no request ids in here.
const SYSTEM = "You are the support assistant for Acme Outdoor, an invented shop. Our return policy: …";

const { text, report } = await layer.generate({
  model: "anthropic/claude-haiku-4-5",
  messages: [
    { role: "system", content: SYSTEM },
    { role: "user", content: "Can I return hiking boots after 20 days?" },
  ],
});
console.log(text);
console.log(report.nativeSavings?.cacheReadTokens, report.nativeSavings?.cacheWriteTokens);
console.log(report.nativeSavings?.netUsd); // read discount minus write premium; negative on a cold write
```

`report.nativeSavings` to rabat Anthropic, pokazywany osobno: warstwa nigdy nie liczy go jako własnej oszczędności, więc Twój raport zgadza się z fakturą.

**Przypadek, w którym należy wyłączyć oznaczanie.** Bez klucza, jeśli Twój prompt systemowy zmienia się przy każdym żądaniu (znacznik czasu, identyfikator użytkownika) albo Twoje wywołania w świeżych procesach dzieli więcej niż pięć minut, domyślne oznaczanie zapisuje wpis w cache, którego nikt nie czyta, a według README kosztuje to około 20 % więcej niż bez warstwy. Przenieś to, co się zmienia, do wiadomości użytkownika albo wyłącz oznaczanie:

```ts
import { createSavingsLayer, AnthropicProvider } from "@bivelio/savings-layer";

// A system prompt that changes every time: no cache marks, no write premium.
export const noMarks = createSavingsLayer({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, maxCacheBreakpoints: 0 }),
});

// Or keep the marks and, per request, let the layer move timestamp and UUID
// lines to the end of the system prompt, outside the cached part (opt-in: the
// model reads the same lines in a different order).
const layer = createSavingsLayer({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
});
export const reply = await layer.generate({
  model: "anthropic/claude-haiku-4-5",
  messages: [
    { role: "system", content: `Today is ${new Date().toISOString()}\nYou are the support assistant for Acme Outdoor, an invented shop. …` },
    { role: "user", content: "Can I return hiking boots after 20 days?" },
  ],
  savings: { cachePrefix: true },
});
```

To opcjonalne przestawianie jest dźwignią stojącą za eksploracyjnym testem na żywo opublikowanym w README: na `claude-haiku-4-5`, w skonstruowanej sekwencji, w której znacznik czasu zatruwał cache, podniosło odsetek trafień z 0 % do 95 % i obniżyło koszt żądania o 82.76 % w porównaniu z samą warstwą bez tej opcji, przy 20 żądaniach na ramię, zmierzone wersją 1.2.0 15 listopada 2026 r. To mały, skonstruowany test, a nie prognoza dla Twojego ruchu.

## Sprawdź z liczbami Anthropic

1. **Dla każdego wywołania.** Loguj `usage` z każdej odpowiedzi (albo `report.nativeSavings`, jeśli używasz warstwy) i licz odsetek trafień jak wyżej. Zdrowy ruch czatowy lub agentowy po pierwszym wywołaniu pokazuje znacznie więcej odczytów niż zapisów.
2. **Dla każdego dnia.** W Claude Console strona użycia rozbija wejście na zapisy i odczyty cache według modelu i klucza API. Zsumuj zalogowane `cache_read_input_tokens` i `cache_creation_input_tokens` dla tego samego klucza i tego samego dnia UTC: sumy powinny się zgadzać. Do sprawdzenia programowego [Usage and Cost Admin API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) zwraca te same liczniki.
3. **W pieniądzach.** Wyceniaj odczyty, zapisy i zwykłe wejście osobno. Raport, który pokazuje tylko „zaoszczędzone tokeny”, a nie dopłatę za zapis, ukrywa połowę rachunku.

[Publiczne benchmarki](/pl/benchmarks) repozytorium mierzą oba ramiona każdego testu licznikiem użycia samego dostawcy. Ogólną metodę opisuje poradnik [jak sprawdzić oszczędności na LLM z rachunkiem](/pl/guides/verify-llm-savings-against-provider-bill). Ten sam problem po stronie OpenAI omawia poradnik [dlaczego cached_tokens w OpenAI wynosi 0](/pl/guides/openai-prompt-caching-cached-tokens). Kod jest na [GitHubie](https://github.com/BiVelio/bivelio-savings-layer).
