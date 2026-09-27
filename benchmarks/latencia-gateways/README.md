# Latencia y fidelidad de gateways locales

> PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.

Mide, en una máquina y contra un **upstream falso** que responde al instante, tres
cosas de un gateway local (el de BV-SALA y los OSS con los que se le compara):

1. **Sobrecoste de latencia.** Cada ronda manda la misma petición directa al
   upstream y a través de **cada** gateway, en una permutación aleatoria. El
   sobrecoste de un gateway es la **mediana de sus diferencias con el directo de
   la misma ronda**, con IC 95 % por bootstrap. Como todos los gateways comparten
   rondas, viven la misma carga de la máquina y se pueden comparar entre sí
   (`nucleo.ts` explica el porqué). Cuatro escenarios: Chat
   Completions de 1 KB y de 200 KB (el tamaño de un turno de agente de código),
   con y sin stream. El primer byte cuenta aparte: un gateway que retiene el
   stream se ve ahí.
2. **Carga** (opcional, `--concurrencia`): peticiones por segundo y p50/p99 con N
   en vuelo, en dos pasadas por todos los brazos (la segunda en orden inverso).
3. **Fidelidad.** Una petición con los campos que cambian la factura
   (`prompt_cache_key`, `service_tier: "flex"`, `store`, herramientas,
   `parallel_tool_calls`) y lo que el upstream dice haber recibido; y la respuesta
   del gateway frente a la directa. Con dos modelos: `gpt-4o-mini` (sin Flex en
   OpenAI) y `gpt-5-mini` (con Flex).

4. **Fidelidad en el dialecto de Anthropic** (E1, 2026-09-27). Un cuerpo de
   `/v1/messages` con `cache_control` a TTL de 1 h (en `system`, en una
   herramienta y en el último turno), la búsqueda de herramientas con una
   diferida y su `tool_reference`, y las herramientas en línea (un mensaje
   `system` a mitad de conversación con `tool_addition` por definición y por
   referencia), con `anthropic-version` y `anthropic-beta`
   (`nucleo.ts → cuerpoDeFidelidadAnthropic`). Se mira lo que llegó al upstream
   (cuerpo ruta a ruta y las dos cabeceras) y la respuesta frente a la directa,
   en JSON y en SSE, con el `usage` clave a clave (el desglose de la escritura de
   1 h incluido). Con `claude-haiku-4-5` y `claude-opus-5-5`. Rutas: BV-SALA y
   LiteLLM `/v1/messages`, Bifrost `/anthropic/v1/messages`, Portkey
   `/v1/messages` con `x-portkey-provider: anthropic`. Helicone no entra (su
   catálogo acaba en 2025).

Todo el tráfico se queda en 127.0.0.1 y ninguna petición lleva una clave real.
Nadie se mide a sí mismo: el reloj es el del cliente y el upstream es el mismo
para todos.

## Ejecutar

```bash
pnpm latencia:gateways                      # solo BV-SALA (reenvío y medido)
pnpm latencia:gateways --objetivos bvsala,bvsala-medido,litellm,bifrost,portkey,helicone \
  --rondas 600 --calentamiento 60 --concurrencia 32 --peticiones 4000 --guardar --etiqueta a \
  --pid litellm=<pid> --pid bifrost=<pid> --pid portkey=<pid> --pid helicone=<pid>
```

- El arnés arranca el upstream falso en `--puerto-upstream` (9911 por defecto) y
  el gateway de BV-SALA **compilado a .js** desde el fuente con una licencia de
  prueba (la misma clave efímera que usan los tests del gateway; el paquete
  publicado ignora esa clave y solo acepta la embebida). `--bvsala-desde-fuente`
  lo corre con tsx.
- `bvsala` reenvía sin clave de servicio; `bvsala-medido` mide cada petición
  contra una ingesta falsa, como el CLI en producción.
- `--guardar` escribe `benchmarks/evidencia/latencia-gateways-<fecha>[-<etiqueta>].json`
  con la máquina, su carga media al empezar y al terminar, las versiones
  (`--version nombre=x.y.z`), cada resumen, la carga y la fidelidad.
- `--usar-upstream-existente` reutiliza un upstream falso ya lanzado a mano.
- `--escenarios 1k,1k-stream,200k,200k-stream` elige escenarios;
  `--modelos-fidelidad gpt-4o-mini,gpt-5-mini` elige los modelos de la prueba de
  fidelidad y `--modelos-fidelidad-anthropic claude-haiku-4-5,claude-opus-5-5`
  los de la de Mensajes.
- `--solo-fidelidad` pasa solo las pruebas de fidelidad (sin latencia ni carga);
  con `--prefijo fidelidad-anthropic` la evidencia sale en
  `benchmarks/evidencia/fidelidad-anthropic-<fecha>.json`:

```bash
pnpm latencia:gateways --usar-upstream-existente --solo-fidelidad \
  --objetivos bvsala,bvsala-medido,litellm,bifrost,portkey \
  --guardar --prefijo fidelidad-anthropic \
  --version litellm=1.102.1 --version bifrost=2.2.3 --version portkey=1.15.2
```

  La garantía de BV-SALA en este dialecto (bytes intactos en los dos sentidos,
  `anthropic-beta` incluida, JSON y SSE) la ata también
  `test/latencia-gateways.test.ts`, con un control negativo que demuestra que
  la prueba ve un `ttl` perdido.

## Los gateways de terceros

No los instala el arnés. Versiones fijadas el 2026-09-27, en un directorio
aparte (nunca global), todas apuntando al upstream falso:

| Gateway | Instalación fijada | Arranque | Puerto |
|---|---|---|---|
| LiteLLM proxy 1.102.1 | `uv venv litellm-venv && uv pip install --python litellm-venv/bin/python 'litellm[proxy]==1.102.1'` (rueda arm64 sha256 `da73fe3f…b280c7`) | `litellm-venv/bin/litellm --config configs/litellm.yaml --port 4000` (E1 lo lanzó con `--host 127.0.0.1`) | 4000 |
| Bifrost transports v2.2.3 | `curl -o bifrost-http https://downloads.getmaxim.ai/bifrost/v2.2.3/darwin/arm64/bifrost-http` (sha256 observado `dd596a79…33b4a`; el servidor no publica suma) | `./bifrost-http -app-dir <dir con configs/bifrost/config.json> -port 8080 -host 127.0.0.1` | 8080 |
| Portkey gateway 1.15.2 | `npm install @portkey-ai/gateway@1.15.2` (tarball sha256 `be968d3a…d669`) | `node node_modules/@portkey-ai/gateway/build/start-server.js --port=8787` | 8787 |
| Helicone AI Gateway 0.2.0-beta.30 | `gh release download v0.2.0-beta.30 -R Helicone/ai-gateway -p 'ai-gateway-aarch64-apple-darwin.tar.xz*'` y `shasum -a 256 -c` | `OPENAI_API_KEY=relleno ./ai-gateway --config configs/helicone.yaml` | 8090 |

Avisos que condicionan la lectura:

- **LiteLLM** baja su tabla de precios de `raw.githubusercontent.com/BerriAI/litellm/main`
  al importarse (sin fijar versión); `LITELLM_LOCAL_MODEL_COST_MAP=True` usa la
  que trae el paquete. Escucha en `0.0.0.0` por defecto.
- **Bifrost**: el lanzador de npm (`@maximhq/bifrost` 1.6.3) descarga el binario
  sin comprobar suma ni firma. Sincroniza precios y un catálogo MCP de
  `getbifrost.ai` al arrancar y guarda prompts y respuestas en `logs.db`.
- **Portkey**: el stream por `x-portkey-custom-host` responde 500
  (`TypeError: immutable`, issues #1389 y #1550 abiertos) con Node 20.20 y 25.9,
  también con `@hono/node-server` 1.14.2 fijado; esos escenarios salen como error.
  Escucha en todas las interfaces.
- **Helicone**: el catálogo embebido acaba en modelos de 2025 (`gpt-5-mini` da
  500 «No model mapping found»); el repositorio no recibe commits desde el
  2025-11-21. Su dirección por defecto es `0.0.0.0`; la configuración la fija a
  loopback.

## ¿A quién llaman por su cuenta?

```bash
pnpm vigia:conexiones --segundos 30 --cada-ms 100 --proxy-registro -- <comando del gateway…>
```

Muestrea con `lsof` las conexiones del árbol de procesos y, con
`--proxy-registro`, lanza el comando con `HTTP(S)_PROXY` apuntando a un proxy
local que apunta cada destino y lo reenvía sin tocarlo. Ve **a quién** se llama,
no **qué** viaja; no ve a quien ignora las variables de proxy ni la resolución
DNS. Es un indicio que se contrasta con el código, no una auditoría.

## Límites

- Una máquina, un upstream en loopback: mide lo que añade el proceso del gateway,
  no la red. Con un proveedor real (300–2.000 ms hasta el primer token) medio
  milisegundo es ruido; la cifra sirve para comparar gateways, no para prometer
  latencia.
- La máquina compartida con otros procesos mete ruido en la cola (p99). Las
  rondas compartidas protegen la mediana y la comparación entre gateways; la
  cola y la prueba de carga, no del todo.
- La carga con un solo cliente Node satura antes el cliente que un gateway rápido:
  las RPS altas son un suelo del gateway, no su techo.
- No es ahorro, no entra en ningún libro y no es una cifra de producto sin la
  máquina, las versiones y la fecha al lado.
