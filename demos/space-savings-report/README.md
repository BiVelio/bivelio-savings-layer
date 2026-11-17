---
title: BV-SALA · SavingsReport demo
emoji: 📉
colorFrom: blue
colorTo: gray
sdk: static


pinned: false
license: apache-2.0
---

# BV-SALA · SavingsReport — measured, not promised

Demo estática del informe de ahorro de BV-SALA con **muestras reales de los
artefactos públicos** (`benchmarks/evidencia`): el A/B del reorden del prefijo
cacheable (−82,76 % por petición), el factorial dedup × cache_control
(−85,94 %), el piloto de cascada (−67,91 %) y la curva ρ. Sin claves, sin
coste, sin telemetría.

- **Producto**: [github.com/BiVelio/bivelio-savings-layer](https://github.com/BiVelio/bivelio-savings-layer) (open-core, Apache-2.0)
- **Paper v2.3-r1**: [savings.bivelio.com/paper](https://savings.bivelio.com/paper) · DOI [10.5281/zenodo.24278852](https://doi.org/10.5281/zenodo.24278852)
- **Artefactos**: `benchmarks/evidencia/*.json` del repositorio

Cada cifra está medida con el contador del proveedor a precios de lista; los
cuatro libros (`avoided_calls`, `eliminated_tokens`, `compressed_tokens`,
`provider_cached_tokens`) nunca se suman, y cada figura lleva su `basis`.
