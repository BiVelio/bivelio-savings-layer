/**
 * EL BANCO SEMANAL · EL RESUMEN (Markdown para el job summary y el artefacto).
 * Puro: del resultado ya evaluado al texto.
 */
import { BATERIAS, PRESUPUESTO_SEMANAL_USD, type Modo, type Reparto } from "./plan.js";
import { lineaDelCuadre, type Cuadre } from "./factura.js";
import type { ResultadoDeCelda, Veredicto } from "./umbrales.js";

export interface DatosDelResumen {
  modo: Modo;
  commit: string;
  version: string;
  inicio: string;
  fin: string;
  gastoUsd: number;
  reparto: Reparto;
  resultados: readonly ResultadoDeCelda[];
  veredicto: Veredicto;
  /** El cuadre contra la factura real (factura.ts); vacío en SECO. */
  factura?: readonly Cuadre[];
}

const usd = (x: number) => `${x.toFixed(2)} $`;
const escapar = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function metricas(r: ResultadoDeCelda): string {
  if (r.estado !== "medida") return "—";
  const m = r.medicion;
  if (m.estado !== "medido") return "—";
  const partes: string[] = [];
  if (m.respuestasDeOtraPregunta !== undefined) partes.push(`otra pregunta ${m.respuestasDeOtraPregunta}`);
  if (m.llamadasCambiadas !== undefined) partes.push(`llamadas cambiadas ${m.llamadasCambiadas}`);
  if (m.negativasCacheadas !== undefined) partes.push(`negativas cacheadas ${m.negativasCacheadas}`);
  if (m.negativasAcreditadas !== undefined) partes.push(`acreditadas ${m.negativasAcreditadas}`);
  partes.push(`capa-falla ${m.fallosDeLaCapa}`);
  if (m.excluidosPorCuota) partes.push(`excluidos por cuota ${m.excluidosPorCuota}`);
  const e = m.exactitud.find((x) => x.brazo === "B") ?? m.exactitud[0];
  if (e && e.valor !== null) {
    const nombre = r.bateria === "mt-bench" ? "victoria de B" : "B−A";
    partes.push(e.ic95 ? `${nombre} ${e.valor.toFixed(3)} [${e.ic95.lower.toFixed(3)}, ${e.ic95.upper.toFixed(3)}]` : `${nombre} ${e.valor.toFixed(3)}${e.p !== undefined ? ` p=${e.p.toPrecision(2)}` : ""}`);
  }
  if (m.calidadSinMedir) partes.push(`calidad sin medir (${m.calidadSinMedir})`);
  const f = m.informeVsFactura.find((x) => x.brazo === "B") ?? m.informeVsFactura[0];
  if (f && f.facturaUsd > 0) partes.push(`informe/factura ${(((f.informeUsd - f.facturaUsd) / f.facturaUsd) * 100).toFixed(2)} %`);
  return partes.join(" · ");
}

function estado(r: ResultadoDeCelda): string {
  switch (r.estado) {
    case "medida":
      return r.medicion.estado === "medido"
        ? r.medicion.cortadaPorTope
          ? "medida (cortada por tope)"
          : r.medicion.cortadaPorPlazo
            ? "medida (cortada por plazo)"
            : "medida"
        : "no medible";
    case "sin-soporte":
      return "sin soporte";
    case "sin-clave":
      return "no medible (sin clave)";
    case "arnes-falla":
      return "**arnés falló**";
    case "omitida-por-tope-global":
      return "omitida (tope global)";
    case "aplazada-por-cuota":
      return "aplazada (cuota diaria)";
  }
}

export function resumenMarkdown(d: DatosDelResumen): string {
  const L: string[] = [];
  const ok = d.veredicto.ok;
  L.push(`# Banco semanal — ${ok ? "✅ sin regresiones" : "❌ REGRESIÓN o banco incompleto"}`);
  L.push("");
  L.push(
    `Modo **${d.modo === "vivo" ? "VIVO" : "SECO (sin red de proveedor: los números no son mediciones)"}** · fuente de main \`${d.commit}\` (${d.version}, BVSALA_DEV_OPEN=1) · ` +
      `gasto **${usd(d.gastoUsd)}** de ${usd(PRESUPUESTO_SEMANAL_USD)} (asignados ${usd(d.reparto.asignadoUsd)}) · ${d.inicio} → ${d.fin}`,
  );
  L.push("");
  if (d.veredicto.infracciones.length) {
    L.push("## Lo que hace fallar el banco");
    L.push("");
    for (const i of d.veredicto.infracciones) L.push(`- **${i.regla}** · ${i.bateria} · ${i.modelo}: ${escapar(i.detalle)}`);
    L.push("");
  }
  L.push("## Celdas");
  L.push("");
  L.push("| Batería | Modelo | Estado | Gasto / tope | n | Métricas |");
  L.push("| --- | --- | --- | --- | --- | --- |");
  for (const b of BATERIAS) {
    for (const r of d.resultados.filter((x) => x.bateria === b)) {
      const gasto =
        r.estado === "medida" ? `${usd(r.medicion.gastoUsd)} / ${usd(r.topeUsd)}` : r.estado === "arnes-falla" ? `? / ${usd(r.topeUsd)}` : "—";
      const n = r.estado === "medida" ? String(r.medicion.n) : "—";
      L.push(`| ${b} | ${r.modelo} | ${estado(r)} | ${gasto} | ${n} | ${escapar(metricas(r))} |`);
    }
  }
  L.push("");
  L.push("## Factura real (criterio 4: ±2 %, ahorro nativo aparte)");
  L.push("");
  if (!d.factura?.length) {
    L.push(d.modo === "vivo" ? "- No se consultó." : "- En SECO no hay gasto: la factura real no se consulta.");
  } else {
    for (const c of d.factura) L.push(`- ${escapar(lineaDelCuadre(c))}`);
  }
  L.push("- Google (Gemini): sin API de costes integrada (su factura sale de la exportación de facturación de Cloud); no se comprueba.");
  L.push("");
  if (d.veredicto.avisos.length) {
    L.push("## Avisos (no hacen fallar)");
    L.push("");
    for (const a of d.veredicto.avisos) L.push(`- ${escapar(a)}`);
    L.push("");
  }
  L.push("## Cómo leerlo");
  L.push("");
  L.push(
    "Cada celda es una batería publicada corrida con UN modelo, brazo A (proveedor directo) contra brazo B (la capa, desde el fuente de main). " +
      "Las reglas y sus tolerancias están en `benchmarks/banco-semanal/umbrales.ts`; la guía entera, en `docs/BANCO-SEMANAL.md`. " +
      "Los artefactos de cada arnés (JSON y Markdown) van en el artefacto `banco-semanal` de este run.",
  );
  L.push("");
  return L.join("\n");
}
