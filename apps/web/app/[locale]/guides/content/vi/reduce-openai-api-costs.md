Hóa đơn OpenAI là tổng của vài con số trên mỗi yêu cầu: token đầu vào không qua cache, token đầu vào lấy từ cache, lượt ghi cache (từ GPT-5.6 trở đi), token đầu ra (kể cả token suy luận) và giá của mô hình. Mọi cách giảm hóa đơn đều tác động vào một trong các con số đó. Hướng dẫn này đi qua từng đòn bẩy theo thứ tự thường mang lại hiệu quả nhất, nói rõ khi nào mỗi đòn bẩy không hiệu quả, và chỉ cách chứng minh từng khoản tiết kiệm bằng chính dữ liệu sử dụng của OpenAI thay vì một con số dự phóng. Phần lớn không cần công cụ nào; ở những chỗ SDK mã nguồn mở BV-SALA tự động hóa được một đòn bẩy, bạn sẽ thấy nó làm thế nào.

## Bắt đầu bằng việc đo theo từng yêu cầu

Trước khi thay đổi bất cứ điều gì, hãy ghi lại khối `usage` của mọi phản hồi cùng với tính năng hoặc template prompt đã tạo ra nó: `prompt_tokens`, `prompt_tokens_details.cached_tokens`, `cache_write_tokens` nếu mô hình có báo cáo, `completion_tokens` và, với các mô hình suy luận, `completion_tokens_details.reasoning_tokens`. Tính giá từng nhóm theo biểu giá trên trang giá của OpenAI và ghi lại ngày bạn chép giá. Từ GPT-5.6 trở đi, ghi cache là một nhóm riêng: OpenAI tính phí 1,25 lần giá đầu vào không qua cache với thời gian sống mặc định 30 phút, và 2,5 lần với thời gian sống 12 giờ ([hướng dẫn prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), đọc ngày 23 tháng 11 năm 2026). Nếu tính chúng như đầu vào thường, bạn sẽ tính thiếu. Chỉ cần một tuần dữ liệu như vậy là trả lời được câu hỏi duy nhất quan trọng lúc đầu: **hai hay ba tính năng nào chiếm phần lớn hóa đơn.** Hãy tối ưu những tính năng đó; bỏ qua phần còn lại.

## 1. Đừng trả tiền hai lần cho cùng một yêu cầu

Các lần retry, cú bấm đúp, job chạy đêm phân loại lại các mục của hôm qua và các worker song song gửi cùng một prompt đều tốn trọn một lệnh gọi mỗi lần. Một cache phản hồi khớp chính xác và cơ chế khử trùng lặp các yêu cầu đang chạy loại bỏ chúng mà không thay đổi bất kỳ câu trả lời nào. Bạn tiết kiệm được bao nhiêu hoàn toàn phụ thuộc vào tần suất các yêu cầu lặp lại, nên hãy đo tỷ lệ trùng lặp trước. Hướng dẫn đầy đủ: [loại bỏ các yêu cầu LLM trùng lặp](/vi/guides/deduplicate-llm-requests).

## 2. Để prompt cache của OpenAI làm việc

Các prompt từ khoảng 1.024 token trở lên được cache tự động, và token đầu vào lấy từ cache được tính giá chiết khấu. Từ GPT-5.6 trở đi, việc nạp cache không miễn phí: phần được ghi vào cache bị tính giá cao hơn mức không qua cache, như đã nói ở trên, nên một prompt được ghi rồi không bao giờ được đọc lại sẽ tốn hơn so với không dùng cache, còn một prompt sớm được đọc lại thì rẻ hơn nhiều. Các mô hình cũ hơn không tính thêm phí ghi. Cache chỉ khớp từ token đầu tiên, nên nó chỉ hoạt động khi phần đầu prompt của bạn giống hệt nhau giữa các yêu cầu. Hãy đặt chỉ dẫn, định nghĩa công cụ và ví dụ lên trước; ngày tháng, tên người dùng và câu hỏi để sau cùng. Nếu `cached_tokens` cứ đứng ở 0, xem [vì sao cached_tokens của OpenAI bằng 0](/vi/guides/openai-prompt-caching-cached-tokens).

## 3. Gửi việc có thể chờ sang Batch API

Chạy eval, backfill, tạo embedding cho một bộ tài liệu và phân loại chạy đêm không cần câu trả lời trong hai giây. [Batch API](https://developers.openai.com/api/docs/guides/batch) của OpenAI nhận một tệp chứa các yêu cầu, trả kết quả trong vòng một ngày và tính giá thấp hơn so với gửi từng yêu cầu một (xem [hướng dẫn tối ưu chi phí](https://developers.openai.com/api/docs/guides/cost-optimization) để biết điều khoản hiện hành). Với công việc offline, đây thường là khoản tiết kiệm đơn lẻ lớn nhất, và nó không thay đổi gì ở câu trả lời.

## 4. Dùng mô hình nhỏ nhất vượt qua bộ đánh giá của bạn

Chênh lệch giá giữa các hạng mô hình rất lớn, và nhiều tác vụ (phân loại, trích xuất, viết lại ngắn, định tuyến) không cần đến mô hình lớn nhất. Hãy dựng một bộ đánh giá nhỏ từ các yêu cầu thật, chạy nó trên hai hoặc ba mô hình và chọn mô hình rẻ nhất vượt qua. Chạy lại mỗi khi có mô hình mới. Không có bộ đánh giá, việc hạ mô hình chỉ là phỏng đoán, và cái giá của những câu trả lời sai không hiện lên hóa đơn API.

## 5. Kiểm soát đầu ra

Token đầu ra thường đắt gấp nhiều lần token đầu vào, và token suy luận được tính như đầu ra.

- Đặt `max_completion_tokens` đúng mức tính năng thực sự cần.
- Với mô hình suy luận, hạ mức reasoning effort cho những tác vụ không cần suy luận sâu, và đo `reasoning_tokens` trước và sau.
- Yêu cầu structured output với JSON schema khi mã của bạn phân tích câu trả lời. Một lần parse thất bại kéo theo retry nghĩa là trả tiền cho cả yêu cầu hai lần.

## 6. Gửi ít đầu vào hơn

- Đừng gửi lại toàn bộ cuộc hội thoại khi tác vụ chỉ cần vài lượt cuối.
- Loại các đầu ra công cụ lớn (log, nội dung tệp, kết quả tìm kiếm) khỏi các lượt sau khi chúng đã được dùng.
- Gửi dữ liệu có cấu trúc ở dạng gọn: JSON được pretty-print tốn token cho khoảng trắng.
- Truy xuất ba đoạn liên quan thay vì dán cả tài liệu.

Hãy cẩn thận với hai mục cuối trong các vòng lặp agent dài: sửa phần giữa của một lịch sử mà OpenAI đã cache khiến mọi thứ sau chỗ sửa bị tính phí lại, theo giá không qua cache hoặc, từ GPT-5.6 trở đi, theo giá ghi cache cao hơn khi được cache lại. Hãy rút gọn phần mới, không phải phần đã cache.

## BV-SALA tự động hóa một phần trong số đó như thế nào

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) là một lớp tiết kiệm theo giấy phép Apache-2.0, bọc bất kỳ endpoint nào tương thích OpenAI trong TypeScript. Nó tiết kiệm với mọi đòn bẩy **miễn phí, không cần khóa và không cần đăng ký**, và không gửi gì về BiVelio trừ khi bạn thêm khóa cho bảng điều khiển cloud tùy chọn. Bật theo mặc định: cache khớp chính xác, khử trùng lặp các yêu cầu giống hệt đang chạy, trả lời các phép tính số học thuần ngay trên máy, và tuần tự hóa gọn dữ liệu có cấu trúc mà bạn truyền vào. Tùy chọn bật (opt-in), mỗi thứ một tùy chọn: chuỗi mô hình (cascade), nén đầu ra công cụ và sắp xếp lại để tiền tố cache được. Mỗi yêu cầu trả về một báo cáo cho biết đã tiết kiệm được gì và con số đến từ đâu.

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

Nói thẳng, có hai giới hạn. Thứ nhất, lưu lượng không bao giờ lặp lại tiết kiệm được khoảng 0% từ cache và khử trùng lặp, và đó là do thiết kế. Thứ hai, việc mặc định cắt bớt các kết quả công cụ đã bị thay thế có thể tốn nhiều hơn số tiết kiệm được trong các vòng lặp agent dài trên nhà cung cấp cache toàn bộ prompt: changelog của dự án ghi nhận +12,2% trên một vòng lặp 60 bước với `gpt-5`, đo bằng một nhà cung cấp giả với các phiên bản 1.2.3 và 1.2.4 và không có khóa; 1.2.5 cắt bớt theo đúng cách đó. Với vòng lặp agent dài, hãy truyền `savings: { elision: false }` trong yêu cầu và so sánh.

## Chứng minh từng khoản tiết kiệm bằng số liệu của OpenAI

Một khoản tiết kiệm bạn không kiểm tra được chỉ là dự phóng. Với mỗi đòn bẩy:

1. **Chọn bộ đếm mà nó phải làm thay đổi.** Caching và khử trùng lặp làm thay đổi số yêu cầu. Prompt caching làm thay đổi `cached_tokens`, và từ GPT-5.6 trở đi cả `cache_write_tokens`. Batch làm thay đổi giá. Chọn mô hình làm thay đổi giá mỗi token. Kiểm soát đầu ra làm thay đổi `completion_tokens`.
2. **Đọc bộ đếm đó từ OpenAI.** [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) trả về số yêu cầu, token đầu vào, đầu vào từ cache và token đầu ra theo ngày, mô hình, dự án và khóa. Endpoint Costs và bảng điều khiển usage cho bạn biết số tiền.
3. **So sánh tương đương.** Cùng tính năng, cùng các ngày trong tuần, trước và sau, hoặc tốt hơn nữa là hai nhánh của cùng một lưu lượng chạy cùng lúc. Xem token trước, đô la sau: đô la còn biến động theo giá.

Với lớp này, mọi báo cáo đều mang `cost.basis`: các khoản `measured` và `reference` đến từ chính bộ đếm của OpenAI, còn các khoản `estimated` được báo cáo riêng và không bao giờ bị trộn vào. Phương pháp đầy đủ: [kiểm chứng khoản tiết kiệm LLM với hóa đơn của nhà cung cấp](/vi/guides/verify-llm-savings-against-provider-bill).

## Các con số đã công bố nói gì

[Trang benchmark](/vi/benchmarks) của dự án đo cả hai nhánh của mỗi bài kiểm tra bằng chính bộ đếm usage của nhà cung cấp. Trên một tải công khai xây từ các câu hỏi GSM8K, trong đó 30% yêu cầu là lặp lại y hệt, mức giảm gộp trên `gpt-4o-mini` là **31,50%**, với khoảng tin cậy 95% từ 25,7% đến 36,7% (artifact của SDK 0.4.31, tháng 9 năm 2026; cũng có trong README). Trên hội thoại hai lượt không lặp lại (MT-Bench), các chênh lệch không phân biệt được với số không hoặc không thể quy cho lớp này, và trang benchmark nói rõ điều đó. Phương pháp, các khoảng tin cậy và mọi giới hạn có trong [bài báo](/vi/paper). Mã nguồn có trên [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
