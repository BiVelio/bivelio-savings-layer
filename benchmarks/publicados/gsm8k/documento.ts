/**
 * El documento de la batería GSM8K, escrito SOLO desde el artefacto JSON: aquí
 * no se calcula nada nuevo, solo se da forma a lo medido. Medido y modelado van
 * en secciones separadas y cada cifra dice de dónde sale.
 */
import type { Artefacto, MedicionDeModelo } from "./arnes.js";
import type { Comparacion0430 } from "./comparar.js";
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
    if (b !== "A" && x.peticiones > 0 && x.errores === x.peticiones) {
      return `| ${b} | — (falló en todas) | — | ${usd(x.costeUsd)} | — (no hubo llamadas: no es un ahorro) | — | — | — | **${x.errores}** |`;
    }
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

function brazoCaido(m: MedicionDeModelo, b: Brazo): boolean {
  const x = m.resumen?.brazos[b];
  return !!x && b !== "A" && x.peticiones > 0 && x.errores === x.peticiones;
}

/** Una fila por modelo y brazo con capa: lo que hay que leer primero. */
function resumenGeneral(grupos: { etiqueta: string; modelos: readonly MedicionDeModelo[] }[]): string[] {
  const out = [
    "## Resumen por modelo y brazo",
    "",
    "Ahorro MEDIDO vs A (usage del proveedor, precio de lista) y su origen: «caché de la capa» son las posiciones que la capa sirvió sin llamar; «prefijo/llamadas» es la diferencia en las posiciones en que los dos llamaron (caché de prefijo del proveedor más ruido de longitud de salida).",
    "",
    "| Modelo | Brazo | Exactitud A → brazo | Ahorro medido [IC95] | De caché de la capa | De prefijo/llamadas | Tokens leídos de caché del proveedor A → brazo | Respuestas de OTRA pregunta | Latencia p50 A → brazo |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const g of grupos) {
    for (const m of g.modelos) {
      const r = m.resumen;
      if (!r) {
        out.push(`| ${m.modelo}${g.etiqueta} | — | ${m.estado}: ${m.motivo ?? ""} | | | | | | |`);
        continue;
      }
      const a = r.brazos.A;
      for (const b of (["B", "S", "E"] as const).filter((x) => r.brazos[x])) {
        const x = r.brazos[b]!;
        const accA = a ? `${a.exactitud.aciertos}/${a.exactitud.n}` : "—";
        if (brazoCaido(m, b)) {
          out.push(`| ${m.modelo}${g.etiqueta} | ${b} | ${accA} → **falló en todas (${x.errores})** | — | — | — | — | — | — |`);
          continue;
        }
        const c = r.comparaciones.find((y) => y.brazo === b);
        const o = m.origenDelAhorro?.[b];
        const v = r.variantesPorBrazo[b];
        out.push(
          `| ${m.modelo}${g.etiqueta} | ${b} | ${accA} → ${x.exactitud.aciertos}/${x.exactitud.n} | ${ic(c?.ahorroMedido)} | ` +
            `${o ? `${usd(o.cacheCapa.usd)} (${o.cacheCapa.posiciones} pos.)` : "—"} | ${o ? usd(o.llamadas.usd) : "—"} | ` +
            `${o ? `${o.tokensLeidosDeCacheA} → ${o.tokensLeidosDeCacheBrazo}` : "—"} | **${v?.deOtra ?? "—"}** | ${ms(a?.latenciaMs.p50)} → ${ms(x.latenciaMs.p50)} |`,
        );
      }
    }
  }
  return out;
}

function origen(m: MedicionDeModelo): string {
  const o = m.origenDelAhorro;
  if (!o || !Object.keys(o).length) return "";
  const vivos = (Object.keys(o).sort() as Brazo[]).filter((b) => !brazoCaido(m, b));
  if (!vivos.length) return "";
  const filas = vivos.map((b) => {
    const x = o[b]!;
    const d = x.costeA - x.costeBrazo;
    return (
      `| ${b} | ${usd(x.costeA)} → ${usd(x.costeBrazo)} | ${usd(d)} | ${x.cacheCapa.posiciones} pos., ${usd(x.cacheCapa.usd)} | ` +
      `${x.llamadas.posiciones} pos., ${usd(x.llamadas.usd)} | ${usd(x.descuentoPrefijoA)} → ${usd(x.descuentoPrefijoBrazo)} | ` +
      `${x.tokensLeidosDeCacheA} → ${x.tokensLeidosDeCacheBrazo} | ${x.tokensEscritosA} → ${x.tokensEscritosBrazo} |`
    );
  });
  return [
    "**Origen del ahorro medido** (coste(A) − coste(brazo) = caché de la capa + llamadas al proveedor; el descuento de prefijo es lo que el proveedor rebajó por leer de su caché, neto de la prima de escritura, en A y en el brazo):",
    "",
    "| Brazo | Coste A → brazo | Ahorro | Servidas por la capa sin llamar | Con llamada (prefijo + ruido de salida) | Descuento de prefijo A → brazo | Tokens leídos de caché A → brazo | Tokens escritos A → brazo |",
    "|---|---|---|---|---|---|---|---|",
    ...filas,
  ].join("\n");
}

const frac = (a: number, n: number): string => (n ? `${((a / n) * 100).toFixed(1)} % (${a}/${n})` : "—");

function seccionComparacion(c: Comparacion0430): string[] {
  const out: string[] = [];
  out.push(`## ${c.versionAntes} → ${c.versionDespues}: el mismo flujo, otra versión`);
  out.push("");
  out.push(
    `Misma semilla y mismos únicos por modelo que la tirada \`${c.runAntes}\` de la ${c.versionAntes} (gsm8k.json), así que las dos preguntan lo mismo en el mismo orden; ` +
      "se comprueba con la huella de cada petición y se compara solo el prefijo que las dos completaron, con la misma función de resumen. " +
      "Coste y ahorro son MEDIDOS (usage del proveedor); el ahorro es 1 − coste/coste(A) de la MISMA tirada.",
  );
  for (const m of c.modelos) {
    out.push("");
    out.push(
      `### ${m.modelo} — ${m.posiciones} peticiones comparadas; únicos ${m.nUnicosAntes} → ${m.nUnicosDespues}; ` +
        (m.mismoFlujo ? "flujo idéntico (0 huellas distintas)" : `**flujo distinto** (${m.discrepancias} huellas distintas)`),
    );
    out.push("");
    out.push("| Brazo | Exactitud antes → después | Coste medido antes → después | Ahorro vs A antes → después | Aciertos semántica | Variantes servidas de caché | **Respuestas de OTRA pregunta** |");
    out.push("|---|---|---|---|---|---|---|");
    for (const f of m.filas) {
      const a = f.antes;
      const d = f.despues;
      out.push(
        `| ${f.brazo} | ${frac(a.aciertos, a.n)} → ${frac(d.aciertos, d.n)} | ${usd(a.costeUsd)} → ${usd(d.costeUsd)} | ` +
          `${f.brazo === "A" ? "—" : `${pct(a.ahorro)} → ${pct(d.ahorro)}`} | ${a.semanticas} → ${d.semanticas} | ` +
          `${a.variantesDeCache}/${a.variantes} → ${d.variantesDeCache}/${d.variantes} | **${a.deOtra} → ${d.deOtra}** |`,
      );
    }
  }
  if (c.sinRed.filas.length) {
    out.push("");
    out.push(`### Sin red, split de test entero (${c.sinRed.preguntasAntes ?? "—"} → ${c.sinRed.preguntasDespues ?? "—"} peticiones)`);
    out.push("");
    out.push("| Configuración | Llamadas al proveedor antes → después | Semántica antes → después | **Respuestas de OTRA pregunta** |");
    out.push("|---|---|---|---|");
    for (const f of c.sinRed.filas) {
      const x = (v: { llamadas: number; semantica: number; erroneas: number } | null, k: "llamadas" | "semantica" | "erroneas") => (v ? String(v[k]) : "— (no existía)");
      out.push(`| ${f.config} | ${x(f.antes, "llamadas")} → ${x(f.despues, "llamadas")} | ${x(f.antes, "semantica")} → ${x(f.despues, "semantica")} | **${x(f.antes, "erroneas")} → ${x(f.despues, "erroneas")}** |`);
    }
  }
  return out;
}

export function escribirDocumento(art: Artefacto): string {
  const out: string[] = [];
  out.push(
    `# GSM8K ${art.procedencia.version}${art.nombreDocs?.endsWith("gama-alta") ? " gama alta" : ""} — caché exacta, caché semántica y compresión sin perder exactitud (${art.fecha})`,
  );
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
  const topes = art.presupuesto.topesPorModelo
    ? Object.entries(art.presupuesto.topesPorModelo).map(([m, t]) => `${m} ${usd(t)}`).join(", ")
    : `${usd(art.presupuesto.topePorModeloUsd)} por modelo`;
  out.push(`Modo: **${art.modo}**, run \`${art.runId}\`${art.ejecutadaEl ? `, ejecutada el ${art.ejecutadaEl}` : ""}. Gasto real total: **${usd(art.presupuesto.gastoTotalUsd)}** (topes duros en código: ${topes}).`);
  if (art.topeDeSalida !== undefined || art.interruptorSemantico) {
    out.push("");
    out.push(
      `Tope de salida de todos los brazos: ${art.topeDeSalida ?? "ninguno"}. Caché semántica de S y E encendida con: ${art.interruptorSemantico ?? "savings.semanticCache por petición"}.`,
    );
  }
  if (art.red) {
    out.push("");
    out.push(
      `Hosts vistos durante la medición: ${Object.entries(art.red.hostsVistos).map(([h, n]) => `${h} (${n})`).join(", ") || "ninguno"}; ` +
        `bloqueados: ${Object.entries(art.red.bloqueados).map(([h, n]) => `${h} (${n})`).join(", ") || "ninguno"}. Permitidos: ${art.red.hostsPermitidos.join(", ")}.`,
    );
  }
  if (art.comparacion) out.push("", ...seccionComparacion(art.comparacion));
  out.push("");
  out.push(
    ...resumenGeneral([
      { etiqueta: "", modelos: art.modelos },
      ...(art.suplemento ? [{ etiqueta: art.suplemento.parcheGemini ? " (parche del banco)" : " (suplemento)", modelos: art.suplemento.modelos }] : []),
    ]),
  );
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
  out.push(...seccionModelos(art.modelos, "###"));
  if (art.suplemento) {
    const sup = art.suplemento;
    out.push("");
    out.push(`## Suplemento: ${sup.parcheGemini ? "Gemini con el parche declarado del banco (NO es el producto)" : "segunda tirada"} — run \`${sup.runId}\``);
    out.push("");
    if (sup.parcheGemini) out.push(`> ${sup.parcheGemini.descripcion} Campos quitados en esta tirada: ${sup.parcheGemini.camposQuitados}.`, "");
    out.push(
      `Misma semilla y mismo diseño; A se vuelve a medir en esta tirada para que el emparejamiento sea dentro de la misma. Gasto real: **${usd(sup.presupuesto.gastoTotalUsd)}**. ` +
        (sup.red ? `Hosts vistos: ${Object.entries(sup.red.hostsVistos).map(([h, n]) => `${h} (${n})`).join(", ") || "ninguno"}; bloqueados: ${Object.entries(sup.red.bloqueados).map(([h, n]) => `${h} (${n})`).join(", ") || "ninguno"}.` : ""),
    );
    out.push(...seccionModelos(sup.modelos, "###", sup.parcheGemini ? " (parche del banco)" : " (suplemento)"));
    if (sup.limitaciones.length) {
      out.push("", "Limitaciones del suplemento:", "");
      for (const l of sup.limitaciones) out.push(`- ${l}`);
    }
  }
  return cierre(art, out);
}

function seccionModelos(modelos: readonly MedicionDeModelo[], h: string, sufijo = ""): string[] {
  const out: string[] = [];
  for (const m of modelos) {
    out.push("");
    out.push(`${h} ${m.modelo}${sufijo}`);
    out.push("");
    out.push(
      `Estado: **${m.estado}**${m.motivo ? ` — ${m.motivo}` : ""}. Host: ${m.host ?? "—"}. Muestreo: \`${JSON.stringify(m.muestreo)}\`. ` +
        `Tope de salida: ${m.topeDeSalida ?? "ninguno"}. Gasto real: **${usd(m.gasto.totalUsd)}** ` +
        `(${Object.entries(m.gasto.porBrazo).map(([k, v]) => `${k} ${usd(v)}`).join(", ")}).`,
    );
    if (m.precioFueraDeCatalogo) {
      out.push("");
      out.push(`Precio (sin fila en el catálogo, solo en el banco): ${m.precioFueraDeCatalogo}.`);
    }
    if (m.sondaDetalle?.length) {
      out.push("");
      out.push(`Sonda (brazo A, 3 llamadas): salida ${m.sondaDetalle.map((x) => `${x.salida} (${x.finish ?? "—"})`).join(", ")} tokens.` +
        (m.pensamientoOcultoPorBrazo ? ` Pensamiento de Gemini facturado y ausente de completion_tokens: ${Object.entries(m.pensamientoOcultoPorBrazo).map(([k, v]) => `${k} ${v}`).join(", ")} tokens.` : ""));
    }
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
      const org = origen(m);
      if (org) out.push("", org);
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
  return out;
}

function cierre(art: Artefacto, out: string[]): string {
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
