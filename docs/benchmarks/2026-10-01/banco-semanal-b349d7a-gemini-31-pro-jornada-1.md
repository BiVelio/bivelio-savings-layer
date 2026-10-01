# Banco semanal — ✅ sin regresiones

Modo **VIVO** · fuente de main `b349d7a` (0.4.36, BVSALA_DEV_OPEN=1) · gasto **2.09 $** de 50.00 $ (asignados 44.20 $) · 2026-10-01T20:57:38.916Z → 2026-10-01T21:04:29.408Z

## Celdas

| Batería | Modelo | Estado | Gasto / tope | n | Métricas |
| --- | --- | --- | --- | --- | --- |
| gsm8k | google/gemini-3.1-pro-preview | aplazada (cuota diaria) | — | — | — |
| bfcl | google/gemini-3.1-pro-preview | medida | 0.94 $ / 1.10 $ | 48 | llamadas cambiadas 0 · capa-falla 0 · B−A -0.063 [-0.188, 0.063] · informe/factura -0.00 % |
| xstest | google/gemini-3.1-pro-preview | aplazada (cuota diaria) | — | — | — |
| mt-bench | google/gemini-3.1-pro-preview | medida (cortada por tope) | 1.15 $ / 1.50 $ | 9 | capa-falla 0 · victoria de B 0.500 [0.389, 0.639] · informe/factura 0.00 % |

## Factura real (criterio 4: ±2 %, ahorro nativo aparte)

- anthropic · tirada 2250b4 (2026-10-01T20:57:38.916Z → 2026-10-01T21:04:29.403Z) · **sin-gasto** · el banco no gastó nada facturado por este proveedor: nada que cuadrar
- openai · tirada 2250b4 (2026-10-01T20:57:38.916Z → 2026-10-01T21:04:29.403Z) · **sin-gasto** · el banco no gastó nada facturado por este proveedor: nada que cuadrar
- Google (Gemini): sin API de costes integrada (su factura sale de la exportación de facturación de Cloud); no se comprueba.

## Avisos (no hacen fallar)

- gsm8k · google/gemini-3.1-pro-preview: aplazada por cuota diaria — 250 peticiones al día para google/gemini-3.1-pro-preview: este banco mide su jornada 1 (bfcl, mt-bench); gsm8k va en la 2 (hasta 99 peticiones) — `--jornada 2` otro día
- xstest · google/gemini-3.1-pro-preview: aplazada por cuota diaria — 250 peticiones al día para google/gemini-3.1-pro-preview: este banco mide su jornada 1 (bfcl, mt-bench); xstest va en la 2 (hasta 96 peticiones) — `--jornada 2` otro día
- mt-bench · google/gemini-3.1-pro-preview: cortada por su tope tras 9 ítems (intervalo más ancho)

## Cómo leerlo

Cada celda es una batería publicada corrida con UN modelo, brazo A (proveedor directo) contra brazo B (la capa, desde el fuente de main). Las reglas y sus tolerancias están en `benchmarks/banco-semanal/umbrales.ts`; la guía entera, en `docs/BANCO-SEMANAL.md`. Los artefactos de cada arnés (JSON y Markdown) van en el artefacto `banco-semanal` de este run.
