# Plan — de «una cuenta es una persona» a «una cuenta es una organización»

**2026-08-12.** Cubre los tres huecos que quedaron abiertos tras cerrar el plan de
lanzamiento: la organización que en realidad es un usuario, el panel que afirma
«no hay tráfico» cuando lo que hay es una lectura vacía, y el poller del SDK que
se apaga sin decir nada.

Sale de una investigación de **20 agentes**: 7 diseños en paralelo sobre el código
real, cada uno roto después por un adversario que abrió los ficheros citados, más
4 sobre el producto hermano y una síntesis. Todo lo que aquí lleva `fichero:línea`
está comprobado.

---

## La premisa que decide todo lo demás

**`org_id == user_id` no está en el esquema.** `bvsala.organizations.id` es un
`uuid primary key default gen_random_uuid()` **sin clave ajena contra
`auth.users`** (`db/migrations/0001_init.sql:32-39`). Es una convención de la
aplicación, no una restricción de la base.

De ahí se siguen tres cosas que cambian el coste y el riesgo de todo el trabajo:

1. **No hay que renumerar ninguna organización. Nunca.** Las filas vivas son
   válidas tal cual: un org id que casualmente coincide con un user id sigue
   siendo un org id legítimo.
2. **No hay que reescribir nada inmutable**: ni los `metadata.org_id` ya escritos
   en las suscripciones de Stripe, ni los `org_id` que van **firmados dentro de
   las licencias** ya desplegadas.
3. **Mientras `org_id == user_id`, cada cambio de lectura es un no-op sobre las
   dos organizaciones vivas.** Se puede migrar el código entero, desplegarlo, y no
   cambia absolutamente nada en producción.

El primer `org_id` distinto de un user id nace en la **Fase 6**, y ni un minuto
antes. Todo lo que quede sin migrar en ese instante pasa a ser un fallo
**silencioso**: un `.eq()` con un id inexistente devuelve cero filas — no lanza,
no alerta, no se ve en el panel.

> ⛔ **Prohibición explícita, para quien llegue después:** no actualizar jamás un
> `organizations.id`. `src/license/refresher.ts:155` descarta en silencio
> cualquier token renovado cuyo `org_id` no case con el vigente, y los tokens
> están firmados y ya desplegados en las máquinas del cliente que paga: cambiar un
> id le apagaría la flota fail-closed al agotar la gracia, semanas después. Ni
> siquiera pasaría de la base: las 8 claves ajenas contra `organizations(id)` están
> declaradas sin `on update cascade`, y tres llevan `org_id` **dentro de la clave
> primaria** (`usage_daily`, `seat_activity`, `usage_ingest_seen`), que es la base
> de la facturación.

---

## Lo que ya resolvió el producto hermano (y lo que no)

`bivelio-privacy-gateway` comparte el proyecto de Supabase y llegó antes a este
problema. Estudiado en solo lectura:

| | `bvprga` (hermano) | `bvsala` (nosotros) |
|---|---|---|
| Identidad de la org | uuid propio | uuid propio ✅ **igual** |
| **Propiedad** | `owner_id → auth.users on delete set null` | ❌ no existe |
| **Roles en la RLS** | `is_member` **e** `is_admin` | ❌ solo `is_org_member` |
| **Una suscripción por org** | `org_id` es **primary key** | ❌ solo un índice |
| Invitaciones | ❌ **tampoco existen** | ❌ |
| Escritura de miembros | ❌ sin políticas: solo `service_role` | ❌ |

Dos lecciones que valen más que el código:

**Nadie en BiVelio ha construido todavía el ciclo de vida multiusuario.** El
hermano resolvió la *identidad* y paró ahí. Sus roles están tan muertos como los
nuestros: `bvprga.is_admin()` está definida y **no la usa ninguna política ni
ninguna línea de código**.

**Un trigger sobre `auth.users` es una trampa.** El hermano lo tuvo y lo borró a
propósito (commit `6e12b93`, *«cross-product hazard»*): en un proyecto compartido,
un trigger de alta dispara con **cada registro de toda la suite**. Su sustituto es
aprovisionar en diferido desde la aplicación con `service_role` — que es lo que
nosotros ya hacemos. **Ningún diseño que cree la organización con un trigger de
base de datos es válido aquí**, por tentador que parezca.

El patrón que sí conviene copiar es `apps/web/lib/billing/org.ts` del hermano:
resolver la organización por `memberships` **filtrando por rol**, y devolver
`null` ante cualquier fallo para que quien llama falle cerrado.

---

# Punto 1 · La organización

**21 puntos de llamada en 7 ficheros** asumen `org_id == user_id`. Cada fase es
una PR y un despliegue independientes.

## Fase 0 · Pre-vuelo, solo lectura sobre producción · 1 h

Cuatro consultas por la Management API. Las cuatro tienen que dar **0 filas** (la
segunda, 2 filas `owner`):

```sql
select org_id, count(*) from bvsala.org_members where role='owner' group by 1 having count(*)>1;
select role, count(*) from bvsala.org_members group by 1;
select o.id from bvsala.organizations o
  left join bvsala.org_members m on m.org_id = o.id where m.org_id is null;
select user_id, count(*) from bvsala.org_members group by 1 having count(*)>1;
```

La tercera es **bloqueante dura**: una organización sin ninguna membresía haría
que el resolvedor acuñe una org nueva mientras la vieja conserva suscripción,
licencias y `stripe_customer_id` — y como esa columna es `unique`, el update de
`webhook/route.ts:92-95` chocaría. Ese error **hoy se ignora**, así que el portal
dejaría de abrir sin un solo registro.

## Fase 1 · El resolvedor, sin un solo llamador · 0,5 día

`apps/web/lib/org/resolver.ts`, código muerto: desplegable sin efecto.

- `resolverOrgSiExiste(admin, userId)` — solo lee, con **desempate explícito**.
  Hoy `data.ts:98` y `license/current:157` usan `.limit(1)` **sin `order`**, así
  que Postgres devuelve una fila arbitraria y la organización que ves puede
  cambiar entre peticiones. Orden: (1) la que tenga suscripción viva; (2)
  `org_id == userId`; (3) `created_at asc`. Devuelve también el `role`.
- `resolverOrgDelUsuario(admin, userId, email)` — resuelve o crea. **Nunca**
  `id: userId`. Falla **cerrada**: si no puede resolver ni crear, lanza. Jamás cae
  a `user.id`, que es el defecto que se está cerrando.

## Fase 2 · Migración 0013, en caliente, sin desplegar código · 0,5 día

100 % aditiva. Cuatro decisiones técnicas que no son obvias:

1. `organizations.owner_user_id uuid references auth.users(id) on delete set null`
   + backfill desde `org_members` donde `role='owner'`, y `raise exception` si
   queda algún null. **Abortar es el resultado bueno**: una org sin dueño es peor.
2. **No un índice único parcial** para «un solo owner», sino
   `exclude using btree (org_id with =) where (role='owner') deferrable initially deferred`.
   Un índice único parcial se comprueba por fila y **no admite `deferrable`**:
   haría *imposible* la transferencia atómica, que es justo el objetivo. `using
   btree` evita instalar `btree_gist` en una base compartida.
3. `org_invitations` con `email **text**` y `unique index on (org_id, lower(email))`.
   **No `citext`**: no está instalada, y `create extension citext` sin `with
   schema` la instala en `public` — el esquema de otra aplicación con más de 100
   tablas. Todo el aislamiento de `0001` existe para no tocar `public`.
4. **No una función `rol_en_org()` `security definer`.** Resolvería por
   `auth.uid()`, y todas las decisiones de autorización de este producto se toman
   con `service_role`, donde `auth.uid()` es **NULL siempre**: devolvería NULL en
   el 100 % de los casos. El chequeo de rol va en TypeScript.

Y **no se toca `is_org_member`**: la usan las políticas RLS de 6 tablas.

Después, obligatorio: `notify pgrst, 'reload schema'` y verificar por la API que
la columna es visible **antes** de desplegar la Fase 3.

## Fase 3 · El webhook aprende que el dueño no es la organización · 0,5-1 día

`ensureOrg` escribe hoy `org_members {user_id: orgId}` (`webhook/route.ts:117-122`).
Con un org id aleatorio, la clave ajena contra `auth.users` **revienta**, el
`throw` devuelve 503, Stripe reintenta 72 h y se rinde: **el cliente paga y no
recibe licencia nunca.**

Pasa a recibir el user id por separado, con respaldo `session.metadata?.user_id ??
session.client_reference_id` para las sesiones ya abiertas por el código viejo.
Y se **comprueban los errores que hoy se tragan** en `:92-95` y `:97-104`.

⚠️ Hay que **editar un test existente**, no solo añadir uno:
`apps/web/app/api/billing.test.ts:430` afirma literalmente `{ org_id: orgId,
user_id: orgId, role: "owner" }`.

## Fase 4 · Todos los caminos de lectura, en un solo despliegue · 1,5-2 días

`load.ts:48-52` es el embudo: pasa `user.id` tres veces. Se resuelve la org **una
vez** y se pasa a las tres.

Lo que más importa de esta fase, y no es el panel vacío:

- **`license/current:156` y `license/trial:36` tienen un `new Set([user.id])`**
  que es una **puerta trasera permanente**: el usuario fundador podría descargar
  el token completo de su organización para siempre, aunque se le quite de
  `org_members` o se transfiera la propiedad — justo el escenario que este trabajo
  existe para habilitar.
- **`data.ts:94-100` puede devolver un panel MEZCLADO**, no solo vacío: con dos
  membresías puede resolver la org B mientras licencia y asientos vienen de la A.
- **`asientos-usados.ts` salta la RLS con `service_role`.** Con RLS de por medio,
  un orgId equivocado da un panel vacío; **por ahí, da los asientos de otro
  cliente.** Su cabecera justifica el salto diciendo que el orgId sale de
  `auth.getUser()`; deja de ser cierto y **reescribir ese comentario es parte del
  trabajo**, no cosmética.

## Fase 5 · Los caminos que ACUÑAN organizaciones · 0,5 día

**El fallo realmente letal, y no está en el webhook.**
`service-accounts/route.ts:41` hace `upsert({id: user.id}, {ignoreDuplicates:true})`:
con un id de org aleatorio **no hay conflicto**, así que crea una **segunda
organización vacía**, y la `bvk_` queda atada a ella. La cadena completa:

> el ingest muere con 402 → `/api/license/current` por vía `bvk_` da 404 → el
> refresher no renueva → **la flota se apaga fail-closed semanas después** → y la
> guardia anti-doble-cobro no ve la suscripción real → **segundo cobro**.

Es la regresión que cerró `6d1e4aa`, reabierta por otra puerta. **Esta fase no
puede ir después de la 6**: si un cliente nuevo pulsa «crear clave» en esa
ventana, su flota muere sin un solo error visible.

## Fase 6 · El checkout acuña la organización · **punto de no retorno** · 0,5 día

La organización se crea **aquí**, antes de `checkout.sessions.create`:
`customer.subscription.created` puede llegar antes que `checkout.session.completed`,
y `upsertSub` inserta con clave ajena contra `organizations(id)`.

Puerta de despliegue: verificar **en Vercel, no en git**, que las Fases 3, 4 y 5
están vivas. A partir de aquí existen ids de org que no son ids de usuario y **el
rollback de código deja de ser seguro**.

---

# ═══ LÍNEA DE CORTE ═══

Hasta aquí: **la cuenta es una organización**. Cero cambios visibles, cero
funcionalidad nueva, y una lista de defectos latentes cerrados. Es el suelo
obligatorio: sin esto, todo lo de abajo es un fallo silencioso sobre alguien que
paga.

De aquí abajo: **la organización tiene personas**. Es lo que pregunta un
departamento de compras.

---

## Fase 7 · Los roles dejan de ser decorativos · 1 día · **imprescindible para vender**

`apps/web/lib/org/permisos.ts`: tabla pura rol → acciones, comprobada en
TypeScript. Se aplica donde hoy no se mira nada: `/api/license/current` (que
entrega el **token firmado completo** a cualquier miembro), `/api/service-accounts`
(la otra puerta a la misma credencial), `checkout` y `portal`.

Hoy el único miembro de cada org es el dueño, así que es un no-op sobre datos
vivos. Pero es lo que hace segura la Fase 8, y es la respuesta escrita a
*«¿pueden restringir quién descarga credenciales?»*.

## Fase 8 · Invitaciones, miembros y transferencia · 1,5-2 semanas · **no es de esta semana**

- Aceptar: **el email de la invitación tiene que coincidir con el del usuario
  autenticado**, o cualquiera con el enlace entra.
- Transferir: migración 0014 con una función plpgsql que degrade y promueva **en
  una transacción**. Dos peticiones dejan una ventana con la org sin dueño. La
  restricción diferible de 0013 es lo que lo hace posible.
- Entrega v1: **el enlace se copia a mano.** Defendible con 2 clientes. El único
  correo del producto es el avisador **interno**; correo transaccional a terceros
  es otro producto (dominio, entregabilidad, plantillas en 12 idiomas, baja).
- **El coste real no son las rutas: es la interfaz en 12 idiomas.**

## Fase 9 · Pertenencia a varias organizaciones + selector · no este mes

---

# Punto 2 · El panel que afirma lo que no sabe

`getUsageRollups` distingue error de vacío mirando `error` de PostgREST
(`data.ts:237-241`), y **una denegación por RLS no es un error**: filtra filas y
devuelve `[]` con `error: null`. Así que `failed` queda en `false` y `VerdictHero`
pinta *«0 solicitudes vistas, instala el SDK»*.

**El diseño elegido no cuesta ni una consulta nueva.** La lectura de `org_members`
ya se hace en cada carga (`data.ts:94-100`) y hoy se le **tiran el `error` y el
`org_id`**. Con eso el titular pasa de 4 estados a 5: medido / sin precio / sin
tráfico **probado** / **alcance desconocido** / error de consulta.

Hay que arreglar además cuatro sitios más con el mismo defecto, todos derivados de
`usage.length === 0`: `LiveLedgerTiles`, `TrafficModelMix`, `meteringState` y
`activationSteps` — este último apaga los pasos «First report» y «Live metering»
de la guía de activación.

> ⚠️ **Lo que el adversario encontró y hay que asumir por escrito.** El probador y
> lo probado se evalúan con la **misma función**: `mem_read` y `usage_read`
> dependen las dos de `is_org_member`. Si la pertenencia no consta —fila perdida,
> política reescrita, `auth.uid()` sin sujeto— **las dos se apagan a la vez** y el
> panel vuelve a mentir. Este diseño detecta la denegación *específica* de
> `usage_daily`; no detecta el fallo del `is_org_member` compartido. Cubre el caso
> que ocurre en la práctica (el `org_id` equivocado), no el caso general.

**Esfuerzo: 1 día**, más los 12 idiomas (`parity.test.ts` lo hace todo o nada).

---

# Punto 3 · El poller mudo

`create.ts:125-136` no le pasa `onEvent` al poller, que **ya emite cinco eventos**
(`poller.ts:26-31`). Con la salida de red cerrada, el cliente no ve **ni una
línea** durante 6 h y su primer síntoma es que `generate()` empieza a lanzar.

El diseño no es registrar cada poll fallido —inservible en un servidor de vida
larga— sino una **escalera** anclada a la misma magnitud que usa la verja: lo que
se cura solo (5xx, red) calla hasta el 50 % del presupuesto de frescura y ahí
avisa **una vez**, diciendo **a qué hora exacta se cerrará la puerta**; lo que no
se cura solo (4xx, y sobre todo `rejected`) avisa al primer intento, como ya hace
`refresher.ts:139-147`.

Se expone `onLicenseHealth`, **no** el `onEvent` crudo: ese es mecanismo interno y
charla cada 15 minutos. Cambio aditivo de API pública → **0.3.0**.

> 🔴 **Hace falta un paso 0 que el diseño no tenía.** El peldaño `rejected` —el que
> su propio autor llama «el silencio más caro del fichero»— descansa en una
> afirmación causal que el código refuta: `poller.ts:176-177` **guarda el ETag
> antes de verificar**. En el estado actual de producción, con `seq` clavado en 0 y
> el cliente en régimen de 304 el 91 % del tiempo, ese aviso **se dispararía cada
> 11 polls**, diciéndole al único cliente que paga que su servicio se apaga a una
> hora que nunca llega. Un aviso que miente en su primer uso **quema el canal
> entero**. Hay que arreglar el orden ETag/verificación *antes* de cablear nada.

**Esfuerzo: 1 día**, más el paso 0.

---

# Esfuerzo, sin optimismo

| | |
|---|---|
| Fases 0-6 (la cuenta es una organización) | **5-7 días laborables** |
| Fase 7 (roles aplicados) | 1 día |
| Fase 8 (invitaciones + interfaz en 12 idiomas) | 1,5-2 semanas |
| Punto 2 (el panel) | 1 día |
| Punto 3 (el poller) | 1 día + paso 0 |

Los diseños etiquetaban casi cada paso como «horas». Es falso. La Fase 4 sola son
días: la función es trivial, los 21 puntos de llamada y los tests que codifican la
convención no lo son.

# Dónde parar

| | |
|---|---|
| **Mínimo honesto para lanzar** | Fases 0-6 + puntos 2 y 3. Nada nuevo que enseñar; es lo único que impide que el próximo cliente rompa en silencio |
| **Mínimo para un departamento de compras** | + Fase 7 |
| **Lo que compras espera de verdad** | + Fase 8. No cabe esta semana |

Para el hueco entre 7 y 8 hay una respuesta que no es código y que con 2 clientes
es defendible en un cuestionario de compras: **procedimiento manual documentado** —
invitación y transferencia se solicitan a `support@bivelio.com` y las ejecuta el
equipo.

# Decisiones que no puede tomar un ingeniero

1. **¿Una persona pertenece a una organización o a varias?** Todo el producto
   asume una. Permitir varias obliga a selector y «org actual» en sesión, en 12
   idiomas. Fija el desempate del resolvedor y el alcance de las Fases 8-9.
2. **¿Un asiento de 4 € es una MÁQUINA o una PERSONA?** Hoy la facturación cuenta
   máquinas y el precio se anuncia por asiento. Invitar a 10 compañeros **no**
   cambia la factura; arrancar 10 máquinas sí. **Las invitaciones hacen ese
   desajuste visible el primer día.** Es precio, no ingeniería.
3. **¿Puede un `member` descargar el token de licencia y acuñar claves `bvk_`?**
   Son la misma credencial por dos puertas.
4. **¿Cómo se entrega la invitación?** Enlace a mano / correo transaccional propio
   / `inviteUserByEmail` de Supabase — esta última **escribe en el auth compartido
   y crea identidades que ven los demás productos de BiVelio**. Es una decisión de
   plataforma que afecta a proyectos que no son este.
5. **¿Qué pasa con una organización cuyo dueño se va o borra su cuenta?** Hoy no
   hay ninguna respuesta y la suscripción sigue cobrando. Y `auth.users` es
   compartido: un borrado desde otro producto de BiVelio deja una organización
   viva, cobrando y sin dueño.
6. **¿Se renombran las 2 organizaciones vivas?** Hoy se llaman con el correo de
   facturación o «My workspace»; en cuanto haya invitados, ese nombre lo ven todos.
7. **¿La propiedad puede transferirse a otro dominio de correo?** Quien la reciba
   controla la facturación.
8. **¿Dónde se para esta semana**, y si se para antes de la Fase 8, ¿es aceptable
   el procedimiento manual por `support@bivelio.com`?

# El punto más frágil de todo el cambio

**La atadura clave de servicio → organización.** Es la única identidad que llevan
las máquinas ya desplegadas del cliente que paga, y decide dos cosas a la vez: si
se acepta el ingest (`metering/usage/route.ts:33-42`) y si se entrega la licencia
renovada (`license/current/route.ts:106-131`). Cualquier error de resolución ahí
**no lanza, no alerta y no se ve en el panel**: se manifiesta como un SDK que se
para fail-closed semanas después. Es el único camino del producto sin un humano
mirando y sin RLS debajo que lo atrape, porque todas esas rutas corren con
`service_role`.

Por eso la **Fase 5 va antes que la 6**, y no al revés.
