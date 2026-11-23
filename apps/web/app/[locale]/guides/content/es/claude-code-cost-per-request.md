«¿Cuánto cuesta Claude Code?» tiene dos respuestas honestas. Con una suscripción de Claude, el precio es el del plan, y el coste por token solo importa cuando pasas de sus límites. Con una clave de API o un proveedor cloud, pagas por token, y el coste de una sesión depende de cuántas peticiones envía Claude Code, de lo grande que es cada una y de cuánto se lee de la caché de prompts. Esta guía enseña lo que publica Anthropic, qué herramientas integradas te dan totales y cómo ver el coste de cada petición en tu propia máquina, gratis, para encontrar los turnos que encarecen una sesión.

## Lo que dice Anthropic que cuesta

La propia [página de costes de Claude Code](https://code.claude.com/docs/en/costs) de Anthropic da medias de despliegues empresariales: unos 13 US$ por desarrollador y día activo y de 150 US$ a 250 US$ por desarrollador al mes, con el 90 % de los usuarios por debajo de 30 US$ por día activo. Son medias de muchos equipos. Tu cifra depende del modelo que elijas, del tamaño de tu repositorio y de cómo trabajes, y por eso el resto de esta guía trata de cómo medirla.

## Las herramientas integradas, y lo que no enseñan

- **`/usage` en Claude Code.** El bloque Session muestra un coste *estimado* a precio de lista, con los tokens por modelo desglosados en entrada, salida, lecturas de caché y escrituras de caché. Las versiones recientes añaden una línea de caché de prompts con la tasa de aciertos y el número de fallos. Es un total de la sesión, calculado en local.
- **La Claude Console.** Para claves de API, las páginas Cost y Usage muestran lo facturado por día, workspace y modelo. Esta es la cifra con la que hay que conciliar.
- **Exportación a OpenTelemetry.** Claude Code puede enviar métricas de tokens y de coste a tu propio stack de observabilidad, por usuario y sesión ([documentación de monitorización](https://code.claude.com/docs/en/monitoring-usage)).

Lo que ninguna de ellas pone fácil es la **vista por petición**: qué turno fue el caro, y por qué. Una sesión son decenas o cientos de llamadas a la API, y las caras tienen causas reconocibles:

- **Una caché fría.** El primer turno tras una pausa más larga que la duración de la caché vuelve a leer toda la conversación a precio completo, y la escribe de nuevo.
- **Un cambio de modelo.** Cada modelo tiene su propia caché, así que cambiar de modelo a mitad de sesión vuelve a procesarlo todo.
- **Resultados de herramientas enormes.** Un log de tests o un fichero grande leído una sola vez se queda en el contexto de todos los turnos siguientes.
- **Demasiadas definiciones de herramientas.** Los servidores MCP pueden añadir muchos kilobytes de definiciones a cada petición.
- **La compactación.** Resumir una conversación larga ya es, en sí, una petición grande.

## Mide cada petición con un gateway local

Un gateway es un pequeño proxy entre Claude Code y la API que lee los contadores de uso de cada respuesta. Claude Code lo admite oficialmente mediante `ANTHROPIC_BASE_URL`. [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) incluye uno en su paquete de npm: Apache-2.0, **sin clave, sin registro**, y no se envía nada a BiVelio. Necesita Node.js 20.19.0 o posterior.

Con un solo comando:

```bash
# Starts a local gateway on a free port, runs Claude Code through it, and stops it on exit.
npx @bivelio/savings-layer claude
```

El envoltorio silencia el log por petición para no pintar encima de la interfaz de Claude Code. Al salir, imprime cuántas peticiones ha medido, cuánto han costado a precio de lista, qué se ha ahorrado o por qué no se ha ahorrado nada, y qué peticiones ha reenviado sin medir y por qué. Para ver cada petición en el momento, o bien pides el log por stderr:

```bash
BVSALA_GATEWAY_LOG=1 npx @bivelio/savings-layer claude
```

o bien arrancas el gateway en su propio terminal, en un puerto fijo:

```bash
# Terminal 1: the gateway (Anthropic is the default upstream, port 8402)
npx @bivelio/savings-layer gateway

# Terminal 2: Claude Code, pointed at it (no /v1 at the end).
# ENABLE_TOOL_SEARCH=true only matters before Claude Code v2.1.304 (see below).
ENABLE_TOOL_SEARCH=true ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude
```

Cada petición se convierte en una línea. Estas dos salen de una prueba local contra un servidor de prueba, con tráfico inventado: el formato es real y las cifras no son las tuyas:

```text
[gateway] POST /v1/messages  · claude-sonnet-5 · $0.007700 (in 40, cache↑3000 cache↓0, out 12)
[gateway] POST /v1/messages  · claude-sonnet-5 · $0.000800 (in 40, cache↑0 cache↓3000, out 12)
```

Se lee de izquierda a derecha: el modelo, el coste al precio de lista estándar del modelo (los turnos en modo rápido son la excepción, más abajo), y luego los tokens de entrada facturados completos, los tokens escritos en la caché (`cache↑`), los leídos de ella (`cache↓`) y los tokens de salida. La primera línea es un turno en frío que escribe el prefijo; la segunda lo vuelve a leer por una fracción del precio. Una sesión en la que `cache↑` sigue alto turno tras turno tiene un problema de caché: consulta [por qué deja de funcionar el prompt caching de Claude](/es/guides/claude-prompt-caching-not-working).

`ENABLE_TOOL_SEARCH=true` depende de tu versión de Claude Code. Desde la v2.1.304, la búsqueda de herramientas (tool search) sigue activa detrás de un gateway ([documentación de MCP de Claude Code](https://code.claude.com/docs/en/mcp)), y la variable no cambia nada. Antes de la v2.1.304, Claude Code desactivaba tool search detrás de cualquier base URL que no fuera la de Anthropic y metía todas las definiciones de herramientas en cada petición. En esas versiones antiguas salía caro: la guía de Claude Code del gateway, incluida en el paquete de npm, recoge una configuración con 226 herramientas MCP, medida el 9 de septiembre de 2026, en la que eso suponía 450 KB por petición y una cuarta parte de la factura de ese día. El envoltorio `claude` pone la variable por ti, salvo que ya la hayas puesto tú.

## Lo que ve el gateway, y lo que no

- **Reenvía lo que envía Claude Code.** Si ninguna palanca actúa sobre una petición, el cuerpo llega a Anthropic byte a byte, con las marcas `cache_control` y la cabecera `anthropic-beta`, así que la caché funciona exactamente igual que sin el gateway. Un test del repositorio lo comprueba contra un upstream falso en cada cambio.
- **Dos llamadas pequeñas se lo saltan.** Según la [guía de compatibilidad con gateways](https://code.claude.com/docs/en/llm-gateway-protocol) de Claude Code, la comprobación de disponibilidad del modo rápido y la comprobación de seguridad de dominios de WebFetch llaman directamente a `api.anthropic.com` en vez de seguir `ANTHROPIC_BASE_URL`. Ninguna de las dos es una petición al modelo: la inferencia en modo rápido sí sigue la base URL y pasa por el gateway.
- **Los turnos en modo rápido se registran al precio estándar.** Anthropic marca una petición en modo rápido con `speed: "fast"` y la factura con recargo: 8 US$ de entrada y 40 US$ de salida por millón de tokens en Claude Opus 5.5, el doble de la tarifa estándar, con los multiplicadores de caché encima ([documentación del modo rápido](https://platform.claude.com/docs/en/build-with-claude/fast-mode)). La versión 1.2.5 del gateway, como la 1.2.3, no lee `speed`, así que cuenta bien esos tokens pero les pone precio de turno estándar: en Opus 5.5, la mitad de lo que factura Anthropic. Si usas `/fast`, el total del gateway para esos turnos se queda corto.
- **El tráfico de suscripción se mide, no se factura.** Si inicias sesión con Claude Pro o Max, no hay factura por token; el gateway valora ese tráfico a su equivalente en precio de lista para que lo veas, y no le atribuye ningún ahorro.

## ¿El gateway también ahorra dinero?

Tal cual viene, con Claude Code sobre una clave de API, mide y no ahorra nada, y la versión 1.2.5 lo dice. Su mensaje de arranque dice que el ajuste del TTL de la caché es la única palanca de ahorro activa por defecto y que solo actúa sobre el tráfico de Anthropic con clave de API que pide la caché de una hora, y su resumen de salida pone lo ahorrado junto a lo gastado, con el motivo cuando el ahorro es cero. La versión 1.2.3 decía que todas las palancas de ahorro locales estaban activas, y su resumen de salida solo contaba peticiones: si aún la usas, no tomes ninguno de los dos como una promesa. La palanca por defecto del gateway baja la duración de la escritura en caché de una hora a cinco minutos en los turnos en los que gran parte de la petición es nueva, porque una escritura de una hora cuesta el doble del precio de entrada y una de cinco minutos 1,25 veces. Claude Code con clave de API ya pide cinco minutos, salvo que pongas `promptCacheTtl` a `1h`, así que no hay nada que bajar.

Cuando entra en juego la caché de una hora, el ahorro es pequeño y depende de tu tráfico. La [página del banco público](/es/benchmarks#gateway-ttl) publica una reproducción del propio tráfico de Claude Code de una organización: un neto de **+2,49 %** de la factura a precio de lista (113,45 US$ de 4563,61 US$), con un intervalo del 95 % de +1,50 % a +3,57 % al remuestrear por sesión, y un techo del 7,2 % para cualquier política de este tipo. En un modelo el resultado fue casi nulo, y en un periodo perdió dinero. Es una reproducción con una línea base reconstruida en parte, no una factura, y la página enumera todos sus límites.

## Contrasta las cifras del gateway con tu factura

1. **Con `/usage`.** Para una sesión, suma los costes por petición del gateway y compáralos con el bloque Session de `/usage`. Los dos valoran los mismos contadores a precio de lista, así que deberían salir parecidos, salvo en los turnos en modo rápido, que `/usage` valora a la tarifa rápida y el gateway 1.2.5 a la estándar.
2. **Con la Console.** Usa una clave de API o un workspace dedicados durante un día y compara los totales por modelo del gateway con la página Usage de la Console para esa clave: entrada, salida, escrituras de caché y lecturas de caché, primero en tokens y después en dólares.
3. **Explica cualquier diferencia.** El precio de lista no siempre es tu precio: los descuentos contratados, la residencia de datos o los niveles de prioridad cambian el dinero, pero no los recuentos de tokens. El modo rápido también: con `/fast` activado, el total del gateway queda por debajo del de la Console, porque la 1.2.5 valora los turnos en modo rápido a la tarifa estándar. El tráfico que no ha pasado por este gateway, como otra máquina, un script o un job de CI que usa la misma clave, solo aparece en la Console.

Si los tokens cuadran y los dólares no, la diferencia está en los precios, no en la medición. Para el método completo, lee [cómo verificar el ahorro en LLM con la factura de tu proveedor](/es/guides/verify-llm-savings-against-provider-bill).

## Recortar la factura cuando ya la ves

Con las cifras por petición delante, los arreglos habituales son sencillos: limpia el contexto entre tareas que no tienen relación en vez de arrastrar un contexto largo, elige el modelo antes de la sesión y no lo cambies, compacta en las pausas naturales, deja los logs grandes fuera del contexto y quita los servidores MCP que no usas. Cómo usar el modelo de otro proveedor detrás de Claude Code se explica en [costes de la API de DeepSeek y Qwen](/es/guides/deepseek-qwen-api-cost-local-gateway).

El código fuente del gateway, su guía de Claude Code y los tests que comprueban que reenvía tus peticiones sin cambios están en [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
