# Tipografías self-hosted

Las tres familias del sistema de BiVelio, servidas desde este origen porque la
CSP declara `font-src 'self'` (ver `next.config.mjs`). bivelio.com carga las
mismas vía `next/font/google`; aquí son subconjuntos latinos variables, un
fichero por familia.

| Fichero | Familia | Eje | Uso |
|---|---|---|---|
| `inter-var.woff2` | Inter | `wght 100–900` | cuerpo de texto (`--sans`) |
| `space-grotesk-var.woff2` | Space Grotesk | `wght 300–700` | titulares y wordmark (`--font-heading`) |
| `jetbrains-mono-var.woff2` | JetBrains Mono | `wght 100–800` | cifras, claves y micro-rótulos (`--mono`) |

`space-grotesk-500.woff2` y `space-grotesk-700.woff2` son los estáticos previos
a la variable; ninguna regla los referencia ya.

Las tres se distribuyen bajo la **SIL Open Font License 1.1**, que permite
redistribuirlas empaquetadas siempre que no se vendan por separado y se conserve
el aviso de copyright:

- Inter — © The Inter Project Authors (https://github.com/rsms/inter)
- Space Grotesk — © The Space Grotesk Project Authors (https://github.com/floriankarsten/space-grotesk)
- JetBrains Mono — © 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)

Texto completo de la licencia: https://scripts.sil.org/OFL

`jetbrains-mono-var.woff2` es el subconjunto latino de
`@fontsource-variable/jetbrains-mono@5.3.0`, renombrado para seguir la
convención de las otras dos.
