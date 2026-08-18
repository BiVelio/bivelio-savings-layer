# Rotación de la clave de firma de licencias

La clave privada Ed25519 que firma **todas** las licencias vivía en `keys/` y se
subía a Vercel en cada deploy desde la raíz (arreglado en `.vercelignore`, pero
los deploys anteriores ya la subieron). Hay que **rotar el par**. Momento ideal:
**ahora, con 0 clientes de pago** — rotar más tarde obliga a cada cliente a
actualizar el SDK a la vez.

## Qué es delicado

La mitad **pública** va EMBEBIDA en el SDK en tiempo de build (`tsup` la lee de
`keys/license.pub.pem`) y viaja dentro de cada copia de `@bivelio/savings-layer`.
La **privada** firma en el plano de control (variable `LICENSE_PRIVATE_KEY_B64` de
Vercel). Si se rota la privada sin desplegar la pública nueva en TODAS partes a la
vez, el plano de control firma licencias que los SDK con la pública vieja rechazan
→ caída total (fail-closed). Por eso la rotación va **atada al corte del 0.5.0**:
la pública nueva sale en el SDK + en la web, y la privada nueva se pone en Vercel
en la misma ventana.

## Pasos (los ejecuta el dueño; la privada NUNCA pasa por el asistente)

1. **Generar el par nuevo** (sobrescribe `keys/`, que está gitignored):
   ```bash
   openssl genpkey -algorithm ed25519 -out keys/license.key.pem
   openssl pkey -in keys/license.key.pem -pubout -out keys/license.pub.pem
   ```

2. **Sincronizar la pública en la web** (solo mitad pública):
   ```bash
   node scripts/rotar-clave-publica.mjs
   pnpm build            # tsup re-embebe la pública nueva en el SDK
   npx vitest run clave-esperada   # ata SDK ↔ web ↔ keys/
   ```

3. **La privada, en Vercel** (el asistente no la ve ni la escribe). Base64 de la
   privada → variable de entorno del proyecto:
   ```bash
   base64 -i keys/license.key.pem | pbcopy   # pégalo en Vercel → Settings → Environment → LICENSE_PRIVATE_KEY_B64
   ```
   (o `vercel env add LICENSE_PRIVATE_KEY_B64 production` y pegar el valor).

4. **Cortar y publicar 0.5.0** con la pública nueva (llave física, ver
   [[npm-publicar-con-llave-fisica]]), y **desplegar la web** en la misma ventana,
   para que control-plane y clientes cambien de par a la vez.

5. **Comprobar la sonda de salud** `/api/health/signing`: su huella debe pasar a la
   de la clave nueva. Si sigue en la vieja, el despliegue no tomó la variable.

## Invariante que lo protege

`apps/web/lib/license/clave-esperada.ts` mantiene una copia de la pública porque
el build de la web (raíz en `apps/web`) no alcanza `keys/`. `clave-esperada.test.ts`
exige que esa copia sea byte a byte la de `keys/license.pub.pem` (la que el SDK
embebe). Así, si el paso 2 se olvida, el test falla en CI antes de desplegar una
web que verifica contra una clave que ningún cliente tiene.
