Her LLM API'si çağrı başına faturalar. Uygulamanız aynı isteği iki kez gönderirse, ikinci yanıt hiçbir şey katmasa bile iki kez ödersiniz. Bu rehber bunu önleyen iki tekniği gösteriyor: daha sonra gelen tekrarlar için **birebir eşleşme yanıt önbelleği** ve aynı anda gelen özdeş istekler için **eşzamanlı istek birleştirme** (in-flight coalescing). İkisi de her dilde ve her sağlayıcıyla çalışır. Sonunda, açık kaynaklı BV-SALA SDK'sının ikisini de varsayılan olarak nasıl yaptığını ve tasarrufu sağlayıcınızın kendi kullanım sayılarıyla nasıl kontrol edeceğinizi göreceksiniz.

## Yinelenen istekler nereden gelir

Yinelenen istekler göründüğünden daha yaygındır, çünkü nadiren tek ve bariz bir yerden gelirler:

- **Yeniden denemeler ve çift tıklamalar.** Bir kullanıcı "Oluştur" düğmesine iki kez basar ya da bir istemci kütüphanesi, sağlayıcının aslında yanıtlamış olduğu bir zaman aşımından sonra isteği yeniden dener.
- **Batch işleri ve cron'lar.** Bir gece işi, dün sınıflandırdığı ürün açıklamalarını, SSS kayıtlarını ya da destek hazır yanıtlarını yeniden sınıflandırır.
- **Fan-out.** İki worker, iki tarayıcı sekmesi ya da geliştirme ortamında iki kez çalışan bir React effect'i, milisaniyeler içinde aynı prompt'u gönderir.
- **Ajanlar ve pipeline'lar.** Çok adımlı bir pipeline, aynı alt soruyu birkaç dalda sorar.
- **Testler ve değerlendirmeler.** CI, her push'ta aynı fixture'ları canlı API'ye karşı çalıştırır.

İlk ve son grup zamana yayılmış tekrarlardır; fan-out ise eşzamanlılıktır. Farklı çözümler gerektirirler ve bu rehber bu yüzden ikisini de ele alıyor.

## Önce yinelenme oranınızı ölçün

Herhangi bir şey inşa etmeden önce trafiğinizin ne kadarının tekrarlandığını öğrenin. Bir gün boyunca her istek gövdesinin hash'ini alın ve sayın. Anahtar **kanonik** olmalıdır: Aynı istek, JSON anahtarlarının sırası ne olursa olsun aynı baytları vermelidir.

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

Oran sıfıra yakınsa bir yanıt önbelleği size pek bir şey kazandırmaz; bunun yerine [prompt caching](/tr/guides/claude-prompt-caching-not-working) ya da [model seçimi](/tr/guides/reduce-openai-api-costs) konularına bakmalısınız. İsteklerinizin kayda değer bir kısmı tekrarlanıyorsa okumaya devam edin.

## Gerçekten güvenli bir önbellek anahtarı oluşturun

Birebir eşleşme önbelleği, anahtarı kadar iyidir. Kural basittir: **Yanıtı değiştirebilecek her şey anahtara girer ve hiçbir şey normalleştirilerek atılmaz.**

- Model kimliği, mesaj listesinin tamamı, sistem prompt'u, araç tanımları, yanıt biçimi ya da JSON şeması ve her örnekleme parametresi (`temperature`, `top_p`, `max_tokens`, `seed`, akıl yürütme seviyesi).
- Prompt kullanıcı verisi taşıyorsa bir **kapsam** (scope). "Bakiyem ne kadar?" diye soran iki kullanıcı aynı metni gönderir ve farklı yanıtlara ihtiyaç duyar. Kullanıcı ya da tenant kimliğini anahtara ekleyin veya bu istekleri hiç önbelleğe almayın.
- "Akıllıca" normalleştirme yok. Daha fazla isabet için küçük harfe çevirmek, boşlukları kırpmak ya da noktalama işaretlerini silmek birebir önbelleği bulanık bir önbelleğe dönüştürür ve bulanık bir önbellek, başka bir sorunun yanıtını döndürebilir.

## Asla önbellekten sunulmaması gerekenler

Bazı istekler tekrarlanır ama yine de her seferinde modele ulaşmalıdır:

- **Değişmesi gereken yanıtlar**: "rastgele bir isim seç", "bir parola üret", "saat kaç", "bugünün fiyatı". Burada önbellekten gelen yanıt bir tasarruf değil, bir hatadır.
- **Yan etkisi olan araçlar.** Yanıt `send_email` ya da `create_order` çağrısı istiyorsa, yanıtı önbellekten tekrar oynatmak o eylemi atlar. Yalnızca araçları salt okunur olan ya da hiç aracı olmayan istekleri önbelleğe alın.
- **Kullanıcıların çeşitlilik beklediği örneklenmiş çıktı.** Yüksek bir `temperature` değerinde önbellekten gelen yanıt yalnızca tek bir örnektir ve sonsuza kadar sunulur.
- **Hatalar, boş yanıtlar, retler ve kesilmiş yanıtlar.** Bunları asla önbelleğe yazmayın; bir sonraki istek yeniden denesin.
- **Hassas konular.** Bir destek botu, kendine zarar verme ya da tıbbi acil durumla ilgili yanıtları önbelleğe almamalıdır; bunları her seferinde modele gönderin.

## Eşzamanlı özdeş istekleri birleştirin

Önbellek ancak ilk yanıt geldikten sonra işe yarar. On özdeş istek aynı 300 ms içinde başlarsa onu da önbelleği ıskalar. Çözüm, genellikle *singleflight* olarak adlandırılan küçük bir kalıptır: İlk çağıran çağrıyı yapar, diğerleri aynı promise'i bekler.

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

Üretimde üç ayrıntı önemlidir. Hatalar bekleyen her çağırana ulaşmalıdır (yukarıdaki kalıp bunu yapar). Bir çağıranın iptal etmesi, ortak çağrıyı diğerleri için iptal etmemelidir. Akışlar ise daha zordur: Başlamış bir akış ikinci bir çağırana öylece devredilemez; bu yüzden çoğu uygulama, düz bir isteğin devam eden bir çağrıya katılmasına izin verir ama hiçbir şeyin bir akışa katılmasına izin vermez.

## BV-SALA bunu nasıl yapar

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer), TypeScript için Apache-2.0 lisanslı bir tasarruf katmanıdır. SDK'sı sağlayıcınızı sarar ve **anahtarsız ve kayıt olmadan** iki tekniği de varsayılan olarak açar: tam eşleşme önbelleği ve eşzamanlı istek tekilleştirme. Yukarıdaki "asla önbelleğe alma" kurallarını da uygular: Güncellik ya da rastgelelik isteyen ifadeler, oturum olmadan kişisel ifadeler, hassas konular, retler ve hatalar önbelleğin dışında kalır.

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

Kişisel görünen bir istek ("siparişim", "faturamız"), kime ait olduğunu söylemediğiniz sürece önbelleğe alınmaz. Bir kapsam geçin, önbellek her oturum için ayrı olarak yeniden çalışır:

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

Varsayılan önbellek tek bir sürecin belleğinde yaşar. Onu birden fazla sunucu ya da serverless örneği arasında paylaşmak için `exactCache` seçeneğiyle kendi çalıştırdığınız bir depoyu geçin. Üç metot gerektirir, bu yüzden herhangi bir anahtar-değer deposu işe yarar:

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

Önbellekteki yanıtlar sizin altyapınızda kalır. Anahtarsız çalıştığınızda BiVelio'ya hiçbir şey gönderilmez.

## Tasarrufu sağlayıcınızın sayılarıyla doğrulayın

Önbellek tasarrufunu kontrol etmek kolaydır, çünkü bu tasarruf gerçekleşmeyen çağrıların sayısından ibarettir.

1. **Çağrıları iki tarafta da sayın.** Bir gün boyunca uygulamanızın yaptığı `generate()` çağrılarını sayın ve sağlayıcınızın aynı API anahtarı ve model için gösterdiği istek sayısıyla karşılaştırın (OpenAI ya da Anthropic konsolunun kullanım sayfası veya kullanım API'leri). Fark, `report.calls.avoidedLlm` toplamına eşit olmalıdır.
2. **Her tekrarın nasıl değerlendirildiğine bakın.** `report.cost.basis`, sayının nereden geldiğini söyler. Çalışan özdeş çağrı doğrudan OpenAI'ın, Anthropic'in ya da Google'ın Gemini API'sine (`api.openai.com`, `api.anthropic.com` veya `generativelanguage.googleapis.com`) gittiyse tekrar `reference` olur: Referans çizgisi o çağrının kendi kullanım sayacıdır ve ihtiyatlı biçimde önbellekten gelen girdi tarifesiyle fiyatlanır. Çalışan çağrı başka herhangi bir yere gittiyse, DeepSeek gibi başka bir sağlayıcının kendi API'si, bir proxy, Azure ya da bir gateway dahil, tekrar `estimated` olarak kalır; çünkü katmanın liste fiyatlarının faturayla tuttuğu yalnızca bu üç API için bilinir. Tahmini tutarlar her zaman ayrı raporlanır.
3. **Yalnızca çağrıları değil, harcamayı karşılaştırın.** `report.cost.netSavingsUsd` değerini dayanağa göre toplayın. Ölçülen ve tahmini tutarları asla birbirine eklemeyin ve `netSavingsRatio` değerinin istekler üzerinden ortalamasını asla almayın.

Daha temiz bir test istiyorsanız aynı iş yükünü iki kez çalıştırın: bir kez o çalıştırma için kaldıraçlar kapalıyken (her istekte `savings: { exactCache: false, singleflight: false }`) ve bir kez varsayılanlarla; ardından iki faturayı karşılaştırın.

## Herkese açık sayılar ne diyor

Depo benchmark çalıştırmalarını yayımlıyor. İsteklerin %30'unun birebir tekrar olduğu, GSM8K sorularından oluşturulmuş herkese açık bir iş yükünde `gpt-4o-mini` için ölçülen toplu azalma **%31,50** oldu; %95 aralığı %25,7 ile %36,7 arasındaydı (Eylül 2026 tarihli SDK 0.4.31 artefaktları; kaynak: [benchmark sayfası](/tr/benchmarks#savings) ve README). Hiç tekrarlanmayan trafikte tasarruf yaklaşık %0 olur ve [benchmark sayfası](/tr/benchmarks#no-savings) bu düz sonuçları da gösteriyor. Bir önbellek için en önemli hatayı da sayıyor: 198 soru varyantından **0 tanesine** başka bir sorunun yanıtı verildi ([garantiler](/tr/benchmarks#guarantees)).

Tasarrufunuz yinelenme oranınıza bağlıdır; bu yüzden önce onu bu sayfanın başındaki kod parçasıyla ölçün. Kod, makale ve ham raporlar [GitHub](https://github.com/BiVelio/bivelio-savings-layer)'da.
