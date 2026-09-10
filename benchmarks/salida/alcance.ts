/**
 * SALIDA · ALCANCE DE UN ESTILO — ¿cuánta factura puede tocar de verdad?
 *
 * El banco de estilos (arnes.ts) mide una reducción de TOKENS DE SALIDA en un
 * régimen de laboratorio: sin caché, sin thinking, con tareas cortas. Llevar
 * ese porcentaje a la factura y multiplicar por el total sería la trampa de
 * siempre — la de la que este repo lleva un mes retirando cifras de la web.
 * Este módulo hace la aritmética honesta en tres pasos:
 *
 *   1. SUPERFICIE. Un estilo de salida vive en el system prompt. NO puede tocar
 *      el `thinking` (es interno del modelo, no se le instruye) ni el CUERPO de
 *      fichero que viaja dentro del `tool_use` (el JSON *es* el fichero:
 *      recortarlo es escribir peor). Queda la PROSA, y como mucho la parte de
 *      `tool_use` que no es cuerpo — y esa segunda parte hay que DEMOSTRAR que
 *      el estilo la mueve, no suponerlo.
 *
 *   2. DESCOMPOSICIÓN. El banco guarda `charsTexto` (prosa) y `tokensSalida`
 *      por ejecución. Convertir los chars de prosa ahorrados a tokens con la
 *      calibración medida y compararlos con los tokens ahorrados dice qué parte
 *      del ahorro fue prosa y qué parte tool_use. Se hace con el RANGO entero
 *      de calibraciones del corpus, no con una: la conclusión que sobrevive a
 *      todo el rango es la única que se puede publicar.
 *
 *   3. NETO. Un estilo es un texto que se inyecta en CADA petición. Su peso se
 *      paga en entrada — a precio de lectura de caché en régimen estable, que
 *      es el que manda en producción. Un estilo que ahorra en salida menos de
 *      lo que cuesta en entrada es una palanca NEGATIVA por muy bonita que sea
 *      su reducción bruta. Es el mismo fallo que ya tumbó la elisión v0.
 *
 * SIN RED y SIN CORPUS: solo lee los artefactos ya medidos.
 *
 * Uso:    pnpm salida:alcance
 * Salida: benchmarks/salida/resultados/salida-alcance-<fecha>.json
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  bootstrapDiferenciaPorTarea,
  bootstrapReduccionPctPorTarea,
  type IntervaloDeConfianza,
} from "./nucleo.js";

export const RESULTADOS = join("benchmarks", "salida", "resultados");

// -- 1 · La superficie que un estilo puede tocar --

/** Las tres masas del dinero de salida, tal y como las reparte por-clase.ts. */
export interface MasaDeSalida {
  thinking: number;
  prosa: number;
  toolUse: number;
}

export interface Superficie {
  /** Prosa: lo único que un estilo instruye directamente. */
  alcanzable: number;
  /** Thinking: interno del modelo. Ningún texto de system lo gobierna. */
  fueraDeAlcance: number;
  /** tool_use: cuerpo de fichero y orden; se decide aparte, con medición. */
  toolUse: number;
  shareAlcanzableDeFactura: number;
}

/**
 * La superficie alcanzable es la PROSA, y nada más, mientras no haya medición
 * de que el estilo mueve el tool_use. `toolUse` se devuelve aparte -visible,
 * no sumado- justo para que quien lea el artefacto vea lo que se dejó fuera.
 */
export function superficie(masa: MasaDeSalida, facturaUsd: number): Superficie {
  return {
    alcanzable: redondear(masa.prosa),
    fueraDeAlcance: redondear(masa.thinking),
    toolUse: redondear(masa.toolUse),
    shareAlcanzableDeFactura: facturaUsd > 0 ? redondear(masa.prosa / facturaUsd, 6) : 0,
  };
}

// -- 2 · De qué está hecho el ahorro que midió el banco --

export interface Descomposicion {
  /** Chars de prosa que el estilo dejó de escribir (medido). */
  charsProsaAhorrados: number;
  /** Tokens de salida que el estilo dejó de gastar (medido). */
  tokensAhorrados: number;
  /** Share del ahorro atribuible a la prosa, en el rango entero de calibraciones. */
  shareProsa: { inferior: number; superior: number };
  /** Tokens de tool_use ahorrados: negativo = el JSON creció. */
  toolUseAhorrado: { inferior: number; superior: number };
  calibraciones: number[];
}

/**
 * Reparte el ahorro medido entre prosa y tool_use SIN elegir calibración: se
 * evalúa en todas las del corpus y se publica el rango. Si el rango cruza el
 * 100 %, la lectura honesta es «la prosa explica el ahorro entero, el tool_use
 * no aporta nada demostrable» — y no «el tool_use aporta X».
 */
export function descomponerAhorro(
  charsProsaAhorrados: number,
  tokensAhorrados: number,
  calibraciones: number[],
): Descomposicion {
  const cals = [...calibraciones].filter((c) => c > 0).sort((a, b) => a - b);
  if (cals.length === 0 || tokensAhorrados === 0) {
    throw new Error("[alcance] descomponerAhorro necesita calibraciones y un ahorro no nulo");
  }
  // Menos chars/token => más tokens de prosa => mayor share de prosa.
  const shares = cals.map((c) => charsProsaAhorrados / c / tokensAhorrados);
  const restos = cals.map((c) => tokensAhorrados - charsProsaAhorrados / c);
  return {
    charsProsaAhorrados,
    tokensAhorrados,
    shareProsa: { inferior: redondear(Math.min(...shares), 4), superior: redondear(Math.max(...shares), 4) },
    toolUseAhorrado: { inferior: Math.round(Math.min(...restos)), superior: Math.round(Math.max(...restos)) },
    calibraciones: cals,
  };
}

// -- 3 · Bruto, coste propio y NETO --

export interface Precios {
  /** $/1k tokens de LECTURA de caché — el régimen estable de producción. */
  [modelo: string]: number;
}

export interface Alcance {
  estilo: string;
  /** Chars del texto del estilo: se inyecta entero en cada petición. */
  pesoChars: number;
  tokensPorPeticion: number;
  /** Reducción de PROSA medida por el banco (IC 95 % remuestreando tareas). */
  reduccionProsaPct: IntervaloDeConfianza;
  /** Dinero de prosa que el estilo se lleva, antes de descontar su peso. */
  brutoUsd: { media: number; suelo: number };
  /** Lo que cuesta inyectarlo, por modelo de la tabla de precios. */
  costePropioUsd: Record<string, number>;
  /** Bruto (suelo del IC) menos coste propio. Negativo = palanca que resta. */
  netoUsd: Record<string, number>;
  netoShareDeFactura: Record<string, number>;
}

export function alcanceDeEstilo(o: {
  estilo: string;
  pesoChars: number;
  reduccionProsaPct: IntervaloDeConfianza;
  prosaUsd: number;
  facturaUsd: number;
  peticiones: number;
  /** chars/token de prosa: se usa la MÁS BAJA (más tokens => el estilo pesa más). */
  calibraciones: number[];
  precios: Precios;
}): Alcance {
  const cal = Math.min(...o.calibraciones.filter((c) => c > 0));
  const tokensPorPeticion = o.pesoChars / cal;
  const bruto = {
    media: redondear((o.prosaUsd * o.reduccionProsaPct.media) / 100),
    suelo: redondear((o.prosaUsd * o.reduccionProsaPct.inferior) / 100),
  };
  const costePropioUsd: Record<string, number> = {};
  const netoUsd: Record<string, number> = {};
  const netoShareDeFactura: Record<string, number> = {};
  for (const [modelo, precio] of Object.entries(o.precios)) {
    const coste = redondear((o.peticiones * tokensPorPeticion * precio) / 1000);
    costePropioUsd[modelo] = coste;
    netoUsd[modelo] = redondear(bruto.suelo - coste);
    netoShareDeFactura[modelo] = o.facturaUsd > 0 ? redondear((bruto.suelo - coste) / o.facturaUsd, 6) : 0;
  }
  return {
    estilo: o.estilo,
    pesoChars: o.pesoChars,
    tokensPorPeticion: Math.round(tokensPorPeticion),
    reduccionProsaPct: o.reduccionProsaPct,
    brutoUsd: bruto,
    costePropioUsd,
    netoUsd,
    netoShareDeFactura,
  };
}

/**
 * ¿Merece producto propio? La regla del dueño: por debajo del 1 % de la factura
 * no hay producto. Se juzga por el NETO PEOR (el modelo más caro de inyectar),
 * porque un producto se vende a todos, no al cliente que mejor le viene.
 */
export function mereceProducto(
  a: Alcance,
  umbralShare = 0.01,
): { merece: boolean; peorShare: number; motivo: string } {
  const peorShare = Math.min(...Object.values(a.netoShareDeFactura));
  const merece = peorShare >= umbralShare;
  return {
    merece,
    peorShare,
    motivo: merece
      ? `neto por encima del ${(umbralShare * 100).toFixed(0)} % de la factura en todos los modelos`
      : `el neto peor (${(peorShare * 100).toFixed(3)} %) no llega al ${(umbralShare * 100).toFixed(0)} % de la factura`,
  };
}

/** Dos estilos se distinguen solo si el IC 95 % de su diferencia no cruza el cero. */
export function seDistinguen(dif: IntervaloDeConfianza): boolean {
  return dif.inferior > 0 || dif.superior < 0;
}

function redondear(x: number, dec = 4): number {
  return Number(x.toFixed(dec));
}

// -- El arnés --

interface Banco {
  modelo: string;
  reps: number;
  tareas: string[];
  textosChars: Record<string, number>;
  ejecuciones: {
    tarea: string;
    estilo: string;
    rep: number;
    tokensSalida: number;
    charsTexto: number;
    llamadas: number;
  }[];
}

interface PorClase {
  fecha: string;
  dias: number;
  calibracionPorModelo: Record<string, { prosaCharsPorToken: number | null }>;
  global: {
    peticiones: number;
    salidaUsd: number;
    entradaUsd: number;
    repartoCalibrado: { thinking: number; text: number; tool_use: number };
  };
}

/** El artefacto más reciente que casa con el prefijo. */
export function ultimoArtefacto(dir: string, prefijo: string): string {
  const f = readdirSync(dir)
    .filter((x) => x.startsWith(prefijo) && x.endsWith(".json"))
    .sort();
  if (f.length === 0) throw new Error(`[alcance] sin artefacto ${prefijo}* en ${dir}`);
  return join(dir, f[f.length - 1]!);
}

/** Precios de LECTURA de caché del catálogo, para los modelos que dominan el corpus. */
export const PRECIOS_LECTURA_CACHE: Precios = {
  "claude-fable-5-1": 0.00025,
  "claude-opus-5": 0.0005,
  "claude-fable-5": 0.001,
};

function main(): void {
  const rutaBanco = ultimoArtefacto(RESULTADOS, "salida-banco-");
  const rutaClase = ultimoArtefacto(RESULTADOS, "salida-por-clase-");
  const banco = JSON.parse(readFileSync(rutaBanco, "utf8")) as Banco;
  const clase = JSON.parse(readFileSync(rutaClase, "utf8")) as PorClase;

  const g = clase.global;
  const facturaUsd = redondear(g.salidaUsd + g.entradaUsd, 2);
  const masa: MasaDeSalida = {
    thinking: g.repartoCalibrado.thinking,
    prosa: g.repartoCalibrado.text,
    toolUse: g.repartoCalibrado.tool_use,
  };
  const sup = superficie(masa, facturaUsd);
  const calibraciones = Object.values(clase.calibracionPorModelo)
    .map((c) => c.prosaCharsPorToken)
    .filter((c): c is number => typeof c === "number" && c > 0);

  const clave = (e: Banco["ejecuciones"][number]): string => `${e.tarea} ${e.rep}`;
  const base = new Map(banco.ejecuciones.filter((e) => e.estilo === "base").map((e) => [clave(e), e]));
  const estilos = [...new Set(banco.ejecuciones.map((e) => e.estilo))].filter((s) => s !== "base").sort();

  const alcances: Alcance[] = [];
  const descomposiciones: Record<string, Descomposicion> = {};
  const brazos = new Map<string, Map<string, Banco["ejecuciones"][number]>>();

  for (const estilo of estilos) {
    const brazo = new Map(banco.ejecuciones.filter((e) => e.estilo === estilo).map((e) => [clave(e), e]));
    brazos.set(estilo, brazo);
    const pares = [...base.entries()]
      .filter(([k]) => brazo.has(k))
      .map(([k, b]) => ({ tarea: b.tarea, b, e: brazo.get(k)! }));

    const reduccionProsaPct = bootstrapReduccionPctPorTarea(
      pares.map((p) => ({ tarea: p.tarea, base: p.b.charsTexto, estilo: p.e.charsTexto })),
    );
    descomposiciones[estilo] = descomponerAhorro(
      pares.reduce((s, p) => s + p.b.charsTexto - p.e.charsTexto, 0),
      pares.reduce((s, p) => s + p.b.tokensSalida - p.e.tokensSalida, 0),
      calibraciones,
    );
    alcances.push(
      alcanceDeEstilo({
        estilo,
        pesoChars: banco.textosChars[estilo] ?? 0,
        reduccionProsaPct,
        prosaUsd: masa.prosa,
        facturaUsd,
        peticiones: g.peticiones,
        calibraciones,
        precios: PRECIOS_LECTURA_CACHE,
      }),
    );
  }

  // ¿Se distingue un estilo de otro? Diferencia pareada, remuestreando TAREAS.
  const comparaciones: Record<string, { diferenciaPct: IntervaloDeConfianza; seDistinguen: boolean }> = {};
  for (let i = 0; i < estilos.length; i++) {
    for (let j = i + 1; j < estilos.length; j++) {
      const a = estilos[i]!;
      const b = estilos[j]!;
      const ma = brazos.get(a)!;
      const mb = brazos.get(b)!;
      const pares = [...base.entries()]
        .filter(([k]) => ma.has(k) && mb.has(k))
        .map(([k, base0]) => ({
          tarea: base0.tarea,
          // Reducción de prosa de cada brazo sobre su propia base, en puntos.
          a: base0.charsTexto === 0 ? 0 : 100 * (1 - ma.get(k)!.charsTexto / base0.charsTexto),
          b: base0.charsTexto === 0 ? 0 : 100 * (1 - mb.get(k)!.charsTexto / base0.charsTexto),
        }));
      const dif = bootstrapDiferenciaPorTarea(pares);
      comparaciones[`${b} menos ${a}`] = { diferenciaPct: dif, seDistinguen: seDistinguen(dif) };
    }
  }

  const informe = {
    fecha: new Date().toISOString(),
    version: "salida-alcance-v1",
    nota: [
      "SUPERFICIE: un estilo de salida vive en el system prompt. No gobierna el `thinking` (interno del modelo) ni el CUERPO de fichero dentro del `tool_use` (el JSON ES el fichero). La superficie alcanzable es la PROSA; `toolUse` se lista aparte, sin sumar, para que se vea lo que queda fuera.",
      "DESCOMPOSICIÓN: reparte el ahorro medido por el banco entre prosa y tool_use evaluando TODAS las calibraciones chars/token del corpus. Si el rango de `shareProsa` cruza el 1, la lectura es «la prosa explica el ahorro entero», nunca «el tool_use aporta X».",
      "NETO: el texto del estilo se inyecta en cada petición y se paga en entrada a precio de LECTURA de caché. El bruto se toma del SUELO del IC, el coste del peor caso: un producto se vende a todos.",
      "El IC remuestrea TAREAS, no pares — las reps de una tarea comparten fixture y remuestrear pares regala suelo.",
      "Solo cifras: del contenido de los artefactos no sale nada.",
    ],
    fuentes: { banco: rutaBanco, porClase: rutaClase, modeloDelBanco: banco.modelo, dias: clase.dias },
    factura: {
      totalUsd: facturaUsd,
      salidaUsd: redondear(g.salidaUsd, 2),
      shareSalida: redondear(g.salidaUsd / facturaUsd, 4),
      masaDeSalida: masa,
    },
    superficie: sup,
    descomposiciones,
    alcances,
    comparaciones,
    veredicto: Object.fromEntries(alcances.map((a) => [a.estilo, mereceProducto(a)])),
  };

  const ruta = join(RESULTADOS, `salida-alcance-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(ruta, JSON.stringify(informe, null, 2));

  console.error(
    `[alcance] factura ${clase.dias} d: $${facturaUsd} · salida $${redondear(g.salidaUsd, 2)} (${((100 * g.salidaUsd) / facturaUsd).toFixed(1)} %)`,
  );
  console.error(
    `[alcance] SUPERFICIE alcanzable (prosa) = $${sup.alcanzable} = ${(sup.shareAlcanzableDeFactura * 100).toFixed(3)} % de la factura`,
  );
  console.error(`[alcance]   fuera de alcance: thinking $${sup.fueraDeAlcance} · tool_use $${sup.toolUse}`);
  for (const a of alcances) {
    const d = descomposiciones[a.estilo]!;
    console.error(
      `[alcance] ${a.estilo}: prosa -${a.reduccionProsaPct.media.toFixed(1)} % (suelo ${a.reduccionProsaPct.inferior.toFixed(1)} %) · ` +
        `explica ${(d.shareProsa.inferior * 100).toFixed(0)}-${(d.shareProsa.superior * 100).toFixed(0)} % del ahorro medido`,
    );
    console.error(
      `[alcance]   peso ${a.pesoChars} chars (${a.tokensPorPeticion} tok/pet) · bruto $${a.brutoUsd.suelo} · ` +
        `neto ${Object.entries(a.netoUsd)
          .map(([m, v]) => `${m.replace("claude-", "")}=$${v}`)
          .join(" ")}`,
    );
    const v = mereceProducto(a);
    console.error(`[alcance]   => ${v.merece ? "MERECE" : "NO merece"} producto propio: ${v.motivo}`);
  }
  for (const [par, c] of Object.entries(comparaciones)) {
    console.error(
      `[alcance] ${par}: ${c.diferenciaPct.media >= 0 ? "+" : ""}${c.diferenciaPct.media.toFixed(2)} pts de prosa ` +
        `IC95 [${c.diferenciaPct.inferior.toFixed(2)}, ${c.diferenciaPct.superior.toFixed(2)}] => ${c.seDistinguen ? "SEÑAL" : "RUIDO"}`,
    );
  }
  console.error(`[alcance] artefacto: ${ruta}`);
}

if (process.argv[1] && /alcance\.ts$/.test(process.argv[1])) main();
