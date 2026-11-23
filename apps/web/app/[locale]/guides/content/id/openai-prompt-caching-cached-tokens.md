OpenAI meng-cache prompt panjang secara otomatis: ketika awal sebuah permintaan cocok dengan permintaan yang baru-baru ini diprosesnya, token masukan itu ditagih dengan diskon dan jawabannya mulai lebih cepat. Anda tidak perlu mengaktifkan apa pun. Justru karena itu, mudah untuk tidak menyadarinya ketika caching berhenti bekerja. Jika `cached_tokens` kembali bernilai `0` di setiap permintaan, panduan ini mencantumkan penyebabnya sesuai urutan pemeriksaan, menunjukkan cara memantau hit rate per permintaan, dan cara mengeceknya terhadap data penggunaan milik OpenAI sendiri.

## Di mana membacanya

Setiap respons memberi tahu berapa banyak token masukan yang berasal dari cache:

- **Chat Completions:** `usage.prompt_tokens_details.cached_tokens`, dari total `usage.prompt_tokens`.
- **Responses API:** `usage.input_tokens_details.cached_tokens`, dari total `usage.input_tokens`.

Token dari cache adalah bagian dari total masukan, bukan tambahan di atasnya. [Panduan prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) OpenAI adalah rujukan untuk aturan yang berlaku saat ini. Panduan itu kini membedakan model yang lebih baru, yang juga melaporkan dan menagih penulisan cache serta menerima opsi cache eksplisit, dari model yang lebih lama, yang penulisan cache-nya gratis. Periksa bagian untuk model yang Anda pakai.

## Mengapa cached_tokens bernilai 0

1. **Prompt-nya terlalu pendek.** Caching dimulai dari sekitar 1.024 token prompt; ambang persisnya dan cara pembulatan jumlah token dari cache bergantung pada model. System prompt 600 token dan pertanyaan singkat tidak akan pernah kena cache, dan tidak ada yang memberi tahu Anda.
2. **Awal prompt-nya berubah.** Cache mencocokkan mulai dari token pertama. Timestamp, id permintaan, atau nama pengguna di pesan pertama membuat setiap permintaan unik sejak token pertama. Tools, gambar, dan format respons juga bagian dari prefiks, jadi tools yang urutannya berbeda, atau skema yang diserialisasi secara berbeda, merusak kecocokannya.
3. **Cache-nya sudah di-evict.** Entri disimpan sebentar setelah terakhir dipakai, biasanya hitungan menit saat lalu lintas sepi. Permintaan yang berjarak satu jam jarang kena hit.
4. **Lalu lintasnya tersebar.** Permintaan dirutekan berdasarkan hash dari awal prompt. Volume yang sangat tinggi dengan prefiks yang sama meluap ke mesin lain yang tidak menyimpan entri itu. Parameter `prompt_cache_key` milik OpenAI mengelompokkan permintaan yang berbagi prefiks; gunakan satu key per templat prompt, bukan per pengguna, dan jaga laju permintaan setiap key tetap moderat, seperti dijelaskan dalam panduan tersebut.
5. **Anda tidak membaca field-nya.** Permintaan Chat Completions yang di-stream sama sekali tidak membawa usage kecuali Anda memintanya dengan `stream_options: { include_usage: true }`. Banyak wrapper membuang `prompt_tokens_details`. Beberapa penyedia yang kompatibel dengan OpenAI dan beberapa deployment Azure melaporkan caching secara berbeda atau tidak sama sekali.

## Uji dalam dua menit

Sebelum men-debug aplikasi Anda, pastikan dulu caching memang bekerja untuk akun dan model Anda. Kirim prompt panjang yang sama dua kali, berselang beberapa detik, lalu baca usage dari setiap jawaban:

```bash
# A system prompt well above the threshold, sent twice. The second answer should report cached tokens.
BODY=$(python3 -c 'import json; print(json.dumps({"model": "gpt-4o-mini", "messages": [{"role": "system", "content": "You are a careful assistant for an invented shop. " * 200}, {"role": "user", "content": "Say OK."}]}))')
for i in 1 2; do
  curl -s https://api.openai.com/v1/chat/completions \
    -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" \
    -d "$BODY" | python3 -c 'import json, sys; u = json.load(sys.stdin)["usage"]; print(u["prompt_tokens"], u.get("prompt_tokens_details"))'
done
```

Jika baris kedua menunjukkan token dari cache, sisi penyedia berfungsi dan masalahnya ada pada cara aplikasi Anda menyusun prompt: lanjutkan membaca. Jika tidak ada, coba lagi beberapa kali (caching bersifat best effort, dan permintaan pertama bisa mendarat di mesin yang berbeda), lalu periksa entri model tersebut di panduan caching OpenAI. Ganti dengan model yang Anda pakai di produksi; uji pada model lain hampir tidak membuktikan apa-apa.

Uji ini juga memberi Anda baseline untuk bagian-bagian berikutnya. Setelah Anda mengubah urutan prompt atau menambahkan `prompt_cache_key`, jalankan perbandingan yang sama pada templat nyata dari aplikasi Anda dan simpan angkanya. Hit rate yang diukur sebelum dan sesudah perubahan, pada templat yang benar-benar dipakai pengguna Anda, adalah hasil yang bisa Anda tunjukkan; "caching seharusnya membantu" bukan hasil.

## Taruh yang berubah di akhir

Perbaikan untuk sebagian besar kasus adalah soal urutan. Semua yang sama untuk setiap permintaan diletakkan di depan dan tetap identik byte demi byte; semua yang berubah diletakkan di akhir.

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

Lalu pantau porsi setiap prompt yang di-cache, agar regresi terlihat pada hari ia dirilis:

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

Kelompokkan berdasarkan templat prompt. Templat yang porsinya tetap 0% padahal prompt-nya di atas 1.024 token punya sesuatu yang berubah di dekat awal: catat dua permintaan dan bandingkan karakter demi karakter, seperti ditunjukkan di [versi Claude dari panduan ini](/id/guides/claude-prompt-caching-not-working#temukan-byte-yang-merusak-cache-anda).

## Bagaimana BV-SALA membantu

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) adalah lapisan penghematan berlisensi Apache-2.0 untuk TypeScript yang membungkus endpoint apa pun yang kompatibel dengan OpenAI, gratis dan tanpa kunci. Cache OpenAI bersifat otomatis, jadi lapisan ini tidak menandai apa pun di OpenAI. Yang dilakukannya untuk caching:

- **Ia selalu meminta usage pada stream,** sehingga permintaan yang di-stream tetap terukur alih-alih diam-diam kehilangan penghitungnya.
- **Ia menampilkan diskon OpenAI di setiap panggilan,** dalam `report.nativeSavings`, dari penghitung milik OpenAI sendiri, dan memisahkannya dari penghematannya sendiri: diskon itu milik OpenAI, bukan milik lapisan ini.
- **Ia bisa memindahkan baris yang mudah berubah keluar dari prefiks.** Dengan opsi opt-in `savings: { cachePrefix: true }`, baris system prompt yang berubah di setiap permintaan (timestamp ISO, UUID, waktu epoch) dipindahkan ke akhir, sehingga bagian yang stabil bisa di-cache. Model membaca baris yang sama dalam urutan berbeda, itulah sebabnya ini keputusan Anda dan tidak pernah aktif secara bawaan.

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

Tuas milik lapisan ini sendiri (melewati pengulangan persis dan permintaan identik yang sedang berjalan) terpisah dari cache OpenAI dan dijelaskan dalam [deduplikasi permintaan LLM yang identik](/id/guides/deduplicate-llm-requests).

## Verifikasi terhadap angka OpenAI

1. **Per permintaan:** catat `cached_tokens` dan total masukan dari setiap respons, atau `report.tokens.providerCachedInput` jika memakai lapisan ini.
2. **Per hari:** [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) OpenAI mengembalikan penggunaan completions dalam bucket harian yang mencakup token masukan dari cache, per model dan, jika Anda minta, per kunci API atau proyek. Jumlahkan log Anda untuk kunci, model, dan hari UTC yang sama: total masukan dari cache dan total masukan tanpa cache harus sama dengan angka OpenAI.
3. **Dalam uang:** hitung harga masukan dari cache dan tanpa cache secara terpisah. Pada model yang menagih penulisan cache, sertakan juga penulisan itu, atau estimasi penghematan Anda akan terlalu tinggi.

Untuk metode lengkapnya, baca [cara memverifikasi penghematan LLM terhadap tagihan penyedia Anda](/id/guides/verify-llm-savings-against-provider-bill). Untuk tuas lain pada tagihan OpenAI, lihat [cara mengurangi biaya API OpenAI](/id/guides/reduce-openai-api-costs). Hasil yang terukur, termasuk di mana lapisan ini tidak menghemat apa pun, ada di [halaman benchmark](/id/benchmarks), dan kodenya ada di [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
