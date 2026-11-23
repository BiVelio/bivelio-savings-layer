DeepSeek ve Qwen token başına ucuzdur; bu da faturayı takip etmeyi bırakmayı kolaylaştırır. İki sağlayıcı da prompt'ları kendi tarafında önbelleğe alır ve önbelleğe isabet eden girdi, ıskalayan girdiden çok daha düşük faturalanır. Dolayısıyla trafiğinizin gerçek maliyeti, çoğu panelin gizlediği bir sayıya bağlıdır: her istekte kaç girdi token'ının önbelleğe isabet ettiği. Bu rehber iki sağlayıcının nasıl faturaladığını ve önbelleğe aldığını, bir isteğin kullanım alanlarından nasıl fiyatlanacağını ve bunu ücretsiz bir yerel gateway ile istek başına nasıl göreceğinizi anlatıyor.

## DeepSeek bir isteği nasıl faturalar

DeepSeek her isteğin girdisini ikiye ayırır: bağlam önbelleğine isabet eden token'lar ve onu ıskalayan token'lar, her biri kendi fiyatıyla; bunlara çıktı token'ları eklenir. [Bağlam önbelleği](https://api-docs.deepseek.com/guides/kv_cache) her hesap için varsayılan olarak açıktır. İsabet için isteğin başının önceki bir istekle birebir eşleşmesi gerekir, önbellek best effort çalışır ve kullanılmayan kayıtlar birkaç saat ya da gün sonra temizlenir. Yanıt ne olduğunu söyler:

- `usage.prompt_cache_hit_tokens`: önbellekten sunulan girdi token'ları.
- `usage.prompt_cache_miss_tokens`: baştan sona işlenen girdi token'ları.
- `usage.prompt_tokens_details.cached_tokens`: aynı isabet sayısı, OpenAI uyumlu araçların okuduğu alanda.

DeepSeek'in [fiyatlandırma sayfası](https://api-docs.deepseek.com/quick_start/pricing), her model için isabet, ıska ve çıktı fiyatlarını ve daha düşük fiyatlı bir yoğun saat dışı penceresini listeler. Fiyatlar değişir; onları okuduğunuz tarihle birlikte kaydedin.

## Qwen bir isteği nasıl faturalar

Alibaba Cloud Model Studio'daki Qwen modellerinin iki tür [bağlam önbelleği](https://www.alibabacloud.com/help/en/model-studio/context-cache) vardır. Örtük önbellek, minimum uzunluğun üzerindeki prompt'lar için otomatiktir ve isabetleri indirimli faturalanır. Açık önbellek Anthropic'inki gibi çalışır: Bir bloğu `cache_control` ile işaretlersiniz, kayıt birkaç dakika yaşar ve yazmak normal girdiden biraz pahalıyken okumak çok daha ucuzdur. OpenAI uyumlu API'de isabet sayısı `usage.prompt_tokens_details.cached_tokens` alanında gelir. Model Studio'nun bölgesel endpoint'leri vardır; anahtarınızın hangisine ait olduğunu kontrol edin.

## İki sağlayıcıda da önbelleğe isabet ettirin

Kurallar her önek önbelleğindekiyle aynıdır:

1. Hiç değişmeyenleri başa koyun: sistem prompt'u, araç tanımları, uzun referans metinler, few-shot örnekler.
2. Bunları istekler arasında bayt bayt aynı tutun: içinde zaman damgası, istek kimliği ya da kullanıcı adı olmasın, araç tanımları sabit bir sırada dursun.
3. Değişenleri sona koyun: kullanıcının sorusu, son araç sonucu.
4. Ajanlarda geçmişi yeniden yazmak yerine sonuna ekleyin. Ortadaki eski bir mesajı düzenlemek ondan sonraki her şeyi geçersiz kılar.

## Tek bir isteğin maliyetini hesaplayın

Bir isteği fiyatlandırmak için herhangi bir araca ihtiyacınız yok. Kullanım bloğunu okuyun ve her kalemi kendi fiyatıyla çarpın:

```python
def request_cost(usage: dict, price_miss: float, price_hit: float, price_out: float) -> float:
    """USD cost of one chat completion. Prices are per million tokens, from the provider's pricing page."""
    details = usage.get("prompt_tokens_details") or {}
    hit = usage.get("prompt_cache_hit_tokens", details.get("cached_tokens", 0)) or 0
    miss = usage["prompt_tokens"] - hit
    return (miss * price_miss + hit * price_hit + usage["completion_tokens"] * price_out) / 1_000_000
```

Bu sayıyı her istek için model, isabet payı (`hit / prompt_tokens`) ve bir zaman damgasıyla birlikte loglayın; böylece önemli soruları yanıtlayabilirsiniz: Hangi özellik en çok tutuyor, bir dağıtımdan sonra önbellek isabet oranı düştü mü ve trafiğinizin ne kadarı yoğun saat dışı penceresine denk geliyor.

## Yerel bir gateway ile her isteği görün

Her çağrı noktasına dokunmamak için sağlayıcının önüne bir gateway koyun. [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer), npm paketinde bir gateway ile gelir: Apache-2.0, yerel, **anahtarsız ve kayıt olmadan** ve BiVelio'ya hiçbir şey gönderilmez. Her sağlayıcı için kendi portunda bir gateway çalıştırın:

```bash
# DeepSeek
npx @bivelio/savings-layer gateway --upstream deepseek --port 8403

# Qwen on Model Studio's international endpoint (`--upstream qwen` is the Beijing one)
npx @bivelio/savings-layer gateway --upstream https://dashscope-intl.aliyuncs.com --port 8404
```

Gateway, istemcinizin gönderdiği yolu sağlayıcıya iletir; bu yüzden base URL'niz, host olarak gateway'in yer aldığı, sağlayıcının kendi adresidir:

| Sağlayıcı | `--upstream` | OpenAI istemciniz için base URL |
| --- | --- | --- |
| DeepSeek | `deepseek` | `http://127.0.0.1:8403` |
| Qwen (Pekin) | `qwen` | `http://127.0.0.1:<port>/compatible-mode/v1` |
| Qwen (uluslararası) | `https://dashscope-intl.aliyuncs.com` | `http://127.0.0.1:8404/compatible-mode/v1` |
| GLM | `glm` | `http://127.0.0.1:<port>/api/paas/v4` |

`npx @bivelio/savings-layer --help`, diğer upstream'leri listeler (Moonshot, MiniMax, OpenRouter, Gemini, Ollama, vLLM, LM Studio).

Python'da paketin küçük istemcisi base URL'yi sizin yerinize ayarlar: Sağlayıcı için her zamanki OpenAI istemcinizi oluşturun; `wrap()`, gateway'den geçen ve sağlayıcının yolunu koruyan bir kopya döndürür.

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

Qwen için de aynısı, diğer gateway ve `OpenAI(base_url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1", ...)` ile çalışır. Trafiğinizi bir HTTP proxy'si üzerinden yönlendiriyorsanız, yerel gateway'e giden isteklerin oradan geçmemesi için `NO_PROXY=127.0.0.1,localhost` ayarlayın. Çalışan bir gateway yoksa `wrap()`, sağlayıcıyı doğrudan çağırmak yerine `GatewayUnavailable` hatası fırlatır. 1.2.3 sürümünde bu hata mesajı ayrıca gateway'in bir servis anahtarına ihtiyaç duyduğunu söyler: Bu doğru değil, gateway anahtarsız başlar.

Başka herhangi bir dil ya da araç da çalışır: OpenAI base URL'sini gateway'e yönlendirin; her istek gateway'in logunda, model, liste fiyatıyla maliyet ve tam fiyatlı token'lar ile önbellek okumaları (`cache↓`) olarak ayrılmış girdiyle tek bir satıra dönüşür.

Sohbet araçları ve ajanlar için önemli bir istisna var: Kullanım verisi (`stream_options: {"include_usage": true}`) istemeyen bir **akış** isteği sağlayıcıdan hiç kullanım verisi almaz; bu yüzden 1.2.3 sürümü onu `not metered: the request did not ask for usage` olarak loglar. İstemcinizde kullanım verisi isteyin ya da gateway'i, bu seçeneği eksik olan akışlara ekleyen `BVSALA_GATEWAY_USAGE_INJECT=1` ile başlatın. Bu akışların son parçasında `choices` listesi boş olur; `choices[0]` değerini kontrol etmeden okuyan kod bunu beklemez.

## DeepSeek veya Qwen üzerinde kodlama ajanları

DeepSeek ayrıca Anthropic biçiminde bir endpoint sunar ve bunun Claude Code ile nasıl kullanılacağını belgeler. `--upstream deepseek` ile gateway, Anthropic biçimindeki istekleri kendiliğinden bu endpoint'e gönderir:

```bash
npx @bivelio/savings-layer gateway --upstream deepseek --port 8402
ANTHROPIC_BASE_URL=http://127.0.0.1:8402 ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY" ANTHROPIC_MODEL=deepseek-flash claude
```

Claude Code'un arkasında Claude olmayan bir model çalıştırmak DeepSeek'in entegrasyonudur, Anthropic'in desteklediği bir kurulum değildir; modelin sizin işiniz için kalitesini değerlendirmek size kalmış.

**Qwen modelleriyle Qwen Code** farklı bir yol gerektirir. Paketin `qwen` wrapper'ı bunu kapsamaz: 1.2.3 sürümünde `npx @bivelio/savings-layer qwen`, Qwen Code'u Anthropic kimlik doğrulama türüyle çalıştırır ve Anthropic'in API'sine iletir; dolayısıyla yalnızca bir Anthropic anahtarıyla kullanılan Claude modellerini ölçer ve Anthropic biçimindeki bir DashScope base URL'sini reddeder. Qwen modelleri için Qwen Code'un OpenAI uyumlu modunu kullanın; [belgeleri](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/) bu modu `OPENAI_API_KEY`, `OPENAI_BASE_URL` ve `OPENAI_MODEL` ile yapılandırıyor. Bu base URL'yi bir gateway'e yönlendirin. `DASHSCOPE_PROXY_BASE_URL` değerini de tam olarak aynı URL'ye ayarlayın:

```bash
npx @bivelio/savings-layer gateway --upstream https://dashscope-intl.aliyuncs.com --port 8404

GW=http://127.0.0.1:8404/compatible-mode/v1
OPENAI_BASE_URL="$GW" DASHSCOPE_PROXY_BASE_URL="$GW" OPENAI_API_KEY="$DASHSCOPE_API_KEY" OPENAI_MODEL=qwen-plus qwen
```

İkinci değişken fatura için önemlidir. Qwen Code, DashScope ile konuşup konuşmadığına base URL'nin host'una bakarak karar verir ve `127.0.0.1` bir DashScope host'u değildir. Değişken olmadan genel OpenAI sağlayıcısına geri döner; bu sağlayıcı açık önbellek işaretlerini (`cache_control` ve `X-DashScope-CacheControl` başlığı) göndermez. İstekleriniz bu durumda açık önbelleğin 10 % fiyatı yerine, isabetlerin tipik olarak girdi fiyatının 20 % kadarına mal olduğu ve best effort çalışan Model Studio örtük önbelleğine düşer ([bağlam önbelleği](https://www.alibabacloud.com/help/en/model-studio/context-cache)). Qwen Code, `DASHSCOPE_PROXY_BASE_URL` ile birebir eşleşen bir base URL'yi DashScope olarak kabul eder ve işaretleri korur ([DashScope sağlayıcısı](https://github.com/QwenLM/qwen-code/blob/8fab857da5/packages/core/src/core/openaiContentGenerator/provider/dashscope.ts), 23 Kasım 2026'da erişildi). Gateway ikisini de değiştirmeden iletir: Bunu 1.2.3 sürümüyle kontrol ettik.

Bu yolda Qwen Code'un kendisini değil, gateway tarafını 1.2.3 sürümüyle kontrol ettik; bu yüzden gateway'in logunu okuyun: istek başına maliyet içeren tek bir satır. Bir `not metered` satırı nedenini söyler: Genellikle kullanım verisi istemeyen bir akış (gateway'i `BVSALA_GATEWAY_USAGE_INJECT=1` ile yeniden başlatın) ya da 1.2.3 kataloğunda satırı olmayan bir modeldir; katalogda `qwen-plus`, `qwen-flash`, `qwen3.7-flash`, `qwen3.8-flash` ve `qwen3.8-max` var ama örneğin `qwen3-coder-plus` yok.

1.2.3'teki iki fiyatlandırma açığı ikinci değişkene bağlıdır. **`DASHSCOPE_PROXY_BASE_URL` ayarlıyken**, yukarıdaki gibi, Model Studio her açık önbellek yazmasını girdi fiyatının 125 % oranında faturalar ve bunu `usage.prompt_tokens_details.cache_creation_input_tokens` alanında bildirir. 1.2.3 gateway'i bu alanı okumaz: Bu token'ları `cache↑0` ile normal girdi olarak, maliyetlerinin 80 % oranında loglar. Gateway'in `qwen-plus` için kullandığı isabet fiyatı açık önbelleğin 10 % oranıdır; bu doğrudur. **Değişken olmadan** açık yazma yoktur ama isabetler örtüktür, yaklaşık 20 % oranında faturalanır ve gateway onları aynı 10 % oranıyla, yani maliyetlerinin yaklaşık yarısıyla loglar.

## Gateway neyi ölçer, neyi ölçmez

- **Dolar tutarı DeepSeek'in günün saatine göre değişen fiyatlarından değil, bir katalogdan gelir.** 1.2.3 sürümünde `deepseek-flash` ve `deepseek-v4-pro` için satırlar var. Önbellek ıskaları ve çıktı için DeepSeek'in yoğun saat fiyatını kullanırlar; bu yüzden yoğun saat dışında bu kalemler DeepSeek'in faturaladığının iki katını gösterir. Önbellek isabetleri için iki satır da milyon token başına $0.003 kullanır; bu, DeepSeek'in `deepseek-flash` için yoğun saat dışı isabet fiyatıdır (yoğun saatte iki katı) ve DeepSeek'in `deepseek-v4-pro` için yayımladığı iki isabet fiyatının da altındadır ([fiyatlandırma sayfası](https://api-docs.deepseek.com/quick_start/pricing), 23 Kasım 2026'da erişildi). Saate ve girdinizin ne kadarının önbelleğe isabet ettiğine bağlı olarak gateway'in toplamı faturanın üstünde ya da altında çıkabilir. Token sayıları kesindir; önce onları karşılaştırın. Klasik `deepseek-chat` takma adının satırı yoktur: İletilir ve log onun ölçülmediğini söyler.
- **Bu istekleri değiştirmez.** OpenAI uyumlu trafikte gateway ölçer ve iletir (tek istisna yukarıdaki isteğe bağlı kullanım enjeksiyonudur); tasarruf kaldıraçları Anthropic biçimindeki trafik içindir. DeepSeek ve Qwen'deki tasarruf onların kendi önbelleklerinden gelir; izlenmesi gereken sayının isabet sayısı olmasının nedeni budur.

## DeepSeek veya Qwen'i TypeScript'ten çağırıyorsanız

BV-SALA SDK'sı OpenAI uyumlu herhangi bir endpoint'le konuşur ve birebir tekrarları ve eşzamanlı aynı istekleri ücretsiz ve anahtarsız atlar ([nasıl çalıştığı](/tr/guides/deduplicate-llm-requests)). DeepSeek'te bu kaçınılan çağrılar `reference` olarak değil `estimated` olarak raporlanır: 1.2.3 sürümü bir tekrarı yalnızca çalışan çağrı OpenAI'ın, Anthropic'in ya da Google'ın kendi API'sine gittiyse referansla değerlendirir. Ajan döngüleri için bir uyarı: Yerini yenisi almış araç sonuçlarını varsayılan olarak kırpmak geçmişin ortasını yeniden yazar ve prompt'un tamamını kendiliğinden önbelleğe alan bir sağlayıcıda bu, kazandırdığından fazlasına mal olabilir. Projenin changelog'u, DeepSeek üzerinde 60 adımlık bir ajan döngüsünde +166 % bildiriyor; ölçüm, sahte bir sağlayıcıya karşı 1.2.3 ve 1.2.4 sürümleriyle ve anahtarsız yapıldı. Ajan döngülerinde bunu istek başına kapatın:

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

## Sayıları sağlayıcınızla karşılaştırın

Günde bir kez gateway'in model başına toplamlarını (girdi, önbellek isabetleri, çıktı) aynı anahtar için DeepSeek platformunun ya da Model Studio'nun kullanım sayfasıyla karşılaştırın. Toplam token sayıları eşleşmelidir; dağılımda tek bir istisna var: Qwen'de 1.2.3 sürümü açık önbellek yazmalarını önbellek yazması olarak değil, normal girdi olarak sayar. Dolar tutarları, bilinen nedenlerle her iki yönde de farklı olabilir. Katalog fiyatları DeepSeek'in saate göre değişen fiyatları değildir. Qwen'de 1.2.3, açık önbellek yazmalarını Model Studio'nun faturaladığının altında, normal girdi olarak, örtük isabetleri ise açık önbellek tarifesiyle fiyatlar (ikisi de yukarıda anlatıldı). Bölgesel fiyatlar ve indirimler de parayı değiştirir. Adım adım bir yöntem için [LLM tasarruflarını sağlayıcı faturasıyla doğrulama](/tr/guides/verify-llm-savings-against-provider-bill) rehberine bakın. Gateway'in kodu ve terminal başına rehberleri [GitHub](https://github.com/BiVelio/bivelio-savings-layer)'da; projenin neleri ölçtüğü ve neleri ölçmediği ise [benchmark sayfasında](/tr/benchmarks).
