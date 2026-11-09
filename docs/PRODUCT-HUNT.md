# Product Hunt — Kit de lanzamiento

Fecha objetivo: en cuanto la 1.1.0 esté en npm y PyPI (el corte de release exige
el banco semanal en vivo en verde, ~30 min). Este documento es la pieza que falta
para publicar en Product Hunt: la copia de la página y la lista de assets.

---

## La página (Product Hunt)

### Tagline (máx. ~60 caracteres)

> The savings layer for your LLM bill — audited per request, Apache-2.0.

### One-liner (subtítulo)

> Cut your LLM bill 30–75% and see exactly why, measured with your provider's own
> usage counter. Zero dependencies. Zero telemetry. One command for coding agents.

### Descripción (What it does)

> BV-SALA sits between your code (or your coding agent) and the LLM provider, and
> lets through only what has to be paid for. On every request it asks, in order:
> can I skip this call? can I send fewer tokens? can I place the prompt cache
> where it actually hits? can a cheaper model do it? Then it returns a
> SavingsReport with four separate ledgers — calls avoided, tokens eliminated,
> tokens compressed, tokens cached by the provider — each valued with your
> provider's own usage counter at versioned list prices.
>
> Install it in 60 seconds: `npm i @bivelio/savings-layer` (SDK), or
> `npx @bivelio/savings-layer claude` (gateway for Claude Code / Codex / Gemini
> CLI / Cursor / Goose / Aider).

### Por qué es diferente (el moat)

> Three things no one else does:
> 1. **Measured, not promised.** Every amount is labelled `measured` (provider
>    counter + published price), `reference`, or `estimated` — and estimates are
>    never billed. A wrong price is rejected by a guard, not by review.
> 2. **Four ledgers, never summed.** The industry's "40–95%" headlines mix
>    mechanisms; we keep them apart so the number can't inflate itself.
> 3. **Open core, zero telemetry.** Apache-2.0, no keys required, prompts never
>    reach BiVelio. The optional cloud is a flat fee — never a commission on your
>    savings.

### Categorías / temas

Developer Tools · Artificial Intelligence · Open Source · Productivity ·
Developer Tools → APIs · LLMs · Cost Optimization.

### Enlaces

- Website: https://savings.bivelio.com
- GitHub: https://github.com/BiVelio/bivelio-savings-layer
- npm: https://www.npmjs.com/package/@bivelio/savings-layer
- Paper: https://savings.bivelio.com/paper
- Public bench: https://savings.bivelio.com/benchmarks

---

## El «maker's first comment» (la historia)

> We built BV-SALA because our own LLM bill had a line we couldn't explain: we
> were paying to re-send context the model had already read, and the "save 50%"
> tools we tried never showed a receipt we could check. So we built the layer we
> wanted: it avoids the call when it can, trims what doesn't need to be paid for,
> and — the part we're most proud of — tells you the *basis* of every saving
> (measured vs estimated) instead of one marketing number.
>
> The open-core release (Apache-2.0) means you can install it with no key and no
> account. The paper (linked) publishes the numbers with confidence intervals and
> every limitation. Ask us anything — especially about why we keep "estimated"
> out of the invoice.

---

## Assets que faltan (por orden de impacto)

1. **Demo GIF / video corto** (el activo nº1 en PH): `npx @bivelio/savings-layer
   claude` en una terminal → el `SavingsReport` al salir. 20–30 s. Hay un
   **terminal SVG estático listo** (`docs/launch/demo-terminal.svg`) con la
   salida REAL del SDK como placeholder; para el GIF de verdad hace falta una
   grabadora:
   ```bash
   asciinema rec demo.cast   # o cualquier grabador de pantalla
   # y convertir:  asciinema-agg demo.cast demo.gif --theme monokai
   ```
2. **Logo / og:image** — ✅ **ya en vivo**: la og:image dinámica (1200×630,
   `next/og`) se sirve en `https://savings.bivelio.com/en/opengraph-image`
   (verificada HTTP 200, image/png). Product Hunt la toma automáticamente del
   sitio; no hay que crear una aparte.
3. **Screenshots** (máx. 5): (a) el dashboard con el banco público y su split por
   modelo; (b) el recibo de ahorro por request; (c) la tabla de precios; (d) el
   paper; (e) el `bvsala doctor` listando configuraciones.

## Checklist antes de publicar

- [ ] 1.1.0 publicada en npm y PyPI (las palancas de lote + audit + cascada 2026).
- [ ] `npm i @bivelio/savings-layer` y `npx @bivelio/savings-layer claude` probados
      en una máquina limpia (el «60 seconds» del README).
- [ ] Demo GIF grabado y subido (asset nº1).
- [ ] Logo/og:image compuesto (1024×512).
- [ ] Primer comentario escrito (arriba).
- [ ] Enlaces (GitHub/npm/paper/bench) vivos y sin 404.

## Métricas a seguir el día del lanzamiento

- Instalaciones/día (npm downloads) y `pip install` (PyPI).
- Estrellas/forks de GitHub.
- Upvotes + comentarios de Product Hunt (responder cada uno).
- Sesiones del gateway que activan la nube (conversión).
