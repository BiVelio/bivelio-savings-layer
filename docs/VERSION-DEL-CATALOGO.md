# La versión del catálogo de precios

**Regla (decisión del dueño, 2026-09-29): la versión del catálogo de precios
cambia cada vez que cambia su contenido.**

La versión es `PRECIOS_AL_DIA` en `src/pricing/catalogo.ts`, un día `AAAA-MM-DD`:
el día del último cambio de contenido. No es el día en que alguien releyó la
página de un proveedor; eso sigue anotado donde estaba, en el comentario de
cada fila y en el `consultado` de cada tarifa de tier.

## Por qué

La versión viaja a lo que ve el cliente:

| Dónde | Cómo la cita |
|---|---|
| Extracto (`apps/web/lib/billing/extracto-sombra.ts`, `cierre.ts`) | `VERSION_PRECIOS_CATALOGO` → `parametros.versionPrecios` → columna `version_precios` de `extractos` (db/migrations/0016) y la página del extracto |
| Calculadora de comisión de la web | `PRECIOS_AL_DIA` del bundle vendored `apps/web/public/vendor/bv-sala.js` |
| Recibo del gateway (`gateway/recibo.ts`) | «Precios del catálogo …» |
| Banco A/B (`benchmarks/ab-live.ts`) | `pricing.catalogueDated` |
| Contraste semanal (`scripts/contraste-catalogo.ts`) | `catalogo.preciosAlDia` |
| Escrituras de caché (`src/economics/escrituras-de-cache.ts`) | fecha de consulta por defecto |

Entre el 2026-09-27 y el 2026-09-29 se quitó claude-3-haiku (#373) y se añadió
claude-sonnet-5-5 (#399) sin mover la fecha: dos cálculos distintos llevaban la
misma etiqueta, y la etiqueta dejó de demostrar nada.

## La verja

`test/version-del-catalogo.test.ts` calcula una huella sha256 de la
serialización canónica (JSON con las claves ordenadas) de todo lo que la versión
describe, y la compara con `HUELLAS_DEL_CATALOGO[PRECIOS_AL_DIA]`, que vive junto
a la versión en `src/pricing/catalogo.ts`.

**Entra en la huella** todo lo que decide el precio que la capa pone a una
petición o lo que acredita de ella:

- `CATALOGO`, fila a fila, con sus tramos (vigencia y precios ya anunciados).
- `SIN_FILA_PROPIA`: un veto quita el precio a un id que heredaba el de su pariente.
- Las primas de escritura de caché: las dos constantes y la prima que reciben,
  evaluada, cada fila del catálogo y de las tarifas de tier.
- `TARIFAS_DE_TIER` entera, con `fuente`, `consultado` y `vigenteHasta` (su
  `consultado` sale como `pricesCheckedOn`).
- La clasificación de razonamiento (`RAZONA_POR_FILA`, `IGNORA_TEMPERATURA` y
  los patrones de nombre): decide si la salida de una repetición se acredita.

**No entra**, a propósito: las propias etiquetas de fecha (`PRECIOS_AL_DIA`,
`TARIFAS_DE_TIER_AL_DIA`), los comentarios y el orden de las claves, el
emparejador de ids (es código, viaja con la versión del paquete y lo fijan sus
propios tests) y los `costModels` del cliente.

## Qué hacer cuando la verja falla

El mensaje del test lo dice con las cifras ya puestas. En resumen, en el mismo
commit que cambia el contenido:

1. `PRECIOS_AL_DIA` = la fecha de hoy (UTC), con una línea en su «Historia».
2. **Añadir** al final de `HUELLAS_DEL_CATALOGO` la entrada de hoy con la huella
   que imprime el test. La huella de una versión anterior no se reescribe nunca:
   hay extractos que la citan con aquel contenido.
3. `VERSION_PRECIOS_CATALOGO` en `apps/web/lib/billing/extracto-sombra.ts` = la
   misma fecha (su test la ancla al fichero del catálogo).

Dos cambios el mismo día: si la versión de hoy aún no ha salido en ninguna
release ni despliegue, se actualiza la huella de la entrada de hoy; si ya salió,
el cambio nuevo espera al día siguiente. La verja también falla si dos versiones
tienen la misma huella (se subió la versión sin cambiar nada) o si
`PRECIOS_AL_DIA` no es la última entrada.

La calculadora de la web lee el bundle vendored `bv-sala.js`, que se regenera con
`pnpm build` en la release: hasta entonces sigue mostrando la versión con la que
se generó.
