# Onboarding: del `npm install` a la primera prueba que dice «ok»

**Fecha:** 27‑sep‑2026 · **Línea:** onboarding (una de diez) · **Rama:** `feat/onboarding` · **Producto:** `@bivelio/savings-layer` 0.4.25
**Etiquetas:** **[oficial]** = documentación del propio proyecto, leída hoy; **[marketing]** = cifra o promesa del vendedor sin método; **[medido]** = lo ejecutamos nosotros en esta rama, con el comando o el test que lo reproduce.

---

## 1. Pregunta

¿Qué necesita un desarrollador para pasar de «he oído hablar de BV‑SALA» a «la capa está en mi código y sé que funciona», y cuánto de eso podemos acortar hoy **sin** cambiar la política comercial (fail‑closed, sin free tier ni trial, decisión #314) y sin escribir nada en su proyecto sin permiso?

La referencia es cómo lo resuelven en «5 minutos» Portkey, Helicone, LiteLLM y Langfuse, y los asistentes de instalación que hoy fijan las expectativas (Sentry, PostHog, shadcn, Mastra).

## 2. Método y límites

- Documentación oficial vigente, leída con WebFetch el 27‑sep‑2026 (§3). **Límite:** el presupuesto de WebSearch de la sesión estaba agotado, así que no hubo búsqueda abierta de mediciones independientes del «tiempo hasta el primer valor». No afirmamos que no existan; solo que no las buscamos.
- Contexto de mercado: el informe de competencia del 26‑sep (`docs/COMPETENCIA-2026-09-26.md`).
- Código del repo: `gateway/bin.ts`, `gateway/doctor.ts`, los cuatro adaptadores de `src/adapters/`, el README y las verjas que lo atan.
- Pruebas propias (§4): cada adaptador ejecutado con su framework real y la red prohibida, y un `next build`/`next dev`/`next start` real con los ficheros que genera `init`.

## 3. Hallazgos del mercado (fuentes numeradas)

| # | Fuente (consultada el 27‑sep‑2026) | Qué dice | Etiqueta |
|---|---|---|---|
| 1 | npm, `npm exec` — docs.npmjs.com/cli/v11/commands/npm-exec | Con **un solo** `bin`, `npx <paquete>` ejecuta ese comando; con varios, solo el que se llame como el paquete sin scope, y si no, error. Sin TTY o en CI asume `--yes` para instalar. | oficial |
| 2 | Helicone, Quick Start — docs.helicone.ai/getting-started/quick-start | «…in under 2 minutes». Dos pasos: cuenta (free tier) y cambiar `baseURL` + cabecera `Authorization`. Sin CLI. | oficial · la cifra es marketing |
| 3 | Portkey, «Make your first request» — portkey.ai/docs/introduction/make-your-first-request | «Integrate Portkey and analyze your first LLM call in 2 minutes!». Cuenta + API key + configurar el cliente. Sin CLI. | oficial · la cifra es marketing |
| 4 | LiteLLM, Docker quick start — docs.litellm.ai/docs/proxy/docker_quick_start | `curl` del compose, claves generadas con `openssl`, `docker compose up`, modelos por la UI; el cliente apunta `base_url` al proxy. «Budgets are not enforced without a database». | oficial |
| 5 | Langfuse, Get started — langfuse.com/docs/observability/get-started | Siete pasos (cuenta, claves, paquetes por framework, variables, OpenTelemetry, instrumentar, ejecutar). **Sin asistente CLI**; recomienda instalar su *Agent Skill* o su plugin de Cursor para que el agente de código lo haga. | oficial |
| 6 | Langfuse, agent skills — github.com/langfuse/skills | `npx skills add langfuse/skills --skill "langfuse"`. | oficial |
| 7 | Sentry, Next.js — docs.sentry.io/platforms/javascript/guides/nextjs/ | `npx @sentry/wizard@latest -i nextjs`: crea `instrumentation*.ts`, configs, **envuelve `next.config`**, crea una página de ejemplo y un fichero con token. La página no dice si pide permiso antes de escribir. | oficial |
| 8 | PostHog AI wizard — posthog.com/docs/ai-engineering/ai-wizard | `npx -y @posthog/wizard@latest`: «agentic CLI tool that uses AI», escribe código y configura `.env`. La página no describe revisión ni aprobación de cambios. | oficial |
| 9 | shadcn CLI — ui.shadcn.com/docs/cli | `init -y, --yes`: «skip confirmation prompt. (default: true)»; `add --dry-run`, `--diff`, `--view` para ver antes de escribir. | oficial |
| 10 | Mastra CLI — mastra.ai/reference/cli/mastra | `mastra init` con `--default`, `--dir`, `--llm`, `--llm-api-key` (la escribe en un fichero de entorno), `--example`. | oficial |
| 11 | Next.js, `route.js` (v16.3.6, act. 30‑abr‑2026) — nextjs.org/docs/app/api-reference/file-conventions/route | «v15.0.0‑RC: The default caching for `GET` handlers was changed from static to dynamic»; `runtime` por defecto `'nodejs'`. | oficial |
| 12 | Mastra + Next.js — mastra.ai/guides/getting-started/next-js | Node v22.13.0 o posterior; no documenta cambios en `next.config`. | oficial |
| 13 | Informe de competencia, 26‑sep‑2026 (§2.2, §5.2) | Portkey pasa a Palo Alto (29‑may‑2026), Helicone se une a Mintlify (3‑mar‑2026), Langfuse es de ClickHouse (16‑ene‑2026). BV‑SALA sin free tier ni trial (#314), 2.939 descargas/mes. | interno, con fuentes |
| 14 | Registro de npm (`npm view`, 27‑sep‑2026) | `express` 5.2.1 (latest, modificado el 18‑sep‑2026), `@types/express` 5.0.6, `@langchain/openai` 1.6.0 (peer `@langchain/core ^1.2.13`), `@ai-sdk/anthropic` 4.0.65 (mismos `@ai-sdk/provider` 4.0.18 y `provider-utils` 5.0.49 que `@ai-sdk/openai` 4.0.78). | oficial |

**Lectura.** Los «2 minutos» de Helicone y Portkey son promesas de sus propias páginas, sin método: no son una medición [marketing]. Y lo que prometen es corto porque son **proxies**: cambias una URL y una cabecera, a cambio de mandar tus prompts a un tercero (lo contrario de lo que vende BV‑SALA) y de abrir una cuenta. LiteLLM autoalojado ya son varios pasos con Docker. Langfuse, que como BV‑SALA entra en el código, tiene siete pasos y los delega en el agente de código del usuario. Los asistentes (Sentry, PostHog) escriben en el proyecto, y PostHog lo hace con un LLM; ninguna de sus páginas documenta una aprobación explícita antes de escribir, y shadcn salta la confirmación por defecto.

## 4. Hallazgos en nuestro producto (medidos en esta rama)

| # | Qué | Cómo se reproduce | Efecto en el primer uso |
|---|---|---|---|
| M1 | `createAgent({ model: "openai:gpt-4o-mini" })` sin `@langchain/openai` falla en `invoke`, **antes** del middleware: «Unable to import @langchain/openai». El README mandaba instalar `langchain @langchain/core` y nada más. | langchain 1.5.14, `examples/stacks/langchain` sin el paquete | El ejemplo del README no corría pegado tal cual. **Arreglado** en el README y en `init`. |
| M2 | Con ese mismo modelo en cadena, el adaptador llamaba al modelo `chat_model/` y lo tarifaba al **precio ilustrativo**: LangChain lo entrega como `ConfigurableModel`, cuyo nombre vive en `_defaultConfig`. | `test/adaptadores/langchain-modelo-en-cadena.test.ts` (sin el arreglo: `Received: "chat_model/"`) | Coste en dólares que no cuadraba con la factura en el camino del README. **Arreglado** en `src/adapters/langchain.ts`, con una llamada real contra un `fetch` falso de la Responses API que ahora sale `measured` y al precio de la fila de `gpt-4o-mini`. |
| M3 | `@anthropic-ai/sdk` 0.128 sin `ANTHROPIC_API_KEY` lanza `WorkloadIdentityError` (busca `~/.config/anthropic/credentials`) antes de que corra el middleware, aunque la capa fuera a contestar sin llamar. | `examples/stacks/anthropic-sdk` sin la variable | Error confuso en la primera prueba. `init` lo avisa en la tabla de claves. |
| M4 | `@mastra/core` 1.71 sin `OPENAI_API_KEY` imprime «[ModelRouter] Failed to resolve supportedUrls…» con traza, pero la capa contesta. | `examples/stacks/mastra` sin la variable | Ruido que parece un fallo. `init` lo avisa. |
| M5 | El AI SDK 7 y el SDK a secas no necesitan la clave del proveedor para la pregunta que contesta la capa. | `examples/stacks/{ai-sdk,express}` | La comprobación gratuita funciona sin clave del proveedor. |
| M6 | Next.js 15.5.20 real, con los ficheros que escribe `init` y el paquete del tarball: `next build` **sin licencia** termina y marca la ruta como dinámica (ƒ); `next dev` responde 500 con el mensaje de licencia y el enlace; `next start` responde 404. | Proyecto de prueba en el scratchpad con el `next` de `apps/web` | La comprobación no rompe el build ni queda viva en producción. Sin `force-dynamic`, Next.js 14 la ejecutaría en el build [11]. |
| M7 | Una respuesta de la capa (resolver) genera un registro de uso (`avoidedLlm: 1`, basis `estimated`) si hay `serviceAccountKey`. | Sonda con `meteringFetch` espía | La comprobación no es invisible para la medición; no prometemos que se vea en el panel. |
| M8 | El SDK es fail‑closed y la 0.4.25 no tiene modo sin licencia. El mensaje de `LicenseError` ya dice qué hacer (`sala-limpia-del-tarball`). | `init-desde-el-tarball.test.ts` | El tiempo hasta el primer «ok» incluye **conseguir una licencia de pago**. |

## 5. Opciones

| Opción | Qué es | A favor | En contra |
|---|---|---|---|
| A | Solo documentación por pila | Barato | El README ya tiene cuatro secciones y aun así tenía M1; no detecta nada ni comprueba nada. |
| **B** | **`init` que detecta la pila e imprime, más escritura opcional de ficheros NUEVOS con permiso y una comprobación gratuita** | Un comando; el código exacto para la pila detectada; no toca nada del usuario; se puede probar entero | No acorta la compra de la licencia (M8). |
| C | Asistente que modifica ficheros existentes (`next.config`, rutas), al estilo Sentry [7] | Menos pasos manuales | Riesgo real de romper el proyecto de otro; la tarea exige no escribir sin confirmación explícita; y BV‑SALA no necesita tocar la configuración. |
| D | Asistente con LLM, al estilo PostHog [8] | Cubre casos raros | Manda el código del cliente a un LLM, justo lo que BV‑SALA promete no hacer; no es determinista ni se puede probar. |
| E | *Agent skill* de instalación, al estilo Langfuse [5][6] | Barato, y el repo ya distribuye `skills/` | Complementa, no sustituye: el agente necesita una fuente de verdad. `init --json` puede ser esa fuente. |
| F | Licencia gratuita «Medir» o trial | La palanca de mayor efecto sobre el tiempo hasta el primer valor (informe de competencia, §6.3 y §8 n.º 5) | Es una decisión del dueño (revierte parte de #314). No se construye aquí. |

## 6. Decisión y porqué

**B, con `--json` para que un agente (E) pueda usarlo después.** Es lo único que acorta el camino sin tocar la política comercial ni el código existente del cliente, y todo lo que imprime se puede probar: se compila y se ejecuta en CI. Descartamos C y D por el principio de la tarea (nada se escribe sin confirmación explícita) y por la promesa de privacidad del producto. F queda como recomendación para el dueño: sin ella, el «5 minutos» de BV‑SALA empieza cuando ya se tiene una licencia.

## 7. Qué se construye hoy

1. **`bvsala init`**, que también se lanza con `npx @bivelio/savings-layer@latest init` porque el paquete tiene un solo `bin` [1] (hay un test que lo vigila). `gateway/init.ts` y `gateway/init-fragmentos.ts`.
   - **Detecta** Next.js (App Router en `app/` o `src/app/`), Express o Node a secas; la capa por la que se llama al LLM (Mastra > LangChain.js > Vercel AI SDK > SDK de Anthropic > SDK de OpenAI, y nombra las demás); el proveedor por el paquete del framework; el gestor de paquetes (`packageManager` o el lockfile, subiendo hasta la raíz del monorepo); TypeScript, ESM o CommonJS; y la versión **instalada** (la de `node_modules`, o la mínima del rango).
   - **Imprime** la línea de instalación para su gestor (solo lo que falta, con `gpt-tokenizer` si el modelo es de OpenAI y el paquete de integración de LangChain si falta, M1), las claves que faltan (**solo** «set» o «not set»), el cableado con su adaptador, un ejemplo de uso (ruta de Next.js o servidor Express) y la comprobación gratuita.
   - **Lee solo ficheros `package.json`** (el del proyecto, y los de `node_modules` para la versión instalada). De `.env`, `app/`, `src/` y lockfiles mira la existencia. No usa la red, no instala nada y no ejecuta nada del proyecto.
   - **`--write`** crea solo ficheros **nuevos**, tras un «y/yes» explícito en la terminal (sin terminal, exige `--yes` y si no sale con 1 sin escribir). Nunca pisa: usa `wx`, así que un fichero que aparezca entre la pregunta y la escritura también se respeta.
   - **La comprobación gratuita** (`bivelio-check.mjs`, o `app/api/bivelio-check/route.ts` en Next.js) pregunta 2 + 2 * 3, que contesta el resolver de la capa: con la capa en su sitio no se llama al modelo y el ahorro sale `estimated`, que nunca se cobra. Imprime `ok: …` o `not ok: …` con qué hacer y sale con 0 o 1. La ruta de Next.js lleva `force-dynamic` y responde 404 en producción (M6).
   - **Errores que dicen qué hacer:** sin `package.json` (y el caso Python, que recibe la receta del gateway); `package.json` roto; Node < 20; versión de framework fuera de rango (pasa a la siguiente opción y da el comando para actualizar); raíz de monorepo; proyecto CommonJS; opciones desconocidas o combinaciones sin sentido; la capa que no ve la llamada («tiene que ir la ÚLTIMA de la lista»).
   - `--stack` y `--provider` fuerzan la elección, y `--json` saca el plan para un script o un agente.
2. **`examples/stacks/`**, un ejemplo por pila (Next.js + AI SDK, Express, AI SDK, Mastra, LangChain.js y SDK de Anthropic). Son **la salida de `init`** para un proyecto mínimo de cada pila, regenerada con `pnpm init:ejemplos`, y se ejecutan con `pnpm example:<pila>`.
3. **Arreglo del adaptador de LangChain** (M2) y del README (M1, más una sección «Set it up in one command»).
4. **Tests:** `init-deteccion` (36: argumentos, detección, plan, escritura con permiso, y que solo lee `package.json`), `init-ejemplos` (18: los ejemplos son la salida de `init`; **todas** las combinaciones capa × proveedor × anfitrión compilan en strict con un tsconfig de aplicación y son JavaScript válido; los seis ejemplos se **ejecutan** con sus frameworks reales y la red prohibida; la puerta cerrada da «not ok»; el CLI real no escribe sin permiso y no pisa), `init-desde-el-tarball` (el `bin` del artefacto de npm: `init --write --yes` y la comprobación sin clave dicen «not ok» con el enlace, sin sugerir un modo sin licencia) y `langchain-modelo-en-cadena` (M2). `typecheck:all` compila además `examples/stacks` con su tsconfig.
5. **Dependencias de desarrollo** fijadas a versión exacta, solo para ejecutar los ejemplos en CI: `express` 5.2.1, `@types/express` 5.0.6, `@langchain/openai` 1.6.0 y `@ai-sdk/anthropic` 4.0.65 [14]. No entran en el tarball.

## 8. Qué queda

- **Publicar** la versión que lleve `init`. Hasta entonces, `npx @bivelio/savings-layer@latest init` baja la 0.4.25, que no lo tiene y responde con la ayuda y exit 1. **Decisión del dueño.**
- **La licencia gratuita «Medir»** (opción F). Es lo que de verdad acorta el camino (M8). **Decisión del dueño.**
- Poner `npx … init` en el panel de instalación de la web (`InstallLicensePanel`) **después** de publicar, para no anunciar algo que npm todavía no sirve.
- Un *agent skill* de instalación que lea `init --json` (opción E).
- Variantes que hoy caen en el script: la ruta de comprobación para el Pages Router, y listar los paquetes de un monorepo que llaman al LLM en vez de solo avisar.
- La clave del proveedor en Mastra y Anthropic (M3, M4) es comportamiento de esos SDK: lo avisamos, no lo arreglamos.

## 9. Riesgos

| Riesgo | Mitigación |
|---|---|
| `npx …@latest` ejecuta en la máquina del cliente la última versión publicada. Mientras el repositorio sea privado, `publish.yml` publica **sin provenance**. | Trusted publishing y SBOM (#331). La provenance llega cuando el repo sea público, que es decisión del dueño. |
| Un fragmento deja de compilar con otra versión del framework. | Compilación y ejecución en CI con versiones exactas; `init` comprueba los rangos de cada adaptador antes de proponerlo. Otras versiones dentro del rango no se prueban. |
| Detección errónea en proyectos atípicos. | Todo es impreso y revisable; `--stack` y `--provider` fuerzan la elección, y nada se escribe sin permiso. |
| La ruta de comprobación llega a producción. | 404 en producción y `force-dynamic` (M6); la cabecera pide borrarla cuando diga «ok». |
| Filtrar un secreto por la salida. | Solo se consulta la existencia de las variables; `.env` no se abre (hay un test que falla si se lee otra cosa que `package.json`, y otro que busca el contenido de un `.env` en la salida). |
| Una versión vieja instalada en local responde en lugar de la nueva. | Recomendamos `npx …@latest`. |

## 10. Cómo se medirá el efecto

`init` no manda telemetría y no se le va a añadir: sería contradictorio con la promesa del producto. El efecto se mide con lo que ya existe:

1. **Tiempo desde que se emite la licencia hasta el primer registro de uso de la organización.** El servidor ya tiene las dos fechas. Hay que comparar las cohortes de antes y de después de publicar la versión con `init`, y publicar la mediana con su tamaño de muestra.
2. **Proporción de organizaciones con licencia y sin ningún registro a los 7 días.** Es la gente que se atasca antes del primer «ok».
3. **Correos a soporte sobre la instalación**, antes y después, clasificados por causa (M1–M4).
4. **En CI**, el camino completo desde el tarball (`init-desde-el-tarball`) tiene que seguir en verde. Es el control de que el primer paso no se rompe.

Hoy no hay línea base publicada de (1) ni de (2). Sacarla es el primer paso de la medición, antes de publicar.
