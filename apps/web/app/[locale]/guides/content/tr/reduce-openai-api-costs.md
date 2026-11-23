Bir OpenAI faturası, her istek için birkaç sayının toplamıdır: önbelleğe alınmamış girdi token'ları, önbellekten gelen girdi token'ları, önbellek yazmaları (GPT-5.6 ve sonrasında), çıktı token'ları (akıl yürütme dahil) ve modelin fiyatı. Faturayı düşürmenin her yolu bu sayılardan birini değiştirir. Bu rehber, kaldıraçları genellikle en çok kazandırdıkları sırayla ele alıyor, hangisinin ne zaman kazandırmadığını söylüyor ve her tasarrufu bir projeksiyonla değil, OpenAI'ın kendi kullanım verileriyle nasıl kanıtlayacağınızı gösteriyor. Çoğu için hiçbir araca gerek yok; açık kaynaklı BV-SALA SDK'sının bir kaldıracı otomatikleştirdiği yerlerde bunu nasıl yaptığını da göreceksiniz.

## İşe her isteği ölçerek başlayın

Herhangi bir şeyi değiştirmeden önce, her yanıtın `usage` bloğunu, onu üreten özellik ya da prompt şablonuyla birlikte loglayın: `prompt_tokens`, `prompt_tokens_details.cached_tokens`, modelin bildirdiği durumlarda `cache_write_tokens`, `completion_tokens` ve akıl yürütme modellerinde `completion_tokens_details.reasoning_tokens`. Her kalemi OpenAI'ın fiyatlandırma sayfasındaki tarifelerle fiyatlandırın ve tarifeleri hangi tarihte aldığınızı not edin. GPT-5.6 ve sonrasında önbellek yazmaları ayrı bir kalemdir: OpenAI bunları varsayılan 30 dakikalık ömürde önbelleğe alınmamış girdi fiyatının 1,25 katı, 12 saatlik ömürde ise 2,5 katı üzerinden faturalar ([prompt caching rehberi](https://developers.openai.com/api/docs/guides/prompt-caching), 23 Kasım 2026'da erişildi). Bunları normal girdi gibi fiyatlarsanız maliyeti eksik hesaplarsınız. Bir haftalık veri, başlangıçta önemli olan tek soruyu yanıtlar: **Faturanın büyük kısmını hangi iki ya da üç özellik oluşturuyor?** Bunları optimize edin; gerisini boş verin.

## 1. Aynı istek için iki kez ödemeyin

Yeniden denemeler, çift tıklamalar, dünkü öğeleri yeniden sınıflandıran gece işleri ve aynı prompt'u gönderen paralel worker'lar her seferinde tam bir çağrıya mal olur. Birebir eşleşme yanıt önbelleği ve eşzamanlı istek tekilleştirmesi, tek bir yanıtı bile değiştirmeden bunları ortadan kaldırır. Ne kadar tasarruf edeceğiniz tamamen isteklerinizin ne sıklıkla tekrarlandığına bağlıdır; bu yüzden önce yinelenme oranınızı ölçün. Ayrıntılı rehber: [aynı LLM isteklerini tekilleştirme](/tr/guides/deduplicate-llm-requests).

## 2. OpenAI'ın prompt önbelleğinin çalışmasına izin verin

Yaklaşık 1.024 token ve üzerindeki prompt'lar otomatik olarak önbelleğe alınır ve önbellekten gelen girdi token'ları indirimli faturalanır. GPT-5.6 ve sonrasında önbelleği doldurmak ücretsiz değildir: Önbelleğe yazılan kısım, yukarıda anlatıldığı gibi önbelleğe alınmamış girdi tarifesinden daha yüksek bir fiyatla faturalanır. Bu yüzden yazılıp bir daha hiç okunmayan bir prompt önbelleksiz durumdan daha pahalıya gelir, kısa süre içinde yeniden okunan ise çok daha ucuza. Daha eski modeller yazmalar için ek ücret almaz. Önbellek yalnızca ilk token'dan itibaren eşleşir; dolayısıyla yalnızca prompt'unuzun başı istekler arasında birebir aynıysa işe yarar. Talimatları, araç tanımlarını ve örnekleri başa; tarihleri, kullanıcı adlarını ve soruyu sona koyun. `cached_tokens` değeri 0'da takılı kaldıysa [OpenAI'da cached_tokens neden 0](/tr/guides/openai-prompt-caching-cached-tokens) rehberine bakın.

## 3. Bekleyebilecek işleri Batch API'ye gönderin

Değerlendirmeler, geriye dönük veri doldurma işleri, bir belge kümesinin embedding'leri ve gece çalışan sınıflandırmalar iki saniyede yanıt beklemez. OpenAI'ın [Batch API](https://developers.openai.com/api/docs/guides/batch)'si bir istek dosyası alır, sonuçları bir gün içinde döndürür ve bunları aynı isteklerin tek tek gönderilmesinden daha düşük bir tarifeyle faturalar (güncel koşullar için [maliyet optimizasyonu rehberine](https://developers.openai.com/api/docs/guides/cost-optimization) bakın). Çevrimdışı işlerde çoğu zaman en büyük tekil tasarruftur ve yanıtlarda hiçbir şeyi değiştirmez.

## 4. Değerlendirmenizi geçen en küçük modeli kullanın

Model kademeleri arasındaki fiyat farkları büyüktür ve pek çok görev (sınıflandırma, bilgi çıkarma, kısa yeniden yazımlar, yönlendirme) en büyük modele ihtiyaç duymaz. Gerçek isteklerden küçük bir değerlendirme seti oluşturun, iki ya da üç modelde çalıştırın ve geçen en ucuz modeli seçin. Yeni bir model çıktığında testi tekrarlayın. Değerlendirme olmadan model düşürmek tahminden ibarettir ve yanlış yanıtların maliyeti API faturasında görünmez.

## 5. Çıktıyı kontrol altında tutun

Çıktı token'ları genellikle girdi token'larından birkaç kat daha pahalıdır ve akıl yürütme token'ları çıktı olarak faturalanır.

- `max_completion_tokens` değerini özelliğin gerçekten ihtiyaç duyduğu kadar ayarlayın.
- Akıl yürütme modellerinde, derin akıl yürütme gerektirmeyen görevlerde akıl yürütme seviyesini düşürün ve `reasoning_tokens` değerini öncesinde ve sonrasında ölçün.
- Kodunuz yanıtı ayrıştırıyorsa JSON şemasıyla yapılandırılmış çıktı isteyin. Ayrıştırma hatasının ardından gelen bir yeniden deneme, isteğin tamamı için iki kez ödemek demektir.

## 6. Daha az girdi gönderin

- Görev yalnızca son turlara ihtiyaç duyuyorsa konuşmanın tamamını yeniden göndermeyin.
- Büyük araç çıktılarını (loglar, dosya içerikleri, arama sonuçları) kullanıldıktan sonra sonraki turların dışında tutun.
- Yapılandırılmış verileri kompakt gönderin: Girintili (pretty-printed) JSON, boşluklara token harcar.
- Belgenin tamamını yapıştırmak yerine ilgili üç paragrafı getirin.

Uzun ajan döngülerinde son ikisine dikkat edin: OpenAI'ın zaten önbelleğe aldığı bir geçmişin ortasını düzenlemek, düzenlemeden sonraki her şeyin yeniden faturalanmasına yol açar; önbelleğe alınmamış tarifeden ya da GPT-5.6 ve sonrasında, yeniden önbelleğe alındığında daha yüksek önbellek yazma tarifesinden. Önbellekteki kısmı değil, yeni olanı kısaltın.

## BV-SALA bunların bir kısmını nasıl otomatikleştirir

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer), TypeScript'te OpenAI uyumlu herhangi bir endpoint'i saran, Apache-2.0 lisanslı bir tasarruf katmanıdır. Tüm kaldıraçlarla **ücretsiz, anahtarsız ve kayıt olmadan** tasarruf eder ve isteğe bağlı bulut paneli için bir anahtar eklemediğiniz sürece BiVelio'ya hiçbir şey göndermez. Varsayılan olarak açık olanlar: tam eşleşme önbelleği, eşzamanlı aynı isteklerin tekilleştirilmesi, yalın aritmetiğin yerelde yanıtlanması ve gönderdiğiniz yapılandırılmış verilerin kompakt serileştirilmesi. Her biri tek bir seçenekle açılanlar: model kaskadı, araç çıktısı sıkıştırma ve önbelleğe alınabilir önek için yeniden sıralama. Her istek, neyin tasarruf edildiğini ve sayının nereden geldiğini söyleyen bir rapor döndürür.

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

İki dürüst sınır var. Birincisi, hiç tekrarlanmayan trafik önbellek ve tekilleştirmeden tasarım gereği yaklaşık %0 tasarruf eder. İkincisi, katmanın yerini yenisi almış araç sonuçlarını varsayılan olarak kırpması, prompt'un tamamını önbelleğe alan bir sağlayıcıda uzun ajan döngülerinde kazandırdığından fazlasına mal olabilir: Projenin changelog'u, `gpt-5` üzerinde 60 adımlık bir döngüde +%12,2 bildiriyor; ölçüm, sahte bir sağlayıcıya karşı 1.2.3 ve 1.2.4 sürümleriyle ve anahtarsız yapıldı; 1.2.5 de aynı şekilde kırpar. Uzun ajan döngülerinde istekte `savings: { elision: false }` geçin ve karşılaştırın.

## Her tasarrufu OpenAI'ın sayılarıyla kanıtlayın

Kontrol edemediğiniz bir tasarruf, bir projeksiyondur. Her kaldıraç için:

1. **Değiştirmesi gereken sayacı seçin.** Önbellek ve tekilleştirme istek sayısını değiştirir. Prompt caching `cached_tokens` değerini, GPT-5.6 ve sonrasında ayrıca `cache_write_tokens` değerini değiştirir. Batch fiyatı değiştirir. Model seçimi token başına fiyatı değiştirir. Çıktı kontrolü `completion_tokens` değerini değiştirir.
2. **O sayacı OpenAI'dan okuyun.** [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage), istek sayısını ve girdi, önbellekten gelen girdi ve çıktı token'larını gün, model, proje ve anahtar bazında döndürür. Tutarları Costs endpoint'i ve kullanım paneli verir.
3. **Karşılaştırılabilir olanı karşılaştırın.** Aynı özellik, haftanın aynı günleri, öncesi ve sonrası; daha iyisi, aynı trafiğin aynı anda çalışan iki kolu. Önce token'lara, sonra dolara bakın: Dolar tutarları fiyatlarla birlikte de değişir.

Katmanla birlikte her rapor `cost.basis` alanını taşır: `measured` ve `reference` tutarları OpenAI'ın kendi sayacından gelir, `estimated` tutarlar ayrı raporlanır ve asla onlara karıştırılmaz. Yöntemin tamamı: [LLM tasarruflarını sağlayıcı faturasıyla doğrulama](/tr/guides/verify-llm-savings-against-provider-bill).

## Yayımlanan sayılar ne diyor

Projenin [benchmark sayfası](/tr/benchmarks), her testin iki kolunu da sağlayıcının kendi kullanım sayacıyla ölçer. İsteklerin %30'unun birebir tekrar olduğu, GSM8K sorularından oluşturulmuş herkese açık bir iş yükünde `gpt-4o-mini` üzerindeki toplu azalma **%31,50** oldu; %95 aralığı %25,7 ile %36,7 arasındaydı (SDK 0.4.31 artefaktları, Eylül 2026; README'de de yer alıyor). Tekrarsız iki turlu sohbette (MT-Bench) farklar sıfırdan ayırt edilemedi ya da katmana atfedilemedi ve sayfa bunu açıkça söylüyor. Yöntem, aralıklar ve tüm sınırlamalar [makalede](/tr/paper) yer alıyor. Kod [GitHub](https://github.com/BiVelio/bivelio-savings-layer)'da.
