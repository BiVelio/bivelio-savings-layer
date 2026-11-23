Claude isteklerinize `cache_control` eklediniz ama fatura kıpırdamadı. Ya da `cache_read_input_tokens` her çağrıda `0` olarak dönüyor. Bu rehber bunun neden olduğunu, önbelleğinizi bozan baytı tam olarak nasıl bulacağınızı ve sonucu Anthropic'in kendi kullanım sayılarıyla nasıl kontrol edeceğinizi adım adım anlatıyor. Buradaki her şey herhangi bir SDK ile çalışır. Sonunda, açık kaynaklı BV-SALA SDK'sının breakpoint'leri sizin yerinize nasıl yerleştirdiğini ve ona bunu yapmamasını söylemeniz gereken tek durumu göreceksiniz.

## Önce üç kullanım alanını okuyun

Her Messages API yanıtı önbelleğe ne olduğunu söyler. `usage` içindeki üç sayıya bakın:

| Alan | Neyi sayar |
| --- | --- |
| `cache_creation_input_tokens` | Bu çağrıda önbelleğe yazılan token'lar; normal girdi fiyatının üzerinde faturalanır |
| `cache_read_input_tokens` | Önbellekten sunulan token'lar; girdi fiyatının küçük bir kısmıyla faturalanır |
| `input_tokens` | Son önbellek breakpoint'inden sonraki token'lar; normal fiyattan faturalanır |

Üç örüntü nereye bakmanız gerektiğini söyler:

- **İki önbellek alanı da 0.** Hiçbir şey önbelleğe alınmadı: Önek, modelin minimum uzunluğundan kısa, breakpoint yok ya da sizinle API arasındaki bir şey onu kaldırdı.
- **Yazma her çağrıda yüksek, okumalar 0'da kalıyor.** Önbellek yazılıyor ama hiç yeniden kullanılmıyor: Önek çağrılar arasında değişiyor, kayıt süresi doldu ya da çağrılar farklı bir modele veya workspace'e gidiyor.
- **Okumalar yüksek.** Çalışıyor. Artık tek soru, prompt'un ne kadarının breakpoint'ten önce durduğu.

## Claude'un prompt önbelleği altı maddede nasıl çalışır

1. Bir **önek** önbelleğe alır: isteğin başından bir `cache_control` breakpoint'ine kadar olan kısmı. Eşleşme birebirdir; tek bir bayt farklıysa ondan sonraki her şey yeniden işlenir.
2. Sıra **önce tools, sonra system, sonra messages** şeklindedir. Araç listesindeki bir değişiklik, sistem prompt'unu ve ondan sonraki mesajları geçersiz kılar.
3. En fazla **dört breakpoint** koyabilirsiniz ve API her birinden geriye doğru, sınırlı sayıda blok boyunca önceki bir kaydı arar (bu yazının yazıldığı sırada 20).
4. Kayıtlar varsayılan olarak **beş dakika** yaşar ve her isabette yenilenir. `"ttl": "1h"` ile bir saatlik ömür de kullanılabilir.
5. Yazmak okumaktan pahalıdır: Beş dakikalık bir yazma girdi fiyatının 1,25 katı, bir saatlik yazma 2 katı üzerinden faturalanır; okuma ise girdi fiyatının küçük bir kısmına mal olur (çoğu modelde 0,1 katı). Modeliniz için [Anthropic'in fiyatlandırma sayfasına](https://platform.claude.com/docs/en/about-claude/pricing) bakın.
6. Modele bağlı, 512 ile 4.096 token arasında değişen bir **önbelleğe alınabilir minimum uzunluk** vardır. Bunun altında istek, hiçbir hata vermeden, basitçe önbelleğe alınmaz.

Bunların hepsi, bir sayı değiştiğinde güvenmeniz gereken kaynak olan [Anthropic'in prompt caching belgelerinde](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) yer alıyor.

## Olağan nedenler, kontrol sırasıyla

1. **Önek çok kısa.** 600 token'lık bir sistem prompt'u birçok modelde minimumun altında kalır. Önbelleğe alınan kısmın bir fark yaratacak kadar uzun olması için sabit talimatları, örnekleri ve referans metni bir araya getirin.
2. **Önekteki bir şey her çağrıda değişiyor.** Klasikler: sistem prompt'undaki bir zaman damgası ya da "Bugün …" satırı, bir istek kimliği, kullanıcının adı, rastgele sıralanmış örnekler, anahtar sırası sabit olmayan bir nesneden üretilen araç tanımları ya da farklı boşluklarla serileştirilmiş bir JSON belgesi.
3. **Breakpoint değişen içeriğin üzerinde.** Son `cache_control` kullanıcının sorusunun üzerindeyse her çağrı kimsenin okumadığı yeni bir kayıt yazar. Breakpoint'in yeri, değişmeyen kısmın sonudur.
4. **Kaydın süresi doldu.** Aralarında beş dakikadan fazla olan çağrılar birbirlerinin kaydını asla okumaz. Her on dakikada bir öğe işleyen bir gece batch'i, her seferinde yazma primini öder ve hiçbir şey okumaz.
5. **Çağrılar aynı önbelleği paylaşmıyor.** Farklı bir model, farklı bir workspace ya da konuşmanın ortasında model değiştirmek, her seferinde boş bir önbellekle başlar.
6. **Paralel çağrılar yarışıyor.** Bir kayıt ancak ilk yanıt başladıktan sonra okunabilir. Aynı anda gönderilen on özdeş çağrının hepsi yazar. Önce birini, sonra kalanları gönderin.
7. **Bir proxy işareti kaldırıyor.** `cache_control` değerini silen ya da blok biçimindeki bir `system` alanını düz bir string'e çeviren bir gateway, her çağrı yine başarılı olurken prompt'un tamamının önbelleğe alınmamış girdi olarak faturalanmasına yol açar. Claude Code'un belgeleri, [LLM gateway'leri](https://code.claude.com/docs/en/prompt-caching) için tam olarak bu arızayı anlatıyor.

## Önbelleğinizi bozan baytı bulun

Okumalar sıfırda kaldığında, art arda iki istek gövdesini loglayın ve önbelleğin onları okuduğu sırayla ilk farklılaştıkları yeri bulun:

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

İlk fark sistem prompt'unun ya da araç listesinin içindeyse önbellek ıskanızın kaynağını buldunuz demektir. O kısmı isteğin sonuna, genellikle kullanıcı mesajına taşıyın.

Ardından, bir gerilemenin yayına çıktığı gün fark edilmesi için isabet oranını çağrı başına izleyin:

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

## Önbelleğe almak sizin trafiğinizde kârlı mı?

Yazmalar normal girdiden pahalı olduğu için önbelleğe almak, önekin süresi dolmadan yeniden okunacağına dair bir bahistir. Beş dakikalık ömürde tek bir okuma bile yazmanın maliyetini çıkarır. Yazılıp hiç okunmayan bir önek, işaretsiz gönderilmesine göre yaklaşık %25 daha pahalıya gelir. Bu yüzden "her yere `cache_control` ekle" güvenli bir varsayılan değildir: Birkaç dakika içinde geri dönen sohbet ve ajan trafiğinde kazandırır, tek seferlik isteklerde ya da her seferinde değişen prompt'larda kaybettirir.

## BV-SALA bunu nasıl ele alıyor

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer), Apache-2.0 lisanslı bir tasarruf katmanıdır. `AnthropicProvider` ile breakpoint'leri sizin yerinize, ücretsiz ve anahtarsız yerleştirir: biri sistem prompt'unun sonuna, biri konuşmanın değişmeyen kısmının sonuna; API'nin izin verdiğinden asla fazlasını koymaz. Her çağrının raporu, Anthropic'in kendi sayaçlarına dayanarak önbelleğin ne yaptığını gösterir:

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

`report.nativeSavings`, ayrı gösterilen Anthropic indirimidir: Katman bunu asla kendi tasarrufu olarak saymaz, böylece raporunuz faturayla tutar.

**İşaretlemeyi kapatmanız gereken durum.** Anahtarsız kullanımda, sistem prompt'unuz her istekte değişiyorsa (bir zaman damgası, bir kullanıcı kimliği) ya da çağrılarınız yeni süreçlerde beş dakikadan uzun aralıklarla geliyorsa, varsayılan işaretleme kimsenin okumadığı bir önbellek kaydı yazar ve README'ye göre bu, katmansız duruma kıyasla yaklaşık %20 daha pahalıya gelir. Değişen kısmı kullanıcı mesajına taşıyın ya da işaretlemeyi kapatın:

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

Bu isteğe bağlı yeniden sıralama, README'de yayımlanan keşif amaçlı bir canlı testin arkasındaki kaldıraçtır: `claude-haiku-4-5` üzerinde, bir zaman damgasının önbelleği zehirlediği kurgusal bir dizide isabet oranını %0 seviyesinden %95 seviyesine çıkardı ve istek başına maliyeti, katmanın bu seçenek olmadan çalışan haline kıyasla %82,76 düşürdü; kol başına 20 istek, 1.2.0 sürümüyle 15 Kasım 2026'da ölçüldü. Küçük ve kurgusal bir test; sizin trafiğiniz için bir öngörü değil.

## Anthropic'in sayılarıyla doğrulayın

1. **Çağrı başına.** Her yanıttan `usage` bloğunu (katmanı kullanıyorsanız `report.nativeSavings` alanını) loglayın ve isabet oranını yukarıdaki gibi hesaplayın. Sağlıklı bir sohbet ya da ajan iş yükü, ilk çağrıdan sonra yazmalardan çok daha fazla okuma gösterir.
2. **Gün başına.** Claude Console'daki kullanım sayfası, girdiyi model ve API anahtarı bazında önbellek yazmaları ve önbellek okumaları olarak ayırır. Aynı anahtar ve aynı UTC günü için logladığınız `cache_read_input_tokens` ve `cache_creation_input_tokens` değerlerini toplayın: Toplamlar eşleşmelidir. Programatik bir kontrol için [Usage and Cost Admin API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) aynı sayaçları döndürür.
3. **Para olarak.** Okumaları, yazmaları ve normal girdiyi ayrı ayrı fiyatlandırın. Yazma primini değil de yalnızca "tasarruf edilen token'ları" gösteren bir rapor, hesabın yarısını saklıyordur.

Deponun [herkese açık benchmark'ları](/tr/benchmarks), her testin iki kolunu da sağlayıcının kendi kullanım sayacıyla ölçer. Genel yöntem için [LLM tasarruflarını faturanızla doğrulama](/tr/guides/verify-llm-savings-against-provider-bill) rehberine bakın. Aynı sorunun OpenAI tarafı için [OpenAI'da cached_tokens neden 0](/tr/guides/openai-prompt-caching-cached-tokens) rehberine bakın. Kod [GitHub](https://github.com/BiVelio/bivelio-savings-layer)'da.
