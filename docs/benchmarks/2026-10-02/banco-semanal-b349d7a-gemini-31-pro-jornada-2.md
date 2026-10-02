# Banco semanal — ✅ sin regresiones

Modo **VIVO** · fuente de main `b349d7a` (0.4.36, BVSALA_DEV_OPEN=1) · gasto **0.99 $** de 50.00 $ (asignados 44.20 $) · 2026-10-02T07:12:51.793Z → 2026-10-02T07:18:12.267Z

## Celdas

| Batería | Modelo | Estado | Gasto / tope | n | Métricas |
| --- | --- | --- | --- | --- | --- |
| gsm8k | google/gemini-3.1-pro-preview | medida | 0.49 $ / 1.10 $ | 20 | otra pregunta 0 · capa-falla 0 · B−A 0.000 [0.000, 0.000] · informe/factura 0.00 % |
| bfcl | google/gemini-3.1-pro-preview | aplazada (cuota diaria) | — | — | — |
| xstest | google/gemini-3.1-pro-preview | medida | 0.50 $ / 1.10 $ | 24 | negativas cacheadas 0 · acreditadas 0 · capa-falla 0 · B−A 0.000 p=1.0 · informe/factura 0.00 % |
| mt-bench | google/gemini-3.1-pro-preview | aplazada (cuota diaria) | — | — | — |

## Factura real (criterio 4: ±2 %, ahorro nativo aparte)

- anthropic · tirada ccd7cf (2026-10-02T07:12:51.793Z → 2026-10-02T07:18:12.261Z) · **sin-gasto** · el banco no gastó nada facturado por este proveedor: nada que cuadrar
- openai · tirada ccd7cf (2026-10-02T07:12:51.793Z → 2026-10-02T07:18:12.261Z) · **sin-gasto** · el banco no gastó nada facturado por este proveedor: nada que cuadrar
- Google (Gemini): sin API de costes integrada (su factura sale de la exportación de facturación de Cloud); no se comprueba.

## Avisos (no hacen fallar)

- bfcl · google/gemini-3.1-pro-preview: aplazada por cuota diaria — 250 peticiones al día para google/gemini-3.1-pro-preview: este banco mide su jornada 2 (gsm8k, xstest); bfcl va en la 1 (hasta 126 peticiones) — `--jornada 1` otro día
- mt-bench · google/gemini-3.1-pro-preview: aplazada por cuota diaria — 250 peticiones al día para google/gemini-3.1-pro-preview: este banco mide su jornada 2 (gsm8k, xstest); mt-bench va en la 1 (hasta 64 peticiones) — `--jornada 1` otro día

## Cómo leerlo

Cada celda es una batería publicada corrida con UN modelo, brazo A (proveedor directo) contra brazo B (la capa, desde el fuente de main). Las reglas y sus tolerancias están en `benchmarks/banco-semanal/umbrales.ts`; la guía entera, en `docs/BANCO-SEMANAL.md`. Los artefactos de cada arnés (JSON y Markdown) van en el artefacto `banco-semanal` de este run.
