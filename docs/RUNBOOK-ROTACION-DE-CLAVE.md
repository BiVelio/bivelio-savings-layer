# Runbook — rotar la clave de firma de licencias

La privada Ed25519 firma **todas** las licencias del producto. Rotarla es
coordinado: si las dos mitades públicas se desincronizan, el SDK —que es
fail-closed— deja de validar licencias **de todos los clientes a la vez**.

Este runbook existe porque el paso que se olvida siempre es el 3.

## Dónde vive cada mitad

| | dónde | ¿versionado? |
|---|---|---|
| **privada** | variable `LICENSE_PRIVATE_KEY_B64` en Vercel | **NO**, y nunca |
| privada (copia local) | `keys/license.key.pem` | no — `.gitignore:27` |
| pública (fuente) | `keys/license.pub.pem` | **SÍ, está en git** |
| pública (SDK) | embebida por `tsup` en el build, desde el fichero de arriba | — |
| pública (web) | `apps/web/lib/license/clave-esperada.ts` | **SÍ** |

> **Ojo con esto**, porque es donde falla la rotación: `.gitignore` solo excluye
> `keys/*.key.pem` y `keys/*.private.pem`. **La pública SÍ está versionada**
> (`git ls-files keys/` lo confirma). Si rotas y no la commiteas, CI seguirá
> construyendo el SDK con la clave vieja mientras la web ya verifica con la
> nueva, y el desajuste no se ve hasta que un cliente no puede validar.

## Los pasos

**1 · Generar el par nuevo.** El `-pubout` del segundo comando no es opcional:

```bash
openssl genpkey -algorithm ed25519 -out keys/license.key.pem
openssl pkey -in keys/license.key.pem -pubout -out keys/license.pub.pem
```

Si te equivocas y dejas una privada en `license.pub.pem`, el guion del paso 2 lo
detecta y **para sin imprimir el contenido** — no lo abras tú en una terminal
compartida para «ver qué pasó»: regenera la mitad pública y sigue.

**2 · Sincronizar la copia de la web.**

```bash
node scripts/rotar-clave-publica.mjs
```

Comprueba que sea un SPKI público **y** que sea Ed25519 (60 caracteres base64) antes
de escribir nada. Un SPKI de RSA pasaría la primera comprobación y rompería a
todos los clientes: `rawKeyFromSpkiPem` corta los últimos 32 bytes del DER, así
que con RSA saca basura y ninguna firma verifica.

**3 · Reconstruir, verificar y COMMITEAR. Este es el paso que se olvida.**

```bash
pnpm build                          # tsup re-embebe la pública en el SDK
npx vitest run clave-esperada       # ata las dos mitades públicas
git add keys/license.pub.pem apps/web/lib/license/clave-esperada.ts \
        apps/web/public/vendor/bv-sala.js
```

El bundle vendorizado entra porque la web lo carga en el navegador y también
lleva la pública dentro.

**4 · Poner la privada nueva en Vercel**, como variable de entorno, a mano y
desde el panel. Nunca por CLI que la deje en el historial del shell, nunca en un
fichero del repo, nunca pegada en una transcripción.

**5 · Publicar el SDK** con la pública nueva embebida:

```bash
npm logout && npm login --auth-type=web && npm publish --access public
```

El `logout` primero es la pieza clave: sin él npm pide TOTP y no abre el
navegador.

## Orden y ventana de riesgo

Entre el paso 4 (la web ya firma con la privada nueva) y el 5 (los clientes
tienen la pública nueva) hay una ventana en la que una licencia recién emitida no
valida contra un SDK viejo. Emite las licencias nuevas **después** de publicar, o
acepta las dos claves durante la transición si algún día se implementa.

## Si algo sale mal

`npx vitest run clave-esperada` es el canario: falla en cuanto las dos mitades
públicas dejan de coincidir. Córrelo antes de publicar y después de commitear.
