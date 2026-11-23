"Berapa biaya Claude Code?" punya dua jawaban yang jujur. Dengan langganan Claude, harganya adalah harga paket Anda, dan biaya per token baru penting begitu Anda melewati batasnya. Dengan kunci API atau penyedia cloud, Anda membayar per token, dan biaya satu sesi bergantung pada berapa banyak permintaan yang dikirim Claude Code, seberapa besar masing-masing, dan seberapa banyak yang dibaca dari prompt cache. Panduan ini menunjukkan apa yang dipublikasikan Anthropic, alat bawaan mana yang memberi Anda total, dan cara melihat biaya setiap permintaan di mesin Anda sendiri, secara gratis, sehingga Anda bisa menemukan giliran yang membuat sebuah sesi mahal.

## Berapa biayanya menurut Anthropic

[Halaman biaya Claude Code](https://code.claude.com/docs/en/costs) milik Anthropic memberikan rata-rata dari deployment enterprise: sekitar US$13 per developer per hari aktif dan US$150 hingga US$250 per developer per bulan, dengan 90% pengguna di bawah US$30 per hari aktif. Itu rata-rata dari banyak tim. Angka Anda bergantung pada model yang Anda pilih, ukuran repositori Anda, dan cara Anda bekerja, dan karena itulah sisa panduan ini membahas cara mengukurnya.

## Alat bawaan, dan apa yang tidak ditampilkannya

- **`/usage` di Claude Code.** Blok Session menampilkan biaya *estimasi* dengan harga daftar, dengan token per model yang dipecah menjadi masukan, keluaran, pembacaan cache, dan penulisan cache. Versi terbaru menambahkan baris prompt cache berisi hit rate dan jumlah miss. Ini total per sesi, dihitung secara lokal.
- **Claude Console.** Untuk kunci API, halaman Cost dan Usage menunjukkan apa yang ditagihkan, per hari, workspace, dan model. Inilah angka acuan untuk rekonsiliasi.
- **Ekspor OpenTelemetry.** Claude Code dapat mengalirkan metrik token dan biaya ke stack observabilitas Anda sendiri, per pengguna dan sesi ([dokumentasi monitoring](https://code.claude.com/docs/en/monitoring-usage)).

Yang tidak dimudahkan oleh satu pun dari alat itu adalah **tampilan per permintaan**: giliran mana yang mahal, dan mengapa. Satu sesi terdiri dari puluhan atau ratusan panggilan API, dan panggilan yang mahal punya penyebab yang bisa dikenali:

- **Cache dingin.** Giliran pertama setelah jeda yang lebih lama dari masa hidup cache membaca ulang seluruh percakapan dengan harga penuh, lalu menuliskannya lagi.
- **Berganti model.** Setiap model punya cache sendiri, jadi berganti model di tengah sesi memproses ulang semuanya.
- **Hasil alat yang sangat besar.** Log tes atau file besar yang dibaca sekali akan terus berada di konteks setiap giliran sesudahnya.
- **Terlalu banyak definisi alat.** Server MCP bisa menambahkan definisi berukuran berkilo-kilobyte ke setiap permintaan.
- **Kompaksi.** Meringkas percakapan panjang itu sendiri merupakan permintaan yang besar.

## Ukur setiap permintaan dengan gateway lokal

Gateway adalah proxy kecil di antara Claude Code dan API yang membaca penghitung penggunaan dari setiap respons. Claude Code mendukungnya secara resmi lewat `ANTHROPIC_BASE_URL`. [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) menyertakan satu gateway di paket npm-nya: Apache-2.0, **tanpa kunci, tanpa pendaftaran**, dan tidak ada yang dikirim ke BiVelio. Ia membutuhkan Node.js 20 atau yang lebih baru.

Cara dengan satu perintah:

```bash
# Starts a local gateway on a free port, runs Claude Code through it, and stops it on exit.
npx @bivelio/savings-layer claude
```

Wrapper ini membuat log per permintaan tetap senyap agar tidak menimpa antarmuka Claude Code. Saat Anda keluar, ia mencetak berapa banyak permintaan yang diukurnya dan mana yang diteruskannya tanpa diukur, beserta alasannya. Untuk melihat setiap permintaan saat terjadi, Anda bisa meminta log di stderr:

```bash
BVSALA_GATEWAY_LOG=1 npx @bivelio/savings-layer claude
```

atau menjalankan gateway di terminalnya sendiri, pada port tetap:

```bash
# Terminal 1: the gateway (Anthropic is the default upstream, port 8402)
npx @bivelio/savings-layer gateway

# Terminal 2: Claude Code, pointed at it (no /v1 at the end).
# ENABLE_TOOL_SEARCH=true only matters before Claude Code v2.1.304 (see below).
ENABLE_TOOL_SEARCH=true ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude
```

Setiap permintaan menjadi satu baris. Dua baris ini berasal dari uji lokal terhadap server pengganti, dengan lalu lintas rekaan, jadi bentuknya nyata tetapi angkanya bukan milik Anda:

```text
[gateway] POST /v1/messages  · claude-sonnet-5 · $0.007700 (in 40, cache↑3000 cache↓0, out 12)
[gateway] POST /v1/messages  · claude-sonnet-5 · $0.000800 (in 40, cache↑0 cache↓3000, out 12)
```

Bacalah dari kiri ke kanan: model, biaya dengan harga daftar standar model tersebut (giliran mode cepat adalah pengecualian, lihat di bawah), lalu token masukan yang ditagih penuh, token yang ditulis ke cache (`cache↑`), token yang dibaca dari cache (`cache↓`), dan token keluaran. Baris pertama adalah giliran dingin yang menulis prefiks; baris kedua membacanya kembali dengan sebagian kecil harganya. Sesi yang `cache↑`-nya tetap besar dari giliran ke giliran punya masalah cache: lihat [mengapa prompt caching Claude berhenti bekerja](/id/guides/claude-prompt-caching-not-working).

`ENABLE_TOOL_SEARCH=true` bergantung pada versi Claude Code Anda. Sejak v2.1.304, tool search tetap aktif di belakang gateway ([dokumentasi MCP Claude Code](https://code.claude.com/docs/en/mcp)), dan variabel ini tidak mengubah apa pun. Sebelum v2.1.304, Claude Code mematikan tool search di belakang base URL apa pun yang bukan milik Anthropic dan memasukkan setiap definisi alat ke setiap permintaan. Pada versi lama itu, hal ini mahal: panduan Claude Code milik gateway, yang disertakan dalam paket npm, mencatat sebuah setup dengan 226 alat MCP, diukur pada 9 September 2026, yang berarti 450 KB per permintaan dan seperempat tagihan hari itu. Wrapper `claude` mengatur variabel ini untuk Anda, kecuali Anda sudah mengaturnya sendiri.

## Apa yang dilihat gateway, dan apa yang tidak

- **Ia meneruskan apa yang dikirim Claude Code.** Selama tidak ada tuas yang bekerja pada sebuah permintaan, body-nya sampai ke Anthropic byte demi byte, termasuk penanda `cache_control` dan header `anthropic-beta`, sehingga caching bekerja persis seperti tanpa gateway. Sebuah tes di repositori memeriksa hal ini terhadap upstream palsu pada setiap perubahan.
- **Dua panggilan kecil tidak melewatinya.** Menurut [panduan kompatibilitas gateway](https://code.claude.com/docs/en/llm-gateway-protocol) Claude Code, pemeriksaan ketersediaan mode cepat (fast mode) dan pemeriksaan keamanan domain WebFetch memanggil `api.anthropic.com` secara langsung alih-alih mengikuti `ANTHROPIC_BASE_URL`. Keduanya bukan permintaan model: inferensi mode cepat itu sendiri mengikuti base URL dan melewati gateway.
- **Giliran mode cepat dicatat dengan harga standar.** Anthropic menandai permintaan mode cepat dengan `speed: "fast"` dan menagihnya dengan harga premium: US$8 untuk masukan dan US$40 untuk keluaran per juta token pada Claude Opus 5.5, dua kali tarif standar, ditambah pengali cache di atasnya ([dokumentasi fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode)). Gateway versi 1.2.3 tidak membaca `speed`, sehingga ia menghitung token-token itu dengan benar tetapi menghitung harganya sebagai giliran standar: pada Opus 5.5, separuh dari yang ditagih Anthropic. Jika Anda memakai `/fast`, total gateway untuk giliran tersebut terlalu rendah.
- **Lalu lintas langganan diukur, bukan ditagih.** Pada login Claude Pro atau Max tidak ada faktur per token; gateway menghitung lalu lintas itu dengan nilai setara harga daftar agar Anda bisa melihatnya, dan tidak mengkreditkan penghematan apa pun atasnya.

## Apakah gateway juga menghemat uang?

Secara bawaan, dengan Claude Code memakai kunci API, gateway ini mengukur dan tidak menghemat apa pun. Jangan anggap pesan startup versi 1.2.3 sebagai janji: pesan itu mengatakan semua tuas penghematan lokal aktif, dan ringkasan saat keluar hanya menghitung permintaan yang diukurnya, jadi tidak satu pun yang memberi tahu Anda bahwa penghematannya nol. Tuas bawaan gateway menurunkan masa hidup penulisan cache dari satu jam ke lima menit pada giliran ketika sebagian besar permintaan berisi konten baru, karena penulisan satu jam berharga dua kali harga masukan dan penulisan lima menit 1,25 kali. Claude Code dengan kunci API sudah meminta lima menit, kecuali Anda mengatur `promptCacheTtl` ke `1h`, jadi tidak ada yang perlu diturunkan.

Ketika cache satu jam dipakai, penghematannya kecil dan bergantung pada lalu lintas Anda. [Halaman benchmark](/id/benchmarks#gateway-ttl) memublikasikan replay lalu lintas Claude Code milik satu organisasi: neto **+2,49%** dari tagihan harga daftar (US$113,45 dari US$4.563,61), dengan interval 95% dari +1,50% hingga +3,57% bila di-resample per sesi, dan batas atas 7,2% untuk kebijakan apa pun dari jenis ini. Pada satu model hasilnya nyaris nol, dan pada satu periode justru merugi. Ini adalah replay dengan baseline yang sebagian direkonstruksi, bukan faktur, dan halaman itu mencantumkan setiap batasannya.

## Cek angka gateway terhadap tagihan Anda

1. **Terhadap `/usage`.** Untuk satu sesi, jumlahkan biaya per permintaan dari gateway dan bandingkan dengan blok Session di `/usage`. Keduanya menghitung biaya dari penghitung yang sama dengan harga daftar, jadi hasilnya seharusnya berdekatan, kecuali untuk giliran mode cepat, yang dihitung `/usage` dengan tarif cepat dan oleh gateway 1.2.3 dengan tarif standar.
2. **Terhadap Console.** Gunakan kunci API atau workspace khusus selama sehari, lalu bandingkan total gateway per model dengan halaman Usage di Console untuk kunci itu: masukan, keluaran, penulisan cache, dan pembacaan cache, dalam token terlebih dahulu, lalu dalam dolar.
3. **Jelaskan setiap selisih.** Harga daftar tidak selalu harga Anda: diskon kontrak, data residency, atau priority tier mengubah uangnya tetapi tidak mengubah jumlah token. Mode cepat juga begitu: dengan `/fast` aktif, total gateway lebih rendah daripada Console, karena 1.2.3 menghitung giliran mode cepat dengan tarif standar. Lalu lintas yang tidak melewati gateway ini, seperti mesin lain, skrip, atau job CI yang memakai kunci yang sama, hanya muncul di Console.

Jika jumlah token cocok tetapi dolarnya tidak, selisihnya ada pada harga, bukan pada pengukuran. Untuk metode lengkapnya, baca [cara memverifikasi penghematan LLM terhadap tagihan penyedia Anda](/id/guides/verify-llm-savings-against-provider-bill).

## Memangkas tagihan begitu Anda bisa melihatnya

Dengan angka per permintaan di depan mata, perbaikan yang biasa cukup sederhana: lakukan clear di antara tugas yang tidak berhubungan alih-alih membawa konteks panjang, pilih model sebelum sesi dan pertahankan, lakukan compact pada jeda yang alami, jauhkan log besar dari konteks, dan pangkas server MCP yang tidak Anda pakai. Memakai model penyedia lain di belakang Claude Code dibahas dalam [biaya API DeepSeek dan Qwen](/id/guides/deepseek-qwen-api-cost-local-gateway).

Kode sumber gateway, panduan Claude Code-nya, dan tes yang memastikan ia meneruskan permintaan Anda tanpa perubahan ada di [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
