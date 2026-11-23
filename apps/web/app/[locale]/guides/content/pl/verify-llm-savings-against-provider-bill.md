Każde narzędzie do kosztów LLM pokazuje jakąś liczbę oszczędności. Niewiele z nich pokazuje, jak ją sprawdzić, a to właśnie przy sprawdzaniu większość deklaracji się sypie: panel pokazuje dużą oszczędność, a faktura prawie się nie zmienia. Ten poradnik daje metodę, którą można zastosować z dowolnym narzędziem albo bez żadnego: co logować, jak uzgodnić to z danymi o użyciu od dostawcy, jak odróżnić prawdziwą oszczędność od szacunku i jak upewnić się, że oszczędność wynika z wprowadzonej zmiany. Na końcu zobaczysz, jak otwartoźródłowe SDK BV-SALA oznacza każdą kwotę, żeby takie sprawdzenie było możliwe.

## Dlaczego liczby oszczędności i rachunki się nie zgadzają

Rozbieżność prawie zawsze wynika z jednej z tych przyczyn:

- **Cena katalogowa a Twoja cena.** Narzędzia wyceniają tokeny po publicznych cenach katalogowych. Twoja faktura może uwzględniać rabaty, umowy z zobowiązaniem wykorzystania, stawki regionalne lub za rezydencję danych, poziomy priorytetowe i podatki.
- **Szacunki podawane jako pomiary.** Jeśli narzędzie usunęło z promptu 2000 tokenów, dostawca nigdy ich nie policzył. „Zaoszczędzona” liczba to własne wyliczenie narzędzia, zrobione tokenizerem, który może nie być tokenizerem dostawcy.
- **Rabat dostawcy przypisany narzędziu.** Prompt caching w OpenAI, Anthropic, DeepSeek czy Gemini jest rozliczany przez dostawcę po niższej stawce. Narzędzie, które liczy ten rabat jako własną oszczędność, zawyża swoją liczbę.
- **Ruch, którego narzędzie nigdy nie widziało.** Wywołania z innej usługi, skrypt kolegi z zespołu, poboczne żądania agenta programistycznego czy zadanie wsadowe pojawiają się na rachunku, a nie w narzędziu.
- **Brakujące dane o użyciu.** Strumieniowane żądanie bez końcowego zdarzenia z danymi o użyciu w ogóle nie ma liczby tokenów. Jeśli po cichu policzyć je jako zero, wszystko dalej wygląda taniej.
- **Czas.** Dostawcy grupują użycie według dnia UTC, a część użycia pojawia się z opóźnieniem.

## Metoda krok po kroku

### 1. Loguj liczniki samego dostawcy dla każdego żądania

Nie swój szacunek, tylko blok `usage`, który zwrócił dostawca. Wejście, wejście z cache (i zapisy do cache, tam gdzie istnieją), wyjście, tokeny rozumowania, identyfikator modelu podany przez dostawcę, klucz API lub projekt i znacznik czasu UTC. Żądanie, którego dane o użyciu nie dotarły, oznacz jako **niezmierzone**, nigdy jako zero.

### 2. Uzgadniaj tokeny przed dolarami

Wyeksportuj dzienne użycie od dostawcy dla tych samych kluczy i dni: [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) od OpenAI, [Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) od Anthropic albo strony użycia w konsolach DeepSeek i Model Studio. Potem porównaj pozycja po pozycji:

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

Jeśli tokeny się zgadzają, Twoje logowanie jest kompletne i możesz ufać reszcie analizy. Jeśli dostawca pokazuje więcej, znajdź ruch, którego nie logujesz, zanim pójdziesz dalej.

### 3. Dopiero potem wyceniaj, z datowaną tabelą cen

Pomnóż każdą pozycję przez jej stawkę, zapisz datę skopiowania stawek i porównaj z raportem kosztów dostawcy. Stała różnica rzędu kilku procent to zwykle rabat albo stawka regionalna, a ponieważ jest taka sama z optymalizacją i bez niej, nie zmienia oszczędności.

### 4. Trzymaj osobno trzy rodzaje liczb

- **Zmierzone:** odczytane z licznika dostawcy dla wywołania, które się odbyło.
- **Zmierzone przez odniesienie:** wywołanie, które się nie odbyło (trafienie w cache, deduplikowane żądanie), wycenione licznikiem dostawcy dla identycznego wywołania, które się odbyło. To najlepszy dostępny dowód dla wywołania, którego nigdy nie było.
- **Szacowane:** wszystko, czego dostawca nigdy nie policzył, na przykład tokeny, które narzędzie usunęło z promptu.

Sumuj każdy rodzaj osobno. Nigdy nie dodawaj kwot szacowanych do zmierzonych i nigdy nie uśredniaj procentów po żądaniach: zsumuj pieniądze, a potem podziel.

### 5. Oddziel rabat dostawcy od własnego

Tokeny wejściowe z cache są tańsze dzięki dostawcy. Jeśli niczego nie zmieniono, a odsetek trafień był już wysoki, ten rabat nie jest oszczędnością Twojego projektu. Wyceniaj tokeny z cache po stawce dla cache po obu stronach porównania; to, co zostanie, jest Twoje.

## Czy to zmiana spowodowała oszczędność?

Rachunek, który spadł po wdrożeniu, może też oznaczać spokojny tydzień. Żeby przypisać oszczędność:

- **Uruchom dwa ramiona jednocześnie.** Wysyłaj te same żądania ze zmianą i bez niej, w tym samym czasie, przez ten sam klucz, i porównaj liczniki dostawcy dla obu. Czysta wersja to żądania losowo przydzielane do ramion.
- **Podawaj przedział, a nie pojedynczą wartość.** Przy ponownym próbkowaniu losuj całe rozmowy albo dni i mów „między X a Y %”. Przedział obejmujący zero oznacza, że nie da się odróżnić różnicy od szumu, i jest to uprawniony wynik.
- **Sprawdzaj jakość w tym samym przebiegu.** Tańsza odpowiedź, która jest błędna, nie jest oszczędnością. Mierz w obu ramionach trafność albo wynik testu właściwego dla zadania.

## Jak BV-SALA umożliwia to sprawdzenie

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) to warstwa oszczędności na licencji Apache-2.0, darmowa i bez klucza. Każde żądanie zwraca `SavingsReport` zbudowany dokładnie pod tę metodę:

- `cost.basis` ma wartość `measured`, `reference`, `estimated` albo `unmeasured`, zgodnie z powyższymi definicjami. Powtórzenie jest wyceniane przez odniesienie tylko wtedy, gdy wywołanie, które się odbyło, trafiło bezpośrednio do API OpenAI, Anthropic albo Google Gemini; w każdym innym przypadku pozostaje `estimated`.
- Oszczędności są ewidencjonowane w czterech osobnych księgach, których nigdy nie sumuje się w jedną liczbę: `avoided_calls`, `eliminated_tokens`, `compressed_tokens` i `provider_cached_tokens`.
- Rabat za cache od samego dostawcy jest raportowany osobno, w `report.nativeSavings`, i nigdy nie jest liczony jako oszczędność warstwy.
- Strumień, który kończy się bez danych o użyciu, ma status `unmeasured` i nigdy nie jest wyceniany jako zero.

Zsumowanie raportów według podstawy zajmuje kilka linii:

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

Z Pythona klient z pakietu odczytuje te same raporty z lokalnego gatewaya i zachowuje ten sam podział:

```python
# pip install bivelio-savings-layer
import bvsala

gw = bvsala.Gateway("http://127.0.0.1:8403")
# ... send requests with gw.wrap(client) and read each one with gw.report(response) ...
t = gw.totals()
print(t.requests, t.metered, t.not_metered, t.actual_cost_usd)
print(t.net_savings_usd_by_basis)  # one amount per basis, never added together
```

Następnie wykonaj krok 2 na tych sumach: wydatki `measured` warstwy powinny zgadzać się z użyciem u dostawcy dla tego samego klucza i dnia, w tokenach dokładnie, a w dolarach z dokładnością do Twoich rabatów. Raporty wyceniają po cenie katalogowej; nie są fakturą.

## Ta sama metoda, stosowana publicznie

Projekt publikuje własne przebiegi A/B na [stronie benchmarków](/pl/benchmarks): dwa ramiona na tych samych żądaniach, jedno prosto do dostawcy, drugie przez warstwę, oba mierzone licznikiem użycia samego dostawcy, z przedziałami 95% oraz datą i wersją każdego przebiegu. Wyniki, które nic nie zaoszczędziły albo kosztowały więcej, są na tej samej stronie. Pełna metoda, estymator i jego ograniczenia są opisane w [artykule](/pl/paper).

Szczegóły dla poszczególnych dostawców opisują poradniki [dlaczego cached_tokens w OpenAI wynosi 0](/pl/guides/openai-prompt-caching-cached-tokens), [dlaczego prompt caching w Claude nie działa](/pl/guides/claude-prompt-caching-not-working) i [jak mierzyć koszt Claude Code dla każdego żądania](/pl/guides/claude-code-cost-per-request). Kod i surowe raporty są na [GitHubie](https://github.com/BiVelio/bivelio-savings-layer).
