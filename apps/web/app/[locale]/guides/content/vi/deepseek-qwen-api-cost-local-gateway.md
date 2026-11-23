DeepSeek và Qwen rẻ tính theo token, nên rất dễ thôi để mắt đến hóa đơn. Cả hai nhà cung cấp đều cache prompt ở phía họ, và đầu vào trúng cache được tính giá thấp hơn nhiều so với đầu vào trượt cache. Vì vậy chi phí thực của lưu lượng phụ thuộc vào một con số mà hầu hết các bảng điều khiển đều giấu đi: bao nhiêu token đầu vào trúng cache ở mỗi yêu cầu. Hướng dẫn này giải thích cách hai nhà cung cấp tính phí và cache, cách tính giá một yêu cầu từ các trường usage của nó, và cách xem chi phí theo từng yêu cầu bằng một gateway cục bộ miễn phí.

## DeepSeek tính phí một yêu cầu thế nào

DeepSeek chia đầu vào của mỗi yêu cầu làm hai: token trúng context cache và token trượt, mỗi loại một giá, cộng với token đầu ra. [Context caching](https://api-docs.deepseek.com/guides/kv_cache) của DeepSeek được bật mặc định cho mọi tài khoản. Muốn trúng cache, phần đầu yêu cầu phải khớp chính xác với một yêu cầu trước đó; cache chỉ là best effort, và các mục không được dùng sẽ bị xóa sau vài giờ hoặc vài ngày. Phản hồi cho bạn biết điều gì đã xảy ra:

- `usage.prompt_cache_hit_tokens`: token đầu vào được lấy từ cache.
- `usage.prompt_cache_miss_tokens`: token đầu vào được xử lý đầy đủ.
- `usage.prompt_tokens_details.cached_tokens`: cùng số token trúng cache, trong trường mà các công cụ tương thích OpenAI đọc.

[Trang giá](https://api-docs.deepseek.com/quick_start/pricing) của DeepSeek liệt kê giá trúng cache, trượt cache và đầu ra cho từng mô hình, cùng một khung giờ thấp điểm với giá thấp hơn. Giá có thể thay đổi; hãy chép lại kèm ngày bạn đọc.

## Qwen tính phí một yêu cầu thế nào

Các mô hình Qwen trên Alibaba Cloud Model Studio có hai loại [context cache](https://www.alibabacloud.com/help/en/model-studio/context-cache). Cache ngầm (implicit) tự động áp dụng cho các prompt vượt độ dài tối thiểu, và các lượt trúng được tính giá chiết khấu. Cache tường minh (explicit) hoạt động giống của Anthropic: bạn đánh dấu một block bằng `cache_control`, mục cache sống vài phút, và việc ghi tốn hơn đầu vào thường một chút trong khi việc đọc rẻ hơn nhiều. Trong API tương thích OpenAI, số token trúng cache nằm trong `usage.prompt_tokens_details.cached_tokens`. Model Studio có các endpoint theo vùng, nên hãy kiểm tra khóa của bạn thuộc vùng nào.

## Làm cho cache trúng, trên nhà cung cấp nào cũng vậy

Quy tắc giống như với mọi cache tiền tố:

1. Đặt những gì không bao giờ thay đổi lên đầu: system prompt, định nghĩa công cụ, văn bản tham chiếu dài, các ví dụ few-shot.
2. Giữ phần đó giống hệt từng byte giữa các yêu cầu: không có timestamp, request id hay tên người dùng bên trong, và định nghĩa công cụ theo thứ tự cố định.
3. Đặt những gì thay đổi xuống cuối: câu hỏi của người dùng, kết quả công cụ mới nhất.
4. Với agent, hãy nối thêm vào lịch sử thay vì viết lại nó. Sửa một message cũ ở giữa sẽ làm mất hiệu lực mọi thứ phía sau.

## Tính chi phí của một yêu cầu

Bạn không cần công cụ nào để tính giá một yêu cầu. Đọc khối usage và nhân từng nhóm với giá của nó:

```python
def request_cost(usage: dict, price_miss: float, price_hit: float, price_out: float) -> float:
    """USD cost of one chat completion. Prices are per million tokens, from the provider's pricing page."""
    details = usage.get("prompt_tokens_details") or {}
    hit = usage.get("prompt_cache_hit_tokens", details.get("cached_tokens", 0)) or 0
    miss = usage["prompt_tokens"] - hit
    return (miss * price_miss + hit * price_hit + usage["completion_tokens"] * price_out) / 1_000_000
```

Ghi con số đó cùng với mô hình, tỷ lệ trúng (`hit / prompt_tokens`) và timestamp cho mỗi yêu cầu, là bạn trả lời được những câu hỏi quan trọng: tính năng nào tốn nhất, tỷ lệ trúng cache có giảm sau một lần deploy không, và bao nhiêu lưu lượng rơi vào khung giờ thấp điểm.

## Xem từng yêu cầu bằng một gateway cục bộ

Để khỏi phải sửa từng chỗ gọi API, hãy đặt một gateway trước nhà cung cấp. [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) kèm sẵn một gateway trong gói npm của mình: Apache-2.0, cục bộ, **không cần khóa và không cần đăng ký**, và không có gì được gửi về BiVelio. Chạy một gateway cho mỗi nhà cung cấp, mỗi cái trên một cổng riêng:

```bash
# DeepSeek
npx @bivelio/savings-layer gateway --upstream deepseek --port 8403

# Qwen on Model Studio's international endpoint (`--upstream qwen` is the Beijing one)
npx @bivelio/savings-layer gateway --upstream https://dashscope-intl.aliyuncs.com --port 8404
```

Gateway chuyển tiếp nguyên đường dẫn mà client của bạn gửi tới nhà cung cấp, nên base URL của bạn chính là base URL của nhà cung cấp, với gateway làm host:

| Nhà cung cấp | `--upstream` | Base URL cho client OpenAI của bạn |
| --- | --- | --- |
| DeepSeek | `deepseek` | `http://127.0.0.1:8403` |
| Qwen (Bắc Kinh) | `qwen` | `http://127.0.0.1:<port>/compatible-mode/v1` |
| Qwen (quốc tế) | `https://dashscope-intl.aliyuncs.com` | `http://127.0.0.1:8404/compatible-mode/v1` |
| GLM | `glm` | `http://127.0.0.1:<port>/api/paas/v4` |

`npx @bivelio/savings-layer --help` liệt kê các upstream khác (Moonshot, MiniMax, OpenRouter, Gemini, Ollama, vLLM, LM Studio).

Trong Python, client nhỏ đi kèm gói lo phần base URL giúp bạn: tạo client OpenAI như thường lệ cho nhà cung cấp, và `wrap()` trả về một bản sao đi qua gateway, vẫn giữ nguyên đường dẫn của nhà cung cấp.

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

Với Qwen cũng làm tương tự, dùng gateway còn lại và `OpenAI(base_url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1", ...)`. Nếu bạn định tuyến lưu lượng qua một HTTP proxy, hãy đặt `NO_PROXY=127.0.0.1,localhost` để các yêu cầu tới gateway cục bộ không đi qua proxy đó. Nếu không có gateway nào đang chạy, `wrap()` ném ra `GatewayUnavailable` thay vì gọi thẳng nhà cung cấp. Ở phiên bản 1.2.3, thông báo lỗi đó còn nói rằng gateway cần một khóa dịch vụ: điều đó không đúng, gateway khởi động mà không cần khóa nào.

Ngôn ngữ hay công cụ nào khác cũng dùng được: trỏ base URL OpenAI của nó tới gateway, và mỗi yêu cầu sẽ thành một dòng trong log của gateway, với mô hình, chi phí theo giá niêm yết và đầu vào được tách thành token tính đủ giá và token đọc từ cache (`cache↓`).

Có một ngoại lệ quan trọng với các công cụ chat và agent: một yêu cầu **dạng stream** không yêu cầu usage (`stream_options: {"include_usage": true}`) sẽ không nhận được usage nào từ nhà cung cấp, nên phiên bản 1.2.3 ghi nó là `not metered: the request did not ask for usage`. Hãy yêu cầu usage trong client của bạn, hoặc khởi động gateway với `BVSALA_GATEWAY_USAGE_INJECT=1`, biến này thêm tùy chọn đó vào các stream còn thiếu. Khi đó chunk cuối cùng của các stream này có danh sách `choices` rỗng, điều mà code đọc `choices[0]` không kiểm tra sẽ không lường trước.

## Agent lập trình trên DeepSeek hoặc Qwen

DeepSeek cũng công bố một endpoint theo định dạng Anthropic, và có tài liệu hướng dẫn dùng nó với Claude Code. Với `--upstream deepseek`, gateway tự gửi các yêu cầu định dạng Anthropic tới endpoint đó:

```bash
npx @bivelio/savings-layer gateway --upstream deepseek --port 8402
ANTHROPIC_BASE_URL=http://127.0.0.1:8402 ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY" ANTHROPIC_MODEL=deepseek-flash claude
```

Chạy một mô hình không phải Claude phía sau Claude Code là tích hợp của DeepSeek, không phải một cấu hình được Anthropic hỗ trợ, và chất lượng của mô hình cho công việc của bạn là do bạn tự đánh giá.

**Qwen Code với các mô hình Qwen** cần một lộ trình khác. Wrapper `qwen` của gói không bao quát trường hợp này: ở phiên bản 1.2.3, `npx @bivelio/savings-layer qwen` chạy Qwen Code với kiểu xác thực Anthropic và chuyển tiếp tới API của Anthropic, nên nó chỉ đo các mô hình Claude dùng với khóa Anthropic, và từ chối một base URL DashScope định dạng Anthropic. Với các mô hình Qwen, hãy dùng chế độ tương thích OpenAI của Qwen Code, mà [tài liệu của nó](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/) cấu hình bằng `OPENAI_API_KEY`, `OPENAI_BASE_URL` và `OPENAI_MODEL`, rồi trỏ base URL đó tới một gateway. Đặt `DASHSCOPE_PROXY_BASE_URL` đúng bằng chính URL đó:

```bash
npx @bivelio/savings-layer gateway --upstream https://dashscope-intl.aliyuncs.com --port 8404

GW=http://127.0.0.1:8404/compatible-mode/v1
OPENAI_BASE_URL="$GW" DASHSCOPE_PROXY_BASE_URL="$GW" OPENAI_API_KEY="$DASHSCOPE_API_KEY" OPENAI_MODEL=qwen-plus qwen
```

Biến thứ hai quan trọng với hóa đơn. Qwen Code dựa vào host của base URL để quyết định có phải nó đang nói chuyện với DashScope hay không, và `127.0.0.1` không phải là host của DashScope. Không có biến này, nó quay về provider OpenAI chung, vốn không gửi các đánh dấu cache tường minh (`cache_control` và header `X-DashScope-CacheControl`). Khi đó các yêu cầu của bạn rơi về cache ngầm của Model Studio, nơi lượt trúng thường tốn 20 % giá đầu vào và chỉ là best effort, thay vì 10 % của cache tường minh ([context cache](https://www.alibabacloud.com/help/en/model-studio/context-cache)). Qwen Code coi một base URL khớp chính xác với `DASHSCOPE_PROXY_BASE_URL` là DashScope, và giữ lại các đánh dấu ([provider DashScope của nó](https://github.com/QwenLM/qwen-code/blob/8fab857da5/packages/core/src/core/openaiContentGenerator/provider/dashscope.ts), đọc ngày 23 tháng 11 năm 2026). Gateway chuyển tiếp cả hai không thay đổi: chúng tôi đã kiểm tra điều đó với phiên bản 1.2.3.

Chúng tôi đã kiểm tra phía gateway của lộ trình này với phiên bản 1.2.3, không phải bản thân Qwen Code, nên hãy đọc log của gateway: mỗi yêu cầu một dòng kèm chi phí. Một dòng `not metered` sẽ nói lý do: thường là một stream không yêu cầu usage (khởi động lại gateway với `BVSALA_GATEWAY_USAGE_INJECT=1`), hoặc một mô hình không có dòng nào trong danh mục giá của 1.2.3, vốn có `qwen-plus`, `qwen-flash`, `qwen3.7-flash`, `qwen3.8-flash` và `qwen3.8-max` nhưng không có, chẳng hạn, `qwen3-coder-plus`.

Hai điểm lệch về giá trong 1.2.3 phụ thuộc vào biến thứ hai. **Khi đặt `DASHSCOPE_PROXY_BASE_URL`**, như ở trên, Model Studio tính mỗi lượt ghi cache tường minh bằng 125 % giá đầu vào và báo cáo nó trong `usage.prompt_tokens_details.cache_creation_input_tokens`. Gateway 1.2.3 không đọc trường đó: nó ghi các token này như đầu vào thường, với `cache↑0`, ở mức 80 % chi phí thực của chúng. Giá trúng cache của nó cho `qwen-plus` là mức 10 % của cache tường minh, và mức này khớp. **Khi không có biến này** thì không có lượt ghi tường minh nào, nhưng các lượt trúng là trúng ngầm, tính khoảng 20 %, và gateway ghi chúng ở cùng mức 10 %, khoảng một nửa chi phí thực.

## Gateway đo gì, và không đo gì

- **Con số đô la lấy từ danh mục giá, không phải từ giá theo khung giờ của DeepSeek.** Phiên bản 1.2.3 có dòng cho `deepseek-flash` và `deepseek-v4-pro`. Với token trượt cache và đầu ra, cả hai dòng dùng giá giờ cao điểm của DeepSeek, nên vào giờ thấp điểm các nhóm đó hiển thị gấp đôi số DeepSeek tính. Với token trúng cache, cả hai dòng dùng $0.003 mỗi triệu token, đây là giá trúng cache giờ thấp điểm của DeepSeek cho `deepseek-flash` (giá trúng cache giờ cao điểm gấp đôi mức đó) và thấp hơn cả hai mức giá trúng cache DeepSeek công bố cho `deepseek-v4-pro` ([trang giá](https://api-docs.deepseek.com/quick_start/pricing), đọc ngày 23 tháng 11 năm 2026). Tùy theo giờ và lượng đầu vào trúng cache, tổng của gateway có thể cao hơn hoặc thấp hơn hóa đơn. Số token thì chính xác; hãy so chúng trước. Alias kinh điển `deepseek-chat` không có dòng nào: yêu cầu vẫn được chuyển tiếp, và log ghi rằng nó không được đo.
- **Nó không thay đổi các yêu cầu này.** Với lưu lượng tương thích OpenAI, gateway đo và chuyển tiếp (ngoại lệ duy nhất là việc chèn usage opt-in ở trên); các đòn bẩy tiết kiệm của nó dành cho lưu lượng định dạng Anthropic. Khoản tiết kiệm trên DeepSeek và Qwen đến từ cache của chính họ, đó là lý do số token trúng cache là con số cần theo dõi.

## Nếu bạn gọi DeepSeek hoặc Qwen từ TypeScript

SDK BV-SALA làm việc với mọi endpoint tương thích OpenAI và bỏ qua các lần lặp lại y hệt cũng như các yêu cầu giống hệt đang chạy, miễn phí và không cần khóa ([cách hoạt động](/vi/guides/deduplicate-llm-requests)). Trên DeepSeek, các lệnh gọi được tránh đó được báo cáo là `estimated`, không phải `reference`: phiên bản 1.2.3 chỉ định giá một lần lặp lại theo tham chiếu khi lệnh gọi đã chạy đi tới API riêng của OpenAI, Anthropic hoặc Google. Một lưu ý cho vòng lặp agent: việc mặc định cắt bớt các kết quả công cụ đã bị thay thế sẽ viết lại phần giữa của lịch sử, và trên một nhà cung cấp tự cache toàn bộ prompt, điều đó có thể tốn nhiều hơn số tiết kiệm được. Changelog của dự án ghi nhận +166 % trên một vòng lặp agent 60 bước với DeepSeek, đo bằng một nhà cung cấp giả với các phiên bản 1.2.3 và 1.2.4 và không có khóa. Với vòng lặp agent, hãy tắt nó cho từng yêu cầu:

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

## Đối chiếu số liệu với nhà cung cấp

Mỗi ngày một lần, hãy so tổng theo mô hình của gateway (đầu vào, token trúng cache, đầu ra) với trang usage của nền tảng DeepSeek hoặc Model Studio cho cùng một khóa. Tổng số token phải khớp, với một ngoại lệ ở cách chia: trên Qwen, phiên bản 1.2.3 đếm các lượt ghi cache tường minh là đầu vào thường, không phải lượt ghi cache. Số đô la có thể lệch, theo cả hai chiều, vì những lý do đã biết. Giá trong danh mục không phải giá theo khung giờ của DeepSeek. Trên Qwen, 1.2.3 tính lượt ghi cache tường minh theo giá đầu vào thường, thấp hơn số Model Studio tính, và tính lượt trúng ngầm theo giá tường minh (cả hai đã nói ở trên). Giá theo vùng và chiết khấu cũng làm thay đổi số tiền. Để có phương pháp từng bước, xem [cách kiểm chứng khoản tiết kiệm LLM với hóa đơn của nhà cung cấp](/vi/guides/verify-llm-savings-against-provider-bill). Mã nguồn của gateway và các hướng dẫn cho từng terminal có trên [GitHub](https://github.com/BiVelio/bivelio-savings-layer), còn những gì dự án đã đo, và chưa đo, có trên [trang benchmark](/vi/benchmarks).
