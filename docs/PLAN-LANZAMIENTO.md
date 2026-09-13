# Plan de lanzamiento — BV-SALA

**Estado: 2026-08-11.** Documento vivo. Es la referencia única de qué falta para poder
vender, en qué orden y quién hace cada cosa.

---

## El listón: qué significa "poder salir"

Sin esto escrito, cada uno entiende "estamos listos" de una manera distinta. Podemos
salir cuando las tres son ciertas:

1. **Alguien puede pagar y recibir el producto** — probado contra el sistema real, no
   supuesto a partir de tests con dobles.
2. **Si se rompe, nos enteramos nosotros antes que el cliente.**
3. **Lo que decimos que hace, lo hace — y lo publicado es lo arreglado.**

Hoy fallan las tres.

---

## Hechos confirmados (no suposiciones)

| Hecho | Cómo se sabe |
|---|---|
| Stripe opera en **EUR** y en **modo REAL** | Confirmado por el dueño, 2026-08-11 |
| El circuito de cobro **nunca se ha ejercitado**: 0 eventos de Stripe, 0 suscripciones, 0 licencias emitidas | Consulta a la BD de producción |
| `@bivelio/savings-layer@0.1.0` **está publicado en npm** desde 2026-08-09 y **no tiene ninguno de los arreglos** | El `dist/index.d.ts` del tarball publicado no contiene `toolCalls` ni `licenseRefresh` |
| La clave que firma en producción **sí** es pareja de la que embarca el SDK | Firma de `/licenses/revocations` verificada contra `keys/license.pub.pem`, con control negativo |
| La migración 0012 (`subscriptions.last_event_at`) **sí** está aplicada en producción | Consulta al esquema vía Management API |
| No hay CI, ni checks obligatorios, ni pruebas end-to-end, ni monitorización | `.github/workflows/` solo tiene `publish.yml`; `gh api .../branches/main/protection` no devuelve `required_status_checks` |
| La comparativa que alimenta la web **sí es real** (`mode: LIVE`) pero mide **un solo modelo** | `apps/web/public/data/ab-live.json`: 27,1% punto, 23,1% cota inferior al 95%, sobre `openai/gpt-4o-mini` |

---

## 🔴 Riesgos vivos AHORA MISMO

Estos no esperan a ninguna fase: están en producción mientras lees esto.

1. **Se anuncian dólares y se cobran euros.**
   `https://savings.bivelio.com/landing.html` responde 200 y dice *"Priced per seat,
   in USD · $4 / seat / month · $39 / seat / year"*. Stripe cobra **EUR en real**. Un
   visitante lee 4 dólares y se le cobran 4 euros. El `README.md` (portada de npm)
   dice lo mismo. No es cosmética: es lo que ve el comprador antes de pagar.

2. **Esa misma página publica el banco de pruebas MOCK antiguo.**
   `landing.html` lleva incrustado `{"mode":"MOCK", …, "headline":"ESTIMATED (mock) —
   not a savings claim"}` con un 54% agregado. Es exactamente el material que la
   auditoría original marcó como deshonesto y que creíamos retirado al portar la
   landing a React. La landing buena (`/es`, `/en`, …) usa el artefacto LIVE; esta es
   una segunda página pública y obsoleta.

3. **El producto instalable es el roto.**
   Quien haga `npm i @bivelio/savings-layer` hoy se lleva la 0.1.0: tira las llamadas
   a herramienta y apaga al cliente mensual el día ~45.

---

## Fase 0 — Desbloqueo (horas · bloquea todo lo demás)

| # | Tarea | Quién |
|---|---|---|
| 0.1 | **Publicar 0.2.0 en npm.** Necesita un `NPM_TOKEN` de tipo *Automation*: el de tipo *Publish* falla con `EOTP` en CI. Va después de mergear el PR #25. | Dueño (token) + yo |
| 0.2 | **Retirar o redirigir `public/landing.html`** y corregir el `README.md` a EUR. Cierra los riesgos 1 y 2 de golpe. | Yo |
| 0.3 | **Verificar el webhook en Stripe**: que exista apuntando a `https://savings.bivelio.com/api/stripe/webhook`, que su *signing secret* case con `STRIPE_WEBHOOK_SECRET` en Vercel, y que estén suscritos los **siete** eventos. | Dueño |
| 0.4 | Decidir sobre los PR abiertos y viejos: **#22** (auth, marcado inerte) y **#14** (Stripe, ya integrado en main por otra vía). | Dueño |

**Los siete eventos que el webhook debe tener suscritos:**

```
checkout.session.completed
checkout.session.async_payment_succeeded   ← añadido 2026-08-10; casi seguro NO suscrito
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
invoice.paid
invoice.payment_failed
```

> Con 0 eventos recibidos en toda la historia, no se distingue "nadie ha pagado" de
> "el webhook no está registrado". Si es lo segundo, el cliente paga, Stripe cobra, y
> **no pasa nada más**: sin licencia, sin plan, sin nada.

---

## Fase 1 — Ejercitar el circuito (1-2 días)

Todo el código de cobro está verificado contra dobles y **nunca ha visto un evento
real**. Aquí es donde la realidad muerde.

**Cómo, dado que producción está en modo REAL:** montar un despliegue *preview* de
Vercel con claves de Stripe de **test** y su propio endpoint de webhook. Así se
ejercita todo sin mover dinero y sin tocar producción. Al final, un único cargo real
pequeño y reembolsado como comprobación de que el modo real también está bien cableado.

Los siete escenarios, y qué arreglo verifica cada uno:

| Escenario | Verifica |
|---|---|
| Primera compra completa | El camino que estaba roto de origen (B1/B2) |
| Pago asíncrono SEPA (`incomplete` → activo) | `ensurePrimeraLicencia` y `async_payment_succeeded`. Crítico en EUR/España |
| Eventos fuera de orden | La guardia `stale` y que aun así se emita la PRIMERA licencia |
| Renovación (Test Clock de Stripe) | Que el SDK recoja el token nuevo con `bvk_` y no muera el día 45 |
| Cancelación → revocación | Que el ingest devuelva 402 y el SDK se pare |
| Impago → `past_due` → gracia | Los 21 días de *dunning* (`lib/billing/gracia.ts`) |
| Redes de tarjeta + 3D Secure | SCA es obligatorio en la UE: sin ello se pierden cobros legítimos |

---

## Fase 2 — Que no se rompa en silencio (1-2 días)

| # | Tarea | Qué detecta que hoy pasa desapercibido |
|---|---|---|
| 2.1 | CI con `pnpm test`, `typecheck:all` **y el build de `apps/web`**, como check obligatorio en `main` | Hoy se puede mergear en rojo. El build de la web es lo ÚNICO que typechequea el código que cobra (`typecheck:all` no lo cubre). Ojo: hay un segundo lockfile en `apps/web` que rompe el workflow ingenuo |
| 2.2 | Sonda: verificar periódicamente la firma de `/licenses/revocations` contra `keys/license.pub.pem` | Si esa pareja de claves se rompe, **ninguna licencia vale** y nadie se entera |
| 2.3 | Invariante: *"¿hay alguna org con suscripción activa y sin licencia viva?"* | Es exactamente el fallo que costó dos días. Necesita un cron (no hay `vercel.json`) |
| 2.4 | Monitorización de errores | Hoy son 25 `console.error` que no sobreviven ni disparan nada |

---

## Fase 3 — Que el recorrido se entienda (2-3 días)

Todo esto sale de la revisión de recorridos del 2026-08-11.

| # | Tarea | Detalle |
|---|---|---|
| 3.1 | **El fragmento del paso 4 no compila pegado tal cual** | `provider`, `model`, `messages` y `response` son identificadores inexistentes, y no hay un solo ejemplo de proveedor en toda la documentación. Es el paso que convierte a quien paga en quien funciona |
| 3.2 | Estados de fallo del dinero sin texto | `past_due` invisible (el dato está en la BD y el panel lo tira); caducidad y gracia no se muestran en ninguna pantalla; los errores del circuito de dinero llegan en inglés en los 12 idiomas |
| 3.3 | Mensajes del SDK que mandan a la acción equivocada | Una clave mal pegada dice *"Renueva tu suscripción"*; con la salida de red bloqueada dice *"expired"* y manda a renovar una licencia pagada; una `bvk_` rotada no reporta nada y el panel dice que instales el SDK |
| 3.4 | El panel no dice en qué variables de entorno guardar las dos claves | Ni menciona `BVSALA_SEAT_ID`, del que depende la factura en Kubernetes |
| 3.5 | Dentro del panel no hay ningún enlace a comprar salvo la pestaña Cuenta | La guía de activación de 5 pasos no menciona suscribirse |

---

## Fase 4 — Cumplir con lo que vendemos (1-2 días)

| # | Tarea | Por qué |
|---|---|---|
| 4.1 | **Unificar la moneda** leyéndola del Price de Stripe (`unit_amount` + `currency`) en vez de escribirla a mano | Hoy hay tres verdades: `landing.html` en USD, la app en EUR, el README en USD. Los importes están escritos a mano en `AccountPlanStrip.tsx` y `TrialKeyButton.tsx` |
| 4.2 | **Acotar o ampliar la cifra de ahorro** | El ≥23,1% está medido sobre **un solo modelo**. O se corre el banco contra 2-3 más, o se acota la afirmación a lo medido. Es lo único que separa lo que decimos de lo que hemos demostrado |
| 4.3 | **IVA / impuestos** | El checkout no fija `automatic_tax`, `tax_id_collection` ni `billing_address_collection`: el importe final aparece por primera vez en la pantalla de la tarjeta y no hay forma de meter el NIF/VAT. Entidad US vendiendo a la UE: **requiere criterio fiscal, no solo código** |

---

## Solo el dueño (fuera del camino crítico, pero pendiente)

- Rotar `service_role`, `SUPABASE_ACCESS_TOKEN`, `RESEND_API_KEY` y `DATABASE_URL_PROD`.
  El proyecto de Supabase es **compartido**: rotar invalida las claves de todos los
  consumidores hasta que cada entorno se actualice y redespliegue. No es automatizable
  a ciegas.
- Mover la clave de firma Ed25519 a KMS. La tubería de `kid` ya está lista: basta con
  fijar `LICENSE_KEY_ID` y un `LicenseKeyset`.

---

## Ya cerrado (para no re-litigarlo)

- **Los 7 bloqueantes** de la re-verificación (`main`, desplegado y verificado en vivo).
- **Las 3 regresiones** que esos propios arreglos introdujeron, incluida una crítica que
  dejaba sin licencia al que paga.
- **Las medias** de esa misma revisión: refresher sin timeout, adopción de token
  revocado, silencio ante 401, `structurallyValid` mintiendo en turnos de herramienta,
  `router:false` saltándose `maxTools`.
- **El panel de instalación en los 12 idiomas** + test de paridad que impide que vuelva
  a derivar (PR #23, mergeado).
- **Los dos textos bloqueantes del pago** (PR #25, abierto).
- **Protección de rama en GitHub** con `enforce_admins`, que es la única capa que no
  depende de la buena voluntad de nadie.

---

## Estimación honesta

**5-8 días de trabajo mío** en el camino crítico, más las comprobaciones de la Fase 0,
que son minutos del dueño pero bloquean todo.

Dos avisos sobre la estimación: las fases 1 y 4 pueden alargarse porque dependen de lo
que aparezca al ejercitar el circuito por primera vez, y los días son una estimación
mía sin haberme peleado todavía con Stripe real.
