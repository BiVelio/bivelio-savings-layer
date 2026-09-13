#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describirEstadoDeElision } from "./palanca.js";
import { describirEstadoDeEsfuerzo } from "./esfuerzo.js";
import { describirEstadoDeHermano } from "./hermano.js";
import { arrancarGateway } from "./servidor.js";
import { envoltorioDe, esTerminalConEnvoltorio, modoAuthCodex, resolverBinarioWindows, TERMINALES_CON_ENVOLTORIO } from "./envoltorios.js";
import { leerEnrolamiento, planDeAnillo2 } from "./anillo2.js";
import { connect } from "node:net";

/**
 * ¿Hay alguien escuchando en ese puerto de loopback? Se pregunta ANTES de
 * encadenar: mandar el tráfico a un espía muerto son 502 en cada turno y el
 * dueño se queda sin terminal por un fichero que olvidó borrar.
 */
function puertoEscucha(puerto: number, msTope = 300): Promise<boolean> {
  return new Promise((resolver) => {
    const socket = connect({ port: puerto, host: "127.0.0.1" });
    const cerrar = (vivo: boolean) => {
      socket.destroy();
      resolver(vivo);
    };
    socket.setTimeout(msTope, () => cerrar(false));
    socket.once("connect", () => cerrar(true));
    socket.once("error", () => cerrar(false));
  });
}
import { doctor } from "./doctor.js";
import { instalarAgentsMd, instalarSkill } from "./skill.js";
import { soportaZstd } from "./medidor.js";
import { BV_SALA_VERSION } from "../src/index.js";

/**
 * El CLI de la pasarela:
 *
 *   `bvsala gateway [--puerto N]` — el medidor local para herramientas que
 *   respetan un base URL (Claude Code y el anillo de terminales compatibles).
 *
 *   `bvsala claude|codex|goose|qwen [args…]` — cero configuración: arranca el
 *   gateway en un puerto efímero, lanza el terminal apuntándole y lo apaga al
 *   salir (tabla en gateway/envoltorios.ts).
 *
 *   `bvsala doctor [--puerto N]` — detecta terminales instalados e imprime el
 *   bloque de configuración exacto de cada uno (gateway/doctor.ts).
 */
const [, , comando, ...resto] = process.argv;

function ayuda(): void {
  console.log(`bvsala ${BV_SALA_VERSION} — BiVelio Savings Layer

Comandos:
  gateway [--puerto N]   Proxy local medidor (por defecto 8402) para terminales que
                         respetan un base URL: Claude Code, opencode, Goose, Crush…
  claude [args…]         Lanza Claude Code a través del gateway, sin configurar nada.
  codex [args…]          Lanza Codex CLI a través del gateway (API key: api.openai.com;
                         auth ChatGPT: chatgpt.com/backend-api/codex — se mide, no se monetiza).
  goose [args…]          Lanza Goose (ANTHROPIC_HOST) a través del gateway.
  qwen [args…]           Lanza Qwen Code (ANTHROPIC_BASE_URL) a través del gateway.
  doctor [--puerto N]    Detecta terminales instalados e imprime su configuración exacta.
  skill [--codex] [--proyecto] [--forzar]
                         Instala el skill «savings-mode» de Claude Code (~/.claude/skills;
                         con --proyecto, en .claude/skills del directorio actual): salida
                         tersa + herramientas quirúrgicas para estirar los topes de
                         suscripción. Con --codex, la misma disciplina como bloque marcado
                         de AGENTS.md (~/.codex; con --proyecto, ./AGENTS.md) — Codex no
                         tiene skills y AGENTS.md va siempre activo. Su efecto se mide con
                         el gateway, no se promete.

Entorno:
  BIVELIO_SERVICE_KEY    Clave de servicio (bvk_…): habilita metering + asiento.
  BVSALA_SEAT_ID         Identidad de asiento estable por réplica (opcional).
  BVSALA_GATEWAY_UPSTREAM  Upstream alternativo (por defecto el del terminal).
  BVSALA_GATEWAY_COALESCE  =1 enciende la coalescencia de duplicados (F2, experimental).
  BVSALA_GATEWAY_SHADOW  =1 enciende el carril sombra de la elisión (S2): calcula qué
                         habría ahorrado la política v0 SIN tocar el tráfico y lo
                         reporta aparte (jamás entra en la comisión).
  BVSALA_GATEWAY_ELISION =0 APAGA las palancas del proveedor (S4a), armadas por
                         defecto. Cada una se enciende de verdad solo si la licencia de
                         tu organización trae su feature (consulta fail-closed):
                           · context_elision  — ajusta SOLO el bloque context_management
                             de cada /v1/messages; el borrado lo hace el proveedor.
                           · cache_ttl_tuning — rebaja el TTL de escritura de caché de
                             1h (2x el precio de entrada) a 5m (1,25x) mientras la sesión
                             siga caliente. NO toca un solo token que el modelo lea:
                             cambia la tarifa, no el contenido. En el corpus del espía
                             el 99,1 % de los turnos encadena en menos de 5 minutos, y
                             ese sobreprecio era el 8,0 % de la factura.
                         Ante cualquier duda, la petición viaja intacta. (Hasta 0.4.13
                         la bandera era al revés: «=1 arma»; en un A/B pásala SIEMPRE
                         explícita, =1 o =0, y no dependerás de la versión instalada.)
  BVSALA_GATEWAY_MODELO_HERMANO
                         =1 sirve claude-fable-5 con claude-fable-5-1 (palanca C): misma
                         tarifa de entrada, salida y escritura de caché; la LECTURA de
                         caché baja de 0,001 a 0,00025 por 1K tokens (catálogo). El
                         ahorro es una resta de dos precios sobre el mismo usage:
                         se mide sin A/B y entra en el titular medido del panel.
                         Solo si la licencia trae sibling_model_routing (fail-closed).
                         CAMBIA el model que ves en la respuesta (/cost, /status), y
                         encenderlo a mitad de un hilo paga UNA escritura fría del
                         prefijo (cada modelo tiene su caché): arráncalo con el terminal.
                         Apagar = quitar la variable o =0.
  BVSALA_GATEWAY_ESFUERZO
                         =low|medium|high|xhigh|max arma el esfuerzo por turno (palanca D):
                         añade al final de cada /v1/messages un mensaje con
                         output_config.effort, sin tocar la raíz (no reinicia la caché de
                         prefijo). Solo si la licencia trae per_turn_effort (fail-closed)
                         y solo con claude-fable-5-1, claude-mythos-5-1 y claude-opus-5;
                         con otro modelo la petición viaja intacta. Es la única palanca
                         que puede tocar la calidad de la respuesta: va APAGADA por
                         defecto y aún no está medida contra la verja de calidad.
  BVSALA_CODEX_AUTH      api-key | chatgpt — fuerza el modo de auth de Codex.
  BVSALA_GATEWAY_LOG     =1 enseña el log por petición también dentro de los envoltorios
                         (por defecto va silenciado para no pisar el TUI; mira el panel).
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1  (Claude Code, solo API key) tus modelos en /model.

El gateway nunca corta el tráfico: sin clave o con la ingesta caída, reenvía y avisa.
Tus prompts jamás salen de tu máquina — solo cuentas y coste. Más: savings.bivelio.com`);
}

const esEnvoltorio = esTerminalConEnvoltorio(comando);
if (comando !== "gateway" && comando !== "doctor" && comando !== "skill" && !esEnvoltorio) {
  ayuda();
  process.exit(comando === undefined || comando === "help" || comando === "--help" ? 0 : 1);
}

if (comando === "skill") {
  // El SKILL.md empaquetado vive en <raíz>/skills/; desde dist/gateway/bin.js
  // la raíz es ../../, y ejecutado con tsx desde gateway/ es ../ — se prueban
  // ambas por existencia en vez de adivinar el layout.
  const aqui = dirname(fileURLToPath(import.meta.url));
  const opciones = {
    origenes: [join(aqui, "..", ".."), join(aqui, "..")],
    home: homedir(),
    cwd: process.cwd(),
    proyecto: resto.includes("--proyecto"),
    forzar: resto.includes("--forzar"),
    fs: {
      existe: existsSync,
      leer: (ruta: string) => readFileSync(ruta, "utf8"),
      escribir: (ruta: string, contenido: string) => writeFileSync(ruta, contenido),
      crearDir: (ruta: string) => mkdirSync(ruta, { recursive: true }),
    },
  };
  // --codex: la misma disciplina como bloque marcado de AGENTS.md (Codex no
  // tiene skills); sin él, el skill de Claude Code de siempre.
  const r = resto.includes("--codex") ? instalarAgentsMd(opciones) : instalarSkill(opciones);
  console.log(r.mensaje);
  process.exit(r.ok ? 0 : 1);
}

// Envoltorios: puerto efímero; `gateway`: 8402 o --puerto (0 = efímero, lo usa
// el arnés F2); `doctor`: 1–65535 (imprime URLs — un puerto 0 no señala nada).
const idx = resto.indexOf("--puerto");
const puerto = esEnvoltorio ? 0 : idx >= 0 ? Number(resto[idx + 1]) : 8402;
if (!Number.isInteger(puerto) || (comando === "doctor" ? puerto < 1 : puerto < 0) || puerto > 65535) {
  console.error(`[bvsala ${comando}] puerto inválido: ${resto[idx + 1]}`);
  process.exit(1);
}

if (comando === "doctor") {
  if (resto.includes("--write")) {
    console.error("[bvsala doctor] --write todavía no existe: el doctor solo imprime; copia el bloque a mano.");
    process.exit(1);
  }
  const informe = await doctor(puerto);
  console.log(informe.texto);
  process.exit(0);
}

// La tabla decide destino y variables; bin.ts solo ejecuta. El modo de auth de
// Codex se lee por EXISTENCIA/enum de ~/.codex/auth.json — jamás se registra.
const envoltorio = esEnvoltorio
  ? envoltorioDe(comando, 0, resto, {
      modoCodex:
        comando === "codex"
          ? modoAuthCodex({ leerAuth: () => readFileSync(join(homedir(), ".codex", "auth.json"), "utf8") })
          : undefined,
    })
  : null;

const serviceAccountKey = process.env.BIVELIO_SERVICE_KEY;
// En modo envoltorio el hijo ES un TUI dueño de la terminal: el log por
// petición del gateway se imprimía encima y se pisaban las palabras (visto en
// vivo con el diálogo de confianza de Claude Code). Silencio por defecto —
// el sitio para mirar es el panel — y BVSALA_GATEWAY_LOG=1 lo recupera para
// depurar. `bvsala gateway` a secas sigue logueando: ahí el log es el producto.
const silencioso = esEnvoltorio && process.env.BVSALA_GATEWAY_LOG !== "1";
// Anillo 2 · el encadenado al espía NO puede depender de cómo se lanzó la
// sesión: vivía en una función del .zshrc y toda sesión nacida por otro camino
// se medía pero no entraba en el corpus (2026-09-06: las dos sesiones vivas,
// sin encadenar). El fichero lo hereda cualquier arranque. Solo la casa lo
// tiene. Codex queda fuera: su upstream no habla el protocolo del espía.
const enrolamientoAnillo2 = envoltorio?.upstream
  ? null
  : leerEnrolamiento(() =>
      readFileSync(process.env.BVSALA_ANILLO2_FICHERO ?? join(homedir(), ".bvsala", "anillo2.json"), "utf8"),
    );
const planAnillo2 = planDeAnillo2({
  enrolamiento: enrolamientoAnillo2,
  espiaVivo: enrolamientoAnillo2 !== null && (await puertoEscucha(enrolamientoAnillo2.espia)),
  upstreamEnv: process.env.BVSALA_GATEWAY_UPSTREAM,
  elisionEnv: process.env.BVSALA_GATEWAY_ELISION,
  hoyUtcIso: new Date().toISOString().slice(0, 10),
});
const upstreamPedido = process.env.BVSALA_GATEWAY_UPSTREAM ?? planAnillo2.upstream;
const elisionPedida = process.env.BVSALA_GATEWAY_ELISION ?? planAnillo2.elision;

const arranque = await arrancarGateway({
  puerto,
  ...(silencioso ? { log: () => {} } : {}),
  ...(serviceAccountKey ? { serviceAccountKey } : {}),
  ...(process.env.BVSALA_SEAT_ID ? { seatId: process.env.BVSALA_SEAT_ID } : {}),
  ...(upstreamPedido
    ? { upstream: upstreamPedido }
    : envoltorio?.upstream
      ? { upstream: envoltorio.upstream }
      : {}),
  ...(process.env.BVSALA_GATEWAY_COALESCE === "1" ? { coalescer: true } : {}),
  ...(process.env.BVSALA_GATEWAY_SHADOW === "1" ? { sombra: true } : {}),
  // S4a · el CANAL de entitlements, del que cuelgan las dos palancas. ARMADO
  // POR DEFECTO: el ahorro en el terminal tiene que funcionar SOLO. El gate
  // REAL son los features `context_elision` y `cache_ttl_tuning` en la licencia
  // de la org (fail-closed). `BVSALA_GATEWAY_ELISION=0` sigue siendo el freno
  // de emergencia que apaga las dos de golpe. `serviceAccountKey` es
  // estructuralmente necesaria (identidad de org para el entitlement).
  elision: elisionPedida !== "0",
  // S4a-B · los DIALES, APAGADOS desde el 2026-09-09. Hasta hoy iban en la
  // misma bandera que la rebaja de TTL, así que no se podía apagar la palanca
  // que pierde sin apagar la que gana. Medida en pérdida por tres vías
  // independientes (simulador honesto +49 % de coste, carril sombra en
  // producción los días 08 y 09, y R = 4,05 frente a R* = 0,0127 en
  // fable-5-1). El brazo del anillo 2 ya NO las arma: mientras el A/B calcule
  // el brazo una sola vez al arrancar el proceso, una sesión que cruza la
  // medianoche corre con la bandera de ayer y no hay observación de control
  // limpia. Se encienden a mano y a sabiendas.
  ...(process.env.BVSALA_GATEWAY_DIALES_ELISION === "1" ? { dialesElision: true } : {}),
  // Palanca C · el MODELO HERMANO (decisión del dueño, 2026-09-09: «haz el C»).
  // Opt-in explícito del cliente porque cambia el `model` de la respuesta; el
  // feature `sibling_model_routing` de la licencia sigue verjando (fail-closed)
  // y `BVSALA_GATEWAY_ELISION=0` la apaga con las demás. NO la arma el anillo 2:
  // el ahorro se mide sin contrafactual, no hay A/B que hacer.
  ...(process.env.BVSALA_GATEWAY_MODELO_HERMANO === "1" ? { modeloHermano: true } : {}),
  // Palanca D · el techo de esfuerzo por turno. Es del OPERADOR: la palanca no
  // adivina qué turno merece pensar menos. Solo cambia la VÍA por la que se
  // aplica —un mensaje añadido, que NO reinicia la caché de prefijo, en vez del
  // campo de la raíz, que sí— y verja por modelo, porque fuera de fable-5-1,
  // mythos-5-1 y opus-5 es un 400.
  ...(process.env.BVSALA_GATEWAY_ESFUERZO ? { esfuerzo: process.env.BVSALA_GATEWAY_ESFUERZO } : {}),
  // Solo para desarrollo y pruebas: redirigir la ingesta de metering. En
  // producción no se toca y el gateway habla con savings.bivelio.com.
  ...(process.env.BVSALA_METERING_URL ? { meteringUrl: process.env.BVSALA_METERING_URL } : {}),
});

const upstreamEfectivo = upstreamPedido ?? envoltorio?.upstream ?? "https://api.anthropic.com";
console.log(`[bvsala gateway] v${BV_SALA_VERSION} escuchando en http://127.0.0.1:${arranque.puerto} → ${upstreamEfectivo}`);
console.log(`[bvsala gateway] medición: ${serviceAccountKey ? "ACTIVA (clave de servicio presente)" : "APAGADA (falta BIVELIO_SERVICE_KEY)"}`);
{
  // El brazo del A/B (anillo 2) dicho en voz alta al arrancar: un día entero de
  // «palanca» corrió sin clave en un terminal viejo y fue control en silencio.
  const estado = describirEstadoDeElision(
    elisionPedida,
    serviceAccountKey !== undefined,
    process.env.BVSALA_GATEWAY_DIALES_ELISION === "1",
  );
  (estado.aviso ? console.error : console.log)(`[bvsala gateway] ${estado.linea}`);
  // Palanca C dicha en voz alta, por la misma razón: una bandera puesta en un
  // terminal sin clave (o con el canal cerrado) es control en silencio.
  const estadoHermano = describirEstadoDeHermano(
    process.env.BVSALA_GATEWAY_MODELO_HERMANO,
    serviceAccountKey !== undefined,
    elisionPedida !== "0",
  );
  (estadoHermano.aviso ? console.error : console.log)(`[bvsala gateway] ${estadoHermano.linea}`);
  // Palanca D dicha en voz alta por la misma razón que las otras: una palanca
  // que se cree encendida y no lo está es la trampa muda que ya costó un A/B.
  const estadoEsfuerzo = describirEstadoDeEsfuerzo(
    process.env.BVSALA_GATEWAY_ESFUERZO,
    serviceAccountKey !== undefined,
    elisionPedida !== "0",
  );
  (estadoEsfuerzo.aviso ? console.error : console.log)(`[bvsala gateway] ${estadoEsfuerzo.linea}`);
  if (planAnillo2.linea) {
    (planAnillo2.aviso ? console.error : console.log)(`[bvsala gateway] ${planAnillo2.linea}`);
  }
}
if (process.env.BVSALA_GATEWAY_UPSTREAM && envoltorio?.upstream && process.env.BVSALA_GATEWAY_UPSTREAM !== envoltorio.upstream) {
  // Un BVSALA_GATEWAY_UPSTREAM heredado del .zshrc (p.ej. el de Claude Code)
  // mandaría el tráfico de Codex a un host que no habla su protocolo.
  console.error(
    `[bvsala ${comando}] AVISO: BVSALA_GATEWAY_UPSTREAM=${process.env.BVSALA_GATEWAY_UPSTREAM} pisa el upstream de este terminal ` +
      `(${envoltorio.upstream}). Si no es lo que quieres, quita la variable.`,
  );
}
if (comando === "codex" && !soportaZstd()) {
  console.error(
    `[bvsala codex] AVISO: este Node (${process.version}) no descomprime zstd y Codex manda el cuerpo en zstd: ` +
      "el tráfico pasa pero NO se mide. Usa Node ≥ 22.15.",
  );
}

if (envoltorio && esEnvoltorio) {
  // La tabla se calculó con puerto 0 (aún no había gateway): se recalcula con
  // el puerto REAL. Hereda la terminal entera (stdio inherit: el TUI funciona
  // tal cual) y muere con el hijo.
  const final = envoltorioDe(comando, arranque.puerto, resto, {
    ...(envoltorio.upstream ? { modoCodex: envoltorio.upstream.includes("chatgpt.com") ? "chatgpt" : "api-key" } : {}),
  });
  if (final.nota) console.log(`[bvsala ${comando}] ${final.nota}`);
  // Windows: spawn no resuelve shims .cmd/.bat y lanzarlos con args no es
  // seguro (ver resolverBinarioWindows). El .exe se ejecuta por ruta directa;
  // con solo-shim nos negamos con guía en vez de fallar con un ENOENT mudo.
  let binAEjecutar = final.bin;
  if (process.platform === "win32") {
    const resuelto = resolverBinarioWindows(final.bin);
    if (resuelto.tipo === "exe") {
      binAEjecutar = resuelto.ruta;
    } else if (resuelto.tipo === "solo-shim") {
      console.error(
        `[bvsala ${comando}] \`${final.bin}\` está instalado como shim de npm (${resuelto.ruta}) y Windows no puede ` +
          "lanzarlo de forma segura con argumentos (CVE-2024-27980). Instálalo con su instalador nativo " +
          `(deja un ${final.bin}.exe en el PATH) o usa la receta manual de docs/terminales/.`,
      );
      await arranque.cerrar();
      process.exit(127);
    }
  }
  const hijo = spawn(binAEjecutar, final.args, { stdio: "inherit", env: { ...process.env, ...final.env } });
  hijo.on("error", (err) => {
    console.error(`[bvsala ${comando}] no se pudo lanzar \`${final.bin}\`: ${String(err)}. ¿Está instalado y en el PATH?`);
    void arranque.cerrar().then(() => process.exit(127));
  });
  hijo.on("exit", (code, signal) => {
    void arranque.cerrar().then(() => process.exit(code ?? (signal ? 1 : 0)));
  });
} else {
  console.log(
    `[bvsala gateway] apunta tu terminal (o usa \`bvsala ${TERMINALES_CON_ENVOLTORIO.join("|")}\`):  ` +
      `ANTHROPIC_BASE_URL=http://127.0.0.1:${arranque.puerto} claude   ·   bvsala doctor para el resto`,
  );
}

const parar = async (): Promise<void> => {
  await arranque.cerrar();
  process.exit(0);
};
process.on("SIGINT", () => void parar());
process.on("SIGTERM", () => void parar());
