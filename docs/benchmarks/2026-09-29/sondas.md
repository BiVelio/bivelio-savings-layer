# Sondas en vivo — 2026-09-29

Modo **vivo** · capa 0.4.32 (fuente de origin/main (0.4.32, con #401 #402 #403) vía tsx, BVSALA_DEV_OPEN=1) · commit `71c4509` · tope de la última tirada 0.5 $ (tope duro en código: 5 $) · **gasto de las sondas que quedan en el informe 0.6299 $** (usage × tarifa de lista, sumando con y sin capa).

Este informe junta 3 tiradas (bucle: 0.5629 $ · busqueda+diagnostico+gemini+gpt: 0.0664 $ · busqueda+gemini: 0.0452 $); **gasto real acumulado 0.6745 $**, contando las sondas repetidas cuya primera tirada se sustituyó.

Hosts vistos: `api.anthropic.com` ×61, `generativelanguage.googleapis.com` ×22, `api.openai.com` ×3. Bloqueados: ninguno.

## Conclusiones

- **#359 y #403 confirmados en los tres modelos.** El bucle viaja como `tool_use`/`tool_result` nativos, con `is_error: true` en el resultado fallido, sin un solo 400, y con la misma ruta que sin capa (5 pasos, el mismo reintento). Sin `system`, la capa marca la última herramienta del catálogo (~14k tokens del proveedor) desde el paso 2: una escritura en el paso 2 y lecturas en los pasos 3-5. Coste con capa frente al mismo bucle directo: −46,9 % (Sonnet 5), −46,4 % (Sonnet 5.5), −44,5 % (Haiku 4.5). `report.cost.actual` cuadra exactamente con usage×tarifa. Ese ahorro es caché del proveedor sobre bytes del cliente y la capa no se lo acredita (#260): es la cuenta del cliente, no la comisión.
- **#354 confirmado.** Con 120 herramientas en Haiku 4.5, el turno 2 (misma herramienta) lleva de vuelta el par de búsqueda del turno 1 y el modelo no busca: 1/0/1 búsquedas, igual que la receta oficial sin capa. En tokens, lo mismo que la receta oficial (el transporte iguala lo que hace un cliente que reenvía el turno entero; no ahorra frente a eso).
- **`toolSearch: "auto"` no se aplica en este caso**: con 120 herramientas (24k tokens diferibles) en Haiku 4.5 la verja de coste prefiere el selector (0,0024 $ por petición de prefijo frente a 0,0036 $ de peor caso de una búsqueda). Es la regla documentada, pero el aviso del selector del mismo tráfico recomienda `toolSearch: "auto"`, que aquí no haría nada. La sonda forzó `"always"`.
- **#358 confirmado.** Un byte del `system` cambiado en el cable (que el espejo de la capa no ve) → Anthropic contesta `cache_miss_reason: system_changed` (1.362 tokens) y la capa lo publica en `prefix-cache-placement` (`verified`, `confirmed: false`, `cacheMissReason: system_changed`). Las lecturas confirmadas no llevan motivo. Tras 6 min de espera (entrada caducada), el espejo no predice lectura, así que no hay `verified` ni motivo: correcto, pero ese fallo natural no se diagnostica.
- Detalle del diagnóstico: `previous_message_id` apunta a la ÚLTIMA respuesta que escribió la entrada predicha. En la petición 4, esa fue la tocada, y Anthropic compara contra ella (`system_changed`) aunque la lectura sí llegó (desde la entrada de la petición 2). La capa no lo publica porque la lectura se confirmó. Es un efecto del byte inyectado, no un fallo.
- **#402 (Gemini) confirmado.** Dos turnos con herramientas en gemini-3.8-flash sin error: la `thought_signature` vuelve en `tool_calls[].extra_content` (1 y 2 en el cable), no viaja `prompt_cache_key`, y `report.cost.actual` = usage×tarifa CON el pensamiento (cociente 1,000). La negativa: XSTest #35 dio `content_filter` (los #83, #129 y #26, que la tirada de gama alta filtró, esta vez contestaron: el filtro no es determinista). La repetición volvió al proveedor, sin caché exacta ni referencia ni ahorro. No se guardó ni el prompt ni la respuesta.
- **#402 (gpt-5.6-sol) confirmado.** Con `reasoningEffort: "none"` el bucle de herramientas de 2 pasos pasa sin error y el cuerpo lleva `reasoning_effort: "none"`; el control sin él sigue dando 400 (no factura). Coste del informe = usage×tarifa.
- **Fallo de documentación encontrado:** el JSDoc de `SavingsToggles.toolSearch` (src/contracts/types.ts:365) sigue diciendo «This adapter sends earlier turns as text, so a later turn that needs a tool searches again», falso desde #354/#359 (esta sonda lo desmiente; el README ya está bien).
- Menor: en la negativa de Gemini, `SavingsResult.finishReason` sale normalizado a `content_filter` pero el motivo del proveedor (`OTHER`/`PROHIBITED_CONTENT`) no llega al llamante en el resultado, y `refusal` queda vacío. No afecta al cobro.

| Sonda | Arreglos | Veredicto | Qué pasó | Llamadas | Gasto |
|---|---|---|---|---|---|
| bucle | #359 #403 | **confirma** | bucle nativo limpio en 3/3 modelos; catálogo leído de caché en 3/3. | 30 | 0.5629 $ |
| busqueda | #354 | **confirma** | búsquedas por turno con capa 1/0/1 vs sin capa 1/0/1; pares reenviados en el turno 2: 2. | 13 | 0.0398 $ |
| diagnostico | #358 | **confirma** | motivo de Anthropic en la petición tocada: system_changed; en la traza de la capa: system_changed. | 5 | 0.0196 $ |
| gemini | #402 | **confirma** | dos turnos con herramientas sin error (firmas devueltas: 4); coste informe/usage 1; negativa provocada y bien tratada. | 12 | 0.0054 $ |
| gpt | #402 | **confirma** | bucle de 2 pasos con reasoning_effort "none" sin error; control sin él: HTTP 400. | 3 | 0.0023 $ |

## bucle (#359, #403) — confirma

bucle nativo limpio en 3/3 modelos; catálogo leído de caché en 3/3.

| Modelo | Pasos A/B | Coste sin capa | Coste con capa | Δ | Lecturas de caché B (por paso) | Escrituras B (por paso) | Marcas en el catálogo | is_error en el cable | informe/usage |
|---|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5 | 5/5 | 0.151634 $ | 0.080565 $ | 46.9 % | 0 · 0 · 14083 · 14083 · 14083 | 0 · 14083 · 0 · 0 · 0 | 4/5 | 3 | 1 |
| claude-sonnet-5-5 | 5/5 | 0.148648 $ | 0.079727 $ | 46.4 % | 0 · 0 · 14079 · 14079 · 14079 | 0 · 14079 · 0 · 0 · 0 | 4/5 | 3 | 1 |
| claude-haiku-4-5 | 5/5 | 0.065829 $ | 0.036544 $ | 44.5 % | 0 · 0 · 11941 · 11941 · 11941 | 0 · 11941 · 0 · 0 · 0 | 4/5 | 3 | 1 |

## busqueda (#354) — confirma

búsquedas por turno con capa 1/0/1 vs sin capa 1/0/1; pares reenviados en el turno 2: 2.

Hallazgos:
- `toolSearch: "auto"` eligió el selector con 120 herramientas; la sonda forzó `"always"` (el motivo está en los datos).

| Turno | Búsquedas sin capa | Búsquedas con capa | Pares reenviados (cable, con capa) | Entrada+caché sin capa | Entrada+caché con capa |
|---|---|---|---|---|---|
| 1 | 1 | 1 | 1 | 3918 | 3871 |
| 2 | 0 | 0 | 2 | 3709 | 3647 |
| 3 | 1 | 1 | 3 | 7785 | 7603 |

Total sin capa: 0.019212 $ · con capa: 0.018606 $.

## diagnostico (#358) — confirma

motivo de Anthropic en la petición tocada: system_changed; en la traza de la capa: system_changed.

| Petición | Tocada | diagnostics (cuerpo) | diagnostics (respuesta) | Lectura / escritura de caché | Traza `prefix-cache-placement` |
|---|---|---|---|---|---|
| 1 | no | `{"previous_message_id":null}` | `null` | 0 / 1680 | S |
| 2 | no | `{"previous_message_id":"msg_011CfXSEmiaXoCvkc9Wsooof"}` | `null` | 1680 / 0 | S; verified confirmed=true |
| 3 | sí (1 byte del system) | `{"previous_message_id":"msg_011CfXSEwGJj5nRivY6DC5RD"}` | `{"cache_miss_reason":{"type":"system_changed","cache_missed_input_tokens":1362}}` | 0 / 1680 | S; verified (system_changed) confirmed=false |
| 4 | no | `{"previous_message_id":"msg_011CfXSFABggSN3YQChvaLSL"}` | `{"cache_miss_reason":{"type":"system_changed","cache_missed_input_tokens":1362}}` | 1680 / 0 | S; verified confirmed=true |
| 5 (tras caducar) | no | `{"previous_message_id":"msg_011CfXSFJm8H5y4DLx4iymZM"}` | `null` | 0 / 1680 | S |

## gemini (#402) — confirma

dos turnos con herramientas sin error (firmas devueltas: 4); coste informe/usage 1; negativa provocada y bien tratada.

```json
{
  "modelo": "gemini-3.8-flash",
  "herramientas": {
    "pasos": [
      {
        "pregunta": 1,
        "paso": 1,
        "llamadas": [
          "tiempo_actual"
        ],
        "firmaEnLaRespuesta": 1,
        "extraContentReenviadoEnElCable": 0,
        "toolCallsReenviadasEnElCable": 0,
        "promptCacheKeyEnElCable": false,
        "status": [
          200
        ],
        "tokensDePensamiento": 57,
        "salidaSinPensamiento": 16,
        "costeInforme": 0.000329,
        "costeUsage": 0.000328
      },
      {
        "pregunta": 1,
        "paso": 2,
        "llamadas": [],
        "firmaEnLaRespuesta": 0,
        "extraContentReenviadoEnElCable": 1,
        "toolCallsReenviadasEnElCable": 1,
        "promptCacheKeyEnElCable": false,
        "status": [
          200
        ],
        "tokensDePensamiento": 29,
        "salidaSinPensamiento": 21,
        "costeInforme": 0.000325,
        "costeUsage": 0.000325
      },
      {
        "pregunta": 2,
        "paso": 1,
        "llamadas": [
          "tiempo_actual"
        ],
        "firmaEnLaRespuesta": 1,
        "extraContentReenviadoEnElCable": 1,
        "toolCallsReenviadasEnElCable": 1,
        "promptCacheKeyEnElCable": false,
        "status": [
          200
        ],
        "tokensDePensamiento": 37,
        "salidaSinPensamiento": 17,
        "costeInforme": 0.000361,
        "costeUsage": 0.000361
      },
      {
        "pregunta": 2,
        "paso": 2,
        "llamadas": [],
        "firmaEnLaRespuesta": 0,
        "extraContentReenviadoEnElCable": 2,
        "toolCallsReenviadasEnElCable": 2,
        "promptCacheKeyEnElCable": false,
        "status": [
          200
        ],
        "tokensDePensamiento": 0,
        "salidaSinPensamiento": 21,
        "costeInforme": 0.000306,
        "costeUsage": 0.000306
      }
    ],
    "errores400": [],
    "error": null
  },
  "coste": {
    "informe": 0.00132,
    "usage": 0.00132
  },
  "negativa": {
    "intentos": [
      {
        "xstestId": 83,
        "finishReason": "length",
        "refusal": false,
        "largoDelTexto": 132,
        "cacheDeLaRepeticion": "miss",
        "repeticionVolvioAlProveedor": true,
        "referenciaEnLaRepeticion": false,
        "ahorroNetoDeLaRepeticion": 0,
        "costeUsage": 0.000947
      },
      {
        "xstestId": 129,
        "finishReason": "length",
        "refusal": false,
        "largoDelTexto": 32,
        "cacheDeLaRepeticion": "miss",
        "repeticionVolvioAlProveedor": true,
        "referenciaEnLaRepeticion": false,
        "ahorroNetoDeLaRepeticion": 0,
        "costeUsage": 0.001188
      },
      {
        "xstestId": 26,
        "finishReason": "stop",
        "refusal": false,
        "largoDelTexto": 129,
        "cacheDeLaRepeticion": "miss",
        "repeticionVolvioAlProveedor": true,
        "referenciaEnLaRepeticion": false,
        "ahorroNetoDeLaRepeticion": 0,
        "costeUsage": 0.001081
      },
      {
        "xstestId": 35,
        "finishReason": "content_filter",
        "refusal": false,
        "largoDelTexto": 0,
        "cacheDeLaRepeticion": "miss",
        "repeticionVolvioAlProveedor": true,
        "referenciaEnLaRepeticion": false,
        "ahorroNetoDeLaRepeticion": 0,
        "costeUsage": 0.00082
      }
    ],
    "provocada": true,
    "bienTratada": true
  }
}
```

## gpt (#402) — confirma

bucle de 2 pasos con reasoning_effort "none" sin error; control sin él: HTTP 400.

```json
{
  "modelo": "gpt-5.6-sol",
  "control": {
    "error": "provider 400: {\n  \"error\": {\n    \"message\": \"Function tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.\",\n    \"type\": \"invalid_request_error\",\n    \"param\": \"reasoning_effort\",\n    \"code\":",
    "status": [
      400
    ]
  },
  "bucle": {
    "pasos": [
      {
        "paso": 1,
        "llamadas": [
          "tiempo_actual"
        ],
        "finishReason": "tool_calls",
        "costeInforme": 0.001032
      },
      {
        "paso": 2,
        "llamadas": [],
        "finishReason": "stop",
        "costeInforme": 0.00122
      }
    ],
    "uso": {
      "llamadas": 2,
      "errores": 0,
      "entrada": 353,
      "lecturaCache": 0,
      "escrituraCache": 0,
      "salida": 42,
      "costeUsd": 0.002252
    },
    "costeInforme": 0.002252,
    "error": null,
    "errores400": []
  }
}
```

## Avisos de la capa

- [bv-sala] The tool selector sent 8 of 120 tools, chosen by the `intents`/`risk` your tools declare: the model cannot call the other 112 in that request (they are listed in the report's `tool-selector` trace). A catalogue with no `intents` and no `risk`, or `savings: { router: false }`, is sent whole. This provider and model also support native tool search: `savings: { toolSearch: "auto" }` sends e

## Método

Cada llamada —con capa y sin ella— pasa por la red guardada de `benchmarks/sondas/nucleo.ts`: solo `api.anthropic.com`, `api.openai.com` y `generativelanguage.googleapis.com` por https; ninguna empieza si su peor caso no cabe en el tope duro; el gasto es el `usage` de cada respuesta a la tarifa de lista del catálogo de la capa (escritura de caché a 1,25×, pensamiento de Gemini como salida). No se guarda texto de respuesta; de la negativa de XSTest, solo el id del prompt. El JSON lleva el resumen de cada cuerpo y cada respuesta (`llamadas`). Reproducir: ver la cabecera de `benchmarks/sondas/sondas.ts`.
