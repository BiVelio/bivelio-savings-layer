// Sincroniza la clave PÚBLICA del SDK tras una rotación. Run: node scripts/rotar-clave-publica.mjs
//
// SOLO TOCA LA MITAD PÚBLICA. La privada (keys/license.key.pem) no la lee nadie
// aquí, ni debe: vive en la variable LICENSE_PRIVATE_KEY_B64 de Vercel y la pone
// el dueño a mano. Este script lee `keys/license.pub.pem` (el par nuevo ya
// generado) y reescribe la copia que la web lleva embebida en
// `apps/web/lib/license/clave-esperada.ts`, para que las DOS mitades públicas
// —la que `tsup` embebe en el SDK desde el mismo fichero, y la del plano de
// control— sigan siendo la misma. `clave-esperada.test.ts` ata las dos y falla si
// derivan; este script es lo que las vuelve a igualar en un paso tras rotar.
//
// El SDK embebido se actualiza solo: `tsup.config.ts` lee keys/license.pub.pem en
// el build. Así que tras generar el par nuevo, esto + un `pnpm build` dejan todo
// coherente, y el 0.5.0 sale con la pública nueva.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const raiz = new URL("../", import.meta.url);
const pubPath = fileURLToPath(new URL("keys/license.pub.pem", raiz));
const claveEsperadaPath = fileURLToPath(new URL("apps/web/lib/license/clave-esperada.ts", raiz));

const pub = readFileSync(pubPath, "utf8").trim();
if (!/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----$/.test(pub)) {
  console.error(`keys/license.pub.pem no parece un PEM público SPKI:\n${pub}`);
  process.exit(1);
}

const fuente = readFileSync(claveEsperadaPath, "utf8");
const patron = /(export const CLAVE_PUBLICA_DEL_SDK = `)([\s\S]*?)(`;)/;
const m = fuente.match(patron);
if (!m) {
  console.error("No se encontró la constante CLAVE_PUBLICA_DEL_SDK en clave-esperada.ts");
  process.exit(1);
}

// Idempotente: solo reescribe si el CUERPO base64 cambia de verdad (el mismo
// criterio que `cuerpoDelPem` en clave-esperada.test.ts). Así una rotación que no
// mueve la clave —o correr el script dos veces— no genera un diff espurio ni
// reformatea el fichero.
const cuerpo = (pem) => pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");
if (cuerpo(m[2]) === cuerpo(pub)) {
  console.log("La clave pública de la web ya coincide con keys/license.pub.pem. Nada que hacer.");
  process.exit(0);
}
// Conserva el estilo del fichero: el PEM va inline tras el backtick, terminado en
// un salto de línea antes del cierre (como estaba).
const nuevo = fuente.replace(patron, `$1${pub}\n$3`);
writeFileSync(claveEsperadaPath, nuevo);
console.log("Actualizada apps/web/lib/license/clave-esperada.ts con la nueva clave pública.");
console.log("Ahora:  pnpm build  (tsup re-embebe la pública en el SDK)  y  npx vitest run clave-esperada");
