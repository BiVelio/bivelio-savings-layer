/**
 * El documento de la batería GSM8K, escrito SOLO desde el artefacto JSON: aquí
 * no se calcula nada nuevo, solo se da forma a lo medido. Medido y modelado van
 * en secciones separadas y cada cifra dice de dónde sale.
 */
import type { Artefacto, MedicionDeModelo } from "./arnes.js";
import type { Brazo } from "./medir.js";

const pct = (x: number | null | undefined, d = 1): string => (x == null ? "—" : `${(x * 100).toFixed(d)} %`);
const usd = (x: number | null | undefined): string => (x == null ? "—" : `$${x.toFixed(4)}`);
const ms = (x: number | null | undefined): string => (x == null ? "—" : `${Math.round(x)} ms`);
const ic = (c: { point: number; lower: number; upper: number } | null | undefined, d = 1): string =>
  c ? `${pct(c.point, d)} [${pct(c.lower, d)}, ${pct(c.upper, d)}]` : "—";
const pp = (c: { point: number; lower: number; upper: number } | null | undefined): string =>
  c ? `${(c.point * 100).toFixed(1)} pp [${(c.lower * 100).toFixed(1)}, ${(c.upper * 100).toFixed(1)}]` : "—";

function tablaDeModelo(m: MedicionDeModelo): string {
  const r = m.resumen;
  if (!r) return `_${m.estado}: ${m.motivo ?? ""}_\n`;
  const brazos = Object.keys(r.brazos).sort() as Brazo[];
  const cmp = new Map(r.comparaciones.map((c) => [c.brazo, c]));
  const filas = brazos.map((b) => {
    const x = r.brazos[b]!;
    const c = cmp.get(b);
    const f = x.fuentes;
    return (
      `| ${b} | ${ic(x.exactitud.ic95)} (${x.exactitud.aciertos}/${x.exactitud.n}) | ${b === "A" ? "—" : pp(c?.diferenciaExactitud)} | ` +
      `${usd(x.costeUsd)} | ${b === "A" ? "—" : ic(c?.ahorroMedido)} | ${f["exact_cache"] ?? 0} / ${f["semantic_cache"] ?? 0} / ${(f["coalesced"] ?? 0) + (f["deterministic"] ?? 0)} | ` +
      `${pct(x.fraccionEntradaCacheada)} | ${ms(x.latenciaMs.p50)} / ${ms(x.latenciaMs.p95)} | ${x.errores} |`
    );
  });
  return [
    "| Brazo | Exactitud [IC95 por familia] | Δ exactitud vs A | Coste medido | Ahorro medido vs A [IC95] | Aciertos exacta / semántica / otros | Entrada leída de caché del proveedor | Latencia p50 / p95 | Errores |",
    "|---|---|---|---|---|---|---|---|---|",
    ...filas,
  ].join("\n");
}

function declarado(m: MedicionDeModelo): string {
  const r = m.resumen;
  if (!r) return "";
  const lineas: string[] = [];
  for (const b of Object.keys(r.brazos).sort() as Brazo[]) {
    const d = r.brazos[b]!.ahorroDeclaradoPorBase;
    if (!d) continue;
    const partes = Object.entries(d)
      .sort()
      .map(([base, v]) => `${base}: ${v.peticiones} pet., ${usd(v.usd)}`);
    lineas.push(`- **${b}**: ${partes.join(" · ")}`);
  }
  return lineas.join("\n");
}

export function escribirDocumento(art: Artefacto): string {
  const out: string[] = [];
  out.push(`# GSM8K — caché exacta, caché semántica y compresión sin perder exactitud (${art.fecha})`);
  out.push("");
  out.push(
    `Batería pública sobre GSM8K (${art.dataset.nombre}, ${art.dataset.licencia}), commit \`${art.dataset.commit}\` de ` +
      `${art.dataset.repo}; ficheros verificados por sha256 (${art.dataset.ficheros.map((f) => `\`${f.id}\` ${f.sha256.slice(0, 12)}…`).join(", ")}).`,
  );
  out.push("");
  out.push(
    `Paquete: \`${art.procedencia.paquete}@${art.procedencia.version}\` — ${art.procedencia.modo}. ` +
      `Tarball sha256 \`${art.procedencia.tarballSha256}\`, \`dist/index.js\` sha256 \`${art.procedencia.distIndexSha256}\`.`,
  );
  out.push("");
  out.push(`Modo: **${art.modo}**, run \`${art.runId}\`. Gasto real total: **${usd(art.presupuesto.gastoTotalUsd)}** (tope ${usd(art.presupuesto.topePorModeloUsd)} por modelo, en código).`);
  out.push("");
  out.push("## Diseño");
  out.push("");
  out.push(
    `Flujo con semilla ${art.flujo.semilla}: hasta ${art.flujo.nUnicosMax} problemas únicos del split de test, ` +
      `${pct(art.flujo.fraccionRepeticiones, 0)} de repeticiones exactas y ${pct(art.flujo.fraccionParafrasis, 0)} de paráfrasis ` +
      "deterministas en cuatro clases a partes iguales: `superficie` (minúsculas, sin «?»), `lexica` (preámbulo y sinónimos), " +
      "`variante-cifra` (primer entero n→n+1) y `variante-palabra` (un número en letra o multiplicador al siguiente: two→three, twice→three times, half→a third). " +
      "Las dos variantes tienen OTRA respuesta: sirven para comprobar que la capa no entrega la respuesta de otra pregunta. " +
      `System prompt común: instrucción + 8 ejemplos del split de train (índices ${art.dataset.fewShotTrainIdx.join(", ")}).`,
  );
  out.push("");
  for (const [b, d] of Object.entries(art.brazos)) out.push(`- **${b}**: ${d}`);
  out.push("");
  out.push("## Resultados medidos por modelo");
  out.push("");
  out.push(
    "Todo lo de esta sección sale del `usage` del proveedor en cada llamada, al precio de lista del catálogo del SDK. " +
      "Los intervalos remuestrean familias enteras (un problema con sus repeticiones y paráfrasis).",
  );
  for (const m of art.modelos) {
    out.push("");
    out.push(`### ${m.modelo}`);
    out.push("");
    out.push(
      `Estado: **${m.estado}**${m.motivo ? ` — ${m.motivo}` : ""}. Host: ${m.host ?? "—"}. Muestreo: \`${JSON.stringify(m.muestreo)}\`. ` +
        `Tope de salida: ${m.topeDeSalida ?? "ninguno"}. Gasto real: **${usd(m.gasto.totalUsd)}** ` +
        `(${Object.entries(m.gasto.porBrazo).map(([k, v]) => `${k} ${usd(v)}`).join(", ")}).`,
    );
    if (m.flujo) {
      out.push("");
      out.push(
        `Flujo: ${m.nUnicos} únicos, ${m.peticionesCompletadas} peticiones completadas — ` +
          Object.entries(m.flujo).map(([k, v]) => `${k} ${v}`).join(", ") + ".",
      );
    }
    out.push("");
    out.push(tablaDeModelo(m));
    const r = m.resumen;
    if (r) {
      out.push("");
      out.push("**Seguridad — variantes con otra respuesta:** " +
        Object.entries(r.variantesPorBrazo)
          .map(([b, v]) => `${b}: ${v!.n} variantes, ${v!.deCache} servidas de caché, **${v!.deOtra} con la respuesta de otra pregunta**`)
          .join(" · "));
      for (const e of m.evidencias ?? []) {
        out.push("");
        out.push(
          `> **Hallazgo grave (${e.brazo}, petición ${e.pos}, ${e.clase}, similitud ${e.similitud?.toFixed(3) ?? "—"}).** ` +
            `Preguntada: «${e.preguntada}» — original: «${e.original}». Servida: ${e.numeroServido}; el brazo A (modelo, sin capa) contestó ${e.numeroA}.`,
        );
      }
      out.push("");
      out.push("**Ahorro que la capa se atribuye en su propio informe** (declarado, no medido por el banco; por base):");
      out.push("");
      out.push(declarado(m) || "—");
      const truncadas = Object.entries(r.brazos).map(([b, x]) => `${b} ${x!.truncadas}`).join(", ");
      out.push("");
      out.push(`Respuestas cortadas por el tope: ${truncadas}. Tokens comprimidos (libro 3): ${Object.entries(r.brazos).map(([b, x]) => `${b} ${x!.tokens.comprimidos}`).join(", ")}.`);
      if (m.calibracionS) {
        out.push("");
        out.push(`Calibración del brazo S al terminar: \`${JSON.stringify(m.calibracionS)}\`.`);
      }
    }
  }
  if (art.sinRed) {
    out.push("");
    out.push("## Sin red: las decisiones de la capa sobre el split de test entero (modelado en lo económico)");
    out.push("");
    out.push(
      `${art.sinRed.preguntas} peticiones (cada problema de test seguido de sus derivadas aplicables) por la capa completa con un ` +
        "proveedor falso que contesta «#### <verdad>». Lo que la capa decide servir no depende del modelo, así que las " +
        "decisiones son las del código publicado; el dinero no existe aquí.",
    );
    out.push("");
    out.push("| Configuración | Llamadas al proveedor | Exacta | Semántica | Respuestas de OTRA pregunta | Veto de caché exacta (política) |");
    out.push("|---|---|---|---|---|---|");
    for (const r of art.sinRed.resultados) {
      const tot = (k: "exacta" | "semantica") => Object.values(r.porClase).reduce((s, f) => s + f[k], 0);
      out.push(
        `| ${r.config} | ${r.llamadasAlProveedor}/${r.peticiones} | ${tot("exacta")} | ${tot("semantica")} | **${r.erroneas}** | ${r.vetoCacheExacta} |`,
      );
    }
    for (const r of art.sinRed.resultados) {
      out.push("");
      out.push(`**${r.config}** por clase: ` + Object.entries(r.porClase).map(([c, f]) => `${c} ${f.n} (exacta ${f.exacta}, semántica ${f.semantica}, de otra ${f.erroneas})`).join("; ") + ".");
      if (r.registrosSemanticos !== undefined) out.push(`Registros en la caché semántica al terminar: ${r.registrosSemanticos}.`);
      if (r.calibracion) out.push(`Calibración: \`${JSON.stringify(r.calibracion)}\`.`);
      for (const e of r.evidencias.slice(0, 3)) {
        out.push("");
        out.push(
          `> ${e.clase}, similitud ${e.similitud?.toFixed(3) ?? "—"}: «${e.preguntada}» recibió ${e.servida} (la respuesta de «${e.original}»); la suya es otra.`,
        );
      }
    }
  }
  out.push("");
  out.push("## Limitaciones");
  out.push("");
  for (const l of art.limitaciones) out.push(`- ${l}`);
  out.push("");
  return out.join("\n");
}
