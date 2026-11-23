OpenAI tự động cache các prompt dài: khi phần đầu của một yêu cầu khớp với một yêu cầu nó vừa xử lý gần đây, các token đầu vào đó được tính giá chiết khấu và câu trả lời bắt đầu sớm hơn. Bạn không phải bật gì cả. Cũng chính vì thế mà khi nó ngừng hoạt động, bạn rất dễ không nhận ra. Nếu `cached_tokens` trả về `0` ở mọi yêu cầu, hướng dẫn này liệt kê các nguyên nhân theo thứ tự nên kiểm tra, chỉ cách theo dõi tỷ lệ trúng cache theo từng yêu cầu, và cách đối chiếu với chính dữ liệu sử dụng của OpenAI.

## Đọc ở đâu

Mỗi phản hồi đều cho biết bao nhiêu token đầu vào đến từ cache:

- **Chat Completions:** `usage.prompt_tokens_details.cached_tokens`, trên tổng `usage.prompt_tokens`.
- **Responses API:** `usage.input_tokens_details.cached_tokens`, trên tổng `usage.input_tokens`.

Token từ cache là một phần của tổng đầu vào, không cộng thêm vào đó. [Hướng dẫn prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) của OpenAI là tài liệu tham chiếu cho các quy tắc hiện hành. Hướng dẫn này giờ phân biệt các mô hình mới hơn, vốn cũng báo cáo và tính phí ghi cache và chấp nhận các tùy chọn cache tường minh, với các mô hình cũ hơn, nơi việc ghi vào cache là miễn phí. Hãy kiểm tra phần dành cho mô hình bạn dùng.

## Vì sao cached_tokens bằng 0

1. **Prompt quá ngắn.** Caching bắt đầu từ khoảng 1,024 token prompt; ngưỡng chính xác và cách làm tròn số token từ cache phụ thuộc vào mô hình. Một system prompt 600 token cộng một câu hỏi ngắn sẽ không bao giờ trúng cache, và không có gì báo cho bạn biết.
2. **Phần đầu prompt thay đổi.** Cache khớp từ token đầu tiên. Một timestamp, một request id hay tên người dùng trong message đầu tiên khiến mọi yêu cầu khác nhau ngay từ token thứ nhất. Tools, hình ảnh và response format cũng là một phần của tiền tố, nên tools được liệt kê theo thứ tự khác, hay một schema được tuần tự hóa khác đi, đều làm hỏng việc so khớp.
3. **Cache đã bị loại bỏ (evict).** Các mục được giữ một thời gian ngắn sau lần dùng cuối, thường là vài phút khi lưu lượng thưa. Các yêu cầu cách nhau một giờ hiếm khi trúng.
4. **Lưu lượng bị phân tán.** Các yêu cầu được định tuyến theo hash của phần đầu prompt. Lưu lượng rất lớn với cùng một tiền tố sẽ tràn sang các máy khác không giữ mục cache đó. Tham số `prompt_cache_key` của OpenAI gom các yêu cầu có chung tiền tố; hãy dùng một key cho mỗi template prompt, không phải cho mỗi người dùng, và giữ tốc độ yêu cầu của mỗi key ở mức vừa phải, như hướng dẫn giải thích.
5. **Bạn không đọc trường đó.** Một yêu cầu Chat Completions dạng stream hoàn toàn không mang usage trừ khi bạn yêu cầu bằng `stream_options: { include_usage: true }`. Nhiều wrapper bỏ mất `prompt_tokens_details`. Một số nhà cung cấp tương thích OpenAI và một số deployment Azure báo cáo caching theo cách khác hoặc không báo cáo gì.

## Kiểm tra trong hai phút

Trước khi debug ứng dụng, hãy kiểm tra xem caching có hoạt động với tài khoản và mô hình của bạn hay không. Gửi cùng một prompt dài hai lần, cách nhau vài giây, rồi đọc usage của từng câu trả lời:

```bash
# A system prompt well above the threshold, sent twice. The second answer should report cached tokens.
BODY=$(python3 -c 'import json; print(json.dumps({"model": "gpt-4o-mini", "messages": [{"role": "system", "content": "You are a careful assistant for an invented shop. " * 200}, {"role": "user", "content": "Say OK."}]}))')
for i in 1 2; do
  curl -s https://api.openai.com/v1/chat/completions \
    -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" \
    -d "$BODY" | python3 -c 'import json, sys; u = json.load(sys.stdin)["usage"]; print(u["prompt_tokens"], u.get("prompt_tokens_details"))'
done
```

Nếu dòng thứ hai có token từ cache, phía nhà cung cấp vẫn hoạt động và vấn đề nằm ở cách ứng dụng của bạn dựng prompt: hãy đọc tiếp. Nếu không có, thử lại vài lần (caching chỉ là best effort, và yêu cầu đầu tiên có thể rơi vào một máy khác), rồi xem mục của mô hình đó trong hướng dẫn caching của OpenAI. Hãy thay bằng mô hình bạn dùng trong production; một bài test trên mô hình khác chẳng chứng minh được bao nhiêu.

Bài test này cũng cho bạn một đường cơ sở cho các phần tiếp theo. Khi bạn thay đổi thứ tự prompt hoặc thêm `prompt_cache_key`, hãy chạy cùng phép so sánh trên một template thật trong ứng dụng và giữ lại các con số. Một tỷ lệ trúng cache đo trước và sau thay đổi, trên một template mà người dùng thực sự gọi tới, là kết quả bạn có thể trình ra; còn "caching chắc sẽ giúp" thì không.

## Đặt phần thay đổi xuống cuối

Cách sửa cho phần lớn trường hợp là thứ tự. Mọi thứ giống nhau ở mọi yêu cầu đặt lên đầu và giữ giống hệt từng byte; mọi thứ thay đổi đặt xuống cuối.

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

Sau đó theo dõi tỷ lệ phần prompt được cache của mỗi yêu cầu, để một regression lộ ra ngay trong ngày nó được phát hành:

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

Hãy nhóm theo template prompt. Một template mà tỷ lệ này cứ ở 0 % trong khi prompt dài hơn 1,024 token là đang có thứ gì đó thay đổi gần phần đầu: hãy ghi lại hai yêu cầu và so sánh từng ký tự, như trong [phiên bản Claude của hướng dẫn này](/vi/guides/claude-prompt-caching-not-working#tìm-byte-làm-hỏng-cache-của-bạn).

## BV-SALA giúp gì

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) là một lớp tiết kiệm theo giấy phép Apache-2.0 cho TypeScript, bọc bất kỳ endpoint nào tương thích OpenAI, miễn phí và không cần khóa. Cache của OpenAI là tự động, nên lớp này không đánh dấu gì trên OpenAI. Những gì nó làm cho caching:

- **Nó luôn yêu cầu usage trên stream,** nên một yêu cầu dạng stream được đo thay vì lặng lẽ mất bộ đếm.
- **Nó hiển thị khoản chiết khấu của OpenAI ở mọi lệnh gọi,** trong `report.nativeSavings`, từ chính bộ đếm của OpenAI, và tách riêng khỏi khoản tiết kiệm của chính nó: chiết khấu đó là của OpenAI, không phải của lớp này.
- **Nó có thể đưa các dòng hay thay đổi ra khỏi tiền tố.** Với tùy chọn opt-in `savings: { cachePrefix: true }`, các dòng trong system prompt thay đổi ở mỗi yêu cầu (timestamp ISO, UUID, thời gian epoch) được chuyển xuống cuối, để phần ổn định có thể được cache. Mô hình đọc cùng những dòng đó theo thứ tự khác, vì vậy đây là quyết định của bạn và không bao giờ bật mặc định.

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

Các đòn bẩy riêng của lớp này (bỏ qua các lần lặp lại y hệt và các yêu cầu giống hệt đang chạy) tách biệt với cache của OpenAI và được giải thích trong [loại bỏ các yêu cầu LLM trùng lặp](/vi/guides/deduplicate-llm-requests).

## Đối chiếu với số liệu của OpenAI

1. **Theo từng yêu cầu:** ghi lại `cached_tokens` và tổng đầu vào từ mỗi phản hồi, hoặc `report.tokens.providerCachedInput` nếu dùng lớp này.
2. **Theo ngày:** [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) của OpenAI trả về usage của completions theo từng ngày, bao gồm token đầu vào từ cache, theo mô hình và, nếu bạn yêu cầu, theo khóa API hoặc dự án. Cộng log của bạn cho cùng khóa, mô hình và ngày UTC: tổng phần được cache và không được cache phải khớp.
3. **Bằng tiền:** tính giá đầu vào từ cache và không qua cache riêng biệt. Với các mô hình tính phí ghi cache, hãy tính cả phần ghi đó, nếu không, ước tính khoản tiết kiệm của bạn sẽ bị đội lên.

Để có phương pháp đầy đủ, hãy đọc [cách kiểm chứng khoản tiết kiệm LLM với hóa đơn của nhà cung cấp](/vi/guides/verify-llm-savings-against-provider-bill). Với các đòn bẩy còn lại trên hóa đơn OpenAI, xem [cách giảm chi phí API OpenAI](/vi/guides/reduce-openai-api-costs). Kết quả đo được, kể cả những chỗ lớp này không tiết kiệm được gì, có trên [trang benchmark](/vi/benchmarks), và mã nguồn có trên [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
