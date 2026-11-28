# Runbook — Savings independiente de Privacy

Savings y Privacy son dos productos, pero hoy comparten cosas que hacen que una
avería, una rotación o una decisión de uno afecte al otro. Este documento dice
qué comparten (y qué no), qué interruptores hay en el código para separarlos, y
en qué orden se encienden en producción, con su vuelta atrás.

**Nada de esto cambia producción por sí solo.** Todos los interruptores nacen
APAGADOS, y apagados la web hace exactamente lo de antes (hay tests que lo
fijan). Cada paso de producción de abajo lo da una persona, y los marcados
**[OK del fundador]** no se dan sin su aprobación.

Cómo leer las marcas: **verificado** = lo leí en el código o en la documentación
oficial, o lo ejecuté, al escribir esto (28-11-2026); **inferido** = se deduce de
lo verificado pero no lo he visto pasar; **no verificable** = no tengo acceso para
comprobarlo (y no debo tenerlo: secretos, paneles de Supabase, Vercel o Stripe).

---

## 0 · Lo que decidió el fundador el 28-11-2026

Savings y Privacy son independientes, pero «todo tiene que colgar de la misma
organizacion lo unico que debe estar fisicamente separado son los accesos, pero
las cuentas de la organizacion de BiVelio seran las mismas en todos los sitios
separadas pues por DNS, apartados de Github, mailing de resend etc». Para este
runbook eso quiere decir:

- **Ninguna cuenta nueva.** Stripe, Resend, Vercel, GitHub, Hetzner y Supabase
  son las cuentas de la organización BiVelio de siempre.
- **Lo que se separa son los accesos**: cada producto tiene su clave, su proyecto
  o su subdominio **dentro** de esas cuentas.
- **Savings se queda en `rsxeb`**, con una clave de servicio propia (A1).
  **Privacy se va a un proyecto de Supabase propio, en la misma organización.**
  Es el camino A de la primera versión de este runbook. El camino B, llevar
  Savings a un proyecto propio, queda descartado (sección 5).
- **Se acaba el inicio de sesión compartido.** La cookie de Privacy queda solo en
  su host (aprobado), y Savings deja de leerla (A3).
- **Privacy tendrá su propio envío de correos de Auth.** Hoy los manda esta web,
  que es el Send Email Hook de `rsxeb`.
- El sandbox de Privacy en fernando se borró el 28-11: el contenedor se quitó y
  la imagen sigue allí. Lo dice el fundador; yo no lo he comprobado.

| Cuenta de BiVelio | Lo que tiene Savings, solo suyo, dentro de ella | Paso |
|---|---|---|
| Supabase | El mismo proyecto (`rsxeb`) y una clave secreta `sb_secret_…` solo para Savings. Supabase lo recomienda: «Use a separate secret key for each backend component» (supabase.com/docs/guides/api/api-keys, leído el 28-11) | A1 |
| Resend | Una clave que solo puede enviar desde el subdominio de Savings, y ese subdominio verificado | A2 |
| Stripe | La verja de `lib/stripe/atribucion.ts` y, si se quiere, una clave restringida (`rk_live_…`) solo para Savings | A7 |
| Vercel | Ya es un proyecto aparte (`bivelio-savings-web`), en el mismo equipo que Privacy | Nada que hacer |
| GitHub | Ya es un repositorio aparte (`BiVelio/bivelio-savings-layer`), en la misma organización | Nada que hacer |
| DNS | La misma zona `bivelio.com`, con los subdominios de Savings | A2 (los registros del subdominio de envío) |

## 1 · Qué comparten hoy y qué no

| | ¿Compartido con Privacy? | Evidencia | Qué lo separa |
|---|---|---|---|
| Claves de firma de licencias | **No** | Verificado: la pública de Savings (`keys/license.pub.pem`, sha256 `128dabf1…`) y la de Privacy (`src/bivelio_privacy_gateway/licensing/_bvlic_public.pem` de su `main`) son distintas. La privada de Savings es `LICENSE_PRIVATE_KEY_B64` (`apps/web/lib/license/sign.ts:11-16`). | Nada que hacer |
| Servicio de licencias, revocaciones y medición | **No** | Verificado: viven en esta web (`/api/license/*`, `/licenses/revocations`, `/api/metering/*`) sobre el esquema `bvsala`. `git grep` de `licensing.bivelio.com`, `128.140.76.8`, `BVCP_` y `fernando` en todo el repo: 0 resultados. `services/licensing` y `services/metering` son un esqueleto en memoria (ver `services/README.md`). | Nada que hacer |
| Paquetes | **No** | Verificado: ningún `package.json` del repo depende de un paquete de Privacy; no hay submódulos. Hay código copiado de Privacy (`safe-next.ts`, `nav-hash.ts`, partes de `globals.css`), pero eso no crea dependencia en ejecución. | Nada que hacer |
| Base de cuentas (`auth.users` del proyecto `rsxebsvguppssbociwiu`) | **Sí** | Verificado en el código de Savings: `apps/web/lib/supabase/env.ts` cae en ese proyecto si falta la variable, y `db/README.md` dice que solo se comparte `auth.users`. El comentario de `apps/web/lib/supabase/env.ts` de Privacy dice que su producción corre en ese mismo proyecto. Cuántas cuentas son de cada uno: **no verificable** sin acceso a la base (para eso está el paso A0). | Se va Privacy; Savings se queda (sección 3) |
| Llave de servicio (`service_role`) | **Sí** (inferido) | La usa `apps/web/lib/supabase/admin.ts`. Que Privacy tenga la misma lo dice el inventario previo; no lo he comprobado. | `BVSALA_SUPABASE_SECRET_KEY` (A1) |
| Cookie de sesión | **Sí**, por el nombre | Verificado: sin nombre propio, `@supabase/ssr` 0.12.3 la llama `sb-<ref>-auth-token` (el test `lib/supabase/independencia.test.ts` lo demuestra con la librería real). Verificado en el código de Privacy: escribe esa cookie en el dominio de `NEXT_PUBLIC_COOKIE_DOMAIN`, y en su host si está vacía (`apps/web/lib/supabase/env.ts:60-64` de su `main`). Que en producción ese valor sea `.bivelio.com`: lo dice el inventario previo, no lo he comprobado. Consecuencia: Savings lee la sesión que escribe Privacy. | `NEXT_PUBLIC_BVSALA_COOKIE_SESION` (A3) |
| Correos de auth (Send Email Hook) | **Sí**: Savings manda los de Privacy | Verificado en el código: `app/api/auth/correo/route.ts` y `lib/correo/auth-hook.ts` reconocen privacy.bivelio.com y shield.bivelio.com. Verificado en el `main` de Privacy: su web no tiene ruta propia para ese hook (`git grep` de `email_action_type`, `webhook-signature` o `SEND_EMAIL_HOOK` en `apps/web`: 0). Que el hook esté encendido en Supabase apuntando aquí: **no verificable** (la configuración de Auth lleva secretos). | `BVSALA_CORREO_SIN_PRIVACY` (A4, cuando Privacy tenga los suyos) |
| Textos que prometen la cuenta compartida | **Sí** | Verificado: son cinco, `auth.loginSubtitle`, `auth.signupSubtitle`, `auth.signupSsoNote`, `dashboard.account.intro` y `dashboard.accountPlanStrip.personalNote` (la primera versión de este runbook decía tres; la revisión encontró las dos entradillas de acceso). Un test busca la suite y Shield en todos los mensajes para que no se escape otra. | `BVSALA_CUENTA_PROPIA` (A4) |
| Resend (cuenta, clave y remitente) | **Sí** (inferido) | El comentario de `apps/web/.env.local.example` dice que es la misma cuenta que el resto de la plataforma; el remitente `no-reply@bivelio.com` estaba escrito en 4 sitios. | La cuenta se queda; la clave y el remitente pasan a ser de Savings (A2) |
| Stripe | **Sí** (cuenta), separado por una verja | Verificado en el código: `lib/stripe/atribucion.ts` (atribución por precio y producto). Todas las claves y precios salen ya del entorno. | La cuenta se queda; clave restringida opcional (A7) |
| Equipo de Vercel, zona DNS `bivelio.com`, organización de Supabase | **Sí, y se queda así** (decisión del 28-11) | Vercel, verificado: los comentarios del bot de Vercel en el PR #632 de Savings y en el PR #690 de Privacy enseñan dos proyectos, `bivelio-savings-web` y `bivelio-privacy-gateway`, del mismo equipo. La zona DNS y la organización de Supabase: lo dice el inventario previo, no lo he comprobado. | Nada: son las cuentas de la organización |

## 2 · Los interruptores de este cambio (todos APAGADOS por defecto)

| Variable (Vercel, proyecto de Savings) | Encendida hace… | Se enciende… | Vuelta atrás | Efecto en las personas |
|---|---|---|---|---|
| `BVSALA_SUPABASE_SECRET_KEY` | El cliente de servicio usa ESTA llave en vez de `SUPABASE_SERVICE_ROLE_KEY` | Cuando exista en `rsxeb` una clave secreta solo de Savings (A1) | Borrarla y redesplegar | Ninguno |
| `RESEND_API_KEY` (cambiar el valor) + `BVSALA_CORREO_REMITENTE`, `BVSALA_CORREO_RESPONDER_A`, `BVSALA_CORREO_REMITENTE_ALERTAS` | Los correos salen con la clave y el remitente de Savings, en la misma cuenta de Resend. Sin `…_ALERTAS`, las alertas usan `BVSALA_CORREO_REMITENTE` | A la vez, en el mismo despliegue (A2) | Devolver el valor viejo de la clave y borrar las tres | Ninguno, si el subdominio está verificado |
| `NEXT_PUBLIC_BVSALA_COOKIE_SESION` (p. ej. `bvsala-auth-token`) | Los cuatro clientes de Supabase de la web leen y escriben SOLO esa cookie: la de Privacy deja de abrir sesión en Savings | A3 (aprobado el 28-11: se acaba el inicio de sesión compartido) | Borrarla y redesplegar | Todo el mundo vuelve a entrar en Savings una vez |
| `BVSALA_CORREO_SIN_PRIVACY=1` | El hook responde 422 a un correo de Privacy/Shield, no lo manda y avisa en crítico | SOLO cuando Privacy ya mande sus propios correos de auth (A4) | Borrarla y redesplegar | Si se enciende antes: en Privacy nadie recibe altas ni recuperaciones |
| `BVSALA_CUENTA_PROPIA=1` | Quita las cinco frases de «la misma cuenta que en Shield/Privacy» y «una cuenta para toda la suite»: las entradillas de la entrada y del alta pasan a su versión sin la suite, y la nota del alta y la entradilla de Cuenta no se pintan | El MISMO día que se separan las cuentas (A4) | Borrarla y redesplegar | Ninguno |
| `SUPABASE_SEND_EMAIL_HOOK_SECRET` con **dos** secretos separados por un espacio | La ruta acepta la firma de cualquiera de los dos | Ningún paso de este runbook lo pide ya (era del camino B). Con uno solo, la ruta hace lo de siempre. Sirve para cambiar el secreto del hook con el viejo y el nuevo puestos a la vez un rato | Dejar uno solo | Ninguno |

Notas que importan:

- Las `NEXT_PUBLIC_` se incrustan al compilar: cambiarlas **pide redesplegar**.
  Las demás también se leen en cada despliegue; en Vercel, cualquier cambio de
  variable necesita un despliegue nuevo para tener efecto.
- Un valor mal escrito se **ignora con un aviso en el registro** y deja el
  comportamiento de siempre (nombre de cookie inválido, remitente que no es una
  dirección). Los interruptores `=1` solo se encienden con exactamente `1`.
- El nombre `BVSALA_SUPABASE_SECRET_KEY` lleva el prefijo de Savings a propósito:
  un nombre genérico como `SUPABASE_SECRET_KEY` lo puede crear por su cuenta una
  integración, y cambiaría la llave sin que nadie lo decidiera (hay un test).
- Probar antes en **Preview** con las mismas variables, cuando el paso lo permita.

## 3 · El camino: Savings se queda en `rsxeb` y se va Privacy (decidido el 28-11)

Savings no mueve ni un usuario ni una fila. Privacy se lleva lo suyo a su
proyecto propio, en la misma organización de Supabase (eso lo hace Privacy, no
este runbook). Para Savings, el único riesgo es no borrar de más cuando, al
final, se limpien de `rsxeb` las cuentas que eran solo de Privacy (A5).

Los pasos A1, A2 y A3 no dependen de Privacy. A4, A5 y A6 esperan a que Privacy
esté fuera de `rsxeb`.

## 4 · Los pasos, en orden

### A0 · Contar las cuentas (solo lectura)

Lo corre una persona con el token de la Management API en un fichero (regla 0c:
el token nunca se imprime ni se pega en un chat):

```bash
TOKEN_FICHERO=<fichero con SOLO el token sbp_…> bash scripts/produccion/clasificar-usuarios.sh
```

Imprime **solo números**: cuántas cuentas son solo de Savings, de Savings y
Privacy, solo de Privacy, de otros esquemas (el `public` de GPOS…) y de ninguno.
«De Savings» es toda columna con clave ajena a `auth.users` en `bvsala` más
`bvsala.skill_downloads.user_id`, las invitaciones pendientes y el
`billing_email` (por correo) y la marca `invitado_por_org` que el alta por
invitación pone en los metadatos de la cuenta. «De Privacy», toda clave ajena
desde `bvprga`.

- Verificado: lo ensayé contra un Postgres 17 local con las 37 migraciones de
  `db/` aplicadas, un `bvprga` y un `public` de juguete y 13 cuentas, una por
  caso; los recuentos salen exactos y cada consulta da los ids esperados.
- **No ejecutado contra producción** (no tengo ni debo tener el token).
- Una columna de Privacy u otros **sin** clave ajena no se ve: por eso las
  cuentas «sin nadie» **nunca** se borran.

**Lo que el recuento NO ve (revisión de #632): las altas de Savings que no han
hecho nada más.** Una cuenta de Savings solo deja filas en `bvsala` cuando hace
algo: crear su organización (`lib/org/resolver.ts` la crea al empezar un pago,
al pedir Medir o la prueba y al crear una cuenta de servicio), descargar el
skill o ser invitada. Darse de alta y entrar en el panel no escribe nada en
`bvsala` (verificado en el código: el alta solo llama a Supabase Auth,
`auth/callback` no toca la base y `dashboard/load.ts` solo lee). Si esa cuenta
tiene además filas en `bvprga`, sale como «solo de Privacy»; si las tiene en
otro esquema, como «otros». Es justo quien leyó en la web «la misma cuenta te
sirve aquí». No pierde licencias ni datos de Savings (no tiene), pero si su
cuenta se borra (A5), **pierde el acceso y tiene que darse de alta otra vez**.
El recuento las enseña en una línea propia («sin rastro de Savings pero con
filas de Privacy u otros»); el script no puede decir cuántas de ellas son de
Savings.

### A1 · Llave de servicio propia de Savings, en `rsxeb` **[OK del fundador]**

1. En el panel de `rsxeb` (el mismo proyecto y la misma organización de
   siempre), crear una clave secreta nueva solo para Savings (las
   `sb_secret_…`). Una persona la pega en Vercel como `BVSALA_SUPABASE_SECRET_KEY`
   (Preview primero), sin que pase por un chat ni por un fichero.
2. Redesplegar. Comprobar que `GET /licenses/revocations` sigue dando 200 y el
   mismo `seq` que antes (la cabecera `etag` lo lleva), que el panel carga y que
   `/api/cron/invariantes` no avisa.
3. Vuelta atrás: borrar la variable y redesplegar.

Verificado: `@supabase/supabase-js` 2.110.7 reconoce las claves `sb_secret_…`, y
la documentación de Supabase recomienda una clave secreta por componente.
**No verificado**: que la pasarela de Supabase acepte esa clave en todas las
llamadas que hace esta web (por eso, Preview primero). La `service_role` vieja
**no se desactiva aquí**: la sigue usando Privacy mientras esté en `rsxeb` (A6).

### A2 · Clave y subdominio de envío propios de Savings, en la cuenta de Resend de BiVelio **[OK del fundador]**

Sin cuenta nueva. En la cuenta de Resend de siempre:

1. El fundador añade un subdominio de envío solo para Savings y lo verifica
   (registros DKIM/SPF/MX en la zona `bivelio.com`: los pone él). El nombre lo
   elige él.
2. Crea en esa cuenta una clave de API nueva solo para Savings, con permiso
   `sending_access` y limitada a ese subdominio. Verificado en la documentación
   de la API de Resend (28-11): `sending_access` «Can only send emails», y una
   clave así se puede «restrict … to send emails only from a specific domain».
   Una persona la pega en Vercel, sin que pase por un chat ni por un fichero.
3. En Vercel, **en el mismo despliegue**: el valor nuevo de `RESEND_API_KEY` y
   `BVSALA_CORREO_REMITENTE` (p. ej. `BiVelio Savings <no-reply@<subdominio de Savings>>`),
   y si se quiere `BVSALA_CORREO_REMITENTE_ALERTAS` y `BVSALA_CORREO_RESPONDER_A`.
   Con una clave limitada al subdominio de Savings, cambiar la clave sin el
   remitente haría que Resend rechazara el remitente viejo (`no-reply@bivelio.com`).
   Entonces los correos de auth darían error: la ruta responde 500 y avisa, no lo
   esconde. Esto lo infiero de la documentación de Resend; no lo he visto pasar.
4. Comprobar: una recuperación de contraseña de Savings a una dirección propia
   llega, con el remitente nuevo; una invitación de equipo llega.
5. Ojo: mientras el hook siga sirviendo a Privacy (hasta A4), **los correos de
   Privacy también saldrán con la clave y el remitente de Savings**: la ruta usa
   el mismo remitente para todos los productos (`app/api/auth/correo/route.ts`).
   Si eso no se quiere, A2 va después de A4.
6. Vuelta atrás: el valor viejo de `RESEND_API_KEY` y borrar las variables de
   remitente. La clave vieja **no se revoca en este paso**: según el comentario
   de `apps/web/.env.local.example`, rotarla afecta también a GPOS y a Privacy
   (no lo he comprobado).

### A3 · Cookie de sesión propia **[Aprobado por el fundador el 28-11: se acaba el inicio de sesión compartido]**

1. `NEXT_PUBLIC_BVSALA_COOKIE_SESION=bvsala-auth-token` en Vercel (Preview
   primero) y redesplegar.
2. Efecto: Savings deja de leer `sb-rsxebsvguppssbociwiu-auth-token`, tanto la
   suya como la que Privacy escribe en `.bivelio.com`. Todo el mundo vuelve a
   entrar una vez; la contraseña es la misma.
3. Comprobar: entrar, salir, recuperar contraseña y aceptar una invitación; en
   el navegador la cookie nueva es solo de `savings.bivelio.com`.
4. Vuelta atrás: borrar la variable y redesplegar (quien conserve la cookie
   vieja vuelve a entrar sin contraseña; el resto entra de nuevo).
5. Quedan en los navegadores dos cookies viejas. La de Savings es solo de su
   host y ya no sirve para nada. La de Privacy está en `.bivelio.com` y la
   retira Privacy. El 28-11 se aprobó que la cookie de Privacy quede solo en su
   host; en su código eso es dejar vacía `NEXT_PUBLIC_COOKIE_DOMAIN` (leído en su
   `main`). La vieja de `.bivelio.com` sigue en los navegadores hasta que caduque
   o hasta que Privacy la borre a propósito (inferido). Lo apunta el runbook del
   PR #690 de Privacy. Este cambio no la toca, a propósito: mientras Privacy la
   use, borrarla desde Savings sacaría a la gente de Privacy.

### A4 · El día que Privacy ya tiene su proyecto y sus correos **[OK del fundador]**

Requisito, comprobado por Privacy: Privacy en su proyecto de Supabase propio
(misma organización) y mandando sus propios correos de Auth. Hoy la web de
Privacy no tiene ruta para el Send Email Hook (leído en su `main`): eso está por
hacer en Privacy. Entonces, en el mismo despliegue de Savings:

1. `BVSALA_CORREO_SIN_PRIVACY=1` y `BVSALA_CUENTA_PROPIA=1`.
2. Comprobar: un alta en Savings recibe su correo; la entrada, el alta, Cuenta
   y la nota «Personal» ya no hablan de la cuenta compartida ni de la suite.
3. Vigilar la alerta crítica «llegó un correo de Privacy con
   BVSALA_CORREO_SIN_PRIVACY=1»: si suena, Privacy sigue usando este hook →
   vuelta atrás inmediata (borrar `BVSALA_CORREO_SIN_PRIVACY` y redesplegar).

### A5 · Limpiar `rsxeb` de lo que era solo de Privacy **[OK del fundador · NO reversible]**

Solo cuando Privacy lleve un tiempo estable en su proyecto (el fundador decide
cuánto), y solo después de que el fundador elija **por escrito** qué hacer con
las altas de Savings sin actividad que también tienen filas de Privacy (ver A0,
«Lo que el recuento NO ve»). **[Decisión del fundador]** Las salidas:

- **(a) Esperar y borrar solo a quien no ha vuelto.** `QUE=sql-borrables`
  exige `PRIVACY_FUERA_DESDE=AAAA-MM-DD` (el día desde el que Privacy ya no usa
  `rsxeb`) y deja fuera a toda cuenta que haya entrado en `rsxeb` desde ese día
  (`auth.users.last_sign_in_at`, o una sesión de `auth.sessions` creada o
  actualizada desde entonces). Con Privacy fuera, quien entra en `rsxeb` entra
  en Savings, o en otro producto que siga ahí, y en los dos casos se queda.
  Cuanto más se espere, menos altas de Savings quedan en la lista; las que no
  hayan vuelto a entrar se pierden, y eso hay que aceptarlo por escrito.
  Verificado en local (datos de juguete): de tres cuentas «solo de Privacy», la
  que tiene `last_sign_in_at` después de la fecha y la que tiene una sesión
  actualizada después se quedan; la otra sale. Si falta `last_sign_in_at`, el
  script se niega en vez de dar una lista más larga.
  **Inferido**: que una entrada en Privacy ya no toca `rsxeb` cuando Privacy
  está en su proyecto (lo tiene que confirmar Privacy). **No verificado**: si
  Supabase actualiza `last_sign_in_at` o `auth.sessions.updated_at` al renovar
  una sesión sin contraseña; si no lo hace, alguien con una sesión abierta y sin
  entradas nuevas saldría en la lista.
- **(b) Una señal propia desde ahora.** Que Savings apunte, cada vez que alguien
  entra, que esa cuenta es suya (una tabla de `bvsala` con clave ajena a
  `auth.users`, que el script descubre solo). Necesita una migración y código
  nuevo detrás de un interruptor; **no está en este cambio**. Cuanto antes se
  encienda, menos cuentas quedan sin distinguir.
- **(c) No borrar.** Las cuentas «solo de Privacy» se quedan en `rsxeb`. No se
  pierde nadie, pero quedan en el proyecto de Savings datos de gente de Privacy
  (correo y hash de la contraseña) que Savings no necesita.

Con la decisión tomada:

1. Respaldo completo de `rsxeb` antes (PITR o `pg_dump`), y anotar la hora.
2. `QUE=sql-borrables PRIVACY_FUERA_DESDE=AAAA-MM-DD bash scripts/produccion/clasificar-usuarios.sh`
   imprime (sin ejecutarla) la consulta de los ids **solo de Privacy** que no han
   entrado desde esa fecha: ni Savings, ni otros esquemas, ni «sin nadie». Esos
   son los únicos candidatos. Sin la fecha, el script se niega.
3. Por qué importa: `bvsala.org_members` y `bvsala.medir_altas` tienen
   `on delete cascade` contra `auth.users`. Borrar de más una cuenta de Savings
   borra en cascada su pertenencia a la organización y su alta de Medir, sin
   ningún aviso.
4. Volver a correr A0 después: «S» debe dar exactamente lo mismo que antes.
5. El esquema `bvprga` lo retira Privacy.

### A6 · Retirar la `service_role` compartida **[OK del fundador]**

Cuando nadie la use: Savings con su llave (A1) y Privacy en su proyecto. El
sandbox de fernando, que según el inventario también la tenía, se quitó el
28-11 (lo dice el fundador; la imagen sigue en fernando y no sé si guarda alguna
clave). Se desactiva en el panel de `rsxeb`. Según la documentación de Supabase
(28-11), las claves viejas «stay valid until you disable them in the Settings >
API Keys section of the Dashboard», y «Supabase is deprecating the `anon` and
`service_role` keys in early 2027». **No verificado**: si una `service_role`
desactivada se puede volver a activar.

### A7 · Stripe y Vercel: las cuentas de siempre **[OK del fundador]**

Decidido el 28-11: ni cuenta de Stripe nueva ni equipo de Vercel nuevo.

- **Vercel: nada que hacer.** Savings ya es un proyecto aparte
  (`bivelio-savings-web`) en el mismo equipo que Privacy
  (`bivelio-privacy-gateway`); lo enseñan los comentarios del bot de Vercel en
  el PR #632 de Savings y en el PR #690 de Privacy. Las variables de cada
  producto viven en su proyecto.
- **Stripe: la misma cuenta, con la verja de `lib/stripe/atribucion.ts`**
  (atribución por precio y producto), que se queda. Si se quiere separar
  también el acceso, `STRIPE_SECRET_KEY` puede pasar a ser una **clave
  restringida solo para Savings**. Verificado en la documentación de Stripe
  (docs.stripe.com/keys/restricted-api-keys, 28-11):
  - empiezan por `rk_live_` o `rk_test_`;
  - cada recurso lleva **None**, **Read** o **Write**;
  - «All Stripe APIs support restricted API keys»;
  - Stripe aconseja «a separate restricted key for each service».

  La web no mira el prefijo `sk_` en ninguna parte. Solo lo miran los guiones
  de `apps/web/scripts/`, para decir en pantalla si la clave es live o test.

  Las llamadas que hace la web en ejecución, sacadas con `git grep` de
  `apps/web/app` y `apps/web/lib` (sin tests). Según Stripe, un `GET` pide
  lectura y un `POST` pide escritura. Qué nombre tiene cada permiso en el panel
  **no lo he comprobado**: esto es la lista de llamadas, no la de permisos.

  | Llamada | Dónde | Pide |
  |---|---|---|
  | `checkout.sessions.create` | `app/api/stripe/checkout` | escritura |
  | `billingPortal.sessions.create` | `app/api/stripe/portal` | escritura |
  | `customers.list`, `customers.retrieve` | checkout, `cron/facturar-extractos` | lectura |
  | `subscriptions.retrieve`, `subscriptions.list` | webhook, checkout y los dos crons de cobro | lectura |
  | `subscriptionItems.retrieve`, `subscriptionItems.update` | `cron/cobrar-asientos` | escritura |
  | `invoices.create`, `invoices.finalizeInvoice` | los dos crons de cobro | escritura |
  | `invoiceItems.create`, `invoiceItems.list` | los dos crons de cobro (`list`, solo `cron/cobrar-asientos`) | escritura |
  | `prices.retrieve` | `lib/stripe/pricing.ts`, checkout | lectura |
  | `coupons.retrieve` | checkout, webhook | lectura |
  | `promotionCodes.list` | checkout | lectura |
  | `webhooks.constructEvent` | webhook | nada: comprueba la firma con `STRIPE_WEBHOOK_SECRET`, en local |

  Los guiones de `apps/web/scripts/*.mjs` (crean productos, precios, el webhook
  y la configuración del portal) piden más y se corren a mano: no deben usar
  esta clave. El orden, como pide Stripe: primero una `rk_test_…` en Preview;
  probar el alta, un pago, el portal, el webhook y los dos crons de cobro; mirar
  en el panel los registros de esa clave (un error de permisos dice qué falta);
  y después la `rk_live_…` en producción. Vuelta atrás: el valor viejo de
  `STRIPE_SECRET_KEY` y redesplegar. La clave vieja no se revoca aquí. Si la
  comparte Privacy (inferido: es la misma cuenta), cada producto la deja cuando
  tenga la suya.

## 5 · Lo que ya no se hace (decisión del 28-11)

- **El camino B**: llevar Savings a un proyecto de Supabase propio, copiando
  sus cuentas y `bvsala`. Con él se van del script las consultas
  `QUE=sql-savings` y `QUE=sql-savings-estricto`. La versión anterior de este
  runbook, con el camino B entero (B0 a B7), está en el commit `4524350d`.
- **Cuentas nuevas** de Resend, Stripe o Vercel para Savings. Lo que se separa
  son las claves (A1, A2, A7).

## 6 · Riesgos que no hay que olvidar

- Encender `BVSALA_CORREO_SIN_PRIVACY` antes de tiempo deja a Privacy sin altas
  ni recuperaciones de contraseña. Por eso responde con error y alerta, no en silencio.
- Las claves ajenas de `bvsala` con `on delete cascade` contra `auth.users`
  hacen que un borrado de cuentas desde cualquier producto llegue a Savings.
- Una alta de Savings que no ha hecho nada más no deja rastro en `bvsala`: si
  tiene filas de Privacy, el script la ve como de Privacy. Por eso A5 espera a
  la decisión del fundador (A0, «Lo que el recuento NO ve»).
- Hacer A2 antes de A4 manda los correos de Privacy con la clave y el remitente
  de Savings (A2, punto 5).
- La cookie de Privacy en `.bivelio.com` (legible desde JavaScript, 400 días) la
  tiene que retirar Privacy; Savings deja de leerla con A3, pero no la borra.
- Supabase va a retirar `anon` y `service_role` a principios de 2027 (A6). A1
  quita la `service_role` de Savings. La clave pública de esta web sigue en
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Si su valor ya es una `sb_publishable_…`, no
  lo sé, y cambiarla queda fuera de este cambio.
