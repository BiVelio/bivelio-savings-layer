# La licencia «Medir» (plan `measure`)

> Decisión del dueño (2026-09-29), sobre la recomendación de
> [COMPETENCIA-2026-09-26.md](./COMPETENCIA-2026-09-26.md) §8 n.º 2 y 5:
> licencia **gratuita, permanente y sin tarjeta**. Revierte **en parte** #314.
>
> Decisiones del dueño sobre #417 (2026-09-29): **límites aceptados** (5
> asientos/mes, 20 000 peticiones/día, token de diez años con 30 días de
> gracia); **al cancelar o dejar de pagar, la org vuelve a Medir sola**;
> **correos desechables bloqueados** en el alta; **la rebaja de TTL** entra en el
> «habrías ahorrado» de la pasarela; migración **0033** (tras la 0032 de #412).

## Qué es

Una licencia firmada más —Ed25519, verificada **offline** como las de pago— con
`plan: "measure"` y **sin features**. Con ella:

| Superficie | Qué hace | Qué NO hace |
|---|---|---|
| SDK (`createSavingsLayer`) | La petición sale por la **llamada directa** (la del fail‑open): `{model, messages, tools, schema, maxOutputTokens, temperature, seed, reasoningEffort}` tal cual. Mide el gasto con el contador del proveedor y publica `report.measure` | Ninguna etapa del optimizador mira la petición: ni resolvers, ni caché exacta o semántica, ni singleflight, ni compresión, elisión, cascada, codebook, marcas de caché de prefijo, tier diferido o lotes (`batches.submit` → `LicenseError` status `measure`). La verificación A/B no lanza copias |
| Pasarela (`bvsala`) | Proxy byte a byte; mide el uso; registra como `shadow` lo que el **modelo hermano** y la **rebaja de TTL** habrían ahorrado sobre ese mismo usage | Ni diales, ni hermano, ni esfuerzo, ni TTL, ni coalescencia, ni inyección de `stream_options`, ni el carril de investigación de la elisión |
| Servidor | Ingiere el uso para el panel | Nunca comisión ni referencia cobrable (ver abajo) |

Se decide **por petición** (`licenseGate.plan()` en el SDK, `live.license.payload.plan`
en la pasarela): al pasar a pago, el refresco de licencia recoge la de pago y la
siguiente petición ya aplica palancas, sin reiniciar.

El fail‑closed **no cambia**: sin clave no hay capa, y la org sin NINGUNA licencia
sigue recibiendo el 402 `no-license` de #314. Lo que se abre es una licencia más.

## «Esto habrías ahorrado» (`report.measure`)

```ts
report.measure = {
  mode: "shadow",
  applied: false,
  wouldHaveSaved: { usd, basis: "shadow", avoidedCall: "exact-repeat" | "in-flight-duplicate" | null },
  notSimulated: ["semantic_cache", "compression", "model_cascade", …],
  upgradeUrl: "https://savings.bivelio.com/dashboard/account",
}
```

Solo se simulan las dos palancas que **evitan la llamada**, porque se pueden
valorar sin inventar nada: la llamada que se habría evitado es ESTA y su coste
lo acaba de declarar el contador del proveedor (`cost.actual`). «Idéntica» se
calcula con las mismas claves que el camino optimizado (`buildExactKey`,
`buildInflightKey`) y la misma política (`evaluatePolicy`, exclusiones de la
etapa 12: herramientas, truncadas, negativas, temas sensibles…). La memoria
guarda **hashes e instantes**, nunca una respuesta. Es por proceso: en una flota
con Redis compartido la cifra es una **cota inferior**. Todo lo demás va en
`notSimulated`.

El emisor manda, además del registro medido (baseline == actual), un registro
`basis: "shadow"` con id `<requestId>:shadow` cuando `usd > 0`. La RPC 0021 lo
acumula solo en `shadow_*`, que ningún cierre lee.

### En la pasarela: el modelo hermano y la rebaja de TTL

La pasarela reenvía el cuerpo intacto y, con el usage que el proveedor declara,
calcula **un** registro `shadow` por petición (`/v1/messages`, API oficial,
tráfico facturado por token, respuesta cobrada) con la misma aritmética que
acreditan las palancas de pago:

- **Modelo hermano** (palanca C): el mismo usage a otro precio de catálogo.
- **Rebaja de TTL** (`cache_ttl_tuning`): la capa toma la **misma decisión** que
  la palanca real —memoria de prefijos por hilo, fracción nueva del prompt,
  marcas `cache_control` de 1h que rebajaría— sobre el cuerpo del cliente, sin
  reescribir nada (`rebajaSombra` en `gateway/servidor.ts`). Si la habría
  aplicado, el ahorro es `escritos a 1h × entrada × (2 − 1,25)`
  (`gateway/tarifa.ts#ahorroDeRebajaEnSombra`), al precio del modelo que habría
  servido. Las mismas exclusiones que la palanca de pago: marcas de 5m del
  cliente o herramientas de servidor → 0 (el usage no dice qué bloque escribió
  qué).

Nunca se aplica ni se cobra: `test/gateway-licencia-medir.test.ts` fija que el
upstream recibe la marca `"ttl":"1h"` byte a byte, que lo medido queda con
baseline == actual y que la sombra es exactamente 0,75 $ en su ejemplo.

## Nunca comisión

`app/api/metering/usage` → `decideEntitlement` devuelve `measure-license` para
una org con Medir viva y sin licencia de pago ni suscripción que cubra. Entonces,
antes de la RPC, `neutralizarParaMedir`:

- `reference` → `estimated`, sin puntero: ninguna fila en `reference_hits`;
- todo registro no‑sombra: baseline == actual, sin tokens eliminados ni
  comprimidos, sin llamada evitada, sin suelo de elisión, `netSavings` 0;
- `shadow` pasa intacto.

Con el SDK honrado no cambia nada. Existe por el SDK parcheado. Fijado en
`apps/web/app/api/metering/usage/medir.test.ts`, incluido que el extracto que
saldría de esos registros cobra 0.

`hasValidLicense` ya **no** cuenta una Medir: el barrido de impago y el invariante
«paga y no tiene licencia» la tratan como «sin licencia pagada».

## Límites anti‑abuso

**Aceptados por el dueño el 2026-09-29.**

| Límite | Valor | Dónde | Cómo se detecta |
|---|---|---|---|
| Organizaciones por cuenta | 1 | `bvsala.medir_altas` (PK `user_id`) | `/api/license/measure` → 409 `one_org_per_account` |
| Cuenta verificada | obligatoria | `user.email_confirmed_at` | 403 `email_not_verified` |
| Correo desechable | rechazado | lista incrustada (abajo) | 403 `disposable_email` |
| Medir por organización | 1 viva | índice `licenses_una_medir_viva_por_org` | la segunda petición devuelve la misma |
| Asientos | **5** por mes natural | ingesta (`seat_activity` del mes) | 402 `measure-seat-limit`; en lote mixto solo cae el asiento nuevo (`rejectedOverSeatLimit`). Cuenta CI y `unknown` |
| Volumen | **20 000** peticiones/día (UTC) | ingesta (`usage_daily.requests` de hoy) | 429 `measure-volume-limit`; recorte parcial al hueco |
| Bloqueo del operador | — | `medir_altas.bloqueada` | 403 `measure_blocked`; nunca se reactiva desde el alta |

**Por qué 5 asientos.** Un asiento es una máquina o identidad de servicio. Medir
sirve para que un equipo piloto (un responsable y unos pocos desarrolladores o
servicios) vea una cifra representativa antes de pagar; cinco lo cubren y quedan
por debajo de cualquier despliegue de producción de más de un equipo. Pasado el
tope la capa sigue funcionando —en sombra no hay nada que quitarle—: lo que se
pierde es la medición de ese asiento, que es justo el incentivo a pasar a pago.

**Por qué 20 000/día.** ~600 000 peticiones al mes caben en un piloto y acotan el
coste de servir un panel gratis a quien lo use como observabilidad de producción.

Los topes fallan **abiertos** ante un error de lectura: son anti‑abuso, no un
candado de cobro (Medir no cobra nada).

**Detección de granjas de cuentas** (varias cuentas verificadas, una org cada
una). El alta guarda el **dominio** del correo, no la dirección:

```sql
select email_dominio, count(*) as altas
from bvsala.medir_altas
where email_dominio not in ('gmail.com','outlook.com','hotmail.com','yahoo.com','icloud.com','proton.me')
group by 1 having count(*) > 1 order by 2 desc;
```

Cortar una org: `update bvsala.medir_altas set bloqueada = true, bloqueo_nota = '…' where org_id = '…';`
y revocar su licencia por la ruta de siempre (`/api/license/revoke`), que la lleva
al ledger que el SDK y la pasarela consultan. Para una org que volvió a Medir al
dejar de pagar (sin fila de alta), insertar la fila con `bloqueada = true` y el
`user_id` de su dueño.

**Correos desechables.** El alta rechaza con 403 `disposable_email` (texto en los
12 idiomas: `dashboard.measurePlan.errDisposableEmail`) el correo cuyo dominio
—o cualquier dominio padre: `x.mailinator.com` es `mailinator.com`— está en la
lista pública
[disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains)
(CC0), **incrustada** en `apps/web/lib/license/dominios-desechables.ts` desde el
commit `51fafcd8` del 2026-09-29 (9 189 dominios). Nunca se descarga en runtime;
la cabecera del fichero dice cómo regenerarla y `desechables.test.ts` fija
fuente, fecha y recuento.

## Al cancelar o dejar de pagar: vuelta a Medir

La org que deja de pagar **no se queda sin capa**: sigue viendo lo que habría
ahorrado (`lib/license/medir.ts#volverAMedir`).

| Vía | Qué se corta | Luego |
|---|---|---|
| Cancelación (`customer.subscription.deleted`) | `revokeAllLicenses(…, { conservarMedir: true })`: **todas las de pago**; una Medir viva se conserva | `volverAMedir` |
| Impago (`/api/cron/dunning`, tras la gracia y sin licencia de pago viva) | el plan pasa a `free` (la de pago ya caducó sola) | `volverAMedir` |

`volverAMedir` emite una Medir salvo que la org ya tenga una **viva** o que el
operador la haya **bloqueado** (`medir_altas.bloqueada`). No escribe
`medir_altas` (no la reclama ninguna cuenta). Se llama **después** del corte: la
Medir nueva es la licencia más nueva y la que entrega `/api/license/current`. Un
fallo al emitirla **no** deshace el corte ni pide reintento a Stripe: alerta
(`aviso`) y la org puede reclamarla desde el panel. `invoice.payment_failed` no
la dispara: el impago tiene gracia.

En la máquina del cliente: el refresco del SDK (`LicenseRefresher`) mira **en
cuanto el ledger revoca el token vigente** —sin esperar a «cerca de caducar»— y
adopta la Medir; la pasarela ya lo hacía (`LicenseRenewer` busca cuando el
vigente deja de conceder). Con el impago, la de pago caduca y ambos recogen la
Medir en su ventana de renovación.

## Por qué el token va «caducado»

Porque las versiones publicadas no saben qué es `measure`: verificarían la firma,
no encontrarían features y encenderían todo lo que no va por feature. Con la
vigencia en campos propios que solo leen los verificadores nuevos
(`src/license/verify.ts#vigenciaEfectiva`, `gateway/license.ts`,
`@bivelio/protocol#effectiveTerm`), una versión vieja falla cerrada. Fijado en
`test/licencia-medir.test.ts` («un verificador ANTERIOR…»). La fila de
`licenses` guarda la vigencia real: el servidor no se engaña.

Los dos refrescos de licencia (SDK `LicenseRefresher`, pasarela `LicenseRenewer`)
miran **en cada vuelta** mientras la licencia vigente sea Medir —nunca llegaría a
estar «cerca de caducar»— y adoptan la de pago aunque caduque antes (mensual
frente a diez años): es el paso a pago sin reiniciar.

## Alta sin tarjeta

Panel → Instalación → «Get my free Measure license» → `POST /api/license/measure`:
sesión + correo verificado → rol `descargar_licencia` → organización (la del
usuario; se crea si no tiene) → fila en `medir_altas` → licencia firmada y
persistida (`lib/license/medir.ts#emitirLicenciaMedir`, fail‑closed) → token.
No aparece para una org `de-pago`. En la vista general, una org `solo-medir` ve
la tarjeta «What you would have saved» con el CTA a `/dashboard/account`.

El servicio de control plane (`services/licensing`) expone lo mismo para el
operador: `POST /licenses/issue-measure { orgId }` (token de admin), y `issue()`
normaliza cualquier `plan: "measure"` (sin features, asientos ≤ 5, vigencia larga).

## Pasos de producción (runbook)

1. **Migraciones 0029 → 0033** en producción, en orden ascendente estricto,
   siguiendo [RUNBOOK-MIGRACIONES-PROD.md](./RUNBOOK-MIGRACIONES-PROD.md) (anexo
   0033). `db/migrations/0033_licencia_medir.sql` **exige 0032** (el ahorro
   nativo, #412) y aborta sin ella, como 0032 exige 0031. No redefine
   `ingest_usage_batch`: no puede regresar la RPC de 0032.
   Diagnóstico: `to_regclass('bvsala.medir_altas') is not null`.
   **Antes** del código web: sin el CHECK nuevo, el alta falla con 23514
   (fail‑closed, no emite nada), y la vuelta a Medir al cancelar solo alerta.
2. **Desplegar la web** (ingesta con topes y neutralización, `/api/license/measure`,
   panel). Hasta este punto ningún SDK publicado ve cambios: sin licencias Medir
   emitidas no hay nada que hacer en sombra.
3. **Publicar el paquete** (SDK + pasarela con el modo sombra). El token Medir se
   firma con `expires_at = issued_at` y `grace_days = 0` y su vigencia real en
   `measure_expires_at` / `measure_grace_days`: un SDK o una pasarela **anteriores**
   (≤ 0.4.32) lo ven **caducado** y fallan cerrados —no pueden encender las
   palancas no gateadas (caché exacta, resolvers, singleflight…) con una licencia
   gratuita fijando una versión vieja—. El coste es un mensaje equívoco en esas
   versiones («license is not active (expired)»), así que conviene publicar el
   paquete **antes** de anunciar Medir y que el panel diga qué versión mínima hace falta (la que publique este PR).
4. **Página de precios**: la lleva otra rama (`feat/plan-asientos-equipo`). La
   clave `dashboard.measurePlan.pricingNote` está en los 12 idiomas para su
   tarjeta, y `landing.pricing.body` («No free tier, no trial») hay que cambiarlo
   allí.
5. **LICENSE** (texto aprobado por el dueño): §1 nombra la Measure license entre
   las suscripciones sin cargo y dice qué hace (modo sombra, ninguna
   optimización, ahorro estimado nunca facturado); §2 dice que al acabar una
   suscripción de pago BiVelio puede dar una Measure license, con la que la capa
   sigue solo en sombra. La §6 (precios) no se toca: la cambia #411.
