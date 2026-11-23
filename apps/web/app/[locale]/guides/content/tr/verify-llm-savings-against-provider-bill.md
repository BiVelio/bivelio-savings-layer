Her LLM maliyet aracı bir tasarruf rakamı gösterir. Pek azı bunun nasıl kontrol edileceğini gösterir ve iddiaların çoğu tam da bu kontrolde çöker: Panel büyük bir tasarruf gösterir, fatura ise neredeyse hiç kıpırdamaz. Bu rehber, herhangi bir araçla ya da hiçbir araç olmadan uygulayabileceğiniz bir yöntem sunuyor: Neyi loglayacağınızı, bunu sağlayıcının kullanım verileriyle nasıl mutabık hale getireceğinizi, gerçek bir tasarrufu bir tahminden nasıl ayıracağınızı ve tasarrufun yaptığınız değişiklikten geldiğinden nasıl emin olacağınızı. Sonunda, açık kaynaklı BV-SALA SDK'sının bu kontrolü mümkün kılmak için her tutarı nasıl etiketlediğini göreceksiniz.

## Tasarruf rakamları ile faturalar neden uyuşmaz

Fark neredeyse her zaman bunlardan birinden gelir:

- **Liste fiyatı ile sizin fiyatınız.** Araçlar token'ları herkese açık liste fiyatlarıyla fiyatlar. Faturanız indirimler, taahhütlü kullanım sözleşmeleri, bölgesel ya da veri yerleşimi tarifeleri, öncelik katmanları ve vergiler içerebilir.
- **Ölçüm gibi sunulan tahminler.** Bir araç bir prompt'tan 2.000 token çıkardıysa sağlayıcı onları hiç saymadı. "Tasarruf edilen" rakam, aracın kendi sayımıdır ve sağlayıcınınki olmayabilecek bir tokenizer ile yapılmıştır.
- **Aracın hanesine yazılan sağlayıcı indirimi.** OpenAI, Anthropic, DeepSeek ya da Gemini'deki prompt caching, sağlayıcı tarafından daha düşük bir tarifeyle faturalanır. Bu indirimi kendi tasarrufu olarak sayan bir araç rakamını şişirir.
- **Aracın hiç görmediği trafik.** Başka bir servisten gelen çağrılar, bir ekip arkadaşının betiği, bir kodlama ajanının yan istekleri ya da bir batch işi faturada görünür, araçta görünmez.
- **Eksik kullanım verisi.** Son kullanım olayı gelmeyen bir akış isteğinin hiç token sayısı yoktur. Onu sessizce sıfır saymak, sonrasındaki her şeyi daha ucuz gösterir.
- **Zaman.** Sağlayıcılar kullanımı UTC gününe göre gruplar ve bazı kullanımlar gecikmeyle görünür.

## Yöntem, adım adım

### 1. Her istek için sağlayıcının kendi sayaçlarını loglayın

Kendi tahmininizi değil, sağlayıcının döndürdüğü `usage` bloğunu. Girdi, önbellekten gelen girdi (ve varsa önbellek yazmaları), çıktı, akıl yürütme token'ları, sağlayıcının bildirdiği model kimliği, API anahtarı ya da proje ve UTC zaman damgası. Kullanım verisi gelmeyen bir isteği asla sıfır olarak değil, **ölçülmemiş** olarak işaretleyin.

### 2. Dolardan önce token'ları mutabık hale getirin

Aynı anahtarlar ve günler için sağlayıcının günlük kullanımını dışa aktarın: OpenAI'ın [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage)'si, Anthropic'in [Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api)'si ya da DeepSeek ve Model Studio konsollarının kullanım sayfaları. Ardından kalem kalem karşılaştırın:

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

Token'lar tutuyorsa loglamanız eksiksizdir ve analizin geri kalanına güvenebilirsiniz. Sağlayıcı daha fazlasını gösteriyorsa, devam etmeden önce loglamadığınız trafiği bulun.

### 3. Ancak bundan sonra, tarihli bir fiyat tablosuyla fiyatlandırın

Her kalemi kendi tarifesiyle çarpın, tarifeleri hangi tarihte aldığınızı saklayın ve sağlayıcının maliyet raporuyla karşılaştırın. Yüzde birkaçlık sabit bir fark genellikle bir indirim ya da bölgesel bir tarifedir; optimizasyonunuzla da onsuz da aynı olduğu için tasarrufu değiştirmez.

### 4. Üç tür sayıyı birbirinden ayrı tutun

- **Ölçülen:** Gerçekleşen bir çağrı için sağlayıcının sayacından okunur.
- **Referansla ölçülen:** Gerçekleşmeyen bir çağrı (bir önbellek isabeti, tekilleştirilmiş bir istek), gerçekleşen özdeş çağrı için sağlayıcının sayacıyla değerlendirilir. Hiç yapılmamış bir çağrı için elde edilebilecek en iyi kanıt budur.
- **Tahmini:** Sağlayıcının hiç saymadığı her şey; örneğin bir aracın prompt'tan çıkardığı token'lar.

Her türü kendi içinde toplayın. Tahmini tutarları asla ölçülenlere eklemeyin ve yüzdelerin istekler üzerinden ortalamasını asla almayın: Parayı toplayın, sonra bölün.

### 5. Sağlayıcının indirimini kendinizinkinden ayırın

Önbellekten gelen girdi token'ları sağlayıcı sayesinde ucuzdur. Hiçbir şeyi değiştirmediyseniz ve isabet oranınız zaten yüksekse, o indirim projenizin tasarrufu değildir. Karşılaştırmanın iki tarafında da önbellekten gelen token'ları önbellek tarifesiyle fiyatlandırın; geriye kalan sizindir.

## Tasarrufu değişiklik mi sağladı?

Bir dağıtımdan sonra düşen bir fatura sakin bir haftadan da kaynaklanabilir. Bir tasarrufu doğru kaynağa bağlamak için:

- **İki kolu aynı anda çalıştırın.** Aynı istekleri değişiklikle ve değişiklik olmadan, aynı anda, aynı anahtar üzerinden gönderin ve ikisi için de sağlayıcının sayaçlarını karşılaştırın. Kollara rastgele dağıtılan istekler bunun temiz sürümüdür.
- **Tek bir nokta değil, bir aralık verin.** Yeniden örneklemeyi konuşmaların ya da günlerin tamamı üzerinden yapın ve "X ile Y % arasında" deyin. Sıfırı içeren bir aralık, farkı gürültüden ayıramadığınız anlamına gelir ve bu da meşru bir sonuçtur.
- **Kaliteyi aynı çalıştırmada kontrol edin.** Daha ucuz ama yanlış bir yanıt tasarruf değildir. İki kolda da doğruluğu ya da göreve özgü bir kontrolü ölçün.

## BV-SALA bu kontrolü nasıl mümkün kılar

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer), Apache-2.0 lisanslı, ücretsiz ve anahtarsız bir tasarruf katmanıdır. Her istek, tam da bu yöntem için tasarlanmış bir `SavingsReport` döndürür:

- `cost.basis`, yukarıdaki tanımlara göre `measured`, `reference`, `estimated` ya da `unmeasured` değerini alır. Bir tekrar, yalnızca çalışan çağrı doğrudan OpenAI'ın, Anthropic'in ya da Google'ın Gemini API'sine gittiyse referansla değerlendirilir; başka her yerde `estimated` olarak kalır.
- Tasarruf, asla tek bir rakamda toplanmayan dört ayrı defterde tutulur: `avoided_calls`, `eliminated_tokens`, `compressed_tokens` ve `provider_cached_tokens`.
- Sağlayıcının kendi önbellek indirimi `report.nativeSavings` içinde ayrı raporlanır ve asla katmanın tasarrufu olarak sayılmaz.
- Kullanım verisi olmadan biten bir akış `unmeasured` olur ve asla sıfır olarak fiyatlanmaz.

Raporları dayanağa göre toplamak birkaç satır sürer:

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

Python'dan, paketin istemcisi aynı raporları yerel gateway'den okur ve aynı ayrımı korur:

```python
# pip install bivelio-savings-layer
import bvsala

gw = bvsala.Gateway("http://127.0.0.1:8403")
# ... send requests with gw.wrap(client) and read each one with gw.report(response) ...
t = gw.totals()
print(t.requests, t.metered, t.not_metered, t.actual_cost_usd)
print(t.net_savings_usd_by_basis)  # one amount per basis, never added together
```

Ardından yukarıdaki 2. adımı bu toplamlara uygulayın: Katmanın `measured` harcaması, aynı anahtar ve gün için sağlayıcıdaki kullanımla token olarak birebir, dolar olarak ise indirimleriniz dışında eşleşmelidir. Raporlar liste fiyatıyla fiyatlar; bir fatura değildir.

## Aynı yöntem, herkesin önünde

Proje kendi A/B çalıştırmalarını [benchmark sayfasında](/tr/benchmarks) yayımlıyor: aynı istekler üzerinde iki kol, biri doğrudan sağlayıcıya, diğeri katmanın içinden; ikisi de sağlayıcının kendi kullanım sayacıyla ölçülüyor, %95 aralıklarıyla ve her çalıştırmanın tarihi ve sürümüyle birlikte. Hiçbir şey kazandırmayan ya da daha pahalıya gelen sonuçlar da aynı sayfada. Yöntemin tamamı, tahmin edici ve sınırları [makalede](/tr/paper) yer alıyor.

Sağlayıcıya özgü ayrıntılar için [OpenAI'da cached_tokens neden 0](/tr/guides/openai-prompt-caching-cached-tokens), [Claude prompt caching neden çalışmıyor](/tr/guides/claude-prompt-caching-not-working) ve [Claude Code maliyetini istek başına ölçme](/tr/guides/claude-code-cost-per-request) rehberlerine bakın. Kod ve ham raporlar [GitHub](https://github.com/BiVelio/bivelio-savings-layer)'da.
