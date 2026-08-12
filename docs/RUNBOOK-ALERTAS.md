# Manual de alertas — qué hacer cuando llega un correo de BV-SALA

Solo llega correo de lo **crítico**, y crítico significa una de dos cosas: *alguien
está pagando y no tiene producto*, o *estamos perdiendo datos de facturación*.
Cinco alertas, cinco procedimientos. Cada una dice qué mirar primero, cómo
arreglarlo y en cuánto tiempo hay que hacerlo.

**Lo primero, siempre, en las tres primeras:** casi todas se reparan
**reenviando el evento en Stripe**. Los handlers son idempotentes —comprueban
antes de emitir— así que reenviar es seguro: no duplica licencias ni cobra dos
veces.

> ⚠️ **PERO REENVIAR NO BASTA SI EL EVENTO YA SE PROCESÓ UNA VEZ**, y esto no es
> evidente: `webhook/route.ts:560-566` corta ANTES del manejador cuando el evento
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
