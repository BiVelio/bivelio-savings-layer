/**
 * VERJA DE FIDELIDAD DE LA ELISIÓN POR SUPERSESIÓN. Run: pnpm fidelidad
 * ---------------------------------------------------------------------------
 * La elisión por supersesión BORRA una salida de herramienta vieja SOLO cuando
 * una más nueva vuelve a pedir el MISMO recurso (misma herramienta + mismos
 * argumentos) — la única redundancia demostrable sin adivinar la pregunta. Es lo
 * que corre EN VIVO (`ELISION_EN_VIVO`); reemplaza a la v0 (edad×tamaño), que el
 * carril sombra sigue midiendo como referencia pero que esta verja probó insegura
 * (borraba síntesis y el juez la cazaba). Bajar la factura del cliente no vale
 * NADA si degrada la
 * respuesta —«los clientes lo notan a final de factura»—, y hoy no había ninguna
 * red que lo comprobara: el banco de corpus (`sombra-corpus.ts`) es CIEGO a la
 * salida (no llama al modelo, tira el contenido por privacidad) y el único sitio
 * donde se ejercita la calidad contra el modelo es el A/B sintético de
 * `ab-live.ts`. Esta verja es esa red, específica de la elisión: reproduce el MISMO
 * contexto con y sin elidir A TRAVÉS DEL MODELO y juzga que la respuesta elidida
 * es AL MENOS tan correcta y completa como la no elidida.
 *
 * REGLA DURA: el borrado real en vivo (`ELISION_EN_VIVO` en `pipeline.ts`) NO se
 * enciende hasta que esta verja esté en verde (fidelidad ≥ suelo, por defecto
 * 0,999) sobre las formas que la elisión toca. Si algún caso no llega al suelo,
 * ESE caso se excluye del borrado (keep-floor más alto o exención por tipo), nunca
 * se publica un borrado que degrade. Es la salvaguarda que el dueño exige.
 *
 * VETO DE TRUNCADO PRIMERO (misma doctrina que `verja-de-calidad.ts`): una
 * respuesta cortada por el tope no es una respuesta, y pagar un juez para que lo
 * confirme es gasto sobre una pregunta ya contestada — el veto va delante.
 *
 * MODOS (idénticos a `ab-live.ts`):
 *   LIVE  — `BVSALA_DEMO_BASE_URL` (+ `_API_KEY`, `_MODEL`) a un endpoint
 *           compatible con OpenAI. Opcional: juez ciego en `BVSALA_JUDGE_BASE_URL`
 *           (+ `_API_KEY`, `_MODEL`); sin juez, la verja solo puede aplicar el veto
 *           de truncado y la igualdad exacta, y lo DICE.
 *   MOCK  — sin `BVSALA_DEMO_BASE_URL`: sin red. Ejercita la fontanería entera
 *           (selección → reescritura → llamada) de forma determinista para probar
 *           que el arnés corre, y marca el resultado como «SOLO FONTANERÍA — no es
 *           una afirmación de fidelidad».
 *
 * ENV: BVSALA_FIDELITY_REPS (reps por caso, def. 5), BVSALA_FIDELITY_FLOOR
 *      (suelo, def. 0.999), BVSALA_FIDELITY_MAX_TOKENS (tope de salida, def. 500),
 *      BVSALA_DEMO_KEEP_PREFIX.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

import {
  OpenAICompatibleProvider,
  type Provider,
  type ChatMessage,
} from "../src/index.js";
import {
  seleccionarSupersesion,
  aplicarElision,
  KEEP_TOOL_RESULTS,
  MUNON_ELISION,
} from "../src/pipeline/elision.js";
import {
  conReintentos,
  proveedorDelBanco,
  transporteDeModelo,
  type ConfigDeTransporte,
} from "./transporte.js";
import { cortadaPorElTope } from "./verja-de-calidad.js";

// ── Entorno / configuración ──────────────────────────────────────────────────
const CFG: ConfigDeTransporte = {
  baseUrl: process.env.BVSALA_DEMO_BASE_URL,
  apiKey: process.env.BVSALA_DEMO_API_KEY,
  keepPrefix: process.env.BVSALA_DEMO_KEEP_PREFIX === "1",
};
const MODEL = process.env.BVSALA_DEMO_MODEL ?? "gpt-4o-mini";
const MODE: "LIVE" | "MOCK" = transporteDeModelo(MODEL, CFG) === "mock" ? "MOCK" : "LIVE";
const REPS = intEnv(process.env.BVSALA_FIDELITY_REPS, 5);
const FLOOR = Number(process.env.BVSALA_FIDELITY_FLOOR ?? 0.999);
const MAX_TOKENS = intEnv(process.env.BVSALA_FIDELITY_MAX_TOKENS, 500);

function intEnv(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

const provider: Provider = conReintentos(proveedorDelBanco(MODEL, CFG));

const judgeBase = process.env.BVSALA_JUDGE_BASE_URL;
const judgeModel = process.env.BVSALA_JUDGE_MODEL ?? MODEL;
const judge: Provider | null =
  MODE === "LIVE" && judgeBase
    ? conReintentos(
        new OpenAICompatibleProvider({
          baseUrl: judgeBase,
          ...(process.env.BVSALA_JUDGE_API_KEY ? { apiKey: process.env.BVSALA_JUDGE_API_KEY } : {}),
          stripProviderPrefix: !CFG.keepPrefix,
          requireUsage: false,
        }),
      )
    : null;

// ── Construcción de transcripciones de fidelidad ─────────────────────────────
/** Un cuerpo de tool_result «gordo» (>1 KB) con una línea de HECHO etiquetada y
 *  relleno realista alrededor. El hecho es lo único que una pregunta puede
 *  necesitar; el relleno es lo que hace al bloque candidato por tamaño. */
function cuerpoGordo(etiqueta: string, hecho: string, kb = 3): string {
  const relleno = Array.from(
    { length: kb * 8 },
    (_, i) => `// ${etiqueta} línea ${i}: contexto de andamiaje, valor auxiliar ${i * 7 + 3}`,
  ).join("\n");
  return `// ${etiqueta}\n${hecho}\n${relleno}\n`;
}

interface CasoFidelidad {
  name: string;
  /** Por qué está en la verja y qué esperamos de él. */
  nota: string;
  messages: ChatMessage[];
  /** La pregunta final que el modelo debe responder con el contexto (elidido o no). */
  pregunta: string;
}

/** Una ronda de agente: la herramienta que se llamó (con SUS argumentos reales
 *  — el `path` leído, el `pattern` buscado) y el cuerpo que devolvió. Los
 *  argumentos son la identidad de recurso: dos rondas con la MISMA herramienta y
 *  los MISMOS argumentos hablan del mismo recurso, y la supersesión elide la
 *  vieja. Por defecto `read_file` de un `path` propio de la ronda. */
interface Ronda {
  cuerpo: string;
  tool?: string;
  args?: Record<string, unknown>;
}

/** Un assistant con tool_call (nombre + argumentos JSON) + su tool_result. */
function ronda(j: number, r: Ronda): ChatMessage[] {
  const tool = r.tool ?? "read_file";
  const args = JSON.stringify(r.args ?? { path: `archivo-${j}.ts` });
  return [
    { role: "assistant", content: "", toolCalls: [{ id: `c${j}`, name: tool, arguments: args }] },
    { role: "tool", content: r.cuerpo, toolCallId: `c${j}`, name: tool },
  ];
}

/** Arma una transcripción: intro de usuario + N rondas + pregunta final. */
function transcripcion(intro: string, rondas: Ronda[], pregunta: string): ChatMessage[] {
  const m: ChatMessage[] = [{ role: "user", content: intro }];
  rondas.forEach((r, j) => m.push(...ronda(j, r)));
  m.push({ role: "user", content: pregunta });
  return m;
}
/** Azúcar: una ronda `read_file` de un `path` dado. */
const leer = (path: string, cuerpo: string): Ronda => ({ cuerpo, tool: "read_file", args: { path } });

const CASOS: CasoFidelidad[] = [
  // 1. POSITIVO (DEBE llegar al suelo). Misma lectura SUPERSEDIDA: `config.ts` se
  //    lee dos veces (mismo `path`), y la lectura vieja queda obsoleta tras la
  //    reciente. La pregunta va sobre el estado ACTUAL. La supersesión elide SOLO
  //    la lectura vieja de `config.ts` —recurso probadamente re-pedido—; los
  //    módulos (paths distintos) y la relectura vigente se conservan.
  {
    name: "superseded-read",
    nota: "config.ts releído (mismo path); la lectura vieja está superada y la pregunta va sobre el estado actual",
    messages: transcripcion(
      "Estoy refactorizando el módulo de configuración. Ayúdame a revisarlo.",
      [
        leer("config.ts", cuerpoGordo("config.ts (v1, OBSOLETA)", "export const TIMEOUT_MS = 1000; // valor viejo, ya cambiado", 3)),
        leer("notas-viejas.md", cuerpoGordo("notas-viejas.md", "TODO antiguo ya resuelto: subir el timeout", 3)),
        ...Array.from({ length: 6 }, (_, i) =>
          leer(`modulo-${i}.ts`, cuerpoGordo(`modulo-${i}.ts`, `// módulo auxiliar ${i}, sin relación con el timeout`, 3)),
        ),
        leer("config.ts", cuerpoGordo("config.ts (v2, ACTUAL)", "export const TIMEOUT_MS = 5000; // valor ACTUAL tras el cambio", 3)),
        leer("config.test.ts", cuerpoGordo("config.test.ts", "expect(TIMEOUT_MS).toBe(5000); // confirma el valor actual", 3)),
      ],
      "¿Cuál es el valor ACTUAL de TIMEOUT_MS en config.ts? Responde solo el número.",
    ),
    pregunta: "¿Cuál es el valor ACTUAL de TIMEOUT_MS en config.ts? Responde solo el número.",
  },

  // 2. POSITIVO (DEBE llegar al suelo). DOS recursos, cada uno releído: `a.ts` y
  //    `b.ts` se leen dos veces con estado cambiado. La supersesión elide las DOS
  //    lecturas viejas y conserva las dos vigentes. La pregunta necesita el estado
  //    actual de ambos → elidir lo superado no debería cambiar la respuesta.
  {
    name: "multi-recurso-supersedido",
    nota: "dos archivos releídos (a.ts, b.ts); las dos lecturas viejas están superadas; la pregunta va sobre el estado actual de ambos",
    messages: transcripcion(
      "Revisa el estado de estos dos ficheros mientras itero sobre ellos.",
      [
        leer("a.ts", cuerpoGordo("a.ts (v1)", "export const RETRIES = 1; // viejo", 3)),
        leer("b.ts", cuerpoGordo("b.ts (v1)", "export const BUFFER = 64; // viejo", 3)),
        ...Array.from({ length: 4 }, (_, i) =>
          leer(`ruido-${i}.ts`, cuerpoGordo(`ruido-${i}.ts`, `// sin relación ${i}`, 3)),
        ),
        leer("a.ts", cuerpoGordo("a.ts (v2, ACTUAL)", "export const RETRIES = 7; // ACTUAL", 3)),
        leer("b.ts", cuerpoGordo("b.ts (v2, ACTUAL)", "export const BUFFER = 512; // ACTUAL", 3)),
      ],
      "Da los valores ACTUALES de RETRIES (a.ts) y BUFFER (b.ts). Responde 'RETRIES=<n>, BUFFER=<n>'.",
    ),
    pregunta: "Da los valores ACTUALES de RETRIES (a.ts) y BUFFER (b.ts). Responde 'RETRIES=<n>, BUFFER=<n>'.",
  },

  // 3. DECLINADO POR DISEÑO (elididos=0 → fuera del veredicto). Búsquedas viejas
  //    con consultas DISTINTAS (`error`, `catch`) superadas por una definitiva
  //    (`handleNetworkError`). v0 las borraba; la supersesión NO —consultas
  //    distintas no son el mismo recurso, no hay redundancia demostrable—, así que
  //    deja ese ahorro seguro sobre la mesa. Aquí se mide que NO toca nada.
  {
    name: "stale-search-distinta-consulta",
    nota: "grep con consultas distintas: NO es supersesión (recursos distintos); la política declina y no elide → ahorro seguro no capturado",
    messages: transcripcion(
      "Busca dónde se define el manejador de errores de red.",
      [
        { tool: "grep", args: { pattern: "error" }, cuerpo: cuerpoGordo("grep 'error' (viejo)", "// muchos falsos positivos", 3) },
        { tool: "grep", args: { pattern: "catch" }, cuerpo: cuerpoGordo("grep 'catch' (viejo)", "// ruido", 3) },
        ...Array.from({ length: 6 }, (_, i) =>
          leer(`archivo-irrelevante-${i}.ts`, cuerpoGordo(`archivo-irrelevante-${i}.ts`, `// no relacionado ${i}`, 3)),
        ),
        { tool: "grep", args: { pattern: "handleNetworkError" }, cuerpo: cuerpoGordo("grep 'handleNetworkError' (DEFINITIVO)", "src/net/retry.ts:42 → export function handleNetworkError(e) { ... }", 3) },
      ],
      "¿En qué archivo y línea se define handleNetworkError? Responde archivo:línea.",
    ),
    pregunta: "¿En qué archivo y línea se define handleNetworkError? Responde archivo:línea.",
  },

  // 4. LA FRONTERA QUE ROMPÍA v0, AHORA INTACTA (elididos=0 → fuera del veredicto,
  //    y ese es el punto). Síntesis que necesita un dato de CADA resultado, todos
  //    de recursos DISTINTOS. v0 borraba los más viejos y la verja lo cazaba con
  //    fidelidad 0. La supersesión NO elide nada aquí (ningún recurso se re-pidió),
  //    así que el caso que hacía inseguro el borrado queda demostradamente sin tocar.
  {
    name: "sintesis-recursos-distintos",
    nota: "síntesis sobre recursos distintos (ninguno re-pedido): la supersesión NO elide → el caso que rompía v0 queda intacto",
    messages: transcripcion(
      "Recopila las métricas de latencia de cada servicio que vaya leyendo.",
      Array.from({ length: KEEP_TOOL_RESULTS + 2 }, (_, i) =>
        leer(`servicio-${i}/metrics.json`, cuerpoGordo(`servicio-${i}/metrics.json`, `LATENCIA_${i}_MS = ${100 + i * 10}`, 3)),
      ),
      `Suma LATENCIA_0_MS … LATENCIA_${KEEP_TOOL_RESULTS + 1}_MS de los ${KEEP_TOOL_RESULTS + 2} servicios y da el total. Responde solo el número.`,
    ),
    pregunta: `Suma LATENCIA_0_MS … LATENCIA_${KEEP_TOOL_RESULTS + 1}_MS de los ${KEEP_TOOL_RESULTS + 2} servicios y da el total. Responde solo el número.`,
  },

  // 5. CONTROL (elididos=0). Sesión corta de recursos distintos: nada se re-pide →
  //    la supersesión no elide → contexto idéntico → la respuesta no puede cambiar.
  {
    name: "sesion-corta-control",
    nota: "control: recursos distintos, ninguno re-pedido → no elide nada → contexto idéntico",
    messages: transcripcion(
      "Lee estos pocos archivos y dime qué hacen.",
      Array.from({ length: KEEP_TOOL_RESULTS - 2 }, (_, i) =>
        leer(`util-${i}.ts`, cuerpoGordo(`util-${i}.ts`, `// utilidad ${i}: función pura de formateo`, 3)),
      ),
      "¿Qué tipo de funciones son las utilidades que has leído? Una frase.",
    ),
    pregunta: "¿Qué tipo de funciones son las utilidades que has leído? Una frase.",
  },
];

// ── Ejecución ────────────────────────────────────────────────────────────────
async function responder(messages: ChatMessage[]): Promise<{ text: string; cortada: boolean }> {
  const res = await provider.generate({ model: MODEL, messages, maxOutputTokens: MAX_TOKENS, temperature: 0 });
  return { text: res.text ?? "", cortada: cortadaPorElTope(res.finishReason) };
}

/** Juez ciego: ¿es la respuesta elidida AL MENOS tan correcta/completa como la
 *  base, sin regresión factual? Aleatoriza el orden para matar el sesgo de
 *  posición. Sin juez configurado, devuelve null (indeciso). */
async function juezEquivalente(base: string, elidida: string, tarea: string): Promise<boolean | null> {
  if (!judge) return null;
  const flip = (tarea.length + base.length) % 2 === 0;
  const uno = flip ? elidida : base;
  const dos = flip ? base : elidida;
  const res = await judge.generate({
    model: judgeModel,
    messages: [
      { role: "system", content: 'You are a strict evaluator. Reply ONLY with compact JSON {"equivalent":bool}.' },
      {
        role: "user",
        content:
          `Task: ${tarea}\n\nResponse 1:\n${uno}\n\nResponse 2:\n${dos}\n\n` +
          `Is Response ${flip ? "1" : "2"} at least as correct and complete as the other, with no factual regression? JSON only.`,
      },
    ],
    maxOutputTokens: 20,
    temperature: 0,
  });
  try {
    return !!JSON.parse(res.text.trim()).equivalent;
  } catch {
    return /"equivalent"\s*:\s*true/.test(res.text);
  }
}

interface ResultadoCaso {
  name: string;
  nota: string;
  elididos: number;
  bytesElididos: number;
  reps: number;
  pasan: number;
  fidelidad: number;
  gate: string;
  detalle: string[];
}

async function correrCaso(c: CasoFidelidad): Promise<ResultadoCaso> {
  const eleccion = seleccionarSupersesion(c.messages); // elide solo recursos re-pedidos
  const tratado = aplicarElision(c.messages, eleccion.indices);
  const detalle: string[] = [];
  let pasan = 0;

  // Caso sin elisión (control): contexto idéntico, no hay nada que degradar.
  if (eleccion.indices.length === 0) {
    return {
      name: c.name, nota: c.nota, elididos: 0, bytesElididos: 0,
      reps: REPS, pasan: REPS, fidelidad: 1,
      gate: "sin-elision(contexto-identico)",
      detalle: ["el suelo de fidelidad no elidió nada → base y tratado son el mismo contexto"],
    };
  }

  for (let r = 0; r < REPS; r++) {
    const base = await responder(c.messages);
    const elidida = await responder(tratado);

    // 1. Veto de truncado PRIMERO. Solo importa el brazo elidido (el que la capa
    //    manda en vivo); si la base se corta, la comparación no es justa y se anota.
    if (elidida.cortada) {
      detalle.push(`rep ${r}: FALLA — la respuesta elidida se cortó por el tope (truncated)`);
      continue;
    }
    if (base.cortada) {
      detalle.push(`rep ${r}: base cortada por el tope; sube BVSALA_FIDELITY_MAX_TOKENS`);
    }

    // 2. Igualdad exacta (barata) antes de pagar juez: muchas respuestas de estos
    //    casos son un número o una línea.
    const iguales = base.text.trim() === elidida.text.trim() && base.text.trim().length > 0;
    if (iguales) {
      pasan++;
      detalle.push(`rep ${r}: PASA — respuesta idéntica`);
      continue;
    }

    // 3. Juez ciego (si está configurado).
    const eq = await juezEquivalente(base.text, elidida.text, c.pregunta);
    if (eq === true) {
      pasan++;
      detalle.push(`rep ${r}: PASA — el juez la declara equivalente o mejor`);
    } else if (eq === false) {
      detalle.push(`rep ${r}: FALLA — el juez detecta regresión (base="${recorta(base.text)}" elidida="${recorta(elidida.text)}")`);
    } else {
      // Sin juez y sin igualdad exacta: no se puede afirmar fidelidad → no cuenta como paso.
      detalle.push(`rep ${r}: INDECISO — sin juez configurado y las respuestas difieren; configura BVSALA_JUDGE_BASE_URL`);
    }
  }

  const gate = judge ? "truncado+juez" : "truncado+igualdad-exacta";
  return {
    name: c.name, nota: c.nota,
    elididos: eleccion.indices.length, bytesElididos: eleccion.bytesOriginales,
    reps: REPS, pasan, fidelidad: pasan / REPS, gate, detalle,
  };
}

const recorta = (s: string, n = 60): string => (s.length > n ? s.slice(0, n) + "…" : s).replace(/\n/g, " ");

// ── Informe ──────────────────────────────────────────────────────────────────
function gitCommitCorto(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  console.log(`\n═══ VERJA DE FIDELIDAD — elisión por supersesión ═══`);
  console.log(`modo=${MODE}  modelo=${MODEL}  juez=${judge ? judgeModel : "(ninguno)"}  reps=${REPS}  suelo=${FLOOR}`);
  if (MODE === "MOCK") {
    console.log(
      "⚠ MOCK: sin red. Esto SOLO prueba que el arnés corre (selección→reescritura→llamada).\n" +
        "  NO es una afirmación de fidelidad. Configura BVSALA_DEMO_BASE_URL para una tirada real.",
    );
  } else if (!judge) {
    console.log(
      "⚠ SIN JUEZ: la verja solo aplica el veto de truncado y la igualdad exacta. Las respuestas\n" +
        "  que difieran quedan INDECISAS (no cuentan como paso). Configura BVSALA_JUDGE_BASE_URL para el juicio semántico.",
    );
  }
  console.log(`  muñón = "${MUNON_ELISION}"\n`);

  const resultados: ResultadoCaso[] = [];
  for (const c of CASOS) {
    process.stdout.write(`· ${c.name} … `);
    const r = await correrCaso(c);
    resultados.push(r);
    console.log(`elididos=${r.elididos}  fidelidad=${(r.fidelidad * 100).toFixed(1)}%  (${r.pasan}/${r.reps})`);
  }

  // Solo los casos que la elisión REALMENTE toca cuentan para el veredicto de
  // encender el borrado en vivo. Un caso sin elisión (control) pasa trivialmente
  // y no demuestra nada sobre el borrado.
  const conElision = resultados.filter((r) => r.elididos > 0);
  const pisoReal = conElision.length ? Math.min(...conElision.map((r) => r.fidelidad)) : 1;
  const verde = MODE === "LIVE" && conElision.length > 0 && pisoReal >= FLOOR;

  console.log(`\n─── VEREDICTO ───`);
  for (const r of resultados) {
    const marca = r.elididos === 0 ? "  (control)" : r.fidelidad >= FLOOR ? "  ✓" : "  ✗ POR DEBAJO DEL SUELO";
    console.log(`  ${r.name}: ${(r.fidelidad * 100).toFixed(1)}%${marca}  — ${r.nota}`);
    for (const d of r.detalle.filter((x) => x.includes("FALLA") || x.includes("INDECISO"))) {
      console.log(`      ${d}`);
    }
  }

  if (MODE === "MOCK") {
    console.log(`\n⚠ MOCK — sin veredicto de fidelidad. El arnés corre; falta la tirada LIVE.`);
  } else if (verde) {
    console.log(
      `\n✅ VERDE: piso de fidelidad de los casos con elisión = ${(pisoReal * 100).toFixed(2)}% ≥ ${(FLOOR * 100).toFixed(1)}%.` +
        `\n   El borrado en vivo (ELISION_EN_VIVO) puede encenderse en anillo-0 para las formas probadas aquí.`,
    );
  } else {
    console.log(
      `\n⛔ ROJO: piso de fidelidad de los casos con elisión = ${(pisoReal * 100).toFixed(2)}% < ${(FLOOR * 100).toFixed(1)}%.` +
        `\n   NO encender el borrado real. Excluir el/los caso(s) por debajo del suelo (subir keep-floor o exención por tipo) y re-medir.`,
    );
  }

  // Artefacto.
  const dir = join(process.cwd(), "benchmarks", "out");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artefacto = {
    kind: "fidelidad-elision",
    at: new Date().toISOString(),
    commit: gitCommitCorto(),
    mode: MODE,
    model: MODEL,
    judge: judge ? judgeModel : null,
    reps: REPS,
    floor: FLOOR,
    keepFloor: KEEP_TOOL_RESULTS,
    pisoRealConElision: pisoReal,
    verde,
    resultados,
  };
  const ruta = join(dir, `fidelidad-elision-${stamp}.json`);
  writeFileSync(ruta, JSON.stringify(artefacto, null, 2));
  console.log(`\nartefacto → ${ruta}`);

  // Código de salida: rojo en LIVE es fallo (para poder encadenarlo en un gate),
  // MOCK nunca falla (solo prueba fontanería).
  if (MODE === "LIVE" && !verde) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
