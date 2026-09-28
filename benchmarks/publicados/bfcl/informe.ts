/**
 * EL INFORME DE LA BATERÍA BFCL: agregados por modelo y el Markdown.
 * ---------------------------------------------------------------------------
 * Separa lo MEDIDO (coste de cada brazo desde el `usage` crudo del proveedor,
 * exactitud AST) de lo MODELADO (lo que el informe de la capa dice haber
 * ahorrado: `baselineEstimate − actual`, con su `basis`). Intervalos: Wilson
 * para proporciones, bootstrap pareado (semilla fija) para diferencias y para
 * la fracción de ahorro, estratificado por categoría.
 */
import { bootstrapMeanCI, bootstrapRatioCI, bootstrapRatioCIEstratificado, wilsonCI, type CI } from "../../stats.js";
import type { Artefacto, RegistroAst, TiradaDeModelo } from "./arnes.js";

export interface ResumenDeModelo {
  modelo: string;
  n: number;
  exactitudA: CI | null;
  exactitudB: CI | null;
  porCategoria: Record<string, { n: number; aciertosA: number; aciertosB: number }>;
  pares: { ambos: number; soloA: number; soloB: number; ninguno: number };
  diferenciaExactitud: CI;
  mismasLlamadas: number;
  /** Casos en que la capa devolvió llamadas distintas de las que trajo el proveedor. */
  infieles: string[];
  erroresB: { id: string; error: string }[];
  erroresA: { id: string; error: string }[];
  diferenciasDelCable: Record<string, { casos: number; ejemplo: string }>;
  marcasDeCacheB: number;
  coste: {
    A: number;
    B: number;
    ahorro: CI;
    ahorroAgrupado: CI;
    tokens: { A: TokensDeBrazo; B: TokensDeBrazo };
  };
  modelado: { ahorroQueDiceLaCapa: number; porBasis: Record<string, number>; cache: Record<string, number> };
  repeticiones: { n: number; cacheB: Record<string, number>; costeA: number; costeB: number; llamadasB: number };
  multiTurno: {
    entradas: number;
    violaciones: string[];
    herramientasOmitidasPorB: number;
    /** Paso 0: alguna llamada del brazo es una función del primer turno de referencia de BFCL (señal informativa). */
    paso0EnReferencia: { A: number; B: number };
    /** Paso 0: el brazo no llamó a ninguna herramienta. */
    paso0SinLlamada: { A: number; B: number };
    costeA: number;
    costeB: number;
  };
  gasto: { total: number; A: number; B: number; tope: number; abortado: boolean; llamadas: { A: number; B: number } };
}

interface TokensDeBrazo {
  entrada: number;
  lecturaCache: number;
  escrituraCache: number;
  salida: number;
}

const suma = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

function tokens(rs: RegistroAst[], b: "A" | "B"): TokensDeBrazo {
  return {
    entrada: suma(rs.map((r) => r[b].entrada)),
    lecturaCache: suma(rs.map((r) => r[b].lecturaCache)),
    escrituraCache: suma(rs.map((r) => r[b].escrituraCache)),
    salida: suma(rs.map((r) => r[b].salida)),
  };
}

/** ¿Alguna llamada es a una función que aparece en el primer turno de referencia (`nombre(...)`)? */
function enReferencia(llamadas: { name: string }[], referencia: string[]): boolean {
  const nombres = new Set(referencia.map((r) => r.split("(")[0]!.trim()));
  return llamadas.some((l) => nombres.has(l.name));
}

export function resumir(t: TiradaDeModelo): ResumenDeModelo {
  // Solo pares completos: los dos brazos obtuvieron respuesta del proveedor (o la capa respondió sin él).
  const rs = t.ast.filter((r) => r.A.ok && r.B.ok);
  const n = rs.length;
  const kA = rs.filter((r) => r.A.correcto).length;
  const kB = rs.filter((r) => r.B.correcto).length;
  const porCategoria: ResumenDeModelo["porCategoria"] = {};
  for (const r of rs) {
    const c = (porCategoria[r.categoria] ??= { n: 0, aciertosA: 0, aciertosB: 0 });
    c.n++;
    if (r.A.correcto) c.aciertosA++;
    if (r.B.correcto) c.aciertosB++;
  }
  const dif: ResumenDeModelo["diferenciasDelCable"] = {};
  for (const r of rs) {
    for (const d of r.B.diferenciasDelCable) {
      const clave = d.replace(/\[.*?\]/, "[]").split(":")[0]!.trim();
      const e = (dif[clave] ??= { casos: 0, ejemplo: `${r.id} → ${d}` });
      e.casos++;
    }
  }
  const estratos = [...new Set(rs.map((r) => r.categoria))].map((c) => {
    const xs = rs.filter((r) => r.categoria === c);
    return { costA: xs.map((r) => r.A.coste), costB: xs.map((r) => r.B.coste) };
  });
  const porBasis: Record<string, number> = {};
  const cache: Record<string, number> = {};
  let dice = 0;
  for (const r of rs) {
    const inf = r.B.informe;
    if (!inf) continue;
    porBasis[inf.basis] = (porBasis[inf.basis] ?? 0) + 1;
    cache[inf.cache] = (cache[inf.cache] ?? 0) + 1;
    dice += inf.baselineEstimate - inf.actual;
  }
  const cacheRep: Record<string, number> = {};
  for (const r of t.repeticiones) cacheRep[r.cacheB] = (cacheRep[r.cacheB] ?? 0) + 1;
  const mt = t.multiTurno;
  return {
    modelo: t.modelo,
    n,
    exactitudA: wilsonCI(kA, n),
    exactitudB: wilsonCI(kB, n),
    porCategoria,
    pares: {
      ambos: rs.filter((r) => r.A.correcto && r.B.correcto).length,
      soloA: rs.filter((r) => r.A.correcto && !r.B.correcto).length,
      soloB: rs.filter((r) => !r.A.correcto && r.B.correcto).length,
      ninguno: rs.filter((r) => !r.A.correcto && !r.B.correcto).length,
    },
    diferenciaExactitud: bootstrapMeanCI(rs.map((r) => Number(r.B.correcto) - Number(r.A.correcto)), { seed: 0xbfc1 }),
    mismasLlamadas: rs.filter((r) => r.mismasLlamadas).length,
    infieles: t.ast.filter((r) => r.B.fiel === false).map((r) => r.id),
    erroresB: t.ast.filter((r) => !r.B.ok).map((r) => ({ id: r.id, error: r.B.error ?? "" })),
    erroresA: t.ast.filter((r) => !r.A.ok).map((r) => ({ id: r.id, error: r.A.error ?? "" })),
    diferenciasDelCable: dif,
    marcasDeCacheB: suma(rs.map((r) => r.B.marcasDeCache)),
    coste: {
      A: suma(rs.map((r) => r.A.coste)),
      B: suma(rs.map((r) => r.B.coste)),
      ahorro: bootstrapRatioCIEstratificado(estratos, { seed: 0xbfc2 }),
      ahorroAgrupado: bootstrapRatioCI(rs.map((r) => r.A.coste), rs.map((r) => r.B.coste), { seed: 0xbfc3 }),
      tokens: { A: tokens(rs, "A"), B: tokens(rs, "B") },
    },
    modelado: { ahorroQueDiceLaCapa: dice, porBasis, cache },
    repeticiones: {
      n: t.repeticiones.length,
      cacheB: cacheRep,
      costeA: suma(t.repeticiones.map((r) => r.costeA)),
      costeB: suma(t.repeticiones.map((r) => r.costeB)),
      llamadasB: suma(t.repeticiones.map((r) => r.llamadasAlProveedorB)),
    },
    multiTurno: {
      entradas: mt.length,
      violaciones: mt.flatMap((m) => m.violaciones.map((v) => `${m.id}: ${v}`)),
      paso0EnReferencia: {
        A: mt.filter((m) => enReferencia(m.paso0.A.llamadas, m.paso0.referenciaTurno1)).length,
        B: mt.filter((m) => enReferencia(m.paso0.B.llamadas, m.paso0.referenciaTurno1)).length,
      },
      paso0SinLlamada: { A: mt.filter((m) => m.paso0.A.llamadas.length === 0).length, B: mt.filter((m) => m.paso0.B.llamadas.length === 0).length },
      herramientasOmitidasPorB: mt.filter((m) => m.paso0.B.herramientasEnCable > 0 && m.paso0.B.herramientasEnCable < m.paso0.A.herramientasEnCable).length,
      costeA: suma(mt.flatMap((m) => [m.paso0.A.coste, ...m.variantes.map((v) => v.costeA)])),
      costeB: suma(mt.flatMap((m) => [m.paso0.B.coste, ...m.variantes.map((v) => v.costeB)])),
    },
    gasto: { total: t.gastado, A: t.gastoPorBrazo.A, B: t.gastoPorBrazo.B, tope: t.tope, abortado: t.abortadoPorPresupuesto, llamadas: t.llamadasPorBrazo },
  };
}

const pct = (x: number | undefined) => (x === undefined ? "—" : `${(x * 100).toFixed(1)} %`);
const ci = (c: CI | null) => (c ? `${pct(c.point)} [${pct(c.lower)}, ${pct(c.upper)}]` : "—");
const usd = (x: number) => `${x.toFixed(4)} $`;
const pp = (c: CI) => `${(c.point * 100).toFixed(1)} pp [${(c.lower * 100).toFixed(1)}, ${(c.upper * 100).toFixed(1)}]`;

/** Un modelo sin una sola respuesta válida del proveedor en el brazo A no se midió (credencial, id, cuota). */
export function noMedido(t: TiradaDeModelo): string | null {
  const intentos = t.ast.length + t.multiTurno.length;
  const buenas = t.ast.filter((r) => r.A.ok).length + t.multiTurno.filter((m) => !m.paso0.A.error).length;
  if (intentos > 0 && buenas === 0) {
    return t.ast[0]?.A.error ?? t.multiTurno[0]?.paso0.A.error ?? "no successful provider response";
  }
  return intentos === 0 ? "no entry ran" : null;
}

/** La sección que compara esta tirada con la de otra versión del paquete (la 0.4.30), modelo a modelo. */
function comparacion(a: Artefacto, rs: ResumenDeModelo[]): string[] {
  const c = a.comparacion!;
  const l: string[] = [];
  l.push(`## ${c.version} → ${a.paquete.version}: what changed`);
  l.push("");
  l.push(
    `Previous run: \`${c.fichero}\` (${c.tag}, tag commit \`${c.commitDelTag.slice(0, 7)}\`, ${c.fecha.slice(0, 10)}; ${c.config.n}/category AST, ${c.config.multi} multi-turn, seed ${c.config.semilla}). ` +
      `Same dataset commit, same seed, so the same AST entries and the same multi_turn_base entries${c.config.semilla === a.config.semilla && c.config.multi === a.config.multi ? "" : " (**config differs: see both artifacts**)"}. ` +
      "Arm A is re-measured in each run (the models are nondeterministic), so compare B against its own A first, then across versions.",
  );
  l.push("");
  l.push(`### Multi-turn step 0 (the #382 fix: an untyped catalogue is no longer cut to 8 tools)`);
  l.push("");
  l.push(`| Model | version | tools on the wire A → B | entries B sent fewer tools | step 0 in BFCL's reference turn 1, A / B | step 0 no tool call, A / B |`);
  l.push("|---|---|---|---|---|---|");
  for (const r of rs) {
    const antes = c.resumen.find((x) => x.modelo === r.modelo);
    const t = a.modelos.find((x) => x.modelo === r.modelo)!;
    const fila = (v: string, x: ResumenDeModelo, cable: string) =>
      `| ${r.modelo} | ${v} | ${cable} | ${x.multiTurno.herramientasOmitidasPorB}/${x.multiTurno.entradas} | ${x.multiTurno.paso0EnReferencia.A} / ${x.multiTurno.paso0EnReferencia.B} | ${x.multiTurno.paso0SinLlamada.A} / ${x.multiTurno.paso0SinLlamada.B} |`;
    if (antes) l.push(fila(c.version, antes, (c.multiTurno[r.modelo] ?? []).map((m) => `${m.herramientasEnCable.A}→${m.herramientasEnCable.B}`).join(", ")));
    l.push(fila(a.paquete.version, r, t.multiTurno.map((m) => `${m.paso0.A.herramientasEnCable}→${m.paso0.B.herramientasEnCable}`).join(", ")));
  }
  l.push("");
  l.push("### AST");
  l.push("");
  l.push("| Model | version | n | acc. A | acc. B | B − A (paired) | same calls | layer changed a call | saving (measured) |");
  l.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of rs) {
    const antes = c.resumen.find((x) => x.modelo === r.modelo);
    const fila = (v: string, x: ResumenDeModelo) =>
      `| ${r.modelo} | ${v} | ${x.n} | ${ci(x.exactitudA)} | ${ci(x.exactitudB)} | ${pp(x.diferenciaExactitud)} | ${x.mismasLlamadas}/${x.n} | ${x.infieles.length} | ${ci(x.coste.ahorro)} |`;
    if (antes) l.push(fila(c.version, antes));
    l.push(fila(a.paquete.version, r));
  }
  l.push("");
  const sinPrevio = rs.filter((r) => !c.resumen.some((x) => x.modelo === r.modelo)).map((r) => r.modelo);
  if (sinPrevio.length) l.push(`Not in the previous run (nothing to compare): ${sinPrevio.join(", ")}.\n`);
  return l;
}

export function escribirInforme(a: Artefacto): string {
  const sinMedir = a.modelos.filter((t) => noMedido(t) !== null);
  a = { ...a, modelos: a.modelos.filter((t) => noMedido(t) === null) };
  const rs = a.modelos.map(resumir);
  const l: string[] = [];
  l.push(`# BFCL A/B — ${a.fecha.slice(0, 10)} (${a.modo})`);
  l.push("");
  if (a.modo === "MOCK") l.push("> **MOCK**: simulated provider, no network. Nothing here is a measurement.\n");
  l.push(`- **Dataset:** Berkeley Function Calling Leaderboard, \`${a.dataset.repo}@${a.dataset.commit}\` (${a.dataset.licencia}), fetched at run time and sha256-checked per file (\`benchmarks/publicados/bfcl/datos.ts\`); not vendored.`);
  l.push(`- **Arm A:** direct provider call with native tools (Anthropic Messages \`tool_use\` / OpenAI Chat Completions \`tools\`), hand-written, no layer.`);
  const origen =
    a.paquete.origenDelFuente === "git-archive"
      ? `loaded from \`git archive ${a.paquete.tag} src\` (this tree differs from the tag in ${(a.paquete.diferenciasDelArbol ?? []).map((f) => `\`${f}\``).join(", ")}, so the tree was NOT measured)`
      : `\`git diff ${a.paquete.tag} -- src/ packages/\` empty`;
  l.push(`- **Arm B:** ${a.paquete.etiqueta} — tag commit \`${a.paquete.commitDelTag.slice(0, 7)}\`, ${origen}; npm integrity \`${a.paquete.integridadNpm.slice(0, 24)}…\`, dist sha256 \`${a.paquete.sha256DistNpm.slice(0, 12)}…\`. Default config: provider only (no licenseServerUrl, no service key, no exporters).`);
  l.push(`- **Hosts contacted during the run:** ${a.paquete.hostsVistos.join(", ") || "(none)"}; refused by the host guard: ${a.paquete.hostsRechazados.join(", ") || "none"}.${
    (a.noMedibles ?? []).some((x) => x.modelo.startsWith("anthropic/")) && !a.modelos.some((t) => t.familia === "anthropic")
      ? " api.anthropic.com was contacted only by the free key check (`GET /v1/models`), which returned 401: no Anthropic model was billed."
      : ""
  }`);
  l.push(`- **Sample:** ${a.config.n} per AST category (simple, multiple, parallel, parallel_multiple), stratified, seed ${a.config.semilla}, round-robin order; ${a.config.repes} deliberate AST repeats; ${a.config.multi} multi_turn_base entries for the cache-isolation probe. Budget per model (A+B, hard cap in code): ${a.modelos.map((t) => `${t.modelo} ${usd(t.tope + (a.config.gastoPrevioDescontado?.[t.modelo] ?? 0))}`).join(", ") || "—"}; enforced before every call.`);
  l.push("");
  if (sinMedir.length || a.noMedibles?.length) {
    l.push("## Not measured");
    l.push("");
    for (const x of a.noMedibles ?? []) l.push(`- **${x.modelo}**: ${x.motivo}. No paid call was made (spend 0.0000 $). Not a finding about the layer.`);
    for (const t of sinMedir) {
      l.push(`- **${t.modelo}**: every call failed in BOTH arms before any tokens were billed (spend ${usd(t.gastado)}): \`${(noMedido(t) ?? "").slice(0, 220)}\`. Not a finding about the layer.`);
    }
    l.push("");
  }
  l.push("## Per model");
  l.push("");
  l.push("| Model | n | AST acc. A | AST acc. B | B − A (paired) | same calls | layer changed a call | cost A | cost B | saving (measured, stratified) | spend (A+B, all parts) |");
  l.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rs) {
    l.push(
      `| ${r.modelo} | ${r.n} | ${ci(r.exactitudA)} | ${ci(r.exactitudB)} | ${pp(r.diferenciaExactitud)} | ${r.mismasLlamadas}/${r.n} | ${r.infieles.length} | ${usd(r.coste.A)} | ${usd(r.coste.B)} | ${ci(r.coste.ahorro)} | ${usd(r.gasto.total)}${r.gasto.abortado ? " (stopped by budget)" : ""} |`,
    );
  }
  l.push("");
  l.push("Accuracy: Wilson 95 % interval. B − A: paired bootstrap of per-entry correctness (seed fixed). Saving: 1 − ΣB/ΣA over AST pairs, bootstrap stratified by category, both arms priced from the provider's own `usage` with the SDK catalogue list prices (`cable.ts`). Spend includes AST, repeats and the multi-turn probe.");
  l.push("");
  l.push("## Accuracy by category (correct A / correct B / n)");
  l.push("");
  l.push(`| Model | ${["simple", "multiple", "parallel", "parallel_multiple"].join(" | ")} |`);
  l.push("|---|---|---|---|---|");
  for (const r of rs) {
    const c = (k: string) => {
      const x = r.porCategoria[k];
      return x ? `${x.aciertosA} / ${x.aciertosB} / ${x.n}` : "—";
    };
    l.push(`| ${r.modelo} | ${c("simple")} | ${c("multiple")} | ${c("parallel")} | ${c("parallel_multiple")} |`);
  }
  l.push("");
  l.push("## Cost, cache and what the layer claims");
  l.push("");
  l.push("| Model | input tok A / B | cache read A / B | cache write A / B | output tok A / B | cache_control marks in B | layer's own claimed saving (modelled) | B report basis | B exact-cache results |");
  l.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of rs) {
    const { A, B } = r.coste.tokens;
    l.push(
      `| ${r.modelo} | ${A.entrada} / ${B.entrada} | ${A.lecturaCache} / ${B.lecturaCache} | ${A.escrituraCache} / ${B.escrituraCache} | ${A.salida} / ${B.salida} | ${r.marcasDeCacheB} | ${usd(r.modelado.ahorroQueDiceLaCapa)} | ${JSON.stringify(r.modelado.porBasis)} | ${JSON.stringify(r.modelado.cache)} |`,
    );
  }
  l.push("");
  l.push("*Measured* = the two columns priced from each arm's provider `usage`. *Modelled* = Σ(`report.cost.baselineEstimate − report.cost.actual`) from the layer's own report; it is not a measurement and is shown only to compare with the measured delta.");
  l.push("");
  l.push("## Deliberate repeats (AST, a tool-call turn must never be served from cache)");
  l.push("");
  l.push("| Model | repeats | B cache result | B provider calls | cost A | cost B |");
  l.push("|---|---|---|---|---|---|");
  for (const r of rs) l.push(`| ${r.modelo} | ${r.repeticiones.n} | ${JSON.stringify(r.repeticiones.cacheB)} | ${r.repeticiones.llamadasB} | ${usd(r.repeticiones.costeA)} | ${usd(r.repeticiones.costeB)} |`);
  l.push("");
  l.push("## Multi-turn cache isolation (#368, live)");
  l.push("");
  l.push("Per entry: step 0 (first user turn, all the entry's tools) in both arms; then five continuations built from the SAME tool call: V1 result ok; V2 same content with `isError: true`; V3 one argument changed; V4 exact repeat of V1 (fresh call ids); V5 exact repeat of V2. V2 and V3 must never be served from cache; V4/V5 may, but only with their own original's answer. Tool results are synthetic (the bench does not execute BFCL's Python classes), so this is NOT BFCL's multi-turn accuracy metric.");
  l.push("");
  for (const t of a.modelos) {
    for (const m of t.multiTurno) {
      const vs = m.variantes.map((v) => `${v.variante}: ${v.cacheB}/${v.llamadasAlProveedorB} call${v.llamadasAlProveedorB === 1 ? "" : "s"}`).join(" · ");
      l.push(
        `- **${t.modelo} · ${m.id}** (${m.clases.join("+")}, ${m.herramientas} tools; on the wire A ${m.paso0.A.herramientasEnCable} / B ${m.paso0.B.herramientasEnCable}) — ` +
          `${m.omitido ?? vs}${m.violaciones.length ? ` — **VIOLATIONS:** ${m.violaciones.join("; ")}` : " — no violation"}`,
      );
    }
  }
  l.push("");
  l.push("| Model | entries | step 0: a call in BFCL's reference turn 1, A / B | step 0: no tool call at all, A / B | tools on the wire (A → B) |");
  l.push("|---|---|---|---|---|");
  for (const r of rs) {
    const t = a.modelos.find((x) => x.modelo === r.modelo)!;
    const cable = t.multiTurno.map((m) => `${m.paso0.A.herramientasEnCable}→${m.paso0.B.herramientasEnCable}`).join(", ");
    l.push(`| ${r.modelo} | ${r.multiTurno.entradas} | ${r.multiTurno.paso0EnReferencia.A} / ${r.multiTurno.paso0EnReferencia.B} | ${r.multiTurno.paso0SinLlamada.A} / ${r.multiTurno.paso0SinLlamada.B} | ${cable} |`);
  }
  l.push("");
  l.push("## Findings about the layer (A≠B)");
  l.push("");
  let hubo = false;
  for (const r of rs) {
    const t = a.modelos.find((x) => x.modelo === r.modelo)!;
    if (r.infieles.length) {
      hubo = true;
      l.push(`- **${r.modelo}: the layer returned tool calls different from the provider's raw response** in ${r.infieles.join(", ")}.`);
    }
    for (const e of r.erroresB) {
      hubo = true;
      l.push(`- **${r.modelo} · ${e.id}: arm B failed** — \`${e.error}\``);
    }
    for (const [k, v] of Object.entries(r.diferenciasDelCable)) {
      hubo = true;
      l.push(`- ${r.modelo}: request body differs from arm A in \`${k}\` in ${v.casos}/${r.n} AST cases (e.g. \`${v.ejemplo.slice(0, 260)}\`).`);
    }
    if (r.multiTurno.herramientasOmitidasPorB) {
      hubo = true;
      const recortes = t.multiTurno
        .filter((m) => m.paso0.B.herramientasEnCable > 0 && m.paso0.B.herramientasEnCable < m.paso0.A.herramientasEnCable)
        .map((m) => `${m.paso0.A.herramientasEnCable}→${m.paso0.B.herramientasEnCable}`);
      l.push(
        `- **${r.modelo}: in ${r.multiTurno.herramientasOmitidasPorB}/${r.multiTurno.entradas} multi-turn entries the layer sent fewer tools than the caller declared** (${recortes.join(", ")}). ` +
          `Step 0 hit a function of BFCL's reference first turn in ${r.multiTurno.paso0EnReferencia.A}/${r.multiTurno.entradas} entries without the layer and ` +
          `${r.multiTurno.paso0EnReferencia.B}/${r.multiTurno.entradas} with it; with the layer the model made no tool call at all in ${r.multiTurno.paso0SinLlamada.B}/${r.multiTurno.entradas}. ` +
          (t.avisosDeLaCapa.length === 0 ? "The layer printed NO warning for it; the only trace is `report.traces` (`tool-selector`)." : "The layer printed a warning (below)."),
      );
    }
    for (const v of r.multiTurno.violaciones) {
      hubo = true;
      l.push(`- **${r.modelo}: cache isolation violated** — ${v}`);
    }
    for (const e of t.errores) {
      hubo = true;
      l.push(`- ${r.modelo}: harness error — \`${e}\``);
    }
  }
  if (!hubo) l.push("- None observed.");
  l.push("");
  const avisos = [...new Set(a.modelos.flatMap((t) => t.avisosDeLaCapa))];
  if (avisos.length) {
    l.push("## Warnings the layer printed");
    l.push("");
    for (const w of avisos) l.push(`- \`${w.slice(0, 400).replace(/`/g, "'")}\``);
    l.push("");
  }
  if (a.comparacion) l.push(...comparacion(a, rs));
  l.push("## Spend");
  l.push("");
  l.push("| Model | A | B | this run | earlier runs of this battery (pilot, aborted) | total | budget | calls A / B |");
  l.push("|---|---|---|---|---|---|---|---|");
  const previo = (m: string) => a.config.gastoPrevioDescontado?.[m] ?? 0;
  for (const r of rs) {
    l.push(
      `| ${r.modelo} | ${usd(r.gasto.A)} | ${usd(r.gasto.B)} | ${usd(r.gasto.total)} | ${usd(previo(r.modelo))} | ${usd(r.gasto.total + previo(r.modelo))} | ${usd(r.gasto.tope + previo(r.modelo))} | ${r.gasto.llamadas.A} / ${r.gasto.llamadas.B} |`,
    );
  }
  l.push("");
  l.push("The budget is enforced across every live run of this battery: before starting, the cost of every earlier live call (the cable log) is subtracted from the per-model cap.");
  l.push("");
  l.push("## Limitations");
  l.push("");
  l.push("- A stratified subsample, not the full BFCL categories; intervals are conditional on it.");
  l.push("- The AST checker is a TypeScript port of BFCL's Python checker (`ast.ts`, pinned by tests). On Anthropic both arms read `tool_use.input` through `JSON.parse`, so `5` and `5.0` are indistinguishable there (the int-vs-float check is slightly more lenient than BFCL's Python on that provider, equally for both arms).");
  l.push("- Multi-turn: only the first user turn and one synthetic tool round per entry; BFCL's state-based multi-turn scoring is not reproduced.");
  l.push("- Models are nondeterministic (sonnet-5 and gpt-5.4-mini reason and do not take temperature 0), so A≠B in *which* call was made is expected noise; a call the layer changed after the provider returned it is not, and is checked separately (`layer changed a call`).");
  l.push("- Costs use list prices from the SDK catalogue, not the invoice.");
  l.push("");
  return `${l.join("\n")}\n`;
}
