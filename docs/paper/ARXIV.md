# Subir el paper a arXiv — guía paso a paso

El fuente (`main.tex`) es **arXiv-ready**: un solo fichero, solo paquetes estándar
de TeX Live, sin imágenes ni `.bib` (la bibliografía va con `thebibliography`).
El PDF compilado es `main.pdf` (15 páginas; portada con título, autores, abstract
y keywords, Introducción en la página 2). Solo falta tu cuenta.

## 1 · Cuenta y endorsement (una sola vez)

1. Regístrate en https://arxiv.org/register (correo institucional o verificado).
2. Las categorías `cs.*` exigen **endorsement** de un autor ya establecido la
   primera vez. Al enviar, arXiv te pide elegir un endorser o te da el enlace
   para pedirlo; con el paper en la mano es un trámite rápido.

## 2 · Metadatos exactos (cópialos tal cual)

- **Title**:
  `BV-SALA Savings Layer: Verifiable Measurement of Cost Savings in Large Language Model Applications (Open-Core Edition)`
- **Author**: `Joan-Marc Fisa` (BiVelio Inc)
- **Abstract** (texto plano, sin LaTeX; es el mismo que el `\begin{abstract}` de `main.tex`, 1.444 caracteres, por debajo del tope de 1.920 de arXiv):

```
Cost claims for large language model (LLM) applications require an explicit workload, cost basis and counterfactual. BV-SALA is an open-core SDK and gateway integrating established optimization mechanisms with usage accounting. We specify provider usage as disjoint billable categories, distinguish observed costs from reference-valued and estimated counterfactuals, and separate mechanism diagnostics from experimental attribution. Recomputing public September 2026 artifacts yields a pooled list-price cost reduction of 31.50% (percentile family bootstrap interval 25.74-36.75%) on gpt-4o-mini, and 75.08% (69.31-79.60%) on claude-sonnet-5. The corresponding equal-family means are 22.88% and 70.71%; these answer different questions. Approximately 41.08 percentage points of the Anthropic pooled result correspond to a descriptive net cache-pricing contrast, not an independently identified causal effect. Additional public November summaries report cost reductions from prefix reordering, response reuse and a model cascade; these are exploratory and do not establish quality non-inferiority. We identify explicit limits of line-based prefix reordering, replay equivalence and permissive answer matching. The contribution is a measurement and reproducibility framework, with results bounded to the published workloads and prices. No invoice reconciliation, general semantic-preservation guarantee or independent live replication is claimed.
```

- **Comments**: `15 pages. Technical report; open-core software at https://savings.bivelio.com (Apache-2.0).`
- **Categorías**: primaria **`cs.SE`** (Software Engineering — la contribución es un
  marco de medición y reproducibilidad dentro de un SDK/gateway); secundarias
  **`cs.LG`** (Machine Learning — economía de coste de LLMs y análisis bootstrap)
  y **`econ.GN`** (General Economics — contabilidad de costes y precios de lista).
- **License**: recomendada **CC BY 4.0**, la misma que el depósito de Zenodo (`.zenodo.json`). En arXiv la licencia no se puede retirar después; la alternativa es «arXiv non-exclusive license». El código del producto sigue siendo Apache-2.0.
- **Calendario**: arXiv cierra la recepción a las 14:00 de Nueva York (20:00 en Andorra) de lunes a viernes y anuncia a las 20:00 de Nueva York de domingo a jueves. Lo enviado un jueves antes de las 20:00 de Andorra se anuncia esa noche (las 02:00 del viernes en Andorra); lo enviado el viernes no se anuncia hasta el lunes por la noche. Un primer envío en `cs.*` sin endorsement o una retención de moderación lo retrasan.

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
