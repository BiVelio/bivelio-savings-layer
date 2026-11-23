Bạn đã thêm `cache_control` vào các yêu cầu gửi Claude, nhưng hóa đơn không hề nhúc nhích. Hoặc `cache_read_input_tokens` trả về `0` ở mọi lệnh gọi. Hướng dẫn này giải thích vì sao điều đó xảy ra, cách tìm chính xác byte làm hỏng cache của bạn, và cách đối chiếu kết quả với số liệu sử dụng của chính Anthropic. Mọi thứ ở đây đều áp dụng được với bất kỳ SDK nào. Cuối bài, bạn sẽ thấy SDK mã nguồn mở BV-SALA đặt breakpoint giúp bạn như thế nào, và trường hợp duy nhất bạn nên bảo nó đừng làm vậy.

## Đọc ba trường usage trước tiên

Mỗi phản hồi của Messages API đều cho biết điều gì đã xảy ra với cache. Hãy nhìn vào ba con số trong `usage`:

| Trường | Nó đếm gì |
| --- | --- |
| `cache_creation_input_tokens` | Token được ghi vào cache trong lệnh gọi này, tính giá cao hơn giá đầu vào thông thường |
| `cache_read_input_tokens` | Token được lấy từ cache, tính bằng một phần nhỏ giá đầu vào |
| `input_tokens` | Token nằm sau breakpoint cache cuối cùng, tính theo giá thông thường |

Ba kiểu kết quả sau cho bạn biết cần tìm ở đâu:

- **Cả hai trường cache đều bằng 0.** Không có gì được cache: tiền tố ngắn hơn mức tối thiểu của mô hình, không có breakpoint, hoặc thứ gì đó nằm giữa bạn và API đã gỡ nó đi.
- **Creation cao ở mọi lệnh gọi còn read vẫn bằng 0.** Cache được ghi nhưng không bao giờ được dùng lại: tiền tố thay đổi giữa các lệnh gọi, mục cache đã hết hạn, hoặc các lệnh gọi đi tới một mô hình hay workspace khác.
- **Read cao.** Cache đang hoạt động. Câu hỏi giờ chỉ còn là bao nhiêu phần của prompt nằm trước breakpoint.

## Prompt cache của Claude hoạt động thế nào, gói trong sáu điều

1. Nó cache một **tiền tố**: yêu cầu tính từ đầu đến một breakpoint `cache_control`. So khớp phải chính xác tuyệt đối; khác một byte là mọi thứ phía sau bị xử lý lại.
2. Thứ tự là **tools, rồi system, rồi messages**. Một thay đổi trong danh sách tools làm mất hiệu lực system prompt và các message phía sau.
3. Bạn có thể đặt tối đa **bốn breakpoint**, và từ mỗi breakpoint, API chỉ dò ngược một số block giới hạn để tìm mục cache trước đó (20 vào thời điểm viết bài).
4. Mục cache sống **năm phút** theo mặc định, được làm mới mỗi lần trúng. Có thời gian sống một giờ với `"ttl": "1h"`.
5. Ghi đắt hơn đọc: ghi năm phút tính 1.25 lần giá đầu vào và ghi một giờ tính 2 lần; đọc chỉ tốn một phần nhỏ giá đầu vào (0.1 lần trên hầu hết các mô hình). Xem [trang giá của Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) cho mô hình của bạn.
6. Có một **độ dài tối thiểu để được cache**, tùy mô hình, từ 512 đến 4,096 token. Dưới mức đó, yêu cầu đơn giản là không được cache, và không có lỗi nào.

Tất cả đều có trong [tài liệu prompt caching của Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), nguồn đáng tin nhất khi có con số thay đổi.

## Các nguyên nhân thường gặp, theo thứ tự nên kiểm tra

1. **Tiền tố quá ngắn.** Một system prompt 600 token nằm dưới mức tối thiểu trên một số mô hình. Hãy gom các chỉ dẫn ổn định, ví dụ và văn bản tham chiếu lại với nhau để phần được cache đủ dài mà thực sự có tác dụng.
2. **Có thứ gì đó trong tiền tố thay đổi ở mỗi lệnh gọi.** Những thủ phạm kinh điển: một timestamp hay dòng "Hôm nay là…" trong system prompt, một request id, tên người dùng, thứ tự ví dụ ngẫu nhiên, định nghĩa công cụ dựng từ một object có thứ tự key không cố định, hoặc một tài liệu JSON được tuần tự hóa với khoảng trắng khác nhau.
3. **Breakpoint nằm trên nội dung thay đổi.** Nếu `cache_control` cuối cùng nằm trên câu hỏi của người dùng, mỗi lệnh gọi sẽ ghi một mục mới mà không ai đọc. Breakpoint phải nằm ở cuối phần không thay đổi.
4. **Mục cache đã hết hạn.** Các lệnh gọi cách nhau hơn năm phút không bao giờ đọc được mục cache của nhau. Một batch chạy đêm xử lý mỗi mục cách nhau mười phút sẽ trả phụ phí ghi mỗi lần mà chẳng đọc được gì.
5. **Các lệnh gọi không dùng chung cache.** Một mô hình khác, một workspace khác, hay việc đổi mô hình giữa cuộc hội thoại đều bắt đầu từ một cache trống.
6. **Các lệnh gọi song song tranh nhau.** Một mục cache chỉ đọc được sau khi phản hồi đầu tiên đã bắt đầu. Mười lệnh gọi giống hệt bắn ra cùng lúc đều sẽ ghi. Hãy gửi một cái trước, rồi mới gửi phần còn lại.
7. **Một proxy gỡ mất đánh dấu.** Một gateway loại bỏ `cache_control`, hoặc biến `system` dạng block thành một chuỗi thuần, khiến toàn bộ prompt bị tính như đầu vào không qua cache trong khi mọi lệnh gọi vẫn thành công. Tài liệu của Claude Code mô tả đúng lỗi này với [LLM gateway](https://code.claude.com/docs/en/prompt-caching).

## Tìm byte làm hỏng cache của bạn

Khi read vẫn bằng 0, hãy ghi lại hai body yêu cầu liên tiếp và tìm chỗ đầu tiên chúng khác nhau, theo đúng thứ tự cache đọc chúng:

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

Nếu điểm khác biệt đầu tiên nằm trong system prompt hoặc danh sách tools, bạn đã tìm ra nguyên nhân cache miss. Hãy chuyển phần đó xuống cuối yêu cầu, thường là vào message của người dùng.

Sau đó theo dõi tỷ lệ trúng cache theo từng lệnh gọi, để một regression lộ ra ngay trong ngày nó được phát hành:

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

## Caching có đáng với lưu lượng của bạn không?

Vì ghi đắt hơn đầu vào thường, caching là một ván cược rằng tiền tố sẽ được đọc lại trước khi hết hạn. Với thời gian sống năm phút, chỉ một lần đọc đã đủ bù cho lần ghi. Một tiền tố được ghi mà không bao giờ được đọc tốn hơn khoảng 25 % so với gửi nó không kèm đánh dấu. Đó là lý do "thêm `cache_control` ở mọi nơi" không phải là một mặc định an toàn: nó có lời với lưu lượng chat và agent quay lại trong vòng vài phút, và lỗ với các yêu cầu chỉ chạy một lần hoặc các prompt thay đổi mỗi lần.

## BV-SALA xử lý việc này ra sao

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) là một lớp tiết kiệm theo giấy phép Apache-2.0. Với `AnthropicProvider`, nó đặt breakpoint giúp bạn, miễn phí và không cần khóa: một ở cuối system prompt và một ở cuối phần hội thoại không thay đổi, không bao giờ vượt quá số API cho phép. Báo cáo của mỗi lệnh gọi cho thấy cache đã làm gì, theo chính bộ đếm của Anthropic:

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

`report.nativeSavings` là khoản chiết khấu của Anthropic, hiển thị riêng: lớp này không bao giờ tính nó là khoản tiết kiệm của mình, nên báo cáo của bạn cộng lại khớp với hóa đơn.

**Trường hợp bạn nên tắt việc đánh dấu.** Khi không có khóa, nếu system prompt của bạn thay đổi ở mỗi yêu cầu (một timestamp, một user id), hoặc các lệnh gọi cách nhau hơn năm phút trong các tiến trình mới, việc đánh dấu mặc định sẽ ghi một mục cache mà không ai đọc, và README nêu rõ rằng điều này tốn hơn khoảng 20 % so với không dùng lớp. Hãy chuyển phần thay đổi vào message của người dùng, hoặc tắt việc đánh dấu:

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

Việc sắp xếp lại opt-in đó chính là đòn bẩy đứng sau một thử nghiệm thực tế mang tính thăm dò được công bố trong README: trên `claude-haiku-4-5`, trong một chuỗi được dựng sẵn mà timestamp đầu độc cache, nó đưa tỷ lệ trúng cache từ 0 % lên 95 % và giảm chi phí mỗi yêu cầu 82.76 %, so với chính lớp này khi không bật tùy chọn, 20 yêu cầu mỗi nhánh, đo bằng phiên bản 1.2.0 ngày 15 tháng 11 năm 2026. Đây là một thử nghiệm nhỏ và được dựng sẵn, không phải dự báo cho lưu lượng của bạn.

## Đối chiếu với số liệu của Anthropic

1. **Theo từng lệnh gọi.** Ghi lại `usage` của mọi phản hồi (hoặc `report.nativeSavings` nếu bạn dùng lớp này) và tính tỷ lệ trúng cache như trên. Một tải chat hay agent lành mạnh cho thấy read cao hơn hẳn write sau lệnh gọi đầu tiên.
2. **Theo ngày.** Trong Claude Console, trang usage tách đầu vào thành ghi cache và đọc cache theo mô hình và khóa API. Cộng `cache_read_input_tokens` và `cache_creation_input_tokens` bạn đã ghi lại cho cùng khóa và cùng ngày UTC: tổng phải khớp. Để kiểm tra bằng chương trình, [Usage and Cost Admin API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) trả về cùng các bộ đếm đó.
3. **Bằng tiền.** Tính giá đọc, ghi và đầu vào thường riêng biệt. Một báo cáo chỉ hiện "token tiết kiệm được" mà không có phụ phí ghi là đang giấu đi một nửa phép tính được mất.

[Benchmark công khai](/vi/benchmarks) của repository đo cả hai nhánh của mọi bài kiểm tra bằng chính bộ đếm usage của nhà cung cấp. Về phương pháp chung, xem [cách kiểm chứng khoản tiết kiệm LLM với hóa đơn của bạn](/vi/guides/verify-llm-savings-against-provider-bill). Về phía OpenAI của cùng vấn đề, xem [vì sao cached_tokens của OpenAI bằng 0](/vi/guides/openai-prompt-caching-cached-tokens). Mã nguồn có trên [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
