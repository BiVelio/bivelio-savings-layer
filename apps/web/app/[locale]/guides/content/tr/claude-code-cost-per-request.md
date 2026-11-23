"Claude Code ne kadar tutar?" sorusunun iki dürüst cevabı var. Bir Claude aboneliğinde ödediğiniz fiyat planın ücretidir ve token başına maliyet ancak planın limitlerini aştığınızda önem kazanır. Bir API anahtarında ya da bir bulut sağlayıcısında token başına ödersiniz ve bir oturumun maliyeti, Claude Code'un kaç istek gönderdiğine, her birinin ne kadar büyük olduğuna ve ne kadarının prompt önbelleğinden okunduğuna bağlıdır. Bu rehber Anthropic'in ne yayımladığını, hangi yerleşik araçların size toplamları verdiğini ve bir oturumu pahalı yapan turları bulabilmeniz için her bir isteğin maliyetini kendi makinenizde, ücretsiz olarak nasıl göreceğinizi gösteriyor.

## Anthropic'e göre Claude Code ne kadar tutar

Anthropic'in kendi [Claude Code maliyet sayfası](https://code.claude.com/docs/en/costs), kurumsal kurulumlardan alınmış ortalamalar veriyor: geliştirici başına aktif gün başına yaklaşık $13 ve geliştirici başına aylık $150 ile $250 arası; kullanıcıların %90 kadarı aktif gün başına $30 altında kalıyor. Bunlar birçok ekibin ortalamaları. Sizin sayınız seçtiğiniz modele, deponuzun büyüklüğüne ve çalışma biçiminize bağlı; bu rehberin geri kalanı da bu yüzden onu ölçmekle ilgili.

## Yerleşik araçlar ve göstermedikleri

- **Claude Code'daki `/usage`.** Session bloğu liste fiyatıyla *tahmini* bir maliyet gösterir; model başına token'lar girdi, çıktı, önbellek okumaları ve önbellek yazmaları olarak ayrılır. Yeni sürümler isabet oranını ve ıska sayısını içeren bir prompt önbelleği satırı ekler. Bu, yerelde hesaplanan bir oturum toplamıdır.
- **Claude Console.** API anahtarları için Cost ve Usage sayfaları, nelerin faturalandığını gün, workspace ve model bazında gösterir. Mutabakat yapmanız gereken sayı budur.
- **OpenTelemetry dışa aktarımı.** Claude Code, token ve maliyet metriklerini kullanıcı ve oturum bazında kendi gözlemlenebilirlik altyapınıza aktarabilir ([izleme belgeleri](https://code.claude.com/docs/en/monitoring-usage)).

Bunların hiçbiri **istek başına görünümü** kolaylaştırmaz: hangi turun pahalı olduğunu ve nedenini. Bir oturum onlarca ya da yüzlerce API çağrısından oluşur ve pahalı olanların tanınabilir nedenleri vardır:

- **Soğuk önbellek.** Önbellek ömründen uzun bir aradan sonraki ilk tur, konuşmanın tamamını tam fiyattan yeniden okur ve yeniden yazar.
- **Model değişikliği.** Her modelin kendi önbelleği vardır; bu yüzden oturumun ortasında model değiştirmek her şeyi yeniden işletir.
- **Devasa araç sonuçları.** Bir kez okunan bir test logu ya da büyük bir dosya, sonraki her turun bağlamında kalır.
- **Çok fazla araç tanımı.** MCP sunucuları her isteğe kilobaytlarca tanım ekleyebilir.
- **Sıkıştırma (compaction).** Uzun bir konuşmayı özetlemek başlı başına büyük bir istektir.

## Her isteği yerel bir gateway ile ölçün

Gateway, Claude Code ile API arasında duran ve her yanıtın kullanım sayaçlarını okuyan küçük bir proxy'dir. Claude Code bunu `ANTHROPIC_BASE_URL` üzerinden resmi olarak destekler. [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer), npm paketinde bir gateway ile gelir: Apache-2.0, **anahtarsız, kayıt olmadan** ve BiVelio'ya hiçbir şey gönderilmez. Node.js 20 veya daha yenisini gerektirir.

Tek komutluk yol:

```bash
# Starts a local gateway on a free port, runs Claude Code through it, and stops it on exit.
npx @bivelio/savings-layer claude
```

Wrapper, Claude Code'un arayüzünün üzerine yazmaması için istek başına logu sessiz tutar. Çıkışta kaç isteği ölçtüğünü, hangilerini ölçmeden ilettiğini ve nedenini yazdırır. Her isteği anında görmek için ya logu stderr'e isteyin:

```bash
BVSALA_GATEWAY_LOG=1 npx @bivelio/savings-layer claude
```

ya da gateway'i kendi terminalinde, sabit bir portta çalıştırın:

```bash
# Terminal 1: the gateway (Anthropic is the default upstream, port 8402)
npx @bivelio/savings-layer gateway

# Terminal 2: Claude Code, pointed at it (no /v1 at the end).
# ENABLE_TOOL_SEARCH=true only matters before Claude Code v2.1.304 (see below).
ENABLE_TOOL_SEARCH=true ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude
```

Her istek tek bir satıra dönüşür. Aşağıdaki iki satır, uydurma trafikle bir yedek sunucuya karşı yapılan yerel bir testten geliyor; yani biçim gerçek, sayılar sizin değil:

```text
[gateway] POST /v1/messages  · claude-sonnet-5 · $0.007700 (in 40, cache↑3000 cache↓0, out 12)
[gateway] POST /v1/messages  · claude-sonnet-5 · $0.000800 (in 40, cache↑0 cache↓3000, out 12)
```

Soldan sağa okuyun: model, modelin standart liste fiyatıyla maliyet (hızlı mod turları istisnadır, aşağıya bakın), ardından tam fiyattan faturalanan girdi token'ları, önbelleğe yazılan token'lar (`cache↑`), önbellekten okunanlar (`cache↓`) ve çıktı token'ları. İlk satır öneki yazan soğuk bir tur; ikincisi onu fiyatın küçük bir kısmına geri okuyor. `cache↑` değerinin tur üstüne tur büyük kaldığı bir oturumda önbellek sorunu vardır: [Claude prompt caching neden çalışmayı bırakır](/tr/guides/claude-prompt-caching-not-working) rehberine bakın.

`ENABLE_TOOL_SEARCH=true`, Claude Code sürümünüze bağlıdır. v2.1.304'ten beri tool search bir gateway'in arkasında da açık kalır ([Claude Code'un MCP belgeleri](https://code.claude.com/docs/en/mcp)) ve değişken hiçbir şeyi değiştirmez. v2.1.304'ten önce Claude Code, Anthropic'inki olmayan her base URL'nin arkasında tool search'ü kapatıyor ve her araç tanımını her isteğe koyuyordu. Bu eski sürümlerde bunun maliyeti yüksekti: Gateway'in npm paketiyle gelen Claude Code rehberi, 9 Eylül 2026'da ölçülen ve 226 MCP aracı içeren bir kurulumu kaydediyor; orada bu, istek başına 450 KB ve o günkü faturanın dörtte biri anlamına geliyordu. `claude` wrapper'ı, siz zaten ayarlamadıysanız değişkeni sizin yerinize ayarlar.

## Gateway neyi görür, neyi görmez

- **Claude Code'un gönderdiğini iletir.** Bir isteğe hiçbir kaldıraç uygulanmadığında gövde Anthropic'e bayt bayt ulaşır; `cache_control` işaretleri ve `anthropic-beta` başlığı dahil. Böylece önbellek, gateway olmadan nasıl çalışıyorsa aynen öyle çalışır. Depodaki bir test bunu her değişiklikte sahte bir upstream'e karşı kontrol eder.
- **İki küçük çağrı onu atlar.** Claude Code'un [gateway uyumluluk rehberine](https://code.claude.com/docs/en/llm-gateway-protocol) göre hızlı mod kullanılabilirlik kontrolü ve WebFetch alan adı güvenlik kontrolü, `ANTHROPIC_BASE_URL` değerini izlemek yerine doğrudan `api.anthropic.com` adresini çağırır. İkisi de model isteği değildir: Hızlı mod çıkarımının kendisi base URL'yi izler ve gateway'den geçer.
- **Hızlı mod turları standart fiyatla loglanır.** Anthropic, hızlı moddaki bir isteği `speed: "fast"` ile işaretler ve primli faturalar: Claude Opus 5.5'te milyon token başına girdi için $8, çıktı için $40; yani standart tarifenin iki katı, üstüne önbellek çarpanları ([hızlı mod belgeleri](https://platform.claude.com/docs/en/build-with-claude/fast-mode)). Gateway'in 1.2.3 sürümü `speed` alanını okumaz; bu token'ları doğru sayar ama standart turlar gibi fiyatlar: Opus 5.5'te Anthropic'in faturaladığının yarısı. `/fast` kullanıyorsanız gateway'in bu turlar için verdiği toplam düşük kalır.
- **Abonelik trafiği ölçülür, faturalanmaz.** Claude Pro veya Max hesabıyla oturum açıldığında token başına fatura yoktur; gateway bu trafiği görebilmeniz için liste fiyatı karşılığıyla fiyatlar ve ona hiçbir tasarruf yazmaz.

## Gateway para da kazandırır mı?

Kutudan çıktığı haliyle, bir API anahtarıyla çalışan Claude Code'da yalnızca ölçer, hiçbir şey kazandırmaz. 1.2.3 sürümünün başlangıç mesajını bir vaat olarak okumayın: Tüm yerel tasarruf kaldıraçlarının açık olduğunu söyler ve çıkış özeti yalnızca ölçtüğü istekleri sayar; yani ikisi de size tasarrufun sıfır olduğunu söylemez. Gateway'in varsayılan kaldıracı, isteğin büyük kısmının yeni olduğu turlarda önbellek yazma ömrünü bir saatten beş dakikaya indirir; çünkü bir saatlik yazma girdi fiyatının iki katına, beş dakikalık yazma 1,25 katına mal olur. API anahtarıyla çalışan Claude Code, `promptCacheTtl` değerini `1h` yapmadığınız sürece zaten beş dakika ister; yani düşürülecek bir şey yoktur.

Bir saatlik önbellek devredeyken tasarruf küçüktür ve trafiğinize bağlıdır. [Benchmark sayfası](/tr/benchmarks#gateway-ttl), bir kuruluşun kendi Claude Code trafiğinin yeniden oynatımını (replay) yayımlıyor: liste fiyatıyla faturanın net **+%2,49**'u ($4.563,61 içinden $113,45), oturum bazında yeniden örneklemeyle %95 aralığı +%1,50 ile +%3,57 arası ve bu türden herhangi bir politika için %7,2 tavan. Bir modelde sonuç sıfıra yakındı, bir dönemde ise zarar ettirdi. Bu, kısmen yeniden kurulmuş bir referans çizgisiyle yapılmış bir yeniden oynatım, bir fatura değil ve sayfa tüm sınırlamaları listeliyor.

## Gateway'in sayılarını faturanızla karşılaştırın

1. **`/usage` ile.** Bir oturum için gateway'in istek başına maliyetlerini toplayın ve `/usage` içindeki Session bloğuyla karşılaştırın. İkisi de aynı sayaçları liste fiyatıyla fiyatlar, dolayısıyla birbirine yakın olmalıdır; istisna, `/usage` aracının hızlı mod tarifesiyle, 1.2.3 gateway'inin ise standart tarifeyle fiyatladığı hızlı mod turlarıdır.
2. **Console ile.** Bir gün boyunca ayrı bir API anahtarı ya da workspace kullanın, sonra gateway'in model başına toplamlarını o anahtar için Console'daki Usage sayfasıyla karşılaştırın: girdi, çıktı, önbellek yazmaları ve önbellek okumaları; önce token, sonra dolar olarak.
3. **Her farkı açıklayın.** Liste fiyatı her zaman sizin fiyatınız değildir: Sözleşmeli indirimler, veri yerleşimi ya da öncelik katmanları tutarı değiştirir ama token sayılarını değiştirmez. Hızlı mod da öyle: `/fast` açıkken gateway'in toplamı Console'unkinin altında kalır, çünkü 1.2.3 hızlı mod turlarını standart tarifeyle fiyatlar. Bu gateway'den geçmeyen trafik, örneğin aynı anahtarı kullanan başka bir makine, bir betik ya da bir CI işi, yalnızca Console'da görünür.

Token sayıları tutuyor ama dolar tutmuyorsa fark ölçümde değil fiyatlandırmadadır. Yöntemin tamamı için [LLM tasarruflarını sağlayıcı faturasıyla doğrulama](/tr/guides/verify-llm-savings-against-provider-bill) rehberini okuyun.

## Faturayı görebildiğinizde düşürmek

İstek başına sayılar önünüzdeyken olağan çözümler basittir: Uzun bir bağlamı taşımak yerine birbiriyle ilgisiz görevler arasında bağlamı temizleyin, modeli oturumdan önce seçip ona bağlı kalın, doğal molalarda sıkıştırın, büyük logları bağlamın dışında tutun ve kullanmadığınız MCP sunucularını ayıklayın. Claude Code'un arkasında başka bir sağlayıcının modelini kullanmak, [DeepSeek ve Qwen API maliyetleri](/tr/guides/deepseek-qwen-api-cost-local-gateway) rehberinde anlatılıyor.

Gateway'in kaynak kodu, Claude Code rehberi ve isteklerinizi değiştirmeden ilettiğini doğrulayan testler [GitHub](https://github.com/BiVelio/bivelio-savings-layer)'da.
