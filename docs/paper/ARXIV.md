# Subir el paper a arXiv — guía paso a paso

El fuente (`main.tex`) es **arXiv-ready**: un solo fichero, solo paquetes estándar
de TeX Live, sin imágenes ni `.bib` (la bibliografía va con `thebibliography`).
El PDF compilado es `main.pdf` (12 páginas). Solo falta tu cuenta.

## 1 · Cuenta y endorsement (una sola vez)

1. Regístrate en https://arxiv.org/register (correo institucional o verificado).
2. Las categorías `cs.*` exigen **endorsement** de un autor ya establecido la
   primera vez. Al enviar, arXiv te pide elegir un endorser o te da el enlace
   para pedirlo; con el paper en la mano es un trámite rápido.

## 2 · Metadatos exactos (cópialos tal cual)

- **Title**:
  `BV-SALA Savings Layer: Verifiable Measurement of Cost Savings in Large Language Model Applications (Open-Core Edition)`
- **Author**: `Joan-Marc Fisa` (BiVelio Inc)
- **Abstract** (texto plano, sin LaTeX):

```
Cost claims for large language model (LLM) optimizations are only interpretable when the workload, the uncertainty, and the cost basis are stated explicitly. This paper evaluates BV-SALA Savings Layer — an in-process SDK and a local gateway that combine provider-reported usage with versioned list prices — in its open-core distribution, where the entire local saving stack runs with no license key, arms every local lever, and sends zero telemetry by default. We formalize the accounting object as a function from a request to a vector of four mutually exclusive, never-summed ledgers (avoided_calls, eliminated_tokens, compressed_tokens, provider_cached_tokens) and an evidence label in the lattice {measured, reference, estimated, unmeasured}; we give conditions under which the cost ratio decomposes additively over the ledgers (Proposition 1). Live double-runs under a paired design with percentile cluster bootstrap (10,000 resamples, family as the resampling unit) yield a 31.5% reduction (95% CI 25.7–36.7; 100 families, 200 requests per arm) on gpt-4o-mini, and 75.1% (95% CI 69.3–79.6; 31 families, 62 requests per arm) on claude-sonnet-5, of which approximately 41 percentage points are attributable to a prefix-cache effect enabled by cache_control in the instrumented arm rather than to a pre-existing provider discount. A counterfactual replay of 19,779 gateway requests (51 sessions, 13 days) estimates 2.49% (95% CI 1.50–3.57) and is reported as reference-valued, not measured. We add a routing-economics gradient at versioned list prices across DeepSeek, Qwen and GLM siblings, presented as conditional arithmetic rather than measured savings; a semantic-cache positioning against the published AWS benchmark and GPTCache; and a preregistered roadmap specifying the factorial and non-inferiority designs — now executed live: a cacheable-prefix reorder lifts a poisoned prompt cache from 0% to 95% hit-rate (an 82.8% per-request cost reduction), a 2x2 dedup x cache_control factorial yields an 85.9% total reduction with measured attribution, and a cascade non-inferiority run cuts cost 67.9% with no quality loss on a golden list. No invoice reconciliation is claimed; every number is reproducible from public artifacts.
```

- **Comments**: `12 pages. Technical report; open-core software at https://savings.bivelio.com (Apache-2.0).`
- **Categorías**: primaria `cs.LG` (Machine Learning), secundarias `cs.SE` (Software Engineering) y `econ.GN` (General Economics).
- **License**: arXiv default (non-exclusive) — el código del producto es Apache-2.0, el texto del paper es tuyo.

## 3 · Subida

1. https://arxiv.org/submit → «Start new submission».
2. **Archivo**: sube `docs/paper/main.tex` tal cual (un solo fichero; no hace
   falta PDF — arXiv lo compila él con su TeX Live).
3. Pega los metadatos de arriba.
4. Procesa y aprueba el PDF de arXiv (revisa la página 1 y que «Introduction»
   caiga en la página 2, como en `main.pdf`).
5. Anota el ID `arXiv:XXXX.NNNNN` y ponlo en la cabecera del paper
   (`\date{…}` + una línea «This is an extended version of arXiv:XXXX.NNNNN»
   cuando toque).

## 4 · Recompilar tras cualquier cambio

```bash
pdflatex main.tex && pdflatex main.tex   # en docs/paper/
```

El workflow `compilar-paper.yml` también compila el PDF en CI y lo deja como
artefacto (`bv-sala-paper`).
