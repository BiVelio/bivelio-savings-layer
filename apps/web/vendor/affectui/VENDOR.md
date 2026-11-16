# vendor/affectui — piezas de affectUI adaptadas a BiVelio Savings

Código de terceros **vendorizado** (copiado y adaptado, no instalado como
dependencia). Vive fuera de `app/` a propósito: no es código de BiVelio y no
todo está bajo la licencia Apache-2.0 de este repositorio.

| | |
|---|---|
| Upstream | https://github.com/flohoeller/affectui (catálogo en https://www.affectui.com) |
| Commit de las piezas libres | `8f15236c790d3a21a668c98a663037e5219dd9c9` (2026-11-16) |
| Licencia de las piezas libres | MIT — texto íntegro en [`LICENSE`](./LICENSE) |
| Piezas Pro | Licencia affectUI Pro a nombre de BiVelio (https://www.affectui.com/license) |

## Dos licencias, no una

- **Piezas libres (MIT).** Se pueden redistribuir conservando el aviso de
  copyright: cada fichero lo lleva en su cabecera y el texto está en `LICENSE`.
- **Piezas Pro.** La licencia permite integrarlas en un producto con
  repositorio público **conservando el aviso en cada fichero**. Esos ficheros
  **no pasan a Apache-2.0** ni se redistribuyen como kit de componentes. Cada
  fichero derivado de una pieza Pro (el `.tsx` y su `.css`) empieza por:

  > Derived from affectUI Pro '<pieza>' (https://www.affectui.com). Used under
  > the affectUI Pro license held by BiVelio. NOT covered by this repository's
  > Apache-2.0 licence; do not redistribute as a component kit.

  Quien trabaje con el **fuente** Pro original necesita una plaza de la
  licencia; aquí solo vive el derivado ya integrado.

## Inventario

sha256 del fichero **upstream** del que deriva cada pieza (antes de adaptar),
para poder comparar al actualizar.

| Pieza | Ficheros | Licencia | Origen | sha256 upstream |
|---|---|---|---|---|
| Code Block (Clean) | `code-block-clean.tsx` + `.css` | MIT | `components/code-block-clean.tsx` | `928a4e93648c7fbee2074c07d67f39a0b574ecee189ead60d4da8b0463504979` |
| Empty State (Clean) | `empty-state-clean.tsx` + `.css` | MIT | `components/empty-state-clean.tsx` | `495f16a093feb816c8d1f26f9f4adeecfb95712fbf2ee55f9961432de9fe4d46` |
| Skeleton (Clean) | `skeleton-clean.tsx` + `.css` | MIT | `components/skeleton-clean.tsx` | `1664e4f6df2a4965b9f9cc483e69ba5f445bbde257c45b8c0f13b61784efb0e6` |
| Segmented Control (Clean) | `segmented-control-clean.tsx` + `.css` | MIT | `components/segmented-control-clean.tsx` | `8547e6335fc70ec9aa8e5a89dec96deb95bb46de5894c3c0e2b26e1763abd506` |
| Number Ticker | `number-ticker.tsx` + `.css` | MIT | `motion/number-ticker.tsx` | `c56e7605203d19041fa33c6f177bccd4a02bf75b7923ba037461fd64f8440a6d` |
| Experiment Card | `experiment-card.tsx` + `.css` | **affectUI Pro** | registro Pro, `experiment-card` (descarga del 2026-11-16) | `f6d08216b0a7803c47c196d52ea51e6d88e1d1900a3f584dba183a8459411373` |
| Pricing Plans | `pricing-plans.tsx` + `.css` | **affectUI Pro** | registro Pro, `pricing-plans` (descarga del 2026-11-16) | `37e802dab0624e23b07369ae5a7b0191624f3612c42be4e2780c3aa94472ceaf` |
| Gradient Text | `gradient-text.tsx` + `.css` | **affectUI Pro** | registro Pro, `gradient-text` (descarga del 2026-11-16) | `45e5c18b337ce322268f821185b5e384e20a953ee2af0b652c1d7646957659ef` |
| Gradient Floor | `gradient-floor.tsx` + `.css` | **affectUI Pro** | registro Pro, `gradient-floor` (descarga del 2026-11-16) | `df01c384627d3c66b2fa91ed3981212c71832124f92b4f0262d4937359c400d9` |

## Cambios respecto a upstream

**Comunes a todas las piezas**

1. Cabecera de procedencia y licencia en cada fichero.
2. La cadena `const css = \`…\`` y su `<style href precedence>` se
   sustituyen por un `.css` hermano que el `.tsx` importa
   (`import "./pieza.css"`). Next App Router admite CSS global importado desde
   un componente fuera de `app/`; el build lo comprueba.
3. **Solo tema claro**: se elimina el bloque final
   `:where(.dark, [data-theme="dark"]) …`.
4. **Tipografías**: los respaldos `"Inter", …` pasan a
   `var(--aui-font, var(--font-sans))` y `var(--aui-font-mono, var(--font-mono))`.
5. **Colores**: todo lo que upstream lee de `--aui-*` hereda BiVelio desde
   `:root` en `app/globals.css` (`--aui-primary` es tinta, `--aui-focus` es
   el azul de marca). Los colores propios de cada pieza que no pasaban por
   `--aui-*` se han apuntado a tokens de BiVelio (lista abajo).
6. `prefers-reduced-motion` se conserva tal cual.
7. Sin datos de demostración: ninguna pieza trae cifras, clientes ni textos de
   ejemplo. No hay cadenas en inglés por defecto: todo texto visible o leído
   por un lector de pantalla llega por props.

**Por pieza**

- **code-block-clean** — nueva prop `labels { copy, copied, code? }`; el botón
  de copiar solo se pinta si llega (`"Copy code"`/`"Copied"` eliminados). Paleta
  del coloreador a tokens: palabra clave `--brand`, cadena `--good-ink`, número
  y literal `--warn`, comentario `#7A7F8C`, función/variable `#0052B8`; fondo
  `--surface`, línea marcada con `--brand`.
- **empty-state-clean** — marco a `--surface` translúcido.
- **skeleton-clean** — `Loading.label` pasa a ser **obligatoria** (sin
  `"Loading"` por defecto); relleno `--surface-2`.
- **segmented-control-clean** — acento `--brand`/`--brand-soft`, relleno
  `--surface-2`, sombra de la pastilla con `--line`, curva `--aui-ease`.
- **number-ticker** — **ya no cuenta desde cero al entrar** (sugería una
  medición en curso): el primer valor se pinta tal cual, también en el HTML del
  servidor, y solo ruedan los cambios posteriores. Nueva prop `countIn` para
  recuperar la entrada de upstream. `duration` por defecto 320 ms (antes 900).
- **experiment-card** (Pro) — nuevas props obligatorias `labels`
  (`ExperimentCardLabels`: todas las cadenas visibles y de `aria-label`) y
  `locale` (los formatos numéricos ya no son `"en-US"` fijo). Tarjeta y
  pistas a `--surface`/`--surface-2`, transición 400 ms con `--aui-ease`.

- **pricing-plans** (Pro; frente F1, landing y `/pricing`) — reescrito como
  **componente de servidor sin datos propios**. Fuera: los planes, precios y
  textos de la demo (prueba de 14 días, dólares, descuento anual, SSO,
  workspaces, visitantes, integraciones y sus logos, «Popular»), el formateo
  de moneda (`money`, `"en-US"`), el rodillo de dígitos al cambiar de periodo,
  el plegado de detalles y los textos recortados con elipsis y `title`. Dentro:
  `plans` con importes YA formateados por quien llama, valores por periodo
  (`{ monthly, yearly }`) para precio y límites, `unit` (la unidad que se
  cobra, bajo el precio), `summary`, `limits` como `<dl>`, `action` y `footer`
  como nodos (el enlace real lo pone la página) y `labels` obligatorias. El
  selector mensual/anual son **dos radios nativos + CSS `:has()`**: funciona
  con teclado y sin JavaScript, y no anima cifras. Cuatro planes en fila
  (≥1040px del contenedor), dos y una columna, con filas compartidas
  (`subgrid`) para que la misma línea de cada tarjeta quede a la misma altura.
  El texto contractual parte línea; nada depende del hover. El precio anual se
  rotula como cargo anual: el componente nunca divide ni multiplica importes.
- **gradient-text** (Pro; F1, una frase del héroe) — colores a azul de marca →
  verde azulado (todas las paradas ≥ 3:1 sobre marfil), ciclo de 12 s (antes
  8), barrido de 900 ms, `-webkit-user-select`, y un bloque `forced-colors`
  que deja solo el texto real. El texto real sigue en el DOM (seleccionable y
  leído); la copia coloreada es `aria-hidden`.
- **gradient-floor** (Pro; F1, cierre de la landing) — `speed` por defecto `0`
  (la forma no se mueve), deriva lateral de 18 s (antes 2,5 s) ajustable con
  `--ui-gf-drift`, intensidad con `--ui-gf-strength`, fondo desde
  `--ui-gf-bg`/`--aui-surface`, colores por defecto azules de BiVelio, y las
  longitudes `u(n)` de la plantilla JS pasadas a `calc(n * 100cqw / 2200)` en
  el `.css`. Guarda contra una entrada vacía del IntersectionObserver.

## Cómo vendorizar una pieza nueva (frentes)

1. Copia el fichero upstream **sin tocar** a un directorio temporal y anota su
   `shasum -a 256`.
2. Crea `vendor/affectui/<pieza>.tsx` y `<pieza>.css`:
   - cabecera de licencia (MIT o Pro, las de arriba);
   - mueve el CSS de la cadena a `<pieza>.css` e impórtalo; borra el `<style>`;
   - borra el bloque de tema oscuro; tipografías a `var(--aui-font, var(--font-sans))`;
   - colores sueltos → tokens de BiVelio; no añadas `--aui-*` nuevos sin
     definirlos en `:root` de `app/globals.css` (eso lo coordina la fundación);
   - quita datos de demostración y cualquier texto por defecto: todo por props;
   - conserva `prefers-reduced-motion` y los roles/atributos ARIA.
3. Añade la fila al inventario y tus cambios a «Por pieza».
4. Úsala desde `app/` importando `@/vendor/affectui/<pieza>`. Las clases
   `ui-*` de la pieza viven en su `.css`; **no** escribas esas clases como
   literales en un `className` de `app/**` (el test `clases-que-existen` solo
   conoce `app/globals.css`).
5. `pnpm --dir apps/web run typecheck`, `pnpm exec vitest run apps/web` y el
   build.

## Cómo actualizar una pieza

1. Baja la versión nueva y compara su sha256 con el del inventario.
2. `diff` entre el upstream antiguo (commit de arriba) y el nuevo; aplica a mano
   solo lo que interese sobre el fichero adaptado.
3. Reaplica la lista de cambios, actualiza commit/sha256 aquí y vuelve a
   verificar reduced-motion, foco y contraste: el soporte que declara la
   librería se comprueba de nuevo después de modificarla.
