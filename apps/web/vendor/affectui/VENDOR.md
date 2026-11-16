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
| Profile Menu | `profile-menu.tsx` + `.css` | **affectUI Pro** | registro Pro, `profile-menu-clean` (descarga del 2026-11-16) | `fb632b336ce6061151d5a329acc04f6b569bdf20bfb8d339fb27d59755a09270` |
| KPI Chart (**fork**) | `kpi-chart.tsx` + `.css` | **affectUI Pro** | registro Pro, `kpi-chart-clean` (descarga del 2026-11-16) | `81a7e5beb60e835413d35d99b08e3a5518fbcfe15a557a8d83a79663ec16000d` |
| Model Usage (**fork**) | `model-usage.tsx` + `.css` | **affectUI Pro** | registro Pro, `model-usage-clean` (descarga del 2026-11-16) | `a550368f7ba505a289e0c30d191f8676de7fbe3820612e3c270e77a238d39217` |
| Avatar | `avatar.tsx` + `.css` | **affectUI Pro** | registro Pro, `avatar-clean` (descarga del 2026-11-16) | `77ff605558de18612fd45e1b91857826698e41fa893f6a70a5afa03485610a46` |
| Dialog (AlertDialog) | `dialog.tsx` + `.css` | **affectUI Pro** | registro Pro, `dialog-clean` (descarga del 2026-11-16) | `3d377b605125ad7287a09f454d315a7d71ec1c8a6afab733316f23ca3bb355a4` |
| Dropdown Menu | `dropdown-menu.tsx` + `.css` | **affectUI Pro** | registro Pro, `dropdown-menu-clean` (descarga del 2026-11-16) | `d6552544746bdde40febc8e0d461f6caf10f54d1661816afad4c09dd08398c04` |
| Select | `select.tsx` + `.css` | **affectUI Pro** | registro Pro, `select-clean` (descarga del 2026-11-16) | `086f8e8b71a40f9b221afdd61c3fe337fe2e1640a0e0e148a260db987e94440d` |
| Number Input | `number-input.tsx` + `.css` + `number-input-read.ts` (lectura y teclas, sacadas del componente) | **affectUI Pro** | registro Pro, `number-input-clean` (descarga del 2026-11-16) | `01c2322723b7fe55420073487f7ccaee55f0435caca31a5da51b294b375c3e27` |
| Segmented Control | `segmented-control.tsx` + `.css` | **affectUI Pro** | registro Pro, `segmented-control-clean` (descarga del 2026-11-16) | `8547e6335fc70ec9aa8e5a89dec96deb95bb46de5894c3c0e2b26e1763abd506` |
| Setup Guide (**solo lectura**) | `setup-guide.tsx` + `.css` | **affectUI Pro** | registro Pro, `setup-guide-clean` (descarga del 2026-11-16) | `4fbb24b69b082ecbd761c5c0dbba8af08376dfd262f5e55717abfcfd58d7a58d` |
| Empty Calendar | `empty-calendar.tsx` + `.css` | **affectUI Pro** | registro Pro, `empty-calendar` (descarga del 2026-11-16) | `e3de6f44d69d5ad484fa588cf202f7ead07a5ba6c4b0b3100d33fdaaa7503ec3` |
| Hover Card (Clean) | `hover-card.tsx` + `.css` | **affectUI Pro** | registro Pro, `hover-card-clean` (descarga del 2026-11-16) | `1bc3812c0a6efa497377d5f254c18b56658a0a44fc6e43c71653af132ca8c470` |
| Toggle Group (Clean) | `toggle-group.tsx` + `.css` | **affectUI Pro** | registro Pro, `toggle-group-clean` (descarga del 2026-11-16) | `4a086d53e0ecf33966e84af16d1b1d2d8388f90a7f64c733132f3e026345a9ad` |
| A/B Branches (**fork** de Outreach Branches) | `ab-branches.tsx` + `.css` | **affectUI Pro** | registro Pro, `outreach-branches` (descarga del 2026-11-16) | `26d6e022b36ba2495d49b90ecaeace2208e86d836d286fb3608496a52c5a2442` |
| Button (Clean) | `button-clean.tsx` + `.css` | **affectUI Pro** | registro Pro, `button` (descarga del 2026-11-16) | `686046d5fbe47b1d2234980c05d4fc56d2ad69ee3a084de8583c82759a7d4acb` |
| Breadcrumb (Clean) — **reducido** | `breadcrumb-clean.tsx` + `.css` | **affectUI Pro** | registro Pro, `breadcrumb` (descarga del 2026-11-16) | `f083bb8936aa1e7e83850a542c873ddf0b0c087dfc9603ea760d6e13b738cd55` |
| Separator (Clean) | `separator-clean.tsx` + `.css` | **affectUI Pro** | registro Pro, `separator` (descarga del 2026-11-16) | `b642c1780fe834682572463cae18112f6ade28ba6d7fbbbb4ff2cf0f960ec381` |
| Scroll Area (Clean) | `scroll-area-clean.tsx` + `.css` | **affectUI Pro** | registro Pro, `scroll-area` (descarga del 2026-11-16) | `95e8c21e9af24234bf807f8d3e98f83f280787de8aa256e1ee81aa492495d59c` |
| Tab Overload | `tab-overload.tsx` + `.css` | **affectUI Pro** | registro Pro, `tab-overload` (descarga del 2026-11-16) | `327924948676db859ee3c72e8cafbdb68f304bace3dc9c423cda803c6460bf3f` |
| Glass Folder | `glass-folder.tsx` + `.css` | **affectUI Pro** | registro Pro, `glass-folder` (descarga del 2026-11-16) | `96edbd88efd40e771822737e0b4f21c0f05cce33e081bc6005be542bbb71d02f` |
| Grid Background | `grid-background.tsx` + `.css` | **affectUI Pro** | registro Pro, `grid-background` (descarga del 2026-11-16) | `c9c7936cffc22cf08f3c786ad2f09509ada9f2901aed0a89ceaa0037f43ae394` |
| Tilt Card | `tilt-card.tsx` + `.css` | **affectUI Pro** | registro Pro, `tilt-card` (descarga del 2026-11-16) | `69c24693d70581fbf169e71eedc4318897302539fb0a0f5cbc46c719d913d7ba` |
| Logo Marquee | `logo-marquee.tsx` + `.css` | **affectUI Pro** | registro Pro, `logo-marquee` (descarga del 2026-11-16) | `65b4862d3fb7bf17134c761aa3b70b0ec39205770bef6e61e5af3fabae369f3a` |
| Badge (Clean) | `badge-clean.tsx` + `.css` | **affectUI Pro** | registro Pro, `badge-clean` (descarga del 2026-11-16) | `d5e6309addea4d8a9d65e4c58abd1075ed85bef43f6e65812e55a9918d3b234f` |
| Tooltip (Clean) | `tooltip-clean.tsx` + `.css` | **affectUI Pro** | registro Pro, `tooltip-clean` (descarga del 2026-11-16) | `248d67efb0b588fb949990c6427fc9d7aea734056eadddca564a3da7269a44f1` |
| Data Table (Clean) — **fork de solo lectura** | `data-table-clean.tsx` + `.css` | **affectUI Pro** | registro Pro, `data-table-clean` (descarga del 2026-11-16) | `7c52ae0dfe600becdd259343d25ce5acb72bb38b18a94ac75a6ec26582f3bd5e` |
| Text Field (Clean) | `text-field-clean.tsx` + `.css` | **affectUI Pro** | registro Pro, `text-field-clean` (descarga del 2026-11-16) | `87a72ec504b23ff046d2b45944415c41f72f8ce99bcf9741918d96f5868717c4` |
| Empty State (Clean) | `empty-state-clean.tsx` + `.css` | **affectUI Pro** | registro Pro, `empty-state-clean` (descarga del 2026-11-16) | `495f16a093feb816c8d1f26f9f4adeecfb95712fbf2ee55f9961432de9fe4d46` |
| Spinner (Clean) | `spinner-clean.tsx` + `.css` | **affectUI Pro** | registro Pro, `spinner-clean` (descarga del 2026-11-16) | `e53e0798e1d6ad45afc1377b0bfcc1421edbafef83ae4d07562f883ab79896c4` |
| Toaster (Clean) — **reducido** | `toaster.tsx` + `.css` | **affectUI Pro** | registro Pro, `toaster-clean` (descarga del 2026-11-16) | `2f83426953e89fdc61936a20e0b16ec046ca598b45d4ee0efaed872f2ffea5ad` |
| Usage Meter (Clean) — **fork: asientos** | `usage-meter.tsx` + `.css` | **affectUI Pro** | registro Pro, `usage-meter-clean` (descarga del 2026-11-16) | `c2a9d72a1a8ee981b4bb53c507fb9011bd23387828f3e8e558c4abaa43e69b29` |
| Team Invite | `team-invite.tsx` + `.css` | **affectUI Pro** | registro Pro, `team-invite` (descarga del 2026-11-16) | `975e8e7f198a43a310dbedf97d81244965232dcc68a0f53f5b90b0c7a5254906` |
| Blur Crossfade | `blur-crossfade.tsx` + `.css` | **affectUI Pro** | registro Pro, `blur-crossfade` (descarga del 2026-11-16) | `2cff559cbf363731894c1a2f97d17c625772102db3f2b9b0776571ba26b58cf2` |

Todas las piezas incorporadas por los frentes E1–E4 y la capa Pro (2026-11-16) salen
del catálogo completo bajado con la licencia Pro. Ese catálogo no distingue cuáles
publica además upstream bajo MIT, así que todas llevan la cabecera Pro, la más
restrictiva de las dos.

**Una pieza, un fichero.** Los cuatro frentes vendorizaron por separado diez piezas
que se solapaban (badge, data-table, tooltip, toaster, usage-meter, text-field,
empty-state, spinner, team-invite, blur-crossfade). La integración del 2026-11-16 las
fundió: cada una vive en UN fichero, con una sola fila aquí, y su lista de cambios
(«Consolidadas», más abajo) reúne lo que aportó cada frente. Antes de vendorizar una
pieza, búscala en este inventario.

## Dónde se usa cada pieza

Auditoría del 2026-11-16: una pieza que nadie importa desde `app/` no se queda.

| Pieza | La importa |
|---|---|
| `pricing-plans` | `app/components/landing/PlanesCloud.tsx` (portada `#pricing` y `/pricing`) |
| `kpi-board` | `dashboard/components/ResumenKpis.tsx` (`/dashboard`) |
| `compact-breakdown` | `dashboard/components/DesgloseModelos.tsx` (`/dashboard`); también `dashboard/components/YourBenchStrata.tsx` (el peso de cada grupo) |
| `progress-tracker-clean` | `dashboard/install/page.tsx`, `app/components/app/SetupProgress.tsx`, `dashboard/components/InstrumentationSpine.tsx` |
| `code-block-clean` | `migrate-to-0.5/page.tsx` (dentro de `CodeFrame`) |
| `integration-beam`, `layer-stack` | `app/components/HowItWorks.tsx` (`/how-it-works` y `/dashboard/how-it-works`) |
| `experiment-card` | `app/components/evidencia/ComparacionAB.tsx` (`/benchmarks`) |
| `experiment-readout` | `dashboard/components/YourBenchHeadline.tsx` (`/dashboard/your-bench`) |
| `gradient-text` | `app/[locale]/page.tsx` (una frase del héroe) |
| `gradient-floor` | `app/components/landing/CierreMeasure.tsx` (cierre de la portada) |
| `number-ticker` | `dashboard/components/VerdictHero.tsx` (la cifra del veredicto, al cambiar de rango) y `dashboard/components/ProjectorVerifier.tsx` (la estimación, al mover un supuesto) |
| `profile-menu` | `app/components/app/CuentaMenu.tsx` (la cuenta de la barra del panel, vía `AppTopbar`) |
| `kpi-chart` | `dashboard/components/CosteDiarioChart.tsx` (`PulsoDelPeriodo`, `/dashboard`) |
| `model-usage` | `dashboard/components/PulsoDelPeriodo.tsx` (`/dashboard`) |
| `setup-guide` | `dashboard/install/page.tsx` (la guía a la vista de Primeros pasos), muestrario `captura-cuenta` |
| `number-input` | `BillingButtons.tsx` (asientos a comprar) |
| `dialog` (`AlertDialog`) | `EquipoPanel.tsx` (quitar, transferir), `ServiceAccountKeySection.tsx` (revocar una clave) |
| `avatar` | `AccountPlanStrip.tsx`, `EquipoPanel.tsx` |
| `toggle-group` | `app/components/evidencia/CentroDeEvidencia.tsx` (filtro de lectura de `/benchmarks`) y `dashboard/components/ProjectorVerifier.tsx` (perfil y nivel) |
| `ab-branches` | `app/components/evidencia/ParAB.tsx`, que pintan `/dashboard/proof`, `/dashboard/your-bench` (apagado y reuniendo) y «cómo leer» de `/benchmarks` |
| `tilt-card` | `app/components/acceso/PanelDeMarca.tsx` (el recibo ilustrativo de login y alta) |
| `breadcrumb-clean` | `app/components/docs/Migas.tsx` (`/pricing`, `/privacy`, `/paper`, `/migrate-to-0.5`) |
| `scroll-area-clean`, `separator-clean` | `app/components/docs/DocIndice.tsx` (el índice de las páginas de lectura); `scroll-area-clean` también dentro de `data-table-clean`; `separator-clean` en la 404 |
| `grid-background` | cabeceras de `/how-it-works`, `/pricing`, `/privacy`, `/paper`, `/migrate-to-0.5` y la 404 |
| `glass-folder` | `/privacy` (cabecera) |
| `logo-marquee` | `/how-it-works` (la cinta de sistemas) |
| `setup-guide` | `dashboard/install/page.tsx` (la guía a la vista de Primeros pasos), muestrario `captura-cuenta` |
| `segmented-control` | `app/components/SnippetPorSistema.tsx` (pestañas macOS·Linux / Windows en Primeros pasos y `/how-it-works`) |
| `select`, `dropdown-menu` | `EquipoPanel.tsx` (perfil, acciones de fila) |
| `empty-calendar` | `ExtractoVista.tsx` (sin tráfico en el periodo) |
| `hover-card` | `app/components/evidencia/Termino.tsx` (`Detalle`), que usa `ReferenceLedgerCards` |
| `button-clean` | `app/components/AuthForm.tsx`, `ResetPasswordForm.tsx`, `invitacion/[token]/AceptarInvitacion.tsx` |
| `scroll-area-clean`, `separator-clean` | `app/components/docs/DocIndice.tsx` (el índice de las páginas de lectura); `scroll-area-clean` también dentro de `data-table-clean` (todas las tablas); `separator-clean` en la 404 |
| `tab-overload` | `app/[locale]/not-found.tsx` |
| `fallback-chain`, `memory-graph`, `integration-flow` | `app/components/landing/CapaEnAccion.tsx` (portada `#data`, «Savings Layer, en acción») |
| `badge-clean` | **Panel:** `MaquinasCard`, `RitmoCard`, `ShadowOpportunitiesCard`, `AccountPlanStrip`, `EquipoPanel`, `ExtractoVista`, `InstallLicensePanel`, `ServiceAccountKeySection`. **Evidencia:** `IntegrityQualityChips`, `ReferenceLedgerCards`, `ScenarioTable`, `YourBenchStrata`. **Público:** `app/components/HowItWorks.tsx` (veredicto de cada caso), `/privacy` (plazos), `/pricing` (modalidad histórica), la invitación (perfil) |
| `tooltip-clean` | `app/components/evidencia/Termino.tsx` (`Termino` y `AyudaDeTermino`: el término con su definición de TODO el sitio — `ResumenKpis`, `ShadowOpportunitiesCard`, `ReferenceLedgerCards`, `ScenarioTable`, `YourBenchHeadline`, `ComparacionAB`), `NavLink.tsx` (la frase de cada cifra del raíl), `PanelEditable.tsx` (subir/bajar), `MaquinasCard.tsx` y `SesionesCard.tsx` (id completo), `text-field-clean` (ver/ocultar la contraseña) |
| `data-table-clean` | **Panel:** `MaquinasCard`, `SesionesCard`, `ShadowOpportunitiesCard` (`/dashboard`); `EquipoPanel` (miembros, invitaciones); `ExtractoVista` (tramos, extractos cerrados). **Evidencia:** `ScenarioTable` (`/dashboard/proof`), `YourBenchStrata` (`/dashboard/your-bench`). **Público:** `/pricing` (tramos de la modalidad histórica), `/paper` y `/migrate-to-0.5` (todas sus tablas) |
| `text-field-clean` | `app/components/acceso/CampoClave.tsx`, `app/components/AuthForm.tsx`, `invitacion/[token]/AceptarInvitacion.tsx`; en el panel, `ServiceAccountKeySection.tsx` (probador de clave) y `EquipoPanel.tsx` (invitación, nombre de la organización) |
| `empty-state-clean` | `app/[locale]/not-found.tsx` (escala de página); `EquipoPanel.tsx` y `ExtractoVista.tsx` (lista vacía, sin extractos) |
| `spinner-clean` | `invitacion/[token]/AceptarInvitacion.tsx`; en el panel, `BillingButtons`, `PortalButton`, `TrialKeyButton`, `MeasureClaimButton`, `ServiceAccountKeySection`, `EquipoPanel` |
| `toaster` | `PanelEditable.tsx` (aviso con «Deshacer» al ocultar, mostrar o restablecer) y `EquipoPanel.tsx` (resultado de invitar, quitar o transferir; un fallo se queda hasta cerrarlo) |
| `usage-meter` | `AccountPlanStrip.tsx` (`/dashboard/account`, tamaño `md` con leyenda) y `MaquinasCard.tsx` (`/dashboard`, tamaño `sm`): la misma lectura, asientos en uso frente a contratados |
| `team-invite` | `EquipoPanel.tsx` (lista de miembros vacía, decorativa) y `invitacion/[token]/AceptarInvitacion.tsx` (con las marcas de la organización y de Savings) |
| `blur-crossfade` | `app/components/SnippetPorSistema.tsx` (al cambiar de sistema) y `app/components/evidencia/ComparacionAB.tsx` (la lectura del modelo elegido) |

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
   sustituyen por un `.css` hermano. El `.tsx` **no lo importa**:
   `node scripts/juntar-affectui.mjs` copia todas las hojas en dos ficheros
   generados —`affectui.css`, con las piezas que alcanza alguna página pública
   o la 404, que importa el layout del idioma detrás de `globals.css`; y
   `affectui-panel.css`, con las que solo usa el panel, que importa
   `dashboard/layout.tsx`—. El reparto sale del grafo de imports, no de una
   lista. Con un `import "./pieza.css"` por componente Next partía el CSS en 43
   ficheros, cada página esperaba hasta 15 hojas antes de pintar y la 404 se
   quedaba en blanco en una de cada tres cargas directas (la causa, en la
   cabecera de `affectui.css`). Lo vigila `hojas-en-una-entrada.test.ts`.
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
  verde azulado (todas las paradas ≥ 3:1 sobre marfil), barrido de 900 ms,
  `-webkit-user-select`, y un bloque `forced-colors` que deja solo el texto
  real. El texto real sigue en el DOM (seleccionable y leído); la copia
  coloreada es `aria-hidden`. **Sin bucle** (WCAG 2.2.2): upstream repite el
  flujo sin fin (8 s por ciclo); aquí da UNA pasada de 4 s como mucho
  (`FLOW_MAX_S`, `speed` queda acotado), que empieza con el barrido al verse la
  frase y termina en el degradado quieto. Con `prefers-reduced-motion` no se
  mueve nada.
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

**Frente E4 — páginas públicas y acceso (2026-11-16).** Todas salen de la
descarga Pro, así que llevan la cabecera Pro aunque alguna tenga gemela libre.

- **button-clean** — tamaño nuevo `xl` (44px) y `block`; en `xl` el rótulo
  PARTE línea en vez de cortarse con «…» (se retira el `title` al pasar). Fuera
  la variante `destructive`. Se conservan el barrido de luz de `loading` y el
  cambio de ancho animado.
- **breadcrumb-clean** — **REDUCIDO** al rastro, en servidor: sin plegado de
  migas intermedias en un menú «…» ni desplegables por miga (el sitio tiene dos
  niveles). Las migas parten línea; 44px en táctil; `linkAs` recibe el `Link`
  con idioma; `label` obligatorio; oculto al imprimir.
- **scroll-area-clean** — comportamiento intacto; el pulgar en tinta.
- **tab-overload** — `label` obligatorio; degradados y puntos a los azules de
  BiVelio, marcos a `--surface-2`/`--line`; el brillo de los bloques, más lento.
- **glass-folder** — `label` obligatorio; azul de marca; tamaño con
  `--ui-fd-size`; sin recorte del contenedor (la sombra no se corta).
- **grid-background** — por defecto celda de 56px y 14 s por celda (antes 48px
  y 3 s): es fondo, no protagonista. Línea en tinta al 7 %. Oculta con
  `forced-colors`. La máscara la recoloca cada pantalla desde `globals.css`.
- **tilt-card** — inclinación máxima 5° (antes 10), escala 1.01, `display:
  block`, radio y sombras de BiVelio, sin recorte (el recibo tiene festón).
- **logo-marquee** — `label` obligatorio; velocidad 28 px/s; `grayscale`
  apagado por defecto (los logotipos van a color por decisión del dueño).

- **hover-card** (Pro) — `toggleOnClick` (el disparador es un botón sin acción
  propia: clic o toque abren, y lleva `aria-expanded`) y `label` (la tarjeta se
  anuncia como grupo con nombre). Mismo arreglo de mayúsculas heredadas.
- **toggle-group** (Pro) — `required` en `type="single"`: una opción queda
  siempre encendida (un filtro de lectura) y pulsar la encendida no hace nada.
  La variante «buttons» pinta la opción encendida en tinta con texto blanco
  (como el resto de chips de BiVelio; upstream usa un velo gris), filete de 1px
  y 44px de alto en pantallas táctiles (upstream 36–40).
- **ab-branches** (Pro) — **FORK** de la ilustración Outreach Branches. Mismo
  lenguaje (conectores finos, baldosas blancas con sombra suave, pulso hecho de
  trazos apilados) para explicar una sola cosa: un par A/B. Dos ramas en vez de
  tres, que vuelven a unirse en una cuarta baldosa (el contador del proveedor);
  fuera los logos de Gmail, Slack y Notion (las baldosas llevan las letras A y
  B); pulsos en tinta (A) y azul de marca (B) en vez del degradado pastel; sin
  filtros ni degradados SVG, así que no necesita ids ni `"use client"`. El
  dibujo NO dice nada del resultado: los dos brazos miden lo mismo. Decorativo
  salvo que se le pase `label`; la leyenda la escribe quien lo usa, en texto.
- **experiment-readout** — `ReadoutFact.label` admite un nodo (un término con
  su definición) y una `key` opcional.

**Frente E2 (2026-11-16) — panel: instalación, cuenta, equipo y extracto**

Las piezas de este frente salen del registro Pro y llevan la cabecera Pro (las
que compartía con otros frentes están en «Consolidadas»). Comunes a todas,
además de lo de arriba: la interpolación
`${EXIT_MS}` del CSS de `dialog` queda escrita (200 ms), y cada control lleva
al final de su `.css` un bloque `---- BiVelio ----` con el tamaño `lg` a 44 px
(en táctil conserva los 16 px de texto de upstream, para que iOS no amplíe) y
un filo visible sobre el fondo marfil.

- **avatar** — reducido a INICIALES sobre un color estable por nombre o id.
  Fuera: fotos, marca de agente, punto de estado (y sus «online/away/busy»),
  `AvatarGroup` y su «N more». Sin estado: se renderiza en servidor.
- **dialog** — `closeLabel`, `confirmLabel` y `cancelLabel` pasan a ser
  obligatorias (antes «Close», «Confirm», «Cancel»). Botones a 44 px.
  Revisión de dinero (2026-11-16): el botón de confirmar del AlertDialog
  ignora las pulsaciones de los primeros `CONFIRM_GUARD_MS` (400 ms) tras
  abrirse — en móvil la hoja sube con «Confirmar» bajo el dedo y el segundo
  toque de un doble toque confirmaba solo (`dialog-confirm-guard.test.ts`).
- **dropdown-menu** — `empty` ya no trae «Nothing here yet». Filas a 40 px
  (44 en táctil).
- **select** — `placeholder` sin «Choose…»; `optional` es el texto ya
  traducido, no un booleano que imprimía «Optional».
- **number-input** — `stepLabels` obligatoria (antes «Increase»/«Decrease»);
  `optional` como en `select`. Revisión de dinero (2026-11-16), porque el campo
  de asientos manda su valor a Stripe: la lectura del texto, lo que se emite y
  las teclas que el campo se queda viven en `number-input-read.ts` (puro,
  probado en `campo-asientos.test.ts`). `integer`: un texto con cualquier
  separador no se lee y el campo vuelve a su último valor (antes se quitaban
  comas y espacios: «2,5» era 25). `jumpKeys={false}`: Inicio/Fin/RePág/AvPág
  se quedan con el navegador (antes «Fin» saltaba a `max`). `onValueChange`
  también se emite MIENTRAS se teclea, en cuanto el texto es un número. Un
  texto ilegible da un paso desde el último valor, no desde el mínimo.
- **segmented-control** — el contador ya no se formatea con `"en-US"` fijo.
  `lg` a 36 px con puntero fino y 44 px en táctil.
- **setup-guide** — REESCRITO en solo lectura y sin estado: nadie marca nada.
  Cada tarea trae su estado (medido por el producto) y es un enlace a su
  instrucción. Fuera: marcar/desmarcar, bloqueo de tareas, plegado, «Edit»,
  minimizar y cerrar. Sin `progress` no hay barra ni recuento.
- **empty-calendar** — decorativa: fuera los textos «Calendar», «EMPTY» y el
  botón «Join meeting» dibujados en el SVG; la tarjeta no lleva palabras.

**Consolidadas (2026-11-16) — una pieza, un fichero.** Los frentes E1–E4
vendorizaron estas diez por separado; aquí queda UNA versión de cada una, con lo
que aportó cada frente. Quien la actualice parte de esta lista, no de cuatro.

- **badge-clean** (Pro; antes `badge` ×3 en E1/E2/E3 y `badge-clean` en E4) —
  **componente de servidor** (sin `"use client"`). Fuera los objetos de
  Hugeicons y el tono `purple` (nadie lo usaba). **La etiqueta parte línea** en
  vez de acabar en «…» (doce idiomas; un estado cortado no es un estado), así
  que la altura es `min-height`. Una sola escala: `md` (22px, texto de 12px, el
  valor por defecto) y `sm` (18px, 11px, para filas densas). Tonos a tokens de
  BiVelio con tinta ≥ 4,5:1 sobre su propio fondo. De E1: `caps` (lectura mono
  en mayúsculas de las etiquetas de tipo de evidencia). De E2: `live` (el punto
  late solo mientras algo está de verdad en curso; quieto con
  `prefers-reduced-motion`) y `count`, que ahora recibe el valor YA escrito en
  vez de formatearlo con el idioma del navegador. Borde en `forced-colors`.
- **tooltip-clean** (Pro; antes `tooltip` en E1/E3 y un `tooltip-clean`
  reducido a CSS en E4) — se conserva casi entero: capa superior con
  `popover="manual"` (ningún `overflow` lo corta), volteo, ventana de «vecinos
  sin espera», Escape. CSS en fichero hermano, tema claro, fondo a tinta de
  BiVelio. De E3 (y `tapToggles` de E1, que era lo mismo): **`toggleOnClick`**
  — cuando el disparador no hace otra cosa (un término con su definición), un
  clic o un toque abren y cierran, y tocar fuera cierra; upstream nunca abre con
  el dedo. De E1: **`kind="definition"`** (más ancho, peso normal, interlineado
  de párrafo). De E3: la burbuja vive en el DOM junto a su disparador, así que
  restablece `text-transform`, `letter-spacing` y `font-style` (no hereda las
  mayúsculas de una cabecera). La versión reducida de E4 desaparece: el botón de
  ver/ocultar la contraseña de `text-field-clean` usa esta (`content`, no
  `label`).
- **data-table-clean** (Pro; antes `data-table` en E1 y —distinta— en E2,
  `data-table-readonly` en E3 y `data-table-clean` en E4) — **BIFURCADA A SOLO
  LECTURA, una tabla para todo el sitio.** Upstream es una hoja de cálculo
  pequeña (celdas editables, cursor, selección de rangos, copiar y pegar,
  casillas, acciones en bloque, selectores de etiquetas, «añadir fila»,
  deshacer); nada de eso existe aquí a propósito: las filas son hechos medidos,
  contractuales o publicados, y una celda que parece editable mentiría. Queda el
  aspecto (tarjeta con sombra, cabecera de 12px gris sobre una banda tenue,
  filas separadas solo por filetes, velo al pasar) sobre un `<table>` real, y
  UNA interacción, ordenar:
  - de todos: las celdas son nodos que ya vienen formateados y traducidos; se
    ordena por el valor crudo de `row.sort`, nunca interpretando un texto;
  - de E1 y E3: **un valor que falta (`null` o ausente) ordena SIEMPRE al
    final**, en los dos sentidos: no es el número más pequeño y jamás se trata
    como cero (la versión de E2 lo dejaba donde cayera); `Intl.Collator` con
    `numeric` y `locale` opcional;
  - `aria-sort` en la columna ordenada; cada cabecera ordenable es un
    `<button>` de **44px con puntero grueso** (E1, E3), con nombre accesible por
    `sortLabel` («Ordenar por {column}», de E1; E3 lo pasaba columna a columna);
    primera pulsación de mayor a menor, segunda al revés y, si no hay
    `defaultSort` (E3), la tercera devuelve el orden entregado (E1, E2);
  - de E3: fila de título (`title`, `description`, `aside`, `headingAs`),
    `help` tras el rótulo de una columna (el «?» con la definición) y
    **`pinFirst`**, la primera columna fija al desplazar, con su filo;
  - de E4: `rowHeader` (`<th scope="row">`), `dense`, `lang`, estilos de
    impresión y el desplazamiento lateral dentro del **Scroll Area** de la
    librería (región con nombre que solo es parada de tabulador mientras de
    verdad desplaza, con bordes suaves donde hay más); sustituye al `overflow`
    nativo de E1/E2 y a los bordes hechos con script de E3;
  - de E2: `flat` (sin tarjeta, para una tabla que ya vive dentro de una) y
    **`narrow="stack"`**: por debajo de 640px de su propio ancho cada fila pasa
    a ser una hoja de pares rótulo/valor (`lead`, `plain`); el resto desplaza;
  - de E1: `summary` (fila de resumen que no participa en la ordenación),
    `nowrap`, `mono` y `quiet` (celdas que son un «—»);
  - nuevo en la integración: `prose` (tablas de un artículo o una guía: celdas
    alineadas arriba y que pueden partir en cualquier punto) y `label`
    obligatoria (el `<caption>` oculto y el nombre de la región).
  Sin una sola cadena en inglés.
- **text-field-clean** (Pro; antes `text-field` en E2 y `text-field-clean` en
  E4) — 44px de alto en todas partes y texto de 16px en táctil (objetivo
  táctil; iOS no amplía). `reveal` trae los dos nombres del botón de ver/ocultar
  ya traducidos, y el botón lleva el Tooltip de la librería. `invalid` marca el
  campo sin imprimir un mensaje debajo (los formularios de acceso dicen el
  error UNA vez, en la alerta). `icon` (antes `prefix`) y `aside`. Fuera:
  tamaños, sufijos, borrar, copiar y contador (nada los usa; la versión de E2
  los conservaba detrás de `labels`). Filo visible sobre el fondo marfil,
  autorrelleno del navegador sin segunda caja. El panel baja el texto a 14,5px
  con puntero fino desde `app/globals.css` (`--fs`).
- **empty-state-clean** (Pro; antes `empty-state` en E2 y `empty-state-clean`
  en E4) — componente de servidor; sin glifo por defecto ni objetos de
  Hugeicons (`icon` es un SVG en línea o nada). De E4: `art` (ilustración en
  vez de baldosa), `eyebrow`, `titleAs` y `size="page"` (la 404). `bare` y
  `tall` como upstream.
- **spinner-clean** (Pro; antes `spinner` en E2 y `spinner-clean` en E4) —
  componente de servidor; sin cambios de comportamiento. La etiqueta, si la
  hay, llega traducida.
- **separator-clean** (Pro; E4) — componente de servidor; sin cambios de
  comportamiento.
- **toaster** (Pro; antes dos `toaster`: el reducido de E1 y el casi íntegro de
  E2) — **REDUCIDO, uno para todo el panel.** Una esquina, una columna (sin el
  abanico de tarjetas asomando), sin deslizar para cerrar, sin `promise` ni
  metamorfosis de carga, sin segunda pila (`id`/`toaster`), sin `position`.
  Queda la tarjeta blanca con filete, el icono de estado de 16px, UNA acción
  (el sitio de «Deshacer»), cerrar (botón, y Escape con el foco en el aviso) y
  un temporizador que se detiene con el puntero o el foco encima. La lista es
  una región viva `polite`. De E2: tipo `error` (es `role="alert"` y, salvo que
  se le dé duración, **se queda hasta que se cierra**) y los atajos
  `toast.success/.error/.info`. Sin cadenas por defecto: `label` y `closeLabel`
  son props de `<Toaster />`.
- **usage-meter** (Pro; antes dos `usage-meter`, E1 y E2, ambos «solo
  asientos») — **BIFURCADO A UNA LECTURA: asientos en uso frente a
  contratados**, y uno solo para las dos pantallas que la enseñan. Componente
  de servidor, sin estado ni animación de conteo. Fuera: créditos y categorías,
  selector de periodo, minigráfico diario, límites de plan, «se renueva en N
  días», botón de mejora y el aviso del 80 %. De E2: cabecera con `unit`, la
  cifra grande con su `figureLabel`, `missing` (sin lectura NO hay barra y se
  escribe el porqué; nunca un cero), la leyenda `rows` y el tramo por encima de
  lo contratado en ámbar. De E1: la barra dibuja **un hueco por asiento**
  mientras caben (hasta 40), `stateLabel` (el estado también se dice con
  palabras), `note` y el tamaño `sm` (dentro de otra tarjeta). La barra sale de
  las dos lecturas crudas (`used`, `limit`), ya no de proporciones calculadas
  fuera. Estados `ok` / `full` / `over`: ocupar todos los asientos y pasarse
  son AVISOS, en ámbar; ninguno es un error (E1 pintaba el exceso en rojo).
  Relleno en tinta: el azul queda para las acciones.
- **team-invite** (Pro; E2 y E4) — **sin retratos**: `nodes` son tres nodos
  (glifos o marcas) que pone quien la usa; por defecto, un glifo anónimo (lo
  que hacía E2). Con `label` es `role="img"`; sin ella es decorativa
  (`aria-hidden`), para cuando el texto de al lado ya lo dice. Colores a
  tokens de BiVelio (el punto «en línea» en azul de marca) y bucle de 6,4 s.
- **blur-crossfade** (Pro; E2 y E3) — duración 240 ms (antes 420) y desenfoque
  6px (antes 10) por defecto; curva a `--aui-ease`.

## Cómo vendorizar una pieza nueva (frentes)

1. Copia el fichero upstream **sin tocar** a un directorio temporal y anota su
   `shasum -a 256`.
2. Crea `vendor/affectui/<pieza>.tsx` y `<pieza>.css`:
   - cabecera de licencia (MIT o Pro, las de arriba);
   - mueve el CSS de la cadena a `<pieza>.css` y borra el `<style>`. **No lo
     importes desde el `.tsx`**: `node scripts/juntar-affectui.mjs` lo mete en
     la hoja que toque (pública o del panel, según quién importe la pieza). Hay
     que volver a ejecutarlo cuando una pieza del panel pasa a usarse en una
     página pública; el test falla si se olvida;
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
5. `node scripts/juntar-affectui.mjs` (desde `apps/web`),
   `pnpm --dir apps/web run typecheck`, `pnpm exec vitest run apps/web` y el
   build.

## Cómo actualizar una pieza

1. Baja la versión nueva y compara su sha256 con el del inventario.
2. `diff` entre el upstream antiguo (commit de arriba) y el nuevo; aplica a mano
   solo lo que interese sobre el fichero adaptado.
3. Reaplica la lista de cambios, actualiza commit/sha256 aquí y vuelve a
   verificar reduced-motion, foco y contraste: el soporte que declara la
   librería se comprueba de nuevo después de modificarla.
