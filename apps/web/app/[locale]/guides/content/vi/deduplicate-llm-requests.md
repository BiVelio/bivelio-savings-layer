Mọi API LLM đều tính phí theo lệnh gọi. Nếu ứng dụng của bạn gửi cùng một yêu cầu hai lần, bạn trả tiền hai lần, dù câu trả lời thứ hai không thêm được gì. Hướng dẫn này trình bày hai kỹ thuật để chấm dứt điều đó: **cache phản hồi khớp chính xác** cho các lần lặp lại đến sau, và **gộp yêu cầu đang chạy (in-flight coalescing)** cho các yêu cầu giống hệt đến cùng một lúc. Cả hai đều dùng được với mọi ngôn ngữ và mọi nhà cung cấp. Cuối bài, bạn sẽ thấy SDK mã nguồn mở BV-SALA làm cả hai theo mặc định như thế nào, và cách đối chiếu khoản tiết kiệm với chính số liệu sử dụng của nhà cung cấp.

## Yêu cầu trùng lặp đến từ đâu

Trùng lặp phổ biến hơn bạn tưởng, vì chúng hiếm khi đến từ một chỗ dễ thấy:

- **Retry và bấm đúp.** Người dùng bấm "Generate" hai lần, hoặc một thư viện client retry sau một lần timeout mà thực ra nhà cung cấp đã trả lời.
- **Batch job và cron.** Một job chạy đêm phân loại lại đúng những mô tả sản phẩm, mục FAQ hay macro chăm sóc khách hàng mà nó đã phân loại hôm qua.
- **Fan-out.** Hai worker, hai tab trình duyệt hoặc một effect React chạy hai lần ở chế độ development gửi cùng một prompt trong vòng vài mili giây.
- **Agent và pipeline.** Một pipeline nhiều bước hỏi cùng một câu hỏi phụ ở nhiều nhánh.
- **Test và eval.** CI chạy cùng các fixture với API thật ở mỗi lần push.

Nhóm đầu và nhóm cuối là lặp lại theo thời gian; fan-out là chuyện đồng thời. Chúng cần cách sửa khác nhau, đó là lý do hướng dẫn này nói về cả hai.

## Đo tỷ lệ trùng lặp trước tiên

Trước khi xây bất cứ thứ gì, hãy tìm hiểu bao nhiêu phần lưu lượng của bạn bị lặp lại. Băm (hash) mọi body yêu cầu trong một ngày rồi đếm. Key phải **chuẩn tắc (canonical)**: cùng một yêu cầu phải cho ra cùng các byte, bất kể thứ tự các key JSON.

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

Nếu tỷ lệ gần bằng không, cache phản hồi sẽ không tiết kiệm được nhiều, và bạn nên xem [prompt caching](/vi/guides/claude-prompt-caching-not-working) hoặc [chọn mô hình](/vi/guides/reduce-openai-api-costs) thay vào đó. Nếu một phần đáng kể yêu cầu của bạn lặp lại, hãy đọc tiếp.

## Xây một cache key thực sự an toàn

Một cache khớp chính xác chỉ tốt bằng key của nó. Quy tắc rất đơn giản: **mọi thứ có thể làm thay đổi câu trả lời đều phải nằm trong key, và không có gì bị chuẩn hóa bỏ đi.**

- Id mô hình, toàn bộ danh sách message, system prompt, định nghĩa công cụ, response format hoặc JSON schema, và mọi tham số lấy mẫu (`temperature`, `top_p`, `max_tokens`, `seed`, reasoning effort).
- Một **phạm vi (scope)** khi prompt mang dữ liệu người dùng. Hai người dùng cùng hỏi "số dư của tôi là bao nhiêu?" gửi cùng một đoạn văn bản nhưng cần hai câu trả lời khác nhau. Hãy đưa id người dùng hoặc tenant vào key, hoặc hoàn toàn không cache những yêu cầu đó.
- Không chuẩn hóa kiểu "thông minh". Chuyển về chữ thường, cắt khoảng trắng hay bỏ dấu câu để được nhiều lượt trúng hơn sẽ biến cache khớp chính xác thành cache gần đúng, và cache gần đúng có thể trả về câu trả lời cho một câu hỏi khác.

## Những gì không bao giờ được trả từ cache

Một số yêu cầu có lặp lại nhưng vẫn phải đến được mô hình mỗi lần:

- **Câu trả lời buộc phải thay đổi**: "chọn một cái tên ngẫu nhiên", "tạo mật khẩu", "bây giờ là mấy giờ", "giá hôm nay". Trả lời từ cache ở đây là bug, không phải tiết kiệm.
- **Công cụ có tác dụng phụ.** Nếu phản hồi yêu cầu gọi `send_email` hay `create_order`, phát lại nó sẽ bỏ qua hành động. Chỉ cache những yêu cầu mà công cụ chỉ đọc (read-only), hoặc không có công cụ nào.
- **Đầu ra lấy mẫu mà người dùng mong sẽ khác nhau.** Với `temperature` cao, một câu trả lời từ cache chỉ là một mẫu, được trả về mãi mãi.
- **Lỗi, câu trả lời rỗng, lời từ chối và câu trả lời bị cắt cụt.** Đừng bao giờ ghi chúng vào cache; hãy để yêu cầu tiếp theo thử lại.
- **Chủ đề nhạy cảm.** Một bot chăm sóc khách hàng không nên cache câu trả lời về tự gây hại hay cấp cứu y tế; hãy gửi những yêu cầu đó tới mô hình mỗi lần.

## Gộp các yêu cầu giống hệt đang chạy

Cache chỉ có ích sau khi câu trả lời đầu tiên đã về. Nếu mười yêu cầu giống hệt bắt đầu trong cùng 300 ms, cả mười đều trượt. Cách sửa là một pattern nhỏ thường được gọi là *singleflight*: bên gọi đầu tiên thực hiện lệnh gọi thật, các bên gọi còn lại chờ cùng một promise.

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

Có ba chi tiết quan trọng khi chạy production. Lỗi phải đến được mọi bên đang chờ (pattern ở trên đã làm điều đó). Một bên gọi hủy không được làm hủy lệnh gọi dùng chung của các bên khác. Và streaming thì khó hơn: một stream đã bắt đầu không thể cứ thế trao cho bên gọi thứ hai, nên hầu hết các cài đặt cho phép một yêu cầu thường nhập vào lệnh gọi đang chạy nhưng không cho bất cứ thứ gì nhập vào một stream.

## BV-SALA làm điều này thế nào

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) là một lớp tiết kiệm theo giấy phép Apache-2.0 cho TypeScript. SDK của nó bọc nhà cung cấp của bạn và, **không cần khóa và không cần đăng ký**, bật cả hai kỹ thuật theo mặc định: cache khớp chính xác và khử trùng lặp các yêu cầu đang chạy. Nó cũng áp dụng các quy tắc "không bao giờ cache" ở trên: các yêu cầu có cách diễn đạt đòi dữ liệu mới nhất hoặc tính ngẫu nhiên, cách diễn đạt mang tính cá nhân mà không có phiên, chủ đề nhạy cảm, lời từ chối và lỗi đều nằm ngoài cache.

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

Một yêu cầu trông có vẻ cá nhân ("đơn hàng của tôi", "hóa đơn của chúng tôi") sẽ không được cache trừ khi bạn nói rõ nó thuộc về ai. Truyền một scope và cache lại hoạt động, riêng cho từng phiên:

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

Cache mặc định nằm trong bộ nhớ của một tiến trình. Để chia sẻ nó giữa nhiều server hoặc instance serverless, hãy truyền một store do bạn vận hành qua tùy chọn `exactCache`. Nó chỉ cần ba method, nên kho key-value nào cũng dùng được:

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

Các câu trả lời được cache nằm lại trong hạ tầng của bạn. Không có gì được gửi về BiVelio khi bạn chạy không có khóa.

## Đối chiếu khoản tiết kiệm với số liệu của nhà cung cấp

Khoản tiết kiệm từ cache rất dễ kiểm tra, vì nó là số lệnh gọi đã không xảy ra.

1. **Đếm lệnh gọi ở cả hai phía.** Trong một ngày, đếm số lệnh gọi `generate()` mà ứng dụng của bạn thực hiện và so với số yêu cầu nhà cung cấp hiển thị cho cùng khóa API và mô hình (trang usage trong console của OpenAI hoặc Anthropic, hoặc usage API của họ). Chênh lệch phải bằng tổng `report.calls.avoidedLlm`.
2. **Xem mỗi lần lặp lại được định giá thế nào.** `report.cost.basis` cho biết con số đến từ đâu. Một lần lặp lại là `reference` khi lệnh gọi giống hệt đã thực sự chạy đi thẳng tới API của OpenAI, Anthropic hoặc Gemini của Google (`api.openai.com`, `api.anthropic.com` hoặc `generativelanguage.googleapis.com`): đường cơ sở của nó là bộ đếm usage của chính lệnh gọi đó, được định giá một cách thận trọng theo giá đầu vào từ cache. Nó vẫn là `estimated` khi lệnh gọi đã chạy đi tới bất kỳ đâu khác, kể cả API riêng của một nhà cung cấp khác như DeepSeek, một proxy, Azure hay một gateway, vì bảng giá niêm yết của lớp này chỉ được biết là khớp với hóa đơn trên ba API đó. Tiền ước tính luôn được báo cáo riêng.
3. **So sánh chi tiêu, không chỉ số lệnh gọi.** Cộng `report.cost.netSavingsUsd` theo từng basis. Đừng bao giờ cộng các khoản đo được với các khoản ước tính, và đừng bao giờ lấy trung bình `netSavingsRatio` giữa các yêu cầu.

Nếu muốn một phép thử sạch hơn, hãy chạy cùng một tải hai lần, một lần tắt các đòn bẩy cho lượt chạy đó (`savings: { exactCache: false, singleflight: false }` trên mỗi yêu cầu) và một lần với mặc định, rồi so sánh hai hóa đơn.

## Các con số công khai nói gì

Repository công bố các lượt chạy benchmark của mình. Trên một tải công khai xây từ các câu hỏi GSM8K, trong đó 30 % yêu cầu là lặp lại y hệt, mức giảm gộp đo được là **31.50 %** với `gpt-4o-mini`, khoảng tin cậy 95 % từ 25.7 % đến 36.7 % (artifact của SDK 0.4.31 từ tháng 9 năm 2026; nguồn: [trang benchmark](/vi/benchmarks#savings) và README). Trên lưu lượng không bao giờ lặp lại, khoản tiết kiệm vào khoảng 0 %, và [trang benchmark](/vi/benchmarks#no-savings) cũng hiển thị những kết quả đi ngang đó. Trang này còn đếm lỗi quan trọng nhất với một cache: **0 trên 198** biến thể câu hỏi bị trả về câu trả lời của một câu hỏi khác ([các cam kết](/vi/benchmarks#guarantees)).

Khoản tiết kiệm của bạn phụ thuộc vào tỷ lệ trùng lặp, nên hãy đo nó trước bằng đoạn mã ở đầu trang này. Mã nguồn, bài báo và các báo cáo thô có trên [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
