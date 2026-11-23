"Claude Code tốn bao nhiêu tiền?" có hai câu trả lời trung thực. Với gói thuê bao Claude, giá chính là giá gói của bạn, và chi phí theo token chỉ quan trọng khi bạn vượt quá giới hạn của gói. Với khóa API hoặc một nhà cung cấp cloud, bạn trả theo token, và chi phí của một phiên phụ thuộc vào số yêu cầu Claude Code gửi đi, kích thước của mỗi yêu cầu và bao nhiêu phần trong đó được đọc từ prompt cache. Hướng dẫn này cho thấy Anthropic công bố gì, những công cụ có sẵn nào cho bạn con số tổng, và cách xem chi phí của từng yêu cầu ngay trên máy của bạn, miễn phí, để tìm ra những lượt khiến một phiên trở nên đắt đỏ.

## Anthropic nói chi phí là bao nhiêu

[Trang chi phí của Claude Code](https://code.claude.com/docs/en/costs) do Anthropic công bố đưa ra mức trung bình từ các triển khai doanh nghiệp: khoảng 13 US$ mỗi lập trình viên mỗi ngày hoạt động và 150 US$ đến 250 US$ mỗi lập trình viên mỗi tháng, với 90% người dùng dưới 30 US$ mỗi ngày hoạt động. Đó là mức trung bình trên nhiều nhóm. Con số của bạn phụ thuộc vào mô hình bạn chọn, kích thước repository và cách bạn làm việc, đó là lý do phần còn lại của hướng dẫn này nói về cách đo nó.

## Các công cụ có sẵn, và những gì chúng không cho thấy

- **`/usage` trong Claude Code.** Khối Session hiển thị chi phí *ước tính* theo giá niêm yết, với token theo từng mô hình được chia thành đầu vào, đầu ra, đọc cache và ghi cache. Các phiên bản gần đây thêm một dòng prompt cache với tỷ lệ trúng và số lần trượt. Đây là tổng của cả phiên, tính ngay trên máy.
- **Claude Console.** Với khóa API, các trang Cost và Usage hiển thị số tiền đã bị tính, theo ngày, workspace và mô hình. Đây là con số dùng để đối soát.
- **Xuất OpenTelemetry.** Claude Code có thể đẩy số liệu token và chi phí sang hệ thống observability của riêng bạn, theo người dùng và phiên ([tài liệu monitoring](https://code.claude.com/docs/en/monitoring-usage)).

Điều mà không công cụ nào trong số này làm cho dễ dàng là **góc nhìn theo từng yêu cầu**: lượt nào là lượt đắt, và vì sao. Một phiên gồm hàng chục hoặc hàng trăm lệnh gọi API, và những lệnh gọi đắt đều có nguyên nhân dễ nhận ra:

- **Cache nguội.** Lượt đầu tiên sau một khoảng nghỉ dài hơn thời gian sống của cache sẽ đọc lại toàn bộ cuộc hội thoại với giá đầy đủ, rồi ghi lại nó một lần nữa.
- **Đổi mô hình.** Mỗi mô hình có cache riêng, nên đổi mô hình giữa phiên sẽ xử lý lại mọi thứ.
- **Kết quả công cụ khổng lồ.** Một log test hay một tệp lớn được đọc một lần sẽ nằm lại trong ngữ cảnh của mọi lượt sau đó.
- **Quá nhiều định nghĩa công cụ.** Các MCP server có thể thêm nhiều kilobyte định nghĩa vào mỗi yêu cầu.
- **Nén ngữ cảnh (compaction).** Bản thân việc tóm tắt một cuộc hội thoại dài đã là một yêu cầu lớn.

## Đo từng yêu cầu bằng một gateway cục bộ

Gateway là một proxy nhỏ nằm giữa Claude Code và API, đọc các bộ đếm usage của từng phản hồi. Claude Code hỗ trợ chính thức cách này qua `ANTHROPIC_BASE_URL`. [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) kèm sẵn một gateway trong gói npm của mình: Apache-2.0, **không cần khóa, không cần đăng ký**, và không có gì được gửi về BiVelio. Nó cần Node.js 20.19.0 trở lên.

Cách chỉ với một lệnh:

```bash
# Starts a local gateway on a free port, runs Claude Code through it, and stops it on exit.
npx @bivelio/savings-layer claude
```

Wrapper giữ cho log theo từng yêu cầu im lặng để không vẽ đè lên giao diện của Claude Code. Khi bạn thoát, nó in ra số yêu cầu đã được đo, chi phí của chúng theo giá niêm yết, số tiền tiết kiệm được hoặc lý do không tiết kiệm được gì, những yêu cầu nào được chuyển tiếp mà không đo, và lý do. Để xem từng yêu cầu ngay khi nó diễn ra, bạn có thể yêu cầu log ra stderr:

```bash
BVSALA_GATEWAY_LOG=1 npx @bivelio/savings-layer claude
```

hoặc chạy gateway trong một terminal riêng, trên một cổng cố định:

```bash
# Terminal 1: the gateway (Anthropic is the default upstream, port 8402)
npx @bivelio/savings-layer gateway

# Terminal 2: Claude Code, pointed at it (no /v1 at the end).
# ENABLE_TOOL_SEARCH=true only matters before Claude Code v2.1.304 (see below).
ENABLE_TOOL_SEARCH=true ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude
```

Mỗi yêu cầu thành một dòng. Hai dòng dưới đây lấy từ một thử nghiệm cục bộ với một server giả lập, lưu lượng bịa ra, nên định dạng là thật còn các con số không phải của bạn:

```text
[gateway] POST /v1/messages  · claude-sonnet-5 · $0.007700 (in 40, cache↑3000 cache↓0, out 12)
[gateway] POST /v1/messages  · claude-sonnet-5 · $0.000800 (in 40, cache↑0 cache↓3000, out 12)
```

Đọc từ trái sang phải: mô hình, chi phí theo giá niêm yết tiêu chuẩn của mô hình (các lượt chế độ nhanh là ngoại lệ, xem bên dưới), rồi token đầu vào bị tính đủ giá, token được ghi vào cache (`cache↑`), token được đọc từ cache (`cache↓`) và token đầu ra. Dòng đầu là một lượt nguội ghi tiền tố; dòng thứ hai đọc lại nó với một phần nhỏ giá. Một phiên mà `cache↑` cứ lớn từ lượt này sang lượt khác là đang có vấn đề về cache: xem [vì sao prompt caching của Claude ngừng hoạt động](/vi/guides/claude-prompt-caching-not-working).

`ENABLE_TOOL_SEARCH=true` tùy thuộc vào phiên bản Claude Code của bạn. Từ v2.1.304, tool search vẫn bật khi đứng sau gateway ([tài liệu MCP của Claude Code](https://code.claude.com/docs/en/mcp)), và biến này không thay đổi gì. Trước v2.1.304, Claude Code tắt tool search khi đứng sau bất kỳ base URL nào không phải của Anthropic và đưa mọi định nghĩa công cụ vào mọi yêu cầu. Trên các phiên bản cũ đó, việc này rất tốn kém: hướng dẫn Claude Code của gateway, đi kèm trong gói npm, ghi lại một cấu hình có 226 công cụ MCP, đo ngày 9 tháng 9 năm 2026, trong đó việc này đồng nghĩa với 450 KB mỗi yêu cầu và một phần tư hóa đơn của ngày hôm đó. Wrapper `claude` đặt biến này giúp bạn, trừ khi bạn đã tự đặt.

## Gateway thấy gì, và không thấy gì

- **Nó chuyển tiếp đúng những gì Claude Code gửi.** Khi không có đòn bẩy nào tác động lên một yêu cầu, body đến Anthropic nguyên vẹn từng byte, kể cả các đánh dấu `cache_control` và header `anthropic-beta`, nên caching hoạt động y như khi không có gateway. Một bài test trong repository kiểm tra điều này với một upstream giả ở mỗi lần thay đổi.
- **Hai lệnh gọi nhỏ đi vòng qua nó.** Theo [hướng dẫn tương thích gateway](https://code.claude.com/docs/en/llm-gateway-protocol) của Claude Code, bước kiểm tra khả dụng của chế độ nhanh (fast mode) và bước kiểm tra an toàn tên miền của WebFetch gọi thẳng `api.anthropic.com` thay vì đi theo `ANTHROPIC_BASE_URL`. Không cái nào là yêu cầu tới mô hình: bản thân việc suy luận ở chế độ nhanh vẫn đi theo base URL và qua gateway.
- **Các lượt chế độ nhanh được ghi theo giá tiêu chuẩn.** Anthropic đánh dấu yêu cầu chế độ nhanh bằng `speed: "fast"` và tính giá cao hơn: 8 US$ đầu vào và 40 US$ đầu ra mỗi triệu token trên Claude Opus 5.5, gấp đôi giá tiêu chuẩn, cộng thêm các hệ số nhân của cache ([tài liệu fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode)). Gateway phiên bản 1.2.5, cũng như 1.2.3, không đọc `speed`, nên nó đếm đúng các token đó nhưng tính giá như lượt tiêu chuẩn: trên Opus 5.5, chỉ bằng một nửa số Anthropic tính. Nếu bạn dùng `/fast`, tổng của gateway cho các lượt đó sẽ thấp hơn thực tế.
- **Lưu lượng từ gói thuê bao được đo, không bị tính tiền.** Khi đăng nhập Claude Pro hoặc Max, không có hóa đơn theo token; gateway quy lưu lượng đó ra giá trị tương đương giá niêm yết để bạn nhìn thấy, và không ghi nhận khoản tiết kiệm nào trên đó.

## Gateway có tiết kiệm tiền không?

Mặc định, với Claude Code dùng khóa API, nó chỉ đo và không tiết kiệm gì, và phiên bản 1.2.5 nói rõ điều đó. Thông báo khởi động của nó nói rằng điều chỉnh TTL của cache là đòn bẩy tiết kiệm duy nhất bật theo mặc định và chỉ tác động lên lưu lượng Anthropic dùng khóa API có yêu cầu cache một giờ, còn bản tóm tắt khi thoát đặt số tiền tiết kiệm được cạnh số tiền đã chi, kèm lý do khi khoản tiết kiệm bằng không. Phiên bản 1.2.3 nói mọi đòn bẩy tiết kiệm cục bộ đều đang bật, còn bản tóm tắt khi thoát chỉ đếm yêu cầu: nếu bạn vẫn dùng nó, đừng đọc cái nào như một lời hứa. Đòn bẩy mặc định của gateway hạ thời gian sống của lượt ghi cache từ một giờ xuống năm phút ở những lượt mà phần lớn yêu cầu là nội dung mới, vì ghi một giờ tốn gấp đôi giá đầu vào còn ghi năm phút tốn 1,25 lần. Claude Code dùng khóa API vốn đã yêu cầu năm phút, trừ khi bạn đặt `promptCacheTtl` thành `1h`, nên chẳng có gì để hạ.

Khi cache một giờ được dùng, khoản tiết kiệm nhỏ và phụ thuộc vào lưu lượng của bạn. [Trang benchmark](/vi/benchmarks#gateway-ttl) công bố một bản phát lại (replay) lưu lượng Claude Code của chính một tổ chức: ròng **+2,49%** hóa đơn theo giá niêm yết (113,45 US$ trên 4.563,61 US$), với khoảng tin cậy 95% từ +1,50% đến +3,57% khi lấy mẫu lại theo phiên, và mức trần 7,2% cho bất kỳ chính sách nào thuộc loại này. Trên một mô hình, kết quả gần như bằng không, và trong một giai đoạn nó còn lỗ. Đây là một bản phát lại với đường cơ sở được dựng lại một phần, không phải hóa đơn, và trang đó liệt kê mọi giới hạn.

## Đối chiếu số liệu của gateway với hóa đơn

1. **Với `/usage`.** Cho một phiên, cộng chi phí theo từng yêu cầu của gateway rồi so với khối Session của `/usage`. Cả hai đều tính giá cùng các bộ đếm theo giá niêm yết, nên kết quả phải gần nhau, ngoại trừ các lượt chế độ nhanh, mà `/usage` tính theo giá nhanh còn gateway 1.2.5 tính theo giá tiêu chuẩn.
2. **Với Console.** Dùng một khóa API hoặc workspace riêng trong một ngày, rồi so tổng theo mô hình của gateway với trang Usage của Console cho khóa đó: đầu vào, đầu ra, ghi cache và đọc cache, so bằng token trước, rồi mới bằng đô la.
3. **Giải thích mọi chênh lệch.** Giá niêm yết không phải lúc nào cũng là giá của bạn: chiết khấu theo hợp đồng, yêu cầu lưu trú dữ liệu (data residency) hay hạng ưu tiên (priority tier) làm thay đổi số tiền nhưng không thay đổi số token. Chế độ nhanh cũng vậy: khi bật `/fast`, tổng của gateway thấp hơn của Console, vì 1.2.5 tính các lượt chế độ nhanh theo giá tiêu chuẩn. Lưu lượng không đi qua gateway này, như một máy khác, một script hay một job CI dùng chung khóa, chỉ xuất hiện trên Console.

Nếu số token khớp mà số đô la không khớp, chênh lệch nằm ở giá, không phải ở phép đo. Để có phương pháp đầy đủ, hãy đọc [cách kiểm chứng khoản tiết kiệm LLM với hóa đơn của nhà cung cấp](/vi/guides/verify-llm-savings-against-provider-bill).

## Cắt giảm hóa đơn khi đã nhìn thấy nó

Khi đã có số liệu theo từng yêu cầu trước mắt, các cách khắc phục thường rất đơn giản: clear giữa các tác vụ không liên quan thay vì kéo theo một ngữ cảnh dài, chọn mô hình trước phiên và giữ nguyên, compact ở những điểm dừng tự nhiên, để các log lớn ra ngoài ngữ cảnh, và bớt các MCP server bạn không dùng. Việc dùng mô hình của nhà cung cấp khác phía sau Claude Code được trình bày trong [chi phí API của DeepSeek và Qwen](/vi/guides/deepseek-qwen-api-cost-local-gateway).

Mã nguồn của gateway, hướng dẫn Claude Code của nó và các bài test kiểm tra rằng nó chuyển tiếp yêu cầu của bạn không thay đổi đều có trên [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
