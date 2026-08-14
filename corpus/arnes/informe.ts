/**
 * EL INFORME, para leerlo con los ojos.
 *
 *   pnpm corpus:arnes            → el selector por defecto (mandarlo todo)
 *   pnpm corpus:arnes --todos    → añade las líneas base y los mutantes
 *
 * Lo que hay que mirar, en este orden:
 *
 *   1. La tabla del CRUCE idioma × dominio. La media global se puede aprobar
 *      con el catalán de contratos hundido; la celda no.
 *   2. `ahorro`. Un selector con cobertura del 100 % y ahorro del 0 % es
 *      `mandarloTodo`, o sea la ausencia de palanca.
 *   3. Los fallos, uno a uno. Un informe sin los fallos no se arregla.
 */

import { cargarCorpus } from "./cargar.js";
import { brecha, degradaciones, peorCelda, puntuarCorpus, type Celda, type Informe } from "./metricas.js";
import { MUTANTES, oraculo } from "./mutantes.js";
import { conEntradaLimpia, lasPrimerasK, mandarloTodo } from "./selectores.js";

const pct = (x: number): string => `${(x * 100).toFixed(1).padStart(5)} %`;

function tabla(titulo: string, celdas: readonly Celda[]): string {
  const filas = celdas.map(
    (c) =>
      `  ${c.clave.padEnd(28)} ${String(c.total).padStart(4)}  ` +
      `${pct(c.tasa)}  ${pct(c.coberturaDeCamposCriticos)}  ${pct(c.citasConservadas)}  ` +
      `${pct(c.tasaDeAbstencionCorrecta)}  ${pct(c.fraccionAhorrada)}`,
  );
  return [
    `\n${titulo}`,
    `  ${"".padEnd(28)} ${"n".padStart(4)}  ${"aprob".padStart(7)}  ${"crític".padStart(7)}  ${"citas".padStart(7)}  ${"absten".padStart(7)}  ${"ahorro".padStart(7)}`,
    ...filas,
  ].join("\n");
}

export function formatear(informe: Informe): string {
  const g = informe.global;
  const partes: string[] = [];
  partes.push(`\n═══ ${informe.selector} ═══`);
  partes.push(
    `  ${g.total} casos · ${g.aprobados} aprobados (${pct(g.tasa)}) · ` +
      `${g.fueraDePresupuesto} fuera de presupuesto`,
  );
  partes.push(
    `  campos críticos ${g.camposCriticosIntactos}/${g.camposCriticos} · ` +
      `citas ${g.citasVivas}/${g.citas} · abstenciones ${g.abstencionesCorrectas}/${g.abstenciones}`,
  );
  partes.push(
    `  tokens: ${g.tokensAhorrados} de ${g.tokensTotales} ahorrados (${pct(g.fraccionAhorrada)}) ` +
      `— cuenta ${informe.contador.id}, ${informe.contador.exacto ? "EXACTA" : "ESTIMADA (no comparable con una factura)"}`,
  );
  partes.push(
    `  citas por campo en ${informe.granularidad.porCampo} casos; ` +
      `en los otros ${informe.granularidad.global} la cobertura por campo se aproxima con la lista global`,
  );
  partes.push(tabla("por idioma", informe.porIdioma));
  partes.push(tabla("por dominio (tipo documental)", informe.porDominio));
  partes.push(tabla("⚠️ el cruce — lo que las dos medias de arriba esconden", informe.porIdiomaYDominio));
  partes.push(tabla("por dificultad", informe.porDificultad));
  partes.push(tabla("por trampa", informe.porTrampa));

  const peor = peorCelda(informe);
  partes.push(
    `\n  peor celda del cruce: ${peor?.clave ?? "—"} con ${pct(peor?.coberturaDeCamposCriticos ?? 1)} de campos críticos` +
      ` · brecha mejor-peor: ${pct(brecha(informe))}`,
  );

  const degs = degradaciones(informe);
  if (degs.length === 0) {
    partes.push("  sin degradación por idioma ni por tipo documental (umbral 100 %)");
  } else {
    partes.push(`  ⛔ ${degs.length} degradaciones por debajo del 100 %:`);
    for (const d of degs.slice(0, 12)) {
      partes.push(`     ${d.eje} ${d.clave}: ${d.metrica} = ${pct(d.valor)}`);
    }
  }

  if (informe.fallos.length > 0) {
    partes.push(`\n  fallos (${informe.fallos.length}), los diez primeros:`);
    for (const f of informe.fallos.slice(0, 10)) {
      const por = [
        f.idsInventados.length > 0 ? `ids inventados ${f.idsInventados.join(",")}` : "",
        f.citasMuertas.length > 0 ? `citas muertas ${f.citasMuertas.join(",")}` : "",
        f.necesariasPerdidas.length > 0 ? `necesarias perdidas ${f.necesariasPerdidas.join(",")}` : "",
        f.camposCriticosHuerfanos.length > 0 ? `campos huérfanos ${f.camposCriticosHuerfanos.join(",")}` : "",
        f.abstencionRota ?? "",
      ].filter(Boolean);
      partes.push(`     ${f.casoId} [${f.idioma}·${f.dominio}] ${por.join(" · ")}`);
    }
  }
  return partes.join("\n");
}

function principal(): void {
  const casos = cargarCorpus();
  const todos = process.argv.includes("--todos");

  const informes: Informe[] = [
    puntuarCorpus(casos, conEntradaLimpia(mandarloTodo), { nombre: "mandarlo-todo (por defecto)" }),
  ];
  if (todos) {
    informes.push(puntuarCorpus(casos, conEntradaLimpia(lasPrimerasK), { nombre: "las-primeras-k" }));
    informes.push(puntuarCorpus(casos, oraculo, { nombre: "oráculo (con chuleta)" }));
    for (const m of MUTANTES) {
      informes.push(puntuarCorpus(casos, m.selector, { nombre: `mutante · ${m.nombre}` }));
    }
  }
  for (const i of informes) console.log(formatear(i));
  console.log(
    "\n⚠️ Corpus SINTÉTICO. Demuestra que el mecanismo no descarta un campo crítico en" +
      "\n   situaciones construidas para que descartarlo salga caro. NO demuestra que en el" +
      "\n   tráfico real de un cliente el ahorro se materialice, ni que la distribución de" +
      "\n   casos difíciles se parezca a la suya. Ver corpus/arnes/README.md.\n",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) principal();
