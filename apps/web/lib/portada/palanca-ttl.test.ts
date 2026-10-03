import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PALANCA_TTL } from "./palanca-ttl";

/**
 * LA CIFRA DE LA TARJETA DEL GATEWAY, CONTRA SU INFORME.
 *
 * `palanca-ttl.ts` lleva los números escritos a mano (la portada es ISR y no
 * lee `docs/` en Vercel). Esta verja los busca en el informe del banco de TTL:
 * si el informe cambia o un número de aquí se aparta, rojo. Y vigila lo que la
 * tarjeta promete: la cota inferior publicada nunca por encima de la medida.
 */
const RAIZ = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
const informe = readFileSync(join(RAIZ, PALANCA_TTL.informe), "utf8");

/** «0.0249» → «2,49 %», como lo escribe el informe. */
const pct2 = (x: number) => `${(x * 100).toFixed(2).replace(".", ",")} %`;

/** «19779» → «19.779», como lo escribe el informe. */
const miles = (n: number) => n.toLocaleString("de-DE");
/** «4563.61» → «$4.563,61», como lo escribe el informe. */
const usd = (x: number) => `$${x.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

describe("la cifra de la rebaja de TTL sale del informe del banco", () => {
  it("el informe es el del día que se cita", () => {
    expect(PALANCA_TTL.informe).toContain(PALANCA_TTL.fecha);
    expect(informe).toContain(`medida en neto — ${PALANCA_TTL.fecha}`);
  });

  it("el neto puntual es el del veredicto", () => {
    expect(informe).toContain(`un +${pct2(PALANCA_TTL.neto.point)} de la factura`);
  });

  it("el intervalo es el IC 95 % por SESIÓN, cota a cota", () => {
    const fila = informe.split("\n").find((l) => l.includes("por **sesión**"));
    expect(fila, "la fila del IC por sesión").toBeDefined();
    expect(fila).toContain(`**+${pct2(PALANCA_TTL.neto.lower)} … +${pct2(PALANCA_TTL.neto.upper)}**`);
    expect(informe).toContain("IC 95 % (bootstrap");
    expect(PALANCA_TTL.confianza).toBe(0.95);
  });

  it("las sesiones, las peticiones y los días son los del informe", () => {
    expect(informe).toContain(`**${PALANCA_TTL.sesiones} sesiones del tráfico de Claude Code de una`);
    const miles = PALANCA_TTL.peticiones.toLocaleString("de-DE");
    expect(informe).toContain(`**${miles} peticiones en ${PALANCA_TTL.dias} días**`);
    expect(informe).toContain(`| por **sesión** (${PALANCA_TTL.sesiones} clusters)`);
  });

  it("es NETO, de UNA organización y a precio de LISTA: lo que la tarjeta dice", () => {
    expect(informe).toContain("después de restar");
    expect(informe).toContain("sola organización");
    expect(informe).toContain("precios de lista");
  });

  it("el intervalo por DÍA y los remuestreos son los del informe", () => {
    const fila = informe.split("\n").find((l) => l.includes("por **día**"));
    expect(fila, "la fila del IC por día").toBeDefined();
    expect(fila).toContain(`(${PALANCA_TTL.dias} clusters)`);
    expect(fila).toContain(`**+${pct2(PALANCA_TTL.netoPorDia.lower)} … +${pct2(PALANCA_TTL.netoPorDia.upper)}**`);
    expect(informe).toContain(`(bootstrap, ${miles(PALANCA_TTL.remuestreos)} remuestreos)`);
    expect(informe).toContain("Los dos intervalos excluyen el cero");
    expect(PALANCA_TTL.netoPorDia.lower).toBeGreaterThan(0);
  });

  it("la regla de la rebaja: de una hora a cinco minutos cuando lo nuevo llega al umbral", () => {
    expect(informe).toContain(`(escrituras de caché 1h → 5m cuando lo nuevo es ≥ ${PALANCA_TTL.umbralNuevo * 100} % del cuerpo)`);
  });

  it("el resultado, fila a fila: factura, techo, rebajas, bruto, fallos y neto", () => {
    const P = PALANCA_TTL;
    expect(informe).toContain(`| Peticiones / sesiones / días | ${miles(P.peticiones)} / ${P.sesiones} / ${P.dias} |`);
    expect(informe).toContain(`| Factura base (lista) | ${usd(P.facturaUsd)} |`);
    expect(informe).toContain(`(${(P.techo * 100).toFixed(1).replace(".", ",")} %) |`);
    expect(informe).toContain(`| Rebajas | ${miles(P.rebajas)} |`);
    expect(informe).toContain(`| Prima ahorrada (bruto) | ${usd(P.brutoUsd)} |`);
    expect(informe).toContain(`| Fallos inducidos | ${P.fallos} — cuestan ${usd(P.costeFallosUsd)} |`);
    expect(informe).toContain(`| **Neto** | **+${usd(P.netoUsd)} (+${pct2(P.neto.point)})** |`);
    expect(informe).toContain(`**neto de +${usd(P.netoUsd)}, un +${pct2(P.neto.point)} de la factura** (${usd(P.facturaUsd)})`);
  });

  it("las cuentas cuadran entre sí: bruto − fallos = neto, y neto / factura = el porcentaje", () => {
    const P = PALANCA_TTL;
    // Al céntimo de redondeo del propio informe.
    expect(Math.abs(P.brutoUsd - P.costeFallosUsd - P.netoUsd)).toBeLessThan(0.015);
    expect((P.netoUsd / P.facturaUsd).toFixed(4)).toBe(P.neto.point.toFixed(4));
  });

  it("la variante conservadora: su neto y los fallos que añade", () => {
    const C = PALANCA_TTL.conservadora;
    expect(informe).toContain("(`hilo+prefijo-compartido`)");
    expect(informe).toContain(`(+${pct2(C.neto)}), ${C.fallosDeMas} fallos más.`);
  });

  it("el desglose por modelo es la tabla del informe, fila a fila y en su orden", () => {
    const filas = informe.split("\n").filter((l) => l.startsWith("| claude-"));
    expect(filas.map((l) => l.split("|")[1]!.trim())).toEqual(PALANCA_TTL.porModelo.map((m) => m.modelo));
    for (const [i, m] of PALANCA_TTL.porModelo.entries()) {
      const c = filas[i]!.split("|").map((x) => x.trim());
      // | modelo | peticiones | factura | rebajas | bruto | fallos | coste | neto | % factura |
      expect(c[2], m.modelo).toBe(miles(m.peticiones));
      expect(c[4], m.modelo).toBe(miles(m.rebajas));
      expect(c[6], m.modelo).toBe(miles(m.fallos));
      if (m.neto === null) expect(c[9], m.modelo).toBe(`(n = ${m.peticiones})`);
      else expect(c[9], m.modelo).toBe(`**+${pct2(m.neto)}**`);
    }
    // Las filas suman el total: ni un modelo de menos.
    const suma = (k: "peticiones" | "rebajas" | "fallos") => PALANCA_TTL.porModelo.reduce((a, m) => a + m[k], 0);
    expect(suma("peticiones")).toBe(PALANCA_TTL.peticiones);
    expect(suma("rebajas")).toBe(PALANCA_TTL.rebajas);
    expect(suma("fallos")).toBe(PALANCA_TTL.fallos);
  });

  it("el caso feo es el que el informe llama así, con sus cuotas y su pérdida en el primer periodo", () => {
    const F = PALANCA_TTL.casoFeo;
    expect(F.modelo).toBe("claude-sonnet-5");
    expect(informe).toContain(
      `Sonnet-5 es el caso feo: el ${F.cuotaRebajas * 100} % de las rebajas, el ${F.cuotaFallos * 100} % de los fallos y un`,
    );
    // «−» es U+2212, como lo escribe el informe.
    expect(informe).toContain(`−${(-F.netoPrimerPeriodo * 100).toFixed(1).replace(".", ",")} %** de su factura`);
    expect(F.netoPrimerPeriodo).toBeLessThan(0);
    // Las cuotas son las de la tabla, redondeadas.
    const fila = PALANCA_TTL.porModelo.find((m) => m.modelo === F.modelo)!;
    expect(Math.round((fila.rebajas / PALANCA_TTL.rebajas) * 100)).toBe(F.cuotaRebajas * 100);
    expect(Math.round((fila.fallos / PALANCA_TTL.fallos) * 100)).toBe(F.cuotaFallos * 100);
  });

  it("los límites que la sección repite están en el informe", () => {
    for (const frase of [
      "**Una organización, un cliente, un proveedor.**",
      "**Precio de lista, simulado.**",
      "**El modelo de caché es un modelo.**",
      "**P2 y P3 reconstruidos.**",
      "**El hueco se mide desde la llegada de cada petición**",
      "cuenta algún fallo de más, nunca de menos.",
      "no es una cifra",
      "Solo cifras agregadas.",
    ]) {
      expect(informe, frase).toContain(frase);
    }
  });

  it("producción resta los fallos desde la versión que dice el informe, el mismo día", () => {
    expect(informe).toContain(`**Corregido en la ${PALANCA_TTL.netoEnProduccionDesde} (${PALANCA_TTL.fecha}).**`);
    expect(informe).toContain("Lo registrado antes no se recalcula");
  });

  it("el intervalo excluye el cero y contiene la estimación", () => {
    expect(PALANCA_TTL.neto.lower).toBeGreaterThan(0);
    expect(PALANCA_TTL.neto.lower).toBeLessThan(PALANCA_TTL.neto.point);
    expect(PALANCA_TTL.neto.point).toBeLessThan(PALANCA_TTL.neto.upper);
  });
});

describe("lo que los límites de la sección pública dicen con números", () => {
  const miles = (n: number) => n.toLocaleString("de-DE");
  /** Las celdas de la fila de un periodo de la tabla «Por periodo de captura». */
  const periodo = (nombre: string) => {
    const fila = informe.split("\n").find((l) => l.startsWith(`| ${nombre} `));
    expect(fila, `la fila de ${nombre}`).toBeDefined();
    return fila!.split("|").map((c) => c.trim());
  };

  it("las peticiones con línea base reconstruida son P2 + P3, y son la mayoría", () => {
    const pet = (nombre: string) => Number(periodo(nombre)[2]!.replace(/\./g, ""));
    expect(pet("P2") + pet("P3")).toBe(PALANCA_TTL.reconstruidas.peticiones);
    expect(pet("P1") + pet("P2") + pet("P3")).toBe(PALANCA_TTL.peticiones);
    expect(informe).toContain("Grabado detrás del gateway, con la palanca ya armada.");
    expect(PALANCA_TTL.reconstruidas.peticiones / PALANCA_TTL.peticiones).toBeGreaterThan(0.5);
  });

  it("el intervalo del primer periodo, solo, es el de su fila", () => {
    const { lower, upper } = PALANCA_TTL.primerPeriodo;
    expect(periodo("P1").join("|")).toContain(`+${pct2(lower)} … +${pct2(upper)}`);
    // Mucho más ancho que el de todo el tráfico: por eso se dice.
    expect(upper - lower).toBeGreaterThan(PALANCA_TTL.neto.upper - PALANCA_TTL.neto.lower);
  });

  it("las peticiones sin marca de una hora son las del informe", () => {
    const patron = new RegExp(`de ${miles(PALANCA_TTL.peticiones).replace(".", "\\.")}\\s+peticiones, ${miles(PALANCA_TTL.sinMarcaDeHora).replace(".", "\\.")} no traen ni una marca de 1h`);
    expect(informe).toMatch(patron);
  });

  it("la versión y la fecha desde las que producción va en neto son las de la nota del informe", () => {
    expect(informe).toContain(`**Corregido en la ${PALANCA_TTL.netoEnProduccionDesde} (${PALANCA_TTL.netoEnProduccionFecha}).**`);
  });
});
