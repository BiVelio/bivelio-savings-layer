# Tipografías self-hosted

Las cuatro familias de la marca BiVelio, servidas desde este origen porque la
CSP declara `font-src 'self'` (ver `next.config.mjs`). Son las copias locales
aprobadas de las que publica bivelio.com (repo `BiVelio/website`,
`sitio/dist/assets/fuentes`): un woff2 variable por familia y subconjunto, con
el mismo `unicode-range` que `css/fuentes.css` de la web madre.

| Fichero | Familia | Eje / peso | Uso |
|---|---|---|---|
| `geist-latin-wght-normal.woff2` | Geist | `wght 100–900` | interfaz, cuerpo, navegación, titulares de la app (`--font-sans`) |
| `geist-latin-ext-wght-normal.woff2` | Geist | `wght 100–900` | latin-ext (pl, tr, vi…): solo se descarga si la página lo necesita |
| `geist-mono-latin-wght-normal.woff2` | Geist Mono | `wght 100–900` | código, IDs, hashes y cifras del recibo (`--font-mono`) |
| `geist-mono-latin-ext-wght-normal.woff2` | Geist Mono | `wght 100–900` | latin-ext |
| `plus-jakarta-sans-latin-wght-normal.woff2` | Plus Jakarta Sans | `wght 200–800` | titulares editoriales a 800 (`--font-editorial`) |
| `plus-jakarta-sans-latin-ext-wght-normal.woff2` | Plus Jakarta Sans | `wght 200–800` | latin-ext |
| `instrument-serif-latin-400-italic.woff2` | Instrument Serif | 400 cursiva | énfasis breve dentro de un titular (`--font-serif`) |
| `instrument-serif-latin-ext-400-italic.woff2` | Instrument Serif | 400 cursiva | latin-ext |

Las `@font-face` viven al principio de `app/globals.css`, junto a las caras
«Fallback» de métricas ajustadas (`size-adjust`, `ascent-override`…) que evitan
el salto de texto durante `font-display: swap`. `app/[locale]/layout.tsx`
precarga solo `geist-latin` y `plus-jakarta-sans-latin`, que son las que pinta
el primer pliegue.

Rasgos OpenType disponibles en estos subconjuntos (comprobado con fontTools):
Geist y Plus Jakarta Sans traen `liga`, `tnum`, `pnum`, `frac`; **no** traen
`cv11` ni `ss01`. Geist Mono es de ancho fijo y no necesita `tnum`.

## Licencia

Las cuatro se distribuyen bajo la **SIL Open Font License 1.1**, que permite
redistribuirlas empaquetadas siempre que no se vendan por separado y se conserve
el aviso de copyright:

- Geist y Geist Mono — © Vercel, en colaboración con basement.studio (https://github.com/vercel/geist-font)
- Plus Jakarta Sans — © Tokotype (https://github.com/tokotype/PlusJakartaSans)
- Instrument Serif — © Instrument (https://github.com/Instrument/instrument-serif)

Texto completo de la licencia: https://openfontlicense.org
