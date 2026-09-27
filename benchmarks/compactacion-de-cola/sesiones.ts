/**
 * SESIONES SINTÉTICAS DE AGENTE para el banco en seco de la compactación de la
 * cola. Deterministas (semilla fija), sin red y sin datos de nadie.
 *
 * POR QUÉ SINTÉTICAS. El corpus real del espía (~/.bvsala-f0) guarda las
 * cabeceras de cada petición (pueden llevar credenciales: esta línea no lo
 * abre), y el replay existente (`pnpm sombra:corpus`)
 * reduce cada petición a metadatos SIN contenido: la compactación necesita el
 * texto. Así que aquí se mide el MECANISMO —qué le pasa a la caché de prefijo
 * según CUÁNDO se compacta— sobre salidas con la forma de las reales, y la cifra
 * sobre tráfico real queda como paso del dueño (ver el informe).
 *
 * LO QUE SE DECLARA, porque decide la cifra: la MEZCLA de clases por perfil.
 * Cada clase lleva su porqué. El banco publica el resultado por clase además del
 * agregado, para que quien tenga otra mezcla haga su cuenta.
 */
import type { ChatMessage } from "../../src/contracts/types.js";

/** Una salida de herramienta con la llamada que la pidió. */
export interface SalidaDeHerramienta {
  clase: ClaseDeSalida;
  nombre: string;
  argumentos: string;
  contenido: string;
}

export type ClaseDeSalida =
  | "json-indentado"
  | "json-compacto"
  | "tests-con-color"
  | "tests-sin-color"
  | "sondeo-repetido"
  | "barra-de-progreso"
  | "lectura-de-fichero"
  | "grep"
  | "diff"
  | "prosa-web";

export type Perfil = "app-con-api" | "agente-de-codigo" | "agente-de-operaciones";

/**
 * La mezcla por perfil (pesos relativos).
 *
 *  · app-con-api: el cliente del SDK. Herramientas de negocio que devuelven JSON
 *    (CRM, tickets, búsqueda). Se supone que la mitad del JSON llega INDENTADO
 *    —lo que hace un servidor MCP que devuelve `JSON.stringify(x, null, 2)` o un
 *    `jq`— y el resto ya compacto, que es lo que devuelve una API REST sin más.
 *  · agente-de-codigo: dominan lecturas de fichero y grep (que NO se tocan por
 *    nombrar un fichero), diffs y tests SIN color —un agente corre los comandos
 *    sin terminal, y casi ninguna herramienta colorea ni pinta barras así—. Lo
 *    compactable es un 10 % de las salidas: Quesma midió que la salida de
 *    terminal era el 11 % de la entrada de Claude Code, JetBrains que el gancho
 *    de RTK solo veía una quinta parte de la salida de herramientas, y el
 *    replay del corpus propio clasificó como «log» el 0,0 % del prompt.
 *  · agente-de-operaciones: logs de sondeo, barras de progreso y tests con color
 *    (CI con FORCE_COLOR), además de JSON de APIs de infraestructura.
 */
export const MEZCLA: Record<Perfil, Partial<Record<ClaseDeSalida, number>>> = {
  "app-con-api": { "json-indentado": 40, "json-compacto": 40, "prosa-web": 20 },
  "agente-de-codigo": {
    "lectura-de-fichero": 40,
    grep: 20,
    diff: 10,
    "tests-sin-color": 15,
    "prosa-web": 5,
    "tests-con-color": 3,
    "sondeo-repetido": 3,
    "barra-de-progreso": 2,
    "json-indentado": 2,
  },
  "agente-de-operaciones": {
    "sondeo-repetido": 25,
    "barra-de-progreso": 15,
    "tests-con-color": 20,
    "json-indentado": 25,
    "json-compacto": 15,
  },
};

export interface Sesion {
  perfil: Perfil;
  id: string;
  /** La conversación ENTERA tal como la guarda el cliente, con los originales. */
  mensajes: ChatMessage[];
  salidas: SalidaDeHerramienta[];
}

// --- azar sembrado ------------------------------------------------------------

export type Azar = () => number;

export function azarSembrado(semilla: number): Azar {
  let s = semilla >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const entero = (azar: Azar, min: number, max: number): number => min + Math.floor(azar() * (max - min + 1));
const elegir = <T>(azar: Azar, xs: readonly T[]): T => xs[Math.floor(azar() * xs.length)]!;

const PALABRAS = (
  "checkout payment order customer invoice refund shipping address cart session token retry timeout " +
  "service request response handler queue worker cache database index migration schema table column " +
  "user account billing plan seat license report metric latency error warning deploy build release"
).split(" ");

const frase = (azar: Azar, n: number): string =>
  Array.from({ length: n }, () => elegir(azar, PALABRAS)).join(" ");

const fecha = (azar: Azar): string =>
  `2026-09-${String(entero(azar, 1, 27)).padStart(2, "0")}T${String(entero(azar, 0, 23)).padStart(2, "0")}:${String(entero(azar, 0, 59)).padStart(2, "0")}:00Z`;

// --- generadores por clase -------------------------------------------------------

function registrosDeApi(azar: Azar, turno: number): unknown {
  return {
    total_count: entero(azar, 20, 400),
    page: 1,
    items: Array.from({ length: entero(azar, 8, 30) }, (_, i) => ({
      id: 184_000_000 + turno * 100 + i,
      number: 4000 + turno * 10 + i,
      title: frase(azar, entero(azar, 4, 9)),
      state: elegir(azar, ["open", "closed"]),
      labels: Array.from({ length: entero(azar, 0, 3) }, () => ({ name: elegir(azar, PALABRAS), color: "d73a4a" })),
      user: { login: `user-${entero(azar, 1, 90)}`, id: entero(azar, 1000, 99999), type: "User" },
      created_at: fecha(azar),
      updated_at: fecha(azar),
      comments: entero(azar, 0, 25),
      body: frase(azar, entero(azar, 8, 30)),
    })),
  };
}

function salidaDeTests(azar: Azar, turno: number, color: boolean): string {
  const c = (codigo: number, t: string) => (color ? `\u001b[${codigo}m${t}\u001b[39m` : t);
  const tenue = (t: string) => (color ? `\u001b[2m${t}\u001b[22m` : t);
  const lineas = [`${tenue("RUN")} v2.1.9 /workspace/app`, ""];
  const n = entero(azar, 15, 60);
  let fallos = 0;
  for (let i = 0; i < n; i++) {
    const falla = azar() < 0.08;
    if (falla) fallos += 1;
    const fichero = `test/${elegir(azar, PALABRAS)}-${elegir(azar, PALABRAS)}.test.ts`;
    lineas.push(
      falla
        ? ` ${c(31, "×")} ${fichero} > ${frase(azar, 5)} ${c(33, `${entero(azar, 1, 900)}ms`)}`
        : ` ${c(32, "✓")} ${fichero} ${tenue(`(${entero(azar, 1, 40)} tests)`)} ${c(33, `${entero(azar, 1, 900)}ms`)}`,
    );
    if (falla) {
      lineas.push(`   ${c(31, `AssertionError: expected ${entero(azar, 0, 99)} to be ${entero(azar, 100, 199)}`)}`);
      lineas.push(`    ${tenue(`❯ ${fichero}:${entero(azar, 10, 300)}:${entero(azar, 1, 40)}`)}`);
    }
  }
  lineas.push("", ` ${tenue("Test Files")}  ${c(31, `${fallos} failed`)} | ${c(32, `${n - fallos} passed`)} (${n})`);
  lineas.push(` ${tenue("Duration")}  ${entero(azar, 1, 90)}.${entero(azar, 0, 9)}s (turn ${turno})`);
  return lineas.join("\n");
}

function sondeoRepetido(azar: Azar, turno: number): string {
  const lineas = [`$ ./scripts/wait-for-stack.sh (attempt ${turno})`];
  const bloques = entero(azar, 1, 3);
  for (let b = 0; b < bloques; b++) {
    const linea = elegir(azar, [
      "Waiting for postgres at db:5432 to accept connections...",
      "curl: (7) Failed to connect to localhost port 8080 after 0 ms: Connection refused",
      "npm WARN deprecated inflight@1.0.6: This module is not supported, and leaks memory.",
      "[warn] Retrying request to https://registry.internal/v2/ in 1000ms (ECONNRESET)",
    ]);
    const veces = entero(azar, 5, 30);
    for (let k = 0; k < veces; k++) lineas.push(linea);
    lineas.push(`${frase(azar, 6)} (${entero(azar, 1, 30)}s)`);
  }
  lineas.push("stack ready");
  return lineas.join("\n");
}

function barraDeProgreso(azar: Azar, turno: number): string {
  const lineas = [`$ pip download -r requirements-${turno}.txt`];
  for (let p = 0; p < entero(azar, 1, 4); p++) {
    const paquete = `${elegir(azar, PALABRAS)}_${elegir(azar, PALABRAS)}-${entero(azar, 1, 9)}.${entero(azar, 0, 20)}.0`;
    const mb = entero(azar, 2, 90);
    const pasos = entero(azar, 5, 20);
    const estados = Array.from({ length: pasos + 1 }, (_, s) => {
      const hecho = Math.round((s / pasos) * 30);
      return `   ${"━".repeat(hecho)}${" ".repeat(30 - hecho)} ${((mb * s) / pasos).toFixed(1)}/${mb}.0 MB ${entero(azar, 1, 30)}.${entero(azar, 0, 9)} MB/s`;
    });
    lineas.push(`Collecting ${paquete}`, estados.join("\r"));
  }
  lineas.push(`Saved ./wheels (turn ${turno})`);
  return lineas.join("\n");
}

function lecturaDeFichero(azar: Azar, turno: number): string {
  const n = entero(azar, 40, 160);
  const lineas: string[] = [];
  let sangria = 0;
  for (let i = 1; i <= n; i++) {
    const r = azar();
    let codigo: string;
    if (r < 0.1) {
      codigo = `export function ${elegir(azar, PALABRAS)}${elegir(azar, PALABRAS)}(input: ${elegir(azar, ["string", "number", "Order"])}) {`;
      sangria = 1;
    } else if (r < 0.2 && sangria > 0) {
      codigo = "}";
      sangria = 0;
    } else {
      codigo = `${"  ".repeat(sangria)}const ${elegir(azar, PALABRAS)} = await ${elegir(azar, PALABRAS)}.${elegir(azar, PALABRAS)}(${entero(azar, 0, 99)});`;
    }
    lineas.push(`${String(i).padStart(6)}\t${codigo}`);
  }
  lineas.push(`// turn ${turno}`);
  return lineas.join("\n");
}

function grep(azar: Azar, turno: number): string {
  return Array.from(
    { length: entero(azar, 5, 40) },
    () => `src/${elegir(azar, PALABRAS)}/${elegir(azar, PALABRAS)}.ts:${entero(azar, 1, 400)}:  ${frase(azar, entero(azar, 3, 10))}`,
  ).join("\n") + `\n(turn ${turno})`;
}

function diff(azar: Azar, turno: number): string {
  const lineas = [`diff --git a/src/${elegir(azar, PALABRAS)}.ts b/src/${elegir(azar, PALABRAS)}.ts`, "index 3f1c2a..9b8e7d 100644"];
  for (let h = 0; h < entero(azar, 1, 4); h++) {
    lineas.push(`@@ -${entero(azar, 1, 300)},7 +${entero(azar, 1, 300)},8 @@`);
    for (let i = 0; i < entero(azar, 4, 14); i++) {
      lineas.push(`${elegir(azar, [" ", " ", "+", "-"])}  ${frase(azar, entero(azar, 3, 9))};`);
    }
  }
  lineas.push(`// turn ${turno}`);
  return lineas.join("\n");
}

function prosaWeb(azar: Azar, turno: number): string {
  return Array.from({ length: entero(azar, 4, 14) }, () => `${frase(azar, entero(azar, 25, 60))}.`).join("\n\n") + `\n\n(turn ${turno})`;
}

function generar(clase: ClaseDeSalida, azar: Azar, turno: number): SalidaDeHerramienta {
  switch (clase) {
    case "json-indentado":
      return { clase, nombre: "search_tickets", argumentos: `{"query":"${frase(azar, 2)}","page":1}`, contenido: JSON.stringify(registrosDeApi(azar, turno), null, 2) };
    case "json-compacto":
      return { clase, nombre: "search_tickets", argumentos: `{"query":"${frase(azar, 2)}","page":1}`, contenido: JSON.stringify(registrosDeApi(azar, turno)) };
    case "tests-con-color":
      return { clase, nombre: "bash", argumentos: '{"command":"FORCE_COLOR=1 pnpm test"}', contenido: salidaDeTests(azar, turno, true) };
    case "tests-sin-color":
      return { clase, nombre: "bash", argumentos: '{"command":"pnpm test"}', contenido: salidaDeTests(azar, turno, false) };
    case "sondeo-repetido":
      return { clase, nombre: "bash", argumentos: '{"command":"./scripts/wait-for-stack.sh"}', contenido: sondeoRepetido(azar, turno) };
    case "barra-de-progreso":
      return { clase, nombre: "bash", argumentos: '{"command":"pip download -r requirements.txt"}', contenido: barraDeProgreso(azar, turno) };
    case "lectura-de-fichero":
      return { clase, nombre: "read_file", argumentos: `{"file_path":"src/${elegir(azar, PALABRAS)}.ts"}`, contenido: lecturaDeFichero(azar, turno) };
    case "grep":
      return { clase, nombre: "grep", argumentos: `{"pattern":"${elegir(azar, PALABRAS)}","path":"src"}`, contenido: grep(azar, turno) };
    case "diff":
      return { clase, nombre: "bash", argumentos: '{"command":"git diff"}', contenido: diff(azar, turno) };
    case "prosa-web":
      return { clase, nombre: "web_fetch", argumentos: `{"url":"https://docs.example.com/${elegir(azar, PALABRAS)}"}`, contenido: prosaWeb(azar, turno) };
  }
}

function claseAlAzar(azar: Azar, mezcla: Partial<Record<ClaseDeSalida, number>>): ClaseDeSalida {
  const entradas = Object.entries(mezcla) as [ClaseDeSalida, number][];
  const total = entradas.reduce((s, [, w]) => s + w, 0);
  let r = azar() * total;
  for (const [clase, w] of entradas) {
    r -= w;
    if (r < 0) return clase;
  }
  return entradas[entradas.length - 1]![0];
}

/** Un `system` de agente realista: instrucciones y definiciones de herramientas. */
function sistema(azar: Azar): string {
  const reglas = Array.from({ length: 60 }, (_, i) => `${i + 1}. ${frase(azar, entero(azar, 10, 24))}.`);
  const herramientas = ["search_tickets", "bash", "read_file", "grep", "web_fetch"].map((n) => ({
    name: n,
    description: frase(azar, 20),
    input_schema: { type: "object", properties: { query: { type: "string", description: frase(azar, 8) } } },
  }));
  return `You are an autonomous agent.\n\n${reglas.join("\n")}\n\nTools:\n${JSON.stringify(herramientas)}`;
}

/** `n` sesiones del perfil, cada una de `minTurnos`..`maxTurnos` turnos de herramienta. */
export function sesiones(perfil: Perfil, n: number, semilla: number, minTurnos = 15, maxTurnos = 40): Sesion[] {
  const azar = azarSembrado(semilla);
  const salida: Sesion[] = [];
  for (let s = 0; s < n; s++) {
    const turnos = entero(azar, minTurnos, maxTurnos);
    const mensajes: ChatMessage[] = [
      { role: "system", content: sistema(azar) },
      { role: "user", content: `${frase(azar, 30)}?` },
    ];
    const salidas: SalidaDeHerramienta[] = [];
    for (let t = 0; t < turnos; t++) {
      const h = generar(claseAlAzar(azar, MEZCLA[perfil]), azar, t);
      salidas.push(h);
      const id = `call_${s}_${t}`;
      mensajes.push({ role: "assistant", content: frase(azar, entero(azar, 5, 25)), toolCalls: [{ id, name: h.nombre, arguments: h.argumentos }] });
      mensajes.push({ role: "tool", toolCallId: id, name: h.nombre, content: h.contenido });
    }
    salida.push({ perfil, id: `${perfil}-${s}`, mensajes, salidas });
  }
  return salida;
}
