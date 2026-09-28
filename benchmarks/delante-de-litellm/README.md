# E6 · BV-SALA delante de LiteLLM

> PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.

Experimento E6 del informe de competencia del 2026-09-27
(`docs/investigacion/2026-09-27/inteligencia-competitiva.md`, §10): el comprador
que ya tiene LiteLLM, ¿puede tener libros con base sin cambiar de gateway? La
receta para el cliente (en inglés, borrador sin publicar) está en
[`examples/litellm/README.md`](../../examples/litellm/README.md).

## Qué hay aquí

| Fichero | Qué es |
|---|---|
| `instalar-litellm.sh` | Instala LiteLLM proxy **1.102.1** en un venv temporal: suma sha256 de la rueda fijada y comparada con la que publica PyPI, rueda comprobada con `shasum` antes de instalar, dependencias con `--exclude-newer 2026-09-24T00:00:00Z` y la caché de uv dentro del directorio. Nada global. |
| `litellm.yaml` | `model_list` mínima delante del upstream falso: `gpt-4o-mini` (id del proveedor), `equipo-rapido` (alias propio, mismo modelo) y `claude-haiku-4-5` (paso de Anthropic, `/v1/messages`). |
| `litellm-con-cache.yaml` | La misma lista con la caché de respuestas de LiteLLM (`local`) y una master key de relleno. |
| `nucleo.ts` | Lo que comparten la prueba real y el test de CI: el **doble** de LiteLLM, los escenarios (SDK y gateway) y el veredicto de comisión con la verja real del ingest. |
| `e2e.ts` | La prueba con LiteLLM de verdad (`pnpm litellm:e2e`). |

## Ejecutar

```bash
bash benchmarks/delante-de-litellm/instalar-litellm.sh /tmp/e6-litellm
env -u BIVELIO_SERVICE_KEY -u BIVELIO_LICENSE_KEY \
  pnpm litellm:e2e --litellm /tmp/e6-litellm/venv/bin/litellm --guardar
rm -rf /tmp/e6-litellm
```

Todo escucha en 127.0.0.1. LiteLLM corre con el entorno **vaciado** (ni una
variable de la shell), `HOME` temporal, la tabla de precios local
(`LITELLM_LOCAL_MODEL_COST_MAP=True`; sin ella la baja de GitHub al arrancar) y la
telemetría apagada. BV-SALA corre desde el fuente sin licencia real
(`devUnlicensed` en el SDK, la licencia efímera de los tests en el gateway) y mide
contra una ingesta falsa local. Ninguna petición lleva una clave real.
`--guardar` escribe `benchmarks/evidencia/delante-de-litellm-<fecha>.json`.

En CI, sin Python ni red, `test/delante-de-litellm.test.ts` corre los mismos
escenarios contra el doble, y ata el doble a las cabeceras que LiteLLM mandó de
verdad (las guarda la evidencia).

## Resultado del 2026-09-27 (LiteLLM 1.102.1, Apple M4 Pro, Node 25.9.0)

| # | Escenario | Resultado |
|---|---|---|
| S1 | SDK → LiteLLM (Chat Completions), `openai/gpt-4o-mini` con `stripProviderPrefix` | 1.ª `measured`, 2.ª `reference` (acierto exacto); al upstream llega **una** |
| S1 | Lo que haría el servidor con la repetición | Pasa la verja del ingest como `reference` y **entra en la base de la comisión** |
| S2 | Alias propio sin precio de lista | 2.ª `estimated` (`no-cached-price`): fuera de la base |
| S3 | El mismo alias con `costModels` | 2.ª `reference`: dentro de la base |
| S4 | SDK → LiteLLM (Messages, paso de Anthropic) | 1.ª `measured`, 2.ª `reference`; al upstream llega una |
| S5 | Dos instancias del SDK tras un LiteLLM con caché | La 2.ª es un acierto de LiteLLM (`x-litellm-cache-key`), no llega al upstream, repite la cabecera de coste y el SDK la da por **`measured` a precio completo** |
| S6 | Gateway → LiteLLM, dos idénticas en vuelo (coalescencia) | Una al upstream; la gemela `estimated`, motivo `unofficial-upstream`: **fuera de la base** |
| S7 | `cache_control` con `ttl: "1h"` a través de LiteLLM | Llega intacto al upstream |
| S8 | Palanca de TTL del gateway con LiteLLM de upstream | El `ttl` rebajado a `5m` cruza LiteLLM hasta el upstream |

**(a) se cumple** en los dos dialectos. **(b) se cumple solo en el gateway.** Tres
huecos, fijados en el test tal como se comportan hoy (no cambian facturación en
este PR; los decide el dueño):

1. **SDK — CERRADO el 2026-09-28** (el dueño: alinear el SDK con el gateway). El
   SDK decidía el origen oficial por el host solo para el tier y la caché
   explícita; la regla de la referencia (`src/pipeline/referencia.ts`) no lo
   miraba. Detrás de LiteLLM, una repetición con un id del catálogo (o con
   `costModels`) entraba en la base de la comisión a precio de lista, aunque
   LiteLLM pueda enrutar ese nombre a Azure, Bedrock, un modelo propio o un
   respaldo. Ahora `OpenAICompatibleProvider` y `AnthropicProvider` atestiguan el
   origen por su `baseUrl` y, detrás de un origen no oficial, la llamada que corre
   no deja registro de referencia (E0-bis, `unofficial-origin`): S1, S3 y S4 dan
   la repetición `estimated`, fuera de la base, como el gateway
   (`esUpstreamOficial`). La tabla de arriba es la de la evidencia del
   2026-09-27, anterior al cambio.
2. **Gateway, palanca de TTL:** su ahorro `measured` (prima de 1 h frente a 5 min,
   a precio de lista) solo se excluye con tráfico de suscripción, no con un
   upstream no oficial. El test lo demuestra con un upstream que declara
   escrituras a 5 min detrás del doble.
3. **Caché de LiteLLM:** un acierto llega como respuesta normal con el `usage`
   original; el SDK lo reporta `measured` a precio completo. Hasta el 2026-09-28
   dejaba además un registro de referencia con ese contador; desde el cierre del
   hueco 1, no. No mueve la comisión (lo medido sin palanca tiene ahorro 0), pero
   el `actual` de esa fila no está en ninguna factura.

## Límites

- Upstream falso en loopback: prueba la contabilidad, no la red ni un proveedor
  real. El `usage` lo fabrica el upstream falso.
- El doble no es LiteLLM: no enruta, no reintenta ni autentica, y no sirve stream.
  Imita lo que cambia una cuenta (alias, `provider_specific_fields`, cabeceras de
  coste, su caché); lo demás lo cubre la prueba real.
- Una máquina, una versión de LiteLLM. LiteLLM saca versión cada semana: se vuelve
  a pasar `pnpm litellm:e2e` antes de publicar la receta.
