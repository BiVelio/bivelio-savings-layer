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
 *                        NO cuenta un 429 del proveedor por cuota o límite de
 *                        tasa, en cualquier brazo: el ítem sale de la
 *                        comparación en los dos y se avisa («excluidos por
 *                        cuota: n»), salvo que B mandara más peticiones al
 *                        proveedor que A en la celda (extraer.ts, cuotaAtribuible).
 *                        Actúa también en una celda no medible: que no queden
 *                        ítems comparables no borra los errores de la capa.
 *   exactitud-peor       B − A significativamente negativa: el IC 95 % entero
 *                        por debajo de 0 (GSM8K, BFCL), la tasa de victoria de
 *                        B con el IC entero por debajo de 0,5 (MT-Bench), o
 *                        McNemar p < 0,05 en la dirección mala (XSTest).
 *                        SOLO si la capa intervino en la celda: donde el
 *                        artefacto demuestra que no cambió nada que altere la
 *                        generación (MT-Bench y BFCL: extraer.ts,
 *                        sinIntervencionMtBench / sinIntervencionBfcl), pasa a
 *                        aviso «atribuible al muestreo». GSM8K y XSTest no
 *                        traen el cable por ítem: ahí actúa siempre.
 *   informe-vs-factura   El coste que dice el informe de la capa, sumado por
 *                        brazo, fuera de ±2 % de lo que factura el proveedor
 *                        según su `usage` (con 0,0001 $ de holgura absoluta
 *                        para que una suma de céntimos no dispare por redondeo).
 *
 *   factura-no-cuadra    Criterio 4 de CAMINO-A-0.5: lo que el proveedor
 *                        FACTURA (su API de costes, workspace o proyecto
 *                        dedicado, días UTC de la tirada) fuera de ±2 % de lo
 *                        que el banco midió (A + B + juez si va directo). Solo
 *                        con clave de administrador; sin ella, aviso «factura
 *                        real no comprobada». Un pendiente por el retraso del
 *                        API se decide en la tirada siguiente (factura.ts).
 *
 *   latencia-excedida    SLO interactivo: total p95 > 3000 ms, max > 5000 ms o
 *                        cualquier deadline_exceeded (siempre falla petición y SLO).
 *   trabajo-capa-excedido Trabajo local F1 p95 > 250 ms o max > 500 ms; presupuesto
 *                        observado independiente del SLO, nunca un SLA futuro.
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
 * no sabe medir (sin-soporte), una celda aplazada por la cuota diaria de su
 * modelo (plan.ts, CUOTA_DIARIA: se mide en su jornada, otro día), uno «no medible» por su clave o su cuota (también
 * la celda que los 429 de cuota dejan sin ítems comparables, o por debajo de
 * MINIMO_COMPARABLE_TRAS_CUOTA: «no medible — cuota del proveedor»), los ítems
 * excluidos por cuota de una celda que sí se midió, una
 * celda cortada por su propio tope (se mide menos, no peor), y una celda de
 * MT-Bench cuyo juez juzgó menos de MINIMO_DE_TURNOS_JUZGADOS turnos (extraer.ts):
 * sin tasa de victoria, y dicho, en vez de un 0,5 que parezca un empate. Ni una
 * calidad peor en una celda donde la capa no intervino (avisoDeMuestreo).
 */
import type { Bateria } from "./plan.js";
import type { Medicion } from "./extraer.js";
import { PRESUPUESTOS_LATENCIA_B2, PRESUPUESTOS_TRABAJO_CAPA_B2, PROTOCOLO_LATENCIA_B2 } from "../b2/latencia.js";
import { lineaDelCuadre, type Cuadre } from "./factura.js";

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
  | "factura-no-cuadra"
  | "latencia-excedida"
  | "deadline-excedido"
  | "trabajo-capa-excedido"
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
  | { bateria: Bateria; modelo: string; estado: "omitida-por-tope-global"; motivo: string }
  /** Un modelo con cuota diaria (plan.ts, CUOTA_DIARIA) cuya batería no toca en la jornada de este banco: no se lanza. */
  | { bateria: Bateria; modelo: string; estado: "aplazada-por-cuota"; motivo: string };

export function fueraDeTolerancia(informeUsd: number, facturaUsd: number): boolean {
  const d = Math.abs(informeUsd - facturaUsd);
  // 1e-12: que un 2 % exacto no caiga fuera por la coma flotante.
  return d > Math.max(TOLERANCIA_INFORME_ABSOLUTA_USD, TOLERANCIA_INFORME_RELATIVA * Math.abs(facturaUsd)) + 1e-12;
}

const pct = (x: number) => `${(x * 100).toFixed(2)} %`;

/** Las líneas de cada `exactitud` significativamente peor de una medición. */
function calidadPeor(m: Medicion): string[] {
  return m.exactitud
    .filter((e) => e.peorSignificativo)
    .map((e) => {
      const ic = e.ic95 ? ` IC95 [${e.ic95.lower.toFixed(3)}, ${e.ic95.upper.toFixed(3)}]` : "";
      const p = e.p !== undefined ? ` p=${e.p.toPrecision(3)}` : "";
      return `${e.metrica}, brazo ${e.brazo}: ${e.valor === null ? "—" : e.valor.toFixed(3)}${ic}${p}`;
    });
}

/**
 * La calidad peor de una celda donde la capa NO intervino (`sinIntervencion`,
 * extraer.ts): no hace fallar, se avisa. Hallazgo del run 36748284158: MT-Bench
 * con gpt-4o-mini dio victoria de B 0,385 [0,308, 0,442] con el cable de B
 * idéntico al de A salvo `prompt_cache_key`, caché todo `miss` y el mismo
 * modelo servido; la tirada anterior, 0,500 [0,423, 0,577]. Era el muestreo con
 * temperatura sobre 25 turnos juzgados, no la capa.
 */
export function avisoDeMuestreo(m: Medicion): string | null {
  if (m.estado !== "medido" || !m.sinIntervencion) return null;
  const peor = calidadPeor(m);
  if (!peor.length) return null;
  const campos = Object.entries(m.sinIntervencion.camposNeutros).map(([k, n]) => `\`${k}\` ×${n}`);
  return (
    `${m.bateria} · ${m.modelo}: calidad B−A atribuible al muestreo: la capa no cambió nada que altere la generación ` +
    `(solo ${campos.length ? campos.join(", ") : "ningún campo: cable idéntico"}; caché todo miss, 0 llamadas evitadas, mismo modelo servido) — ${peor.join(" · ")}`
  );
}

/** Las infracciones de UNA medición (una celda que corrió y dejó artefacto). */
export function infraccionesDe(m: Medicion, topeUsd: number): Infraccion[] {
  const out: Infraccion[] = [];
  const add = (regla: Regla, detalle: string) => out.push({ regla, bateria: m.bateria, modelo: m.modelo, detalle });
  if (m.gastoUsd > topeUsd + EXCESO_DE_TOPE_USD) add("tope-excedido", `gastó ${m.gastoUsd.toFixed(4)} $ con un tope de ${topeUsd.toFixed(2)} $`);
  // Antes de mirar si se midió: una celda sin ítems comparables porque la capa falló en todos sigue fallando.
  if (m.fallosDeLaCapa > 0) add("capa-falla", `${m.fallosDeLaCapa} errores solo con la capa${m.ejemplosDeFallos.length ? `: ${m.ejemplosDeFallos.join(" · ")}` : ""}`);
  for (const [brazo, l] of Object.entries(m.latency?.arms ?? {})) {
    if (l.total.p95 > PRESUPUESTOS_LATENCIA_B2.p95Ms) {
      add("latencia-excedida", `brazo ${brazo}: p95=${l.total.p95.toFixed(0)} ms supera ${PRESUPUESTOS_LATENCIA_B2.p95Ms} ms`);
    }
    if (l.total.max > PRESUPUESTOS_LATENCIA_B2.maxMs) {
      add("latencia-excedida", `brazo ${brazo}: max=${l.total.max.toFixed(0)} ms supera ${PRESUPUESTOS_LATENCIA_B2.maxMs} ms`);
    }
    if (m.latency?.protocol === PROTOCOLO_LATENCIA_B2) {
      if (l.outcomes.deadline_exceeded > 0) {
        add("deadline-excedido", `brazo ${brazo}: ${l.outcomes.deadline_exceeded} petición(es) deadline_exceeded; un deadline siempre falla la petición y el SLO`);
      }
      if (l.layerWork.p95 > PRESUPUESTOS_TRABAJO_CAPA_B2.p95Ms) {
        add("trabajo-capa-excedido", `brazo ${brazo}: trabajo de capa p95=${l.layerWork.p95.toFixed(0)} ms supera el presupuesto observado de ${PRESUPUESTOS_TRABAJO_CAPA_B2.p95Ms} ms`);
      }
      if (l.layerWork.max > PRESUPUESTOS_TRABAJO_CAPA_B2.maxMs) {
        add("trabajo-capa-excedido", `brazo ${brazo}: trabajo de capa max=${l.layerWork.max.toFixed(0)} ms supera el presupuesto observado de ${PRESUPUESTOS_TRABAJO_CAPA_B2.maxMs} ms`);
      }
    }
  }
  if (m.estado !== "medido") return out;
  if ((m.respuestasDeOtraPregunta ?? 0) > 0) add("otra-pregunta", `${m.respuestasDeOtraPregunta} respuestas servidas de otra pregunta`);
  if ((m.llamadasCambiadas ?? 0) > 0) add("llamada-cambiada", `${m.llamadasCambiadas} llamadas a herramienta cambiadas u omitidas por la capa`);
  if ((m.negativasCacheadas ?? 0) > 0) add("negativa-cacheada", `${m.negativasCacheadas} negativas servidas desde la caché o escritas en ella`);
  if ((m.negativasAcreditadas ?? 0) > 0) add("negativa-acreditada", `${m.negativasAcreditadas} negativas con ahorro acreditado o registro de referencia`);
  // Una calidad peor solo es de la capa si la capa intervino (avisoDeMuestreo).
  if (!m.sinIntervencion) for (const e of calidadPeor(m)) add("exactitud-peor", e);
  for (const f of m.informeVsFactura) {
    if (fueraDeTolerancia(f.informeUsd, f.facturaUsd)) {
      const rel = f.facturaUsd !== 0 ? ` (${pct((f.informeUsd - f.facturaUsd) / f.facturaUsd)})` : "";
      add("informe-vs-factura", `brazo ${f.brazo}: el informe dice ${f.informeUsd.toFixed(6)} $ y la factura ${f.facturaUsd.toFixed(6)} $${rel} en ${f.llamadas} llamadas`);
    }
  }
  return out;
}

export interface Veredicto {
  /** Alias compatible del veredicto de release. */
  ok: boolean;
  releaseOk: boolean;
  interactiveSloOk: boolean;
  /** null cuando todas las celdas son legacy y no hay evidencia F1 de trabajo de capa. */
  layerOk: boolean | null;
  interactiveSloInfracciones: Infraccion[];
  layerInfracciones: Infraccion[];
  infracciones: Infraccion[];
  avisos: string[];
}

/**
 * Los cuadres contra la factura real (factura.ts): solo `no-cuadra` hace
 * fallar; lo demás que no sea `cuadra` o `sin-gasto` es un aviso (sin clave de
 * administrador, sin workspace/proyecto dedicado, tráfico ajeno, pendiente por
 * el retraso del API).
 */
export function evaluarFactura(cuadres: readonly Cuadre[]): { infracciones: Infraccion[]; avisos: string[] } {
  const infracciones: Infraccion[] = [];
  const avisos: string[] = [];
  for (const c of cuadres) {
    if (c.estado === "no-cuadra") infracciones.push({ regla: "factura-no-cuadra", bateria: "banco", modelo: c.proveedor, detalle: `tirada ${c.runId}: ${c.detalle}` });
    else if (c.estado !== "cuadra" && c.estado !== "sin-gasto") avisos.push(lineaDelCuadre(c));
  }
  return { infracciones, avisos };
}

export function evaluar(resultados: readonly ResultadoDeCelda[], abortoGlobal: string | null, factura: readonly Cuadre[] = []): Veredicto {
  const infracciones: Infraccion[] = [];
  const avisos: string[] = [];
  const medidasPorBateria = new Map<Bateria, number>();
  const intentadasPorBateria = new Map<Bateria, number>();
  for (const r of resultados) {
    if (r.estado !== "sin-soporte" && r.estado !== "aplazada-por-cuota") intentadasPorBateria.set(r.bateria, (intentadasPorBateria.get(r.bateria) ?? 0) + 1);
    switch (r.estado) {
      case "medida":
        infracciones.push(...infraccionesDe(r.medicion, r.topeUsd));
        if (r.medicion.estado === "medido") medidasPorBateria.set(r.bateria, (medidasPorBateria.get(r.bateria) ?? 0) + 1);
        else avisos.push(`${r.bateria} · ${r.modelo}: no medible — ${r.medicion.motivo ?? "sin motivo"}`);
        {
          const muestreo = avisoDeMuestreo(r.medicion);
          if (muestreo) avisos.push(muestreo);
        }
        if (r.medicion.estado === "medido" && r.medicion.excluidosPorCuota) {
          const sobrecarga = r.medicion.excluidosPorSobrecarga ?? 0;
          const cuota = r.medicion.excluidosPorCuota - sobrecarga;
          if (cuota > 0) {
            avisos.push(
              `${r.bateria} · ${r.modelo}: excluidos por cuota: ${cuota} (429 del proveedor por cuota o límite de tasa en A o en B; fuera de la comparación en los dos brazos, no cuentan como capa-falla)`,
            );
          }
          if (sobrecarga > 0) {
            avisos.push(
              `${r.bateria} · ${r.modelo}: excluidos por sobrecarga del proveedor: ${sobrecarga} (529 o 503 «overloaded» tras los reintentos del arnés, en A o en B; fuera de la comparación en los dos brazos, no cuentan como capa-falla)`,
            );
          }
        }
        if (r.medicion.estado === "medido" && r.medicion.calidadSinMedir) {
          avisos.push(`${r.bateria} · ${r.modelo}: calidad sin medir — ${r.medicion.calidadSinMedir}`);
        }
        if (r.medicion.estado === "medido" && r.medicion.cortadaPorTope) {
          avisos.push(`${r.bateria} · ${r.modelo}: cortada por su tope tras ${r.medicion.n} ítems (intervalo más ancho)`);
        }
        if (r.medicion.estado === "medido" && r.medicion.cortadaPorPlazo && !r.medicion.cortadaPorTope) {
          avisos.push(`${r.bateria} · ${r.modelo}: cortada por su plazo tras ${r.medicion.n} ítems (intervalo más ancho)`);
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
      // No cuenta como intentada: se mide en su jornada, en otro banco.
      case "aplazada-por-cuota":
        avisos.push(`${r.bateria} · ${r.modelo}: aplazada por cuota diaria — ${r.motivo}`);
        break;
    }
  }
  if (abortoGlobal) infracciones.push({ regla: "tope-global", bateria: "banco", modelo: "—", detalle: abortoGlobal });
  for (const [b, n] of intentadasPorBateria) {
    if (n > 0 && !medidasPorBateria.get(b)) {
      infracciones.push({ regla: "bateria-sin-medir", bateria: b, modelo: "—", detalle: `ninguna de sus ${n} celdas se pudo medir` });
    }
  }
  const fac = evaluarFactura(factura);
  infracciones.push(...fac.infracciones);
  avisos.push(...fac.avisos);
  const interactiveSloInfracciones = infracciones.filter((i) => i.regla === "latencia-excedida" || i.regla === "deadline-excedido");
  const layerInfracciones = infracciones.filter((i) => i.regla === "trabajo-capa-excedido");
  const hayEvidenciaF1 = resultados.some((r) => r.estado === "medida" && r.medicion.latency?.protocol === PROTOCOLO_LATENCIA_B2);
  const releaseOk = infracciones.filter((i) => i.regla !== "latencia-excedida").length === 0;
  return {
    ok: releaseOk,
    releaseOk,
    interactiveSloOk: interactiveSloInfracciones.length === 0,
    layerOk: hayEvidenciaF1 ? layerInfracciones.length === 0 : null,
    interactiveSloInfracciones,
    layerInfracciones,
    infracciones,
    avisos,
  };
}
