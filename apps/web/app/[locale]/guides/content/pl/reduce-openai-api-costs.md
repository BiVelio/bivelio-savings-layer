Rachunek od OpenAI to suma kilku liczb na każde żądanie: niecache'owanych tokenów wejściowych, tokenów wejściowych z cache, zapisów do cache (w GPT-5.6 i nowszych), tokenów wyjściowych (łącznie z rozumowaniem) i ceny modelu. Każdy sposób na jego obniżenie przesuwa którąś z tych liczb. Ten poradnik omawia dźwignie w kolejności, w jakiej zwykle się opłacają, mówi, kiedy któraś się nie opłaca, i pokazuje, jak udowodnić każdą oszczędność własnymi danymi o użyciu z OpenAI, a nie prognozą. Większość z tego nie wymaga żadnego narzędzia; tam, gdzie otwartoźródłowe SDK BV-SALA automatyzuje którąś dźwignię, zobaczysz, jak to robi.

## Zacznij od pomiaru każdego żądania

Zanim cokolwiek zmienisz, loguj blok `usage` każdej odpowiedzi razem z funkcją lub szablonem promptu, który ją wygenerował: `prompt_tokens`, `prompt_tokens_details.cached_tokens`, `cache_write_tokens` tam, gdzie model go zwraca, `completion_tokens`, a w modelach rozumujących także `completion_tokens_details.reasoning_tokens`. Wyceń każdą pozycję według stawek ze strony z cennikiem OpenAI i zapisz datę ich skopiowania. W GPT-5.6 i nowszych zapisy do cache to osobna pozycja: OpenAI nalicza za nie 1.25 raza stawkę za niecache'owane wejście przy domyślnym czasie życia 30 minut i 2.5 raza przy czasie życia 12 godzin ([przewodnik po prompt cachingu](https://developers.openai.com/api/docs/guides/prompt-caching), stan na 23 listopada 2026 r.). Jeśli wycenisz je jak zwykłe wejście, zaniżysz koszt. Tydzień takich danych odpowiada na jedyne pytanie, które liczy się na początku: **które dwie lub trzy funkcje generują większość rachunku.** Optymalizuj je; resztę pomiń.

## 1. Nie płać dwa razy za to samo żądanie

Ponowienia, podwójne kliknięcia, nocne zadania, które ponownie klasyfikują wczorajsze elementy, i równoległe workery wysyłające ten sam prompt kosztują każdorazowo pełne wywołanie. Cache odpowiedzi z dokładnym dopasowaniem i deduplikacja żądań w locie eliminują je, nie zmieniając ani jednej odpowiedzi. To, ile zaoszczędzisz, zależy wyłącznie od tego, jak często Twoje żądania się powtarzają, więc najpierw zmierz odsetek duplikatów. Pełny poradnik: [deduplikacja identycznych żądań do LLM](/pl/guides/deduplicate-llm-requests).

## 2. Pozwól działać cache'owi promptów OpenAI

Prompty od około 1,024 tokenów wzwyż są cache'owane automatycznie, a tokeny wejściowe z cache są rozliczane ze zniżką. W GPT-5.6 i nowszych zapełnianie cache nie jest darmowe: zapisana do niego część kosztuje, jak opisano wyżej, więcej niż stawka za niecache'owane wejście, więc prompt zapisany i nigdy więcej nieodczytany kosztuje więcej niż bez cache, a taki, który zostanie wkrótce odczytany ponownie, dużo mniej. Starsze modele nie doliczają nic za zapisy. Cache dopasowuje wyłącznie od pierwszego tokena, więc działa tylko wtedy, gdy początek promptu jest identyczny między żądaniami. Instrukcje, definicje narzędzi i przykłady umieść na początku, a daty, nazwy użytkowników i pytanie na końcu. Jeśli `cached_tokens` utknęło na 0, zobacz [dlaczego cached_tokens w OpenAI wynosi 0](/pl/guides/openai-prompt-caching-cached-tokens).

## 3. Pracę, która może poczekać, wyślij do Batch API

Ewaluacje, uzupełnianie danych wstecz, embeddingi zbioru dokumentów i nocna klasyfikacja nie potrzebują odpowiedzi w dwie sekundy. [Batch API](https://developers.openai.com/api/docs/guides/batch) od OpenAI przyjmuje plik z żądaniami, zwraca wyniki w ciągu doby i nalicza za nie niższą stawkę niż za te same żądania wysyłane pojedynczo (aktualne warunki znajdziesz w [przewodniku po optymalizacji kosztów](https://developers.openai.com/api/docs/guides/cost-optimization)). Przy pracy offline to często największa pojedyncza oszczędność, a odpowiedzi się nie zmieniają.

## 4. Użyj najmniejszego modelu, który przechodzi Twoją ewaluację

Różnice cen między klasami modeli są duże, a wiele zadań (klasyfikacja, ekstrakcja, krótkie przeredagowania, routing) nie potrzebuje największego modelu. Zbuduj mały zestaw ewaluacyjny z prawdziwych żądań, uruchom go na dwóch lub trzech modelach i wybierz najtańszy, który go przechodzi. Powtórz to, gdy wyjdzie nowy model. Bez ewaluacji przejście na tańszy model to zgadywanie, a koszt błędnych odpowiedzi nie pojawia się na rachunku za API.

## 5. Kontroluj wyjście

Tokeny wyjściowe kosztują zwykle kilka razy więcej niż wejściowe, a tokeny rozumowania są rozliczane jak wyjście.

- Ustaw `max_completion_tokens` na tyle, ile funkcja naprawdę potrzebuje.
- W modelach rozumujących obniż poziom rozumowania w zadaniach, które nie wymagają głębokiego rozumowania, i zmierz `reasoning_tokens` przed zmianą i po niej.
- Proś o ustrukturyzowane wyjście ze schematem JSON, gdy Twój kod parsuje odpowiedź. Błąd parsowania, po którym następuje ponowienie, oznacza zapłatę za całe żądanie dwa razy.

## 6. Wysyłaj mniej na wejściu

- Nie wysyłaj ponownie całej rozmowy, jeśli zadanie potrzebuje tylko ostatnich tur.
- Usuwaj duże wyniki narzędzi (logi, zawartość plików, wyniki wyszukiwania) z kolejnych tur, gdy już zostały wykorzystane.
- Przesyłaj ustrukturyzowane dane w zwartej postaci: sformatowany JSON z wcięciami marnuje tokeny na białe znaki.
- Pobieraj trzy istotne akapity zamiast wklejać cały dokument.

Uważaj na dwie ostatnie rady w długich pętlach agentów: edycja środka historii, którą OpenAI już ma w cache, sprawia, że wszystko po edycji jest rozliczane od nowa, po stawce za niecache'owane wejście albo, w GPT-5.6 i nowszych, po wyższej stawce za zapis, gdy trafi do cache ponownie. Skracaj to, co nowe, a nie to, co jest w cache.

## Jak BV-SALA automatyzuje część z nich

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) to warstwa oszczędności na licencji Apache-2.0, która w TypeScripcie opakowuje dowolny endpoint zgodny z OpenAI. Oszczędza wszystkimi dźwigniami **za darmo, bez klucza i bez rejestracji** i nie wysyła nic do BiVelio, chyba że dodasz klucz do opcjonalnego panelu w chmurze. Domyślnie włączone: dokładna pamięć podręczna, deduplikacja identycznych żądań w locie, lokalne odpowiadanie na gołą arytmetykę i zwarta serializacja przekazywanych danych ustrukturyzowanych. Do włączenia, każda jedną opcją: kaskada modeli, kompaktowanie wyników narzędzi i przestawianie promptu pod cache'owalny prefiks. Każde żądanie zwraca raport, który mówi, co zaoszczędzono i skąd pochodzi ta liczba.

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({
    baseUrl: "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY,
  }),
});

const { text, report } = await layer.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
});
console.log(text); // "8": computed on your machine, no call to OpenAI
console.log(report.calls.avoidedLlm); // 1: a whole call you did not pay for
console.log(report.cost.basis); // "estimated": nothing ran, so there is no provider counter to read
```

Dwa uczciwe ograniczenia. Po pierwsze, ruch, który nigdy się nie powtarza, oszczędza na cache i deduplikacji około 0 %, i tak ma być. Po drugie, domyślne przycinanie zastąpionych wyników narzędzi może w długich pętlach agentów kosztować więcej, niż oszczędza, u dostawcy, który cache'uje cały prompt: changelog projektu podaje +12.2 % w pętli z 60 krokami na `gpt-5`, zmierzone na atrapie dostawcy z wersjami 1.2.3 i 1.2.4 i bez klucza. W długich pętlach agentów przekaż w żądaniu `savings: { elision: false }` i porównaj.

## Udowodnij każdą oszczędność liczbami z OpenAI

Oszczędność, której nie da się sprawdzić, to prognoza. Dla każdej dźwigni:

1. **Wybierz licznik, który powinna poruszyć.** Cache i deduplikacja zmieniają liczbę żądań. Prompt caching zmienia `cached_tokens`, a w GPT-5.6 i nowszych także `cache_write_tokens`. Batch zmienia cenę. Wybór modelu zmienia cenę za token. Kontrola wyjścia zmienia `completion_tokens`.
2. **Odczytaj ten licznik z OpenAI.** [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) zwraca liczbę żądań oraz tokeny wejściowe, wejściowe z cache i wyjściowe w podziale na dzień, model, projekt i klucz. Kwoty podają endpoint Costs i panel użycia.
3. **Porównuj porównywalne.** Ta sama funkcja, te same dni tygodnia, przed i po, a jeszcze lepiej dwa ramiona tego samego ruchu w tym samym czasie. Najpierw patrz na tokeny, potem na dolary: dolary zmieniają się także razem z cenami.

Z warstwą każdy raport zawiera `cost.basis`: kwoty `measured` i `reference` pochodzą z licznika samego OpenAI, kwoty `estimated` są raportowane osobno i nigdy nie są do nich doliczane. Pełna metoda: [jak sprawdzić oszczędności na LLM z rachunkiem dostawcy](/pl/guides/verify-llm-savings-against-provider-bill).

## Co mówią opublikowane liczby

[Strona benchmarków](/pl/benchmarks) projektu mierzy oba ramiona każdego testu licznikiem użycia samego dostawcy. Na publicznym obciążeniu zbudowanym z pytań GSM8K, w którym 30 % żądań stanowiły dokładne powtórzenia, łączna redukcja na `gpt-4o-mini` wyniosła **31.50 %**, z przedziałem 95 % od 25.7 % do 36.7 % (artefakty SDK 0.4.31, wrzesień 2026; także w README). Na dwuturowym czacie bez powtórzeń (MT-Bench) różnice były nieodróżnialne od zera albo nie dało się ich przypisać warstwie, i strona mówi to wprost. Metoda, przedziały i wszystkie ograniczenia są opisane w [artykule](/pl/paper). Kod jest na [GitHubie](https://github.com/BiVelio/bivelio-savings-layer).
