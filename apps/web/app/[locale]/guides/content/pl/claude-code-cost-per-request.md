„Ile kosztuje Claude Code?” ma dwie uczciwe odpowiedzi. Przy subskrypcji Claude płacisz cenę planu, a koszt za token ma znaczenie dopiero po przekroczeniu jego limitów. Przy kluczu API albo u dostawcy chmurowego płacisz za tokeny, a koszt sesji zależy od tego, ile żądań wysyła Claude Code, jak duże jest każde z nich i jaka ich część jest odczytywana z cache promptów. Ten poradnik pokazuje, co publikuje Anthropic, które wbudowane narzędzia podają sumy i jak za darmo, na własnej maszynie, zobaczyć koszt każdego pojedynczego żądania, żeby znaleźć tury, które sprawiają, że sesja jest droga.

## Ile według Anthropic kosztuje Claude Code

[Strona o kosztach Claude Code](https://code.claude.com/docs/en/costs) od samego Anthropic podaje średnie z wdrożeń firmowych: około $13 na programistę na aktywny dzień i od $150 do $250 na programistę miesięcznie, przy czym 90 % użytkowników mieści się poniżej $30 na aktywny dzień. To średnie z wielu zespołów. Twoja liczba zależy od wybranego modelu, rozmiaru repozytorium i sposobu pracy, i dlatego reszta tego poradnika dotyczy jej mierzenia.

## Wbudowane narzędzia i to, czego nie pokazują

- **`/usage` w Claude Code.** Blok Session pokazuje *szacowany* koszt po cenie katalogowej, z tokenami na model w podziale na wejście, wyjście, odczyty cache i zapisy do cache. Nowsze wersje dodają linię o cache promptów z odsetkiem trafień i liczbą chybień. To suma dla sesji, liczona lokalnie.
- **Claude Console.** Dla kluczy API strony Cost i Usage pokazują, co zostało zafakturowane, w podziale na dzień, workspace i model. To liczba, z którą należy się uzgadniać.
- **Eksport OpenTelemetry.** Claude Code może strumieniować metryki tokenów i kosztów do Twojego własnego stosu obserwowalności, w podziale na użytkownika i sesję ([dokumentacja monitorowania](https://code.claude.com/docs/en/monitoring-usage)).

Żadne z nich nie ułatwia **widoku na poziomie żądania**: która tura była droga i dlaczego. Sesja to dziesiątki lub setki wywołań API, a te drogie mają rozpoznawalne przyczyny:

- **Zimny cache.** Pierwsza tura po przerwie dłuższej niż czas życia cache ponownie wczytuje całą rozmowę po pełnej cenie i zapisuje ją jeszcze raz.
- **Zmiana modelu.** Każdy model ma własny cache, więc zmiana modelu w środku sesji oznacza przetworzenie wszystkiego od nowa.
- **Ogromne wyniki narzędzi.** Log testów albo duży plik odczytany raz zostaje w kontekście każdej kolejnej tury.
- **Za dużo definicji narzędzi.** Serwery MCP potrafią dodać do każdego żądania wiele kilobajtów definicji.
- **Kompaktowanie.** Streszczenie długiej rozmowy samo w sobie jest dużym żądaniem.

## Mierz każde żądanie lokalnym gatewayem

Gateway to mały serwer proxy między Claude Code a API, który odczytuje liczniki użycia z każdej odpowiedzi. Claude Code oficjalnie to wspiera przez `ANTHROPIC_BASE_URL`. [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) dostarcza taki gateway w swoim pakiecie npm: Apache-2.0, **bez klucza, bez rejestracji**, i nic nie jest wysyłane do BiVelio. Wymaga Node.js 20 lub nowszego.

Sposób w jednym poleceniu:

```bash
# Starts a local gateway on a free port, runs Claude Code through it, and stops it on exit.
npx @bivelio/savings-layer claude
```

Wrapper wycisza log poszczególnych żądań, żeby nie rysował się na interfejsie Claude Code. Przy wyjściu wypisuje, ile żądań zmierzył, które przekazał dalej bez pomiaru i dlaczego. Żeby widzieć każde żądanie na bieżąco, albo poproś o log na stderr:

```bash
BVSALA_GATEWAY_LOG=1 npx @bivelio/savings-layer claude
```

albo uruchom gateway w osobnym terminalu, na stałym porcie:

```bash
# Terminal 1: the gateway (Anthropic is the default upstream, port 8402)
npx @bivelio/savings-layer gateway

# Terminal 2: Claude Code, pointed at it (no /v1 at the end).
# ENABLE_TOOL_SEARCH=true only matters before Claude Code v2.1.304 (see below).
ENABLE_TOOL_SEARCH=true ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude
```

Każde żądanie staje się jedną linią. Te dwie pochodzą z lokalnego testu na serwerze zastępczym, z wymyślonym ruchem, więc format jest prawdziwy, a liczby nie są Twoje:

```text
[gateway] POST /v1/messages  · claude-sonnet-5 · $0.007700 (in 40, cache↑3000 cache↓0, out 12)
[gateway] POST /v1/messages  · claude-sonnet-5 · $0.000800 (in 40, cache↑0 cache↓3000, out 12)
```

Czytaj od lewej do prawej: model, koszt po standardowej cenie katalogowej modelu (wyjątkiem są tury w trybie szybkim, o czym niżej), potem tokeny wejściowe rozliczone w całości, tokeny zapisane do cache (`cache↑`), odczytane z niego (`cache↓`) i tokeny wyjściowe. Pierwsza linia to zimna tura, która zapisuje prefiks; druga odczytuje go z powrotem za ułamek ceny. Sesja, w której wartość `cache↑` tura po turze pozostaje duża, ma problem z cache: zobacz [dlaczego prompt caching w Claude przestaje działać](/pl/guides/claude-prompt-caching-not-working).

`ENABLE_TOOL_SEARCH=true` zależy od Twojej wersji Claude Code. Od v2.1.304 wyszukiwanie narzędzi (tool search) pozostaje włączone za gatewayem ([dokumentacja MCP Claude Code](https://code.claude.com/docs/en/mcp)), a zmienna niczego nie zmienia. Przed v2.1.304 Claude Code wyłączał wyszukiwanie narzędzi za każdym base URL innym niż Anthropic i wkładał każdą definicję narzędzia do każdego żądania. W tych starszych wersjach było to drogie: przewodnik gatewaya dla Claude Code, dołączony do pakietu npm, opisuje konfigurację z 226 narzędziami MCP, zmierzoną 9 września 2026 r., w której oznaczało to 450 KB na żądanie i jedną czwartą rachunku z tego dnia. Wrapper `claude` ustawia tę zmienną za Ciebie, chyba że już ją ustawiono.

## Co gateway widzi, a czego nie

- **Przekazuje dalej to, co wysyła Claude Code.** Gdy na żądanie nie działa żadna dźwignia, body dociera do Anthropic bajt w bajt, łącznie ze znacznikami `cache_control` i nagłówkiem `anthropic-beta`, więc cache działa dokładnie tak samo jak bez gatewaya. Test w repozytorium sprawdza to przy każdej zmianie na atrapie upstreamu.
- **Dwa małe wywołania go omijają.** Według [przewodnika po zgodności z gatewayami](https://code.claude.com/docs/en/llm-gateway-protocol) Claude Code sprawdzenie dostępności trybu szybkiego i sprawdzenie bezpieczeństwa domeny przez WebFetch wywołują `api.anthropic.com` bezpośrednio, zamiast podążać za `ANTHROPIC_BASE_URL`. Żadne z nich nie jest żądaniem do modelu: samo wnioskowanie w trybie szybkim podąża za base URL i przechodzi przez gateway.
- **Tury w trybie szybkim są logowane po cenie standardowej.** Anthropic oznacza żądanie w trybie szybkim przez `speed: "fast"` i nalicza za nie dopłatę: $8 za wejście i $40 za wyjście za milion tokenów w Claude Opus 5.5, dwa razy więcej niż stawka standardowa, z mnożnikami cache na dokładkę ([dokumentacja trybu szybkiego](https://platform.claude.com/docs/en/build-with-claude/fast-mode)). Wersja 1.2.3 gatewaya nie czyta `speed`, więc liczy te tokeny poprawnie, ale wycenia je jak tury standardowe: w Opus 5.5 to połowa tego, co nalicza Anthropic. Jeśli używasz `/fast`, suma gatewaya dla tych tur jest za niska.
- **Ruch z subskrypcji jest mierzony, a nie fakturowany.** Przy logowaniu przez Claude Pro albo Max nie ma faktury za tokeny; gateway wycenia ten ruch według równowartości ceny katalogowej, żeby był widoczny, i nie przypisuje mu żadnej oszczędności.

## Czy gateway też oszczędza pieniądze?

Od razu po instalacji, z Claude Code na kluczu API, tylko mierzy i niczego nie oszczędza. Nie traktuj komunikatu startowego wersji 1.2.3 jak obietnicy: mówi, że wszystkie lokalne dźwignie oszczędności są włączone, a podsumowanie przy wyjściu liczy tylko zmierzone żądania, więc ani jedno, ani drugie nie mówi, że oszczędność wyniosła zero. Domyślna dźwignia gatewaya obniża czas życia zapisu do cache z jednej godziny do pięciu minut w turach, w których duża część żądania jest nowa, bo zapis na godzinę kosztuje dwa razy cenę wejścia, a zapis na pięć minut 1.25 raza. Claude Code na kluczu API i tak prosi o pięć minut, chyba że ustawisz `promptCacheTtl` na `1h`, więc nie ma czego obniżać.

Gdy w grę wchodzi cache na godzinę, oszczędność jest mała i zależy od Twojego ruchu. [Strona benchmarków](/pl/benchmarks#gateway-ttl) publikuje odtworzenie (replay) własnego ruchu Claude Code jednej organizacji: netto **+2.49 %** rachunku po cenie katalogowej ($113.45 z $4,563.61), z przedziałem 95 % od +1.50 % do +3.57 % przy ponownym próbkowaniu po sesjach i górnym limitem 7.2 % dla każdej polityki tego rodzaju. Na jednym modelu wynik był bliski zera, a w jednym okresie przyniósł stratę. To odtworzenie z częściowo zrekonstruowaną linią bazową, a nie faktura, i strona wymienia każde ograniczenie.

## Sprawdź liczby gatewaya z rachunkiem

1. **Z `/usage`.** Dla jednej sesji zsumuj koszty poszczególnych żądań z gatewaya i porównaj je z blokiem Session w `/usage`. Oba wyceniają te same liczniki po cenie katalogowej, więc powinny być blisko, z wyjątkiem tur w trybie szybkim, które `/usage` wycenia według stawki trybu szybkiego, a gateway 1.2.3 według standardowej.
2. **Z Console.** Przez jeden dzień używaj osobnego klucza API lub workspace'u, a potem porównaj sumy gatewaya na model ze stroną Usage w Console dla tego klucza: wejście, wyjście, zapisy do cache i odczyty cache, najpierw w tokenach, potem w dolarach.
3. **Wyjaśnij każdą różnicę.** Cena katalogowa nie zawsze jest Twoją ceną: rabaty umowne, rezydencja danych albo poziomy priorytetowe zmieniają kwoty, ale nie liczby tokenów. Tryb szybki również: przy włączonym `/fast` suma gatewaya jest niższa niż w Console, bo 1.2.3 wycenia tury w trybie szybkim według stawki standardowej. Ruch, który nie przeszedł przez ten gateway, na przykład z innej maszyny, skryptu albo zadania CI na tym samym kluczu, pojawia się tylko w Console.

Jeśli liczby tokenów się zgadzają, a dolary nie, różnica wynika z cen, a nie z pomiaru. Pełną metodę opisuje [jak sprawdzić oszczędności na LLM z rachunkiem dostawcy](/pl/guides/verify-llm-savings-against-provider-bill).

## Jak obciąć rachunek, gdy już go widać

Z liczbami dla każdego żądania przed oczami typowe poprawki są proste: czyść kontekst między niepowiązanymi zadaniami, zamiast ciągnąć długi kontekst, wybierz model przed sesją i trzymaj się go, kompaktuj w naturalnych przerwach, trzymaj duże logi poza kontekstem i wyłącz serwery MCP, których nie używasz. Korzystanie z modelu innego dostawcy za Claude Code opisuje poradnik [koszty API DeepSeek i Qwen](/pl/guides/deepseek-qwen-api-cost-local-gateway).

Kod źródłowy gatewaya, jego przewodnik dla Claude Code i testy, które sprawdzają, że przekazuje on żądania bez zmian, są na [GitHubie](https://github.com/BiVelio/bivelio-savings-layer).
