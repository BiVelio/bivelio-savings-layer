import { formatos, veredicto, type Traductor } from "@/app/components/BancoPublico";
import type { Banco, RegistroGsm8k } from "@/lib/banco-publico/extraer";

import type { FilaAB } from "./ComparacionAB";

/**
 * Las filas de la comparación A/B de /benchmarks: los modelos de GSM8K (la
 * batería hecha para medir ahorro) que tienen una tirada MEDIDA con el coste de
 * los dos brazos. Un modelo sin tirada, o cuya tirada falló, no entra: que sea
 * compatible no lo convierte en medido (su motivo está en #status).
 *
 * El orden es por tamaño de muestra, de mayor a menor: el modelo que se enseña
 * primero es el que más evidencia tiene, no el que más ahorra.
 */
export function filasAB(banco: Banco, t: Traductor, locale: string): FilaAB[] {
  const f = formatos(locale);
  return banco.registros
    .filter(
      (r): r is RegistroGsm8k & { ahorro: NonNullable<RegistroGsm8k["ahorro"]>; costeA: number; costeB: number } =>
        r.bateria === "gsm8k" && r.estado === "medido" && !!r.ahorro && r.costeA !== undefined && r.costeB !== undefined,
    )
    .sort((a, b) => b.n - a.n)
    .map((r) => ({
      modelo: r.modelo,
      n: r.n,
      costeA: r.costeA,
      costeB: r.costeB,
      exactitudA: r.exactitudA ? r.exactitudA.aciertos / r.exactitudA.n : null,
      exactitudB: r.exactitudB ? r.exactitudB.aciertos / r.exactitudB.n : null,
      veredicto: veredicto(r.ahorro),
      muestra: t("savings.nCell", { n: f.ent(r.n), unicos: r.unicos !== undefined ? f.ent(r.unicos) : "—" }),
      ahorro: f.iv(r.ahorro),
      exactitud:
        r.exactitudA && r.exactitudB
          ? `${f.pct(r.exactitudA.aciertos / r.exactitudA.n)} → ${f.pct(r.exactitudB.aciertos / r.exactitudB.n)}`
          : "—",
      tirada: `${r.version} · ${f.fecha(r.fecha)}`,
    }));
}
