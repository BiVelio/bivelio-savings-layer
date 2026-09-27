/**
 * LA TIRADA DEL COLOCADOR DE PUNTOS DE RUPTURA, SOBRE EL SIMULADOR.
 *
 *     BVSALA_DEV_OPEN=1 pnpm exec tsx benchmarks/colocador-de-cache/tirada.ts
 *
 * Sin red y sin claves: cada escenario pasa por el pipeline y el adaptador de
 * Anthropic de verdad, y un `fetch` factura con las reglas oficiales de la caché
 * de prefijo (ver simulador.ts). Compara tres colocaciones sobre el MISMO texto:
 *
 *   fixed         la de siempre (cabecera + historial antes de la pregunta)
 *   cola-siempre  lo que hacen Vercel (`caching: 'auto'`), LangChain y LiteLLM:
 *                 un punto en el último mensaje en todas las peticiones
 *   auto          `cacheBreakpoints: "auto"`
 *
 * LAS CIFRAS SON [simulado], NO [medido]. El simulador no modela la expulsión
 * por presión de memoria, el aislamiento por workspace ni la concurrencia, y
 * todas esas cosas quitan aciertos. Sirven para comparar colocaciones entre sí;
 * lo que se publique como ahorro tiene que salir del contador del proveedor
 * (ver docs/investigacion/2026-09-27/breakpoints-de-cache.md, «Cómo se medirá»).
 */
import { precioDeListaPropio } from "../../src/pricing/catalogo.js";
import { CacheAnthropicSimulada, dolares } from "./simulador.js";
import { MODELO, agente, capaSobre, chatLento, ragDeUnSoloUso, reloj, type Reloj } from "./escenarios.js";

type Capa = ReturnType<typeof capaSobre>;

const ESCENARIOS: [string, (l: Capa, r: Reloj) => Promise<void>][] = [
  ["agente (20 tareas × 15 pasos, 4 s entre pasos)", (l, r) => agente(l, r, { runs: 20, pasos: 15, huecoMs: 4_000, entreRuns: 20_000 })],
  ["RAG de un solo uso (300 peticiones, 10 s)", (l, r) => ragDeUnSoloUso(l, r, { n: 300, huecoMs: 10_000 })],
  ["chat lento (20 conversaciones × 6 turnos, 8 min)", (l, r) => chatLento(l, r, { conversaciones: 20, turnos: 6, huecoMs: 8 * 60_000 })],
  ["chat rápido (40 conversaciones × 8 turnos, 30 s)", (l, r) => chatLento(l, r, { conversaciones: 40, turnos: 8, huecoMs: 30_000 })],
];

const MODOS = ["fixed", "cola-siempre", "auto"] as const;

async function main(): Promise<void> {
  const precio = precioDeListaPropio(MODELO);
  if (!precio || precio.cachedInputPer1k == null) throw new Error(`sin precio propio para ${MODELO}`);
  const tarifa = { inputPer1k: precio.inputPer1k, outputPer1k: precio.outputPer1k, cachedInputPer1k: precio.cachedInputPer1k };

  console.log(`# Colocador de puntos de ruptura — tirada simulada (${MODELO}, precios del catálogo)\n`);
  console.log("| Escenario | Colocación | Entrada | Lectura | Escritura 5 min | Escritura 1 h | Factura [simulado] | vs fixed | cost.actual del informe |");
  console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const [nombre, correr] of ESCENARIOS) {
    let base = 0;
    for (const modo of MODOS) {
      const r = reloj();
      const sim = new CacheAnthropicSimulada(r.ahora);
      const capa = capaSobre(sim, r, modo);
      let informado = 0;
      const generar = capa.generate.bind(capa);
      (capa as { generate: typeof capa.generate }).generate = (async (req: Parameters<typeof capa.generate>[0]) => {
        const res = await generar(req);
        informado += res.report.cost.actual;
        return res;
      }) as typeof capa.generate;
      await correr(capa, r);
      const t = sim.total();
      const factura = dolares(t, tarifa);
      if (modo === "fixed") base = factura;
      const delta = base > 0 ? `${(((factura - base) / base) * 100).toFixed(1)} %` : "—";
      console.log(
        `| ${nombre} | ${modo} | ${t.input.toLocaleString("es-ES")} | ${t.read.toLocaleString("es-ES")} | ` +
          `${t.write5m.toLocaleString("es-ES")} | ${t.write1h.toLocaleString("es-ES")} | $${factura.toFixed(4)} | ` +
          `${modo === "fixed" ? "—" : delta} | $${informado.toFixed(4)} |`,
      );
    }
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
