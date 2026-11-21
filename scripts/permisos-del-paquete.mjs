#!/usr/bin/env node
/**
 * LOS PERMISOS DEL TARBALL NO DEPENDEN DEL UMASK DE QUIEN EMPAQUETA.
 *
 * `npm pack` copia al tarball el modo de cada fichero tal como está en disco, y
 * solo añade el bit de ejecución a los `bin`. En un árbol creado con umask 077
 * (la verificación final de la 1.2.4 empaquetó así una copia de la release) el
 * tarball salía con 36 ficheros -rw------- y bin.js -rwx------, y `npm install`
 * los deja igual en node_modules: en Docker con `npm ci` como root y
 * `USER node`, o con `sudo npm i -g`, otro usuario no podría leer dist/index.js
 * ni ejecutar `bvsala`. La 1.2.3 publicada (hecha en CI, umask 022) va con
 * -rw-r--r-- y -rwxr-xr-x.
 *
 * Corre como `prepack` (package.json): antes de cada `npm pack` / `npm publish`
 * desde el árbol, AÑADE lectura para todos a lo que el paquete publica —lo que
 * lista `files`, más package.json— y ejecución para todos a los directorios y a
 * los ficheros que ya eran ejecutables por su dueño. Solo añade bits: no quita
 * ninguno ni toca el contenido, así que en CI (ya 644/755) no cambia nada y el
 * sha512 que compara publish.yml es el mismo.
 *
 * No imprime nada por stdout: los tests leen el nombre del tarball de la salida
 * de `npm pack --silent`.
 *
 *   node scripts/permisos-del-paquete.mjs [raíz]     (por defecto, el directorio actual)
 */
import { chmodSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const raiz = resolve(process.argv[2] ?? process.cwd());
const pkg = JSON.parse(readFileSync(join(raiz, "package.json"), "utf8"));
const entradas = ["package.json", ...(Array.isArray(pkg.files) ? pkg.files : [])].filter(
  // Un patrón (`dist/*.js`) no es una ruta: este paquete no usa ninguno.
  (e) => typeof e === "string" && !/[*?[\]{}!]/.test(e),
);

function visitar(ruta) {
  let st;
  try {
    st = lstatSync(ruta);
  } catch {
    return; // `files` puede nombrar algo que no existe; npm lo ignora y aquí también.
  }
  if (st.isSymbolicLink()) return;
  const modo = st.mode & 0o7777;
  if (st.isDirectory()) {
    if ((modo | 0o755) !== modo) chmodSync(ruta, modo | 0o755);
    for (const hijo of readdirSync(ruta)) visitar(join(ruta, hijo));
  } else if (st.isFile()) {
    const quiero = modo & 0o100 ? modo | 0o755 : modo | 0o644;
    if (quiero !== modo) chmodSync(ruta, quiero);
  }
}

for (const e of entradas) visitar(join(raiz, e));
