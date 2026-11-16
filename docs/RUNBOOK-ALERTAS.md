# Manual de alertas — qué hacer cuando llega un correo de BV-SALA

Solo llega correo de lo **crítico**, y crítico significa una de dos cosas: *alguien
está pagando y no tiene producto*, o *estamos perdiendo datos de facturación*.
Las cinco primeras son las que más veces han saltado y llevan procedimiento
largo; el resto (§ 6, añadido el 2026-09-13) van por familias, porque comparten
causa y arreglo. Cada una dice qué mirar primero, cómo arreglarlo y en cuánto
tiempo hay que hacerlo.

**Lo primero, siempre, en las tres primeras:** casi todas se reparan
**reenviando el evento en Stripe**. Los handlers son idempotentes —comprueban
antes de emitir— así que reenviar es seguro: no duplica licencias ni cobra dos
veces.

> ⚠️ **PERO REENVIAR NO BASTA SI EL EVENTO YA SE PROCESÓ UNA VEZ**, y esto no es
> evidente: la guardia de idempotencia del webhook (busca «Idempotency
> (at-least-once)» en `apps/web/app/api/stripe/webhook/route.ts`) corta ANTES del manejador cuando el evento
> ya está en `bvsala.stripe_events`, y responde `{duplicate:true}` con un 200. Si
> reenvías sin más, verás un 200 y el problema seguirá ahí — con la falsa
> sensación de haberlo arreglado. (Esta corrección sale de un incidente real: el
> manual decía lo contrario.)
>
> El procedimiento correcto es **borrar primero la marca** y después reenviar:
>
> ```sql
> delete from bvsala.stripe_events where id = 'evt_…';
> ```
>
> Y luego: Stripe → **Developers → Events** → el evento por su id (viene en el
> correo) → **Resend**.
>
> Un evento que NUNCA llegó a procesarse (503, o descartado por la verja de
> producto) no está registrado, así que ahí reenviar a secas sí funciona.

---

## 1 · «N organización(es) PAGANDO sin licencia viva»

**Qué significa.** El invariante del negocio ha fallado: hay una suscripción
cobrando y esa organización no tiene ninguna licencia válida. Es el peor estado
posible del producto: el cliente paga y el SDK le rechaza.

**Cuánto tiempo tienes.** Horas, no días. Si es un cliente nuevo, ahora mismo
está intentando instalar algo que no funciona.

**Qué mirar.** El correo trae, por cada org, el campo `caso`:

- **«nunca se le emitió ninguna»** → falló el camino de alta. Busca en Stripe los
  eventos de esa suscripción (`checkout.session.completed`,
  `customer.subscription.created`) y reenvíalos.
- **«tuvo licencias y las perdió»** → o se revocó cuando no tocaba, o una
  renovación no se entregó. Mira `bvsala.billing_audit` de esa org, en orden: un
  `sub_deleted` te dice que se canceló (¿de verdad?), y su ausencia apunta a una
  renovación que no re-emitió.

**Si el reenvío no arregla nada**, la suscripción probablemente no tiene
`metadata.org_id` — ve a la alerta 2, que es la misma causa.

---

## 2 · «Renovación cobrada SIN org_id: la licencia NO se ha re-emitido»

**Qué significa.** Llegó el cobro del ciclo nuevo, pero la suscripción no lleva
`metadata.org_id`, así que no se sabe a quién pertenece. La licencia conserva la
caducidad del ciclo **anterior**.

**Por qué es grave y silencioso a la vez.** El cliente no nota nada hoy: su token
sigue valiendo hasta `expires_at + 21 días` de gracia. Se le para **semanas
después**, ya pagado, y para entonces nadie relaciona una cosa con la otra.

**Qué hacer:**

1. Stripe → **Subscriptions** → la del correo (`subId`) → **Edit metadata**.
2. Añade `org_id` con el uuid de la organización. Si no lo sabes, sácalo del
   `stripe_customer_id`: `select id from bvsala.organizations where
   stripe_customer_id = 'cus_…'`.
3. **Reenvía el `invoice.paid`** del correo. Eso re-emite la licencia con el
   periodo bueno.
4. Comprueba: debe aparecer una licencia nueva con `expires_at` en el ciclo
   actual, y la anterior marcada `superseded_at` **sin** `revoked`.

---

## 3 · «Cambio de suscripción SIN org_id: ni asientos ni periodo se han aplicado»

**Misma causa que la 2**, distinto momento: el cliente cambió de asientos o de
plan y no se le aplicó. **Ya está pagando la cantidad nueva** y su licencia sigue
diciendo la vieja.

**Ojo:** se respondió `200`, así que **Stripe no lo va a reintentar solo**. Si no
lo tocas, el desajuste es permanente.

Mismo procedimiento: añade el `org_id` a la suscripción y reenvía el
`customer.subscription.updated`.

---

## 3 bis · «Evento de Stripe que no se ha podido atribuir: se procesa igual»

**Qué significa.** Llegó un evento y no se pudo decidir de qué producto es.
BV-SALA y BV-PRGA **comparten cuenta de Stripe**, así que este endpoint recibe
también los eventos del otro producto; los suyos se descartan en silencio con un
200, pero éste no se ha podido clasificar.

**No es urgente, pero no se ignora**: se ha procesado igual —a propósito, porque
descartar un cobro real es peor— y puede ser un evento NUESTRO con algo roto.

**Qué mirar**, por orden de probabilidad:

1. **El catálogo del entorno.** La verja necesita `STRIPE_PRICE_ID_MONTHLY` y
   `STRIPE_PRICE_ID_YEARLY` en Vercel; con uno solo no descarta nada y avisa de
   todo. Compruébalos.
2. **Un precio nuestro que el despliegue no conoce** (cortesía, socio, un nivel
   nuevo). Se añade a `STRIPE_PRICE_IDS_EXTRA`, separado por comas.
3. **Un fallo de red al resolver la suscripción en Stripe.** Ante la duda se
   procesa; si es esporádico, no hay nada que hacer.

## 4 · «Webhook de Stripe con firma inválida»

**Un correo suelto: ignóralo.** Internet escanea endpoints todo el día y una
petición sin firma válida es eso.

**Varios seguidos, o un goteo constante: es una emergencia.** Significa que
`STRIPE_WEBHOOK_SECRET` no es el del endpoint —lo habitual es que se haya rotado
en Stripe y no se haya redesplegado— y entonces **la tubería entera está muerta**:
ningún checkout mina licencia, ninguna renovación re-emite, ninguna cancelación
revoca. Todos los clientes a la vez.

**Cuánto tiempo tienes: unos 3 días.** Stripe reintenta durante ese plazo, así que
lo que se acumula se recupera al arreglarlo. Pasado ese plazo **deshabilita el
endpoint** y los eventos se pierden para siempre.

**Qué hacer:**

1. Stripe → **Developers → Webhooks** → el endpoint de `savings.bivelio.com` →
   **Signing secret** → *Reveal*.
2. Compáralo con `STRIPE_WEBHOOK_SECRET` en Vercel (Production).
3. Si difieren: actualiza el de Vercel y **redespliega** (las variables se fijan al
   desplegar; cambiarla sin redesplegar no hace nada).
4. En el mismo panel, **Resend** los eventos fallidos que se hayan acumulado.

---

## 5 · «El ingest de uso está fallando: se pierden datos de facturación»

**Qué significa.** `ingest_usage_batch` está devolviendo error. De esa tabla salen
las cifras del panel y `billable_seats`, que decide los asientos cobrables.

**Qué se recupera y qué no.** El SDK reencola los `5xx`, así que parte del tráfico
vuelve solo — pero su búfer está acotado (1000 registros) y lo que se desborda no
se recupera. Cuanto antes, menos agujero.

**Qué mirar.** El campo `motivo` del correo trae el error de PostgreSQL:

- **Violación de un CHECK** (p. ej. `usage_daily_calls_add_up`) → un registro que
  el validador dejó pasar y la base rechaza. Es un fallo de código, no de
  operación: hay que mirar qué combinación lo produce.
- **Timeout o saturación** → mira el proyecto de Supabase.
- **`permission denied`** → alguien ha tocado los `grant`; la función es
  `security definer` y solo la puede ejecutar `service_role`.

---

## Y si la alerta no llega

Hay dos canales, a propósito, porque el fallo más traicionero es el del propio
avisador:

- **El correo** (este) sale de las funciones del servidor. Si el despliegue está
  caído entero, no sale.
- **El vigilante de GitHub** (`.github/workflows/vigilante.yml`) mira desde fuera
  cada 6 horas y falla —y GitHub te manda correo— si la landing no responde, si
  los candados se han abierto o si **la huella del par de claves ha cambiado**.

Esa última es la que ningún sistema puede vigilarse a sí mismo: si la privada del
despliegue deja de ser pareja de la pública que el SDK lleva dentro, la emisión
sigue funcionando con toda normalidad y son los SDK de **todos** los clientes los
que rechazan las licencias a la vez. La huella buena es **`74ff7ba0d84b`**.

---

## 6 · Las demás alertas, por familia (añadido 2026-09-13)

El 13-09 se conectaron a `alertar` doce puntos del camino del dinero que hasta
entonces solo escribían en el log (#281), más las alertas de los crons de
comisión (#278) y de la purga (#285). Van por familias: dentro de cada una la
causa y el arreglo son los mismos.

### 6.1 · «cron … no ha corrido: CRON_SECRET sin definir»

(`dunning`, `invariantes`, `cierre-extractos`, `facturar-extractos`, `retencion`)

**Qué significa.** La variable no está en el despliegue; el cron responde 501 y
no hace nada. Todos los crons fallan cerrados igual.

**Qué hacer.** Vercel → Settings → Environment Variables → `CRON_SECRET` en
Production (comprobar por existencia) → **redesplegar**. Después, relanzar a
mano el cron que no corrió:

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" "https://savings.bivelio.com/api/cron/<nombre>[?periodo=YYYY-MM]"
```

Los dos de comisión aceptan `?periodo=` (por defecto, el mes anterior) y son
idempotentes; `?seco=1` en cualquiera de los tres con período enseña qué harían
sin hacerlo.

### 6.2 · «… no pudo leer subscriptions / licenses / usage_daily / los extractos / el candado de cargos»

**Qué significa.** El cron arrancó y la base de datos no respondió a una
lectura: el trabajo de esa pasada **no se ha hecho** (el invariante no se
comprobó, el barrido de impago no corrió, el cierre o la facturación no se
ejecutaron). No hay datos rotos: hay trabajo sin hacer.

**Qué hacer.** Mirar el proyecto de Supabase (estado, saturación); cuando
responda, relanzar el cron con el mismo Bearer (§ 6.1). Para los mensuales,
con `?periodo=` del mes que tocaba.

### 6.3 · Cierre mensual (día 1, 05:00)

- **«aplazado: el FX del BCE no está disponible — relanzar a mano»**: el
  cierre no sella nada sin el cambio del día. Vercel no reintenta un cron
  mensual: relanzar `cierre-extractos?periodo=YYYY-MM` cuando el BCE responda
  (normalmente en minutos), y después `facturar-extractos?periodo=YYYY-MM`,
  que a las 07:00 no habrá encontrado extractos.
- **«aplazado: no se pudo leer quién lleva comisión (marca de exención o
  suscripciones)»**: igual que 6.2; el cierre se niega a sellar sin saber quién
  está exento (facturaría a probadores) ni qué plan llevó cada organización
  (§7).
- **«El cierre mensual de extractos está fallando»**: la escritura en
  `bvsala.extractos` falló (el `motivo` trae el error de PostgreSQL). Un
  CHECK violado es un fallo de código; un timeout, de infraestructura. Relanzar
  cuando esté arreglado: el upsert ignora los ya sellados.

### 6.4 · Facturación de la comisión (día 1, 07:00)

- **«Cargo de comisión SIN cliente de Stripe: no se ha facturado»**: la
  organización tiene cargo y no tiene `stripe_customer_id`. Buscar en Stripe
  el cliente por el correo del dueño de la org, escribir su id en
  `bvsala.organizations.stripe_customer_id`, borrar la fila
  `omitido_sin_cliente` de `bvsala.cargos` (org, período) y relanzar
  `facturar-extractos?periodo=`.
- **«Factura de comisión SIN medio de pago: quedará abierta y el cobro automático fallará»**:
  la factura se emite igual. Stripe → Customers → el cliente → *Default
  payment method for invoices*; si la suscripción de asientos tampoco tiene,
  el cliente tiene que volver a pasar por el portal de facturación. Después,
  Stripe → Invoices → la factura → *Charge*.
- **«Factura de comisión emitida pero el cargo NO quedó registrado»**: la
  factura existe en Stripe (`invoiceId` en el correo) y la fila de
  `bvsala.cargos` no. Insertar la fila a mano con `estado='facturado'` y
  `stripe_invoice_id`; sin ella, una relanzada del cron **no** duplica (la
  clave de idempotencia de Stripe lo impide) pero el panel no enseña la
  factura.
- **«La facturación de la comisión está fallando»**: una org falló y el cron
  siguió con las demás. `motivo` trae el error de Stripe; arreglar y relanzar
  el período: las ya facturadas no se tocan.
- **«Cobro de la comisión FALLIDO»**: Stripe intentó cobrar la factura y no
  pudo. Stripe reintenta según *Smart Retries*; si el cliente no tiene medio
  de pago válido, escribirle con el enlace alojado de la factura (en
  `bvsala.cargos.detalle.hosted_invoice_url`).
- **«El estado del cargo de comisión no se pudo actualizar»** y **«Factura de
  comisión sin (org, período) en metadata»**: la primera es 6.2 aplicada al
  webhook (reenviar el evento cuando la base responda); la segunda significa
  que alguien creó una factura con nuestro `bvsala_tipo` a mano, sin
  metadata: revisarla en Stripe y, si es nuestra, añadir `bvsala_org_id` y
  `bvsala_periodo` y reenviar el evento.

### 6.5 · Webhook y checkout

- **«El webhook de Stripe falló al procesar <tipo>»**: el manejador lanzó;
  se respondió 503 y Stripe reintentará ~3 días. El correo trae `eventId`,
  `tipo` y `motivo`. Arreglar la causa (`motivo`) y, si Stripe ya se rindió,
  reenviar el evento (no está registrado como procesado, así que reenviar a
  secas vale).
- **«No se pudo crear la sesión de Checkout: un cliente no ha podido comprar»**:
  una venta perdida. `motivo` trae el error de Stripe: claves (`STRIPE_*` en
  Vercel), precio inexistente (`STRIPE_PRICE_ID_*`) o Stripe caído. El
  cliente vio «Could not start checkout.»: si se sabe quién es (`orgId`),
  avisarle cuando esté arreglado.
- **«checkout: Stripe tiene una suscripción viva que nuestra tabla no conoce»**:
  la guardia anti-doble-cobro encontró en Stripe una suscripción activa de
  ese cliente que `bvsala.subscriptions` no tiene. Reenviar
  `customer.subscription.created` de esa suscripción; si no existe el evento,
  es una suscripción creada a mano en Stripe: añadirle `metadata.org_id` y
  crear la fila con el mismo procedimiento que la alerta 2.
- **«Compra a 0 € sin poder leer el cupón / sin poder marcar la exención»**:
  un probador acaba de entrar y NO ha quedado exento: el día 1 se le
  facturaría. Marcarlo a mano (runbook de migraciones, § 0028, «Marcar una
  cortesía a mano») antes del día 1.
- **«Checkout sin poder identificar al comprador: no se ha creado la pertenencia»**
  (aviso): el cliente pagó y no tiene fila en `org_members`; verá el panel
  vacío. Insertar la pertenencia con `role='owner'` a partir del
  `user_id` del correo o de `auth.users` por el email.
- **«Cancelación SIN org_id» / «Cambio de suscripción SIN org_id»** (aviso):
  misma causa y procedimiento que las alertas 2 y 3.

### 6.6 · Licencias, ingest y panel

- **«No se pudo emitir una licencia a una organización que la pide»**: el
  cliente paga y el SDK no arranca. `motivo` suele apuntar a la clave de
  firma (`LICENSE_PRIVATE_KEY_B64` / `LICENSE_KEY_ID` en Vercel) o a la
  base. Comprobar por existencia, redesplegar, y que el cliente vuelva a
  pulsar «Obtener licencia».
- **«El panel de un cliente está VACÍO pero sus filas de uso existen (RLS)»**:
  las políticas de `usage_daily` no dejan leer a ese usuario sus filas.
  Comprobar `org_members` de la org y las políticas de la migración que las
  creó; no tocar datos.
- **«El ingest de uso está fallando»**: alerta 5.

### 6.7 · Correo y purga

- **«auth/correo sin RESEND_API_KEY» / «Resend devolvió 429»**: los correos
  de alta, confirmación y recuperación no salen (el 429 es el tope del plan
  de Resend). Sin ellos nadie nuevo puede entrar: revisar la clave en Vercel
  o el plan de Resend. Los envíos fallidos por red son `aviso` y se
  reintentan solos desde el cliente.
- **«La purga de usage_ingest_seen está fallando»**: la tabla de idempotencia
  del ingest vuelve a crecer sin tope. No hay urgencia de horas; mirar el
  `motivo` (permisos o timeout) y relanzar `cron/retencion` (`?seco=1`
  enseña cuántas filas borraría).

## 7 · Quién cierra con comisión (añadido 2026-11-16)

Desde el 2026-11-16 el cierre y la facturación cobran comisión **solo** a la
organización que, durante el período, tuvo una suscripción en un Price
**declarado con comisión** (`apps/web/lib/billing/plan-de-la-org.ts`,
LICENSE-CLOUD §6(b)). Pro y Equipo —vivos, cancelados o impagados—, solo
«Medir», sin suscripción y Enterprise sin contrato con comisión cierran con
cargo 0 y conservan su extracto.

**Y lo que no se puede decidir no se sella.** Cada Price de una suscripción
nuestra tiene que estar declarado en una de estas listas:

| Clase | Variables | Efecto |
|---|---|---|
| Con comisión | `STRIPE_PRICE_ID_MONTHLY`, `STRIPE_PRICE_ID_YEARLY`, `STRIPE_PRICE_IDS_COMISION` (comas) | cierra con cargo |
| Sin comisión | `STRIPE_PRICE_ID_PRO_MONTHLY/YEARLY`, `STRIPE_PRICE_ID_TEAM_MONTHLY/YEARLY`, `STRIPE_PRICE_IDS_SIN_COMISION` (comas) | cierra a 0 |
| **Sin declarar** | en ninguna (aunque esté en `STRIPE_PRICE_IDS_EXTRA`) | **la organización NO se sella** + alerta crítica |

`STRIPE_PRICE_IDS_EXTRA` no clasifica nada: es el escape de la atribución y
mezcla Prices con comisión (los rotados) y sin ella (cortesías).

### 7.0 · Lista de comprobación ANTES de desplegar (y antes del día 1 a las 05:00 UTC)

El extracto sellado es inmutable; esto se hace una vez, con calma, antes.

> **En la duda, un Price se deja SIN DECLARAR.** Sin declarar es el estado
> seguro: la organización no se sella y llega una alerta crítica con el price
> id (§7.1), y se resuelve con calma. Declararlo **sin comisión** por error es
> lo único de esta lista que falla en silencio: sus clientes cierran a 0 para
> siempre, sin ninguna alerta, y la auditoría del paso 5 ya no los puede dar por
> buenos. `STRIPE_PRICE_IDS_SIN_COMISION` solo lleva Prices que se han
> comprobado uno a uno (paso 2).

1. **Los Prices de comisión ROTADOS van a `STRIPE_PRICE_IDS_COMISION`.** El
   2026-08-13 (#53, `apps/web/scripts/provision-precios-exclusive.mjs`)
   `STRIPE_PRICE_ID_MONTHLY`/`YEARLY` pasaron a apuntar a los Prices `exclusive`
   nuevos, y los **anteriores** (`inclusive`) —con los que sigue renovando quien
   se suscribió antes de esa fecha— quedaron **solo** en
   `STRIPE_PRICE_IDS_EXTRA`. Copiar esos price ids antiguos de comisión a
   `STRIPE_PRICE_IDS_COMISION` (Production). Los price ids no son secretos; se
   leen en el panel de Vercel o en el catálogo de Stripe (el Price nuevo lleva
   `metadata.sustituye_a` = el antiguo). No hace falta quitar nada de
   `STRIPE_PRICE_IDS_EXTRA`.
2. **El resto de `STRIPE_PRICE_IDS_EXTRA` NO va en bloque a ninguna lista.**
   `EXTRA` mezcla Prices de comisión y de cortesía, y un Price de comisión que
   no se rotó en #53 no lleva `metadata.sustituye_a`: el paso 1 no lo ve. Cada
   Price se mira **uno a uno** en Stripe, y antes de declarar **cualquiera**
   como sin comisión se cruza con lo ya facturado (solo lectura, SQL editor de
   Supabase):

   ```sql
   SELECT s.price_id, count(DISTINCT c.org_id) AS orgs_con_comision_cobrada
   FROM bvsala.subscriptions s
   JOIN bvsala.cargos c
     ON c.org_id = s.org_id
    AND c.estado IN ('facturado', 'pagado')
    AND c.periodo < '2026-09'
   GROUP BY 1
   ORDER BY 1;
   ```

   Un `price_id` que sale ahí es el de una organización a la que se cobró
   comisión **antes de que existiera Pro** (2026-09-29): casi seguro lleva
   comisión → `STRIPE_PRICE_IDS_COMISION`, **nunca** a la lista sin comisión
   sin haberlo confirmado en Stripe. (Una organización con varias
   suscripciones puede arrastrar un Price ajeno a la consulta: por eso se
   confirma, no se copia.)
   - Cortesía, socio o cuota fija a medida **comprobados**: a
     `STRIPE_PRICE_IDS_SIN_COMISION`, o marcar la organización `comision_exenta`
     (la marca gana a todo).
   - Un contrato Enterprise **con** comisión: su Price a
     `STRIPE_PRICE_IDS_COMISION`.
   - **En la duda: sin declarar** (ver arriba).
3. **Comprobar por existencia** (`vercel env ls production`, nunca
   `vercel env pull`) que están: `STRIPE_PRICE_ID_MONTHLY`,
   `STRIPE_PRICE_ID_YEARLY`, `STRIPE_PRICE_IDS_COMISION`, las cuatro de
   Pro/Equipo y, si aplica, `STRIPE_PRICE_IDS_SIN_COMISION`.
4. **Verificar contra la base, solo lectura** (SQL editor de Supabase):

   ```sql
   SELECT price_id, status, count(*)
   FROM bvsala.subscriptions
   GROUP BY 1, 2
   ORDER BY 1, 2;
   ```

   Cada `price_id` que salga (salvo los que solo tengan filas
   `incomplete_expired`, o canceladas hace meses) tiene que estar en una de las
   dos clases de la tabla de arriba. Un `price_id` nulo es una fila rota: mirarla.
5. **Auditoría de lo ya facturado, ANTES de desplegar** (solo lectura, la
   ejecuta el dueño; no escribe en la base ni en Stripe). Con el catálogo que
   se va a desplegar en el entorno de la terminal, lista los cargos
   `facturado`/`pagado` desde 2026-09 de organizaciones que con ese catálogo no
   llevarían comisión. Va antes porque es la última comprobación de que ningún
   Price de comisión ha acabado en la lista sin comisión: después del
   despliegue, el cierre ya sella con él.

   ```bash
   cd apps/web   # Node ≥ 22.18; las variables STRIPE_PRICE_* de Production en el entorno
   export NEXT_PUBLIC_SUPABASE_URL="https://<ref>.supabase.co"   # pública
   # La clave de servicio NO se escribe en la línea de órdenes (quedaría en el
   # historial de la shell): se pega a ciegas y vive solo en esta terminal.
   read -rs "SUPABASE_SERVICE_ROLE_KEY?service role key: " && export SUPABASE_SERVICE_ROLE_KEY   # zsh
   # bash: read -rsp "service role key: " SUPABASE_SERVICE_ROLE_KEY && export SUPABASE_SERVICE_ROLE_KEY
   node scripts/auditoria-comision-indebida.mjs --desde=2026-09
   unset SUPABASE_SERVICE_ROLE_KEY
   ```

   Saca solo `org_id, periodo, importe_eur, estado, stripe_invoice_id, motivo,
   precios, veredicto`. El veredicto:
   - `seguro` — todas las suscripciones con las que se decidió llevan uno de
     los cuatro Prices de Pro/Equipo. Candidato a nota de crédito (decisión del
     dueño).
   - `COMPROBAR` — el 0 se apoya en un Price de
     `STRIPE_PRICE_IDS_SIN_COMISION`, o no hay ninguna suscripción. **Si ese
     Price llevaba comisión, la factura era correcta y el error está en el paso
     2**: sacarlo de la lista sin comisión antes de desplegar.
   - `REVISAR` — Price sin declarar, mes mixto o final no probado.

   Solo `seguro` entra en el total. La clave no se imprime ni se guarda: no
   pegarla en un fichero ni en la orden.
6. **Redesplegar** (las variables no entran en un despliegue ya hecho) y
   **ensayar en seco** el mes en curso:

   ```bash
   curl -sS -H "Authorization: Bearer $CRON_SECRET" \
     "https://savings.bivelio.com/api/cron/cierre-extractos?seco=1&periodo=<YYYY-MM>" \
     | jq '{error, sin_sellar, comision}'
   ```

   Tiene que salir `sin_sellar: []` (o solo meses mixtos ya conocidos, §7.2),
   ningún `error`, y cada cliente con comisión con
   `cobra: true, motivo: "plan_con_comision"`. Cada entrada de `comision` trae
   en `precios` los price ids con los que se decidió: **leer los de cada
   `cobra: false`** — un `plan_de_cuota_fija` cuyo Price no es uno de los cuatro
   de Pro/Equipo es un Price de `STRIPE_PRICE_IDS_SIN_COMISION`, y tiene que
   ser uno de los comprobados en el paso 2. El ensayo no manda alertas ni
   escribe nada. `error: "commission catalogue empty"` = paso 1/3 sin hacer.
7. **Ensayo de la facturación** sobre un mes ya cerrado:

   ```bash
   curl -sS -H "Authorization: Bearer $CRON_SECRET" \
     "https://savings.bivelio.com/api/cron/facturar-extractos?seco=1&periodo=<YYYY-MM>" \
     | jq '.sin_comision'
   ```

   Cada entrada es un cargo sellado que ya no se facturaría, con su motivo.
   `cargo_existente` distinto de `null` (y `ya_facturado: true` en `ensayo`)
   significa que **esa factura ya se emitió** con la regla anterior: es uno de
   los cargos de la auditoría del paso 5.

### 7.1 · «Cierre de extractos: N organización(es) SIN SELLAR — Price sin declarar o comisión y cuota fija en el mismo mes; resolver y relanzar»

**Qué significa.** El cierre ha sellado a todas las demás y se ha **saltado**
las de `detalle.orgs`: ni cargo ni 0. Cada una trae su `motivo`:

- `precio_desconocido` — una suscripción suya que tocó el mes lleva un Price que
  no está en ninguna lista (`detalle.precios_sin_declarar`). Lo normal: un
  Price de comisión rotado que falta en `STRIPE_PRICE_IDS_COMISION`.
- `plan_sin_comision_en_el_periodo` — **mes mixto**: comisión y Pro/Equipo en el
  mismo mes (§7.2).
- `final_no_probado` — una suscripción con comisión cancelada cuya fecha de
  final no se puede fijar (fila antigua sin `last_event_at`). Solo al relanzar
  meses viejos. Mirar en Stripe cuándo terminó (`ended_at`) y tratar como §7.2.

**Qué hacer (`precio_desconocido`).**
1. Mirar el Price en Stripe y declararlo: `STRIPE_PRICE_IDS_COMISION` si lleva
   comisión, `STRIPE_PRICE_IDS_SIN_COMISION` si no — **solo** tras cruzarlo con
   lo ya facturado (consulta del paso 2 de §7.0). En la duda se queda sin
   declarar: no se sella nada mal mientras tanto. Redesplegar.
2. Relanzar el cierre y **después** la facturación (el cron de las 07:00 ya
   pasó sin ese extracto):
   `GET /api/cron/cierre-extractos?periodo=<YYYY-MM>` y
   `GET /api/cron/facturar-extractos?periodo=<YYYY-MM>`, con el Bearer. Los dos
   son idempotentes: lo ya sellado o facturado no se toca.

Mientras no se resuelva, esa organización no tiene extracto de ese mes y no se
le factura nada; no caduca, pero no se arregla solo.

### 7.2 · Mes mixto (`plan_sin_comision_en_el_periodo`)

**Qué significa.** La organización cambió de plan a mitad de mes (lo habitual:
canceló la modalidad con comisión a fin de ciclo y compró Pro). El extracto es
mensual y no reparte el ahorro por días: cobrar el mes entero comisionaría días
de cuota fija, y sellar 0 regalaría los de comisión. Por eso no se sella sin
una decisión del dueño. No hay columna donde guardar «revisado» (y no se añade
migración), así que la decisión se ejecuta así:

- **Cerrar el mes a 0** (a favor del cliente): marcar la organización
  `comision_exenta = true`, relanzar `cierre-extractos?periodo=<YYYY-MM>`, y
  **quitar la marca** después. El extracto queda sellado con cargo 0 y «lo que
  habría sido» sobre el mes entero (una cota superior).
- **Cobrar los días con comisión**: lo anterior, más una factura manual en
  Stripe por la parte que el dueño decida. El cron no puede sellar ese mes con
  cargo.

**⚠ La marca `comision_exenta` es compartida: tres cautelas, las tres
obligatorias.** No es un interruptor privado de este procedimiento — la leen y
la escriben otras piezas:

1. **Solo DESPUÉS de que `cobrar-asientos` haya corrido para ese período** (día
   1 a las 07:30 UTC; comprobar en los registros de Vercel que terminó).
   Mientras la marca está puesta, ese cron **no cobra** el exceso de asientos de
   la organización: lo deja en revisión manual. Poner la marca a las 07:15 es
   perder ese cobro automático.
2. **Dejar escrito por qué**, en la misma sentencia. El webhook pone y quita la
   marca guiándose por `exencion_nota` (la exención del cupón se levanta sola
   con la primera renovación cobrada): una marca sin nota propia se confunde
   con esa. Anotar antes la nota que hubiera, para restaurarla:

   ```sql
   SELECT id, comision_exenta, exencion_nota FROM bvsala.organizations WHERE id = '<org_id>';
   -- Si YA estaba exenta (true), no hay nada que hacer aquí: la exenta se sella a 0 sola.
   UPDATE bvsala.organizations
      SET comision_exenta = true, exencion_nota = 'revisión mes mixto <YYYY-MM>'
    WHERE id = '<org_id>' AND comision_exenta = false;
   ```

3. **Quitarla y COMPROBARLO con un `SELECT`**, nada más relanzar el cierre. Una
   marca olvidada sella a 0 **todos** los meses siguientes, sin ninguna alerta:

   ```sql
   UPDATE bvsala.organizations
      SET comision_exenta = false, exencion_nota = <la nota anterior, o NULL>
    WHERE id = '<org_id>' AND exencion_nota = 'revisión mes mixto <YYYY-MM>';
   -- Tiene que devolver CERO filas:
   SELECT id, comision_exenta, exencion_nota
     FROM bvsala.organizations
    WHERE exencion_nota LIKE 'revisión mes mixto%' OR (id = '<org_id>' AND comision_exenta);
   ```

Son escrituras en producción: las hace el dueño, a mano. No hay (por decisión
del dueño, de momento) un parámetro del cierre para sellar una organización a 0
sin tocar la marca.

**Cuándo NO es un mes mixto (y no hay que hacer nada).** Una fila `paused` o
`incomplete` que no ha recibido ningún evento desde **antes** del inicio del
período no cuenta para ese período, ni como comisión ni como cuota fija: una
prueba con comisión pausada en julio no convierte en mixtos los meses de un
cliente que compró Pro en septiembre, y un checkout de Pro atascado en
`incomplete` no deja sin cobrar la comisión viva. (Solo si la fila tiene
`last_event_at`; las anteriores a la migración 0012 siguen contando.)

**⚠ El mes mixto que se REPITE cada mes: cancelar la suscripción vieja en
Stripe.** Toda fila no cancelada cuenta en cada período posterior a su alta, y
la excepción de arriba no cubre estos casos:

- la suscripción **con comisión** está `unpaid` (impagada) y la organización
  compró después Pro o Equipo — el checkout lo permite a propósito;
- está `paused` o `incomplete` pero sin `last_event_at`, o sigue recibiendo
  eventos;
- una fila de Pro/Equipo `unpaid` junto a una suscripción con comisión viva.

`unpaid` se deja fuera de la excepción adrede: Stripe sigue abriendo un ciclo
—y mandando eventos— cada mes a una suscripción impagada, así que su
`last_event_at` no prueba nada, y una impagada con comisión **sola** se tiene
que seguir cobrando. El resultado es que la organización sale `sin_sellar` con
`plan_sin_comision_en_el_periodo` **todos los meses**, con su alerta crítica,
y el panel del cliente de Pro enseña una comisión que no debe.

**Resolución:** cancelar en Stripe la suscripción que ya no da servicio (la
`unpaid`/`paused`/`incomplete`; `detalle.orgs[].precios` dice cuáles son los
Prices implicados). El webhook la pasa a `canceled` con su fecha de final, y a
partir del mes siguiente a esa fecha deja de contar. El mes en curso —y los
anteriores que quedaran sin sellar— se cierran una vez con el procedimiento de
arriba. Sin esa cancelación, el procedimiento hay que repetirlo cada día 1.

También cuenta como mes mixto un checkout de Pro/Equipo todavía `incomplete`
en el instante del cierre: relanzar al día siguiente suele bastar.

### 7.3 · «Cierre de extractos aplazado: no hay ningún Price de comisión configurado — restaurar las variables y relanzar»

**Qué significa.** Faltan `STRIPE_PRICE_ID_MONTHLY`, `STRIPE_PRICE_ID_YEARLY` y
`STRIPE_PRICE_IDS_COMISION` en Production y hay organizaciones con uso y
suscripción. **No se ha sellado nada** (500): sellar así habría cerrado a 0 a
todos los clientes con comisión.

**Qué hacer.** Restaurar las variables, redesplegar y relanzar
`cierre-extractos?periodo=<YYYY-MM>` y luego `facturar-extractos?periodo=…`.

### 7.4 · «Cargo de comisión sellado…» (facturar-extractos)

- **«…que no se factura: la organización no llevó un plan con comisión en el
  período»** (aviso, no llega por correo). Un extracto con cargo —sellado con la
  regla anterior, o cuyo plan cambió entre las 05:00 y las 07:00— que la
  facturación ya no convierte en factura. Nada que hacer salvo que
  `cargo_existente` no sea `null`: entonces la factura ya existía → auditoría
  del paso 5 de §7.0.
- **«…SIN FACTURAR: el plan de la organización no se puede decidir — resolver y
  relanzar»** (crítico). Mismo caso que §7.1 visto desde la facturación: el
  extracto tiene cargo pero hoy el Price está sin declarar o el mes es mixto.
  Resolver como §7.1/§7.2 y relanzar `facturar-extractos?periodo=<YYYY-MM>`.
