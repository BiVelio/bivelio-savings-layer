# Banco semanal — ❌ REGRESIÓN o banco incompleto

Modo **VIVO** · fuente de main `105fe13` (0.4.32, BVSALA_DEV_OPEN=1) · gasto **13.74 $** de 50.00 $ (asignados 41.70 $) · 2026-09-29T17:13:05.312Z → 2026-09-29T17:45:33.194Z

## Lo que hace fallar el banco

- **negativa-acreditada** · xstest · openai/gpt-4o-mini: 1 negativas con ahorro acreditado o registro de referencia
- **negativa-cacheada** · xstest · openai/gpt-5.4-mini: 3 negativas servidas desde la caché o escritas en ella
- **negativa-acreditada** · xstest · openai/gpt-5.4-mini: 3 negativas con ahorro acreditado o registro de referencia
- **negativa-cacheada** · xstest · openai/gpt-5.6-sol: 6 negativas servidas desde la caché o escritas en ella
- **negativa-acreditada** · xstest · openai/gpt-5.6-sol: 6 negativas con ahorro acreditado o registro de referencia
- **negativa-cacheada** · xstest · anthropic/claude-haiku-4-5: 3 negativas servidas desde la caché o escritas en ella
- **negativa-acreditada** · xstest · anthropic/claude-haiku-4-5: 4 negativas con ahorro acreditado o registro de referencia

## Celdas

| Batería | Modelo | Estado | Gasto / tope | n | Métricas |
| --- | --- | --- | --- | --- | --- |
| gsm8k | openai/gpt-4o-mini | medida | 0.13 $ / 0.75 $ | 200 | otra pregunta 0 · capa-falla 0 · B−A 0.017 [0.000, 0.047] · informe/factura 0.00 % |
| gsm8k | openai/gpt-5.4-mini | medida | 0.41 $ / 0.75 $ | 104 | otra pregunta 0 · capa-falla 0 · B−A 0.011 [0.000, 0.035] · informe/factura 0.00 % |
| gsm8k | openai/gpt-5.5 | medida | 0.70 $ / 1.25 $ | 22 | otra pregunta 0 · capa-falla 0 · B−A 0.000 [0.000, 0.000] · informe/factura 0.00 % |
| gsm8k | openai/gpt-5.6-sol | medida | 0.31 $ / 1.25 $ | 34 | otra pregunta 0 · capa-falla 0 · B−A 0.000 [0.000, 0.000] · informe/factura 0.00 % |
| gsm8k | anthropic/claude-haiku-4-5 | medida | 0.42 $ / 0.75 $ | 70 | otra pregunta 0 · capa-falla 0 · B−A -0.016 [-0.043, 0.000] · informe/factura 0.00 % |
| gsm8k | anthropic/claude-sonnet-5 | medida | 0.50 $ / 1.10 $ | 54 | otra pregunta 0 · capa-falla 0 · B−A 0.000 [0.000, 0.000] · informe/factura 0.00 % |
| gsm8k | anthropic/claude-sonnet-5-5 | medida | 0.47 $ / 1.10 $ | 56 | otra pregunta 0 · capa-falla 0 · B−A 0.000 [0.000, 0.000] · informe/factura 0.00 % |
| gsm8k | anthropic/claude-opus-5-5 | medida | 0.55 $ / 1.25 $ | 32 | otra pregunta 0 · capa-falla 0 · B−A -0.033 [-0.115, 0.000] · informe/factura 0.00 % |
| gsm8k | google/gemini-3.8-flash | no medible (sin clave) | — | — | — |
| gsm8k | google/gemini-3.1-pro-preview | no medible (sin clave) | — | — | — |
| bfcl | openai/gpt-4o-mini | medida | 0.03 $ / 0.75 $ | 100 | llamadas cambiadas 0 · capa-falla 0 · B−A 0.010 [0.000, 0.030] · informe/factura 0.00 % |
| bfcl | openai/gpt-5.4-mini | medida | 0.15 $ / 0.75 $ | 100 | llamadas cambiadas 0 · capa-falla 0 · B−A 0.010 [-0.020, 0.040] · informe/factura 0.00 % |
| bfcl | openai/gpt-5.5 | medida | 0.28 $ / 1.25 $ | 32 | llamadas cambiadas 0 · capa-falla 0 · B−A 0.000 [-0.094, 0.094] · informe/factura 0.00 % |
| bfcl | openai/gpt-5.6-sol | no medible | 0.00 $ / 1.25 $ | 0 | — |
| bfcl | anthropic/claude-haiku-4-5 | medida | 0.59 $ / 0.75 $ | 100 | llamadas cambiadas 0 · capa-falla 0 · B−A 0.000 [0.000, 0.000] · informe/factura 0.00 % |
| bfcl | anthropic/claude-sonnet-5 | medida | 0.73 $ / 1.10 $ | 48 | llamadas cambiadas 0 · capa-falla 0 · B−A 0.000 [-0.083, 0.083] · informe/factura 0.00 % |
| bfcl | anthropic/claude-sonnet-5-5 | medida | 0.63 $ / 1.10 $ | 48 | llamadas cambiadas 0 · capa-falla 0 · B−A 0.000 [0.000, 0.000] · informe/factura 0.00 % |
| bfcl | anthropic/claude-opus-5-5 | medida | 0.47 $ / 1.25 $ | 32 | llamadas cambiadas 0 · capa-falla 0 · B−A 0.000 [0.000, 0.000] · informe/factura 0.00 % |
| bfcl | google/gemini-3.8-flash | sin soporte | — | — | — |
| bfcl | google/gemini-3.1-pro-preview | sin soporte | — | — | — |
| xstest | openai/gpt-4o-mini | medida | 0.06 $ / 0.75 $ | 450 | negativas cacheadas 0 · acreditadas 1 · capa-falla 0 · B−A 0.000 p=1.0 · informe/factura 0.00 % |
| xstest | openai/gpt-5.4-mini | medida (cortada por tope) | 0.75 $ / 0.75 $ | 413 | negativas cacheadas 3 · acreditadas 3 · capa-falla 0 · B−A 0.000 p=1.0 · informe/factura 0.00 % |
| xstest | openai/gpt-5.5 | medida | 0.97 $ / 1.25 $ | 100 | negativas cacheadas 0 · acreditadas 0 · capa-falla 0 · B−A 0.000 p=1.0 · informe/factura 0.00 % |
| xstest | openai/gpt-5.6-sol | medida | 0.62 $ / 1.25 $ | 100 | negativas cacheadas 6 · acreditadas 6 · capa-falla 0 · B−A 0.000 p=1.0 · informe/factura 0.00 % |
| xstest | anthropic/claude-haiku-4-5 | medida | 0.64 $ / 0.75 $ | 450 | negativas cacheadas 3 · acreditadas 4 · capa-falla 0 · B−A 0.000 p=1.0 · informe/factura 0.00 % |
| xstest | anthropic/claude-sonnet-5 | medida | 0.88 $ / 1.10 $ | 200 | negativas cacheadas 0 · acreditadas 0 · capa-falla 0 · B−A 0.000 p=1.0 · informe/factura 0.00 % |
| xstest | anthropic/claude-sonnet-5-5 | medida | 0.80 $ / 1.10 $ | 200 | negativas cacheadas 0 · acreditadas 0 · capa-falla 0 · B−A 0.000 p=1.0 · informe/factura 0.00 % |
| xstest | anthropic/claude-opus-5-5 | medida (cortada por tope) | 0.82 $ / 1.25 $ | 82 | negativas cacheadas 0 · acreditadas 0 · capa-falla 0 · B−A -0.012 p=1.0 · informe/factura 0.00 % |
| xstest | google/gemini-3.8-flash | no medible (sin clave) | — | — | — |
| xstest | google/gemini-3.1-pro-preview | no medible (sin clave) | — | — | — |
| mt-bench | openai/gpt-4o-mini | medida | 0.08 $ / 0.90 $ | 40 | capa-falla 0 · victoria de B 0.500 [0.500, 0.500] · informe/factura -0.00 % |
| mt-bench | openai/gpt-5.4-mini | medida | 0.33 $ / 0.90 $ | 40 | capa-falla 0 · victoria de B 0.500 [0.500, 0.500] · informe/factura 0.00 % |
| mt-bench | openai/gpt-5.5 | sin soporte | — | — | — |
| mt-bench | openai/gpt-5.6-sol | sin soporte | — | — | — |
| mt-bench | anthropic/claude-haiku-4-5 | medida | 0.44 $ / 0.90 $ | 40 | capa-falla 0 · victoria de B 0.500 [0.500, 0.500] · informe/factura 0.00 % |
| mt-bench | anthropic/claude-sonnet-5 | medida (cortada por tope) | 1.00 $ / 1.25 $ | 21 | capa-falla 0 · victoria de B 0.500 [0.500, 0.500] · informe/factura 0.00 % |
| mt-bench | anthropic/claude-sonnet-5-5 | sin soporte | — | — | — |
| mt-bench | anthropic/claude-opus-5-5 | sin soporte | — | — | — |
| mt-bench | google/gemini-3.8-flash | sin soporte | — | — | — |
| mt-bench | google/gemini-3.1-pro-preview | sin soporte | — | — | — |

## Avisos (no hacen fallar)

- gsm8k · google/gemini-3.8-flash: no medible — sin BVSALA_DEMO_GOOGLE_API_KEY en el entorno
- gsm8k · google/gemini-3.1-pro-preview: no medible — sin BVSALA_DEMO_GOOGLE_API_KEY en el entorno
- bfcl · openai/gpt-5.6-sol: no medible — ninguna respuesta válida del proveedor en el brazo A
- bfcl · google/gemini-3.8-flash: sin soporte en el arnés — BFCL solo habla con api.anthropic.com y api.openai.com
- bfcl · google/gemini-3.1-pro-preview: sin soporte en el arnés — BFCL solo habla con api.anthropic.com y api.openai.com
- xstest · openai/gpt-5.4-mini: cortada por su tope tras 413 ítems (intervalo más ancho)
- xstest · anthropic/claude-opus-5-5: cortada por su tope tras 82 ítems (intervalo más ancho)
- xstest · google/gemini-3.8-flash: no medible — sin BVSALA_DEMO_GOOGLE_API_KEY en el entorno
- xstest · google/gemini-3.1-pro-preview: no medible — sin BVSALA_DEMO_GOOGLE_API_KEY en el entorno
- mt-bench · openai/gpt-5.5: sin soporte en el arnés — MT-Bench no tiene gpt-5.5 en MODELOS_POR_DEFECTO (nucleo.ts)
- mt-bench · openai/gpt-5.6-sol: sin soporte en el arnés — MT-Bench no tiene gpt-5.6-sol en MODELOS_POR_DEFECTO (nucleo.ts)
- mt-bench · anthropic/claude-sonnet-5: cortada por su tope tras 21 ítems (intervalo más ancho)
- mt-bench · anthropic/claude-sonnet-5-5: sin soporte en el arnés — MT-Bench no tiene claude-sonnet-5-5 en MODELOS_POR_DEFECTO (nucleo.ts)
- mt-bench · anthropic/claude-opus-5-5: sin soporte en el arnés — MT-Bench no tiene claude-opus-5-5 en MODELOS_POR_DEFECTO (nucleo.ts)
- mt-bench · google/gemini-3.8-flash: sin soporte en el arnés — MT-Bench no tiene gemini-3.8-flash en MODELOS_POR_DEFECTO (nucleo.ts)
- mt-bench · google/gemini-3.1-pro-preview: sin soporte en el arnés — MT-Bench no tiene gemini-3.1-pro-preview en MODELOS_POR_DEFECTO (nucleo.ts)

## Cómo leerlo

Cada celda es una batería publicada corrida con UN modelo, brazo A (proveedor directo) contra brazo B (la capa, desde el fuente de main). Las reglas y sus tolerancias están en `benchmarks/banco-semanal/umbrales.ts`; la guía entera, en `docs/BANCO-SEMANAL.md`. Los artefactos de cada arnés (JSON y Markdown) van en el artefacto `banco-semanal` de este run.
