# S4 · La palanca — plan de implementación

*03-09-2026 · investigación: replay del corpus (#194), carril sombra vivo
(#195/#196), exploración del SDK/gateway, documentación y evaluaciones públicas
del proveedor, y dos mediciones nuevas sobre el corpus real. Complementa y
detalla la sección S4 de `PLAN-PASARELA-API-KEY.md`; las puertas de entrada de
aquella sección siguen vigentes.*

---

## 0. El hallazgo que reordena el plan

La investigación de hoy cambia la arquitectura de S4. El proveedor ya tiene una
elisión de tool_results **en el servidor**: `context_management` con la
estrategia `clear_tool_uses_20250919` (beta `context-management-2025-06-27`,
disponible en Anthropic, Bedrock y Vertex). Tres propiedades que ninguna
reescritura nuestra en el cliente puede igualar:

1. **Se aplica DESPUÉS de la consulta de caché y ANTES del conteo de tokens.**
   El prefijo cacheado se reutiliza en esa misma petición y los tokens borrados
   no se facturan. Nuestra reescritura cliente invalida el prefijo POR DELANTE
   — es exactamente la trampa que el replay tarifó en 59–441 $ según política.
2. **El ahorro lo declara el contador del proveedor**: la respuesta trae
   `applied_edits` con `cleared_input_tokens`. Es dinero contrastable con la
   factura — `basis:"measured"` de libro, sin contrafactual simulado.
3. **La evidencia de calidad ya existe y es del propio proveedor**: en sus
   evaluaciones publicadas, el context editing solo mejora el rendimiento en
   tareas agénticas un +29 % (y −84 % de tokens en un eval de 100 turnos). No
   es que elidir «no degrade»: el contexto hinchado degrada, y podarlo mejora.

Y la medición sobre NUESTRO corpus (1.952 peticiones, hoy):

| Medida | Valor | Lectura |
|---|---|---|
| Peticiones que YA llevan `context_management` | **75,2 %** | Claude Code lo envía solo; la pareja cabecera-beta + campo ya viaja |
| `applied_edits` del proveedor | **0 en 1.952** | los umbrales de fábrica no se disparan JAMÁS en tráfico real: el premio está íntegro |
| Re-lecturas de tool_results (mismo contenido, tool_use distinto) | **1.333 sobre 926 únicos (144 %)** | el agente YA re-lee contenido viejo constantemente (99 % de las re-lecturas son de bloques con 3+ turnos — justo los que v0 elide) |

La última fila es la evidencia de riesgo de calidad más valiosa que tenemos: el
flujo de trabajo del agente **ya trata el contexto viejo como no fiable y lo
re-pide cuando lo necesita**. La «reparación» tras una elisión (volver a leer)
es un camino que el agente recorre a diario por su cuenta.

**Decisión de arquitectura que este plan propone:** S4 se parte en dos fases
con perfiles de riesgo opuestos.

- **S4a — los diales del proveedor** (esta quincena): para orgs opt-in, el
  gateway AFINA la configuración `context_management` que el cliente ya envía
  (o la añade donde falte, con su cabecera beta). No se toca ni un byte de
  contenido de usuario: la superficie de reescritura es UN campo de
  configuración documentado de la API. Elisión en el servidor, ahorro medido
  por el proveedor, calidad avalada por sus propios evals y por nuestro arnés.
- **S4b — la elisión propia (v0)** (después, y solo si S4a deja premio sobre la
  mesa): la reescritura real de tool_results en el cliente — para el tráfico
  OpenAI (sin equivalente nativo), para políticas más finas que los diales del
  proveedor, y como independencia estratégica. Exige el arnés carril 2 y la
  verja de fidelidad por clase que hoy no existen.

Por qué este orden y no el inverso: S4a captura la mayor parte del premio con
una fracción del riesgo (técnico, de calidad y de ToS), produce dinero
`measured` sin discusión doctrinal, y sus datos (qué borra el servidor, con qué
efecto) calibran gratis el diseño de S4b.

---

## 1. Puertas de entrada (de PLAN-PASARELA-API-KEY.md § S4, con estado)

| Puerta | Estado 03-09 |
|---|---|
| Sombra ≥ 8 puntos netos sostenidos en ≥ 50 sesiones de ≥ 2 clientes | ⏳ carril vivo encendido HOY; el replay certificó +20,6 % sobre 15 sesiones de 1 cliente. La puerta de clientes la fija el dueño; para S4a sobre la org propia basta la sombra propia |
| Arnés carril 2 | ❌ no existe (byte-igualdad hoy); OBLIGATORIO antes de S4b, recomendado antes del opt-in de clientes en S4a |
| Verja de fidelidad sobre tool_results | ❌ no existe; obligatoria para S4b. Para S4a la fidelidad la da el mecanismo del proveedor + anillo 2 (abajo) |
| Postura ToS decidida | Propuesta de este plan: **variante (b) con superficie mínima** — S4a solo toca `context_management` (config documentada), jamás `messages`, `system`, cabeceras o credenciales. La decisión sigue siendo del dueño |

---

## 2. S4a · Los diales del proveedor

### 2.1 Qué hace exactamente

Para una org con la palanca concedida y la bandera local encendida, el gateway,
SOLO en `POST /v1/messages` hacia Anthropic:

1. Si el cuerpo ya trae `context_management` (75 % del tráfico): ajusta los
   diales de `clear_tool_uses_20250919` a los nuestros (abajo). Si trae una
   estrategia que no conocemos, NO se toca (nunca pisar la intención del
   cliente con algo que no entendemos).
2. Si no lo trae: lo añade, junto con la cabecera beta
   `context-management-2025-06-27` (la pareja viaja SIEMPRE junta —
   PASARELA-S3-TERMINALES.md:34: separar campo y cabecera es un 400).
3. Todo lo demás del cuerpo, byte a byte como siempre.

### 2.2 Los diales, derivados de la aritmética que ya validamos

La regla de rentabilidad del replay (una elisión paga su invalidación si lo que
deja de leerse a 0,1× durante los turnos restantes supera la reescritura):

- `trigger.input_tokens`: **30.000** de arranque (el punto donde la masa
  tool_result de nuestras sesiones reales ya amortiza de sobra; los umbrales de
  fábrica no saltaron nunca — este dial es EL cambio).
- `keep.tool_uses`: **3** (el último resultado y dos más: la venda de v0 de «no
  tocar lo recién nacido», que el replay validó).
- `clear_at_least.input_tokens`: **5.000** (la propia guía del proveedor: borrar
  100 tokens no paga romper el prefijo en el punto del borrado; borrar en
  lotes grandes sí — es la monotonicidad de v2m aprendida en el replay,
  expresada en el dial del proveedor).
- `exclude_tools`: vacío de inicio; reservado para herramientas cuyo resultado
  se demuestre irrecuperable.

Los tres números son **parámetros con nombre en un solo módulo**
(`gateway/diales-sombra.ts` o similar), no literales dispersos, y el A/B del
anillo 2 los podrá barrer.

### 2.3 Dónde se inserta y qué invariantes respeta

Punto de inserción identificado: `gateway/servidor.ts` entre la coalescencia y
el `fetchImpl` (hoy :279-290), como función **pura** del cuerpo:

- `try { cuerpoAjustado = ajustarDiales(cuerpo) } catch { cuerpoAjustado = cuerpo }`
  — **degradar a passthrough, jamás a error** (la regla escrita de la
  coalescencia). Un throw en el camino de la petición tumba el turno; aquí no
  puede pasar.
- Pura y determinista ⇒ la coalescencia sigue funcionando (misma clave para
  gemelas). Se decide ANTES de calcular la clave o se declara que la clave usa
  el cuerpo original — ambas valen si la función es pura; elegir una y testarla.
- `content-length` ya se recalcula (el gateway lo retira al reenviar). Cuerpos
  comprimidos (`content-encoding`): en S4a, si el cuerpo llega comprimido y no
  se puede reescribir con seguridad, **se reenvía intacto y no se ajusta** (el
  tráfico Anthropic de Claude Code viaja sin comprimir; el zstd es de Codex,
  que es OpenAI y queda fuera). Nada de construir el camino de recompresión
  para la fase a.
- La MEDICIÓN sigue usando el cuerpo ORIGINAL (los 4 `medir(requestId, cuerpo…)`)
  — el modelo y los bloques del cliente son los suyos; el ajuste se anota aparte.
- Solo Anthropic (`/v1/messages`), solo con emisor, solo no-coalescidas: los
  mismos filtros que la sombra.

### 2.4 Medición y facturación — por fin sin contrafactual

El gateway ya lee `applied_edits` del SSE (el espía v2 lo captura; el
observador lo puede extraer del `message_start`). Por cada respuesta con
`cleared_input_tokens > 0` **causada por nuestra config** (la org tiene la
palanca y el gateway ajustó/inyectó los diales en esa petición):

- `ahorroUsd = cleared_input_tokens × precioEntrada(model)` — conservador a
  propósito: los tokens borrados se habrían pagado como MÍNIMO a precio de
  lectura de caché y en cada turno futuro; tarifarlos una vez a precio de
  entrada es quedarse corto, jamás inventar de más. (Refinamiento posterior:
  amortizar por turnos restantes observados, con la CadenaDeSimulacion.)
- Viaja en el informe como palanca propia (`eliminatedInput` +
  `baselineCost = actual + ahorro`, `netSavings` proporción) con
  `basis:"measured"`: el contador es del proveedor y es contrastable con su
  factura. **Entra en la base de la comisión** — es la primera palanca de
  elisión facturable.
- Si el cliente YA enviaba una config que dispara borrados sin nuestro ajuste:
  ese ahorro es SUYO, no nuestro — no se acredita. Regla: solo se acredita el
  delta en peticiones donde nuestros diales difieren de los que traía.
- Panel/extracto: el ahorro S4a aparece en el carril MEDIDO (el de siempre);
  la tarjeta sombra sigue enseñando lo que la elisión propia v0 añadiría
  encima.

Nota de segmento: en tráfico OAuth/suscripción no hay dólares por petición —
el mismo mecanismo ahorra TOKENS contra los topes (valor real para el cliente,
medible en tokens), pero solo el tráfico API-key entra en base de comisión.

### 2.5 Verjas de calidad — tres anillos antes de ningún cliente

**Anillo 0 · sombra de diales (sin tocar tráfico, esta semana).** La API
`count_tokens` acepta `context_management` y devuelve `original_input_tokens`
vs `input_tokens`: el ahorro exacto que NUESTROS diales habrían producido, por
petición, calculado por el proveedor, sin enviar nada al modelo. El gateway (o
un replay del corpus contra `count_tokens`) lo mide en muestreo y publica la
cifra ANTES de encender nada. Es el equivalente S4a del carril sombra de S2.

> **✅ EJECUTADO (03-09-2026)** — `pnpm sombra:diales`
> (benchmarks/sombra-diales.ts; diales en gateway/diales.ts): 120 llamadas a
> `count_tokens` (0 fallos), muestreo uniforme sobre las 1.498 candidatas
> ≥ trigger del corpus (13 sesiones). Resultado, del contador del PROVEEDOR:
> **el 95,8 % de las muestras borra, y el borrado es el 22,9 % de la entrada**
> (9,97 M de 43,6 M tokens; mediana 95K por turno con borrado; fable 22,7 %,
> opus 37,2 %). Las 120 muestras traían la config del cliente — la que en vivo
> borró CERO en 1.952 peticiones — así que **todo el 22,9 % es atribuible al
> cambio de diales**. Convergencia: 22,9 % (contador del proveedor, S4a) ≈
> +20,6 % (nuestro simulador, replay v0) — dos métodos independientes, misma
> zona. Cautela declarada: es % de TOKENS de entrada en turnos disparados, no
> % de la factura — la proyección a dinero (lecturas a 0,1×, reescritura de
> caché tras cada borrado) es del anillo 2. Artefacto:
> `benchmarks/out/sombra-diales-2026-09-03.json`.

**Anillo 1 · arnés con éxito de tarea (carril 2, la pieza nueva).** Lo que el
plan ya exigía y la exploración confirmó que no existe: hoy el arnés casa por
byte-igualdad y `benchmarks/scenarios.ts` tiene CERO escenarios con
tool_result. Construcción mínima honesta:

- Corpus de tareas: 10–15 tareas agénticas REALES con verificador programático
  (tests que pasan, fichero con contenido esperado, respuesta que contiene el
  dato) grabadas de nuestras propias sesiones + sintetizadas. Multi-turno, con
  tool_results gordos de las tres clases (log, código, otro).
- Ejecución por PARES con la misma sal de frío del banco A/B: brazo A diales de
  fábrica, brazo B nuestros diales, mismo modelo, N reps.
- Veredicto con la maquinaria existente (`veredictoDeCalidad`, QUALITY_FLOOR
  0.999, CI bootstrap): éxito de tarea A vs B + señales secundarias (nº de
  turnos, re-lecturas, errores de herramienta). La puerta: B no pierde éxito de
  tarea fuera del CI, y no dispara re-lecturas más allá de lo que el ahorro
  paga (la tasa base del 144 % del corpus es el punto de comparación).

**Anillo 2 · nosotros primero, con A/B de días.** La palanca se enciende en la
org propia (la misma disciplina del skill): días alternos con/sin diales, y el
panel compara coste por sesión, éxito percibido y señales de fricción. Mínimo
una semana antes de ofrecerla a nadie.

> **Runbook del anillo 2 (06-09-2026, tras la revisión del brazo impar).**
> Protocolo del dueño: día natural **UTC** par = palanca, impar = control.
> Arnés: `pnpm anillo2` (benchmarks/anillo2) lee las capturas del espía,
> clasifica cada turno por el CUERPO y emite veredicto + auditoría de paridad.
>
> 1. **La bandera va SIEMPRE explícita.** Su sentido cambió en 0.4.14 (#217):
>    hasta 0.4.13 `=1` arma; desde 0.4.14 va armada y `=0` apaga. Sin bandera,
>    el brazo depende de la versión instalada — la grieta que hoy tenía el
>    protocolo «impares sin bandera».
>    - pares: `BVSALA_GATEWAY_ELISION=1 BVSALA_GATEWAY_UPSTREAM=http://127.0.0.1:8402 claude`
>    - impares: `BVSALA_GATEWAY_ELISION=0 BVSALA_GATEWAY_UPSTREAM=http://127.0.0.1:8402 claude`
> 2. **Encadenado o no cuenta.** Sin `BVSALA_GATEWAY_UPSTREAM` hacia el espía
>    (scripts/espia-anthropic.mjs 8402, que debe estar vivo) la sesión va
>    directa al proveedor y no entra en ningún brazo. Comprobación: `lsof -nP
>    -p <pid del gateway> | grep 8402`.
> 3. **El entitlement manda.** La palanca solo actúa con `context_elision` en
>    una licencia VIVA de la org (fail-closed). Hoy lo lleva la licencia de la
>    org propia (caduca 12-09-2026 con 21 días de gracia): un día par sin
>    peticiones ajustadas es «palanca mal armada», y la auditoría lo lista.
> 4. **La palanca fusiona, no pisa.** Claude Code manda de fábrica
>    `clear_thinking_20251015 keep:"all"` (corpus 09-2026; ya no manda
>    `clear_tool_uses`): la palanca conserva ese edit en posición 0 y solo
>    sustituye/añade el de tool_uses (`fusionarDiales`). El único delta entre
>    brazos es nuestro dial.
> 5. **Por modelo, no por día mezclado.** La métrica primaria por día (€ de
>    entrada por kTok de salida) va de 0,09 a 1,07 según el modelo; un día
>    dominado por opus-4-8 y otro por fable-5 no se comparan. El veredicto se
>    estratifica por modelo y el titular pondera por gasto del control.
> 6. **Cada mañana:** `pnpm anillo2` → sección `paridad`: brazo esperado vs
>    observado por día, config del cliente, versión de claude-cli, mezcla de
>    modelos y la lista de fisuras (día perdido, día mezclado, par sin
>    palanca). Con `insuficiente` no hay cifra; con menos de 3 días limpios por
>    brazo y modelo, tampoco.
> 7. **Preflight antes de lanzar (30 segundos, cada sesión).** El 06-09 el
>    brazo par corrió un día entero en una pestaña de terminal abierta en
>    agosto, SIN la clave de servicio en su entorno: la palanca no se armó, no
>    midió, no se capturó — control en silencio.
>    - pestaña NUEVA de terminal (o `source ~/.zshrc`): `echo ${BIVELIO_SERVICE_KEY:+clave presente}` debe imprimir «clave presente» (jamás el valor);
>    - espía vivo: `lsof -nP -iTCP:8402 -sTCP:LISTEN` devuelve una línea;
>    - tras lanzar, las dos líneas de arranque del gateway: `medición: ACTIVA` y
>      `elisión S4a: ARMADA … brazo PALANCA` (pares) o `APAGADA … brazo CONTROL`
>      (impares). Un «NO SE ARMA» en día par es abortar y relanzar.
> 8. **Cada noche:** `pnpm anillo2:conciliar --dia <hoy UTC>` → `fugas` debe
>    ser 0. Cruza los transcripts de Claude Code (`~/.claude/projects/**`,
>    que ven TODAS las sesiones de la máquina) con las capturas del espía por
>    `requestId` = `request-id` del proveedor. Una sesión «sin-encadenar» es un
>    día CONTAMINADO — sus turnos no están en ningún brazo — y se anota con su
>    dinero fuera del A/B; «parcial» también. Dos modos de fuga, con su firma
>    en `ps`: (a) `claude` A PELO — sin `ANTHROPIC_BASE_URL` en su entorno,
>    padre `-zsh`; pasa cuando la pestaña no tiene el alias `claude='bvsala
>    claude'` (pestañas abiertas antes de añadirlo al .zshrc), y exportar
>    `BVSALA_GATEWAY_*` en esa pestaña no encadena nada; (b) `bvsala claude`
>    SIN `BVSALA_GATEWAY_UPSTREAM` — hay gateway y medición pero el espía no
>    lo ve. Además, «espía mudo desde X» en las fisuras dice desde cuándo no
>    entra nada. Por qué: el 06-09 el 95 % de los turnos de la org (7
>    sesiones, ~$430) corrieron fuera del corpus por (a) y (b) juntas, incluida
>    la sesión que construía el propio anillo 2. La cifra «$ fuera del A/B» es
>    COTA INFERIOR: sale del usage del transcript (definitivo en el 99,6 % de
>    los turnos) y no incluye las peticiones laterales del cliente (títulos,
>    compactaciones: 11–14 % del dinero de una sesión encadenada) que una
>    sesión sin encadenar no deja en ninguna fuente. El artefacto solo lleva
>    ids, timestamps, modelo, versión de cliente, usage y nombre de proyecto.
>
> Estado 06-09: 8 días de corpus, TODOS control (0 peticiones ajustadas en
> 8,4 GB); ninguna respuesta con `applied_edits`. El brazo impar existente es
> limpio como control, pero el par aún no ha empezado: la sesión de hoy corrió
> sin bandera y sin encadenar.

**Interruptores de apagado, en tres niveles:** bandera local
(`BVSALA_GATEWAY_ELISION=0` mata la palanca en el proceso; el nombre
`BVSALA_GATEWAY_CONTEXT_DIALS` de la primera redacción no existe), revocación
per-org (retirar la feature de la licencia; el gate es fail-closed), y la
degradación automática a passthrough ante cualquier error o ante un upstream
que rechace la beta (un 400 con mención a `context_management` en una petición
ajustada ⇒ reintento inmediato con el cuerpo original + palanca en cuarentena
para esa sesión + aviso).

### 2.6 Gate por organización

- `Feature` gana `"context_elision"` (packages/protocol; unión cerrada) y entra
  en la emisión de licencias per-org — el mecanismo per-org ya existe entero.
- El gateway hoy NO sabe de licencias (0 referencias): se le da el canal mínimo
  — al arrancar con clave de servicio, `GET` de entitlements al control plane
  (o campo nuevo en la respuesta del ingest), cacheado, **fail-closed a
  APAGADO**: sin respuesta no hay palanca, y el tráfico jamás se corta.
- Encendido efectivo = feature en la licencia **y** bandera local del cliente:
  opt-in doble, como pide el plan maestro.

---

## 3. S4b · La elisión propia (fase 2, tras S4a)

Solo si tras S4a queda premio medible (la sombra v0 sigue enseñando ahorro POR
ENCIMA de lo que borra el servidor — la tarjeta sombra del panel responde esto
gratis, porque la sombra corre sobre el tráfico ya ajustado):

1. **Prerequisitos duros** (sin cambios respecto al plan): arnés carril 2 con
   comparador semántico y éxito de tarea (nace en el anillo 1 de S4a), verja de
   fidelidad POR CLASE de tool_result (multiconjunto de números/rutas/símbolos
   para logs y código — `compresionFiel` como molde, nueva implementación), y
   la decisión ToS del dueño para reescritura de contenido.
2. **Motor**: ya existe y está certificado en dinero (`aplicarPolitica` v0 +
   `CadenaDeSimulacion`); S2.5 (`costeEsperadoAmortizado` en economics, interna,
   con `turnos?` en `EntradaDecision`) pasa a ser la condición de emisión en
   vivo, como el plan ya especifica.
3. **Camino técnico pendiente identificado**: recompresión del cuerpo tras
   reescribir (existe descompresión, no el inverso) — necesario para Codex/zstd;
   y el baseline de facturación: para S4b el contrafactual es simulado, así que
   su ahorro nace como `estimated` (fuera de comisión) hasta que el A/B de días
   del arnés certifique la calibración org a org — decisión de facturación del
   dueño con las cifras delante.
4. **OpenAI**: sin equivalente nativo de context editing — S4b es la única vía
   para ese tráfico. El premio allí se dimensiona con el mismo replay sobre el
   corpus de Codex cuando haya masa.

---

## 4. Cronograma (2 semanas, con las verjas delante)

| Días | Trabajo | Sale |
|---|---|---|
| 1–2 | Anillo 0: replay de diales contra `count_tokens` sobre el corpus + módulo de diales con parámetros nombrados | La cifra «X %/mes con estos diales», del contador del proveedor, sin tocar tráfico |
| 2–4 | ✅ **HECHO (04-09)** — Gate per-org (`context_elision` en la unión `Feature` + `GET /api/org/entitlements` autenticado por bvk\_ + `CanalDeEntitlements` fail-closed en la pasarela) + palanca (`gateway/palanca.ts`: pura, sustituye solo `context_management` y fusiona la beta sin pisar las del cliente; cableada en servidor.ts tras la coalescencia; medición y clave de coalescencia sobre el cuerpo ORIGINAL). Interruptores: bandera local `BVSALA_GATEWAY_ELISION=1` (apagada por defecto) · feature per-org retirable (propaga ≤ 5 min, fail-closed) · passthrough ante cualquier anomalía. Verjas: test/gateway-palanca.test.ts (12) + org-entitlements (5) + features-en-paridad (3, ata las TRES listas de features que vivían sueltas) | Palanca construida, apagada, con sus tres interruptores |
| 4–7 | Anillo 1: corpus de 10–15 tareas con verificador + carril 2 mínimo (pares, sal de frío, éxito de tarea, QUALITY_FLOOR) | La verja que S4b también necesitará |
| 7–8 | Medición: applied_edits → informe measured de palanca propia + panel/extracto (carril medido; la sombra sigue aparte) | El ahorro S4a visible y facturable |
| 8–14 | Anillo 2: org propia, días alternos, barrido de diales si hace falta | La evidencia para el opt-in de clientes |
| 14 | **Decisión del dueño**: opt-in de clientes (a quién, con qué umbral de sombra propia) + adaptación del titular de la landing con la primera cifra measured de elisión | S4a EN CLIENTES |

S4b arranca solo después, con sus prerequisitos y su propia decisión.

---

## 5. Riesgos nuevos y qué los mata

| Riesgo | Mitigación |
|---|---|
| La beta cambia o desaparece (es beta pública, no GA) | Cabecera y estrategia fijadas por versión en el módulo de diales; ante 400 → reintento con cuerpo original + cuarentena + aviso; la palanca es reversible por construcción |
| El cliente ya traía config y nuestros diales la empeoran para SU caso | Solo se ajustan estrategias que entendemos; `exclude_tools` respetado; el delta se mide por petición y el A/B de días lo vigila; opt-in doble |
| Acreditarnos ahorro que no es nuestro | Regla del delta (2.4): solo peticiones donde nuestros diales difieren de los del cliente; verja en tests |
| `clear_tool_uses` borra algo que el agente necesitaba | Evidencia previa: el agente ya re-lee (144 %); el proveedor deja marcador de borrado y el agente re-ejecuta la herramienta; el anillo 1 lo cuantifica y el coste de re-lectura se resta del ahorro reportado si el A/B lo enseña material |
| El servidor borra y la SOMBRA v0 cuenta doble (elide lo ya borrado) | La sombra corre sobre el cuerpo que VIAJA (post-ajuste): el doble conteo es imposible por construcción; test que lo fije |
| Sobre-ajuste de diales a nuestra org | Los diales son per-org a futuro; el opt-in de clientes exige SU sombra propia ≥ umbral, no la nuestra |

---

## 6. Qué se decide hoy (dueño)

> **✅ LAS TRES APROBADAS por el dueño el 2026-09-04, tal como estaban
> propuestas** (literal: «1) Sí … 2) Variante b … 3) ≥ 8 puntos sostenidos …
> así que sabiéndolo todo a tope!»). Los días 2–4 del cronograma quedan
> desbloqueados.

1. **La partición S4a/S4b y el orden** (este plan). Sin esto no hay quincena.
   — **APROBADA.**
2. **Postura ToS para S4a**: variante (b) con superficie mínima — ajustar SOLO
   `context_management`. (S4b tendrá su propia decisión más adelante.)
   — **APROBADA.**
3. **El umbral del opt-in de clientes** (propuesta del plan maestro: sombra
   propia ≥ 8 puntos sostenidos; aquí no cambia). — **APROBADA.**
