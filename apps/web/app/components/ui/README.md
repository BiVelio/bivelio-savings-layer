# Fundación visual de BiVelio Savings

Lo que necesitas para construir encima sin tocar la base: tokens, papeles
tipográficos, primitivas con sus props, la regla de los slots y la del código
vendorizado. Fuentes: `GUIA-MAESTRA-FABLE-BIVELIO-SAVINGS.md` (§4, §6, §11,
§12) y `AFFECTUI-PARA-BIVELIO-SAVINGS.md` (§4, §6, §9).

- CSS: `app/globals.css` — tokens en `:root`, primitivas en la sección
  **FUNDACIÓN** (cerca del final), tu CSS en **tu slot** (al final).
- React: este directorio. `import { Recibo, CodeFrame, … } from "@/app/components/ui"`.
- Muestrario: `pnpm dev` y abre `/es/kit` (solo existe en desarrollo).

## Reglas que rompen tests si se ignoran

1. **Toda clase literal** en un `className` de `app/**/*.tsx` tiene que existir
   como `.nombre` en `app/globals.css`. No hay Tailwind ni CSS Modules.
2. **No pases prettier ni stylelint por `globals.css`.** Varios tests lo leen
   como texto (reglas en una línea, sangría, selectores a principio de línea).
3. **No renombres tokens**: los estilos en línea de los TSX los citan. Cambia
   valores o añade alias.
4. **Solo tema claro.** No añadas `.dark`, `data-theme` ni `prefers-color-scheme`.
5. El chrome compartido (NavBar, NavLinks, Footer, layout) **no lee cookies,
   cabeceras ni sesión** en servidor.
6. Texto nuevo: la misma clave en los **12** `messages/*.json`, con traducción
   real, mismos tags e ICU, sin símbolos de moneda, usada con `t("literal")`.

## La regla de los slots

Al final de `globals.css` hay cinco secciones vacías, en este orden:

```
/* ==== SLOT F1 LANDING Y PRICING ==== */            /* ==== FIN SLOT F1 ==== */
/* ==== SLOT F2 ACCESO Y DOCUMENTOS ==== */          /* ==== FIN SLOT F2 ==== */
/* ==== SLOT F3 DASHBOARD NUCLEO ==== */             /* ==== FIN SLOT F3 ==== */
/* ==== SLOT F4 DASHBOARD CUENTA Y EVIDENCIA ==== */ /* ==== FIN SLOT F4 ==== */
/* ==== SLOT F5 EVIDENCIA PUBLICA ==== */            /* ==== FIN SLOT F5 ==== */
```

Cada frente escribe **solo entre sus dos marcas**. No edites la FUNDACIÓN ni el
slot de otro: así las fusiones de git no chocan. Tu slot va después de todo lo
demás, de modo que a igual especificidad ganas tú. Si necesitas que cambie una
primitiva o un token, pídelo a la fundación en vez de sobrescribirlo.

## Tokens

### Color

| Token | Valor | Uso |
|---|---|---|
| `--bg` | `#FAFAF7` | Fondo de página: marfil editorial |
| `--surface` | `#FFFFFF` | Tarjetas, paneles, campos |
| `--surface-2` | `#F2F1EC` | Banda alterna, bandejas, cabeceras |
| `--surface-3` | `#F6F5F1` | Hover neutro, cabecera de tabla y de código |
| `--ink` | `#0F1218` | Texto principal y CTA |
| `--ink-soft` (`--muted`) | `#5A6070` | Texto secundario (6:1 sobre marfil) |
| `--line` | `#E6E4DE` | Divisor fino; se lee sobre marfil y sobre blanco |
| `--line-strong` | `#CFCCC3` | Borde de control, guías punteadas |
| `--brand` (`--accent`) | `#0066E6` | Enlaces, foco, activo, marcas de dato. **No** es el color del CTA |
| `--brand-soft` (`--accent-soft`) | `#E8F1FF` | Fondo de estado activo, selección |
| `--btn-ink` / `--btn-ink-hover` | `#0F1218` / `#1E2430` | Botón primario |
| `--mint` (`--good`) | `#14A06F` | **Rellenos**: puntos, barras. Nunca texto |
| `--good-ink` / `--mint-soft` | `#1F5B43` / `#E3F1EA` | Correcto: texto / fondo |
| `--warn` / `--amber-soft` | `#8A5708` / `#FBF1DE` | Atención: texto / fondo |
| `--danger` (`--bad`) / `--bad-soft` | `#C73A3A` / mezcla al 9 % | Error: texto / fondo |
| `--navy` | `#020852` | Solo las letras de «BiVelio» dentro de una frase |

Sombras: `--shadow-card` (reposo), `--shadow-hover` (interactivo),
`--shadow-elevated` (panel protagonista), `--shadow-pop` (menús).

### Radios

| Alias | Valor | Uso |
|---|---|---|
| `--r-control` | 10px | Botones, campos, pestañas |
| `--r-card` | 14px | Tarjeta de datos, tabla, código |
| `--r-card-lg` | 18px | Tarjeta editorial, plan |
| `--r-hero` | 22px | Panel protagonista |
| `--r-sheet` | 36px (26px ≤900px) | Hoja héroe → cuerpo (`.sheet`) |

`--radius`, `--radius-md` y `--navy` están fijados por tests: no los toques.

### Espaciado y contenedores

- Editorial: `--space-1…5` = 8 / 16 / 24 / 32 / 48. Separación generosa entre
  secciones (`--section-y`: 104px en escritorio, 56px en móvil), compacta
  dentro de datos.
- Panel: `--sp-1…8` = 4 / 6 / 8 / 12 / 16 / 20 / 28 / 40.
- `--page-max` 1200px con 24px laterales; `--nav-h` 56px; `--nav-max` 1280px.

### Movimiento

| Token | Valor |
|---|---|
| `--ease-out` | `cubic-bezier(.16, 1, .3, 1)` |
| `--ease-in-out` | `cubic-bezier(.65, 0, .35, 1)` |
| `--dur-1` / `--dur-2` / `--dur-3` / `--dur-4` | 150 / 200 / 250 / 400 ms |

Utilidades: `.anim-rise`, `.anim-fade`, `.anim-pop` (retardo con
`style={{ "--delay": "120ms" }}`) y `.stagger` (los hijos directos entran
escalonados, 60 ms). El revelado al hacer scroll de la landing sigue siendo
`RevealObserver` + clase `rv` dentro de `.lp`.

Reglas:

- Transiciones de 150–250 ms; entradas de hasta 400 ms.
- **Una sola animación ambiental por viewport.**
- **Una cifra nunca se anima como si se estuviera midiendo en vivo.** Nada de
  contar desde cero al entrar; `NumberTicker` solo rueda cuando el valor cambia
  porque el usuario cambió algo (un rango, una métrica).
- Todo lo que anima va bajo `@media (prefers-reduced-motion: no-preference)`.
  Sin animación, la página conserva jerarquía y significado.

### affectUI

`--aui-font`, `--aui-font-mono`, `--aui-surface`, `--aui-ink`, `--aui-muted`,
`--aui-border`, `--aui-primary` (tinta), `--aui-focus` (azul) y compañía están
definidos en `:root`: una pieza vendorizada hereda BiVelio sin más.

## Papeles tipográficos

| Papel | Familia | Cómo se pide |
|---|---|---|
| Interfaz, cuerpo, navegación | Geist | por defecto (`--font-sans`) |
| Títulos del panel, tarjetas, auth | Geist 600 | `h1–h3` por defecto, `.t-page`, `.t-section` |
| Titular editorial (landing, precios, explicación) | Plus Jakarta Sans 800, `-.04em` | `.lp h1`, `.lp h2`, o `.editorial-title` (+ `--xl`, `--lg`, `--sm`) |
| Énfasis breve dentro de un titular | Instrument Serif cursiva | `.serif-accent` (+ `--brand`) |
| Código, IDs, hashes, cifras del recibo | Geist Mono | `--font-mono`, `.mono` |
| Cifras en columna | — | `.tnum` (`tabular-nums`); `.tbl` ya lo trae |
| Antetítulo | Geist 12/600 versalitas + filete azul | `.kicker` (o `.eyebrow` dentro de `.lp`) |
| Entradilla | Geist 16–18 | `.lede-text` |

- **No impongas la tipografía editorial a las tablas ni al panel.**
- `.serif-accent` es para dos o tres palabras. **Nunca** cifras, precios,
  porcentajes ni controles.
- Estos subconjuntos de Geist traen `liga`, `tnum` y `pnum`; **no** traen
  `cv11` ni `ss01`, así que no se piden.

## Primitivas

### Botones (CSS)

`.btn` es tinta dentro de `.lp`; fuera, añade `.btn-primary`.

| Clase | Qué es |
|---|---|
| `.btn` + `.btn-primary` | CTA tinta. 40px de alto (44px con puntero grueso), radio 10px |
| `.btn.ghost` / `.btn-ghost` | Secundario: blanco con línea fina |
| `.btn-quiet` | Terciario: solo texto hasta el hover |
| `.btn-brand` | Azul. **Uso raro**: nunca dos azules en una vista |
| `.btn-lg` / `.btn-sm` / `.btn-block` | Tamaños y ancho completo |

```tsx
<Link className="btn btn-lg" href="/signup">{t("hero.ctaStart")}</Link>
<Link className="btn btn-lg ghost" href="/benchmarks">{t("hero.ctaBench")}</Link>
```

### Insignias (CSS)

`.tag` (azul suave), `.pill` + `.live` / `.mock` / `.await` (con
`<span className="dot" />` opcional), `.est-tag`, `.app-plan`. Dentro de `.app`
usan radio 6px; fuera, píldora.

### `<EvidenceBadge>` — de dónde sale una cifra

```ts
tipo: "ab-sdk" | "replay-gateway" | "tus-datos" | "benchmark" | "sintetico" | "estimacion" | "sombra"
label: string          // ya traducido
pequeno?: boolean      // 18px, para tablas
title?: string
className?: string
```

```tsx
const t = await getTranslations("ui");
<EvidenceBadge tipo="ab-sdk" label={t("evidence.abSdk")} />
```

Etiquetas listas en `ui.evidence.*` (`abSdk`, `replayGateway`, `tusDatos`,
`benchmark`, `sintetico`, `estimacion`, `sombra`); `CLAVE_DE_EVIDENCIA` mapea
tipo → clave. **Va junto a cada cifra de ahorro.** Un replay del gateway y un
A/B del SDK son cosas distintas: insignias distintas, tarjetas distintas.

### `<Recibo>` — el recibo verificable de una llamada

La pieza propia de Savings. Se repite en héroe, evidencia, instalación y panel.

```ts
titulo: string
meta?: ReactNode                       // modelo · periodo · base de medición
filas: { etiqueta: string; valor: ReactNode; tono?: "neutro" | "ahorro" | "coste" | "atenuado"; mono?: boolean }[]
total?: { etiqueta: string; valor: ReactNode; tono?: … }
evidencia?: { tipo: TipoDeEvidencia; label: string }
procedencia?: { texto: ReactNode; href?: string; enlace?: string }
ilustrativo?: string                   // texto de la franja permanente
compacto?: boolean
ancho?: boolean                        // sin el máximo de 420px
className?: string
```

```tsx
<Recibo
  titulo={t("recibo.titulo")}
  meta={`${modelo} · ${periodo}`}
  filas={[
    { etiqueta: t("recibo.referencia"), valor: fmt(referencia) },
    { etiqueta: t("recibo.observado"), valor: fmt(observado), tono: "coste" },
  ]}
  total={{ etiqueta: t("recibo.ahorro"), valor: fmt(ahorro), tono: "ahorro" }}
  evidencia={{ tipo: "ab-sdk", label: tUi("evidence.abSdk") }}
  procedencia={{ texto: t("recibo.base"), href: "/benchmarks", enlace: tUi("recibo.comoSeMidio") }}
/>
```

- Las cifras llegan **ya formateadas** (moneda, periodo y base, con el locale
  explícito). El componente no calcula.
- Cifras no medidas ⇒ `ilustrativo={tUi("recibo.ilustrativo")}` **siempre**.
- Un dato que falta es `"—"`, nunca `0`.
- `mono: false` para valores de texto (un modelo, un periodo).
- Es un `<figure>` con `<dl>`: se lee sin color.

### `<CodeFrame>` — marco de código

```ts
children: ReactNode                    // se pinta TAL CUAL
etiqueta?: string                      // nombre de fichero o «Terminal»
pestanas?: ReactNode                   // p. ej. el selector de sistema operativo
copiar?: { texto: string; etiqueta: string; etiquetaCopiado: string }
salida?: { etiqueta: string; contenido: ReactNode }   // resultado esperado
lineas?: number                        // numera N líneas (solo ejemplos largos)
ajustar?: boolean                      // partir líneas en vez de scroll
ariaLabel?: string
className?: string
```

```tsx
<CodeFrame
  etiqueta="Terminal"
  copiar={{ texto: "bvsala claude", etiqueta: tUi("copy"), etiquetaCopiado: tUi("copied") }}
  salida={{ etiqueta: tUi("code.expected"), contenido: t("install.expected") }}
>
  <span className="k">bvsala</span> claude
</CodeFrame>
```

- **No reescribas el marcado interior**: los tests fijan
  `<span className="k">bvsala</span> {cmd}`. Clases de token: `.k` `.n` `.s`
  `.c` `.g`.
- El scroll horizontal queda dentro del bloque; la página no se ensancha.
- **No es el contenedor de una credencial.** Una service key real conserva su
  control propio de copia y visibilidad única.
- `.code2`, `.copybtn` y `.lp .code` ya tienen este mismo acabado; dentro de un
  `CodeFrame` pierden su caja.
- ¿Coloreado automático y línea resaltada en un ejemplo LARGO? Mete dentro
  `<pre><CodeLines code={…} language="ts" /></pre>`, de
  `@/vendor/affectui/code-block-clean` (de servidor, sin script). Lo usa la
  guía de migración. No lo uses donde un test fija el marcado interior.

### `<EmptyState>`

```ts
titulo: string; texto?: ReactNode; icono?: ReactNode; acciones?: ReactNode
como?: "h2" | "h3" | "h4" | "p"; compacto?: boolean; sinCaja?: boolean; alInicio?: boolean
```

```tsx
<EmptyState icono={<ProofIcon />} titulo={t("empty.title")} texto={t("empty.body")}
  acciones={<Link className="btn btn-primary" href="/dashboard/install">{t("empty.cta")}</Link>} />
```

### `<Notice>`

```ts
tono?: "info" | "ok" | "warn" | "danger"; titulo?: string; children?: ReactNode
acciones?: ReactNode; role?: "status" | "alert" | "note"
```

`role` por defecto: `alert` en `danger`, `note` en `warn`, `status` en el resto.
Usa `alert` solo para lo que bloquea lo que el usuario estaba haciendo.

```tsx
<Notice tono="warn" titulo={t("billing.pastDue.title")}>{t("billing.pastDue.body")}</Notice>
```

### `<Skeleton>`, `<SkeletonText>`, `<SkeletonGroup>`

```ts
Skeleton:      ancho?: number | string; alto?: number | string; radio?: number | string; linea?: boolean; circulo?: boolean
SkeletonText:  lineas?: number
SkeletonGroup: label: string            // role="status" + aria-busy
```

Reserva el mismo hueco que el contenido real. `.sk` (heredado) sigue valiendo.

### `<PageHeader>` — cabecera de página de marketing

```ts
eyebrow?: string; titulo: ReactNode; acento?: string; marca?: string; acentoEnLinea?: boolean
lede?: ReactNode; acciones?: ReactNode; centrado?: boolean
tamano?: "lg" | "xl"; como?: "h1" | "h2"; id?: string
```

```tsx
<PageHeader eyebrow={t("eyebrow")} titulo={t("title")} acento={t("titleAccent")}
  lede={t("lede")} acciones={<Link className="btn btn-lg" href="/signup">{t("cta")}</Link>} />
```

`marca` (opcional) es la firma de campaña: la parte del `acento` que lleva el
marcador cian (`<Marcado>`, clase `.mk`). Cadena vacía marca la última palabra;
sin la prop no hay marcador. Con marcador, el acento va en tinta. En el héroe de
una página pública va junto a `acentoEnLinea`, dentro de `<HeroeDeCampana>`
(`app/components/campana/`), que pone el cielo cian y el mosaico de llamadas:

```tsx
<HeroeDeCampana pagina="howItWorks">
  <PageHeader titulo={t("title")} acento={t("titleAccent")} marca={t("titleMark")} acentoEnLinea … />
</HeroeDeCampana>
```

Una página, un `h1`. En el panel la cabecera sigue siendo `PageHead`.

### `<SectionHead>`

```ts
eyebrow?: string; titulo: ReactNode; acento?: string; marca?: string; lede?: ReactNode
lateral?: ReactNode; centrado?: boolean; pequeno?: boolean; como?: "h2" | "h3"; id?: string
```

### Superficies y tablas (CSS)

| Clase | Qué es |
|---|---|
| `.card` | Blanca, línea fina, radio 18px, sombra discreta. **Sin** elevación al pasar |
| `a.card`, `button.card`, `.card-link` | Tarjeta interactiva: sí se eleva |
| `.card--flat`, `.card--compact` | Sin sombra / 16px y radio 14px |
| `.tray` + `.tray-in` | Tarjeta de dos capas de la marca madre (bandeja + hoja) |
| `.panel-hero` | Panel protagonista, radio 22px |
| `.band-alt` | Banda `#F2F1EC` a sangre |
| `.sheet` | Hoja con radio superior de 36px (26px en móvil) |
| `.tbl` | Tabla: cifras tabulares, cabecera en versalitas |
| `.tbl-scroll` | Envoltorio con scroll horizontal |
| `.tbl-scroll--sticky` + `.tbl--sticky` | Alto acotado y cabecera fija |
| `.tbl--static` | Cabecera no ordenable (sin cursor de mano) |

## Chrome público

`NavBar` pinta el mismo menú en todas las páginas públicas: Producto
(`/#offers`), Cómo funciona, Resultados (`/benchmarks`), Precios (`/pricing`,
el documento completo) y Código (GitHub). Menú completo desde 1024px;
hamburguesa por debajo, en todas las páginas. Claves en `nav.*`. El destino
activo se marca con `aria-current="page"`. No lo dupliques en tu página.

`Footer` conserva su orden y sus clases fijadas por tests (`ftr-*`, `nvi-*`).
`sinGitHub` oculta GitHub en el dock y en la columna Savings: no lo cambies.

## Código vendorizado (affectUI)

Vive en `apps/web/vendor/affectui/`, fuera de `app/`. Lee
[`VENDOR.md`](../../../vendor/affectui/VENDOR.md) antes de añadir una pieza.

- Ya están: `code-block-clean` (solo el coloreador, `CodeLines`),
  `number-ticker`, `progress-tracker-clean`, `integration-beam`, `layer-stack`
  (MIT) y `pricing-plans`, `kpi-board`, `compact-breakdown`, `experiment-card`,
  `experiment-readout`, `gradient-text`, `gradient-floor` (Pro), y las del
  panel de cuenta (Pro): `setup-guide`, `usage-meter`, `data-table`,
  `text-field`, `number-input`, `select`, `dropdown-menu`, `dialog`, `toaster`,
  `segmented-control`, `blur-crossfade`, `avatar`, `badge`, `empty-state`,
  `spinner`, `team-invite`, `empty-calendar`. El inventario con su uso está en
  `VENDOR.md`.
- **No se vendoriza lo que no se usa.** Empty State, Skeleton y Segmented
  Control se retiraron en la auditoría de 2026-11: `<EmptyState>`,
  `<Skeleton>` y el selector de rango (enlaces) ya cubrían el caso.
- Cada pieza es un `.tsx` + su `.css` hermano. Se importa con
  `@/vendor/affectui/<pieza>`.
- Los ficheros Pro llevan su aviso en la cabecera y **no** son Apache-2.0.
- Adapta, no pegues: solo tema claro, colores a tokens, tipografías a
  `var(--font-sans)`/`var(--font-mono)`, reduced-motion intacto, sin datos de
  demostración ni textos por defecto.
- Prefiere una primitiva de este directorio si ya cubre el caso.

## Haz / No hagas

**Haz**

- Pon la insignia de evidencia junto a **cada** cifra de ahorro.
- Di «asiento» como lo que es: **una máquina o una identidad de servicio**.
- Distingue siempre moneda, periodo y base de cada métrica.
- Escribe vacío, error y límite con palabras y una acción. Usa `EmptyState` y
  `Notice`.
- Marca con «Ejemplo ilustrativo» permanente cualquier maqueta con cifras que
  no sean medidas.
- Deja que los textos largos partan: los doce idiomas tienen que caber sin
  depender del hover ni de una elipsis.
- Mantén teclado, foco visible (2px azul + 2px de separación), estado con
  texto además de color y objetivos táctiles de 44px.
- Conserva anclas, canonical/hreflang, checkout, auth y permisos.

**No hagas**

- No inventes funcionalidades, porcentajes, testimonios, clientes, logos,
  certificaciones, trials ni pantallas operativas.
- No pintes un vacío, un error o un límite como **cero** ni como un gráfico
  plano. Lo no medido es «—».
- No animes una cifra como si se midiera en vivo. No más de una animación
  ambiental por viewport.
- No uses la serif en cifras ni controles, ni la tipografía editorial en el
  panel.
- No pongas el paisaje de la marca detrás de tablas.
- No uses el azul como color de CTA: el CTA es tinta.
- No añadas tema oscuro, Tailwind, otra hoja de estilos ni otra biblioteca de
  componentes.
- No escribas precios ni símbolos de moneda dentro de las traducciones.
- No toques `lib/billing`, `lib/stripe`, `lib/legal`, rutas API, auth,
  permisos, consultas, derivaciones ni tests en un PR visual.
- No conviertas una página estática en dinámica leyendo sesión en un
  componente compartido.
