DeepSeek dan Qwen murah per token, sehingga mudah untuk berhenti memperhatikan tagihannya. Kedua penyedia meng-cache prompt di sisi mereka, dan masukan yang kena cache ditagih jauh di bawah masukan yang miss. Jadi biaya sebenarnya dari lalu lintas Anda bergantung pada angka yang disembunyikan sebagian besar dasbor: berapa banyak token masukan yang kena cache di setiap permintaan. Panduan ini menjelaskan cara kedua penyedia menagih dan meng-cache, cara menghitung biaya sebuah permintaan dari field usage-nya, dan cara melihatnya per permintaan dengan gateway lokal gratis.

## Cara DeepSeek menagih sebuah permintaan

DeepSeek membagi masukan setiap permintaan menjadi dua: token yang kena context cache-nya dan token yang miss, masing-masing dengan harganya sendiri, ditambah token keluaran. [Context caching](https://api-docs.deepseek.com/guides/kv_cache) DeepSeek aktif secara bawaan untuk setiap akun. Sebuah hit membutuhkan awal permintaan yang persis cocok dengan permintaan sebelumnya, cache-nya bersifat best effort, dan entri yang tidak dipakai dihapus setelah beberapa jam atau hari. Respons memberi tahu apa yang terjadi:

- `usage.prompt_cache_hit_tokens`: token masukan yang dilayani dari cache.
- `usage.prompt_cache_miss_tokens`: token masukan yang diproses penuh.
- `usage.prompt_tokens_details.cached_tokens`: jumlah hit yang sama, di field yang dibaca alat-alat yang kompatibel dengan OpenAI.

[Halaman harga](https://api-docs.deepseek.com/quick_start/pricing) DeepSeek mencantumkan harga hit, miss, dan keluaran untuk setiap model, serta jendela off-peak (di luar jam sibuk) dengan harga lebih rendah. Harga bisa berubah; salin beserta tanggal Anda membacanya.

## Cara Qwen menagih sebuah permintaan

Model Qwen di Alibaba Cloud Model Studio punya dua jenis [context cache](https://www.alibabacloud.com/help/en/model-studio/context-cache). Cache implisit berjalan otomatis untuk prompt di atas panjang minimum, dan hit-nya ditagih dengan diskon. Cache eksplisit bekerja seperti milik Anthropic: Anda menandai sebuah blok dengan `cache_control`, entrinya hidup beberapa menit, dan menulisnya sedikit lebih mahal daripada masukan biasa sementara membacanya jauh lebih murah. Di API yang kompatibel dengan OpenAI, jumlah hit muncul di `usage.prompt_tokens_details.cached_tokens`. Model Studio punya endpoint regional, jadi periksa di region mana kunci Anda terdaftar.

## Buat cache kena hit, di penyedia mana pun

Aturannya sama dengan cache prefiks mana pun:

1. Taruh yang tidak pernah berubah di depan: system prompt, definisi alat, teks referensi panjang, contoh few-shot.
2. Jaga agar bagian itu identik byte demi byte antarpermintaan: tanpa timestamp, id permintaan, atau nama pengguna di dalamnya, dan definisi alat dalam urutan tetap.
3. Taruh yang berubah di akhir: pertanyaan pengguna, hasil alat terbaru.
4. Untuk agen, tambahkan ke riwayat alih-alih menulis ulang riwayatnya. Mengedit pesan lama di bagian tengah membatalkan semua yang ada setelahnya.

## Hitung biaya satu permintaan

Anda tidak butuh alat apa pun untuk menghitung biaya sebuah permintaan. Baca blok usage dan kalikan setiap kelompok dengan harganya:

```python
def request_cost(usage: dict, price_miss: float, price_hit: float, price_out: float) -> float:
    """USD cost of one chat completion. Prices are per million tokens, from the provider's pricing page."""
    details = usage.get("prompt_tokens_details") or {}
    hit = usage.get("prompt_cache_hit_tokens", details.get("cached_tokens", 0)) or 0
    miss = usage["prompt_tokens"] - hit
    return (miss * price_miss + hit * price_hit + usage["completion_tokens"] * price_out) / 1_000_000
```

Catat angka itu bersama model, porsi hit (`hit / prompt_tokens`), dan timestamp untuk setiap permintaan, dan Anda bisa menjawab pertanyaan-pertanyaan yang penting: fitur mana yang paling mahal, apakah hit rate cache turun setelah sebuah deploy, dan berapa banyak lalu lintas Anda yang jatuh di jendela off-peak.

## Lihat setiap permintaan dengan gateway lokal

Agar tidak perlu menyentuh setiap titik pemanggilan, taruh gateway di depan penyedia. [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) menyertakan satu gateway di paket npm-nya: Apache-2.0, lokal, **tanpa kunci dan tanpa pendaftaran**, dan tidak ada yang dikirim ke BiVelio. Jalankan satu gateway per penyedia, masing-masing di port-nya sendiri:

```bash
# DeepSeek
npx @bivelio/savings-layer gateway --upstream deepseek --port 8403

# Qwen on Model Studio's international endpoint (`--upstream qwen` is the Beijing one)
npx @bivelio/savings-layer gateway --upstream https://dashscope-intl.aliyuncs.com --port 8404
```

Gateway meneruskan path yang dikirim klien Anda ke penyedia, jadi base URL Anda adalah base URL milik penyedia dengan gateway sebagai host:

| Penyedia | `--upstream` | Base URL untuk klien OpenAI Anda |
| --- | --- | --- |
| DeepSeek | `deepseek` | `http://127.0.0.1:8403` |
| Qwen (Beijing) | `qwen` | `http://127.0.0.1:<port>/compatible-mode/v1` |
| Qwen (internasional) | `https://dashscope-intl.aliyuncs.com` | `http://127.0.0.1:8404/compatible-mode/v1` |
| GLM | `glm` | `http://127.0.0.1:<port>/api/paas/v4` |

`npx @bivelio/savings-layer --help` mencantumkan upstream lainnya (Moonshot, MiniMax, OpenRouter, Gemini, Ollama, vLLM, LM Studio).

Di Python, klien kecil dari paket ini mengurus base URL untuk Anda: buat klien OpenAI seperti biasa untuk penyedia tersebut, lalu `wrap()` mengembalikan salinannya yang melewati gateway, dengan tetap mempertahankan path milik penyedia.

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

Hal yang sama berlaku untuk Qwen dengan gateway yang satunya dan `OpenAI(base_url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1", ...)`. Jika lalu lintas Anda dirutekan lewat proxy HTTP, atur `NO_PROXY=127.0.0.1,localhost` agar permintaan ke gateway lokal tidak melewati proxy itu. Jika tidak ada gateway yang berjalan, `wrap()` melempar `GatewayUnavailable` alih-alih memanggil penyedia secara langsung. Di versi 1.2.3, pesan error itu juga mengatakan bahwa gateway membutuhkan kunci layanan: itu tidak benar, gateway berjalan tanpa kunci apa pun.

Bahasa atau alat lain juga bisa: arahkan base URL OpenAI-nya ke gateway, dan setiap permintaan menjadi satu baris di log gateway, berisi model, biaya dengan harga daftar, dan masukan yang dipecah menjadi token berharga penuh dan pembacaan cache (`cache↓`).

Ada satu pengecualian yang penting untuk alat chat dan agen: permintaan yang **di-stream** tanpa meminta usage (`stream_options: {"include_usage": true}`) tidak mendapat usage dari penyedia, sehingga versi 1.2.3 mencatatnya sebagai `not metered: the request did not ask for usage`. Minta usage di klien Anda, atau jalankan gateway dengan `BVSALA_GATEWAY_USAGE_INJECT=1`, yang menambahkan opsi itu ke stream yang belum memilikinya. Chunk terakhir dari stream tersebut kemudian memiliki daftar `choices` yang kosong, sesuatu yang tidak diantisipasi oleh kode yang membaca `choices[0]` tanpa pengecekan.

## Agen pemrograman di DeepSeek atau Qwen

DeepSeek juga memublikasikan endpoint berformat Anthropic, dan mendokumentasikan cara memakainya dengan Claude Code. Dengan `--upstream deepseek`, gateway mengirim permintaan berformat Anthropic ke endpoint itu dengan sendirinya:

```bash
npx @bivelio/savings-layer gateway --upstream deepseek --port 8402
ANTHROPIC_BASE_URL=http://127.0.0.1:8402 ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY" ANTHROPIC_MODEL=deepseek-flash claude
```

Menjalankan model non-Claude di belakang Claude Code adalah integrasi buatan DeepSeek, bukan setup yang didukung Anthropic, dan kualitas model itu untuk pekerjaan Anda sepenuhnya penilaian Anda sendiri.

**Qwen Code dengan model Qwen** butuh rute yang berbeda. Wrapper `qwen` dari paket ini tidak mencakupnya: di versi 1.2.3, `npx @bivelio/savings-layer qwen` menjalankan Qwen Code dengan tipe autentikasi Anthropic dan meneruskan ke API Anthropic, sehingga ia hanya mengukur model Claude yang dipakai dengan kunci Anthropic, dan menolak base URL DashScope berformat Anthropic. Untuk model Qwen, gunakan mode Qwen Code yang kompatibel dengan OpenAI, yang menurut [dokumentasinya](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/) dikonfigurasi dengan `OPENAI_API_KEY`, `OPENAI_BASE_URL`, dan `OPENAI_MODEL`, lalu arahkan base URL itu ke sebuah gateway. Atur `DASHSCOPE_PROXY_BASE_URL` ke URL yang persis sama:

```bash
npx @bivelio/savings-layer gateway --upstream https://dashscope-intl.aliyuncs.com --port 8404

GW=http://127.0.0.1:8404/compatible-mode/v1
OPENAI_BASE_URL="$GW" DASHSCOPE_PROXY_BASE_URL="$GW" OPENAI_API_KEY="$DASHSCOPE_API_KEY" OPENAI_MODEL=qwen-plus qwen
```

Variabel kedua itu penting untuk tagihan. Qwen Code menentukan dari host base URL apakah ia sedang berbicara dengan DashScope, dan `127.0.0.1` bukan host DashScope. Tanpa variabel itu, Qwen Code kembali ke penyedia OpenAI generiknya, yang tidak mengirim penanda cache eksplisit (`cache_control` dan header `X-DashScope-CacheControl`). Permintaan Anda lalu jatuh ke cache implisit Model Studio, yang hit-nya biasanya berharga 20 % dari harga masukan dan bersifat best effort, alih-alih 10 % milik cache eksplisit ([context cache](https://www.alibabacloud.com/help/en/model-studio/context-cache)). Qwen Code memperlakukan base URL yang persis sama dengan `DASHSCOPE_PROXY_BASE_URL` sebagai DashScope, dan mempertahankan penandanya ([penyedia DashScope-nya](https://github.com/QwenLM/qwen-code/blob/8fab857da5/packages/core/src/core/openaiContentGenerator/provider/dashscope.ts), dibaca pada 23 November 2026). Gateway meneruskan keduanya tanpa perubahan: kami sudah memeriksanya dengan versi 1.2.3.

Kami memeriksa sisi gateway dari rute ini dengan versi 1.2.3, bukan Qwen Code itu sendiri, jadi bacalah log gateway: satu baris dengan biaya per permintaan. Baris `not metered` menyebutkan alasannya: biasanya stream yang tidak meminta usage (jalankan ulang gateway dengan `BVSALA_GATEWAY_USAGE_INJECT=1`), atau model yang tidak punya baris di katalog 1.2.3, yang berisi `qwen-plus`, `qwen-flash`, `qwen3.7-flash`, `qwen3.8-flash`, dan `qwen3.8-max`, tetapi tidak berisi, misalnya, `qwen3-coder-plus`.

Dua celah harga di 1.2.3 bergantung pada variabel kedua itu. **Dengan `DASHSCOPE_PROXY_BASE_URL` diatur**, seperti di atas, Model Studio menagih setiap penulisan cache eksplisit sebesar 125 % dari harga masukan dan melaporkannya di `usage.prompt_tokens_details.cache_creation_input_tokens`. Gateway 1.2.3 tidak membaca field itu: ia mencatat token tersebut sebagai masukan biasa, dengan `cache↑0`, sebesar 80 % dari biaya sebenarnya. Harga hit-nya untuk `qwen-plus` adalah 10 % milik cache eksplisit, yang memang cocok. **Tanpa variabel itu** tidak ada penulisan eksplisit, tetapi hit-nya adalah hit implisit, yang ditagih sekitar 20 %, dan gateway mencatatnya dengan 10 % yang sama, kira-kira separuh dari biayanya.

## Apa yang diukur gateway, dan apa yang tidak

- **Angka dolarnya berasal dari katalog, bukan dari harga DeepSeek menurut jam.** Versi 1.2.3 punya baris untuk `deepseek-flash` dan `deepseek-v4-pro`. Untuk cache miss dan keluaran, keduanya memakai harga peak (jam sibuk) DeepSeek, sehingga di jam off-peak kelompok tersebut menunjukkan dua kali lipat dari yang ditagih DeepSeek. Untuk cache hit, kedua baris memakai $0.003 per juta token, yaitu harga hit off-peak DeepSeek untuk `deepseek-flash` (harga hit peak-nya dua kali lipat) dan di bawah kedua harga hit yang dipublikasikan DeepSeek untuk `deepseek-v4-pro` ([halaman harga](https://api-docs.deepseek.com/quick_start/pricing), dibaca pada 23 November 2026). Tergantung jamnya dan seberapa banyak masukan Anda yang kena cache, total gateway bisa lebih tinggi atau lebih rendah dari tagihan. Jumlah tokennya tepat; bandingkan itu terlebih dahulu. Alias klasik `deepseek-chat` tidak punya baris: permintaannya diteruskan, dan log menyatakan bahwa ia tidak diukur.
- **Ia tidak mengubah permintaan-permintaan ini.** Pada lalu lintas yang kompatibel dengan OpenAI, gateway mengukur dan meneruskan (satu-satunya pengecualian adalah injeksi usage opt-in di atas); tuas penghematannya ditujukan untuk lalu lintas berformat Anthropic. Penghematan di DeepSeek dan Qwen berasal dari cache mereka sendiri, itulah sebabnya jumlah hit adalah angka yang perlu diawasi.

## Jika Anda memanggil DeepSeek atau Qwen dari TypeScript

SDK BV-SALA bisa berkomunikasi dengan endpoint apa pun yang kompatibel dengan OpenAI dan melewati pengulangan persis serta permintaan identik yang sedang berjalan, gratis dan tanpa kunci ([cara kerjanya](/id/guides/deduplicate-llm-requests)). Di DeepSeek, panggilan yang dihindari itu dilaporkan sebagai `estimated`, bukan `reference`: versi 1.2.3 menilai sebuah pengulangan secara reference hanya ketika panggilan yang dijalankan menuju API milik OpenAI, Anthropic, atau Google sendiri. Satu peringatan untuk loop agen: pemangkasan bawaan atas hasil alat yang sudah tergantikan menulis ulang bagian tengah riwayat, dan pada penyedia yang meng-cache seluruh prompt dengan sendirinya, hal itu bisa lebih mahal daripada penghematannya. Changelog proyek melaporkan +166 % pada loop agen 60 langkah di DeepSeek, diukur terhadap penyedia palsu dengan versi 1.2.3 dan 1.2.4 dan tanpa kunci. Untuk loop agen, matikan fitur ini per permintaan:

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

## Cek angkanya terhadap penyedia Anda

Sekali sehari, bandingkan total gateway per model (masukan, cache hit, keluaran) dengan halaman usage di platform DeepSeek atau Model Studio untuk kunci yang sama. Total jumlah token harus cocok, dengan satu pengecualian dalam cara pembagiannya: di Qwen, versi 1.2.3 menghitung penulisan cache eksplisit sebagai masukan biasa, bukan sebagai penulisan cache. Jumlah dolar bisa berbeda, ke arah mana pun, karena alasan yang sudah diketahui. Harga katalog bukan harga DeepSeek menurut jam. Di Qwen, 1.2.3 memberi harga masukan biasa pada penulisan cache eksplisit, di bawah yang ditagih Model Studio, dan tarif eksplisit pada hit implisit (keduanya dijelaskan di atas). Harga regional dan diskon juga mengubah nilai uangnya. Untuk metode langkah demi langkah, lihat [cara memverifikasi penghematan LLM terhadap tagihan penyedia Anda](/id/guides/verify-llm-savings-against-provider-bill). Kode gateway dan panduan per terminalnya ada di [GitHub](https://github.com/BiVelio/bivelio-savings-layer), dan apa yang sudah diukur proyek ini, serta yang belum, ada di [halaman benchmark](/id/benchmarks).
