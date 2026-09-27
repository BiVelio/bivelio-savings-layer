# Informe de competencia: BiVelio Savings Layer (BV‑SALA)

**Fecha de corte:** 26‑sep‑2026 · **Producto:** `@bivelio/savings-layer` 0.4.24 · **Base:** investigación web verificada contra fuentes primarias, más el repositorio `bsl-comprador` (README, bitácoras del 10, 12 y 26‑sep y `src/pricing`). Las citas [n] remiten a §9. Etiquetas: **[marketing]** = cifra del propio vendedor; **[medido]** = medición con método, independiente salvo que se indique otra cosa; **[inferido]** = conclusión de este análisis.

---

## 1. Resumen ejecutivo

**Veredicto: la tesis va por buen camino y el paquete comercial actual no.** BV‑SALA apuesta por lo único que la evidencia de 2026 premia: ahorro medido con el contador del proveedor, con la base de cada cifra declarada. Pero vende palancas que proveedores y frameworks ya regalan, dentro de un paquete que el mercado no acepta: sin prueba gratuita, solo TypeScript y con una comisión que casi nunca se puede cobrar. No hace falta cambiar de tesis. Hace falta estrecharla y abrir la puerta de entrada.

**A favor**
1. La evidencia independiente le da la razón al método. Compresores que anuncian 60–90 % miden ≈0 % o encarecen la factura en agentes de código [56][57][59][60][61]. Medir con contador y etiquetar la base ya es el listón.
2. El hueco sigue libre: no encontramos a nadie que junte, en un SDK en proceso, evitar llamadas (resolvers, singleflight, cachés), libros con base declarada y cobro sobre lo medido. Además, 10→4 % es la comisión más baja entre quienes cobran por ahorro (Genosis 15–20 %, FinOps LLM 15–25 %) [74][75].
3. La consolidación de los gateways SaaS (Portkey pasa a Palo Alto, Helicone queda en mantenimiento, OpenRouter pasa a Stripe) deja sitio a quien no quiere un proxy de terceros que ve los prompts [35][37][38].

**En contra**
1. Las palancas grandes (caché de prefijo, selección de herramientas, compactación) ya son gratis en Anthropic, OpenAI, Mastra, LangChain y el AI SDK [6][11][17][92][93]. El ≥10 % es provisional, medido en gpt‑4o‑mini sobre 11 escenarios sintéticos y sin un brazo «nativo bien configurado» [4].
2. El gateway de terminales (~2 %) queda por debajo de herramientas gratuitas y de ahorros mayores anunciados (Copilot 10 % garantizado, Cursor, Tokenade, Opik) [2][27][52][77][80].
3. El negocio no cierra. Solo se puede cobrar sobre el basis `reference`, que da ~12 €/mes por cada 10.000 $ de gasto. No hay free tier ni trial cuando el resto sí los tiene. La tracción es mínima: 2.939 descargas npm/mes y 4 licencias PRO vivas a 12‑sep [3][4][109].

---

## 2. Mapa del mercado

Hay nueve categorías que compiten por la misma partida, «la factura de LLM». Cada tabla lleva las mismas columnas.

### 2.1 Funciones nativas de proveedores y herramientas (competidor estructural)

| Actor | Qué hace | Precio | Despliegue | ¿Ve prompts? | Ahorro declarado · evidencia | Tracción |
|---|---|---|---|---|---|---|
| Anthropic API | Caché automática (19‑feb‑2026), diagnóstico de caché (GA 23‑sep‑2026), compactación, context editing, tool search, effort por mensaje, advisor, task budgets, Batch −50 % [6][7][8][9][10][11][12] | Incluido. Lectura de caché 0,1× (0,05× Opus 5.5; 0,025× Fable 5.1); escritura 1,25× (5 min) o 2× (1 h) [13] | Nativo | Es el proveedor | «Hasta 90 %» en caché; tool search «>85 %» de las definiciones [marketing]. Caché en agentes: −41 a −80 % de coste [medido, 63] | Activo por defecto |
| OpenAI API | Caché automática; desde GPT‑5.6 (9‑jul‑2026) escritura a 1,25× y breakpoints explícitos; diagnóstico GA (8‑sep‑2026); compactación; tool search (5‑mar‑2026); Flex y Batch −50 % [17][19][20] | Incluido. gpt‑6‑luna 0,10/0,01/0,50 $ por M tokens [18] | Nativo | Es el proveedor | «Hasta 90 %» [marketing] | Activo por defecto |
| Google Gemini | Caché implícita por defecto (desde 8‑may‑2025) al 10 % del precio de entrada; Flex −50 % (2‑abr‑2026) [22][23] | Incluido | Nativo | Es el proveedor | «Hasta 90 %» [marketing] | — |
| Claude Code | `/usage` con causa del fallo de caché, TTL configurable, OTel por usuario, límites de gasto y Claude apps gateway autoalojado [14][15][16] | Gratis | CLI + gateway autoalojado | El gateway no guarda contenido | Sin cifra. Referencia: ~13 $/día activo y 150–250 $/desarrollador/mes [14] | Toda la base de Claude Code |
| Copilot Auto / Cursor Router | Eligen el modelo dentro de la herramienta [27][52] | Copilot: −10 % en el precio; Cursor: tarifa de lista | SaaS | Sí | Copilot 10 % (es precio, no medición); Cursor «60 %» en A/B propio [marketing] | Todas sus bases de pago |

### 2.2 Gateways y proxies

| Actor | Qué hace | Precio | Despliegue | ¿Ve prompts? | Ahorro declarado · evidencia | Tracción |
|---|---|---|---|---|---|---|
| LiteLLM | Proxy OSS y SDK Python: claves virtuales, presupuestos, caché exacta y semántica, auto router [31][33] | OSS gratis; Enterprise a medida | Autoalojado | No sale de casa | AT&T −56 % en código enrutando a modelos baratos [medido por el cliente, 34]; auto router 51,1 % a precio de lista, sin A/B [marketing con método, 33] | 59.673★; 89,4 M descargas PyPI/mes; versiones maliciosas en PyPI el 24‑mar‑2026 [32] |
| Vercel AI Gateway | `caching:'auto'`, `cache_ttl` de 5 min o 1 h (solo en la Responses API), presupuestos por equipo o miembro [28] | 0 % de margen; complementos por uso | SaaS | Sí | Sin %. Un tercero documentó que degradaba en silencio el TTL de 1 h a 5 min [medido, 29] | vercel/ai 26.967★ |
| Cloudflare AI Gateway | Caché exacta, rate limit, límites de gasto, logs sin payload [30] | Núcleo gratis; 5 % sobre créditos | SaaS (edge) | Sí, o solo metadatos | Sin % | — |
| Portkey → Prisma AIRS | Gateway con caché simple y semántica y gobierno [36] | Production 49 $/mes; Enterprise a medida | SaaS, VPC u OSS | Sí en SaaS | ~20 % de aciertos (2023) [marketing] | Palo Alto la compró por 117 M$ (cierre 29‑may‑2026). El OSS no tiene commits desde el 25‑may [35] |
| Bifrost (Maxim) | Gateway en Go con caché de doble capa y presupuestos [41] | OSS gratis | Autoalojado | No | Sin cifra de ahorro | 8.380★ |
| OpenRouter | Marketplace y router; Auto Router; Batch −50 %; caché de respuestas cuyos aciertos se facturan a 0 $ [38][39] | 5,5 % al comprar créditos (8 % en Business); BYOK gratis hasta 25k $/mes | SaaS | Sí | Auto Router −51 % a −64 % en benchmarks propios [marketing] | >10 billones de tokens/día. Compra por Stripe acordada el 19‑ago y **no cerrada** a 26‑sep [38] |
| Kong AI Gateway | Caché semántica y compresor LLMLingua (Enterprise) [44] | Enterprise; 100 $/modelo/mes | Autoalojado o híbrido | No (data plane del cliente) | «Hasta 5×» [marketing] | Kong 44.199★ |

### 2.3 Routers de modelo

| Actor | Qué hace | Precio | Despliegue | ¿Ve prompts? | Ahorro declarado · evidencia | Tracción |
|---|---|---|---|---|---|---|
| Not Diamond (Code) | Router por petición para agentes de código; tiene en cuenta la caché; dice usar solo metadatos [49] | 0,05 $ por M tokens enrutados | API + proxy local | Dice que no | 20–40 % [marketing]. RouterArena: puesto 28 de 32 [medido, 50] | Logos grandes; sin cifras |
| Thesean Ship (Martian) | Alias drop‑in `ship-like/<modelo>` [51] | No publicado | SaaS | Sí. Sus términos permiten entrenar con los datos del cliente | «≥50 % garantizado por SLA» [marketing]; los términos dicen «AS IS» y «non‑refundable» | Clientes citados: Kilo Code, Baz |
| Weave Router | Proxy local para Claude Code y Codex con coste por sesión [53] | Apache‑2.0; la plataforma cuesta 50 $/ingeniero | Local u hospedado | En local, no | 40–70 % [marketing]. RouterArena: puesto 10 de 32 [medido, 50] | 5.274★ |
| Azure Model Router | Router con bandas de calidad (Balanced 1–2 %, Cost 5–6 %) y kit de evaluación [25] | 0,14 $/M de entrada + el modelo | SaaS (Azure) | Sí (no almacena) | Sin cifra. RouterArena: puesto 18 de 32 [medido, 50] | — |

### 2.4 Caché semántica como producto

| Actor | Qué hace | Precio | Despliegue | ¿Ve prompts? | Ahorro declarado · evidencia | Tracción |
|---|---|---|---|---|---|---|
| Redis LangCache | Caché semántica gestionada por API [47] | **Gratis** en vista previa; precio de GA sin fijar | SaaS | Sí | «90 %», con un solo testimonio [marketing] | 10.935 descargas PyPI/mes |
| Fastly AI Accelerator | Proxy de caché semántica [48] | 0,40–0,28 $ por 1.000 peticiones | SaaS (edge) | Sí | «9×» en latencia [marketing] | — |
| GPTCache / vCache | Librerías con verificación del acierto [89][90] | Gratis (vCache con licencia NC‑ND) | Librería | No | JEV: 99,7 % de precisión y 72,1 % de recall [medido por el proyecto]; vCache: cota de error δ (ICLR 2026) [medido] | 8.205★ / 80★ |

### 2.5 Compresión de contexto y agentes de código

| Actor | Qué hace | Precio | Despliegue | ¿Ve prompts? | Ahorro declarado · evidencia | Tracción |
|---|---|---|---|---|---|---|
| Caveman | Skill, proxy local, middleware TS/Py (alfa) y una nube «verified» con recibos firmados, en desarrollo [68] | MIT + BSL‑1.1, gratis para tráfico propio | Local | No | «65 %» [marketing]. JetBrains: −8,5 % de tokens de salida y ~−10 % de coste esperado, p=0,82 [medido, 56] | 107.938★; CLI 85.509/mes; middleware 136/mes |
| Headroom | Compresión reversible como librería, proxy o MCP, con holdout de ahorro [69] | Apache‑2.0; equipos a medida | Local o VPC | No | 20 % en agentes, 60–95 % en JSON [marketing]. Barker: −39 % de tokens y coste sin cambio detectable, con 123 invalidaciones de caché [medido, 60] | 73.874★; 99.881 npm + 246.320 PyPI/mes |
| RTK / RTK Pro | Filtra la salida de comandos, con capa empresarial de pago [70] | CLI gratis; Pro sin precio publicado | Local, SaaS u on‑prem | CLI: no | «60–90 %» de la salida bash [marketing]. JetBrains: +7,6 % de coste (p=0,004); Quesma: +1 % y +17 % [medido, 57][59] | 81.769★ |
| context-mode | Sandbox para salidas de herramientas, más Insight (analítica) [71] | Plugin gratis (ELv2); Insight 20 $/asiento | Local + SaaS de metadatos | No | «98 %» [marketing] | 24.086★; 75.590 npm/mes |
| The Token Company / Compresr (YC W26) | API de compresión [72] | Por token eliminado / 0,10 $ por M procesado | SaaS u on‑prem | Sí en SaaS | 10–50 % / «~90 %» [marketing] | 2 y 3 personas; 104 y 588 PyPI/mes |
| TOON | Formato compacto para datos en prompts [67] | MIT | Librería | No | −42,6 % frente a JSON [marketing]. Medido: −15 % a −26 % frente a JSON; −9 pp de precisión en tool‑calling multiturno [67] | 4,83 M npm/mes; 25.429★ |

### 2.6 Cobro por ahorro (competidores directos por modelo de negocio)

| Actor | Qué hace | Precio | Despliegue | ¿Ve prompts? | Ahorro declarado · evidencia | Tracción |
|---|---|---|---|---|---|---|
| Genosis | SDK en proceso (TS/Py) que reordena bloques para la caché de prefijo y deduplica peticiones; cuenta con la respuesta del proveedor [74] | 0 $ + 20 %, o 299 $/mes + 15 %; prueba de 14 días | SDK + servicio dedicado | No (solo huellas SHA‑256) | 23–70 % [marketing] | 17 descargas npm/mes; fundador único |
| FinOps LLM | Servicio gestionado con línea base firmada y extracto mensual [75] | 15–25 % del ahorro; mínimo 20.000 $/mes de gasto | Servicio | Por defecto no | 40–60 % [marketing] | Sin clientes ni entidad públicos |
| OpenCompress | Gateway de compresión [76] | 10/20/33 % del ahorro neto (sus páginas se contradicen) | SaaS | Sí | 50–70 % [marketing]; mide calidad por similitud coseno | — |
| Tokenade (Francia) | Proxy local para agentes de código [77] | Gratis hasta 10M tokens ahorrados; Pro 24,90 $ + 10 % por encima | Local | No | −38,9 % en THOL, un ranking que mantiene su propio autor [medido, con conflicto de interés] | 2.117 npm/mes |
| Tessera | Proxy con libro de ahorro por petición [78] | Tarifa plana de 0 a 3.999 $ | SaaS | Sí | −60 % en su demo [marketing] | Web desactivada (HTTP 402) |

### 2.7 Observabilidad, FinOps y control de gasto de agentes

| Actor | Qué hace | Precio | Despliegue | ¿Ve prompts? | Ahorro declarado · evidencia | Tracción |
|---|---|---|---|---|---|---|
| Opik Cost Intelligence (Comet) | Demonio local que envía solo metadatos, cuenta con el `usage` del proveedor, ~20 categorías de gasto y políticas en un clic [80] | Función enterprise sin precio; Opik Pro 19 $/mes | Local + SaaS | No | 15–30 % [marketing] | opik 22.251★ |
| Momento «mo» | Gateway para flotas de agentes con «coste autoritativo» y evaluaciones [81] | No encontrado | SaaS o nube del cliente | Sí (con ZDR) | GLM 5.2 a 0,4× el coste de Opus [marketing] | — |
| PointFive TokenShift | FinOps para agentes de código [82] | No publicado | Local + plano de control | Metadatos | 10–20 % [marketing] | Serie B de 60 M$ (8‑jun‑2026); cliente Nubank |
| Faros AI | «Token engineering»: enrutado y coste por tarea [83] | Por consumo | SaaS | n/d | −50 % en un estudio interno [marketing] | — |
| Langfuse / Datadog / Vantage | Trazas y coste, estimado o de facturación [84][85][86] | Langfuse 0–2.499 $/mes; Datadog 160 $/100k spans; Vantage 0–200 $ | SaaS u OSS | Las trazas sí; FinOps no | Miden, no reducen | Langfuse 35.077★ (ahora de ClickHouse [43]) |
| ccusage / CodeBurn | Medición local y gratuita del gasto de agentes; CodeBurn compara lo prometido con lo real [87] | MIT | Local | No | — | 377.689 y 40.125 npm/mes |

### 2.8 Frameworks TypeScript gratuitos (sustituto en proceso)

| Actor | Qué hace | Precio | Despliegue | ¿Ve prompts? | Ahorro declarado · evidencia | Tracción |
|---|---|---|---|---|---|---|
| Vercel AI SDK | Middleware; `toolSearch()` en proceso desde el 16‑sep‑2026; `pruneMessages` [92] | Apache‑2.0 | Librería | No | — | 94,5 M npm/mes |
| Mastra | ResponseCache en proceso (13‑may‑2026), ToolSearch, TokenLimiter, compactación, TokenCostControl (14‑ago‑2026) [93] | Apache‑2.0 | Librería | No | Compactación de 5 a 40× [marketing] | 5,98 M npm/mes |
| LangChain.js v1 | InMemoryCache, breakpoints automáticos para Anthropic, selector de herramientas, resumen, context editing [94] | MIT | Librería | No | «Up to 90%», que es el precio de lectura de Anthropic | 11 M y 21 M npm/mes |

### 2.9 Inferencia barata (compite por el presupuesto; técnicamente es complemento)

| Actor | Qué hace | Precio | Despliegue | ¿Ve prompts? | Ahorro declarado · evidencia | Tracción |
|---|---|---|---|---|---|---|
| Together / Fireworks | Nubes de modelos abiertos, compatibles con OpenAI [105][106] | Ej.: DeepSeek V4.1 Flash a 0,30/1,20 $ | SaaS | Sí | «6–20×» / «8×» [marketing] | Serie C de 800 M$ / 4.000 M$ de valoración |
| DeepSeek API | API de primera parte; fuera de hora punta cuesta la mitad [24] | flash 0,30/1,20 $ (fuera de punta 0,15/0,60) | SaaS | Sí (China) | — | — |

**Lectura del mapa [inferido]:** el gateway y la caché exacta valen 0 $. La compresión está saturada de código abierto viral. Enrutar es la palanca con más ahorro documentado, y BV‑SALA no la tiene como producto. Cobrar por ahorro ya no es exclusivo de nadie. Lo que sigue libre es la **contabilidad verificable del ahorro dentro del proceso**.

---

## 3. Lo que los proveedores ya dan gratis y cuánto valor le quitan a BV‑SALA

| Palanca de BV‑SALA | Qué ofrece ya el mercado sin coste (fecha) | Descuento o efecto | Erosión |
|---|---|---|---|
| Caché de prefijo del proveedor | Anthropic: caché automática con un solo `cache_control` (19‑feb‑2026) [7]. OpenAI: automática, pero desde GPT‑5.6 (9‑jul‑2026) y en toda la familia GPT‑6 (Astra el 3‑sep, Sol y Luna el 22‑sep) escribir cuesta 1,25× [17][19]. Gemini: caché implícita por defecto [22]. Diagnósticos gratis: OpenAI (8‑sep‑2026) y Anthropic (23‑sep‑2026, solo en la Claude API) [8][19] | Lectura a 0,1× (0,05× Opus 5.5; 0,025× Fable 5.1); DeepSeek ~98 % [13][24] | **Total** como mérito propio, algo que BV‑SALA ya asume (#260) [2]. Queda un resto [inferido]: decidir el modo y los breakpoints en GPT‑5.6+/GPT‑6 para no pagar 1,25× en prefijos que nunca se reutilizan, y diagnosticar en Bedrock y Vertex |
| TTL (la palanca PRO del gateway) | Claude Code: 5 min por defecto con clave de API o nube; 1 h solo en suscripción o si se configura a mano (`promptCacheTtl`, v2.1.242). El gateway oficial no admite 1 h [15][16] | Escritura a 2× con 1 h frente a 1,25× con 5 min | **Alta**: el mercado facturable es estrecho (quien eligió 1 h de forma explícita) [inferido] |
| Selector de herramientas | Anthropic tool search (24‑nov‑2025, «>85 %» [marketing]) [11]; OpenAI tool search (5‑mar‑2026) [20]; AI SDK `toolSearch` (16‑sep‑2026) [92]; Mastra ToolSearch (4‑feb‑2026) [93] | Conserva la caché | **Muy alta.** En el banco del 12‑sep el brazo B1 «razonable» ya absorbe el selector (−1,7 % frente a B1) [3]. En el gateway, el 16,4 % era un daño que causaba el propio proxy: Claude Code apaga el tool search si ve un base URL ajeno [2] |
| Compresión de contexto / elisión | Compactación de Anthropic por umbral (5‑feb‑2026) y bajo demanda (14‑sep‑2026) [9]; context editing (29‑sep‑2025) [10]; OpenAI compactación en cliente (11‑dic‑2025) y servidor (~feb‑2026) [20] | Lo hace el proveedor sin romper el prefijo | **Alta**, y además es arriesgada: la elisión propia midió −16,7 % y el patrón de context‑mode −16,73 $ netos [2] |
| Esfuerzo por turno (palanca D) | Effort GA el 5‑feb‑2026; cambio de effort por mensaje sin romper caché: Anthropic (1‑sep‑2026) y OpenAI GPT‑6 (3‑sep‑2026). Claude Code ya lo usa (v2.1.260) [12][15][19] | Recorta la salida, que se cobra a precio de lista | **Alta**: el delta atribuible es solo la diferencia entre el techo del operador y lo que el cliente ya envía [inferido] |
| Serialización compacta (TOON/CSV) | TOON, MIT, 4,83 M descargas/mes [67] | −15 % a −26 % frente a JSON [medido] | La técnica ya es commodity. Lo que queda es la elección automática con «nunca peor que tu JSON» [1] |
| Caché exacta | Cloudflare (gratis), OpenRouter (aciertos a 0 $), LiteLLM y Bifrost (OSS), Mastra ResponseCache y LangChain InMemoryCache (en proceso) [30][39][93][94] | 100 % de la llamada repetida | **Alta**. Y es justo lo que cobra el basis `reference` [inferido; ver §6] |
| Caché semántica | LiteLLM y Bifrost (OSS), LangCache gratis en vista previa, Azure APIM en todos los tiers [31][41][47] | Evidencia débil (§4) | Media. Solo vale si se demuestra la precisión |
| Descuento por diferir | Batch −50 % (OpenAI, Anthropic, Google, Mistral); Flex −50 % (OpenAI; Google desde el 2‑abr‑2026); DeepSeek fuera de punta −50 % [20][23][24] | −50 % | BV‑SALA solo usa Flex de OpenAI (tier diferido). Es una palanca del proveedor que BV‑SALA puede orquestar, no una propia |
| Resolvers deterministas, singleflight | **No encontrado** en proveedores ni frameworks | Evitan la llamada entera | **Ninguna** |
| Informe de ahorro por libros con base declarada | No encontrado. OpenAI da tokens perdidos sin importe [17]; Mastra, coste estimado [93]; Headroom, «estimated/measured» solo del ahorro [69] | — | **Baja** |

**Cuánto valor se lleva esto [inferido].** De las cinco familias de palancas del producto (evitar llamadas, eliminar tokens, comprimir, caché de prefijo, streaming), tres ya las cubren gratis el proveedor o el framework: caché de prefijo, selección de herramientas y compresión de contexto. El streaming es commodity. Lo que conserva valor diferencial es **evitar llamadas** (resolvers, singleflight, caché semántica con verificación) y **la contabilidad**. El banco lo confirma escenario a escenario: aritmética local 100 % (resolver, sin erosión), herramientas 28–30 % (selector, absorbido por B1), FAQ y resumen 0 % [3]. No se puede dar un porcentaje de erosión honesto sin un brazo B2 «nativo bien configurado» (recomendación 3 de §8).

---

## 4. Qué ahorro es creíble

### 4.1 Lo que dicen las mediciones independientes

| Palanca / contexto | Lo que se anuncia | Lo que se mide | Rango creíble [inferido] |
|---|---|---|---|
| Caché de prefijo del proveedor en agentes | «Hasta 90 %» | −41 a −80 % de coste y −13 a −31 % de TTFT en más de 500 sesiones [63] | Alto, pero lo pone el proveedor |
| Comprimir la salida de herramientas en agentes de código | 60–98 % | −38,4 % de tokens y **+6,8 % de coste** (r=0,15 entre tokens y coste) [61]; RTK +7,6 % (p=0,004) [57], +1 % y +17 % [59]; Headroom sin cambio de coste [60] | ≈0 % o negativo |
| Comprimir la salida (estilo) | 50–65 % | Caveman: −8,5 % de salida, ~−10 % de coste, p=0,82 en calidad [56]; Ponytail −10,3 % de coste (p=0,004) [58]; comprimir la salida abarata 1,4–2,4×, comprimir la **entrada lo encarece** ~1,15× [62] | 5–10 % |
| Compresión que respeta la caché | — | CAPC: −49 % frente a usar solo caché [64] | Alto si no se toca el prefijo |
| Caché semántica | 70–90 % | Aciertos del 51–60 % en bruto que bajan al **1,1–2,2 %** ajustados por calidad [65]; −86 % en AWS con un dataset de paráfrasis [91]; con umbral 0,80, solo el 42,2 % de las reutilizaciones son correctas [90] | Bajo, salvo FAQ muy repetitivas; exige verificación |
| Selección de herramientas | «>85 %» | SCOUT: de 140,2k a 1,3k tokens (−99 %) [66] | Alto en tokens; el proveedor ya lo resuelve |
| Enrutado de modelo | 20–75 % | 14–21 % enrutando en las fronteras de sesión [54]; AT&T −56 % con −2 % de rendimiento [34]; los routers comerciales grandes quedan en la mitad baja de RouterArena [50][55] | 15–45 % en código, vigilando la calidad |
| Batch y Flex | 50 % | Aritmética de tarifa de lista | 50 % en lo que se puede diferir |

### 4.2 Lo que dicen los desarrolladores

- **Rechazan los «tokens ahorrados» que no bajan la factura.** «None of these tools measure how effective they are… It's a massive red flag» (Lowfat, 5‑jun‑2026) [96]. Las analíticas de RTK anunciaban 96,2 M de tokens ahorrados mientras la factura subía [57].
- **Rechazan los proxies de terceros.** «There's zero percent chance that I would proxy all my LLM calls with my API key through some third party service» (23‑feb‑2026) [95]. En la encuesta de Stack Overflow 2025, al 81,4 % le preocupa la seguridad y la privacidad con agentes [99].
- **La calidad pesa más que el coste.** Es la primera barrera (32 %) y el coste aparece menos que otros años (LangChain) [100]. Solo el 11 % ha cambiado de proveedor (Menlo) [103].
- **Romper la caché hunde la propuesta.** Las críticas a Tokenless y a Weave fueron exactamente esas [53][97].
- **El gasto es real y ya se pone tope.** 150–250 $/desarrollador/mes con Claude Code [14]; Uber limita a 1.500 $ por empleado y herramienta [102].

### 4.3 Dónde queda el ≥10 % de BV‑SALA y el ~2 % del gateway

- **El ≥10 % es honesto y está dentro de lo que la evidencia sostiene para palancas que no enrutan**, pero es frágil como argumento comercial [inferido]:
  1. Se midió en **gpt‑4o‑mini**, que sigue disponible pero lo supera en precio gpt‑6‑luna (−33 % en entrada, −87 % en entrada cacheada, −17 % en salida), cuya caché descuenta el 90 % frente al 50 % [18][21]. Con otro modelo, la mezcla de palancas cambia.
  2. Son **11 escenarios sintéticos** con peso 1 por escenario: el titular depende de la mezcla (aritmética 100 %, FAQ 0 %). La propia bitácora avisa de que el intervalo «responde a una pregunta más estrecha» [3].
  3. Bajó de ≥23,2 % a ≥10 % porque el escenario de compresión se midió con un compresor que npm no incluye. Está pendiente una tirada `asShipped`, y las credenciales del banco fallan hoy («invalid model ID») [4].
  4. **No hay brazo «nativo bien configurado»** (caché automática, tool search, compactación, effort), que es el contrafactual con el que comparará el comprador técnico.
- **En una comparación rápida pierde**: 20–70 % [marketing] de Genosis, Headroom, Caveman, Edgee y OpenCompress, y el «≥50 % garantizado» de Thesean. **Ante un comprador técnico gana**, porque es la única cifra con IC, basis y datos crudos publicados [1].
- **El ~2 % del gateway** encaja con la evidencia (comprimir en agentes ≈0 %), pero queda por debajo del 10 % garantizado de Copilot [27], del −10,3 % medido de Ponytail [58] y del 14–21 % del enrutado [54]. Sobre 150–250 $/mes, un 2 % son 3–5 $/desarrollador/mes: más o menos lo que cuesta el asiento [inferido].

---

## 5. Posición de BV‑SALA

### 5.1 Qué diferencial es defendible

| Diferencial | ¿Único? | Quién más lo tiene | Veredicto [inferido] |
|---|---|---|---|
| Medición con el contador del proveedor, **basis por cifra** y cuatro libros separados | Solo la combinación | Genosis (solo contador) [74], Headroom (estimated/measured, solo del ahorro) [69], Caveman (inferred/verified, la nube en desarrollo) [68], Opik (usage del proveedor) [80], Momento (coste «autoritativo») [81] | **El más sólido.** Matiz: ~99 % del ahorro del SDK (libros 2 y 3) es estimado, no medido [4] |
| Comisión solo sobre lo medido | No | Genosis, FinOps LLM, OpenCompress, Tokenade [74][75][76][77] | Es la más baja y la más conservadora (solo `reference`). **Ventaja de confianza, no de ingresos** |
| Los prompts no salen de casa | No | LiteLLM, Headroom, Caveman, Genosis, Mastra, context‑mode | Diferencia solo frente a SaaS (OpenRouter, Edgee, Compresr, Vercel, Portkey SaaS). Ojo: el Context Gateway «local» de Compresr envía salidas a su API por defecto [72] |
| SDK dentro del proceso | No | Mastra, LangChain, AI SDK, Headroom, Genosis, middleware de Caveman [68][69][74][92][93][94] | Arquitectura compartida. La brecha es de distribución: 2.939 frente a 94,5 M descargas/mes [109] |
| Singleflight, resolvers deterministas, elección de serialización «nunca peor que JSON» | Sí (no encontrado en otros) | — | Diferencial técnico real, poco visible |

### 5.2 Desventajas

- **Solo TypeScript/Node.** Python llega solo a través del gateway. Headroom mueve 246k descargas PyPI/mes y LiteLLM 89 M [69][31].
- **Sin free tier ni trial.** El free tier se cerró de forma explícita (#314) [4], mientras Genosis, Tokenade, Edgee, Compresr, Opik, LiteLLM Enterprise y RTK Pro tienen tier gratis, prueba o crédito.
- **Fail‑closed.** La licencia se verifica offline, pero el gateway no arranca sin clave de servicio [4]. Añade fricción en la primera prueba y un riesgo de disponibilidad que el comprador percibirá [inferido].
- **Ahorro modesto y provisional**, medido con un modelo de 2024 (§4.3).
- **Sin tracción.** 2.939 descargas npm/mes y 4 licencias PRO vivas a 12‑sep. La cadena de cobro no se había probado en producción [3]. La CI de publicación falla con EOTP [4]. La medición con Anthropic está bloqueada por un límite de uso hasta el 1‑oct [3].
- **El gateway puede degradar funciones nativas.** Apagaba el tool search, y el arreglo solo llega a ventanas nuevas [2].
- **Catálogo de precios incompleto** a 26‑sep (origin/main `f157462`): no están `claude-opus-5-5` ni la familia `gpt-6-*`, y la prima de escritura de 1,25× solo se aplica a `gpt-5.6` [5]. **Corrección al material de investigación:** estos modelos no se tarifan mal por herencia de prefijo, porque la regla de «versión menor» lo impide. Caen al respaldo ilustrativo, que avisa. Eso significa que los modelos insignia actuales no se miden a precio oficial [5].

### 5.3 Directo, sustituto o complemento

| Tipo | Actores |
|---|---|
| **Competidor directo** (mismo comprador, mismo punto de la arquitectura, mismo argumento) | SDK: **Genosis, Headroom, Caveman (+nube), FinOps LLM, OpenCompress**, Tessera (inactivo). Terminales: **Tokenade, Opik Cost Intelligence, Weave Router, Not Diamond Code, Edgee, PointFive TokenShift, RTK Pro, context‑mode Insight** |
| **Sustituto** (resuelve el mismo presupuesto sin BV‑SALA) | Funciones nativas (Anthropic, OpenAI, Google, Claude Code); frameworks (Mastra, LangChain, AI SDK); gateways (LiteLLM, Vercel, Cloudflare, Prisma AIRS, OpenRouter); routers (Thesean, Cursor, Copilot Auto, Azure); proveedores baratos (DeepSeek, Together, gpt‑6‑luna) |
| **Complemento** | Observabilidad (Langfuse, Datadog, Braintrust); FinOps (Vantage, CloudZero, Finout); evaluación (promptfoo, DeepEval); gateways usados como `base_url` (LiteLLM, OpenRouter, Vercel); librerías (TOON, LLMLingua); medidores gratuitos como línea base (ccusage, CodeBurn); contabilidad por petición de OpenRouter para conciliar |

---

## 6. Modelo de precio

### 6.1 Cómo cobra el mercado

| Modelo | Ejemplos | ¿Alineado con el ahorro del cliente? |
|---|---|---|
| % sobre el gasto | OpenRouter 5,5 % (8 % en Business), Requesty 5 %, Cloudflare 5 % sobre créditos, Edgee 5 %, Orq 4–4,5 % [30][39][45][46] | No: ganan más cuanto más gasta el cliente |
| 0 % de margen | Vercel AI Gateway [28] | Neutral; monetizan complementos |
| Por log o petición | Portkey 49 $ + 9 $/100k; Helicone 79–799 $; Langfuse 29–2.499 $; Fastly 0,40–0,28 $/1.000 [36][48][86] | Neutral |
| Por asiento | Dash0 10 $, context‑mode 20 $, TrueFoundry 25 $, Edgee 30 $, Weave 50 $, LangSmith 39 $ [45][53][71] | Neutral |
| Por token enrutado o procesado | Not Diamond 0,05 $/M, Azure 0,14 $/M, Compresr 0,10 $/M, Paritok 0,30 $/M [25][49][72][73] | Neutral |
| **% del ahorro** | Genosis 20 % o 299 $ + 15 %; FinOps LLM 15–25 %; OpenCompress 10–33 %; Tokenade 10 % por encima del tope; en FinOps de nube, Usage.ai 20 % y ProsperOps 30–35 % (según Vendr) [74][75][76][77][88] | Sí |
| Resultado garantizado | Thesean «≥50 %» con SLA, solo en contratos enterprise [51] | Sí en teoría; los términos dicen «AS IS» |

### 6.2 ¿«Asiento + % del ahorro medido» es una ventaja o una fricción?

**Como señal es una ventaja; como modelo de ingresos, una fricción.**

- **Ventaja.** Es la comisión más baja entre quienes cobran por ahorro y la única que se niega a cobrar lo estimado. Encaja con lo que pide el comprador técnico (§4.2).
- **Fricción 1: la base cobrable es casi nula.** Solo se cobra el basis `reference` (repetición idéntica). Eso supone entre ~0,5 €/mes (agentes) y ~140 €/mes (FAQ determinista) por cada 10.000 $ de gasto, y **~12 € en una mezcla típica de API** [4]: un 0,12 % del gasto, menos que el 5 % de cualquier gateway.
- **Fricción 2: lo que se cobra es caché exacta**, que otros dan gratis (OpenRouter factura los aciertos a 0 $, Cloudflare, Mastra, LangChain). El comprador puede verlo como un peaje sobre algo gratuito [inferido].
- **Fricción 3: se paga antes de ver el ahorro.** El mes de calibración sin comisión no evita pagar el asiento, y todos los demás ofrecen alguna forma de probar gratis.
- **Fricción 4: el umbral de rentabilidad.** Con el tramo del 10 %, el cliente gana si el ahorro medido supera ~4,44 €/asiento/mes (0,9·S > 4 €). Con un 10 % de ahorro hace falta una factura de ≥ ~44 €/asiento/mes; con el 2 % del gateway, de ≥ ~222 €/asiento/mes [inferido, sin conversión USD/EUR].
- **Fricción 5: cuesta explicarlo.** Asiento + tramos + cuatro bases, frente a «0 % de margen» o «pagas el 20 % de lo que ahorras».

### 6.3 Recomendación de precio

1. **Separar las dos ofertas**, algo que ya prepara #325 [4]:
   - **SDK para apps con API:** mantener **4 €/asiento**, que está por debajo de los 10–30 $/asiento del mercado, y la comisión **10/8/6/4 % solo sobre `measured` y `reference`**. Presentar la comisión como **garantía** («nunca pagas por un ahorro que no puedas cuadrar con tu factura»), no como fuente de ingresos. No subirla. Publicar la comparación con Genosis y FinOps LLM.
   - **Gateway de terminales:** la **medición debe ser gratuita**, porque compite con `/usage`, ccusage y CodeBurn, que ya lo son. PRO solo cuando la palanca de TTL o de esfuerzo demuestre ahorro con holdout en el tráfico del propio cliente.
2. **Abrir la entrada con una licencia gratuita «Medir», sin tarjeta.** El SDK funcionaría en sombra, calculando con basis lo que habría ahorrado y sin palancas que cambien el contenido, para 1 organización y un tope de asientos. Se pasa a pago al activar palancas. Sigue siendo una licencia firmada, así que no rompe el fail‑closed [inferido]. **Revierte #314, y esa decisión le corresponde al dueño.**
3. **El ingreso tiene que salir de asientos y de un plan de equipo o enterprise**, por ejemplo una auditoría de ahorro con precio fijo, al estilo de la auditoría de FinOps LLM o del kit de evaluación de Microsoft [25][75], no de la comisión [inferido].
4. **Fusionar #320**, que retira el «solo ganamos si ahorras». Con una base cobrable tan pequeña esa frase se vuelve engañosa, y el README de `main` todavía dice «We only earn when you save» [1][4].

---

## 7. Riesgos

| Riesgo | Probabilidad | Impacto | Señal temprana | Mitigación |
|---|---|---|---|---|
| El proveedor absorbe las palancas (caché, herramientas, compactación, esfuerzo, diagnóstico) | **Alta** (ya está pasando) | **Alto** | Nuevas betas de Anthropic y OpenAI cada 2–4 semanas [7][19] | Orquestar lo nativo y medirlo (§8 n.º 9); centrarse en evitar llamadas y en la contabilidad |
| Los frameworks gratuitos (Mastra, LangChain, AI SDK) cubren el «SDK en proceso» | **Alta** | **Alto** | ResponseCache y toolSearch ya publicados [92][93] | Distribuirse como adaptador dentro de ellos (§8 n.º 8) |
| Gateways gratuitos u OSS commoditizan la caché y la medición | **Alta** | Medio | 0 % de margen en Vercel; caché gratis en Cloudflare [28][30] | No vender la caché exacta como valor central |
| Caveman o Genosis ocupan el «ahorro verificado» | Media | **Alto** | Lanzamiento de la nube de Caveman con precio [68] | Publicar antes el método y la comparación con basis (§8 n.º 3–4) |
| Un tercero mide BV‑SALA y le sale ≈0 % o negativo | Media | **Alto** | Series de JetBrains y Quesma, THOL [56][57][59][77] | Adelantarse invitando la medición (§8 n.º 4) |
| El modelo de ingresos no cubre el coste de adquisición | **Alta** | **Alto** | ~12 €/mes por 10.000 $ de gasto [4] | Reorganizar el precio (§6.3) |
| Deflación de precios (10× al año según a16z; 9–900× según Epoch) que encoge la base del ahorro | **Alta** | Medio | gpt‑6‑luna, DeepSeek fuera de punta [18][24][110] | Vender control y auditoría, no un porcentaje |
| Incidente de cadena de suministro en npm | Baja‑media | **Muy alto** (contradice la promesa de privacidad) | Caso LiteLLM, 24‑mar‑2026 [32] | Trusted publishing, provenance, SBOM (§8 n.º 7) |
| Error de precio o de contabilidad por catálogo desfasado | Media | Alto (cobrar o anunciar mal) | Modelos nuevos sin fila [5]; `usage.iterations` no se lee en la compactación [9] | Catálogo con fechas de vigencia y test que falle (§8 n.º 1) |
| Dependencia de betas de Anthropic (palanca D, S4a) | Media | Medio | Cambios de umbrales o de cabeceras [10][12] | Regla del delta y pruebas de regresión |
| El comprador enterprise prefiere el gateway de su contrato de seguridad | Media | Medio | Prisma AIRS en GA (16‑jul‑2026) [35] | Coexistir: SDK delante de su `base_url` |

---

## 8. Recomendaciones priorizadas (por impacto y esfuerzo)

1. **Cuidar la verdad antes que nada: catálogo, cifras y promesas.**
   *Por qué:* la credibilidad es el único activo diferencial. Añadir `claude-opus-5-5` y `gpt-6-*` con fechas de vigencia (Gemini 3.8 Flash dobla su precio el 1‑ene‑2027 [22]), aplicar la prima de 1,25× a GPT‑6, sumar `usage.iterations` cuando haya compactación [9], fusionar #320 y retirar cualquier afirmación de unicidad sin fecha ni método. Frase propuesta: «A 26‑sep‑2026 no encontramos otro SDK en proceso que combine…».
   *Esfuerzo:* S. *Señal de éxito:* un test que falle si un modelo servido no tiene fila, y cero afirmaciones sin fuente en la web.

2. **Enfocar la oferta: el SDK para apps con API es el producto y el gateway es el medidor gratuito.**
   *Por qué:* el ~2 % no compite (§4.3) y el SDK es donde se evitan llamadas enteras. #325 ya lo prepara.
   *Esfuerzo:* S. *Señal:* la portada con dos ofertas, el gateway sin cifra y la conversión desde el gateway al SDK.

3. **Rehacer el banco A/B `asShipped` con modelos de 2026 y un brazo B2 «nativo bien configurado».**
   *Por qué:* ninguna otra acción responde mejor a «¿cuánto aporta sobre lo que ya es gratis?». Modelos: gpt‑6‑luna, Sonnet 5 o Haiku 4.5, Gemini 3.x Flash y uno abierto. Arreglar antes las credenciales [4].
   *Esfuerzo:* S–M (≈3 $ por tirada con el presupuesto actual) [4]. *Señal:* suelo del IC publicado frente a B2. Si sale < 5 %, reescribir el mensaje hacia la contabilidad.

4. **Invitar a una medición independiente, filas en rojo incluidas.**
   *Por qué:* JetBrains, Quesma y THOL ya miden a los competidores [56][57][59][77]. Mejor que midan a BV‑SALA por invitación que por sorpresa.
   *Esfuerzo:* S, después de la n.º 3. *Señal:* un resultado de un tercero publicado con IC.

5. **Licencia gratuita «Medir», sin tarjeta.**
   *Por qué:* todos los competidores permiten probar gratis. El mes de calibración ya mide, pero cobra el asiento.
   *Esfuerzo:* M. *Señal:* activaciones por semana y porcentaje que pasa a pago tras 30 días.

6. **Garantía pública de «no empeorar» en el gateway.**
   *Por qué:* el proxy apagaba el tool search [2], el TTL de 1 h depende de reenviar `anthropic-beta` y perder `cache_control` factura sin caché [15]. Un test público que demuestre que se conservan `tool_reference`, TTL, `cache_control` y el advisor es algo que ningún gateway ofrece.
   *Esfuerzo:* S–M. *Señal:* el test en CI y la alerta en el panel cuando llega tráfico degradado.

7. **Cadena de suministro y disponibilidad.**
   *Por qué:* el caso LiteLLM [32]. Hacen falta trusted publishing o token de automatización (arregla el EOTP [4]), npm provenance, SBOM y documentar qué pasa si cae el servidor de revocación.
   *Esfuerzo:* S–M. *Señal:* publicación desde CI en verde y el badge de provenance en npm.

8. **Adaptadores para AI SDK (LanguageModelMiddleware), Mastra (processor), LangChain (middleware) y el middleware del SDK de Anthropic.**
   *Por qué:* audiencias de 6 a 150 M de descargas al mes [92][93][94]. Es la manera de dejar de competir con ellos.
   *Esfuerzo:* M. *Señal:* descargas de los adaptadores y porcentaje de instalaciones que llegan por ellos.

9. **Orquestar palancas nativas de precio que se pueden medir.**
   *Por qué:* añaden ahorro que el contador del proveedor refleja: Flex de Gemini y de Bedrock, DeepSeek fuera de punta, Batch y el modo explícito sin breakpoints en GPT‑5.6+/GPT‑6 para no pagar 1,25× en prefijos que no se reutilizan [17][23][24] [inferido: tendrían basis `measured`].
   *Esfuerzo:* M. *Señal:* ahorro con basis `measured` por encima del 1 % de la factura en clientes con carga diferible.

10. **Un quinto libro, el de calidad, y precisión publicada de la caché semántica.**
    *Por qué:* nadie publica la calidad por petición. Medirse contra vCache SemBenchmark y las 1.536 tripletas de GPTCache (JEV 99,7 % / 72,1 %) [89][90], y dejar la caché semántica desactivada por defecto en tráfico agéntico, como aconseja LiteLLM [31].
    *Esfuerzo:* M. *Señal:* precisión y recall publicados con IC.

11. **Exportar los libros a OTel GenAI, Langfuse, Datadog y FinOps (Vantage, CloudZero).**
    *Por qué:* esas plataformas miden el gasto pero no tienen dónde apuntar el ahorro [84][85][86].
    *Esfuerzo:* M. *Señal:* una integración oficial listada.

12. **SDK Python nativo (o plugin de LiteLLM), solo si las n.º 5 y 8 dan señal.**
    *Por qué:* es el mercado mayor [31][69], pero cuesta mucho sin tracción previa.
    *Esfuerzo:* L. *Señal:* demanda explícita de clientes de pago.

---

## 9. Fuentes

**Método.** Investigación verificada el 26‑sep‑2026 abriendo cada fuente primaria (webs, documentación, changelogs, arXiv, API de GitHub, npm, PyPI, HN y SEC EDGAR). El cupo de búsqueda web estaba agotado, así que la cobertura de productos cerrados, y sobre todo de actores hispanohablantes, es parcial. Contradicciones resueltas: Portkey se cerró el 29‑may‑2026 por 117 M$ (10‑K); la compra de OpenRouter por Stripe está acordada y no cerrada; la de Katanemo por DigitalOcean se confirmó el 2‑abr‑2026; Not Diamond es 12.º de 12 en el paper de RouterArena y 28.º de 32 en el ranking vivo; «nadie cobra por ahorro» es falso.

**Internas**
1. README de `@bivelio/savings-layer`, repo bsl-comprador, origin/main `f157462` (26‑sep‑2026). [interno]
2. docs/BITACORA-2026-09-10.md (10‑sep‑2026). [interno, medido]
3. docs/BITACORA-2026-09-12.md (12‑sep‑2026). [interno, medido]
4. docs/BITACORA-2026-09-26.md, rama origin/docs/bitacora-2026-09-26 (23–26‑sep‑2026). [interno]
5. `src/pricing/catalogo.ts` y `primas.ts` en origin/main `f157462` (26‑sep‑2026). [interno, verificado]

**Proveedores**
6. Anthropic, Prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching (26‑sep‑2026)
7. Anthropic, notas de versión de la API: https://platform.claude.com/docs/en/release-notes/api (26‑sep‑2026)
8. Anthropic, Cache diagnostics: https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics (GA 23‑sep‑2026)
9. Anthropic, Compaction: https://platform.claude.com/docs/en/build-with-claude/compaction (26‑sep‑2026)
10. Anthropic, Context editing: https://platform.claude.com/docs/en/build-with-claude/context-editing ; https://claude.com/blog/context-management (29‑sep‑2025) [marketing en las cifras]
11. Anthropic, Tool search: https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool ; https://www.anthropic.com/engineering/advanced-tool-use (24‑nov‑2025) [marketing]
12. Anthropic, Effort / Advisor / Task budgets: https://platform.claude.com/docs/en/build-with-claude/effort ; https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool ; https://platform.claude.com/docs/en/build-with-claude/task-budgets (26‑sep‑2026)
13. Anthropic, Pricing: https://platform.claude.com/docs/en/about-claude/pricing (26‑sep‑2026)
14. Claude Code, Costs: https://code.claude.com/docs/en/costs (26‑sep‑2026)
15. Claude Code, Prompt caching: https://code.claude.com/docs/en/prompt-caching (26‑sep‑2026)
16. Claude apps gateway: https://code.claude.com/docs/en/claude-apps-gateway (26‑sep‑2026)
17. OpenAI, Prompt caching: https://developers.openai.com/api/docs/guides/prompt-caching (26‑sep‑2026)
18. OpenAI, Pricing: https://developers.openai.com/api/docs/pricing (26‑sep‑2026)
19. OpenAI, Changelog: https://developers.openai.com/api/docs/changelog (26‑sep‑2026)
20. OpenAI, Compaction / Tool search / Flex: https://developers.openai.com/api/docs/guides/compaction ; https://developers.openai.com/api/docs/guides/tools-tool-search ; https://developers.openai.com/api/docs/guides/flex-processing (26‑sep‑2026)
21. OpenAI, Deprecations: https://developers.openai.com/api/docs/deprecations (26‑sep‑2026)
22. Google, Gemini caching y precios: https://ai.google.dev/gemini-api/docs/caching (act. 2‑sep‑2026) ; https://ai.google.dev/gemini-api/docs/pricing
23. Google, Flex y Priority: https://blog.google/innovation-and-ai/technology/developers-tools/introducing-flex-and-priority-inference/ (2‑abr‑2026)
24. DeepSeek, Pricing: https://api-docs.deepseek.com/quick_start/pricing (26‑sep‑2026)
25. Microsoft Foundry Model Router y guía de evaluación: https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-router (1‑sep‑2026) ; https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/evaluate-model-router (20‑ago‑2026)
26. AWS Bedrock Intelligent Prompt Routing: https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-routing.html ; https://aws.amazon.com/bedrock/intelligent-prompt-routing [marketing «up to 30%»]
27. GitHub Copilot, Auto model selection: https://docs.github.com/en/copilot/concepts/auto-model-selection (26‑sep‑2026) ; https://github.blog/changelog/2026-07-01-copilot-cli-auto-model-selection-routes-based-on-task/ (1‑jul‑2026)

**Gateways y caché**
28. Vercel AI Gateway: https://vercel.com/docs/ai-gateway/models-and-providers/automatic-caching (11‑sep‑2026) ; https://vercel.com/docs/ai-gateway/pricing (8‑sep‑2026)
29. D. Ternyak: https://www.danielternyak.com/articles/vercel-ai-gateway-downgrades-anthropic-prompt-cache (22‑jun‑2026) [medido]
30. Cloudflare AI Gateway: https://developers.cloudflare.com/ai-gateway/reference/pricing/ (24‑sep‑2026) ; https://developers.cloudflare.com/ai-gateway/features/caching/ (27‑ago‑2026)
31. LiteLLM, caché semántica: https://docs.litellm.ai/docs/proxy/caching_semantic (26‑sep‑2026)
32. LiteLLM, actualización de seguridad: https://docs.litellm.ai/blog/security-update-march-2026 (mar‑2026)
33. LiteLLM, Auto Router en producción: https://docs.litellm.ai/blog/auto-router-production-savings (10‑ago‑2026) [marketing con método]
34. PYMNTS, AT&T: https://www.pymnts.com/news/artificial-intelligence/2026/att-slashes-ai-costs-by-adopting-model-routers-and-open-source/ (20‑ago‑2026) [medido por el cliente]
35. Palo Alto Networks, compra de Portkey completada: https://www.paloaltonetworks.com/company/press/2026/palo-alto-networks-completes-acquisition-of-portkey-to-secure-ai-agents (29‑may‑2026) ; 10‑K: https://www.sec.gov/Archives/edgar/data/0001327567/000132756726000023/panw-20260731.htm
36. Portkey, precios: https://portkey.ai/pricing (26‑sep‑2026)
37. Helicone se une a Mintlify: https://www.helicone.ai/blog/joining-mintlify (3‑mar‑2026)
38. Stripe acuerda comprar OpenRouter: https://stripe.com/newsroom/news/stripe-agrees-to-acquire-openrouter (19‑ago‑2026) ; https://openrouter.ai/blog/announcements/openrouter-is-joining-stripe
39. OpenRouter, FAQ y precios: https://openrouter.ai/docs/faq ; https://openrouter.ai/pricing (26‑sep‑2026)
40. TensorZero (sin mantenimiento): https://www.tensorzero.com/ (26‑sep‑2026)
41. Bifrost: https://github.com/maximhq/bifrost (26‑sep‑2026)
42. DigitalOcean compra Katanemo: https://investors.digitalocean.com/news/news-details/2026/DigitalOcean-Acquires-Katanemo-Labs-to-Accelerate-the-Inference-Cloud-for-the-Agentic-Era/default.aspx (2‑abr‑2026)
43. ClickHouse compra Langfuse: https://clickhouse.com/blog/clickhouse-acquires-langfuse-open-source-llm-observability (16‑ene‑2026)
44. Kong, AI Prompt Compressor y precios: https://developer.konghq.com/plugins/ai-prompt-compressor/ ; https://konghq.com/pricing (26‑sep‑2026)
45. Edgee: https://www.edgee.ai/pricing ; https://www.edgee.ai/blog/posts/introducing-compressor-v2-three-compression-layers-measured-end-to-end-for-a-50-cost-reduction (2‑jul‑2026) [marketing con método]
46. Requesty, precios: https://www.requesty.ai/pricing (26‑sep‑2026)
47. Redis LangCache: https://redis.io/langcache/ ; https://redis.io/calculator/langcache/ (26‑sep‑2026) [marketing]
48. Fastly AI Accelerator: https://www.fastly.com/products/ai-accelerator ; https://www.fastly.com/pricing (26‑sep‑2026)

**Routers**
49. Not Diamond, precios: https://www.notdiamond.ai/pricing (26‑sep‑2026) [marketing]
50. RouterArena: https://github.com/RouteWorks/RouterArena (ranking del 29‑ago‑2026) ; https://arxiv.org/abs/2510.00202 (30‑sep‑2025) [medido]
51. Thesean Ship y sus términos: https://thesean.ai/blog/introducing-ship (21‑jul‑2026) ; https://thesean.ai/terms-of-service (10‑jul‑2026) [marketing]
52. Cursor Router: https://cursor.com/blog/router (22‑jul‑2026) [marketing, A/B propio]
53. Weave Router: https://github.com/weave-os/router ; https://weaveos.com/pricing ; HN https://news.ycombinator.com/item?id=48688700 (26‑jun‑2026)
54. arXiv 2609.28919, enrutado en fronteras de sesión: https://arxiv.org/abs/2609.28919 (24‑sep‑2026) [medido]
55. LLMRouterBench (arXiv 2601.07206, 12‑ene‑2026) ; Routing Plateau: https://arxiv.org/html/2606.07587v1 (27‑may‑2026) [medido]

**Compresión y agentes: evidencia**
56. JetBrains, Caveman: https://blog.jetbrains.com/ai/2026/07/speak-to-ai-agents-like-cavemen-tosave-tokens/ (jul‑2026) [medido]
57. JetBrains, RTK: https://blog.jetbrains.com/ai/2026/07/rtk-claude-code-token-savings/ (jul‑2026) [medido]
58. JetBrains, Ponytail: https://blog.jetbrains.com/ai/2026/07/ponytail-skill-claude-tested/ (jul‑2026) [medido]
59. Quesma, RTK: https://quesma.com/blog/does-rtk-make-ai-coding-cheaper/ (11‑sep‑2026) [medido; parte interesada]
60. B. Barker, Headroom: https://brandonbarker.me/writing/headroom-fewer-tokens-bigger-bill (28‑jul‑2026) [medido]
61. arXiv 2607.12161, «Token Reduction Is Not Cost Reduction»: https://arxiv.org/abs/2607.12161 (13‑jul‑2026) [medido]
62. arXiv 2606.24083, CAVEWOMAN: https://arxiv.org/abs/2606.24083 (23‑jun‑2026) [medido]
63. arXiv 2601.06007, «Don't Break the Cache»: https://arxiv.org/abs/2601.06007 (v2 31‑ene‑2026) [medido]
64. arXiv 2607.15516, CAPC: https://arxiv.org/abs/2607.15516 (17‑jul‑2026) [medido]
65. arXiv 2608.20280, desalojo en caché semántica: https://arxiv.org/abs/2608.20280 (20‑ago‑2026) [medido]
66. arXiv 2608.23992, SCOUT: https://arxiv.org/abs/2608.23992 (25‑ago‑2026) [medido]
67. TOON: https://github.com/toon-format/toon (v4.1.1, 5‑ago‑2026) [marketing] ; The Orange Force: https://theorangeforce.com/the-orange-force-news/toon-token-efficiency-useful-cases/ (16‑feb‑2026) [medido] ; ImprovingAgents: https://www.improvingagents.com/blog/toon-benchmarks/ (28‑oct‑2025) [medido] ; arXiv 2605.29676 (28‑may‑2026) [medido]

**Compresión y agentes: productos**
68. Caveman: https://github.com/JuliusBrussee/caveman ; https://caveman.so (act. 5‑sep‑2026) [marketing]
69. Headroom: https://github.com/headroomlabs-ai/headroom (v0.39.0, 25‑sep‑2026) [marketing]
70. RTK / RTK Pro: https://github.com/rtk-ai/rtk ; https://pro.rtk-ai.app/ (26‑sep‑2026)
71. context-mode: https://github.com/mksglu/context-mode ; https://context-mode.com/insight (26‑sep‑2026)
72. The Token Company y Compresr: https://thetokencompany.com/pricing ; https://compresr.ai ; https://github.com/Compresr-ai/Context-Gateway (26‑sep‑2026) [marketing]
73. Paritok: https://github.com/Paritok-official/paritok-4b-v1 (26‑sep‑2026)

**Cobro por ahorro**
74. Genosis: https://usegenosis.ai/pricing ; HN https://news.ycombinator.com/item?id=47516438 (25‑mar‑2026) [marketing]
75. FinOps LLM: https://finopsllm.com/pricing (26‑sep‑2026) [marketing]
76. OpenCompress: https://www.opencompress.ai ; https://opencompress.mintlify.app/billing/pricing (26‑sep‑2026) [marketing]
77. Tokenade y THOL: https://tokenade.net ; https://pi-infected.github.io/token-harness-optimizer-leaderboard/ (26‑sep‑2026) [medido con conflicto de interés]
78. Tessera: https://github.com/tessera-llm/tessera-sdk (último push 10‑ago‑2026)
79. Observ.dev en HN: https://news.ycombinator.com/item?id=46106854 (1‑dic‑2025)

**Observabilidad y FinOps**
80. Opik Cost Intelligence: https://www.comet.com/docs/opik/cost-intelligence (26‑sep‑2026) [marketing]
81. Momento mo: https://gomomento.ai/blog/introducing-mo-enterprise-control-plane-ai-models/ (10‑ago‑2026)
82. PointFive TokenShift: https://www.pointfive.co/press/pointfive-launches-ai-efficiency-os-tokenshift ; https://www.pointfive.co/press/pointfive-raises-60m-series-b (8‑jun‑2026)
83. Faros AI: https://www.faros.ai/ (26‑sep‑2026) [marketing]
84. Datadog, coste en LLM Observability: https://docs.datadoghq.com/llm_observability/monitoring/cost/ (26‑sep‑2026)
85. Vantage, conexión con Anthropic: https://docs.vantage.sh/connecting_anthropic (26‑sep‑2026)
86. Langfuse, precios: https://langfuse.com/pricing (26‑sep‑2026)
87. ccusage y CodeBurn: https://github.com/ccusage/ccusage ; https://github.com/getagentseal/codeburn (26‑sep‑2026)
88. ProsperOps / Vendr / Usage.ai: https://www.prosperops.com/pricing/ ; https://www.vendr.com/buyer-guides/prosperops (feb‑2026) ; https://www.usage.ai/blogs/aws/guides/usage-ai/how-to-use-savings-calculator/ (2‑jun‑2026)

**Caché semántica: evidencia**
89. vCache: https://arxiv.org/abs/2502.03771 (v5 21‑feb‑2026, ICLR 2026) [medido]
90. GPTCache, benchmark reuse_compatibility: https://github.com/zilliztech/GPTCache/blob/main/examples/benchmark/reuse_compatibility/README.md (22‑sep‑2026) [medido por el proyecto]
91. AWS ElastiCache, benchmarks de caché semántica: https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/semantic-caching-benchmarks.html (26‑sep‑2026) [medido por el proveedor]

**Frameworks**
92. Vercel AI SDK: https://ai-sdk.dev/docs/ai-sdk-core/tool-search ; https://registry.npmjs.org/ai (7.0.104, 16‑sep‑2026)
93. Mastra: https://mastra.ai/reference/processors/response-cache ; https://github.com/mastra-ai/mastra/blob/main/packages/core/CHANGELOG.md (26‑sep‑2026)
94. LangChain.js, middleware incluido: https://docs.langchain.com/oss/javascript/langchain/middleware/built-in (26‑sep‑2026)

**Voz de los desarrolladores y encuestas**
95. HN, AgentReady: https://news.ycombinator.com/item?id=47122083 (23‑feb‑2026)
96. HN, Lowfat: https://news.ycombinator.com/item?id=48409955 (5‑jun‑2026)
97. HN, Tokenless: https://news.ycombinator.com/item?id=49099143 (29‑jul‑2026)
98. HN, LiteLLM: https://news.ycombinator.com/item?id=45903485 (19‑nov‑2025)
99. Stack Overflow Developer Survey 2025, IA: https://survey.stackoverflow.co/2025/ai
100. LangChain, State of Agent Engineering: https://www.langchain.com/state-of-agent-engineering (encuesta de nov–dic‑2025)
101. CloudZero, State of AI Costs: https://www.cloudzero.com/state-of-ai-costs/ (mar‑2025)
102. TechCrunch: https://techcrunch.com/2026/06/02/uber-caps-employee-ai-spending-after-blowing-through-budget-in-four-months/ (2‑jun‑2026) ; https://techcrunch.com/2026/06/05/the-token-bill-comes-due-inside-the-industry-scramble-to-manage-ais-runaway-costs/ (5‑jun‑2026)
103. Menlo Ventures: https://menlovc.com/perspective/stripe-to-acquire-openrouter-why-everyone-is-obsessed-with-model-routing/ (19‑ago‑2026) ; informe de mitad de año 2025 (31‑jul‑2025; URL no incluida en el material)
104. Quesma, Tokenomicon: https://quesma.com/blog/inside-the-first-tokenomicon-amsterdam/ (sep‑2026)

**Inferencia barata y contexto de mercado**
105. Together AI: https://www.together.ai/blog/announcing-our-series-c (1‑jul‑2026) [marketing] ; https://www.together.ai/pricing
106. Fireworks AI: https://fireworks.ai/blog/series-c (28‑oct‑2025) [marketing]
107. Groq y Cerebras, caché de prompts: https://console.groq.com/docs/prompt-caching ; https://inference-docs.cerebras.ai/capabilities/prompt-caching (26‑sep‑2026)
108. Alibaba Model Studio, precios: https://www.alibabacloud.com/help/en/model-studio/model-pricing (24‑sep‑2026)
109. API de descargas de npm y pypistats: https://api.npmjs.org/downloads/point/last-month/@bivelio/savings-layer (y un endpoint análogo por paquete; ventana del 27‑ago al 25‑sep‑2026) ; https://pypistats.org
110. Epoch AI (12‑mar‑2025) y a16z, «LLMflation» (12‑nov‑2024), sobre la deflación del precio por capacidad (URLs no incluidas en el material)