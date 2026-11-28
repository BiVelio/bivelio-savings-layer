# Runbook — Savings independiente de Privacy

Savings y Privacy son dos productos, pero hoy comparten cosas que hacen que una
avería, una rotación o una decisión de uno afecte al otro. Este documento dice
qué comparten (y qué no), qué interruptores hay en el código para separarlos, y
en qué orden se encienden en producción, con su vuelta atrás.

**Nada de esto cambia producción por sí solo.** Todos los interruptores nacen
APAGADOS, y apagados la web hace exactamente lo de antes (hay tests que lo
fijan). Cada paso de producción de abajo lo da una persona, y los marcados
**[OK del fundador]** no se dan sin su aprobación.

Cómo leer las marcas: **verificado** = lo leí en el código o lo ejecuté al
escribir esto (28-11-2026); **inferido** = se deduce de lo verificado pero no lo
he visto pasar; **no verificable** = no tengo acceso para comprobarlo (y no debo
tenerlo: secretos, paneles de Supabase, Vercel o Stripe).

---

## 1 · Qué comparten hoy y qué no

| | ¿Compartido con Privacy? | Evidencia | Qué lo separa |
|---|---|---|---|
| Claves de firma de licencias | **No** | Verificado: la pública de Savings (`keys/license.pub.pem`, sha256 `128dabf1…`) y la de Privacy (`src/bivelio_privacy_gateway/licensing/_bvlic_public.pem` de su `main`) son distintas. La privada de Savings es `LICENSE_PRIVATE_KEY_B64` (`apps/web/lib/license/sign.ts:11-16`). | Nada que hacer |
| Servicio de licencias, revocaciones y medición | **No** | Verificado: viven en esta web (`/api/license/*`, `/licenses/revocations`, `/api/metering/*`) sobre el esquema `bvsala`. `git grep` de `licensing.bivelio.com`, `128.140.76.8`, `BVCP_` y `fernando` en todo el repo: 0 resultados. `services/licensing` y `services/metering` son un esqueleto en memoria (ver `services/README.md`). | Nada que hacer |
| Paquetes | **No** | Verificado: ningún `package.json` del repo depende de un paquete de Privacy; no hay submódulos. Hay código copiado de Privacy (`safe-next.ts`, `nav-hash.ts`, partes de `globals.css`), pero eso no crea dependencia en ejecución. | Nada que hacer |
| Base de cuentas (`auth.users` del proyecto `rsxebsvguppssbociwiu`) | **Sí** | Verificado en el código de Savings: `apps/web/lib/supabase/env.ts` cae en ese proyecto si falta la variable, y `db/README.md` dice que solo se comparte `auth.users`. El comentario de `apps/web/lib/supabase/env.ts` de Privacy dice que su producción corre en ese mismo proyecto. Cuántas cuentas son de cada uno: **no verificable** sin acceso a la base (para eso está el paso A0). | Camino A o B (sección 3) |
| Llave de servicio (`service_role`) | **Sí** (inferido) | La usa `apps/web/lib/supabase/admin.ts`. Que Privacy tenga la misma lo dice el inventario previo; no lo he comprobado. | `BVSALA_SUPABASE_SECRET_KEY` |
| Cookie de sesión | **Sí**, por el nombre | Verificado: sin nombre propio, `@supabase/ssr` 0.12.3 la llama `sb-<ref>-auth-token` (el test `lib/supabase/independencia.test.ts` lo demuestra con la librería real). Verificado en el código de Privacy: escribe esa cookie en el dominio de `NEXT_PUBLIC_COOKIE_DOMAIN`. Que en producción ese valor sea `.bivelio.com`: lo dice el inventario previo, no lo he comprobado. Consecuencia: Savings lee la sesión que escribe Privacy. | `NEXT_PUBLIC_BVSALA_COOKIE_SESION` |
| Correos de auth (Send Email Hook) | **Sí**: Savings manda los de Privacy | Verificado en el código: `app/api/auth/correo/route.ts` y `lib/correo/auth-hook.ts` reconocen privacy.bivelio.com y shield.bivelio.com. Que el hook esté encendido en Supabase apuntando aquí: **no verificable** (la configuración de Auth lleva secretos). | `BVSALA_CORREO_SIN_PRIVACY` (cuando Privacy tenga los suyos) |
| Textos que prometen la cuenta compartida | **Sí** | Verificado: `auth.signupSsoNote`, `dashboard.account.intro` y `dashboard.accountPlanStrip.personalNote`. | `BVSALA_CUENTA_PROPIA` |
| Resend (cuenta, clave y remitente) | **Sí** (inferido) | El comentario de `apps/web/.env.local.example` dice que es la misma cuenta que el resto de la plataforma; el remitente `no-reply@bivelio.com` estaba escrito en 4 sitios. | `RESEND_API_KEY` (valor) + `BVSALA_CORREO_REMITENTE*` |
| Stripe | **Sí** (cuenta), separado por una verja | Verificado en el código: `lib/stripe/atribucion.ts` (atribución por precio y producto). Todas las claves y precios salen ya del entorno. | Opcional (paso A7) |
| Equipo de Vercel, zona DNS `bivelio.com`, organización de Supabase | **Sí** (inferido) | Lo dice el inventario previo; no lo he comprobado (no entro en Vercel, DNS ni Supabase). | Opcional (paso A7) |

## 2 · Los interruptores de este cambio (todos APAGADOS por defecto)

| Variable (Vercel, proyecto de Savings) | Encendida hace… | Se enciende… | Vuelta atrás | Efecto en las personas |
|---|---|---|---|---|
| `BVSALA_SUPABASE_SECRET_KEY` | El cliente de servicio usa ESTA llave en vez de `SUPABASE_SERVICE_ROLE_KEY` | Cuando exista una clave secreta solo de Savings (A1) | Borrarla y redesplegar | Ninguno |
| `RESEND_API_KEY` (cambiar el valor) + `BVSALA_CORREO_REMITENTE`, `BVSALA_CORREO_RESPONDER_A`, `BVSALA_CORREO_REMITENTE_ALERTAS` | Los correos salen de la cuenta y del remitente de Savings. Sin `…_ALERTAS`, las alertas usan `BVSALA_CORREO_REMITENTE` | A la vez, en el mismo despliegue (A2) | Devolver el valor viejo de la clave y borrar las tres | Ninguno, si el dominio está verificado |
| `NEXT_PUBLIC_BVSALA_COOKIE_SESION` (p. ej. `bvsala-auth-token`) | Los cuatro clientes de Supabase de la web leen y escriben SOLO esa cookie: la de Privacy deja de abrir sesión en Savings | Cuando el fundador acepte que se acaba el inicio de sesión único (A3) | Borrarla y redesplegar | Todo el mundo vuelve a entrar en Savings una vez |
| `BVSALA_CORREO_SIN_PRIVACY=1` | El hook responde 422 a un correo de Privacy/Shield, no lo manda y avisa en crítico | SOLO cuando Privacy ya mande sus propios correos de auth (A4) | Borrarla y redesplegar | Si se enciende antes: en Privacy nadie recibe altas ni recuperaciones |
| `BVSALA_CUENTA_PROPIA=1` | Quita las tres frases de «la misma cuenta que en Shield/Privacy» | El MISMO día que se separan las cuentas (A4 o B6) | Borrarla y redesplegar | Ninguno |
| `SUPABASE_SEND_EMAIL_HOOK_SECRET` con **dos** secretos separados por un espacio | La ruta acepta la firma de cualquiera de los dos | Solo en el camino B, mientras los dos proyectos llamen al hook (B3) | Dejar uno solo | Ninguno |

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

## 3 · Dos caminos — decide el fundador **[OK del fundador]**

- **Camino A (el que propone el inventario, y el más corto): Savings se queda
  en `rsxeb`; es Privacy quien se va a su propio proyecto.** Savings no mueve ni
  un usuario ni una fila: el riesgo para Savings es solo no borrar de más
  cuando, al final, se limpien las cuentas de Privacy.
- **Camino B: Savings se va a un proyecto de Supabase propio.** Hay que copiar
  sus cuentas (con el mismo id y la misma contraseña) y todo `bvsala`, con una
  ventana de corte. Es el camino de la sección 5.

Los pasos A1, A2 y A3 valen para los dos caminos y no dependen de Privacy.

## 4 · Camino A, en orden

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
`billing_email` (por correo). «De Privacy», toda clave ajena desde `bvprga`.

- Verificado: lo ensayé contra un Postgres 17 local con las 37 migraciones de
  `db/` aplicadas, un `bvprga` y un `public` de juguete y 11 cuentas, una por
  caso; los recuentos salen exactos.
- **No ejecutado contra producción** (no tengo ni debo tener el token).
- Una columna de Privacy u otros **sin** clave ajena no se ve: por eso las
  cuentas «sin nadie» **nunca** se borran.

### A1 · Llave de servicio propia de Savings **[OK del fundador]**

1. En el panel de `rsxeb`, crear una clave secreta nueva solo para Savings (las
   `sb_secret_…`). Una persona la pega en Vercel como `BVSALA_SUPABASE_SECRET_KEY`
   (Preview primero), sin que pase por un chat ni por un fichero.
2. Redesplegar. Comprobar que `GET /licenses/revocations` sigue dando 200 y el
   mismo `seq` que antes (la cabecera `etag` lo lleva), que el panel carga y que
   `/api/cron/invariantes` no avisa.
3. Vuelta atrás: borrar la variable y redesplegar.

Verificado: `@supabase/supabase-js` 2.110.7 reconoce las claves `sb_secret_…`.
**No verificado**: que la pasarela de Supabase acepte esa clave en todas las
llamadas que hace esta web (por eso, Preview primero). La `service_role` vieja
**no se desactiva aquí**: la siguen usando Privacy y, según el inventario, el
sandbox de fernando (paso A6).

### A2 · Resend propio de Savings **[OK del fundador]**

1. El fundador crea la cuenta de Resend de Savings y verifica en ella un
   dominio o subdominio de envío (registros DKIM/SPF/MX en la zona: los pone él).
2. En Vercel, **en el mismo despliegue**: el valor nuevo de `RESEND_API_KEY` y
   `BVSALA_CORREO_REMITENTE` (p. ej. `BiVelio Savings <no-reply@<subdominio verificado>>`),
   y si se quiere `BVSALA_CORREO_REMITENTE_ALERTAS` y `BVSALA_CORREO_RESPONDER_A`.
   Cambiar la clave sin el remitente hace que Resend rechace el remitente viejo:
   los correos de auth darían error (la ruta responde 500 y avisa, no lo esconde).
3. Comprobar: una recuperación de contraseña de Savings a una dirección propia
   llega, con el remitente nuevo; una invitación de equipo llega.
4. Ojo: mientras el hook siga sirviendo a Privacy (hasta A4), **los correos de
   Privacy también saldrán por la cuenta nueva de Savings**, con el remitente
   nuevo. Si eso no se quiere, A2 va después de A4.
5. Vuelta atrás: el valor viejo de `RESEND_API_KEY` y borrar las variables de remitente.

### A3 · Cookie de sesión propia **[OK del fundador: se acaba el inicio de sesión único]**

1. `NEXT_PUBLIC_BVSALA_COOKIE_SESION=bvsala-auth-token` en Vercel (Preview
   primero) y redesplegar.
2. Efecto: Savings deja de leer `sb-rsxebsvguppssbociwiu-auth-token`, tanto la
   suya como la que Privacy escribe en `.bivelio.com`. Todo el mundo vuelve a
   entrar una vez; la contraseña es la misma.
3. Comprobar: entrar, salir, recuperar contraseña y aceptar una invitación; en
   el navegador la cookie nueva es solo de `savings.bivelio.com`.
4. Vuelta atrás: borrar la variable y redesplegar (quien conserve la cookie
   vieja vuelve a entrar sin contraseña; el resto entra de nuevo).
5. Queda en los navegadores la cookie vieja de Savings (solo de su host, inerte
   para Savings) y la de Privacy en `.bivelio.com`: esa la tiene que borrar
   Privacy (su paso P13). Este cambio no la toca, a propósito: borrarla desde
   Savings sacaría a la gente de Privacy.

### A4 · El día que Privacy ya tiene sus propias cuentas y correos **[OK del fundador]**

Requisito: Privacy en su propio proyecto (o con su propio hook), comprobado por
Privacy. Entonces, en el mismo despliegue de Savings:

1. `BVSALA_CORREO_SIN_PRIVACY=1` y `BVSALA_CUENTA_PROPIA=1`.
2. Comprobar: un alta en Savings recibe su correo; el alta, Cuenta y la nota
   «Personal» ya no hablan de la cuenta compartida.
3. Vigilar la alerta crítica «llegó un correo de Privacy con
   BVSALA_CORREO_SIN_PRIVACY=1»: si suena, Privacy sigue usando este hook →
   vuelta atrás inmediata (borrar `BVSALA_CORREO_SIN_PRIVACY` y redesplegar).

### A5 · Limpiar `rsxeb` de lo que era solo de Privacy **[OK del fundador · NO reversible]**

Solo cuando Privacy lleve un tiempo estable fuera (el fundador decide cuánto).

1. Respaldo completo de `rsxeb` antes (PITR o `pg_dump`), y anotar la hora.
2. `QUE=sql-borrables bash scripts/produccion/clasificar-usuarios.sh` imprime
   (sin ejecutarla) la consulta de los ids **solo de Privacy**: ni Savings, ni
   otros esquemas, ni «sin nadie». Esos son los únicos candidatos.
3. Por qué importa: `bvsala.org_members` y `bvsala.medir_altas` tienen
   `on delete cascade` contra `auth.users`. Borrar de más una cuenta de Savings
   borra en cascada su pertenencia a la organización y su alta de Medir, sin
   ningún aviso.
4. Volver a correr A0 después: «S» debe dar exactamente lo mismo que antes.
5. El esquema `bvprga` lo retira Privacy.

### A6 · Retirar la `service_role` compartida **[OK del fundador]**

Cuando nadie la use: Savings con su llave (A1), Privacy fuera de `rsxeb` y el
sandbox de fernando borrado (pasos de Privacy). Se desactiva en el panel.
**No verificado**: si una `service_role` desactivada se puede volver a activar.

### A7 · Opcionales **[OK del fundador]**

- **Stripe propio**: el código ya lo lee todo del entorno (`STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, los `STRIPE_PRICE_ID_*`, `STRIPE_PRODUCT_IDS`). Una
  cuenta nueva obliga a recrear las suscripciones vivas y a mover el webhook; el
  traspaso de clientes y tarjetas entre cuentas está **no verificado**. La verja
  de `atribucion.ts` se queda aunque la cuenta sea propia.
- **Equipo de Vercel propio**: se pasa el proyecto con sus variables, su dominio y
  sus 6 crons (`apps/web/vercel.json`), y se revisa `vigilante.yml`.

## 5 · Camino B: llevar las cuentas de Savings a un proyecto propio sin perder ninguna

Todo lo de abajo lo hace una persona. Los ficheros de cuentas llevan los hashes
de las contraseñas: son secretos (regla 0c), se guardan cifrados, no pasan por
ningún chat ni asistente, y se borran al acabar.

**B0 · Contar (A0).** Apuntar el total de «a copiar si Savings se va».

**B1 · Proyecto nuevo [OK del fundador].** Misma región (Frankfurt). Precio y
organización los decide el fundador.

**B2 · Esquema.** Aplicar `db/migrations/0001…0037` en orden (como en
`RUNBOOK-MIGRACIONES-PROD.md`) y exponer `bvsala` en la Data API (`db/README.md`).
Verificado en local: las 37 migraciones se aplican en orden sobre un Postgres 17
con un `auth` de juguete.

**B3 · Auth del proyecto nuevo.** `site_url` y lista de redirecciones de
savings.bivelio.com (y sus previews); el Send Email Hook apuntando a
`https://savings.bivelio.com/api/auth/correo` con un secreto NUEVO. En Vercel,
`SUPABASE_SEND_EMAIL_HOOK_SECRET` pasa a llevar **los dos secretos separados por
un espacio** (el de `rsxeb`, que sigue mandando los correos de Privacy, y el
nuevo). Verificado con tests: con dos, vale la firma de cualquiera; con uno, como siempre.

**B4 · Copia de cuentas (hora T0).** La consulta del conjunto sale de:

```bash
QUE=sql-savings bash scripts/produccion/clasificar-usuarios.sh > conjunto.sql   # sin la primera línea de comentario
```

Es «de Savings» **más las cuentas sin nadie** (pueden ser altas de Savings que
aún no han hecho nada; copiarlas de más no hace daño, perderlas sí). Con ella:

```sql
-- en rsxeb, solo lectura
copy (select u.* from auth.users u where u.id in ( <conjunto.sql> )) to stdout with (format csv, header);
copy (select i.* from auth.identities i where i.user_id in ( <conjunto.sql> )) to stdout with (format csv, header);
-- en el proyecto nuevo
copy auth.users from stdin with (format csv, header);
copy auth.identities from stdin with (format csv, header);
```

- Mismo `id` (las claves ajenas de `bvsala` apuntan a él) y mismo
  `encrypted_password` (la guía de Supabase dice que los hashes se pueden migrar
  y nadie tiene que cambiar la contraseña).
- **Antes de copiar**, comparar las columnas de `auth.users` y `auth.identities`
  de los dos proyectos; si no coinciden, usar una lista explícita de columnas.
- **No verificado**: que el rol que da Supabase pueda escribir en `auth.users`
  del proyecto nuevo con `copy`; confirmarlo en la documentación vigente de
  Supabase antes de la ventana.
- Verificado en local (Postgres 17, datos de juguete): se copian 7 de 11
  cuentas, las 7 esperadas, y `bvsala` restaura sin violar ninguna clave ajena.

**B5 · Copia de `bvsala`.** `pg_dump --data-only --schema=bvsala --no-owner --no-privileges`
desde `rsxeb` y restaurar en el nuevo. Después, recuento por tabla en los dos
lados: tienen que coincidir todos. Y `select max(seq) from bvsala.revocations`
idéntico: el SDK rechaza una lista de revocaciones con un `seq` más bajo que el
que ya vio (`src/license/revocation.ts:81`). Verificado en local: `pg_dump`
lleva el `setval` de la secuencia y la siguiente revocación sigue por encima.

**B6 · Corte (ventana).** En Vercel, a la vez: `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY` y `BVSALA_SUPABASE_SECRET_KEY` del proyecto nuevo,
y `BVSALA_CUENTA_PROPIA=1`; redesplegar. La CSP sale sola de la URL
(`next.config.mjs`) y la cookie cambia sola de nombre (`sb-<ref nuevo>-auth-token`).
Todo el mundo vuelve a entrar, salvo que se reutilice la clave de firma de JWT
(según la guía de Supabase, solo es posible en dos casos concretos).

**B7 · Lo que entró entre T0 y el corte.** Cuentas: repetir B4 con
`created_at > T0 or updated_at > T0` y `insert … on conflict (id) do update`
(**no verificado** que `updated_at` cambie en todos los casos, p. ej. al cambiar
la contraseña: comprobarlo antes). `bvsala` es lo difícil: los webhooks de
Stripe y la medición escriben sin parar. Lo que se sabe:

- Verificado en el código: el SDK reencola los lotes de medición si el servidor
  responde 5xx (`src/metering/emitter.ts:298-300`), con un tope de 1.000 por defecto.
- Verificado en el código: los manejadores del webhook de Stripe son
  idempotentes (`docs/RUNBOOK-ALERTAS.md`), así que los eventos de la ventana se
  pueden reenviar desde Stripe después del corte.
- **No resuelto en este cambio**: una forma de congelar las escrituras de
  `bvsala` durante la ventana. Es la razón principal para preferir el camino A.

**Vuelta atrás de B** (mientras no se limpie `rsxeb`): devolver las variables de
Vercel a `rsxeb` y redesplegar. Lo escrito en el proyecto nuevo después del
corte se trae de vuelta con el mismo procedimiento al revés.

## 6 · Riesgos que no hay que olvidar

- Encender `BVSALA_CORREO_SIN_PRIVACY` antes de tiempo deja a Privacy sin altas
  ni recuperaciones de contraseña. Por eso responde con error y alerta, no en silencio.
- Las claves ajenas de `bvsala` con `on delete cascade` contra `auth.users`
  hacen que un borrado de cuentas desde cualquier producto llegue a Savings.
- La URL de respaldo de `apps/web/lib/supabase/env.ts` sigue siendo `rsxeb`
  (para no cambiar nada hoy). En el camino B, si un día faltara
  `NEXT_PUBLIC_SUPABASE_URL`, la web hablaría con `rsxeb` usando las llaves del
  proyecto nuevo. Cuando el camino B esté cerrado, conviene quitar ese respaldo
  (Privacy ya lo quitó en el suyo).
- La cookie de Privacy en `.bivelio.com` (legible desde JavaScript, 400 días) la
  tiene que retirar Privacy; Savings deja de leerla con A3, pero no la borra.
