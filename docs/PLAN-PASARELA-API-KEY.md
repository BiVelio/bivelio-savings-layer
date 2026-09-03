# El plan de la pasarela para API key — medir → sombra → palanca

**Fecha:** 2026-08-30 · **Base:** investigación verificada sobre `main@a370bda`
(dos tandas de agentes con refutación adversarial; toda cita es `archivo:línea`
comprobada). **Segmento:** usuarios con **API key** de terminales de
codificación (Claude Code, Codex CLI, opencode, Goose, Crush, Qwen Code,
Droid…). El tráfico OAuth de suscripción se sigue midiendo pero **no se
monetiza** (docs/PASARELA-F0.md:14: «el caso que NO facturamos»).

**Numeración:** fases **S0–S4** (S de *sombra/escalonado*). A propósito no se
usa «F»: el repo ya tiene dos esquemas F que colisionan (pasarela F0–F2 en
PASARELA-F0.md y F0–F8 en PLAN-CAMINO-AL-50.md) y no vamos a crear un tercero.

**Principio rector** (decisión del dueño, 2026-08-30): ir por pasos y que **la
gente que nos contrata sea el banco de medición continuo** — cada fase produce
el dato que decide la siguiente, y el software mejora con cada cliente. Con una
condición innegociable: el cálculo pasa en la máquina del cliente y al plano de
control **solo suben conteos y coste, jamás prompts** (la doctrina de los
cuatro libros; invariante de docs/COMMERCIALIZATION-PLAN.md:42).

---

## 1. Estado de partida (verificado 2026-08-30)

| Hecho | Evidencia |
|---|---|
| El gateway existe y está **publicado**: npm latest 0.4.3 lleva `bin: {"bvsala": "dist/gateway/bin.js"}`; `bvsala gateway` y `bvsala claude` funcionan | package.json:36-38; `npm view @bivelio/savings-layer bin`; gateway/bin.ts:22-42 |
| Hoy **solo mide**: passthrough byte a byte, `basis:"measured"`, netSavings=0; la coalescencia (única palanca) está tras `BVSALA_GATEWAY_COALESCE=1`, apagada | gateway/servidor.ts:15-27; gateway/medidor.ts:9-13; gateway/coalescencia.ts:11-17 |
| ~~El medidor **infra-mide desde hoy**~~ → **arreglado en S0.1/S0.2** (rama `fix/s0-medidor-ttl-1h-y-stream-false`): prima 2× para la escritura 1h con desglose por TTL, y las respuestas `stream:false` de `/v1/messages` se miden vía `usoDeJson` | gateway/medidor.ts (PRIMA_ESCRITURA_CACHE_1H, UsoSse.cache_creation); docs/PASARELA-F0.md:31,38-40 |
| La 0.4.3 publicada mide con el catálogo de precios **anterior** al corte de herencia de instantáneas (#151) | commit 778b9b2; gateway/medidor.ts:74 |
| La web niega el gateway: `caseCodeBody` («library, not a proxy… cannot sit in front of Claude Code») en 12 locales × 2 superficies, + `s1Note:717`, + `HowItWorks.tsx:13`, + `InstallLicensePanel.tsx:25`, + **README.md:63 dentro del propio tarball npm** | apps/web/messages/*.json:725; README.md:63 |
| **No existe ningún experimento de elisión** en el repo (la palabra no aparece); la verja de calidad no cubre `tool_results`; el corpus F0 es 1 sesión **sin herramientas** | benchmarks/verja-de-calidad.ts:16-21; docs/PASARELA-F0.md:75,94 |
| ToS: el modo suscripción-por-gateway está documentado por Anthropic como soportado; **toda la defensa se apoya en no reescribir** | docs/TERMINALES-DE-CODIFICACION.md:56,150-153,166 |
| El premio está en el tráfico de agente: ~88 % entrada / ~12 % salida, donde «la caché de prefijo lo decide casi todo» | docs/PLAN-CAMINO-AL-50.md:74 |

Y el desconocido que dimensiona todo: Claude Code ya envía `context_management`
(docs/PASARELA-F0.md:24-27) — parte de las salidas de herramientas viejas puede
estar recortándose antes de llegar a ningún proxy. **Cuánta masa elidible queda
de verdad es la primera cifra que hay que producir, no asumir.**

---

## 2. Las fases

### S0 · La regla recta (ya, y gratis) — arreglar el medidor y publicar 0.4.4

Sin esto, cualquier resultado futuro se mide con una regla torcida.

| # | Trabajo | Dónde exactamente |
|---|---|---|
| S0.1 | **Prima 2× para escritura 1h.** Ampliar `UsoSse` con `cache_creation?: { ephemeral_5m_input_tokens?, ephemeral_1h_input_tokens? }` (el merge de `ObservadorSse` es spread superficial y ya lo soporta — solo cambia el tipo); constante hermana `PRIMA_ESCRITURA_CACHE_1H = 2`; en `costeMedido` separar 5m/1h con **fallback legacy = todo 5m** cuando no hay desglose. El catálogo **no** cambia: la 1h se deriva como 2× `inputPer1k`, misma convención que la 5m | gateway/medidor.ts:16-21,47,64,79-85; src/tokenizer/accounting.ts:24-31 |
| S0.2 | **Medir `stream:false`.** Cuando `!esSse` y la respuesta es `application/json` de `POST /v1/messages`, acumular los chunks del bucle (ya fluyen por él), `JSON.parse(...).usage` y llamar a `medir(...)` — su firma ya acepta `UsoSse \| null`. Mismo parseo para la réplica coalescida no-SSE, que tiene el mismo hueco | gateway/servidor.ts:199-209,214-217,154-161 |
| S0.3 | **Publicar 0.4.4** — arrastra al binario del gateway el corte de herencia del catálogo (#151). Publicación con llave física según el procedimiento ya establecido | — |
| S0.4 | **Coherencia pública:** corregir a «ya puede ponerse delante y **medir**» las afirmaciones falsas — `caseCodeBody` (12 locales), `s1Note:717`, comentario `HowItWorks.tsx:13-14`, `InstallLicensePanel.tsx:25`, `README.md:63`. El veredicto «Aún no» de la tarjeta **se queda**: sigue siendo verdad que ahorro no hay | apps/web/messages/*.json; README.md |

**Aceptación:** casos nuevos en `test/gateway-medidor.test.ts` (desglose 5m+1h,
tarifa 2×, fallback legacy) y `test/gateway-servidor.test.ts` (JSON con usage se
mide; réplica coalescida JSON se mide); `npm view` = 0.4.4; revisión de las
cadenas en los 12 locales.

### S1 · El denominador (semana 1) — corpus rico y las cuatro cifras

El espía ya captura lo necesario (`requestBody` completo con `messages`,
`tool_result`, `tools`, `context_management` — scripts/espia-anthropic.mjs:85-88 —
y el SSE entero en base64). Tres retoques y a grabar:

1. **Espía** (scripts/espia-anthropic.mjs): guardar cuerpo también en respuestas
   no-SSE (hoy caen del corpus: el arnés filtra por `responseBodyBase64`,
   arnes-pasarela.mjs:76); parametrizar el tope de 4 MB de :162/:171 (hoy por
   encima el cuerpo se **pierde entero**, no se trunca); añadir correlación de
   sesión/subagente (`clientPort`, `requestBody.metadata`) — sin tocar la
   redacción de `SENSIBLES`.
2. **Grabar sesiones ricas:** Claude Code con herramientas, ficheros y
   subagentes; al menos una sesión de un terminal del anillo 2 (Goose u
   opencode, vía Anthropic). La captura completa queda **solo local**
   (`~/.bvsala-f0/`), como en F0.
3. **`scripts/analisis-corpus-f0.mjs`** (✅ hecho; el método final DIFIERE del
   previsto aquí y queda declarado): reconstruye sesiones (cabecera
   `x-claude-code-session-id` → hash del primer mensaje → `clientPort`) y
   calcula:
   - **fracción de tokens de entrada que son `tool_result`** — calibración por
     proporción de bytes × tokens REALES del proveedor por petición (no el
     `HeuristicEstimator` que preveía este plan: cada petición se calibra con
     su propio contador, que es más directo);
   - **efecto de `context_management`** — en dos libros: `applied_edits`
     declarados por el proveedor en la RESPUESTA (el recorte pasa en el
     servidor; medir encogimiento del request no puede verlo) y poda del
     CLIENTE (in situ / compactación del historial enviado);
   - **mezcla real de caché 5m/1h** (con el desglose de S0.1);
   - **fuga** (fast-mode y safety-check de WebFetch van directos a
     api.anthropic.com, TERMINALES-DE-CODIFICACION.md:57): **no computable
     desde la captura** — se cuantifica comparando contra la consola del
     proveedor, y el informe lo declara así.

**Aceptación:** PASARELA-F0.md ampliado con las cuatro cifras. **Puerta de
decisión:** si la masa elidible neta (tool_results − lo que ya recorta
`context_management`) queda por debajo de ~10 % de la entrada, la palanca de
elisión baja de prioridad frente a la caché de prefijo (F5 del PLAN) y S2 se
replantea antes de gastar las 2-3 semanas.

### S2 · La sombra (semanas 2–3) — `basis:"shadow"` de punta a punta

El gateway calcula qué *habría* elidido y con qué ahorro amortizado, **sin tocar
un byte del tráfico reenviado**. Riesgo cero: la defensa ToS del passthrough
queda intacta, y la privacidad también (el cuerpo se analiza en local; solo sube
el conteo hipotético).

> **✅ S2.4-replay EJECUTADO (03-09-2026)** sobre el corpus del espía (1.652
> turnos medibles, 15 sesiones, 659 $ reales a contador del proveedor). Motor en
> `gateway/sombra.ts` + replay en `benchmarks/sombra-corpus.ts`
> (`pnpm sombra:corpus`); simulador de caché de prefijo por (sesión, modelo) con
> la invalidación restada SIEMPRE y reportada aparte; calibración
> baseline-simulado/real = 1,14. Resultados (ahorro NETO de invalidación, sobre
> el baseline simulado con la misma vara):
>
> | Política | Ahorro neto | Invalidación pagada | Veredicto |
> |---|---|---|---|
> | **v0** edad×tamaño | **+20,6 %** (≈125 $ sobre la entrada real) | 59 $ | **GANADORA** — monótona por construcción (la edad solo crece: nadie resucita) |
> | v1 por tipo | +0,5 % | 36 $ | descartada como palanca de dinero: el 48 % del prompt es tool_result clase «otro» que sus reductores no saben leer (y no leer = no tocar, por doctrina) |
> | v2 presupuesto | −38,9 % (256 KB) · −0,6 % (1 MB) · −4,9 % (4 MB) | hasta 441 $ | **la trampa del plan, confirmada en dinero**: repuntuar cada turno baila a las víctimas y tritura el prefijo |
> | v2m presupuesto monótono | −32,7 % (256 KB) · **+12,3 % (1 MB)** · −1,5 % (4 MB) | 46–399 $ | solo positiva afinando el dial, y aun así muy por debajo de v0 |
>
> Decisión: **el carril sombra vivo (S2.4-vivo/S2.6) arranca con v0**; v2m@1MB
> queda como candidata de reserva. Límite declarado del replay: mide DINERO, no
> calidad — el efecto de elidir sobre las respuestas del modelo lo mide el arnés
> de S4, jamás este replay. Artefactos: `benchmarks/out/sombra-corpus-2026-09-03*.json`.

> **✅ CARRIL VIVO CONSTRUIDO (03-09-2026)**, en el orden obligatorio:
> **S2.1** ✅ como migración **0021** (0019 ya era de atribución) — aplicada en
> prod y verificada (columnas + rama shadow en la RPC + grant intacto).
> **S2.2** ✅ `shadow` en las dos copias de USAGE_BASIS, desplegado en prod.
> **S2.3** ✅ `CostBasis` gana `"shadow"` (doctrina traducida al inglés: la
> superficie pública se publica en npm y el trinquete del español bajó 91→81).
> **S2.4-vivo** ✅ `gateway/sombra-vivo.ts` (CarrilSombra: cadenas por
> sesión·agente·modelo, tope LRU; `CadenaDeSimulacion` incremental con verja de
> equivalencia exacta contra el replay) + `informeSombra` + cableado asíncrono
> en `medir()` — solo /v1/messages no coalescidas, requestId `:shadow`.
> **S2.5** ⏭ APLAZADA a S4 con motivo: en el replay el futuro de cada sesión ya
> pasó y se CUENTA (mejor que predecir); la aritmética amortizada solo hace
> falta como condición de emisión cuando la palanca corte de verdad — S4.
> **S2.6** ✅ `BVSALA_GATEWAY_SHADOW=1`, apagada por defecto.
> **S2.7** ✅ panel (tarjeta propia, solo con datos, rojo si pierde) + extracto
> (línea de contexto `sombra`, nunca en la base) + escalera de fallback
> 0021→0015→base en data.ts + i18n ×12. El **cierre SELLADO no cambia**
> (decisión declarada, desviación del plan): un contexto hipotético no entra en
> la fila inmutable de facturación hasta que la palanca sea real (S4).
> **ACTIVACIÓN pendiente**: npm 0.4.11 (dueño) + la bandera en su montaje.

**Orden de despliegue OBLIGATORIO** (doctrina de src/metering/emitter.ts:304-315:
un 4xx del ingest **descarta el lote sin reintento**, y npm es inmutable):
**1º migración BD → 2º verja del servidor → 3º panel/extracto → 4º SDK/gateway.**
Lo inverso pierde uso para siempre.

| Paso | Trabajo | Trampas conocidas (todas con cicatriz en el repo) |
|---|---|---|
| S2.1 | **Migración `0019_elision_en_sombra.sql`:** columnas `shadow_requests`, `shadow_baseline_cost`, `shadow_actual_cost` en `usage_daily` (molde 0010:22-41) + `CREATE OR REPLACE` de `ingest_usage_batch` reproduciendo el cuerpo de 0015:81-199 **entero** | Nunca `DROP+CREATE` (se pierde el grant a `service_role`, 0015:200). El registro sombra aporta **0** a `requests`/`avoided_llm`/`actual_llm`/totales/`seat_activity` — si no, salta el CHECK `usage_daily_calls_add_up` (0011:31-35), revierte el lote entero y se reproduce el bucle 500+reencolado que 0011 curó. Y sin columnas propias, la sombra se disfrazaría de «ahorro estimado» en el extracto (extracto.ts:111) e hincharía el titular del panel (derive.ts:176-179) |
| S2.2 | **Verja del servidor:** añadir `"shadow"` a `USAGE_BASIS` en **las dos copias** — apps/web/lib/metering/usage.ts:40 (la que importa la ruta) y packages/protocol/src/index.ts:242 (el espejo) | Tocar una sola deja la otra devolviendo 400 |
| S2.3 | **Contrato SDK:** `CostBasis` gana `"shadow"` (src/tokenizer/accounting.ts:22) + doctrina en el docstring de `cost.basis` (src/contracts/types.ts:713-727): *hipotético; jamás en base de comisión, jamás sumado a measured ni a totales* | `estimateCost` no debe producirlo jamás; el informe sombra se construye aparte |
| S2.4 | **`gateway/sombra.ts` (nuevo):** sobre el cuerpo ya bufferizado (el gateway bufferiza los POST para la coalescencia), **en asíncrono tras reenviar** — nunca en el camino de la petición —, políticas CANDIDATAS en paralelo, todas valoradas con la aritmética amortizada y comparadas en DINERO (no en tokens) sobre el mismo corpus: **v0** determinista: candidatos = bloques `tool_result` por encima de umbral de edad×tamaño; **v1** consciente del TIPO de bloque (decisión del dueño, 01-09; implementación propia desde cero): logs → conservar errores y trazas, salida de código → firmas/tipos sin cuerpos, diffs aparte; **v2** empaquetado con presupuesto: puntuar bloques por relevancia+recencia+señal de error y podar hasta un presupuesto de tokens, conservando orden cronológico. Trampa que las mata a las dos si se ignora: reescribir un bloque que estaba en caché de prefijo lo convierte en tokens nuevos (escritura 1,25×/2×) — la sombra debe restar SIEMPRE el coste de invalidación de caché, que en tráfico real (98 % lecturas a 0,1×) puede comerse el ahorro entero; ahorro valorado con la aritmética amortizada; emite `informeSombra` vía el builder tercero de gateway/medidor.ts:112-149 | `netSavings` es **PROPORCIÓN** en [-100,1], no dólares — el mismo error ya tumbó lotes de coalescencia (medidor.ts:131-138; verja en usage.ts:103-109). `requestId` con sufijo `:shadow` — la idempotencia `usage_ingest_seen` por (org, requestId) se tragaría en silencio el registro si comparte id con el real (0015:103-107; el patrón de id admite `:`, tope 128 chars, usage.ts:20) |
| S2.5 | **Aritmética amortizada** en economics: función interna nueva `costeEsperadoAmortizado(turnos, …)` construida sobre `costeEsperado` **sin tocar su firma posicional** (3 llamantes + tests); campo opcional `turnos?: number` en `EntradaDecision` (retrocompatible; fluye solo por el spread de equilibrioPrefixHitRate:234-235); reenviarlo a mano en politica-compresion.ts:121-130 y pipeline.ts:1535. Modelo: turno 1 escribe (1,25×/2× según TTL), turnos 2..N leen (0,1×); regla de rentabilidad **por evento** `N ≳ 11,5·S/E` (≈19· con 1h) | Las funciones de economics **no se exportan** del paquete a propósito (src/index.ts:47-60); la nueva queda interna. `minimumCacheTokens=1024` es supuesto declarado, no cifra verificada (cache-tier.ts:29-33) |
| S2.6 | **Bandera** `BVSALA_GATEWAY_SHADOW=1`, apagada por defecto, patrón exacto de `coalescer` (bin.ts:53-54, OpcionesGateway servidor.ts:32-52) | — |
| S2.7 | **Panel y extracto:** columnas `shadow_*` en el select del cierre (cron cierre-extractos route.ts:67-68) y del panel **con el fallback 42703/reintento** de data.ts:251-295 (si el deploy adelanta a la migración, el panel no puede caerse); carril `shadow` propio en el `Verdict`, excluido de `net` y de `measured` (la misma doctrina que separó measured en derive.ts:74-89); en el extracto, línea de contexto tipo `ahorroSombraUsd` con el molde de `ahorroEstimadoExcluidoUsd` (:111) — **prohibido tocar `baseUsd` (:100-102) ni `calcularComision` (:113-114)** | Ojo al i18n: ya existe `extracto.notaSombra` (sombra de calibración) — usar claves `shadowElision*` para no colisionar |

**Aceptación:** caso en `test/esquema-vs-sdk.test.ts` con un informe sombra real
del builder contra el cuerpo del RPC 0019 (la lección de 0011:13-16: ningún test
tocaba el .sql y el CHECK rompió producción); extracto con sombra jamás en la
base (casos en extracto/cierre/derive); y la salida: **nuestra cifra propia,
«X % elidible amortizado sobre tool_results, medido en tráfico real»**, por
cliente que opte, visible en su panel.

### S3 · Más tráfico API-key medible (en paralelo a S2) — terminales

> **Estado 2026-08-30:** investigado y verificado en `docs/PASARELA-S3-TERMINALES.md`;
> **implementado el mismo día** (rama `feat/s3-terminales-hoy`): `ObservadorResponses`
> + dialecto por ruta + 426 al handshake WebSocket + `bvsala codex|goose|qwen`
> (tabla pura en `gateway/envoltorios.ts`) + `bvsala doctor` + `docs/terminales/`
> + test de `GET /v1/models`. **Validado en mano el 30-08:** `bvsala codex` con
> suscripción ChatGPT (426 → fallback limpio, stream íntegro, registro `measured`).
> Pendientes: sesión de Codex con **API key** (`/v1/responses`); Droid y Kilo
> contra el log del gateway. **Laguna conocida, a cerrar en S2 antes de S4:** el
> registro de un usuario de suscripción (Claude Code OAuth, Codex ChatGPT) es
> hoy indistinguible del de API key en el wire — «no se monetiza» es cierto por
> ausencia de comisión, no por diseño; cuando S2 toque el esquema, etiquetar la
> auth de suscripción para que jamás entre en la base de S4.

Prioridades del catálogo (TERMINALES-DE-CODIFICACION.md:160-172), solo la parte
API key:

| Prioridad | Terminal | Trabajo | Nota |
|---|---|---|---|
| #1 | **Codex CLI** | `ObservadorSse` del protocolo **Responses** en gateway/medidor.ts (hoy solo habla Anthropic); ruta `{base}/responses` con passthrough de `Authorization` + `ChatGPT-Account-ID`; envoltorio `bvsala codex` + instalador que escriba `openai_base_url` en `~/.codex/config.toml` **de usuario** (la clave está en PROJECT_LOCAL_CONFIG_DENYLIST) | Probar en mano el transporte WebSocket (`supports_websockets: true`) antes de GA; el catálogo ya cubre gpt-5/codex entero |
| #3 | **Claude Code, conformidad plena** con /llm-gateway-protocol | `HEAD /api/hello` (ya), `count_tokens` opcional, `GET /v1/models` para model discovery, registrar `x-claude-code-session-id/agent-id/parent-agent-id` (además arregla la correlación de sesión de S1), watchdog 300 s | Es argumento de venta Y defensa legal a la vez |
| #4 | **Anillo 2 a coste ~0:** Goose (`ANTHROPIC_HOST`), opencode (`opencode.json`), Crush (`crush.json`), Qwen Code (`ANTHROPIC_BASE_URL`), Droid (`~/.factory/settings.json`) | Docs de onboarding + helpers; **el observador Anthropic actual les sirve tal cual**. Cline/Kilo se configuran por UI → solo documentación | Para Qwen Code: añadir familia qwen al catálogo **solo con precios publicados verificados** (la política de catalogo.ts:10-15 prohíbe estimar) |
| #5 | Gemini CLI / Antigravity | **No construir** hasta validar en mano (sunset de consumo 2026-06-18) | Vigilar |

Aider queda fuera del ranking (estancado desde ago-2025, protocolo Anthropic sin
verificar): candidato a doc de onboarding solo si alguien lo valida en mano.

### S4 · La palanca (solo si la sombra la justifica) — **DECISIÓN DEL DUEÑO**

No se escribe una línea de la elisión real hasta que:

1. **La sombra lo pague:** ≥ N puntos netos amortizados sostenidos sobre ≥ M
   sesiones de ≥ 2 clientes reales (N y M los fija el dueño con las cifras de S2
   delante — propuesta inicial: N=8 puntos, M=50 sesiones).
2. **El carril 2 del arnés exista.** El arnés actual es incompatible por diseño
   (casa la petición por cuerpo exacto, arnes-pasarela.mjs:88-103, y veredicto
   por byte-igualdad :149-157). Carril 2: `pasada(entorno)` genérica (hoy
   hardcodea la coalescencia, :115-119), casado por secuencia/clave laxa, gemelas
   condicionales, y comparador **semántico** (texto final ensamblado, secuencia
   de `tool_use`, `message_stop`, `usage`) con el mismo contrato exit 0/1.
3. **La verja de fidelidad cubra `tool_results`** — hoy ningún escenario del
   banco toca uno, y la única verja de fidelidad real (#156) protege otra cosa.
4. **La postura ToS esté decidida.** Elidir reescribe el cuerpo y **gasta la
   defensa del passthrough** (TERMINALES:153,166). Opciones sobre la mesa, en
   orden de conservadurismo: (a) la elisión vive en el **SDK** (donde ya se
   reescribe con consentimiento) y el gateway queda puro; (b) en el gateway,
   **opt-in explícito por cliente** con passthrough como defecto y tocando solo
   `tool_result` dentro de `messages` — jamás `system`, jamás cabeceras, jamás
   credenciales; (c) no encender. Es una decisión de negocio, no técnica.

Invariantes de la política de elisión (derivados en la investigación, fijos):
determinista y **monótona** (bloque elidido queda elidido; stub estable por
hash), preferencia por aplicar **en frío** (caché expirada o miss observado),
rentabilidad por evento `N ≳ 11,5·S/E`, y la vía preferente es **elisión con
recuperación determinista** (= «paginación de contexto», columna *lossless* del
PLAN:86-90, que se despliega sin golden set; la elisión sin recall sí exige
golden set y sombra previa).

---

## 3. El bucle con clientes

```
cliente nuevo ──▶ gateway mide (S0: regla recta)
                      │  sus conteos engordan el denominador (S1, continuo)
                      ▼
                  sombra opt-in (S2): su panel enseña «X % elidible» propio
                      │  ≥ umbral S4 sostenido
                      ▼
                  palanca opt-in (S4): solo donde SU sombra compensa
                      │
                      └──▶ vuelta a medir (el ahorro pasa a basis:"measured")
```

Cada fase es reversible, cada cliente decide la suya, y los prompts no salen de
su máquina en ninguna. La comisión solo toca dinero `measured`, como siempre
(extracto.ts:19: «Solo entra dinero MEDIDO»).

---

## 4. Riesgos y qué los mata

| Riesgo | Mitigación |
|---|---|
| Elidir en caliente invalida la caché de prefijo (~12,5× el tramo tocado) | Aritmética amortizada de S2.5 como **condición de emisión** del candidato sombra; preferencia por frío; monotonía |
| `context_management` de Anthropic ya recorta la masa → premio menor del esperado | S1 lo mide **antes** de gastar S2; puerta de decisión explícita |
| Reescribir gasta la defensa ToS del passthrough | La sombra no reescribe nada; la palanca es S4 y decisión del dueño, con la vía SDK como alternativa conservadora |
| SDK nuevo contra servidor viejo → 400 → lote perdido sin reintento | Orden de despliegue obligatorio de S2 (BD → verja → panel → SDK) |
| Registro sombra dispara el CHECK 0011 o infla el titular del panel | Columnas `shadow_*` propias; 0 a requests/totales/seat_activity; carril propio en el Verdict |
| El gateway no ve el 100 % del tráfico (fast-mode, WebFetch) | S1 cuantifica la fuga y se declara en la medición — nunca prometer sobre lo que no se ve |
| El «PASA» del arnés certifica de más (ya pasó: coalescencia con 3 bugs) | Carril 2 semántico + cabeceras de identidad en el corpus + corpus multi-credencial antes de encender nada |

---

## 5. Cronología y esfuerzo

| Fase | Cuándo | Esfuerzo | Produce |
|---|---|---|---|
| S0 | ya | 1-2 días | regla recta + 0.4.4 + web coherente |
| S1 | semana 1 | 2-3 días | las cuatro cifras del denominador + puerta GO/NO-GO |
| S2 | semanas 2-3 | ~2 semanas | `basis:"shadow"` E2E + **nuestra cifra propia** |
| S3 | paralelo a S2 | Codex ~1 sem; anillo 2 ~días | más tráfico API-key medible |
| S4 | solo tras S2 | ~2 semanas | la palanca, opt-in, con verja y arnés delante |

*Documentos hermanos: PASARELA-F0.md (el espía y sus hallazgos),
TERMINALES-DE-CODIFICACION.md (el mercado y los ToS),
PLAN-CAMINO-AL-50.md (el presupuesto global de ahorro; esta pasarela alimenta su
palanca de tráfico de agente, no lo sustituye).*
