DeepSeek i Qwen są tanie w przeliczeniu na token, przez co łatwo przestać pilnować rachunku. Obaj dostawcy cache'ują prompty po swojej stronie, a wejście, które trafia w cache, jest rozliczane dużo taniej niż wejście, które w niego nie trafia. Prawdziwy koszt Twojego ruchu zależy więc od liczby, którą większość paneli ukrywa: ile tokenów wejściowych trafia w cache przy każdym żądaniu. Ten poradnik wyjaśnia, jak obaj dostawcy rozliczają i cache'ują, jak wycenić żądanie na podstawie jego pól użycia i jak zobaczyć to dla każdego żądania dzięki darmowemu lokalnemu gatewayowi.

## Jak DeepSeek rozlicza żądanie

DeepSeek dzieli wejście każdego żądania na dwie części: tokeny, które trafiają w jego cache kontekstu, i tokeny, które w niego nie trafiają, każda z tych grup z własną ceną, plus tokeny wyjściowe. Jego [context caching](https://api-docs.deepseek.com/guides/kv_cache) jest domyślnie włączony dla każdego konta. Trafienie wymaga, żeby początek żądania dokładnie pasował do wcześniejszego, cache działa w trybie best effort, a nieużywane wpisy są usuwane po kilku godzinach lub dniach. Odpowiedź mówi, co się stało:

- `usage.prompt_cache_hit_tokens`: tokeny wejściowe podane z cache.
- `usage.prompt_cache_miss_tokens`: tokeny wejściowe przetworzone w całości.
- `usage.prompt_tokens_details.cached_tokens`: ta sama liczba trafień, w polu, które odczytują narzędzia zgodne z OpenAI.

[Strona z cennikiem](https://api-docs.deepseek.com/quick_start/pricing) DeepSeek podaje dla każdego modelu ceny trafienia, chybienia i wyjścia oraz okno poza szczytem z niższą ceną. Ceny się zmieniają; kopiuj je razem z datą odczytu.

## Jak Qwen rozlicza żądanie

Modele Qwen w Alibaba Cloud Model Studio mają dwa rodzaje [cache kontekstu](https://www.alibabacloud.com/help/en/model-studio/context-cache). Cache niejawny działa automatycznie dla promptów powyżej minimalnej długości, a jego trafienia są rozliczane ze zniżką. Cache jawny działa jak w Anthropic: oznaczasz blok przez `cache_control`, wpis żyje kilka minut, a zapis kosztuje trochę więcej niż zwykłe wejście, za to odczyt dużo mniej. W API zgodnym z OpenAI liczba trafień przychodzi w `usage.prompt_tokens_details.cached_tokens`. Model Studio ma endpointy regionalne, więc sprawdź, do którego należy Twój klucz.

## Jak trafiać w cache u obu dostawców

Zasady są takie same jak przy każdym cache prefiksu:

1. Na początek daj to, co nigdy się nie zmienia: prompt systemowy, definicje narzędzi, długi tekst referencyjny, przykłady few-shot.
2. Utrzymuj to identyczne bajt w bajt między żądaniami: żadnych znaczników czasu, identyfikatorów żądań ani nazw użytkowników w środku, a definicje narzędzi w stałej kolejności.
3. Na koniec daj to, co się zmienia: pytanie użytkownika, ostatni wynik narzędzia.
4. W agentach dopisuj do historii zamiast ją przepisywać. Edycja starej wiadomości w środku unieważnia wszystko, co jest po niej.

## Policz koszt jednego żądania

Do wyceny żądania nie potrzebujesz żadnego narzędzia. Odczytaj blok użycia i pomnóż każdą pozycję przez jej cenę:

```python
def request_cost(usage: dict, price_miss: float, price_hit: float, price_out: float) -> float:
    """USD cost of one chat completion. Prices are per million tokens, from the provider's pricing page."""
    details = usage.get("prompt_tokens_details") or {}
    hit = usage.get("prompt_cache_hit_tokens", details.get("cached_tokens", 0)) or 0
    miss = usage["prompt_tokens"] - hit
    return (miss * price_miss + hit * price_hit + usage["completion_tokens"] * price_out) / 1_000_000
```

Loguj tę liczbę dla każdego żądania razem z modelem, udziałem trafień (`hit / prompt_tokens`) i znacznikiem czasu, a odpowiesz na pytania, które mają znaczenie: która funkcja kosztuje najwięcej, czy odsetek trafień w cache spadł po wdrożeniu i jaka część Twojego ruchu przypada na okno poza szczytem.

## Zobacz każde żądanie dzięki lokalnemu gatewayowi

Żeby nie zmieniać kodu w każdym miejscu wywołania, postaw gateway przed dostawcą. [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) dostarcza taki gateway w swoim pakiecie npm: Apache-2.0, lokalnie, **bez klucza i bez rejestracji**, i nic nie jest wysyłane do BiVelio. Uruchom jeden gateway na dostawcę, każdy na własnym porcie:

```bash
# DeepSeek
npx @bivelio/savings-layer gateway --upstream deepseek --port 8403

# Qwen on Model Studio's international endpoint (`--upstream qwen` is the Beijing one)
npx @bivelio/savings-layer gateway --upstream https://dashscope-intl.aliyuncs.com --port 8404
```

Gateway przekazuje dostawcy ścieżkę, którą wysyła Twój klient, więc Twoim base URL jest adres samego dostawcy z gatewayem jako hostem:

| Dostawca | `--upstream` | Base URL dla Twojego klienta OpenAI |
| --- | --- | --- |
| DeepSeek | `deepseek` | `http://127.0.0.1:8403` |
| Qwen (Pekin) | `qwen` | `http://127.0.0.1:<port>/compatible-mode/v1` |
| Qwen (międzynarodowy) | `https://dashscope-intl.aliyuncs.com` | `http://127.0.0.1:8404/compatible-mode/v1` |
| GLM | `glm` | `http://127.0.0.1:<port>/api/paas/v4` |

`npx @bivelio/savings-layer --help` wymienia pozostałe upstreamy (Moonshot, MiniMax, OpenRouter, Gemini, Ollama, vLLM, LM Studio).

W Pythonie mały klient z pakietu ustawia base URL za Ciebie: zbuduj zwykły klient OpenAI dla dostawcy, a `wrap()` zwróci kopię, która idzie przez gateway i zachowuje ścieżkę dostawcy.

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

Dla Qwen działa to tak samo z drugim gatewayem i `OpenAI(base_url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1", ...)`. Jeśli ustawiona jest zmienna proxy HTTP, dodaj `NO_PROXY=127.0.0.1,localhost` przed utworzeniem klienta, inaczej żądania do lokalnego gatewaya, razem z kluczem dostawcy, pójdą przez proxy; wersja 1.2.5 ostrzega, gdy tak by się stało. Jeśli żaden gateway nie działa, `wrap()` zgłasza `GatewayUnavailable` zamiast wywoływać dostawcę bezpośrednio i podaje, jak uruchomić gateway, bez klucza.

Każdy inny język czy narzędzie też zadziała: skieruj jego base URL dla OpenAI na gateway, a każde żądanie stanie się jedną linią w logu gatewaya, z modelem, kosztem po cenie katalogowej i wejściem w podziale na tokeny w pełnej cenie i odczyty z cache (`cache↓`).

Jeden wyjątek ma znaczenie dla narzędzi czatowych i agentów: **strumieniowane** żądanie, które nie prosi o dane o użyciu (`stream_options: {"include_usage": true}`), nie dostaje ich od dostawcy, więc wersja 1.2.5 loguje je jako `not metered: the request did not ask for usage`. Poproś o dane o użyciu w swoim kliencie albo uruchom gateway z `BVSALA_GATEWAY_USAGE_INJECT=1`, co dodaje tę opcję do strumieni, którym jej brakuje. Ostatni fragment takich strumieni ma wtedy pustą listę `choices`, czego nie spodziewa się kod odczytujący `choices[0]` bez sprawdzenia.

## Agenty programistyczne na DeepSeek lub Qwen

DeepSeek udostępnia też endpoint w formacie Anthropic i opisuje, jak używać go z Claude Code. Z `--upstream deepseek` gateway sam wysyła żądania w formacie Anthropic do tego endpointu:

```bash
npx @bivelio/savings-layer gateway --upstream deepseek --port 8402
ANTHROPIC_BASE_URL=http://127.0.0.1:8402 ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY" ANTHROPIC_MODEL=deepseek-flash claude
```

Na tej ścieżce gateway mierzy, ale niczego nie oszczędza: endpoint DeepSeek w formacie Anthropic ignoruje `cache_control` i nie raportuje zapisów do cache ([jego przewodnik](https://api-docs.deepseek.com/guides/anthropic_api)), więc domyślna dźwignia nie ma czego obniżać. Uruchamianie modelu innego niż Claude za Claude Code to integracja DeepSeek, a nie konfiguracja wspierana przez Anthropic, a ocena jakości modelu w Twojej pracy należy do Ciebie.

**Qwen Code z modelami Qwen** wymaga innej drogi: w wersji 1.2.5 `npx @bivelio/savings-layer qwen` zakłada, że Qwen Code używa typu uwierzytelniania Anthropic, i przekazuje ruch do API Anthropic, więc mierzy tylko modele Claude używane z kluczem Anthropic i odrzuca base URL DashScope w formacie Anthropic. Dla modeli Qwen użyj trybu zgodnego z OpenAI w Qwen Code, który [jego dokumentacja](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/) konfiguruje przez `OPENAI_API_KEY`, `OPENAI_BASE_URL` i `OPENAI_MODEL`, i skieruj ten base URL na gateway. Ustaw `DASHSCOPE_PROXY_BASE_URL` na dokładnie ten sam URL:

```bash
npx @bivelio/savings-layer gateway --upstream https://dashscope-intl.aliyuncs.com --port 8404

GW=http://127.0.0.1:8404/compatible-mode/v1
OPENAI_BASE_URL="$GW" DASHSCOPE_PROXY_BASE_URL="$GW" OPENAI_API_KEY="$DASHSCOPE_API_KEY" OPENAI_MODEL=qwen-plus qwen
```

Druga zmienna ma znaczenie dla rachunku. Qwen Code na podstawie hosta w base URL decyduje, czy rozmawia z DashScope, a `127.0.0.1` nie jest hostem DashScope. Bez tej zmiennej wraca do swojego ogólnego dostawcy OpenAI, który nie wysyła znaczników jawnego cache (`cache_control` i nagłówka `X-DashScope-CacheControl`). Twoje żądania trafiają wtedy do niejawnego cache Model Studio, gdzie trafienia kosztują zwykle 20% ceny wejścia i działają w trybie best effort, zamiast do jawnego cache za 10% ([cache kontekstu](https://www.alibabacloud.com/help/en/model-studio/context-cache)). Qwen Code traktuje base URL, który dokładnie pasuje do `DASHSCOPE_PROXY_BASE_URL`, jako DashScope i zachowuje znaczniki ([jego dostawca DashScope](https://github.com/QwenLM/qwen-code/blob/8fab857da5/packages/core/src/core/openaiContentGenerator/provider/dashscope.ts), stan na 23 listopada 2026 r.).

Stronę gatewaya w tej ścieżce sprawdziliśmy w wersji 1.2.5 (oba znaczniki przechodzą bez zmian), a nie samo Qwen Code, więc czytaj log gatewaya: jedna linia z kosztem na każde żądanie. Linia `not metered` mówi dlaczego: zwykle chodzi o strumień, który nie prosi o dane o użyciu (uruchom gateway ponownie z `BVSALA_GATEWAY_USAGE_INJECT=1`), albo o model bez wiersza w katalogu 1.2.5, który ma `qwen-plus`, `qwen-flash`, `qwen3.7-flash`, `qwen3.8-flash` i `qwen3.8-max`, ale nie ma na przykład `qwen3-coder-plus`.

Dwie luki w wycenie w 1.2.5 zależą od drugiej zmiennej. **Z ustawionym `DASHSCOPE_PROXY_BASE_URL`**, jak wyżej, Model Studio nalicza za każdy zapis do jawnego cache 125% ceny wejścia i raportuje go w `usage.prompt_tokens_details.cache_creation_input_tokens`. Gateway 1.2.5 nie czyta tego pola: loguje te tokeny jako zwykłe wejście, z `cache↑0`, po 80% tego, co kosztują. Jego cena trafienia dla `qwen-plus` to 10%, jak w jawnym cache, co się zgadza. **Bez tej zmiennej** nie ma jawnych zapisów, ale trafienia są niejawne, rozliczane po około 20%, a gateway loguje je po tych samych 10%, czyli mniej więcej za połowę ich kosztu.

## Co gateway mierzy, a czego nie

- **Kwota w dolarach pochodzi z katalogu, a nie z cen DeepSeek zależnych od pory dnia.** Wersja 1.2.5 ma wiersze dla `deepseek-flash` i `deepseek-v4-pro`. Dla chybień cache i wyjścia używają ceny DeepSeek w szczycie, więc poza szczytem te pozycje pokazują dwa razy więcej, niż nalicza DeepSeek. Dla trafień w cache oba wiersze używają 0,003 USD za milion tokenów, czyli ceny trafienia poza szczytem w DeepSeek dla `deepseek-flash` (w szczycie jest dwa razy wyższa) i mniej niż obie ceny trafienia, które DeepSeek publikuje dla `deepseek-v4-pro` ([strona z cennikiem](https://api-docs.deepseek.com/quick_start/pricing), stan na 23 listopada 2026 r.). W zależności od godziny i od tego, jaka część Twojego wejścia trafia w cache, suma gatewaya może wyjść powyżej albo poniżej rachunku. Liczby tokenów są dokładne; porównuj je najpierw. Klasyczny alias `deepseek-chat` nie ma wiersza: jest przekazywany dalej, a log mówi, że nie został zmierzony.
- **Nie zmienia tych żądań.** Przy ruchu zgodnym z OpenAI gateway mierzy i przekazuje dalej (jedynym wyjątkiem jest opcjonalne wstrzykiwanie danych o użyciu opisane wyżej); jego dźwignie oszczędności są przeznaczone dla ruchu w formacie Anthropic. Oszczędność na DeepSeek i Qwen pochodzi z ich własnych cache, dlatego liczba trafień jest tą liczbą, którą warto obserwować.

## Jeśli wywołujesz DeepSeek albo Qwen z TypeScriptu

SDK BV-SALA rozmawia z dowolnym endpointem zgodnym z OpenAI i pomija dokładne powtórzenia oraz identyczne żądania w locie, za darmo i bez klucza ([jak to działa](/pl/guides/deduplicate-llm-requests)). Na DeepSeek te uniknięte wywołania są raportowane jako `estimated`, a nie `reference`: wersja 1.2.5 wycenia powtórzenie przez odniesienie tylko wtedy, gdy wywołanie, które się odbyło, trafiło do własnego API OpenAI, Anthropic albo Google. Jedna przestroga dla pętli agentów: domyślne przycinanie zastąpionych wyników narzędzi przepisuje środek historii, a u dostawcy, który sam cache'uje cały prompt, może to kosztować więcej, niż oszczędza. Changelog projektu podaje +166% w pętli agenta z 60 krokami na DeepSeek, zmierzone na atrapie dostawcy z wersjami 1.2.3 i 1.2.4 i bez klucza; 1.2.5 przycina tak samo. W pętlach agentów wyłączaj je dla każdego żądania:

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

## Sprawdź liczby z dostawcą

Raz dziennie porównuj sumy gatewaya na model (wejście, trafienia w cache, wyjście) ze stroną użycia platformy DeepSeek albo Model Studio dla tego samego klucza. Łączne liczby tokenów powinny się zgadzać, z jednym wyjątkiem w ich podziale: na Qwen wersja 1.2.5 liczy zapisy do jawnego cache jako zwykłe wejście, a nie jako zapisy do cache. Kwoty w dolarach mogą się różnić, w obu kierunkach: katalog pomija ceny DeepSeek zależne od pory dnia, na Qwen wycenia zapisy do jawnego cache jak zwykłe wejście, a trafienia niejawne według stawki jawnej; ceny regionalne i rabaty również zmieniają kwoty. Metodę krok po kroku opisuje [jak sprawdzić oszczędności na LLM z rachunkiem dostawcy](/pl/guides/verify-llm-savings-against-provider-bill). Kod gatewaya i jego przewodniki dla poszczególnych terminali są na [GitHubie](https://github.com/BiVelio/bivelio-savings-layer), a to, co projekt zmierzył, i czego nie zmierzył, jest na [stronie benchmarków](/pl/benchmarks).
