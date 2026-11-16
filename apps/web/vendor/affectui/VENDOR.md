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
| Code Block (Clean) — **solo el coloreador** | `code-block-clean.tsx` + `.css` | MIT | `components/code-block-clean.tsx` | `928a4e93648c7fbee2074c07d67f39a0b574ecee189ead60d4da8b0463504979` |
| Number Ticker | `number-ticker.tsx` + `.css` | MIT | `motion/number-ticker.tsx` | `c56e7605203d19041fa33c6f177bccd4a02bf75b7923ba037461fd64f8440a6d` |
| Experiment Card | `experiment-card.tsx` + `.css` | **affectUI Pro** | registro Pro, `experiment-card` (descarga del 2026-11-16) | `f6d08216b0a7803c47c196d52ea51e6d88e1d1900a3f584dba183a8459411373` |
| Pricing Plans | `pricing-plans.tsx` + `.css` | **affectUI Pro** | registro Pro, `pricing-plans` (descarga del 2026-11-16) | `37e802dab0624e23b07369ae5a7b0191624f3612c42be4e2780c3aa94472ceaf` |
| Gradient Text | `gradient-text.tsx` + `.css` | **affectUI Pro** | registro Pro, `gradient-text` (descarga del 2026-11-16) | `45e5c18b337ce322268f821185b5e384e20a953ee2af0b652c1d7646957659ef` |
| Gradient Floor | `gradient-floor.tsx` + `.css` | **affectUI Pro** | registro Pro, `gradient-floor` (descarga del 2026-11-16) | `df01c384627d3c66b2fa91ed3981212c71832124f92b4f0262d4937359c400d9` |
| Progress Tracker (Clean) | `progress-tracker-clean.tsx` + `.css` | MIT | `components/progress-tracker-clean.tsx` | `31c2172b973342f19ba98ac0caa5950bd846385032eef724a6cef59ebe1bfe60` |
| KPI Board | `kpi-board.tsx` + `.css` | **affectUI Pro** | registro Pro, `kpi-board` (descarga del 2026-11-16) | `874fc8f4b9a02071f504043efc1ba65f7487570a8a1bd7078f050370b2460c06` |
| Compact Breakdown | `compact-breakdown.tsx` + `.css` | **affectUI Pro** | registro Pro, `compact-breakdown` (descarga del 2026-11-16) | `16d917616dda6e0ba4f89a4a5efa0b10ee16a7c352548545857c56082b83d7f5` |
| Experiment Readout | `experiment-readout.tsx` + `.css` | **affectUI Pro** (derivado de Experiment Card) | registro Pro, `experiment-card` (descarga del 2026-11-16) | `f6d08216b0a7803c47c196d52ea51e6d88e1d1900a3f584dba183a8459411373` |
| Integration Beam (**fork**) | `integration-beam.tsx` + `.css` | MIT | `illustrations/integration-beam.tsx` | `533cfff48bfc8b2d03a1968292d79e2229b8156e690c587fc4b0dbc965445fe6` |
| Layer Stack | `layer-stack.tsx` + `.css` | MIT | `illustrations/layer-stack.tsx` | `4f8ea82ab8bca0c3a0a8f802eeaaa733fd2fac09b829f671519adbbaa8466cd6` |
| Fallback Chain (**solo la gramática, sin fallback**) | `fallback-chain.tsx` + `.css` | **affectUI Pro** | registro Pro, `fallback-chain` (descarga del 2026-11-16) | `33c253b5c17e1efd745f13e53e8be537fca02674119ca76e99e98a9d55e6d3b4` |
| Memory Graph | `memory-graph.tsx` + `.css` | **affectUI Pro** | registro Pro, `memory-graph` (descarga del 2026-11-16) | `235a440f5403b430d795250fd64d131e659c965cffe4260a056ce4d8831132e3` |
| Integration Flow (**partes, no la escena**) | `integration-flow.tsx` + `.css` | **affectUI Pro** | registro Pro, `integration-flow` (descarga del 2026-11-16) | `f85674636ec99d3cb1b310364efad8b104501411eddfe71f5473db8649dae26c` |
| Tooltip | `tooltip.tsx` + `.css` | **affectUI Pro** | registro Pro, `tooltip-clean` (descarga del 2026-11-16) | `248d67efb0b588fb949990c6427fc9d7aea734056eadddca564a3da7269a44f1` |
| Profile Menu | `profile-menu.tsx` + `.css` | **affectUI Pro** | registro Pro, `profile-menu-clean` (descarga del 2026-11-16) | `fb632b336ce6061151d5a329acc04f6b569bdf20bfb8d339fb27d59755a09270` |
| KPI Chart (**fork**) | `kpi-chart.tsx` + `.css` | **affectUI Pro** | registro Pro, `kpi-chart-clean` (descarga del 2026-11-16) | `81a7e5beb60e835413d35d99b08e3a5518fbcfe15a557a8d83a79663ec16000d` |
| Model Usage (**fork**) | `model-usage.tsx` + `.css` | **affectUI Pro** | registro Pro, `model-usage-clean` (descarga del 2026-11-16) | `a550368f7ba505a289e0c30d191f8676de7fbe3820612e3c270e77a238d39217` |
| Data Table (**fork de solo lectura**) | `data-table.tsx` + `.css` | **affectUI Pro** | registro Pro, `data-table-clean` (descarga del 2026-11-16) | `7c52ae0dfe600becdd259343d25ce5acb72bb38b18a94ac75a6ec26582f3bd5e` |
| Usage Meter (**fork: asientos**) | `usage-meter.tsx` + `.css` | **affectUI Pro** | registro Pro, `usage-meter-clean` (descarga del 2026-11-16) | `c2a9d72a1a8ee981b4bb53c507fb9011bd23387828f3e8e558c4abaa43e69b29` |
| Toaster (**reducido**) | `toaster.tsx` + `.css` | **affectUI Pro** | registro Pro, `toaster-clean` (descarga del 2026-11-16) | `2f83426953e89fdc61936a20e0b16ec046ca598b45d4ee0efaed872f2ffea5ad` |
| Badge | `badge.tsx` + `.css` | **affectUI Pro** | registro Pro, `badge-clean` (descarga del 2026-11-16) | `d5e6309addea4d8a9d65e4c58abd1075ed85bef43f6e65812e55a9918d3b234f` |

Las ocho piezas del frente E1 (2026-11-16) salen del catálogo completo bajado con
la licencia Pro. Ese catálogo no distingue cuáles publica además upstream bajo
MIT, así que todas llevan la cabecera Pro, la más restrictiva de las dos.

## Dónde se usa cada pieza

Auditoría del 2026-11-16: una pieza que nadie importa desde `app/` no se queda.

| Pieza | La importa |
|---|---|
| `pricing-plans` | `app/components/landing/PlanesCloud.tsx` (portada `#pricing` y `/pricing`) |
| `kpi-board` | `dashboard/components/ResumenKpis.tsx` (`/dashboard`) |
| `compact-breakdown` | `dashboard/components/DesgloseModelos.tsx` (`/dashboard`) |
| `progress-tracker-clean` | `dashboard/install/page.tsx`, `app/components/app/SetupProgress.tsx`, `dashboard/components/InstrumentationSpine.tsx` |
| `code-block-clean` | `migrate-to-0.5/page.tsx` (dentro de `CodeFrame`) |
| `integration-beam`, `layer-stack` | `app/components/HowItWorks.tsx` (`/how-it-works` y `/dashboard/how-it-works`) |
| `experiment-card` | `app/components/evidencia/ComparacionAB.tsx` (`/benchmarks`) |
| `experiment-readout` | `dashboard/components/YourBenchHeadline.tsx` (`/dashboard/your-bench`) |
| `gradient-text` | `app/[locale]/page.tsx` (una frase del héroe) |
| `gradient-floor` | `app/components/landing/CierreMeasure.tsx` (cierre de la portada) |
| `number-ticker` | `dashboard/components/VerdictHero.tsx` (la cifra del veredicto, al cambiar de rango) |
| `profile-menu` | `app/components/app/CuentaMenu.tsx` (la cuenta de la barra del panel, vía `AppTopbar`) |
| `tooltip` | `app/components/app/Termino.tsx` (definiciones de términos), `NavLink.tsx` (la frase de cada cifra del raíl), `PanelEditable.tsx` (subir/bajar), `MaquinasCard.tsx` y `SesionesCard.tsx` (id completo) |
| `kpi-chart` | `dashboard/components/CosteDiarioChart.tsx` (`PulsoDelPeriodo`, `/dashboard`) |
| `model-usage` | `dashboard/components/PulsoDelPeriodo.tsx` (`/dashboard`) |
| `data-table` | `MaquinasCard.tsx`, `SesionesCard.tsx`, `ShadowOpportunitiesCard.tsx` (`/dashboard`) |
| `usage-meter` | `dashboard/components/MaquinasCard.tsx` (asientos en uso / pagados) |
| `toaster` | `dashboard/components/PanelEditable.tsx` (aviso con «Deshacer» al ocultar, mostrar o restablecer) |
| `badge` | `MaquinasCard.tsx` (estado de versión), `RitmoCard.tsx`, `ShadowOpportunitiesCard.tsx` |

**Retiradas en esa auditoría** (solo las montaba el muestrario `/kit`): Empty
State (Clean), Skeleton (Clean) y Segmented Control (Clean). Sus equivalentes
de la fundación (`<EmptyState>`, `<Skeleton>`, el selector de rango hecho de
enlaces) ya cubrían el caso y cambiarlos habría movido pantallas aprobadas sin
ganar nada. Si vuelven a hacer falta, se vendorizan de nuevo desde el commit de
arriba.

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

- **code-block-clean** — **REDUCIDO AL MOTOR.** Upstream es un componente de
  cliente con su marco, su cabecera y su botón de copiar. Todo eso ya lo pone
  el `CodeFrame` de la fundación (con su «Copiado» visible, la salida esperada
  y las pestañas de sistema), así que aquí queda lo que `CodeFrame` no tenía:
  el coloreador (TypeScript/JavaScript, JSON, Bash y Python; lo demás, texto
  llano) y la línea resaltada. Se exportan `CodeLines` (un `<code>` con una
  `ui-codec__line` por línea y los `ui-codec__t-*` de upstream; el salto de
  línea vive DENTRO de cada línea, así que el texto seleccionado y el
  `textContent` son el código exacto) y `colorize`. Sin `"use client"`, sin
  estado ni efectos: se renderiza en servidor y no envía JavaScript. Fuera:
  `CodeBlock`, el botón de copiar y `copyText`, la detección de scroll
  (`ResizeObserver`), `maxHeight`, `wrap`, los números de línea propios (los
  pone `CodeFrame`, `lineas`) y los nombres de lenguaje en inglés de la
  cabecera. Paleta a tokens: palabra clave `--brand`, cadena `--good-ink`,
  número y literal `--warn`, comentario `#7A7F8C`, función/variable `#0052B8`;
  línea marcada con `--brand`. Lo usa `/migrate-to-0.5` (los ejemplos largos).
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
- **progress-tracker-clean** — **BIFURCADO A SOLO LECTURA Y CONTROLADO.**
  Upstream deja marcar pasos (`role="checkbox"`, `toggle`), guarda el estado en
  local y puede auto-reproducirse (`autoPlay`, `interval`, `onChange`). Aquí un
  paso está hecho solo porque el producto lo midió: fuera el estado, los
  efectos, el temporizador y `"use client"` (se renderiza en servidor). Cada
  paso lleva `status` (`done | current | pending | unavailable`) y
  `statusLabel` (el estado con palabras, nunca solo color); una fila con `href`
  es un enlace a su instrucción (`linkAs` para un `Link` con idioma) y pulsarla
  no acredita nada. La lista pasa de `<ul>` a `<ol>`, con `aria-current="step"`
  en el siguiente. La barra deja de ser `progressbar` (repetía en inglés la
  cuenta que ya está escrita): `countLabel` llega localizado. Nuevas props
  `layout="steps"` (los mismos pasos en horizontal desde 640px de contenedor),
  `dense`, `bare`, `headingAs`, `footer`. Las etiquetas PARTEN en vez de
  truncarse; fuera el tachado, el brillo de la barra y las entradas animadas.
- **kpi-board** (Pro) — **solo la composición, estática y de servidor.**
  Upstream es dueño del rango, agrega sus series, trata lo no numérico como
  cero, compara con el periodo anterior, pinta un gráfico general y rueda cada
  cifra. Nada de eso queda: se exportan `KpiBoard`, `KpiStat` y `KpiFocus`; las
  cifras llegan ya formateadas con su unidad y su base en palabras; una cifra
  sin dato se dice con `empty` (nunca un cero); no hay «vs. periodo anterior»,
  ni selector, ni tooltip, ni animación. La línea fina opcional (`series`) son
  valores diarios reales, decorativa (`aria-hidden`), y un hueco (`null`) corta
  la línea en vez de bajarla a cero. Rejilla de 12 columnas con consultas de
  contenedor (4 → 2 → 1).
- **compact-breakdown** (Pro) — **estático y de servidor.** Fuera el `tween` de
  cifras, el selector de periodo, la píldora `delta` (era una variación frente
  al periodo anterior, no una tasa de ahorro), el resalte al pasar y el pie
  «Largest». Cada parte trae `value` (dimensiona la barra) y `display` (el
  texto ya formateado) y un `color` que decide quien llama, para que sea
  estable por parte. `total` y `totalLabel` llegan formateados; `aside` (una
  insignia de evidencia) y `footer` (la nota de cobertura, que parte línea) son
  huecos. Las etiquetas largas parten; la cuota conserva el «<1%» / «>99%» de
  upstream.
- **experiment-readout** (Pro, derivado de Experiment Card) — la misma
  composición (bandeja, tarjeta, etiqueta de estado, una fila por variante con
  su insignia y su barra) **sin ninguna interacción**: siempre abierta, nada
  depende del hover, no se elige ganador y ninguna cifra rueda. Es un
  componente de servidor (sin `"use client"`). La bandeja de «elige un ganador»
  pasa a ser la lectura estadística (`facts`: muestra, intervalo, periodo,
  cobertura) con un hueco `action` para «Ver metodología». Nuevos huecos
  `badge` (insignia de evidencia), `figure`/`caption` (el titular y qué es) y
  `children` (la banda del intervalo). No calcula `lift` ni confianza: cada
  cadena, cifra y longitud de barra llega ya formateada por props. Colores a
  tokens (`--good-ink`, `--warn`, `--danger`, `--brand`), sin transiciones.
  La usa `/dashboard/your-bench` (A = copia sin optimizar, B = con Savings).
- **integration-beam** — es un **fork**, no una adaptación: cambia la topología.
  Upstream pinta tres herramientas a cada lado de un producto y mide sus
  posiciones en el navegador; aquí el dibujo es el camino de UNA petición
  (dos emisores → centro → salida) con un nodo **aparte** unido por una línea
  discontinua y rotulada. Componente de servidor, sin script: los hilos los
  coloca la rejilla CSS (`preserveAspectRatio="none"` +
  `vector-effect: non-scaling-stroke`) y el pulso es una animación CSS de
  `stroke-dashoffset`. Props nuevas y obligatorias: `inputs` (dos), `center`,
  `output`, `aside` (con `link`, el rótulo de la línea), `caption` y `label`
  (descripción completa para lectores de pantalla; la escena es un
  `role="img"`). **Retirado**: el contador de conexiones, pausar/reconectar al
  pulsar una loseta, los tooltips (cada nodo lleva su rótulo visible), el
  halo de llegada por Web Animations y los logotipos de marcas de la demo
  (los iconos son cinco glifos propios: `app`, `agent`, `layer`, `provider`,
  `cloud`). Recorrido activo en `--brand`; la línea aparte, gris y sin pulso.
  Vertical por debajo de 680px de contenedor; con movimiento reducido las
  líneas quedan quietas y la punta de flecha conserva el sentido.
- **layer-stack** — **sin reproducción automática**: upstream recorría las
  entradas solo hasta la primera interacción; aquí nada se mueve hasta que el
  lector elige. `items` y `label` pasan a ser obligatorias (sin las cinco
  entradas de demostración ni el `aria-label="Layers"`), y cada entrada lleva
  `facts` (`{ label, value }[]`), que se pintan en un `role="tabpanel"` propio
  enlazado con `aria-controls`; todos los paneles están en el documento y solo
  el elegido se muestra. Teclado: flechas, Inicio y Fin. El marco 3:2 con texto
  en `cqw` se sustituye por una rejilla de dos columnas con texto en `rem` que
  parte línea (doce idiomas, zoom al 200 %); la pastilla deslizante pasa a ser
  el fondo de la fila elegida. Colores a `--brand`/`--brand-soft`/`--surface-2`.
- **kpi-board** (añadido E1) — `KpiStat.label` pasa de `string` a nodo, para que
  el rótulo pueda ser un término con su definición (`Termino` + Tooltip).
- **tooltip** (Pro; E1) — se conserva casi entero (capa superior con
  `popover="manual"`, volteo, ventana de «vecinos sin espera», Escape). Nuevo
  `kind="definition"` (más ancho, peso normal: la definición de un término) y
  `tapToggles` (un toque abre y otro cierra, y tocar fuera cierra): upstream
  nunca abre con el dedo, y una definición tiene que poder leerse en móvil.
  Fondo a tinta de BiVelio y borde en `forced-colors`.
- **profile-menu** (Pro; E1) — upstream es la tarjeta suelta, con botones que
  llaman a `onSelect`, entradas de demo («Docs», «Apps · New») y una fila
  «Profile setup» en inglés. Aquí es un **botón de menú real**: disparador
  (inicial, correo y chevron, `aria-haspopup="menu"`), tarjeta que se abre bajo
  él, foco con flechas/Inicio/Fin, Escape devuelve el foco, Tab y clic fuera
  cierran. Cada fila es un **enlace** (`linkAs` para el `Link` con idioma) con
  una lectura opcional a la derecha; la última es un `<form method="post">`
  (salir nunca es un GET). `tags` (rol y plan) bajo el correo; `setup` es la
  puesta en marcha medida, con su cuenta escrita (la barra es `aria-hidden`) y
  el siguiente hito como enlace. El avatar se queda en la inicial (la pieza
  Avatar reducida a su respaldo). Sin cadenas por defecto; las etiquetas parten
  línea; filas de 36px (44 con puntero grueso).
- **kpi-chart** (Pro; E1) — **fork.** Un valor que falta es `null` y **se queda
  en hueco** (upstream ya cortaba la línea; aquí además el tooltip lo dice con
  `gapText` y nunca pinta «0»). Fuera el `delta` frente al periodo anterior y
  el formateador por defecto en inglés. Nuevo: serie `dashed`, serie
  `tooltipOnly` (una fila del tooltip que no se dibuja: el ahorro del día),
  `band` (el área entre dos series, por tramos donde ambas tienen dato),
  leyenda escrita, hueco `aside` (insignia de evidencia), `plotLabel` /
  `emptyText` obligatorios, Inicio/Fin con teclado, y el tooltip no se cierra
  al levantar el dedo. Sin `max-width`; alto del trazo por `--ui-kpic-h`.
- **model-usage** (Pro; E1) — **fork.** Fuera los datos de demo, el cambio
  frente al periodo anterior, el desglose por tareas, el rodillo de cifras y
  los rótulos del eje. Cada cifra llega **ya formateada por medida**
  (`display`) junto al número que dimensiona la barra (`values`); el componente
  solo calcula la cuota de un modelo dentro de la barra de su empresa. El
  detalle de la empresa se abre al posarse, al enfocar o al tocar la barra
  (son botones) y vive sobre el gráfico, dentro de la tarjeta. `barLabel` es
  una plantilla (`{company}`, `{value}`), no una función: los datos vienen de
  un componente de servidor. Hueco `aside` y pie `footer` (la nota de
  cobertura). Selector de medida con objetivos de 44px en táctil.
- **data-table** (Pro; E1) — **BIFURCADO A SOLO LECTURA.** Upstream es una hoja
  de cálculo pequeña: seleccionar celdas y rangos, editar, pegar desde Excel,
  deshacer, casillas, añadir filas, selector de etiquetas. Nada de eso queda:
  las filas son hechos medidos. Se conserva el aspecto (filas con filete,
  cabecera gris de 12px) y **una** interacción: ordenar por columna
  (ascendente → descendente → como llegó), anunciada con `aria-sort`. Las
  celdas llegan formateadas y `sort` es el valor crudo; un `null` va siempre al
  final. `summary` es una fila de pie que no entra en la ordenación (el
  agregado de CI). Sin tarjeta propia (vive dentro de la del panel); el scroll
  lateral es de la tabla (`role="region"`, enfocable), nunca de la página.
- **usage-meter** (Pro; E1) — **BIFURCADO A UNA LECTURA: ASIENTOS** en uso
  frente a pagados. Fuera el medidor de créditos por categorías, el selector de
  periodo, la serie diaria, los límites del plan y el botón de ampliar: Savings
  no tiene créditos ni cuota de peticiones. Queda la cifra, su cuota y la barra
  (una casilla por asiento hasta 40). Componente de servidor, sin estado ni
  animación; el estado (`ok`/`warn`/`limit`) lo decide quien llama y se dice
  también con palabras.
- **toaster** (Pro; E1) — **REDUCIDO.** Una esquina, una columna (sin el
  abanico de tarjetas detrás), sin deslizar, sin `promise`/`loading`. Queda la
  tarjeta blanca, el icono de estado, **una** acción («Deshacer»), cerrar y un
  temporizador que se detiene con el puntero o el foco encima (es la animación
  CSS del filete; con movimiento reducido, un `setTimeout`). La lista es una
  región `aria-live="polite"`. `id` reemplaza el aviso en pantalla en vez de
  apilar. Las etiquetas de la región y de cerrar son props de `<Toaster />`.
- **badge** (Pro; E1) — componente de servidor: tonos, punto inicial, variante
  `outline` y `caps` (lectura en mono y mayúsculas para tipos de evidencia).
  Fuera el punto «en vivo» que late, el contador y el botón de quitar. La
  etiqueta parte línea en vez de recortarse.

**Las tres piezas de «Savings Layer, en acción»** (`app/components/landing/CapaEnAccion.tsx`)

Las tres comparten el mismo trato: son **componentes de servidor sin script**
(fuera `"use client"`, estado, efectos, `ResizeObserver`, Web Animations y
SMIL), **están quietas** y exponen sus partes con clases `ui-*`; el único bucle
que las mueve vive en `app/globals.css` (SLOT CAPA EN ACCION), solo con
`transform` y `opacity`, y se puede pausar. Ninguna trae texto, cifras ni datos
de demostración.

- **fallback-chain** (Pro) — **SE CONSERVA LA GRAMÁTICA, SE RETIRA EL
  FALLBACK.** Upstream cuenta una petición que prueba un modelo tras otro hasta
  que uno responde. Savings NO hace eso: envía al proveedor que configures y a
  ningún otro. Por eso se exportan solo dos partes:
  `ChainLinks` (las ramas de la petición a cada modelo, en curva o en árbol,
  con geometría fija `curve`/`branch` de upstream) y `ChainModel` (la tarjeta
  de un modelo: marca, nombre, una línea de estado y huecos `control`/`end`
  para que sea la `label` de un radio nativo).
  **Retirado**: los estados `failed` y `skipped` y su línea roja discontinua
  («rate limited», «timed out», «down»), el orden de intentos y su número en la
  esquina, «Up next», «Attempt N of M», «No model answered», `Retry`, los
  bloques que se llenan hacia el `timeout`, los cronómetros (`secs`), los
  costes (`usd`), los totales en marcha y su brillo, el nodo de respuesta, las
  tarjetas flotantes (`Pop`: tokens, precio, región, prompt) y las iniciales.
  **Conservado**: rama punteada = alternativa, rama continua = la ruta en uso
  (`--ui-fbk-on: 1` en la rama, lo decide quien la usa), la luz que recorre la
  rama en uso (ida) y la misma luz en verde de vuelta, y el anillo verde de
  «answered» en la tarjeta (más el de «trying» mientras llega). La insignia de
  la esquina ya no es un número de orden: es la marca de una respuesta.
  La luz deja de ser un `<animateTransform>` SMIL sobre el degradado y pasa a
  ser una banda con el mismo degradado tras una máscara con la forma de la
  rama, movida con `transform` (variables `--ui-fbk-fx/fy/tx/ty`). Los nombres
  parten línea en vez de truncarse.
- **memory-graph** (Pro) — **el dibujo y sus tres gestos, sin palabras.**
  Un único SVG de geometría fija (300×104) que escala entero: el que recuerda
  en el centro con la marca de píxeles de upstream (`pattern`, onda `WAVE`),
  hasta tres recuerdos por lado, los conectores de codo redondeado (`elbowX`)
  con un anillo en cada extremo. Cada sitio es `memory`, `recalled` o
  `learned`. Gestos conservados: **recordar** (la luz sale hacia la tarjeta,
  que se enciende, y su línea queda encendida), **aprender** (la luz sale hacia
  un hueco y la tarjeta nueva sube allí) y el **Gradient Floor** que cruza la
  tarjeta desde el borde por el que entró la luz.
  **Retirado**: el texto de cada recuerdo, el artefacto y los logotipos de
  ficheros (`LOGOS`, Word/Excel/PDF…), fechas, `uses`/`calls`, «N memories · N
  tools», las herramientas, el panel de detalle, `Forget`, `Add`/soltar
  ficheros, los interruptores, «+N more», los enlaces punteados entre
  recuerdos, `outdated`/`replaces`, la maquetación que mide el contenedor y
  todo el teclado (la figura es decorativa: `aria-hidden`). Una tarjeta es
  solo la silueta de una petición: no hay nada que inventar. El Floor ya no
  deforma su silueta con `requestAnimationFrame` ni usa desenfoque: es un
  degradado suave recortado a la tarjeta. La luz pasa de ocho trazos con
  `stroke-dashoffset` a una banda tras una máscara (`--ui-mg-fx/tx`).
- **integration-flow** (Pro) — **el lenguaje de movimiento, no la escena.**
  Upstream es una escena cerrada de 2400×1490 (píldoras de integraciones
  girando por un arco hacia un hub «Data Analysis · Centralized Data
  Processing»). Nada de eso queda —ni las píldoras, ni el arco, ni el hub, ni
  los logotipos de Slack/Okta/Snowflake, ni la etiqueta en inglés, ni el
  escalado por script, ni la idea de «procesado centralizado»—. Se exportan
  tres partes: `FlowLink` (el enlace recto entre dos tarjetas con su haz:
  núcleo + resplandor, recortado en los extremos; aquí con el enlace dibujado y
  un segundo haz de vuelta, en verde), `FlowCharge` (la tarjeta que «se carga»
  antes de disparar o al llegar el haz, por el lado que se indique) y
  `FlowBlobs` (las manchas que derivan y respiran, en azul de marca y un toque
  de menta, sobre fondo claro). El resplandor del haz usa un desenfoque fijo
  (upstream anima el radio, que no corre en el compositor). Se conservan los
  tiempos del barrido (aparece al 18 %, se apaga desde el 72 %, curva
  `cubic-bezier(.55,.06,.25,1)`) y `ui-if-drift`/`ui-if-breathe`.

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
