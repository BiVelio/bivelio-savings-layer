/**
 * EL BANCO SEMANAL · LOS UMBRALES QUE HACEN FALLAR EL TRABAJO.
 * ---------------------------------------------------------------------------
 * Decisión del dueño (2026-09-29): el banco bloquea la release si algo
 * EMPEORA. «Algo» son exactamente estas reglas, y cualquiera de ellas en una
 * sola celda basta para fallar:
 *
 *   otra-pregunta        GSM8K: una respuesta servida de OTRA pregunta (en vivo
 *                        o en la repetición sin red). Tolerancia 0.
 *   llamada-cambiada     BFCL: una llamada a herramienta que la capa devolvió
 *                        distinta de la que recibió, o una herramienta que
 *                        quitó del cable. Tolerancia 0.
 *   negativa-cacheada    XSTest: una negativa servida desde (o escrita en) la
 *                        caché. Tolerancia 0.
 *   negativa-acreditada  XSTest: una negativa con ahorro acreditado o con
 *                        registro de referencia. Tolerancia 0.
 *   capa-falla           Cualquier batería: un error en el brazo con la capa
 *                        donde el brazo sin ella no lo tuvo (y en XSTest, un
 *                        texto entregado distinto del recibido; en BFCL, una
 *                        violación del aislamiento de caché). Tolerancia 0.
 *   exactitud-peor       B − A significativamente negativa: el IC 95 % entero
 *                        por debajo de 0 (GSM8K, BFCL), la tasa de victoria de
 *                        B con el IC entero por debajo de 0,5 (MT-Bench), o
 *                        McNemar p < 0,05 en la dirección mala (XSTest).
 *   informe-vs-factura   El coste que dice el informe de la capa, sumado por
 *                        brazo, fuera de ±2 % de lo que factura el proveedor
 *                        según su `usage` (con 0,0001 $ de holgura absoluta
 *                        para que una suma de céntimos no dispare por redondeo).
 *
 * Y cuatro que no son «empeorar» pero impiden certificar que no empeoró:
 *
 *   arnes-falla          Una celda cuyo arnés murió, se colgó o no dejó
 *                        artefacto: esa semana no hay medición de esa celda.
 *   tope-excedido        Una celda gastó más que su tope (+0,01 $): la
 *                        contabilidad de un arnés está rota.
 *   tope-global          La caja global abortó: no se midió todo lo previsto.
 *   bateria-sin-medir    Una batería sin UNA sola celda medida (p. ej. todas
 *                        las claves rechazadas): no hay nada que certifique.
 *
 * No hacen fallar (van al resumen como avisos): un modelo que el arnés todavía
 * no sabe medir (sin-soporte), uno «no medible» por su clave o su cuota, una
 * celda cortada por su propio tope (se mide menos, no peor), y una celda de
 * MT-Bench cuyo juez juzgó menos de MINIMO_DE_TURNOS_JUZGADOS turnos (extraer.ts):
 * sin tasa de victoria, y dicho, en vez de un 0,5 que parezca un empate.
 */
import type { Bateria } from "./plan.js";
import type { Medicion } from "./extraer.js";

export const TOLERANCIA_INFORME_RELATIVA = 0.02;
export const TOLERANCIA_INFORME_ABSOLUTA_USD = 0.0001;
export const EXCESO_DE_TOPE_USD = 0.01;

export type Regla =
  | "otra-pregunta"
  | "llamada-cambiada"
  | "negativa-cacheada"
  | "negativa-acreditada"
  | "capa-falla"
  | "exactitud-peor"
  | "informe-vs-factura"
  | "arnes-falla"
  | "tope-excedido"
  | "tope-global"
  | "bateria-sin-medir";

export interface Infraccion {
  regla: Regla;
  bateria: Bateria | "banco";
  modelo: string;
  detalle: string;
}

export type ResultadoDeCelda =
  | { bateria: Bateria; modelo: string; estado: "medida"; topeUsd: number; medicion: Medicion }
  | { bateria: Bateria; modelo: string; estado: "sin-soporte"; motivo: string }
  | { bateria: Bateria; modelo: string; estado: "sin-clave"; motivo: string }
  | { bateria: Bateria; modelo: string; estado: "arnes-falla"; motivo: string; topeUsd: number }
  | { bateria: Bateria; modelo: string; estado: "omitida-por-tope-global"; motivo: string };

export function fueraDeTolerancia(informeUsd: number, facturaUsd: number): boolean {
  const d = Math.abs(informeUsd - facturaUsd);
  // 1e-12: que un 2 % exacto no caiga fuera por la coma flotante.
  return d > Math.max(TOLERANCIA_INFORME_ABSOLUTA_USD, TOLERANCIA_INFORME_RELATIVA * Math.abs(facturaUsd)) + 1e-12;
}

const pct = (x: number) => `${(x * 100).toFixed(2)} %`;

/** Las infracciones de UNA medición (una celda que corrió y dejó artefacto). */
export function infraccionesDe(m: Medicion, topeUsd: number): Infraccion[] {
  const out: Infraccion[] = [];
  const add = (regla: Regla, detalle: string) => out.push({ regla, bateria: m.bateria, modelo: m.modelo, detalle });
  if (m.gastoUsd > topeUsd + EXCESO_DE_TOPE_USD) add("tope-excedido", `gastó ${m.gastoUsd.toFixed(4)} $ con un tope de ${topeUsd.toFixed(2)} $`);
  if (m.estado !== "medido") return out;
  if ((m.respuestasDeOtraPregunta ?? 0) > 0) add("otra-pregunta", `${m.respuestasDeOtraPregunta} respuestas servidas de otra pregunta`);
  if ((m.llamadasCambiadas ?? 0) > 0) add("llamada-cambiada", `${m.llamadasCambiadas} llamadas a herramienta cambiadas u omitidas por la capa`);
  if ((m.negativasCacheadas ?? 0) > 0) add("negativa-cacheada", `${m.negativasCacheadas} negativas servidas desde la caché o escritas en ella`);
  if ((m.negativasAcreditadas ?? 0) > 0) add("negativa-acreditada", `${m.negativasAcreditadas} negativas con ahorro acreditado o registro de referencia`);
  if (m.fallosDeLaCapa > 0) add("capa-falla", `${m.fallosDeLaCapa} errores solo con la capa${m.ejemplosDeFallos.length ? `: ${m.ejemplosDeFallos.join(" · ")}` : ""}`);
  for (const e of m.exactitud) {
    if (!e.peorSignificativo) continue;
    const ic = e.ic95 ? ` IC95 [${e.ic95.lower.toFixed(3)}, ${e.ic95.upper.toFixed(3)}]` : "";
    const p = e.p !== undefined ? ` p=${e.p.toPrecision(3)}` : "";
    add("exactitud-peor", `${e.metrica}, brazo ${e.brazo}: ${e.valor === null ? "—" : e.valor.toFixed(3)}${ic}${p}`);
  }
  for (const f of m.informeVsFactura) {
    if (fueraDeTolerancia(f.informeUsd, f.facturaUsd)) {
      const rel = f.facturaUsd !== 0 ? ` (${pct((f.informeUsd - f.facturaUsd) / f.facturaUsd)})` : "";
      add("informe-vs-factura", `brazo ${f.brazo}: el informe dice ${f.informeUsd.toFixed(6)} $ y la factura ${f.facturaUsd.toFixed(6)} $${rel} en ${f.llamadas} llamadas`);
    }
  }
  return out;
}

export interface Veredicto {
  ok: boolean;
  infracciones: Infraccion[];
  avisos: string[];
}

export function evaluar(resultados: readonly ResultadoDeCelda[], abortoGlobal: string | null): Veredicto {
  const infracciones: Infraccion[] = [];
  const avisos: string[] = [];
  const medidasPorBateria = new Map<Bateria, number>();
  const intentadasPorBateria = new Map<Bateria, number>();
  for (const r of resultados) {
    if (r.estado !== "sin-soporte") intentadasPorBateria.set(r.bateria, (intentadasPorBateria.get(r.bateria) ?? 0) + 1);
    switch (r.estado) {
      case "medida":
        infracciones.push(...infraccionesDe(r.medicion, r.topeUsd));
        if (r.medicion.estado === "medido") medidasPorBateria.set(r.bateria, (medidasPorBateria.get(r.bateria) ?? 0) + 1);
        else avisos.push(`${r.bateria} · ${r.modelo}: no medible — ${r.medicion.motivo ?? "sin motivo"}`);
        if (r.medicion.estado === "medido" && r.medicion.calidadSinMedir) {
          avisos.push(`${r.bateria} · ${r.modelo}: calidad sin medir — ${r.medicion.calidadSinMedir}`);
        }
        if (r.medicion.estado === "medido" && r.medicion.cortadaPorTope) {
          avisos.push(`${r.bateria} · ${r.modelo}: cortada por su tope tras ${r.medicion.n} ítems (intervalo más ancho)`);
        }
        break;
      case "sin-soporte":
        avisos.push(`${r.bateria} · ${r.modelo}: sin soporte en el arnés — ${r.motivo}`);
        break;
      // Sin la clave de su proveedor la celda no se lanza: «no medible», un aviso
      // (docs/BANCO-SEMANAL.md). Cuenta como intentada, así que una batería que se
      // queda entera sin claves sigue cayendo en `bateria-sin-medir`.
      case "sin-clave":
        avisos.push(`${r.bateria} · ${r.modelo}: no medible — ${r.motivo}`);
        break;
      case "arnes-falla":
        infracciones.push({ regla: "arnes-falla", bateria: r.bateria, modelo: r.modelo, detalle: r.motivo });
        break;
      case "omitida-por-tope-global":
        break;
    }
  }
  if (abortoGlobal) infracciones.push({ regla: "tope-global", bateria: "banco", modelo: "—", detalle: abortoGlobal });
  for (const [b, n] of intentadasPorBateria) {
    if (n > 0 && !medidasPorBateria.get(b)) {
      infracciones.push({ regla: "bateria-sin-medir", bateria: b, modelo: "—", detalle: `ninguna de sus ${n} celdas se pudo medir` });
    }
  }
  return { ok: infracciones.length === 0, infracciones, avisos };
}
