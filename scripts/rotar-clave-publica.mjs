// Sincroniza la clave PÚBLICA del SDK tras una rotación.
//   node scripts/rotar-clave-publica.mjs
//
// SOLO TOCA LA MITAD PÚBLICA. La privada (keys/license.key.pem) no la lee nadie
// aquí, ni debe: vive en la variable LICENSE_PRIVATE_KEY_B64 de Vercel y la pone
// el dueño a mano. Este script lee `keys/license.pub.pem` (el par nuevo ya
// generado) y reescribe la copia que la web lleva embebida en
// `apps/web/lib/license/clave-esperada.ts`, para que las DOS mitades públicas
// —la que `tsup` embebe en el SDK desde ese mismo fichero, y la del plano de
// control— sigan siendo la misma. `clave-esperada.test.ts` ata las dos y falla si
// derivan; esto es lo que las vuelve a igualar en un paso tras rotar.
//
// NUNCA IMPRIME EL CONTENIDO DE UN FICHERO DE CLAVE. Ni siquiera cuando no
// valida — sobre todo entonces: el error más probable al generar el par es
// equivocarse con `-out`/`-pubout` y dejar una PRIVADA donde debería ir la
// pública, y un volcado «para ayudar a depurar» la quemaría en la terminal, en
// el scrollback y en la transcripción de la sesión. Los mensajes dicen QUÉ pasa
// y QUÉ hacer, nunca QUÉ hay dentro.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const raiz = new URL("../", import.meta.url);
const pubPath = fileURLToPath(new URL("keys/license.pub.pem", raiz));
const claveEsperadaPath = fileURLToPath(new URL("apps/web/lib/license/clave-esperada.ts", raiz));

const cuerpoDelPem = (pem) =>
  pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");

let pub;
try {
  pub = readFileSync(pubPath, "utf8").trim();
} catch {
  console.error("No se pudo leer keys/license.pub.pem. Genera antes el par nuevo.");
  process.exit(1);
}

if (!/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----$/.test(pub)) {
  // Se dice qué cabecera se esperaba, no lo que hay. Si ahí hay una privada, el
  // mensaje no la propaga.
  console.error(
    "keys/license.pub.pem no es un PEM público SPKI: falta la cabecera " +
      "'-----BEGIN PUBLIC KEY-----'.\n" +
      "Si al generar el par se olvidó `-pubout`, ese fichero podría ser la PRIVADA: " +
      "no lo abras en una terminal compartida; regenera la mitad pública con\n" +
      "  openssl pkey -in keys/license.key.pem -pubout -out keys/license.pub.pem",
  );
  process.exit(1);
}

// Y QUE SEA Ed25519, no cualquier SPKI. Un SPKI de RSA pasa el regex de arriba
// tal cual, y `rawKeyFromSpkiPem` (src/license/verify.ts) corta los ÚLTIMOS 32
// bytes del DER: con RSA saca 32 bytes de basura, toda firma deja de verificar y
// el SDK —que es fail-closed— tumba a TODOS los clientes a la vez. La verja
// existe aguas abajo (`clave-esperada.test.ts` exige 60 caracteres base64), pero
// llega dos pasos tarde: para entonces la clave mala ya está escrita.
const cuerpoNuevo = cuerpoDelPem(pub);
if (cuerpoNuevo.length !== 60) {
  console.error(
    `keys/license.pub.pem no parece una clave Ed25519: su cuerpo base64 mide ` +
      `${cuerpoNuevo.length} caracteres y una Ed25519 SPKI mide 60. ` +
      `No se ha tocado nada.`,
  );
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
// mueve la clave —o correr esto dos veces— no genera un diff espurio.
if (cuerpoDelPem(m[2]) === cuerpoNuevo) {
  console.log("La clave pública de la web ya coincide con keys/license.pub.pem. Nada que hacer.");
  process.exit(0);
}

// Reemplazo con FUNCIÓN, no con cadena: en la cadena de reemplazo, `$&`, `$'` y
// `$1` son referencias, y el regex de validación admite cualquier cosa entre las
// cabeceras. Con una función, el PEM se inserta literal pase lo que pase.
const nuevo = fuente.replace(patron, (_todo, abre, _viejo, cierra) => `${abre}${pub}\n${cierra}`);
writeFileSync(claveEsperadaPath, nuevo);

console.log("Actualizada apps/web/lib/license/clave-esperada.ts con la nueva clave pública.");
console.log("Falta, en este orden:");
console.log("  1. pnpm build                       (tsup re-embebe la pública en el SDK)");
console.log("  2. npx vitest run clave-esperada    (ata las dos mitades)");
console.log("  3. commitear keys/license.pub.pem Y clave-esperada.ts");
console.log("     — la PÚBLICA está versionada; .gitignore solo excluye keys/*.key.pem.");
