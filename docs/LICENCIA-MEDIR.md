# La licencia «Medir» (plan `measure`)

> Decisión del dueño (2026-09-29), sobre la recomendación de
> [COMPETENCIA-2026-09-26.md](./COMPETENCIA-2026-09-26.md) §8 n.º 2 y 5:
> licencia **gratuita, permanente y sin tarjeta**. Revierte **en parte** #314.

## Qué es

Una licencia firmada más —Ed25519, verificada **offline** como las de pago— con
`plan: "measure"` y **sin features**. Con ella:

| Superficie | Qué hace | Qué NO hace |
|---|---|---|
| SDK (`createSavingsLayer`) | La petición sale por la **llamada directa** (la del fail‑open): `{model, messages, tools, schema, maxOutputTokens, temperature, seed, reasoningEffort}` tal cual. Mide el gasto con el contador del proveedor y publica `report.measure` | Ninguna etapa del optimizador mira la petición: ni resolvers, ni caché exacta o semántica, ni singleflight, ni compresión, elisión, cascada, codebook, marcas de caché de prefijo, tier diferido o lotes (`batches.submit` → `LicenseError` status `measure`). La verificación A/B no lanza copias |
| Pasarela (`bvsala`) | Proxy byte a byte; mide el uso; registra como `shadow` lo que el **modelo hermano** habría ahorrado sobre ese mismo usage | Ni diales, ni hermano, ni esfuerzo, ni TTL, ni coalescencia, ni inyección de `stream_options`, ni el carril de investigación de la elisión |
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

| Límite | Valor | Dónde | Cómo se detecta |
|---|---|---|---|
| Organizaciones por cuenta | 1 | `bvsala.medir_altas` (PK `user_id`) | `/api/license/measure` → 409 `one_org_per_account` |
| Cuenta verificada | obligatoria | `user.email_confirmed_at` | 403 `email_not_verified` |
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
al ledger que el SDK y la pasarela consultan.

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

1. **Migración 0032** (`db/migrations/0032_licencia_medir.sql`) en producción,
   siguiendo [RUNBOOK-MIGRACIONES-PROD.md](./RUNBOOK-MIGRACIONES-PROD.md).
   Diagnóstico: `to_regclass('bvsala.medir_altas') is not null`.
   **Antes** del código web: sin el CHECK nuevo, el alta falla con 23514
   (fail‑closed, no emite nada).
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
5. **LICENSE**: §1 ya admite una suscripción «granted by BiVelio at no charge»;
   revisión legal de si Medir necesita mención explícita (asientos, sin palancas).
