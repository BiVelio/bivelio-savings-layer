/**
 * Banco de SALIDA · anillo 0 · el ARNÉS (todo el I/O: red, disco, reloj).
 *
 * Ejecuta el corpus del anillo 1 contra la API real de Anthropic con TRES
 * estilos de salida y decide con ÉXITO DE TAREA (verificador programático),
 * no con parecido de texto. El bucle de turnos es el de
 * `benchmarks/anillo1/arnes.ts` (mismo `pedirConReintentos`, mismo
 * `costeMedido` del medidor de producción, misma contabilidad de relecturas)
 * copiado y generalizado a un ESTILO en vez de a un brazo: `ejecutarTarea`
 * no está exportada allí, y el anillo 1 no se toca.
 *
 * Orden de ejecución: por tarea, por rep, los estilos SEGUIDOS. Así los tres
 * comparten momento y cola del proveedor — lo que cambie entre ellos no es la
 * hora del día ni la carga del servidor.
 *
 * Presupuesto duro: BVSALA_SALIDA_BUDGET_USD (40 $) aborta la tirada si el
 * gasto acumulado lo supera; el artefacto sale igualmente, marcado.
 *
 * Uso:  npx tsx --env-file-if-exists=.env.bench benchmarks/salida/arnes.ts
 *         [--humo] [--estilos=base,savings-mode,caveman]
 * ENV:  BVSALA_DEMO_ANTHROPIC_API_KEY (+ _BASE_URL opcional, con o sin /v1),
 *       BVSALA_SALIDA_MODEL (claude-sonnet-4-5), BVSALA_SALIDA_REPS (2),
 *       BVSALA_SALIDA_BUDGET_USD (40), BVSALA_SALIDA_TAREAS (ids por comas).
 * Log humano por STDERR; por stdout solo la ruta del artefacto al final.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { costeMedido } from "../../gateway/medidor.js";
import { ejecutarHerramienta, tareasDelAnillo1, type EstadoDeTarea, type Tarea } from "../anillo1/tareas.js";
import {
  ESTILOS,
  construirPeticionSalida,
  ejecucionVacia,
  esEstilo,
  textoDeSkill,
  veredicto,
  type EjecucionSalida,
  type Estilo,
  type PeticionConstruida,
  type TextosDeEstilo,
} from "./nucleo.js";

// ── Los textos de estilo (disco → puro) ──

/** La raíz del repo, resuelta desde ESTE fichero: el arnés no depende del cwd. */
export function raizDelRepo(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

export const RUTA_SAVINGS_MODE = "skills/savings-mode/SKILL.md";
export const RUTA_CAVEMAN = "benchmarks/salida/estilos/caveman.md";

/**
 * savings-mode = el skill de la casa sin su frontmatter; caveman = la copia
 * literal guardada con atribución, sin la cabecera ni su frontmatter. Ambos
 * llegan al modelo como llegarían a un usuario que los instala.
 */
export function leerTextosDeEstilo(raiz = raizDelRepo()): TextosDeEstilo {
  return {
    "savings-mode": textoDeSkill(readFileSync(join(raiz, RUTA_SAVINGS_MODE), "utf8")),
    caveman: textoDeSkill(readFileSync(join(raiz, RUTA_CAVEMAN), "utf8")),
  };
}

// ── La API ──

interface UsoAnthropic {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  /** No es de Messages hoy; se lee por si el proveedor lo desglosa algún día. */
  thinking_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
}

interface RespuestaMessages {
  content?: { type: string; id?: string; name?: string; input?: Record<string, unknown>; text?: string }[];
  stop_reason?: string;
  usage?: UsoAnthropic;
  error?: { type?: string; message?: string };
}

async function pedirConReintentos(
  url: string,
  peticion: PeticionConstruida,
  log: (l: string) => void,
): Promise<RespuestaMessages> {
  for (let intento = 0; ; intento++) {
    const res = await fetch(url, {
      method: "POST",
      headers: peticion.cabeceras,
      body: JSON.stringify(peticion.cuerpo),
    });
    if (res.ok) return (await res.json()) as RespuestaMessages;
    const texto = await res.text();
    if ([429, 500, 502, 503, 529].includes(res.status) && intento < 3) {
      const espera = 2000 * 2 ** intento;
      log(`    reintento ${intento + 1} tras HTTP ${res.status} (${espera} ms)`);
      await new Promise((r) => setTimeout(r, espera));
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${texto.slice(0, 300)}`);
  }
}

// ── El bucle de una tarea con un estilo ──

export async function ejecutarTareaSalida(opts: {
  tarea: Tarea;
  estilo: Estilo;
  rep: number;
  sal: string;
  modelo: string;
  apiKey: string;
  url: string;
  textos: TextosDeEstilo;
  log: (l: string) => void;
}): Promise<EjecucionSalida> {
  const { tarea, estilo, rep } = opts;
  const estado: EstadoDeTarea = tarea.construir();
  const mensajes: unknown[] = [{ role: "user", content: tarea.enunciado }];
  const vistas = new Set<string>();

  const ejec = ejecucionVacia(tarea, estilo, rep);
  let respuestaFinal = "";
  let thinking: number | undefined;

  while (ejec.turnos < tarea.turnosMax) {
    ejec.turnos++;
    const peticion = construirPeticionSalida({
      tarea,
      estilo,
      sal: opts.sal,
      modelo: opts.modelo,
      mensajes,
      apiKey: opts.apiKey,
      textos: opts.textos,
    });
    const res = await pedirConReintentos(opts.url, peticion, opts.log);
    if (res.error) throw new Error(`API: ${res.error.type}: ${res.error.message}`);

    if (res.usage) {
      const medido = costeMedido(opts.modelo, res.usage);
      if (medido) {
        ejec.costeTotalUsd += medido.costeUsd;
        // La salida se tarifa aparte con el MISMO precio de lista del medidor:
        // es la cifra en dinero que este banco persigue.
        ejec.costeSalidaUsd += (medido.tokens.salida / 1_000) * medido.precio.outputPer1k;
        ejec.tokens.entrada += medido.tokens.entrada;
        ejec.tokens.salida += medido.tokens.salida;
        ejec.tokens.cacheLeida += medido.tokens.cacheLeida;
        ejec.tokens.cacheEscrita += medido.tokens.cacheEscrita;
      }
      const t = res.usage.thinking_tokens ?? res.usage.output_tokens_details?.reasoning_tokens;
      if (t !== undefined) thinking = (thinking ?? 0) + t;
    }

    const contenido = res.content ?? [];
    for (const bloque of contenido) {
      if (bloque.type === "text" && bloque.text) ejec.charsTexto += bloque.text.length;
      if (bloque.type === "thinking") ejec.bloquesThinking = (ejec.bloquesThinking ?? 0) + 1;
    }
    if (res.usage?.output_tokens !== undefined) ejec.maxSalidaTurno = Math.max(ejec.maxSalidaTurno ?? 0, res.usage.output_tokens);
    if (res.stop_reason === "max_tokens") ejec.truncados = (ejec.truncados ?? 0) + 1;
    mensajes.push({ role: "assistant", content: contenido });

    if (res.stop_reason !== "tool_use") break; // texto final sin entregar (o truncado): cuenta como no entregado

    const resultados: unknown[] = [];
    let entregado = false;
    for (const bloque of contenido) {
      if (bloque.type !== "tool_use" || bloque.id === undefined || bloque.name === undefined) continue;
      ejec.llamadas++;
      const firma = `${bloque.name}:${JSON.stringify(bloque.input ?? {})}`;
      if (vistas.has(firma)) ejec.relecturas++;
      vistas.add(firma);
      const r = ejecutarHerramienta(tarea, estado, { nombre: bloque.name, entrada: bloque.input ?? {} });
      resultados.push({
        type: "tool_result",
        tool_use_id: bloque.id,
        content: r.contenido,
        ...(r.esError ? { is_error: true } : {}),
      });
      if (r.entrega !== undefined) {
        respuestaFinal = r.entrega;
        entregado = true;
      }
    }
    if (resultados.length === 0) break;
    mensajes.push({ role: "user", content: resultados });
    if (entregado) {
      ejec.entregado = true;
      break;
    }
  }

  ejec.tokensSalida = ejec.tokens.salida;
  ejec.charsEntrega = respuestaFinal.length;
  if (thinking !== undefined) ejec.thinkingTokens = thinking;
  ejec.exito = ejec.entregado && tarea.verificar(estado, respuestaFinal);
  return ejec;
}

// ── main ──

function estilosDeLaOrden(argv: string[]): Estilo[] {
  const arg = argv.find((a) => a.startsWith("--estilos="));
  if (!arg) return [...ESTILOS];
  const pedidos = arg.slice("--estilos=".length).split(",").map((s) => s.trim()).filter(Boolean);
  const malos = pedidos.filter((p) => !esEstilo(p));
  if (malos.length) throw new Error(`estilos desconocidos: ${malos.join(", ")} (válidos: ${ESTILOS.join(", ")})`);
  // Siempre en el orden canónico y con base delante: el veredicto compara contra base.
  const set = new Set(pedidos as Estilo[]);
  if (!set.has("base")) throw new Error("--estilos debe incluir «base»: es la referencia de todos los pares");
  return ESTILOS.filter((e) => set.has(e));
}

async function main(): Promise<void> {
  const apiKey = process.env.BVSALA_DEMO_ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Falta BVSALA_DEMO_ANTHROPIC_API_KEY (en .env.bench).");
    process.exit(1);
  }
  // La base puede venir con /v1 al final: sin normalizar, /v1/v1/messages da 404.
  const base = (process.env.BVSALA_DEMO_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/v1\/?$/, "");
  const url = `${base}/v1/messages`;
  const modelo = process.env.BVSALA_SALIDA_MODEL ?? "claude-sonnet-4-5";
  // Sin parámetro `thinking`, sonnet-4-5 no razona; opus-5 / fable / mythos /
  // sonnet-5 razonan por defecto (adaptativo) y sus output_tokens llevarían
  // razonamiento invisible: la «reducción de salida» mediría otra cosa.
  if (/opus-5|fable|mythos|sonnet-5/.test(modelo) && process.env.BVSALA_SALIDA_PERMITIR_THINKING !== "1") {
    console.error(`[salida] ${modelo} razona por defecto: la salida no sería comparable. Usa un modelo sin thinking o BVSALA_SALIDA_PERMITIR_THINKING=1 a sabiendas.`);
    process.exit(1);
  }
  const humo = process.argv.includes("--humo") || process.env.BVSALA_SALIDA_HUMO === "1";
  const reps = humo ? 1 : Number(process.env.BVSALA_SALIDA_REPS ?? 2);
  const presupuesto = Number(process.env.BVSALA_SALIDA_BUDGET_USD ?? 40);
  const filtro = process.env.BVSALA_SALIDA_TAREAS?.split(",").map((s) => s.trim()).filter(Boolean);
  const estilos = estilosDeLaOrden(process.argv);
  const textos = leerTextosDeEstilo();

  let tareas = tareasDelAnillo1();
  if (filtro?.length) tareas = tareas.filter((t) => filtro.includes(t.id));
  if (humo && !filtro?.length) {
    // Un log y un código con tests, por id (los índices del anillo 1 se movieron
    // al añadir log-cadena-de-partes).
    const porId = new Map(tareas.map((t) => [t.id, t]));
    tareas = [porId.get("log-aguja-500") ?? tareas[0]!, porId.get("codigo-off-by-one") ?? tareas[5]!];
  }

  const tirada = randomUUID().slice(0, 8);
  const log = (l: string) => console.error(l);
  log(
    `salida · anillo 0 · tirada ${tirada} · modelo ${modelo} · ${tareas.length} tareas × ${estilos.length} estilos × ${reps} reps · presupuesto ${presupuesto} $` +
      `\n  textos: savings-mode ${textos["savings-mode"].length} chars · caveman ${textos.caveman.length} chars`,
  );

  const ejecuciones: EjecucionSalida[] = [];
  let gastado = 0;
  let abortada = false;

  bucle: for (const tarea of tareas) {
    for (let rep = 0; rep < reps; rep++) {
      for (const estilo of estilos) {
        const sal = `${tirada}-${tarea.id}-${estilo}-${rep}`;
        try {
          const e = await ejecutarTareaSalida({ tarea, estilo, rep, sal, modelo, apiKey, url, textos, log });
          ejecuciones.push(e);
          gastado += e.costeTotalUsd;
          log(
            `  ${tarea.id} ${estilo}#${rep} → ${e.exito ? "✓" : "✗"} turnos=${e.turnos} llamadas=${e.llamadas} relecturas=${e.relecturas}` +
              ` salida=${e.tokensSalida} tok ($${e.costeSalidaUsd.toFixed(4)}) total=$${e.costeTotalUsd.toFixed(4)} entrega=${e.charsEntrega} chars texto=${e.charsTexto} chars`,
          );
        } catch (err) {
          // Se conserva marcada: el par sale de la puerta de éxito (un 400 del
          // proveedor no es un fracaso del estilo) y su gasto no se pierde.
          log(`  ${tarea.id} ${estilo}#${rep} → ERROR ${String(err).slice(0, 200)}`);
          ejecuciones.push({ ...ejecucionVacia(tarea, estilo, rep), error: String(err).slice(0, 120) });
        }
        if (gastado > presupuesto) {
          log(`\n⛔ presupuesto superado ($${gastado.toFixed(2)} > $${presupuesto}) — tirada abortada aquí`);
          abortada = true;
          break bucle;
        }
      }
    }
  }

  // ── Veredicto ──
  const v = veredicto(ejecuciones, estilos);
  const pct = (ic: { media: number; inferior: number; superior: number }) =>
    `${ic.media.toFixed(1)} % · IC95 [${ic.inferior.toFixed(1)}, ${ic.superior.toFixed(1)}]`;
  log("\n── VEREDICTO ──");
  log(`base: éxito ${v.base.exitos}/${v.base.ejecuciones} · salida ${v.base.tokensSalida} tok · coste $${v.base.costeTotalUsd.toFixed(2)}`);
  for (const s of v.estilos) {
    log(`\n${s.estilo} (${s.pares} pares medidos, ${s.paresDeExito} de éxito):`);
    log(`  tokens de salida: ${s.tokensSalida.base} → ${s.tokensSalida.estilo} · reducción ${pct(s.tokensSalida.reduccionPct)}`);
    log(`  coste de salida:  $${s.costeSalida.base.toFixed(3)} → $${s.costeSalida.estilo.toFixed(3)} · reducción ${pct(s.costeSalida.reduccionPct)}`);
    log(
      `  coste TOTAL:      $${s.costeTotal.base.toFixed(3)} → $${s.costeTotal.estilo.toFixed(3)} · reducción ${pct(s.costeTotal.reduccionPct)}${s.costeTotal.empeora ? " · EMPEORA" : ""}`,
    );
    log(`  entrada (tokens): ${s.tokensEntrada.base} → ${s.tokensEntrada.estilo}`);
    log(
      `  éxito: base ${s.exito.base}/${s.exito.total} · ${s.estilo} ${s.exito.estilo}/${s.exito.total}` +
        (s.exito.diferencia
          ? ` · diferencia ${(s.exito.diferencia.media * 100).toFixed(1)} pt IC95 [${(s.exito.diferencia.inferior * 100).toFixed(1)}, ${(s.exito.diferencia.superior * 100).toFixed(1)}]`
          : "") +
        ` · puerta ${s.exito.puerta ? "PASA" : "NO PASA"}`,
    );
    log(
      `  relecturas/llamada ${(s.relecturasPorLlamada.base * 100).toFixed(1)} % → ${(s.relecturasPorLlamada.estilo * 100).toFixed(1)} % · turnos ${s.turnosMedios.base.toFixed(2)} → ${s.turnosMedios.estilo.toFixed(2)}` +
        ` · entrega ${s.charsEntregaMedios.base.toFixed(0)} → ${s.charsEntregaMedios.estilo.toFixed(0)} chars · texto ${s.charsTextoMedios.base.toFixed(0)} → ${s.charsTextoMedios.estilo.toFixed(0)} chars`,
    );
    log(`  publicable: ${s.publicable ? "SÍ (suelo " + s.tokensSalida.reduccionPct.inferior.toFixed(1) + " % de salida)" : "NO"}`);
    for (const n of s.notas) log(`  · ${n}`);
  }
  if (abortada) log("\nTIRADA ABORTADA POR PRESUPUESTO");

  const artefacto = {
    version: 1,
    banco: "salida-anillo0",
    fecha: new Date().toISOString(),
    tirada,
    modelo,
    reps,
    humo,
    abortada,
    estilos,
    tareas: tareas.map((t) => t.id),
    textosChars: { "savings-mode": textos["savings-mode"].length, caveman: textos.caveman.length },
    costeTotalUsd: gastado,
    presupuestoUsd: presupuesto,
    // Las condiciones que hacen comparable la tirada (y no transferible a
    // producción: aquí la entrada va sin caché y a precio pleno).
    condiciones: { thinking: "ausente", cache: "ninguna", temperature: "por defecto", maxTokens: 2048 },
    ejecuciones,
    veredicto: v,
  };
  const dir = join(raizDelRepo(), "benchmarks", "out");
  mkdirSync(dir, { recursive: true });
  const salida = join(dir, `salida-banco-${new Date().toISOString().slice(0, 10)}-${tirada}.json`);
  writeFileSync(salida, JSON.stringify(artefacto, null, 2) + "\n");
  log(`\ncoste de la tirada: $${gastado.toFixed(2)}\nartefacto: ${salida}`);
  console.log(salida);
}

// Guarda más estrecha que la del anillo 1 («arnes» a secas): este fichero se
// importa desde los tests y desde nadie más, pero nunca debe arrancar por
// coincidencia de nombre.
const esEjecucionDirecta = /salida[\\/]arnes\.ts$/.test(process.argv[1] ?? "");
if (esEjecucionDirecta) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
