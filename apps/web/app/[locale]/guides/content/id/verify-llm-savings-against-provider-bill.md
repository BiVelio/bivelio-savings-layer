Setiap alat biaya LLM menampilkan angka penghematan. Hanya sedikit yang menunjukkan cara mengeceknya, dan justru di pengecekan itulah sebagian besar klaim runtuh: dasbor menunjukkan penghematan besar sementara faktur nyaris tidak bergerak. Panduan ini memberi metode yang bisa Anda jalankan dengan alat apa pun, atau tanpa alat: apa yang perlu dicatat, cara merekonsiliasinya dengan data penggunaan penyedia, cara membedakan penghematan nyata dari estimasi, dan cara memastikan penghematan itu berasal dari perubahan yang Anda buat. Di bagian akhir, Anda akan melihat bagaimana SDK open source BV-SALA memberi label pada setiap jumlah agar pengecekan ini bisa dilakukan.

## Mengapa angka penghematan dan tagihan tidak cocok

Selisihnya hampir selalu berasal dari salah satu hal berikut:

- **Harga daftar versus harga Anda.** Alat-alat itu menghitung biaya token dengan harga daftar publik. Faktur Anda bisa mencakup diskon, kontrak committed-use, tarif regional atau data residency, priority tier, dan pajak.
- **Estimasi yang disajikan sebagai pengukuran.** Jika sebuah alat menghapus 2.000 token dari prompt, penyedia tidak pernah menghitungnya. Angka "dihemat" itu adalah hitungan alat itu sendiri, dibuat dengan tokenizer yang belum tentu milik penyedia.
- **Diskon penyedia diklaim sebagai milik alat.** Prompt caching di OpenAI, Anthropic, DeepSeek, atau Gemini ditagih penyedia dengan tarif lebih rendah. Alat yang menghitung diskon itu sebagai penghematannya sendiri menggelembungkan angkanya.
- **Lalu lintas yang tidak pernah dilihat alat itu.** Panggilan dari layanan lain, skrip rekan tim, permintaan sampingan agen pemrograman, atau job batch semuanya muncul di tagihan tetapi tidak di alat.
- **Usage yang hilang.** Permintaan yang di-stream tanpa event usage terakhirnya sama sekali tidak punya jumlah token. Diam-diam menghitungnya sebagai nol membuat semua yang ada sesudahnya tampak lebih murah.
- **Waktu.** Penyedia mengelompokkan penggunaan per hari UTC, dan sebagian penggunaan baru muncul belakangan.

## Metodenya, langkah demi langkah

### 1. Catat penghitung milik penyedia untuk setiap permintaan

Bukan estimasi Anda: blok `usage` yang dikembalikan penyedia. Masukan, masukan dari cache (dan penulisan cache bila ada), keluaran, token reasoning, ID model yang dilaporkan penyedia, kunci API atau proyek, dan timestamp UTC. Tandai permintaan yang usage-nya tidak sampai sebagai **tidak terukur**, jangan pernah sebagai nol.

### 2. Rekonsiliasi token sebelum dolar

Ekspor penggunaan harian dari penyedia untuk kunci dan hari yang sama: [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) OpenAI, [Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) Anthropic, atau halaman usage di console DeepSeek dan Model Studio. Lalu bandingkan kelompok demi kelompok:

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

Jika tokennya cocok, pencatatan Anda lengkap dan Anda bisa memercayai sisa analisisnya. Jika penyedia menunjukkan lebih banyak, temukan lalu lintas yang tidak Anda catat sebelum melangkah lebih jauh.

### 3. Lalu hitung harganya, dengan tabel harga bertanggal

Kalikan setiap kelompok dengan tarifnya, simpan tanggal tarif itu disalin, lalu bandingkan dengan laporan biaya penyedia. Selisih yang stabil sebesar beberapa persen biasanya berasal dari diskon atau tarif regional, dan selisih itu sama besar dengan maupun tanpa optimasi Anda, jadi tidak mengubah penghematannya.

### 4. Pisahkan tiga jenis angka

- **Terukur (measured):** dibaca dari penghitung penyedia untuk panggilan yang dijalankan.
- **Terukur secara referensi (reference):** panggilan yang tidak terjadi (cache hit, permintaan yang dideduplikasi), dinilai dengan penghitung penyedia untuk panggilan identik yang memang dijalankan. Ini bukti terbaik yang tersedia untuk panggilan yang tidak pernah terjadi.
- **Estimasi (estimated):** apa pun yang tidak pernah dihitung penyedia, seperti token yang dihapus sebuah alat dari prompt.

Jumlahkan setiap jenis secara terpisah. Jangan pernah menambahkan jumlah estimasi ke jumlah terukur, dan jangan pernah merata-ratakan persentase antarpermintaan: jumlahkan uangnya, lalu bagi.

### 5. Pisahkan diskon penyedia dari penghematan Anda

Token masukan dari cache lebih murah karena penyedianya. Jika Anda tidak mengubah apa pun dan hit rate Anda memang sudah tinggi, diskon itu bukan penghematan dari proyek Anda. Hitung token dari cache dengan tarif cache di kedua sisi perbandingan; sisanya adalah milik Anda.

## Apakah perubahan itu yang menyebabkan penghematan?

Tagihan yang turun setelah sebuah deploy bisa juga hanya karena minggu yang sepi. Untuk mengatribusikan penghematan:

- **Jalankan dua lengan sekaligus.** Kirim permintaan yang sama dengan dan tanpa perubahan, pada waktu yang sama, melalui kunci yang sama, lalu bandingkan penghitung penyedia untuk keduanya. Permintaan yang dibagi secara acak antarlengan adalah versi yang bersih.
- **Laporkan interval, bukan satu titik.** Lakukan resample atas seluruh percakapan atau hari, dan katakan "antara X dan Y %". Interval yang melewati nol berarti Anda tidak bisa membedakan selisihnya dari noise, dan itu hasil yang sah.
- **Cek kualitas dalam run yang sama.** Jawaban lebih murah yang salah bukanlah penghematan. Ukur akurasi atau pengecekan khusus tugas di kedua lengan.

## Bagaimana BV-SALA memungkinkan pengecekan ini

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) adalah lapisan penghematan berlisensi Apache-2.0, gratis tanpa kunci. Setiap permintaan mengembalikan `SavingsReport` yang dibuat persis untuk metode ini:

- `cost.basis` bernilai `measured`, `reference`, `estimated`, atau `unmeasured`, dengan definisi seperti di atas. Sebuah pengulangan dinilai secara referensi hanya ketika panggilan yang dijalankan langsung menuju API OpenAI, Anthropic, atau Gemini milik Google; di tempat lain, nilainya tetap `estimated`.
- Penghematan disimpan dalam empat ledger terpisah yang tidak pernah dijumlahkan menjadi satu angka: `avoided_calls`, `eliminated_tokens`, `compressed_tokens`, dan `provider_cached_tokens`.
- Diskon cache milik penyedia dilaporkan terpisah, di `report.nativeSavings`, dan tidak pernah dihitung sebagai penghematan lapisan ini.
- Stream yang berakhir tanpa usage-nya bernilai `unmeasured`, tidak pernah dihargai nol.

Menjumlahkan laporan per basis hanya butuh beberapa baris:

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

Dari Python, klien dari paket ini membaca laporan yang sama dari gateway lokal dan mempertahankan pemisahan yang sama:

```python
# pip install bivelio-savings-layer
import bvsala

gw = bvsala.Gateway("http://127.0.0.1:8403")
# ... send requests with gw.wrap(client) and read each one with gw.report(response) ...
t = gw.totals()
print(t.requests, t.metered, t.not_metered, t.actual_cost_usd)
print(t.net_savings_usd_by_basis)  # one amount per basis, never added together
```

Lalu jalankan langkah 2 di atas terhadap total ini: pengeluaran `measured` dari lapisan ini harus cocok dengan penggunaan dari penyedia untuk kunci dan hari yang sama, sama persis dalam token, dan dalam dolar dengan selisih sebesar diskon Anda. Laporan dihitung dengan harga daftar; laporan bukanlah faktur.

## Metode yang sama, diterapkan secara terbuka

Proyek ini memublikasikan run A/B-nya sendiri di [halaman benchmark](/id/benchmarks): dua lengan pada permintaan yang sama, satu langsung ke penyedia dan satu melalui lapisan, keduanya diukur dengan penghitung penggunaan milik penyedia, dengan interval 95% serta tanggal dan versi setiap run. Hasil yang tidak menghemat apa pun, atau malah lebih mahal, ada di halaman yang sama. Metode lengkap, estimator, dan batasannya ada di [makalah](/id/paper).

Untuk detail khusus per penyedia, lihat [mengapa cached_tokens OpenAI bernilai 0](/id/guides/openai-prompt-caching-cached-tokens), [mengapa prompt caching Claude tidak berfungsi](/id/guides/claude-prompt-caching-not-working), dan [mengukur biaya Claude Code per permintaan](/id/guides/claude-code-cost-per-request). Kode dan laporan mentahnya ada di [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
