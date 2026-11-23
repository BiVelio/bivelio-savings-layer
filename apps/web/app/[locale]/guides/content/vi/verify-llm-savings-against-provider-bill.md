Công cụ chi phí LLM nào cũng hiển thị một con số tiết kiệm. Rất ít công cụ chỉ cách kiểm tra nó, mà chính ở bước kiểm tra, hầu hết các tuyên bố đều đổ vỡ: bảng điều khiển hiện một khoản tiết kiệm lớn còn hóa đơn gần như không nhúc nhích. Hướng dẫn này đưa ra một phương pháp bạn có thể áp dụng với bất kỳ công cụ nào, hoặc không cần công cụ: ghi lại những gì, đối soát với dữ liệu sử dụng của nhà cung cấp ra sao, phân biệt khoản tiết kiệm thật với ước tính thế nào, và làm sao chắc chắn khoản tiết kiệm đến từ thay đổi bạn đã làm. Cuối bài, bạn sẽ thấy SDK mã nguồn mở BV-SALA gắn nhãn cho từng khoản tiền như thế nào để việc kiểm tra này khả thi.

## Vì sao con số tiết kiệm và hóa đơn không khớp

Khoảng chênh gần như luôn đến từ một trong những nguyên nhân sau:

- **Giá niêm yết so với giá của bạn.** Các công cụ tính giá token theo giá niêm yết công khai. Hóa đơn của bạn có thể gồm chiết khấu, hợp đồng cam kết sử dụng, giá theo vùng hoặc theo yêu cầu lưu trú dữ liệu, hạng ưu tiên và thuế.
- **Ước tính được trình bày như phép đo.** Nếu một công cụ cắt 2.000 token khỏi prompt, nhà cung cấp không bao giờ đếm chúng. Con số "đã tiết kiệm" là số đếm của chính công cụ, tính bằng một tokenizer có thể không phải của nhà cung cấp.
- **Chiết khấu của nhà cung cấp bị nhận là của công cụ.** Prompt caching trên OpenAI, Anthropic, DeepSeek hay Gemini được nhà cung cấp tính giá thấp hơn. Một công cụ tính khoản chiết khấu đó là khoản tiết kiệm của mình sẽ thổi phồng con số.
- **Lưu lượng mà công cụ không bao giờ thấy.** Lệnh gọi từ một dịch vụ khác, script của đồng nghiệp, các yêu cầu phụ của agent lập trình hay một batch job đều xuất hiện trên hóa đơn mà không có trong công cụ.
- **Thiếu usage.** Một yêu cầu dạng stream thiếu sự kiện usage cuối cùng thì hoàn toàn không có số token. Âm thầm tính nó bằng không sẽ khiến mọi thứ sau đó trông rẻ hơn.
- **Thời gian.** Nhà cung cấp gom usage theo ngày UTC, và một phần usage xuất hiện trễ.

## Phương pháp, từng bước một

### 1. Ghi lại bộ đếm của chính nhà cung cấp cho mọi yêu cầu

Không phải ước tính của bạn: khối `usage` mà nhà cung cấp trả về. Đầu vào, đầu vào từ cache (và ghi cache nếu có), đầu ra, token suy luận, id mô hình mà nhà cung cấp báo, khóa API hoặc dự án, và timestamp UTC. Đánh dấu một yêu cầu không nhận được usage là **chưa đo**, không bao giờ là số không.

### 2. Đối soát token trước, đô la sau

Xuất usage theo ngày của nhà cung cấp cho cùng các khóa và ngày: [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) của OpenAI, [Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) của Anthropic, hoặc các trang usage trong console của DeepSeek và Model Studio. Sau đó so từng nhóm một:

```ts
interface Row { day: string; model: string; input: number; cachedInput: number; output: number }

function byDayAndModel(rows: Row[]): Map<string, Row> {
  const totals = new Map<string, Row>();
  for (const r of rows) {
    const k = `${r.day}|${r.model}`;
    const t = totals.get(k) ?? { day: r.day, model: r.model, input: 0, cachedInput: 0, output: 0 };
    t.input += r.input;
    t.cachedInput += r.cachedInput;
    t.output += r.output;
    totals.set(k, t);
  }
  return totals;
}

/** Lines where your log and the provider disagree by more than the tolerance. Empty means they agree. */
export function reconcile(mine: Row[], provider: Row[], tolerance = 0.01): string[] {
  const a = byDayAndModel(mine);
  const b = byDayAndModel(provider);
  const gaps: string[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    for (const field of ["input", "cachedInput", "output"] as const) {
      const yours = a.get(k)?.[field] ?? 0;
      const theirs = b.get(k)?.[field] ?? 0;
      const gap = theirs === 0 ? (yours === 0 ? 0 : 1) : Math.abs(yours - theirs) / theirs;
      if (gap > tolerance) gaps.push(`${k} ${field}: yours ${yours}, provider ${theirs}`);
    }
  }
  return gaps;
}
```

Nếu token khớp, việc ghi log của bạn đã đầy đủ và bạn có thể tin phần phân tích còn lại. Nếu nhà cung cấp cho thấy nhiều hơn, hãy tìm phần lưu lượng bạn chưa ghi trước khi đi tiếp.

### 3. Sau đó mới tính tiền, với một bảng giá có ghi ngày

Nhân từng nhóm với đơn giá, ghi lại ngày chép giá, rồi so với báo cáo chi phí của nhà cung cấp. Một chênh lệch ổn định vài phần trăm thường là do chiết khấu hoặc giá theo vùng, và nó như nhau dù có hay không có tối ưu của bạn, nên không làm thay đổi khoản tiết kiệm.

### 4. Tách riêng ba loại con số

- **Đo được (measured):** đọc từ bộ đếm của nhà cung cấp cho một lệnh gọi đã chạy.
- **Đo theo tham chiếu (reference):** một lệnh gọi đã không xảy ra (một lượt trúng cache, một yêu cầu đã được khử trùng lặp), được định giá bằng bộ đếm của nhà cung cấp cho lệnh gọi giống hệt đã chạy. Đây là bằng chứng tốt nhất có được cho một lệnh gọi không bao giờ xảy ra.
- **Ước tính (estimated):** mọi thứ nhà cung cấp không bao giờ đếm, như số token mà một công cụ đã cắt khỏi prompt.

Cộng từng loại riêng. Đừng bao giờ cộng khoản ước tính vào khoản đo được, và đừng bao giờ lấy trung bình phần trăm giữa các yêu cầu: hãy cộng tiền, rồi mới chia.

### 5. Tách chiết khấu của nhà cung cấp khỏi khoản tiết kiệm của bạn

Token đầu vào từ cache rẻ hơn là nhờ nhà cung cấp. Nếu bạn không thay đổi gì và tỷ lệ trúng cache vốn đã cao, khoản chiết khấu đó không phải là khoản tiết kiệm của dự án bạn. Hãy tính token từ cache theo giá cache ở cả hai vế của phép so sánh; phần còn lại mới là của bạn.

## Thay đổi có thực sự tạo ra khoản tiết kiệm?

Một hóa đơn giảm sau lần deploy cũng có thể chỉ là một tuần ít lưu lượng. Để quy khoản tiết kiệm cho đúng nguyên nhân:

- **Chạy hai nhánh cùng lúc.** Gửi cùng các yêu cầu có và không có thay đổi, cùng thời điểm, qua cùng một khóa, rồi so bộ đếm của nhà cung cấp cho cả hai. Chia yêu cầu ngẫu nhiên giữa hai nhánh là phiên bản sạch nhất.
- **Báo cáo một khoảng, không phải một điểm.** Lấy mẫu lại theo nguyên cuộc hội thoại hoặc nguyên ngày, và nói "từ X đến Y %". Một khoảng vắt qua số không nghĩa là bạn không thể phân biệt khác biệt đó với nhiễu, và đó là một kết quả hợp lệ.
- **Kiểm tra chất lượng trong cùng lượt chạy.** Một câu trả lời rẻ hơn mà sai không phải là tiết kiệm. Đo độ chính xác hoặc một phép kiểm tra riêng cho tác vụ ở cả hai nhánh.

## BV-SALA giúp việc kiểm tra này khả thi ra sao

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) là một lớp tiết kiệm theo giấy phép Apache-2.0, miễn phí và không cần khóa. Mọi yêu cầu đều trả về một `SavingsReport` được xây dựng đúng cho phương pháp này:

- `cost.basis` là `measured`, `reference`, `estimated` hoặc `unmeasured`, theo các định nghĩa ở trên. Một lần lặp lại chỉ được định giá theo tham chiếu khi lệnh gọi đã chạy đi thẳng tới API của OpenAI, Anthropic hoặc Gemini của Google; ở bất kỳ đâu khác, nó vẫn là `estimated`.
- Khoản tiết kiệm được giữ trong bốn sổ cái (ledger) riêng biệt không bao giờ cộng gộp thành một con số: `avoided_calls`, `eliminated_tokens`, `compressed_tokens` và `provider_cached_tokens`.
- Khoản chiết khấu cache của chính nhà cung cấp được báo cáo riêng, trong `report.nativeSavings`, và không bao giờ được tính là khoản tiết kiệm của lớp này.
- Một stream kết thúc mà thiếu usage là `unmeasured`, không bao giờ được tính giá bằng không.

Cộng các báo cáo theo basis chỉ cần vài dòng:

```ts
import type { SavingsReport } from "@bivelio/savings-layer";

/** Spend and saving per basis. Never mix bases, never average ratios. */
export function totalsByBasis(reports: SavingsReport[]) {
  const totals: Record<string, { requests: number; spendUsd: number; savedUsd: number }> = {};
  for (const r of reports) {
    const t = (totals[r.cost.basis] ??= { requests: 0, spendUsd: 0, savedUsd: 0 });
    t.requests += 1;
    t.spendUsd += r.cost.actual;
    t.savedUsd += r.cost.netSavingsUsd;
  }
  return totals;
}
```

Từ Python, client đi kèm gói đọc cùng các báo cáo đó từ gateway cục bộ và giữ nguyên sự tách biệt:

```python
# pip install bivelio-savings-layer
import bvsala

gw = bvsala.Gateway("http://127.0.0.1:8403")
# ... send requests with gw.wrap(client) and read each one with gw.report(response) ...
t = gw.totals()
print(t.requests, t.metered, t.not_metered, t.actual_cost_usd)
print(t.net_savings_usd_by_basis)  # one amount per basis, never added together
```

Sau đó chạy bước 2 ở trên với các tổng này: chi tiêu `measured` của lớp phải khớp với usage của nhà cung cấp cho cùng khóa và ngày, khớp chính xác về token, và về đô la thì chỉ chênh trong phạm vi các khoản chiết khấu của bạn. Các báo cáo tính theo giá niêm yết; chúng không phải hóa đơn.

## Cùng phương pháp đó, áp dụng công khai

Dự án công bố các lượt chạy A/B của chính mình trên [trang benchmark](/vi/benchmarks): hai nhánh trên cùng các yêu cầu, một đi thẳng tới nhà cung cấp và một đi qua lớp, cả hai được đo bằng chính bộ đếm usage của nhà cung cấp, với khoảng tin cậy 95% cùng ngày và phiên bản của mỗi lượt chạy. Những kết quả không tiết kiệm được gì, hoặc còn tốn hơn, nằm ngay trên cùng trang. Phương pháp đầy đủ, bộ ước lượng và các giới hạn của nó có trong [bài báo](/vi/paper).

Về chi tiết theo từng nhà cung cấp, xem [vì sao cached_tokens của OpenAI bằng 0](/vi/guides/openai-prompt-caching-cached-tokens), [vì sao prompt caching của Claude không hoạt động](/vi/guides/claude-prompt-caching-not-working) và [đo chi phí Claude Code theo từng yêu cầu](/vi/guides/claude-code-cost-per-request). Mã nguồn và các báo cáo thô có trên [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
