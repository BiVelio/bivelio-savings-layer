OpenAI uzun prompt'ları otomatik olarak önbelleğe alır: Bir isteğin başı yakın zamanda işlediği bir istekle eşleştiğinde, o girdi token'ları indirimli faturalanır ve yanıt daha erken başlar. Hiçbir şeyi açmanıza gerek yoktur. Çalışmayı bıraktığında gözden kaçması da tam bu yüzden kolaydır. `cached_tokens` her istekte `0` olarak dönüyorsa, bu rehber nedenleri kontrol sırasıyla listeliyor, isabet oranını istek başına nasıl izleyeceğinizi ve OpenAI'ın kendi kullanım verileriyle nasıl doğrulayacağınızı gösteriyor.

## Nereden okunur

Her yanıt, girdi token'larından kaçının önbellekten geldiğini söyler:

- **Chat Completions:** `usage.prompt_tokens_details.cached_tokens`, `usage.prompt_tokens` toplamının bir parçası olarak.
- **Responses API:** `usage.input_tokens_details.cached_tokens`, `usage.input_tokens` toplamının bir parçası olarak.

Önbellekten gelen token'lar girdi toplamının içindedir, ona eklenmez. OpenAI'ın [prompt caching rehberi](https://developers.openai.com/api/docs/guides/prompt-caching), güncel kurallar için referanstır. Rehber artık önbellek yazmalarını da bildirip faturalayan ve açık önbellek seçeneklerini kabul eden yeni modelleri, önbelleğe yazmanın ücretsiz olduğu eski modellerden ayırıyor. Kullandığınız model için oraya bakın.

## cached_tokens neden 0

1. **Prompt çok kısa.** Önbelleğe alma yaklaşık 1.024 prompt token'ında başlar; tam eşik ve önbellekten gelen sayının nasıl yuvarlandığı modele bağlıdır. 600 token'lık bir sistem prompt'u ve kısa bir soru önbelleğe asla isabet etmez ve hiçbir şey size bunu söylemez.
2. **Prompt'un başı değişiyor.** Önbellek en ilk token'dan itibaren eşleştirir. İlk mesajdaki bir zaman damgası, bir istek kimliği ya da kullanıcının adı, her isteği ilk token'dan itibaren benzersiz kılar. Araçlar, görseller ve yanıt biçimleri de önekin parçasıdır; bu yüzden farklı sırayla listelenen araçlar ya da farklı serileştirilen bir şema eşleşmeyi bozar.
3. **Kayıt önbellekten çıkarıldı.** Kayıtlar son kullanımdan sonra kısa bir süre tutulur; trafik sakinken genellikle birkaç dakika. Aralarında bir saat olan istekler nadiren isabet eder.
4. **Trafik dağınık.** İstekler, prompt'un başının bir hash'ine göre yönlendirilir. Aynı öneke sahip çok yüksek hacim, kaydı tutmayan başka makinelere taşar. OpenAI'ın `prompt_cache_key` parametresi ortak öneki paylaşan istekleri gruplar; rehberin açıkladığı gibi kullanıcı başına değil prompt şablonu başına bir anahtar kullanın ve her anahtarın istek hızını makul düzeyde tutun.
5. **Alanı okumuyorsunuz.** Akış (stream) olarak gönderilen bir Chat Completions isteği, `stream_options: { include_usage: true }` ile istemediğiniz sürece hiç kullanım verisi taşımaz. Birçok wrapper `prompt_tokens_details` alanını düşürür. OpenAI uyumlu bazı sağlayıcılar ve bazı Azure dağıtımları önbelleğe almayı farklı biçimde bildirir ya da hiç bildirmez.

## İki dakikada test edin

Uygulamanızda hata ayıklamaya başlamadan önce, önbelleğe almanın hesabınız ve modeliniz için çalışıp çalışmadığını kontrol edin. Aynı uzun prompt'u birkaç saniye arayla iki kez gönderin ve her yanıtın kullanım verisini okuyun:

```bash
# A system prompt well above the threshold, sent twice. The second answer should report cached tokens.
BODY=$(python3 -c 'import json; print(json.dumps({"model": "gpt-4o-mini", "messages": [{"role": "system", "content": "You are a careful assistant for an invented shop. " * 200}, {"role": "user", "content": "Say OK."}]}))')
for i in 1 2; do
  curl -s https://api.openai.com/v1/chat/completions \
    -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" \
    -d "$BODY" | python3 -c 'import json, sys; u = json.load(sys.stdin)["usage"]; print(u["prompt_tokens"], u.get("prompt_tokens_details"))'
done
```

İkinci satır önbellekten gelen token'lar gösteriyorsa sağlayıcı tarafı çalışıyor demektir ve sorun, uygulamanızın prompt'larını nasıl oluşturduğundadır: Okumaya devam edin. Hiç göstermiyorsa birkaç kez daha deneyin (önbelleğe alma best effort çalışır ve ilk istek farklı bir makineye düşmüş olabilir), ardından OpenAI'ın önbellek rehberinde modelin kaydını kontrol edin. Üretimde kullandığınız modeli koyun; farklı bir modelde yapılan test pek bir şey kanıtlamaz.

Bu test, sonraki bölümler için de size bir referans noktası verir. Prompt'unuzun sırasını değiştirdiğinizde ya da bir `prompt_cache_key` eklediğinizde, aynı karşılaştırmayı uygulamanızdaki gerçek bir şablonla yapın ve sayıları saklayın. Kullanıcılarınızın gerçekten kullandığı bir şablonda değişiklikten önce ve sonra ölçülen bir isabet oranı, gösterebileceğiniz bir sonuçtur; "önbellek işe yarar herhalde" ise değildir.

## Değişeni sona koyun

Çoğu durumda çözüm sıralamadır. Her istek için aynı olan her şey başa gider ve bayt bayt aynı kalır; değişen her şey sona gider.

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

Ardından, bir gerilemenin yayına çıktığı gün fark edilmesi için her prompt'un önbellekten gelen payını izleyin:

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

Bunu prompt şablonuna göre gruplayın. Prompt'ları 1.024 token'ın üzerinde olduğu halde payı %0 seviyesinde kalan bir şablonun başına yakın bir yerde değişen bir şey vardır: İki isteği loglayın ve [bu rehberin Claude sürümünde](/tr/guides/claude-prompt-caching-not-working#önbelleğinizi-bozan-baytı-bulun) gösterildiği gibi karakter karakter karşılaştırın.

## BV-SALA nasıl yardımcı olur

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer), OpenAI uyumlu herhangi bir endpoint'i ücretsiz ve anahtarsız saran, TypeScript için Apache-2.0 lisanslı bir tasarruf katmanıdır. OpenAI'ın önbelleği otomatik olduğundan katman OpenAI'da hiçbir şeyi işaretlemez. Önbellek için yaptıkları:

- **Akışlarda her zaman kullanım verisi ister;** böylece akış olarak gönderilen bir isteğin sayacı sessizce kaybolmaz, istek ölçülür.
- **OpenAI'ın indirimini her çağrıda gösterir;** bunu `report.nativeSavings` içinde, OpenAI'ın kendi sayacına dayanarak yapar ve indirimi kendi tasarruflarından ayrı tutar: İndirim OpenAI'ındır, katmanın değil.
- **Değişken satırları önekin dışına taşıyabilir.** İsteğe bağlı `savings: { cachePrefix: true }` ile sistem prompt'unda her istekte değişen satırlar (ISO zaman damgaları, UUID'ler, epoch zamanları) sona taşınır, böylece sabit kısım önbelleğe alınabilir. Model aynı satırları farklı bir sırayla okur; bu yüzden karar sizindir ve asla varsayılan olarak açık değildir.

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

Katmanın kendi kaldıraçları (birebir tekrarları ve eşzamanlı aynı istekleri atlamak) OpenAI'ın önbelleğinden ayrıdır ve [aynı LLM isteklerini tekilleştirme](/tr/guides/deduplicate-llm-requests) rehberinde anlatılıyor.

## OpenAI'ın sayılarıyla doğrulayın

1. **İstek başına:** Her yanıttan `cached_tokens` değerini ve girdi toplamını loglayın; katmanı kullanıyorsanız `report.tokens.providerCachedInput` alanını.
2. **Gün başına:** OpenAI'ın [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage)'si, önbellekten gelen girdi token'larını da içeren günlük dilimlerde completions kullanımını model bazında ve isterseniz API anahtarı ya da proje bazında döndürür. Aynı anahtar, model ve UTC günü için loglarınızı toplayın: Önbellekten gelen ve gelmeyen girdi toplamları eşleşmelidir.
3. **Para olarak:** Önbellekten gelen ve gelmeyen girdiyi ayrı ayrı fiyatlandırın. Önbellek yazmalarını faturalayan modellerde onları da ekleyin, yoksa tasarruf tahmininiz olduğundan yüksek çıkar.

Yöntemin tamamı için [LLM tasarruflarını sağlayıcı faturasıyla doğrulama](/tr/guides/verify-llm-savings-against-provider-bill) rehberini okuyun. Bir OpenAI faturasındaki diğer kaldıraçlar için [OpenAI API maliyetleri nasıl düşürülür](/tr/guides/reduce-openai-api-costs) rehberine bakın. Katmanın hiçbir şey kazandırmadığı durumlar dahil ölçülen sonuçlar [benchmark sayfasında](/tr/benchmarks), kod ise [GitHub](https://github.com/BiVelio/bivelio-savings-layer)'da.
