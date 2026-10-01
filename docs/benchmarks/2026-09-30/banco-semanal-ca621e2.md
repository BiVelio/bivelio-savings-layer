# Banco semanal — ❌ REGRESIÓN o banco incompleto

Modo **VIVO** · fuente de main `ca621e2` (0.4.35, BVSALA_DEV_OPEN=1) · gasto **25.52 $** de 50.00 $ (asignados 44.20 $) · 2026-09-30T20:18:16.482Z → 2026-09-30T22:07:43.159Z

## Lo que hace fallar el banco

- **exactitud-peor** · bfcl · openai/gpt-5.4-mini: exactitud AST (B − A), brazo B: -0.040 IC95 [-0.080, -0.010]
- **capa-falla** · bfcl · google/gemini-3.1-pro-preview: 2 errores solo con la capa: parallel_multiple_133: TimeoutError: The operation was aborted due to timeout · parallel_196: TimeoutError: The operation was aborted due to timeout
- **capa-falla** · xstest · google/gemini-3.8-flash: 1 errores solo con la capa: prompt 5: HTTP 400: INVALID_ARGUMENT
- **arnes-falla** · xstest · google/gemini-3.1-pro-preview: plazo de 75 min agotado

## Celdas

| Batería | Modelo | Estado | Gasto / tope | n | Métricas |
| --- | --- | --- | --- | --- | --- |
| gsm8k | openai/gpt-4o-mini | medida | 0.13 $ / 0.75 $ | 200 | otra pregunta 0 · capa-falla 0 · B−A 0.000 [-0.016, 0.017] · informe/factura 0.00 % |
| gsm8k | openai/gpt-5.4-mini | medida | 0.41 $ / 0.75 $ | 104 | otra pregunta 0 · capa-falla 0 · B−A -0.011 [-0.035, 0.000] · informe/factura 0.00 % |
| gsm8k | openai/gpt-5.5 | medida | 0.70 $ / 1.25 $ | 22 | otra pregunta 0 · capa-falla 0 · B−A 0.000 [0.000, 0.000] · informe/factura 0.00 % |
| gsm8k | openai/gpt-5.6-sol | medida | 0.31 $ / 1.25 $ | 34 | otra pregunta 0 · capa-falla 0 · B−A 0.000 [0.000, 0.000] · informe/factura 0.00 % |
| gsm8k | anthropic/claude-haiku-4-5 | medida | 0.42 $ / 0.75 $ | 70 | otra pregunta 0 · capa-falla 0 · B−A -0.016 [-0.043, 0.000] · informe/factura 0.00 % |
| gsm8k | anthropic/claude-sonnet-5 | medida | 0.48 $ / 1.10 $ | 52 | otra pregunta 0 · capa-falla 0 · B−A -0.021 [-0.074, 0.000] · informe/factura 0.00 % |
| gsm8k | anthropic/claude-sonnet-5-5 | medida | 0.46 $ / 1.10 $ | 56 | otra pregunta 0 · capa-falla 0 · B−A 0.000 [0.000, 0.000] · informe/factura 0.00 % |
| gsm8k | anthropic/claude-opus-5-5 | medida | 0.54 $ / 1.25 $ | 30 | otra pregunta 0 · capa-falla 0 · B−A 0.000 [0.000, 0.000] · informe/factura -0.00 % |
| gsm8k | google/gemini-3.8-flash | medida | 0.41 $ / 0.75 $ | 70 | otra pregunta 0 · capa-falla 0 · B−A 0.016 [0.000, 0.043] · informe/factura 0.00 % |
| gsm8k | google/gemini-3.1-pro-preview | medida | 0.64 $ / 1.10 $ | 24 | otra pregunta 0 · capa-falla 0 · B−A 0.000 [0.000, 0.000] · informe/factura 0.00 % |
| bfcl | openai/gpt-4o-mini | medida | 0.03 $ / 0.75 $ | 100 | llamadas cambiadas 0 · capa-falla 0 · B−A 0.000 [0.000, 0.000] · informe/factura 0.00 % |
| bfcl | openai/gpt-5.4-mini | medida | 0.15 $ / 0.75 $ | 100 | llamadas cambiadas 0 · capa-falla 0 · B−A -0.040 [-0.080, -0.010] · informe/factura 0.00 % |
| bfcl | openai/gpt-5.5 | medida | 0.27 $ / 1.25 $ | 32 | llamadas cambiadas 0 · capa-falla 0 · B−A 0.000 [-0.094, 0.094] · informe/factura 0.00 % |
| bfcl | openai/gpt-5.6-sol | medida | 0.18 $ / 1.25 $ | 32 | llamadas cambiadas 0 · capa-falla 0 · B−A -0.063 [-0.156, 0.000] · informe/factura 0.00 % |
| bfcl | anthropic/claude-haiku-4-5 | medida | 0.59 $ / 0.75 $ | 100 | llamadas cambiadas 0 · capa-falla 0 · B−A 0.000 [0.000, 0.000] · informe/factura 0.00 % |
| bfcl | anthropic/claude-sonnet-5 | medida | 0.72 $ / 1.10 $ | 48 | llamadas cambiadas 0 · capa-falla 0 · B−A 0.000 [0.000, 0.000] · informe/factura 0.00 % |
| bfcl | anthropic/claude-sonnet-5-5 | medida | 0.63 $ / 1.10 $ | 48 | llamadas cambiadas 0 · capa-falla 0 · B−A -0.021 [-0.063, 0.000] · informe/factura 0.00 % |
| bfcl | anthropic/claude-opus-5-5 | medida | 0.47 $ / 1.25 $ | 32 | llamadas cambiadas 0 · capa-falla 0 · B−A 0.000 [0.000, 0.000] · informe/factura 0.00 % |
| bfcl | google/gemini-3.8-flash | medida | 0.45 $ / 0.75 $ | 100 | llamadas cambiadas 0 · capa-falla 0 · B−A -0.020 [-0.050, 0.000] · informe/factura 0.00 % |
| bfcl | google/gemini-3.1-pro-preview | medida | 0.87 $ / 1.10 $ | 45 | llamadas cambiadas 0 · capa-falla 2 · B−A 0.000 [-0.067, 0.067] · informe/factura 0.00 % |
| xstest | openai/gpt-4o-mini | medida | 0.06 $ / 0.75 $ | 450 | negativas cacheadas 0 · acreditadas 0 · capa-falla 0 · B−A 0.000 p=1.0 · informe/factura 0.00 % |
| xstest | openai/gpt-5.4-mini | medida (cortada por tope) | 0.75 $ / 0.75 $ | 414 | negativas cacheadas 0 · acreditadas 0 · capa-falla 0 · B−A 0.017 p=0.42 · informe/factura 0.00 % |
| xstest | openai/gpt-5.5 | medida | 0.98 $ / 1.25 $ | 100 | negativas cacheadas 0 · acreditadas 0 · capa-falla 0 · B−A 0.000 p=1.0 · informe/factura 0.00 % |
| xstest | openai/gpt-5.6-sol | medida | 0.63 $ / 1.25 $ | 100 | negativas cacheadas 0 · acreditadas 0 · capa-falla 0 · B−A 0.000 p=1.0 · informe/factura 0.00 % |
| xstest | anthropic/claude-haiku-4-5 | medida | 0.64 $ / 0.75 $ | 450 | negativas cacheadas 0 · acreditadas 0 · capa-falla 0 · B−A 0.000 p=1.0 · informe/factura 0.00 % |
| xstest | anthropic/claude-sonnet-5 | medida | 0.88 $ / 1.10 $ | 200 | negativas cacheadas 0 · acreditadas 0 · capa-falla 0 · B−A -0.009 p=1.0 · informe/factura 0.00 % |
| xstest | anthropic/claude-sonnet-5-5 | medida | 0.80 $ / 1.10 $ | 200 | negativas cacheadas 0 · acreditadas 0 · capa-falla 0 · B−A 0.011 p=1.0 · informe/factura 0.00 % |
| xstest | anthropic/claude-opus-5-5 | medida (cortada por tope) | 0.82 $ / 1.25 $ | 83 | negativas cacheadas 0 · acreditadas 0 · capa-falla 0 · B−A 0.000 p=1.0 · informe/factura 0.00 % |
| xstest | google/gemini-3.8-flash | medida | 0.51 $ / 0.75 $ | 450 | negativas cacheadas 0 · acreditadas 0 · capa-falla 1 · B−A 0.000 p=1.0 · informe/factura 0.00 % |
| xstest | google/gemini-3.1-pro-preview | **arnés falló** | ? / 1.10 $ | — | — |
| mt-bench | openai/gpt-4o-mini | medida | 0.41 $ / 1.15 $ | 40 | capa-falla 0 · victoria de B 0.462 [0.385, 0.538] · informe/factura -0.00 % |
| mt-bench | openai/gpt-5.4-mini | medida | 0.67 $ / 1.15 $ | 40 | capa-falla 0 · victoria de B 0.467 [0.367, 0.567] · informe/factura 0.00 % |
| mt-bench | openai/gpt-5.5 | medida (cortada por tope) | 0.62 $ / 1.65 $ | 7 | capa-falla 0 · victoria de B 0.429 [0.286, 0.500] · informe/factura 0.00 % |
| mt-bench | openai/gpt-5.6-sol | medida (cortada por tope) | 0.99 $ / 1.65 $ | 13 | capa-falla 0 · victoria de B 0.500 [0.423, 0.577] · informe/factura 0.00 % |
| mt-bench | anthropic/claude-haiku-4-5 | medida | 0.79 $ / 1.15 $ | 40 | capa-falla 0 · victoria de B 0.406 [0.297, 0.516] · informe/factura 0.00 % |
| mt-bench | anthropic/claude-sonnet-5 | medida (cortada por tope) | 1.18 $ / 1.50 $ | 19 | capa-falla 0 · victoria de B 0.462 [0.365, 0.577] · informe/factura 0.00 % |
| mt-bench | anthropic/claude-sonnet-5-5 | medida | 1.14 $ / 1.50 $ | 24 | capa-falla 0 · victoria de B 0.484 [0.422, 0.547] · informe/factura -0.00 % |
| mt-bench | anthropic/claude-opus-5-5 | medida | 1.38 $ / 1.65 $ | 16 | capa-falla 0 · victoria de B 0.469 [0.359, 0.578] · informe/factura 0.00 % |
| mt-bench | google/gemini-3.8-flash | medida (cortada por tope) | 1.05 $ / 1.15 $ | 31 | capa-falla 0 · victoria de B 0.500 [0.417, 0.604] · informe/factura 0.00 % |
| mt-bench | google/gemini-3.1-pro-preview | medida (cortada por tope) | 1.26 $ / 1.50 $ | 10 | capa-falla 0 · victoria de B 0.475 [0.400, 0.550] · informe/factura 0.00 % |

## Factura real (criterio 4: ±2 %, ahorro nativo aparte)

- anthropic · tirada ab5ea3 (2026-09-30T20:18:16.482Z → 2026-09-30T22:07:43.154Z) · **sin-clave** · factura real no comprobada (sin clave de administrador: ANTHROPIC_ADMIN_API_KEY)
- openai · tirada ab5ea3 (2026-09-30T20:18:16.482Z → 2026-09-30T22:07:43.154Z) · **sin-clave** · factura real no comprobada (sin clave de administrador: OPENAI_ADMIN_API_KEY)
- Google (Gemini): sin API de costes integrada (su factura sale de la exportación de facturación de Cloud); no se comprueba.

## Avisos (no hacen fallar)

- xstest · openai/gpt-5.4-mini: cortada por su tope tras 414 ítems (intervalo más ancho)
- xstest · anthropic/claude-opus-5-5: cortada por su tope tras 83 ítems (intervalo más ancho)
- mt-bench · openai/gpt-5.5: cortada por su tope tras 7 ítems (intervalo más ancho)
- mt-bench · openai/gpt-5.6-sol: cortada por su tope tras 13 ítems (intervalo más ancho)
- mt-bench · anthropic/claude-sonnet-5: cortada por su tope tras 19 ítems (intervalo más ancho)
- mt-bench · google/gemini-3.8-flash: cortada por su tope tras 31 ítems (intervalo más ancho)
- mt-bench · google/gemini-3.1-pro-preview: cortada por su tope tras 10 ítems (intervalo más ancho)
- anthropic · tirada ab5ea3 (2026-09-30T20:18:16.482Z → 2026-09-30T22:07:43.154Z) · **sin-clave** · factura real no comprobada (sin clave de administrador: ANTHROPIC_ADMIN_API_KEY)
- openai · tirada ab5ea3 (2026-09-30T20:18:16.482Z → 2026-09-30T22:07:43.154Z) · **sin-clave** · factura real no comprobada (sin clave de administrador: OPENAI_ADMIN_API_KEY)

## Cómo leerlo

Cada celda es una batería publicada corrida con UN modelo, brazo A (proveedor directo) contra brazo B (la capa, desde el fuente de main). Las reglas y sus tolerancias están en `benchmarks/banco-semanal/umbrales.ts`; la guía entera, en `docs/BANCO-SEMANAL.md`. Los artefactos de cada arnés (JSON y Markdown) van en el artefacto `banco-semanal` de este run.
