Setiap API LLM menagih per panggilan. Jika aplikasi Anda mengirim permintaan yang sama dua kali, Anda membayar dua kali, padahal jawaban kedua tidak menambah apa-apa. Panduan ini menunjukkan dua teknik untuk menghentikannya: **cache respons yang cocok persis** untuk pengulangan yang datang belakangan, dan **penggabungan in-flight** untuk permintaan identik yang datang pada saat yang sama. Keduanya bekerja di bahasa apa pun dan dengan penyedia apa pun. Di bagian akhir, Anda akan melihat bagaimana SDK open source BV-SALA melakukan keduanya secara bawaan, dan cara mengecek penghematannya terhadap angka penggunaan milik penyedia Anda sendiri.

## Dari mana datangnya permintaan duplikat

Duplikat lebih sering terjadi daripada kelihatannya, karena jarang berasal dari satu tempat yang jelas:

- **Retry dan klik ganda.** Pengguna menekan "Generate" dua kali, atau library klien melakukan retry setelah timeout padahal penyedia sebenarnya sudah menjawab.
- **Job batch dan cron.** Job malam mengklasifikasikan deskripsi produk, entri FAQ, atau makro layanan pelanggan yang sama dengan yang sudah diklasifikasikannya kemarin.
- **Fan-out.** Dua worker, dua tab browser, atau effect React yang berjalan dua kali dalam mode development mengirim prompt yang sama dalam hitungan milidetik.
- **Agen dan pipeline.** Pipeline multi-langkah menanyakan sub-pertanyaan yang sama di beberapa cabang.
- **Tes dan eval.** CI menjalankan fixture yang sama terhadap API live pada setiap push.

Kelompok pertama dan terakhir adalah pengulangan dari waktu ke waktu; fan-out adalah soal konkurensi. Keduanya butuh perbaikan berbeda, dan karena itulah panduan ini membahas keduanya.

## Ukur tingkat duplikasi Anda terlebih dahulu

Sebelum membangun apa pun, cari tahu seberapa banyak lalu lintas Anda yang berulang. Buat hash dari setiap body permintaan selama sehari lalu hitung. Key-nya harus **kanonis**: permintaan yang sama harus menghasilkan byte yang sama, apa pun urutan key JSON-nya.

```ts
import { createHash } from "node:crypto";

// Canonical JSON: the same object gives the same text, whatever the key order.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function requestKey(body: object, scope = "global"): string {
  return createHash("sha256").update(`${scope}\n${canonical(body)}`).digest("hex");
}

// Feed it one day of request bodies, then read the share that repeated.
const seen = new Map<string, number>();
export function record(body: object): void {
  const key = requestKey(body);
  seen.set(key, (seen.get(key) ?? 0) + 1);
}
export function duplicateRate(): number {
  let total = 0;
  for (const n of seen.values()) total += n;
  return total === 0 ? 0 : (total - seen.size) / total;
}
```

Jika tingkatnya mendekati nol, cache respons tidak akan banyak menghemat, dan sebaiknya Anda melihat [prompt caching](/id/guides/claude-prompt-caching-not-working) atau [pilihan model](/id/guides/reduce-openai-api-costs). Jika porsi permintaan Anda yang berulang cukup berarti, lanjutkan membaca.

## Bangun cache key yang benar-benar aman

Cache eksak hanya sebaik key-nya. Aturannya sederhana: **semua yang bisa mengubah jawaban masuk ke dalam key, dan tidak ada yang dinormalisasi.**

- ID model, daftar pesan lengkap, system prompt, definisi alat, format respons atau skema JSON, dan setiap parameter sampling (`temperature`, `top_p`, `max_tokens`, `seed`, reasoning effort).
- Sebuah **scope** ketika prompt membawa data pengguna. Dua pengguna yang bertanya "berapa saldo saya?" mengirim teks yang sama tetapi butuh jawaban berbeda. Masukkan id pengguna atau tenant ke dalam key, atau jangan simpan permintaan itu ke cache sama sekali.
- Tanpa normalisasi yang "cerdik". Mengubah ke huruf kecil, memangkas spasi, atau membuang tanda baca demi mendapat lebih banyak hit mengubah cache eksak menjadi cache fuzzy, dan cache fuzzy bisa mengembalikan jawaban untuk pertanyaan yang berbeda.

## Yang tidak boleh dilayani dari cache

Sebagian permintaan memang berulang, tetapi tetap harus sampai ke model setiap kali:

- **Jawaban yang memang harus berubah**: "pilih nama acak", "buat kata sandi", "jam berapa sekarang", "harga hari ini". Jawaban dari cache di sini adalah bug, bukan penghematan.
- **Alat dengan efek samping.** Jika respons meminta pemanggilan `send_email` atau `create_order`, memutarnya ulang berarti melewatkan aksinya. Hanya simpan ke cache permintaan yang alat-alatnya read-only, atau yang tidak memakai alat sama sekali.
- **Keluaran sampling yang diharapkan pengguna bervariasi.** Dengan `temperature` tinggi, jawaban dari cache hanyalah satu sampel, yang disajikan selamanya.
- **Error, jawaban kosong, penolakan, dan jawaban terpotong.** Jangan pernah menuliskannya ke cache; biarkan permintaan berikutnya mencoba lagi.
- **Topik sensitif.** Bot layanan pelanggan sebaiknya tidak meng-cache jawaban tentang menyakiti diri sendiri atau keadaan darurat medis; kirim permintaan semacam itu ke model setiap kali.

## Gabungkan permintaan identik yang sedang berjalan

Cache baru membantu setelah jawaban pertama tiba. Jika sepuluh permintaan identik dimulai dalam rentang 300 ms yang sama, kesepuluhnya miss. Perbaikannya adalah pola kecil yang sering disebut *singleflight*: pemanggil pertama melakukan panggilan, sisanya menunggu promise yang sama.

```ts
const inFlight = new Map<string, Promise<unknown>>();

export function singleflight<T>(key: string, call: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key) as Promise<T> | undefined;
  if (running) return running; // join the call that is already on its way
  const p = call().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p; // an error reaches every caller that joined, so nobody waits forever
}
```

Tiga detail penting di produksi. Error harus sampai ke setiap pemanggil yang menunggu (pola di atas sudah melakukannya). Satu pemanggil yang membatalkan tidak boleh ikut membatalkan panggilan bersama untuk yang lain. Dan streaming lebih sulit: stream yang sudah dimulai tidak bisa begitu saja diserahkan ke pemanggil kedua, jadi sebagian besar implementasi mengizinkan permintaan biasa bergabung ke panggilan yang sedang berjalan, tetapi tidak mengizinkan apa pun bergabung ke stream.

## Cara BV-SALA melakukannya

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) adalah lapisan penghematan berlisensi Apache-2.0 untuk TypeScript. SDK-nya membungkus penyedia Anda dan, **tanpa kunci dan tanpa pendaftaran**, mengaktifkan kedua teknik secara bawaan: cache eksak dan deduplikasi permintaan yang sedang berjalan. SDK ini juga menerapkan aturan "jangan pernah di-cache" di atas: permintaan yang kata-katanya menuntut data terkini atau keacakan, kata-kata personal tanpa sesi, topik sensitif, penolakan, dan error tidak masuk ke cache.

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({
    baseUrl: "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY,
  }),
  // Nothing else is required: the exact cache and deduplication are on by default.
});

const request = {
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user" as const, content: "Classify the sentiment as positive or negative: The battery lasts two days." }],
  temperature: 0,
};

const first = await layer.generate(request);
const again = await layer.generate(request);
console.log(first.report.cache.result, again.report.cache.result); // "miss" "exact"
console.log(again.report.calls.avoidedLlm); // 1: the repeat never reached the provider

// Two identical requests at the same moment: one call, shared by both.
const other = { ...request, messages: [{ role: "user" as const, content: "Classify the sentiment as positive or negative: Shipping took a month." }] };
const [a, b] = await Promise.all([layer.generate(other), layer.generate(other)]);
console.log(a.report.cache.result, b.report.cache.result); // "miss" "singleflight"
```

Permintaan yang tampak personal ("pesanan saya", "faktur kami") tidak di-cache kecuali Anda menyebutkan milik siapa. Berikan scope dan cache bekerja lagi, terpisah untuk setiap sesi:

```ts
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY }),
});

const answer = await layer.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "Translate to French: the invoice for my order is attached." }],
  context: { sessionId: "user-42" }, // cached for this session only
});
console.log(answer.report.cache.result);
```

Cache bawaan hidup di memori satu proses. Untuk membaginya antara beberapa server atau instance serverless, berikan store yang Anda kelola sendiri melalui opsi `exactCache`. Store ini hanya butuh tiga method, jadi key-value store apa pun bisa dipakai:

```ts
import { createSavingsLayer, OpenAICompatibleProvider, type ExactCache } from "@bivelio/savings-layer";

// The three calls a Redis client offers; adapt the names to yours.
interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export function sharedLayer(redis: RedisLike) {
  const exactCache: ExactCache = {
    async get(key) {
      const raw = await redis.get(`bvsala:${key}`);
      return raw ? JSON.parse(raw) : null;
    },
    async set(key, value, ttlMs) {
      await redis.set(`bvsala:${key}`, JSON.stringify(value), "PX", ttlMs ?? 3_600_000);
    },
    async delete(key) {
      await redis.del(`bvsala:${key}`);
    },
  };
  return createSavingsLayer({
    provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY }),
    exactCache,
  });
}
```

Jawaban yang di-cache tetap berada di infrastruktur Anda. Tidak ada yang dikirim ke BiVelio saat Anda menjalankannya tanpa kunci.

## Verifikasi penghematan terhadap angka penyedia Anda

Penghematan dari cache mudah dicek, karena itu adalah hitungan panggilan yang tidak terjadi.

1. **Hitung panggilan di kedua sisi.** Selama sehari, hitung panggilan `generate()` yang dibuat aplikasi Anda dan bandingkan dengan jumlah permintaan yang ditunjukkan penyedia untuk kunci API dan model yang sama (halaman usage di console OpenAI atau Anthropic, atau API usage mereka). Selisihnya harus sama dengan jumlah `report.calls.avoidedLlm`.
2. **Baca bagaimana setiap pengulangan dinilai.** `report.cost.basis` menyebutkan dari mana angkanya berasal. Sebuah pengulangan bernilai `reference` ketika panggilan identik yang benar-benar dijalankan langsung menuju API OpenAI, Anthropic, atau Gemini milik Google (`api.openai.com`, `api.anthropic.com`, atau `generativelanguage.googleapis.com`): baseline-nya adalah penghitung usage dari panggilan itu sendiri, dihargai secara konservatif dengan tarif masukan dari cache. Nilainya tetap `estimated` ketika panggilan yang dijalankan menuju ke tempat lain, termasuk API milik penyedia lain seperti DeepSeek, sebuah proxy, Azure, atau gateway, karena harga daftar lapisan ini hanya diketahui cocok dengan faktur pada ketiga API tersebut. Uang hasil estimasi selalu dilaporkan terpisah.
3. **Bandingkan pengeluaran, bukan hanya panggilan.** Jumlahkan `report.cost.netSavingsUsd` per basis. Jangan pernah menjumlahkan nilai terukur dengan estimasi, dan jangan pernah merata-ratakan `netSavingsRatio` antarpermintaan.

Jika Anda ingin uji yang lebih bersih, jalankan beban kerja yang sama dua kali, sekali dengan tuas dimatikan untuk run itu (`savings: { exactCache: false, singleflight: false }` di setiap permintaan) dan sekali dengan pengaturan bawaan, lalu bandingkan kedua tagihannya.

## Apa kata angka publik

Repositori ini memublikasikan run benchmark-nya. Pada beban kerja publik yang dibangun dari soal GSM8K dengan 30% permintaan berupa pengulangan persis, penurunan gabungan yang terukur adalah **31,50%** untuk `gpt-4o-mini`, dengan interval 95% dari 25,7% hingga 36,7% (artefak SDK 0.4.31 dari September 2026; sumber: [halaman benchmark](/id/benchmarks#savings) dan README). Pada lalu lintas yang tidak pernah berulang, penghematannya sekitar 0%, dan [halaman benchmark](/id/benchmarks#no-savings) juga menampilkan hasil datar itu. Halaman itu juga menghitung kegagalan yang paling penting bagi sebuah cache: **0 dari 198** varian pertanyaan dilayani dengan jawaban untuk pertanyaan lain ([jaminan](/id/benchmarks#guarantees)).

Penghematan Anda bergantung pada tingkat duplikasi Anda, jadi ukur dulu dengan snippet di bagian atas halaman ini. Kode, makalah, dan laporan mentahnya ada di [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
