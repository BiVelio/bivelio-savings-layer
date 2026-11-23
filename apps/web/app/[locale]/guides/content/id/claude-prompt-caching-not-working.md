Anda sudah menambahkan `cache_control` ke permintaan Claude, tetapi tagihannya tidak bergerak. Atau `cache_read_input_tokens` kembali bernilai `0` di setiap panggilan. Panduan ini menjelaskan mengapa hal itu terjadi, cara menemukan byte persis yang merusak cache Anda, dan cara mengecek hasilnya terhadap angka penggunaan milik Anthropic sendiri. Semua yang ada di sini berlaku untuk SDK apa pun. Di bagian akhir, Anda akan melihat bagaimana SDK open source BV-SALA menempatkan breakpoint untuk Anda, dan satu kasus ketika Anda sebaiknya menyuruhnya untuk tidak melakukannya.

## Baca tiga field usage terlebih dahulu

Setiap respons Messages API memberi tahu apa yang terjadi pada cache. Perhatikan tiga angka di `usage`:

| Field | Yang dihitung |
| --- | --- |
| `cache_creation_input_tokens` | Token yang ditulis ke cache pada panggilan ini, ditagih di atas harga masukan normal |
| `cache_read_input_tokens` | Token yang dilayani dari cache, ditagih sebagian kecil dari harga masukan |
| `input_tokens` | Token setelah breakpoint cache terakhir, ditagih dengan harga normal |

Tiga pola berikut menunjukkan di mana Anda harus mencari:

- **Kedua field cache bernilai 0.** Tidak ada yang di-cache sama sekali: prefiksnya lebih pendek dari batas minimum model, tidak ada breakpoint, atau sesuatu di antara Anda dan API menghapusnya.
- **Nilai creation tinggi di setiap panggilan dan read tetap 0.** Cache ditulis tetapi tidak pernah dipakai ulang: prefiks berubah antarpanggilan, entri sudah kedaluwarsa, atau panggilan dikirim ke model atau workspace yang berbeda.
- **Nilai read tinggi.** Cache bekerja. Sekarang pertanyaannya tinggal seberapa banyak bagian prompt yang berada sebelum breakpoint.

## Cara kerja prompt cache Claude, dalam enam fakta

1. Yang di-cache adalah **prefiks**: permintaan dari awal hingga sebuah breakpoint `cache_control`. Pencocokannya persis; satu byte berbeda dan semua yang ada setelahnya diproses ulang.
2. Urutannya **tools, lalu system, lalu messages**. Perubahan pada daftar tools membatalkan system prompt dan pesan-pesan sesudahnya.
3. Anda bisa menempatkan hingga **empat breakpoint**, dan dari masing-masing breakpoint API menengok ke belakang sejumlah blok terbatas untuk mencari entri sebelumnya (20 pada saat panduan ini ditulis).
4. Entri hidup **lima menit** secara bawaan, dan diperbarui setiap kali kena hit. Masa hidup satu jam tersedia dengan `"ttl": "1h"`.
5. Menulis lebih mahal daripada membaca: penulisan lima menit ditagih 1.25 kali harga masukan dan penulisan satu jam 2 kali; pembacaan hanya sebagian kecil dari harga masukan (0.1 kali pada sebagian besar model). Periksa [halaman harga Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) untuk model Anda.
6. Ada **panjang minimum yang bisa di-cache** yang bergantung pada model, dari 512 hingga 4,096 token. Di bawah batas itu, permintaan tidak di-cache begitu saja, tanpa ada error.

Semua ini ada di [dokumentasi prompt caching Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), sumber yang patut dipercaya ketika ada angka yang berubah.

## Penyebab umum, sesuai urutan pemeriksaannya

1. **Prefiksnya terlalu pendek.** System prompt 600 token berada di bawah batas minimum pada beberapa model. Satukan instruksi yang stabil, contoh, dan teks referensi agar bagian yang di-cache cukup panjang untuk berarti.
2. **Ada sesuatu di prefiks yang berubah di setiap panggilan.** Yang klasik: timestamp atau baris "Hari ini tanggal…" di system prompt, id permintaan, nama pengguna, urutan contoh yang acak, definisi alat yang dibangun dari objek yang urutan key-nya tidak tetap, atau dokumen JSON yang diserialisasi dengan spasi berbeda.
3. **Breakpoint-nya berada pada konten yang berubah.** Jika `cache_control` terakhir berada di pertanyaan pengguna, setiap panggilan menulis entri baru yang tidak pernah dibaca siapa pun. Breakpoint seharusnya berada di akhir bagian yang tidak berubah.
4. **Entrinya kedaluwarsa.** Panggilan yang berjarak lebih dari lima menit tidak pernah membaca entri satu sama lain. Batch malam yang menjalankan satu item setiap sepuluh menit membayar premi tulis setiap kali dan tidak membaca apa pun.
5. **Panggilan-panggilan itu tidak berbagi cache.** Model yang berbeda, workspace yang berbeda, atau berganti model di tengah percakapan, masing-masing mulai dari cache kosong.
6. **Panggilan paralel saling berebut.** Sebuah entri baru bisa dibaca setelah respons pertama mulai keluar. Sepuluh panggilan identik yang dikirim sekaligus semuanya menulis. Kirim satu dulu, baru sisanya.
7. **Proxy menghapus penandanya.** Gateway yang membuang `cache_control`, atau mengubah `system` berbentuk blok menjadi string biasa, membuat seluruh prompt ditagih sebagai masukan tanpa cache sementara setiap panggilan tetap berhasil. Dokumentasi Claude Code menjelaskan kegagalan persis ini untuk [gateway LLM](https://code.claude.com/docs/en/prompt-caching).

## Temukan byte yang merusak cache Anda

Ketika nilai read tetap nol, catat dua body permintaan berturut-turut dan temukan di mana keduanya pertama kali berbeda, sesuai urutan cache membacanya:

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

Jika perbedaan pertama berada di dalam system prompt atau daftar tools, Anda sudah menemukan penyebab cache miss-nya. Pindahkan bagian itu ke akhir permintaan, biasanya ke dalam pesan pengguna.

Setelah itu, pantau hit rate per panggilan, agar regresi langsung terlihat pada hari ia dirilis:

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

## Apakah caching sepadan untuk lalu lintas Anda?

Karena penulisan lebih mahal daripada masukan biasa, caching adalah taruhan bahwa prefiks akan dibaca lagi sebelum kedaluwarsa. Dengan masa hidup lima menit, satu pembacaan saja sudah menutup biaya penulisannya. Prefiks yang ditulis dan tidak pernah dibaca harganya sekitar 25 % lebih mahal daripada mengirimnya tanpa penanda. Karena itulah "tambahkan `cache_control` di mana-mana" bukan bawaan yang aman: cara itu menguntungkan pada lalu lintas chat dan agen yang kembali dalam hitungan menit, dan merugi pada permintaan sekali jalan atau pada prompt yang berubah setiap kali.

## Cara BV-SALA menanganinya

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) adalah lapisan penghematan berlisensi Apache-2.0. Dengan `AnthropicProvider`, ia menempatkan breakpoint untuk Anda, gratis dan tanpa kunci: satu di akhir system prompt dan satu di akhir bagian percakapan yang tidak berubah, tidak pernah lebih dari yang diizinkan API. Laporan setiap panggilan menunjukkan apa yang dilakukan cache, berdasarkan penghitung milik Anthropic sendiri:

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

`report.nativeSavings` adalah diskon dari Anthropic, ditampilkan terpisah: lapisan ini tidak pernah menghitungnya sebagai penghematannya sendiri, sehingga laporan Anda tetap cocok dengan faktur.

**Kasus ketika Anda sebaiknya mematikan penandaan.** Tanpa kunci, jika system prompt Anda berubah di setiap permintaan (timestamp, id pengguna), atau panggilan Anda berjarak lebih dari lima menit dalam proses yang baru, penandaan bawaan menulis entri cache yang tidak dibaca siapa pun, dan README menyatakan bahwa ini sekitar 20 % lebih mahal daripada tanpa lapisan. Pindahkan yang berubah ke pesan pengguna, atau matikan penandaannya:

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

Penyusunan ulang opt-in itulah tuas di balik uji langsung eksploratif yang dipublikasikan di README: pada `claude-haiku-4-5`, dalam urutan yang sengaja disusun dengan timestamp yang meracuni cache, opsi ini menaikkan hit rate dari 0 % ke 95 % dan menurunkan biaya per permintaan sebesar 82.76 %, dibandingkan dengan lapisan itu sendiri tanpa opsi tersebut, 20 permintaan per lengan, diukur dengan versi 1.2.0 pada 15 November 2026. Ini uji kecil yang disusun khusus, bukan perkiraan untuk lalu lintas Anda.

## Verifikasi terhadap angka Anthropic

1. **Per panggilan.** Catat `usage` dari setiap respons (atau `report.nativeSavings` jika Anda memakai lapisan ini) dan hitung hit rate seperti di atas. Beban kerja chat atau agen yang sehat menunjukkan angka read jauh di atas write setelah panggilan pertama.
2. **Per hari.** Di Claude Console, halaman usage memecah masukan menjadi penulisan cache dan pembacaan cache per model dan kunci API. Jumlahkan `cache_read_input_tokens` dan `cache_creation_input_tokens` yang Anda catat untuk kunci yang sama dan hari UTC yang sama: totalnya harus cocok. Untuk pengecekan terprogram, [Usage and Cost Admin API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) mengembalikan penghitung yang sama.
3. **Dalam uang.** Hitung harga pembacaan, penulisan, dan masukan biasa secara terpisah. Laporan yang hanya menunjukkan "token yang dihemat" tanpa premi tulisnya menyembunyikan separuh dari hitungan untung-ruginya.

[Benchmark publik](/id/benchmarks) repositori ini mengukur kedua lengan setiap uji dengan penghitung penggunaan milik penyedia. Untuk metode umumnya, lihat [cara memverifikasi penghematan LLM terhadap tagihan Anda](/id/guides/verify-llm-savings-against-provider-bill). Untuk sisi OpenAI dari masalah yang sama, lihat [mengapa cached_tokens OpenAI bernilai 0](/id/guides/openai-prompt-caching-cached-tokens). Kodenya ada di [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
