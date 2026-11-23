Tagihan OpenAI adalah jumlah dari beberapa angka per permintaan: token masukan tanpa cache, token masukan dari cache, penulisan cache (pada GPT-5.6 dan sesudahnya), token keluaran (termasuk reasoning), dan harga model. Setiap cara untuk menurunkannya menggeser salah satu angka itu. Panduan ini membahas tuas-tuasnya sesuai urutan yang biasanya paling menguntungkan, menjelaskan kapan masing-masing tidak efektif, dan menunjukkan cara membuktikan setiap penghematan dengan data penggunaan milik OpenAI sendiri, bukan dengan proyeksi. Sebagian besar tidak memerlukan alat apa pun; bila SDK open source BV-SALA mengotomatiskan sebuah tuas, Anda akan melihat caranya.

## Mulai dengan mengukur per permintaan

Sebelum mengubah apa pun, catat blok `usage` dari setiap respons beserta fitur atau templat prompt yang menghasilkannya: `prompt_tokens`, `prompt_tokens_details.cached_tokens`, `cache_write_tokens` bila model melaporkannya, `completion_tokens` dan, untuk model reasoning, `completion_tokens_details.reasoning_tokens`. Hitung harga setiap kelompok dengan tarif dari halaman harga OpenAI dan simpan tanggal Anda menyalinnya. Pada GPT-5.6 dan sesudahnya, penulisan cache adalah kelompok tersendiri: OpenAI menagihnya 1.25 kali tarif masukan tanpa cache dengan masa hidup bawaan 30 menit, dan 2.5 kali dengan masa hidup 12 jam ([panduan prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), dibaca pada 23 November 2026). Jika Anda menghitungnya dengan tarif masukan biasa, total Anda akan terlalu rendah. Data seminggu sudah cukup untuk menjawab satu-satunya pertanyaan yang penting di awal: **dua atau tiga fitur mana yang menyumbang sebagian besar tagihan.** Optimalkan fitur-fitur itu; abaikan sisanya.

## 1. Jangan membayar dua kali untuk permintaan yang sama

Retry, klik ganda, job malam yang mengklasifikasikan ulang item kemarin, dan worker paralel yang mengirim prompt yang sama masing-masing menghabiskan satu panggilan penuh. Cache respons yang cocok persis dan deduplikasi permintaan yang sedang berjalan menghilangkannya tanpa mengubah satu jawaban pun. Seberapa besar penghematannya sepenuhnya bergantung pada seberapa sering permintaan Anda berulang, jadi ukur dulu tingkat duplikasinya. Panduan lengkap: [deduplikasi permintaan LLM yang identik](/id/guides/deduplicate-llm-requests).

## 2. Biarkan prompt cache OpenAI bekerja

Prompt sekitar 1,024 token atau lebih di-cache secara otomatis, dan token masukan dari cache ditagih dengan diskon. Pada GPT-5.6 dan sesudahnya, mengisi cache tidak gratis: bagian yang ditulis ke cache ditagih di atas tarif tanpa cache, seperti dijelaskan di atas, sehingga prompt yang ditulis lalu tidak pernah dibaca lagi lebih mahal daripada tanpa cache, sedangkan prompt yang segera dibaca lagi jauh lebih murah. Model yang lebih lama tidak mengenakan biaya tambahan untuk penulisan. Cache hanya mencocokkan mulai dari token pertama, jadi cache hanya bekerja bila awal prompt Anda identik antarpermintaan. Taruh instruksi, definisi alat, dan contoh di depan; tanggal, nama pengguna, dan pertanyaannya di akhir. Jika `cached_tokens` macet di 0, lihat [mengapa cached_tokens OpenAI bernilai 0](/id/guides/openai-prompt-caching-cached-tokens).

## 3. Kirim pekerjaan yang bisa menunggu ke Batch API

Evaluasi, backfill, embedding untuk sekumpulan dokumen, dan klasifikasi malam hari tidak membutuhkan jawaban dalam dua detik. [Batch API](https://developers.openai.com/api/docs/guides/batch) dari OpenAI menerima file berisi permintaan, mengembalikan hasilnya dalam satu hari, dan menagihnya dengan tarif lebih rendah daripada permintaan yang sama bila dikirim satu per satu (lihat [panduan optimasi biaya](https://developers.openai.com/api/docs/guides/cost-optimization) untuk ketentuan terkini). Untuk pekerjaan offline, ini sering menjadi penghematan tunggal terbesar, dan sama sekali tidak mengubah jawabannya.

## 4. Pakai model terkecil yang lolos evaluasi Anda

Selisih harga antartingkatan model itu besar, dan banyak tugas (klasifikasi, ekstraksi, penulisan ulang singkat, routing) tidak memerlukan model terbesar. Susun set evaluasi kecil dari permintaan nyata, jalankan pada dua atau tiga model, lalu pilih yang termurah yang lolos. Jalankan ulang setiap kali ada model baru. Tanpa evaluasi, turun ke model yang lebih kecil hanyalah tebakan, dan biaya jawaban yang salah tidak muncul di tagihan API.

## 5. Kendalikan keluaran

Token keluaran biasanya beberapa kali lebih mahal daripada token masukan, dan token reasoning ditagih sebagai keluaran.

- Atur `max_completion_tokens` sesuai yang benar-benar dibutuhkan fitur tersebut.
- Untuk model reasoning, turunkan reasoning effort pada tugas yang tidak butuh penalaran mendalam, dan ukur `reasoning_tokens` sebelum dan sesudahnya.
- Minta structured output dengan skema JSON bila kode Anda mem-parsing jawabannya. Parsing yang gagal lalu diikuti retry berarti membayar seluruh permintaan dua kali.

## 6. Kirim lebih sedikit masukan

- Jangan kirim ulang seluruh percakapan bila tugasnya hanya butuh beberapa giliran terakhir.
- Jauhkan keluaran alat yang besar (log, isi file, hasil pencarian) dari giliran berikutnya setelah dipakai.
- Kirim data terstruktur secara ringkas: JSON yang di-pretty-print menghabiskan token untuk spasi.
- Ambil tiga paragraf yang relevan, alih-alih menempelkan seluruh dokumen.

Hati-hati dengan dua poin terakhir dalam loop agen yang panjang: mengedit bagian tengah riwayat yang sudah di-cache OpenAI membuat semua yang ada setelah editan itu ditagih lagi, dengan tarif tanpa cache atau, pada GPT-5.6 dan sesudahnya, dengan tarif penulisan cache yang lebih tinggi ketika di-cache lagi. Persingkat yang baru, bukan yang sudah di-cache.

## Bagaimana BV-SALA mengotomatiskan sebagian di antaranya

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) adalah lapisan penghematan berlisensi Apache-2.0 yang membungkus endpoint apa pun yang kompatibel dengan OpenAI di TypeScript. Ia menghemat dengan semua tuasnya **secara gratis, tanpa kunci dan tanpa pendaftaran**, dan tidak mengirim apa pun ke BiVelio kecuali Anda menambahkan kunci untuk dasbor cloud opsional. Aktif secara bawaan: cache eksak, deduplikasi permintaan identik yang sedang berjalan, menjawab aritmetika sederhana secara lokal, dan serialisasi ringkas untuk data terstruktur yang Anda kirim. Opt-in, masing-masing dengan satu opsi: kaskade model, pemadatan keluaran alat, dan penyusunan ulang prefiks agar bisa di-cache. Setiap permintaan mengembalikan laporan yang menyebutkan apa yang dihemat dan dari mana angkanya berasal.

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

Dua batasan, terus terang saja. Pertama, lalu lintas yang tidak pernah berulang menghemat sekitar 0 % dari cache dan deduplikasi, memang begitu rancangannya. Kedua, pemangkasan bawaan lapisan ini atas hasil alat yang sudah tergantikan bisa lebih mahal daripada penghematannya dalam loop agen panjang pada penyedia yang meng-cache seluruh prompt: changelog proyek melaporkan +12.2 % pada loop 60 langkah di `gpt-5`, diukur terhadap penyedia palsu dengan versi 1.2.3 dan 1.2.4 dan tanpa kunci. Untuk loop agen yang panjang, kirim `savings: { elision: false }` pada permintaan lalu bandingkan.

## Buktikan setiap penghematan dengan angka OpenAI

Penghematan yang tidak bisa Anda periksa hanyalah proyeksi. Untuk setiap tuas:

1. **Pilih penghitung yang seharusnya bergeser.** Caching dan deduplikasi menggeser jumlah permintaan. Prompt caching menggeser `cached_tokens`, dan pada GPT-5.6 dan sesudahnya juga `cache_write_tokens`. Batch menggeser harga. Pilihan model menggeser harga per token. Kendali keluaran menggeser `completion_tokens`.
2. **Baca penghitung itu dari OpenAI.** [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) mengembalikan jumlah permintaan, token masukan, masukan dari cache, dan token keluaran per hari, model, proyek, dan kunci. Endpoint Costs dan dasbor penggunaan menunjukkan nilai uangnya.
3. **Bandingkan yang setara.** Fitur yang sama, hari kerja yang sama, sebelum dan sesudah, atau lebih baik lagi, dua lengan dari lalu lintas yang sama pada waktu yang sama. Lihat token dulu, baru dolar: dolar juga bergerak mengikuti harga.

Dengan lapisan ini, setiap laporan memuat `cost.basis`: jumlah `measured` dan `reference` berasal dari penghitung milik OpenAI sendiri, sedangkan jumlah `estimated` dilaporkan terpisah dan tidak pernah dicampur. Metode lengkapnya: [verifikasi penghematan LLM terhadap tagihan penyedia Anda](/id/guides/verify-llm-savings-against-provider-bill).

## Apa kata angka yang dipublikasikan

[Halaman benchmark](/id/benchmarks) proyek ini mengukur kedua lengan setiap uji dengan penghitung penggunaan milik penyedia. Pada beban kerja publik yang dibangun dari soal GSM8K dengan 30 % permintaan berupa pengulangan persis, penurunan gabungan pada `gpt-4o-mini` adalah **31.50 %**, dengan interval 95 % dari 25.7 % hingga 36.7 % (artefak SDK 0.4.31, September 2026; juga tercantum di README). Pada chat dua giliran tanpa pengulangan (MT-Bench), selisihnya tidak dapat dibedakan dari nol atau tidak bisa diatribusikan ke lapisan ini, dan halaman tersebut menyatakannya dengan jelas. Metode, interval, dan setiap batasannya ada di [makalah](/id/paper). Kodenya ada di [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
