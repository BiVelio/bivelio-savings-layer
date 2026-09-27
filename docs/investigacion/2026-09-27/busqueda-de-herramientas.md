# Búsqueda de herramientas: la del proveedor frente al selector del SDK

**Fecha:** 2026-09-27 · **Línea:** `busqueda-de-herramientas` · **Rama:** `feat/busqueda-de-herramientas-nativa`
**Producto:** `@bivelio/savings-layer` 0.4.25 (sin cambio de versión)
**Etiquetas:** **[doc]** = documentación oficial vigente; **[marketing]** = cifra del propio vendedor; **[medido]** = medición con método; **[inferido]** = conclusión de este análisis. Las citas [n] remiten a §9.

---

## 1 · La pregunta

Con catálogos grandes de herramientas (varios servidores MCP, cientos de definiciones), ¿cuándo conviene la búsqueda de herramientas **nativa** del proveedor (Anthropic `tool_search_tool_*` + `defer_loading`; OpenAI `tool_search`) y cuándo el **selector propio** del SDK? ¿Cómo se orquesta para usar la nativa donde gana **sin romper el prefijo cacheado** (la ley de la bitácora del 10-09: podar a mitad del prompt rompe la caché) y caer en el selector donde no?

## 2 · Conclusión

1. **Donde existe, la nativa de Anthropic resuelve el choque que el selector solo apaña.** El proveedor saca las diferidas del prefijo y añade las encontradas al final de la conversación, así que el prefijo no cambia ni con la pregunta ni cuando el catálogo crece [1][2]. El selector tiene que congelar el conjunto para no romper la caché y, con un catálogo sin `intents` ni `risk` (el caso de todos los catálogos MCP del corpus [10]), solo manda las 8 primeras herramientas por posición: el modelo no puede llamar a las demás y nada lo avisa.
2. **En dinero la respuesta depende del tráfico y no se puede suponer.** Con la caché caliente, mandar el catálogo entero cuesta poco (0,1× o 0,05×), y cada búsqueda carga definiciones a precio completo. La verja de `auto` solo enciende la nativa cuando sale a cuenta en el peor caso. En el corpus propio, la búsqueda de Claude Code valió el 16,4 % de la factura [10]. Ese es el techo observado, no una promesa.
3. **OpenAI no aplica al SDK hoy.** Su búsqueda existe en las APIs Responses y Agents, no en Chat Completions, que es lo que habla nuestro adaptador [4].
4. **No es un ahorro nuestro.** Se orquesta, se cuenta en la traza y no se acredita en ningún libro, ni en la comisión ni en el registro por referencia.
5. **Se construye hoy, opt-in:** `savings.toolSearch: "auto" | "always" | { mode, alwaysLoaded, variant }`. Con la palanca apagada, el SDK avisa una vez cuando el selector está recortando un catálogo sin tipar en un proveedor y un modelo que admiten la nativa.

## 3 · Hallazgos

### H1 · Anthropic: cómo funciona, dónde y con qué límites [doc] [1][2]

- **Mecanismo.** Se manda **todo** el catálogo en `tools` en cada petición, con `defer_loading: true` en las que no deben cargarse de entrada, más una herramienta de búsqueda (`tool_search_tool_regex_20251119` o `tool_search_tool_bm25_20251119`). Al menos una herramienta, normalmente la de búsqueda, tiene que ir sin diferir. El modelo busca, la API devuelve `tool_reference` (5 por defecto; `limit` hasta 10.000) y las expande a definiciones completas.
- **Caché.** «Internally, the API excludes deferred tools from the system-prompt prefix. When Claude discovers a deferred tool through tool search, the API appends a `tool_reference` block inline in the conversation […] The prefix is untouched, so prompt caching is preserved» [1]. La página de caché lo repite: «adding tools dynamically through tool search does not break your cache» [2]. Una diferida **no puede** llevar `cache_control` (400) [1].
- **Modelos** (tabla «Model compatibility», leída hoy): Fable 5.1, Mythos 5.1, Fable 5, Mythos 5, Opus 5.5, Opus 5, Opus 4.8/4.7/4.6/4.5, Sonnet 4.6/4.5 y Haiku 4.5. **Claude Sonnet 5 no figura en ella**, y Opus 4.1 y anteriores no la admiten.
- **Cuándo usarla**, según el proveedor: «10 or more tools» o «more than 10k tokens» de definiciones, o 200+ herramientas de varios MCP. La llamada estándar encaja mejor con «fewer than 10 tools», cuando se usan todas en cada petición o con definiciones pequeñas [1].
- **Coste.** «Tool search isn't metered as a separate server tool […] the tool definitions that search loads into context count as input tokens» [1].
- **Multi-turno.** Hay que devolver el contenido del asistente sin cambios, incluidos `server_tool_use` y `tool_search_tool_result`, y así el modelo reutiliza lo descubierto sin volver a buscar [1].
- **Límites:** 10.000 diferidas por petición; consulta de 200 caracteres (regex) o 500 (BM25) [1].

### H2 · Las cifras del proveedor [marketing, evaluación propia del proveedor] [1][3]

«>85 %» menos definiciones en contexto; un montaje de 5 servidores pasa de ~77K a ~8,7K tokens. En sus evaluaciones MCP, la precisión de selección sube de 49 % a 74 % (Opus 4) y de 79,5 % a 88,1 % (Opus 4.5) [3]. Según el proveedor, la selección «degrades once you exceed 30–50 available tools» [1]. La búsqueda también «adds a search step before tool invocation» [3], lo que supone latencia. No encontré una medición independiente de esa precisión.

### H3 · OpenAI [doc] [4]

`{"type":"tool_search"}` solo en la API Responses (gpt-5.4 y posteriores) y en la API Agents. **Chat Completions no aparece.** Con una función diferida suelta, el modelo sigue viendo su nombre y su descripción («in practice tool search is mostly deferring the parameter schema»). Las cargadas se inyectan al final del contexto para conservar la caché, y cambiar el conjunto cargado «will break the model's cache». OpenAI recomienda namespaces de menos de 10 funciones.

### H4 · Claude Code y los proxies [doc] [5]

Con un `ANTHROPIC_BASE_URL` que no es de primera parte, la búsqueda MCP se apaga por defecto: «Set `ENABLE_TOOL_SEARCH=true` if your proxy forwards `tool_reference` blocks». Es la regla que copia nuestro `auto`: solo contra el host oficial.

### H5 · Los frameworks [doc] [6][7][8]

El AI SDK 7 ofrece `toolSearch()` con `deferLoading: true`: hasta 5 coincidencias, disponibles «on the next model step» [6]. Su proveedor de Anthropic expone además la búsqueda nativa (`toolSearchBm25_20251119` / `toolSearchRegex_20251119`) [7]. Mastra tiene ToolSearch y LangChain un selector [8]. Todos lo regalan. El informe de competencia ya lo clasificaba como la palanca de absorción «muy alta» [8].

### H6 · Evidencia medida

- **SCOUT (PayPal, en producción)** [medido; parte interesada] [9]: búsqueda híbrida BM25 + densa. El consumo de herramientas MCP baja de 140,2k tokens (70,1 % del contexto) a 1,3k (−99 %). El resumen no publica precisión y observa que la caché de prefijo «reduces reprocessing cost but neither frees context capacity nor improves accuracy».
- **El corpus propio (bitácora del 10-09)** [medido] [10]: 226 herramientas declaradas y solo 11 invocadas. La búsqueda de Claude Code vale **+16,38 % de la factura** (banda 11,1–22,1 %), con cobertura de caché 1,0000; cuando el catálogo crece, se lee de caché el 93,9 % de las veces. Podar sin congelar sale **35,7:1 en contra**, y congelando la misma poda ahorra el 14,3 %.
- **No encontré** mediciones independientes que comparen la búsqueda nativa con un selector local en precisión ni en coste. El presupuesto de búsquedas web de esta sesión se agotó antes de poder buscar más, así que no afirmo nada que no esté arriba.

### H7 · Lo que hace hoy el código

- **Selector** (`src/router/tool-selector.ts`): con un catálogo sin tipar pasa las `maxTools` (8) primeras por posición y apunta las demás en el libro 2. El test `selector-catalogos-reales` lo fija (55 → 8, 47 descartadas). Con un catálogo tipado poda por relevancia y congela el conjunto por sesión.
- **Adaptador de Anthropic:** no tenía forma de mandar la búsqueda (`ProviderRequest` no la describía). Además aplana el historial a texto (`repartirMensajes`), así que ni `tool_use` ni `tool_reference` sobreviven entre turnos.
- **Adaptador OpenAI:** habla `/chat/completions`.
- **Gateway:** ya reenvía `tool_reference` y avisa cuando ve un catálogo entero sin búsqueda (`gateway/busqueda-de-herramientas.ts`).
- **El banco no puede medir esta palanca hoy.** El brazo B2 aplica la búsqueda en el cable (`benchmarks/nativo.ts`), pero el mayor catálogo del banco tiene **8** herramientas (`catalogoGrande`), por debajo del umbral documentado, así que B2 nunca la enciende.

### H8 · Precios que entran en la decisión [doc] [11]

La lectura de caché cuesta 0,1× la entrada (0,05× en Opus 5.5 y 0,025× en Fable 5.1 y Mythos 5.1); la escritura, 1,25× (5 min) o 2× (1 h). Con la caché caliente, el catálogo entero en el prefijo cuesta muy poco por petición. Por eso la nativa no gana siempre en dinero.

## 4 · Cuándo gana cada una

**En dinero, por petición y en el peor caso para la nativa** [inferido, aritmética sobre [1][11]]:

    ahorro del prefijo  = r · pEntrada · (tokens diferidos)                 ← lo que deja de leerse de caché
    coste de 1 búsqueda = pEntrada · (5 definiciones más grandes)           ← cargadas sin caché
                        + pSalida  · (consulta más larga admitida)          ← 200 (regex) o 500 (BM25)

Con la caché caliente, **todas** las peticiones buscando una vez y cargando las cinco definiciones más caras, la nativa gana si `ahorro ≥ coste`. Punto de equilibrio con definiciones de 300 tokens:

| modelo | r | BM25 | regex |
|---|---|---|---|
| Sonnet 4.6 / Haiku 4.5 | 0,1 | 40.000 tokens (~134 herramientas) | 25.000 (~84) |
| Opus 5.5 | 0,05 | 80.000 (~267) | 50.000 (~167) |

Es una cota conservadora a propósito:

- Si la caché no está caliente (TTL vencido o tráfico a ráfagas), mandar el catálogo entero cuesta la escritura (1,25×) y la nativa gana de largo.
- Si una parte de las peticiones no necesita herramienta, no busca.

La medición del 10-09 (+16,4 %) muestra que el tráfico real queda mejor que ese peor caso. Aun así, **el SDK no es Claude Code**: nuestro adaptador aplana el historial, así que cada turno que necesita herramienta vuelve a buscar (H1, H7), mientras que Claude Code reutiliza lo descubierto. Para el SDK, el peor caso está más cerca de la realidad que para Claude Code.

**Frente al selector congelado**, la nativa puede costar más tokens, porque el selector manda ≤ 8 herramientas. Lo que la nativa compra es **alcanzabilidad**: ninguna herramienta queda fuera y elige el modelo, no un emparejamiento léxico de `intents`. Esa diferencia es de función, no de dinero, y por eso la decide quien enciende la palanca, no una verja.

**En calidad**, el proveedor declara mejoras por encima de 30–50 herramientas [1][3] [marketing]. Con un catálogo sin tipar, el selector no selecciona nada: corta por posición.

**En latencia**, la nativa añade un paso de búsqueda dentro de la misma llamada [3]. El selector no añade nada. Nuestro schema-on-demand (`toolDiscovery`) añade una segunda llamada completa y además renuncia a la caché de prefijo.

**En caché**, la nativa conserva el prefijo desde el primer turno [1][2]. El selector lo rompe mientras aprende y lo conserva una vez congelado [10]. En OpenAI, cambiar el conjunto cargado rompe la caché [4].

## 5 · Opciones

| opción | a favor | en contra | veredicto |
|---|---|---|---|
| A · No hacer nada | cero riesgo | con `AnthropicProvider` el cliente **no puede** mandar la búsqueda: no había campo | no |
| B · Encenderla por defecto | máximo alcance | cambia el cuerpo, añade latencia, puede dar 400 si la tabla cambia; rompe el principio opt-in | no |
| C · Opt-in: `auto` conservador + `always` | usa la nativa donde es segura y paga; el llamante decide el resto; nada se acredita | `auto` se queda corto frente al +16 % medido en Claude Code | **sí** |
| D · Búsqueda propia devolviendo `tool_reference` desde una herramienta cliente [1] | búsqueda semántica propia | exige transportar bloques entre turnos, que el SDK no hace (historial en texto) | queda |
| E · Adaptador OpenAI Responses con `tool_search` | cubre gpt-5.4+ | un adaptador nuevo entero | queda |

## 6 · Decisión

**C.** Es lo único que cumple a la vez la ley del 10-09 (no se borra nada a mitad del prompt), el principio de no cobrar lo que no es nuestro (el ahorro lo mide el contador del proveedor y no se acredita) y el de publicar el suelo (`auto` exige el peor caso). El selector sigue siendo la opción por defecto y la de todos los proveedores sin búsqueda nativa.

## 7 · Qué se construye hoy

- **`savings.toolSearch`** (público, en inglés, `src/contracts/types.ts`): `"off"` por defecto, `"auto"`, `"always"`, o `{ mode, alwaysLoaded, variant }`.
- **La decisión** (`src/router/busqueda-nativa.ts`, interno y puro). Requisitos duros, también en `always`:
  - un adaptador propio que declaró la capacidad;
  - un modelo de la tabla oficial;
  - sin contrato de salida;
  - sin cascada;
  - al menos una herramienta que diferir;
  - como mucho 10.000 diferidas;
  - ninguna herramienta del llamante con el nombre de la de búsqueda.

  `auto` exige además el host oficial, el umbral documentado y la verja de dinero del §4. La tabla de modelos es la misma que usa el brazo B2 del banco, y un test impide que diverjan.
- **El adaptador de Anthropic:**
  - declara la capacidad (`oficial` contra `api.anthropic.com`, `compatible` contra otro host);
  - pone la herramienta de búsqueda **primera** y sin diferir, y marca las demás con `defer_loading` salvo `alwaysLoaded`;
  - nunca pone `cache_control` en una herramienta;
  - lee de la respuesta, en JSON y en stream, cuántas búsquedas hubo, qué herramientas cargaron y cuántas fallaron (`ProviderResponse.toolSearch`).
- **El pipeline, etapa 6:**
  - si la nativa aplica, el selector no corre;
  - pasa todo el catálogo salvo lo que retira la misma verja de riesgo del selector (con un catálogo tipado, una petición que no es acción no recibe herramientas de escritura);
  - la huella y la verja de la caché de prefijo cuentan solo las no diferidas, que son las que el proveedor pone en el prefijo;
  - el sondeo de `toolDiscovery` no corre, y la traza lo dice;
  - la traza `tool-search` registra la decisión con sus cifras y lo que hizo el proveedor.
- **Contabilidad:**
  - **nada se acredita**: diferir no mueve `removedInputLocal`;
  - la calibración `k` sale más baja de lo real, así que otras palancas se acreditan de menos (el lado seguro);
  - **nueva regla E4-bis**: una petición servida con búsqueda nativa no deja registro por referencia (`native-tool-search`).
- **Aviso único** (silenciable): con la palanca apagada, si el selector recorta un catálogo sin tipar en un adaptador y un modelo que admiten la nativa.
- **README:** párrafo y ejemplo en «Tool calls», compilado por `fragmento-instalacion`.
- **Tests:** 30 de la decisión (`test/busqueda-nativa.test.ts`) y 17 de cable y pipeline (`test/busqueda-nativa-en-el-cable.test.ts`):
  - el prefijo del proveedor es idéntico byte a byte con otra pregunta y con el catálogo creciendo por delante y por detrás;
  - no hay libro 2, ni ahorro, ni referencia;
  - `auto` contra un proxy no aplica y `always` sí;
  - OpenAI se queda en el selector;
  - la verja de riesgo se mantiene;
  - el contrato de salida hace caer al selector;
  - lectura de las búsquedas en JSON y en SSE;
  - el aviso.

  Una mutación que quita `defer_loading` hace fallar 4 de ellos.

## 8 · Qué queda, riesgos y medición

**Queda:**
1. **Medirlo en el banco.** Hace falta un escenario de catálogo grande (150 o más herramientas estilo MCP, sin tipar) en `benchmarks/scenarios.ts`, con tres brazos (selector, `toolSearch` y B2). No lo he añadido: cambia el conjunto de escenarios del que salen las cifras publicadas y se paga. Lo decide el dueño.
2. **Una sonda en vivo** (con gasto, la corre el dueño). Tiene que confirmar dos cosas: que un modelo de la tabla acepta el cuerpo tal como sale, y que el `usage` de primer nivel de una respuesta con búsqueda incluye la continuación. Lo segundo lo inferimos de la regla del advisor («Every top-level `usage` field is the sum of that field across all executor iterations»), pero no está verificado para la búsqueda.
3. **Transportar los bloques de búsqueda entre turnos.** Hoy cada turno vuelve a buscar. Con los bloques, el modelo reutilizaría lo descubierto [1] y el coste por turno bajaría. Requiere que el historial deje de ir como texto en el adaptador.
4. **Adaptador OpenAI Responses** con `tool_search` (gpt-5.4 y posteriores).
5. **Sonnet 5 no está en la tabla oficial.** El ejemplo del AI SDK la usa con búsqueda [7]; si Anthropic la añade, se incorpora a las dos listas a la vez.
6. **Contrato de salida con búsqueda:** no está documentado. B2 sí lo combina, así que la tirada del banco lo dirá.
7. **`pause_turn`** se entrega tal cual y no se continúa solo.
8. **Decisión del dueño:** ¿cambiar el valor por defecto a `"auto"` cuando haya medición?

**Riesgos:**
- Un 400 si la tabla del proveedor cambia. Mitigación: fallar cerrado, solo modelos listados, opt-in; los errores del proveedor se propagan (no hay rescate que duplique el gasto).
- Un proxy que se coma los bloques: `auto` no aplica fuera del host oficial.
- Una búsqueda que no encuentra la herramienta. Mitigación: `alwaysLoaded`, descripciones claras; la traza enseña lo cargado.
- Más de una búsqueda por petición supera el supuesto de la verja. Se ve en la traza (`searches`).
- Seguridad: con un catálogo sin tipar, todo es alcanzable, igual que en la petición del propio cliente. Con uno tipado se mantiene la verja de escrituras.

**Cómo se medirá:**
- **Por petición**, en `report.traces`:
  - `tool-search` → `native`/`selector` con la razón, las diferidas, `prefixSavingPerRequest` y `worstCaseSearchCost`;
  - `provider` → `searches`, `loaded` y `errors`.

  El coste es siempre el del contador del proveedor (`cost.actual`).
- **A/B pareado en el banco** (punto 1 de «Queda»), con los mismos prompts y sal de frío. Se mide:
  - el coste medido por petición;
  - la parte de la entrada leída de caché;
  - la precisión de herramienta (si se llamó a la esperada);
  - la latencia p50 y p95.

  Se publica el suelo del intervalo de confianza.
- **Señal de éxito:** en catálogos por encima del umbral, un coste medido no peor que B2 y una precisión de herramienta no peor que la del selector. **Nunca** entra en la comisión.

## 9 · Fuentes

1. Anthropic, *Tool search tool*: https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool (consultada 2026-09-27) [doc]
2. Anthropic, *Tool use with prompt caching*: https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching (2026-09-27) [doc]
3. Anthropic Engineering, *Advanced tool use*: https://www.anthropic.com/engineering/advanced-tool-use (publicado 2025-11-24) [marketing; evaluación propia del proveedor]
4. OpenAI, *Tool search*: https://developers.openai.com/api/docs/guides/tools-tool-search (2026-09-27) [doc]
5. Claude Code, *Environment variables* (`ANTHROPIC_BASE_URL`): https://code.claude.com/docs/en/env-vars ; *MCP*: https://code.claude.com/docs/en/mcp (2026-09-27) [doc]
6. Vercel AI SDK, *Tool search*: https://ai-sdk.dev/docs/ai-sdk-core/tool-search (AI SDK 7.x, 2026-09-27) [doc]
7. Vercel AI SDK, *Anthropic provider*: https://ai-sdk.dev/providers/ai-sdk-providers/anthropic (2026-09-27) [doc]
8. `docs/COMPETENCIA-2026-09-26.md`, §2.1 y §3 (fila «Selector de herramientas»; Mastra ToolSearch 4-feb-2026; AI SDK `toolSearch` 16-sep-2026)
9. arXiv 2608.23992, *Hybrid Semantic Tool Discovery for Enterprise MCP Gateway* (SCOUT): https://arxiv.org/abs/2608.23992 (2026-08-25) [medido; parte interesada]
10. `docs/BITACORA-2026-09-10.md`, §1, §2 y §5 [medido; corpus propio]
11. Anthropic, *Pricing*: https://platform.claude.com/docs/en/about-claude/pricing (2026-09-27) [doc]
