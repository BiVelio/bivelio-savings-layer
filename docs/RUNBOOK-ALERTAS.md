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
- **«aplazado: no se pudo leer la exención de comisión»**: igual que 6.2;
  el cierre se niega a sellar sin saber quién está exento, porque facturaría
  a probadores.
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
