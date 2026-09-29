import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { CATALOGO, HUELLAS_DEL_CATALOGO, PRECIOS_AL_DIA, SIN_FILA_PROPIA, tramosDePrecio } from "../src/pricing/catalogo.js";
import {
  PRIMA_ESCRITURA_CACHE,
  PRIMA_ESCRITURA_CACHE_1H,
  primaDeEscritura,
  primaDeEscritura1h,
  primaDeEscrituraAutomatica,
} from "../src/pricing/primas.js";
import { IGNORA_TEMPERATURA, NOMBRE_DE_RAZONAMIENTO, RAZONA_POR_FILA } from "../src/pricing/razonamiento.js";
import { TARIFAS_DE_TIER } from "../src/pricing/tarifas-de-tier.js";

/**
 * LA VERSIÓN DEL CATÁLOGO CAMBIA CADA VEZ QUE CAMBIA SU CONTENIDO.
 *
 * Decisión del dueño (2026-09-29). Hasta hoy `PRECIOS_AL_DIA` decía «cuándo se
 * releyeron las páginas», y entre el 2026-09-27 y el 2026-09-29 se quitó
 * claude-3-haiku (#373) y se añadió claude-sonnet-5-5 (#399) sin moverla: dos
 * cálculos distintos salían en los extractos con la misma `version_precios`.
 *
 * QUÉ ENTRA EN LA HUELLA — todo lo que decide el precio que la capa pone a una
 * petición o lo que acredita de ella, que es lo que la versión afirma describir:
 *   · CATALOGO, fila a fila, CON SUS TRAMOS (`tramosDePrecio`): la vigencia de
 *     la fila y los precios anunciados para después. Un tramo nuevo cambia lo
 *     que se cobra en enero aunque la fila de hoy no se mueva.
 *   · SIN_FILA_PROPIA: un veto quita el precio a un id que antes heredaba el de
 *     su pariente. Mismo CATALOGO, otra factura.
 *   · Las primas de escritura de caché: las dos constantes y el resultado de las
 *     tres funciones para cada fila de CATALOGO y de las tarifas de tier. Se
 *     evalúan en vez de leer el código: lo que importa es qué prima recibe cada
 *     modelo, no cómo está escrito el `if`.
 *   · TARIFAS_DE_TIER entera, con `fuente`, `consultado` y `vigenteHasta`: son
 *     las cifras del ahorro de Flex/Batch/Priority y su `consultado` viaja a la
 *     salida como `pricesCheckedOn`.
 *   · La clasificación de razonamiento (RAZONA_POR_FILA, IGNORA_TEMPERATURA y
 *     los patrones de nombre): decide si la salida de una repetición se
 *     acredita, o sea la base de la comisión por referencia.
 *
 * QUÉ NO ENTRA, a propósito:
 *   · Las etiquetas de fecha (`PRECIOS_AL_DIA`, `TARIFAS_DE_TIER_AL_DIA`): son
 *     el nombre del contenido, no el contenido. Si entraran, subir la versión
 *     cambiaría la huella y la verja no distinguiría «cambió» de «se renombró».
 *   · Los comentarios y el orden de las claves: la serialización es canónica
 *     (claves ordenadas), así que reordenar filas no cambia la versión.
 *   · El emparejador (`buscarPorModelo`, el corte por separador y por versión
 *     menor): es CÓDIGO, viaja con la versión del paquete y lo fijan sus propios
 *     tests (herencia-de-precio-por-version, catalogo-de-precios).
 *   · Los `costModels` del cliente: no son nuestro catálogo, y el extracto ya
 *     dice cuándo se valoró con los suyos.
 */

/** JSON canónico: claves ordenadas a todos los niveles, Set → lista ordenada, RegExp → su literal. */
function canonico(v: unknown): string {
  return JSON.stringify(normalizar(v));
}

function normalizar(v: unknown): unknown {
  if (v instanceof Set) return [...v].map(normalizar).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  if (v instanceof RegExp) return String(v);
  if (Array.isArray(v)) return v.map(normalizar);
  if (v !== null && typeof v === "object") {
    const fuera: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) fuera[k] = normalizar(x);
    }
    return fuera;
  }
  if (typeof v === "number" && !Number.isFinite(v)) throw new Error(`número no serializable en la huella: ${v}`);
  return v;
}

/** Lo que describe una versión del catálogo. Ver la cabecera: qué entra y por qué. */
function contenidoVersionado(): unknown {
  const filas = Object.keys(CATALOGO);
  const idsConPrima = [
    ...new Set([...filas, ...Object.values(TARIFAS_DE_TIER).flatMap((porTier) => Object.values(porTier).flatMap(Object.keys))]),
  ].sort();
  return {
    catalogo: Object.fromEntries(filas.map((k) => [k, tramosDePrecio(k)])),
    sinFilaPropia: [...SIN_FILA_PROPIA].sort(),
    primas: {
      escrituraCache: PRIMA_ESCRITURA_CACHE,
      escrituraCache1h: PRIMA_ESCRITURA_CACHE_1H,
      porModelo: Object.fromEntries(
        idsConPrima.map((m) => [
          m,
          { escritura: primaDeEscritura(m), automatica: primaDeEscrituraAutomatica(m), unaHora: primaDeEscritura1h(m) },
        ]),
      ),
    },
    tarifasDeTier: TARIFAS_DE_TIER,
    razonamiento: {
      porFila: RAZONA_POR_FILA,
      ignoraTemperatura: IGNORA_TEMPERATURA,
      patronesDeNombre: NOMBRE_DE_RAZONAMIENTO,
    },
  };
}

function huella(): string {
  return createHash("sha256").update(canonico(contenidoVersionado())).digest("hex");
}

const DIA = /^\d{4}-\d{2}-\d{2}$/;

describe("⛔ la versión del catálogo cambia cada vez que cambia su contenido", () => {
  const actual = huella();
  const versiones = Object.keys(HUELLAS_DEL_CATALOGO);
  const ultima = versiones[versiones.length - 1];
  const hoy = new Date().toISOString().slice(0, 10);
  const QUE_HACER =
    PRECIOS_AL_DIA === hoy
      ? [
          "",
          `El contenido del catálogo de precios ha cambiado y su versión (${hoy}) ya es la de hoy.`,
          "  · Si la versión de hoy NO ha salido aún en ninguna release ni despliegue: pon la huella nueva en su entrada,",
          `    src/pricing/catalogo.ts → HUELLAS_DEL_CATALOGO  "${hoy}": "${actual}",`,
          "    y añade a la línea de hoy de la «Historia» de PRECIOS_AL_DIA lo que cambió.",
          "  · Si YA salió: no reescribas su huella (hay extractos que citan esa versión con el contenido anterior).",
          "    Espera a mañana para publicar este cambio, con versión nueva. Ver docs/VERSION-DEL-CATALOGO.md.",
        ].join("\n")
      : [
          "",
          "El contenido del catálogo de precios ha cambiado y su versión no.",
          "Haz estas tres cosas en el MISMO commit:",
          `  1. src/pricing/catalogo.ts: PRECIOS_AL_DIA = "${hoy}" (la fecha de hoy, UTC) y una línea en su «Historia» diciendo qué cambió.`,
          `  2. src/pricing/catalogo.ts: AÑADE al final de HUELLAS_DEL_CATALOGO  "${hoy}": "${actual}",`,
          `     No reescribas la huella de "${PRECIOS_AL_DIA}": esa versión ya la citan extractos con el contenido anterior.`,
          `  3. apps/web/lib/billing/extracto-sombra.ts: VERSION_PRECIOS_CATALOGO = "${hoy}" (su test la ancla a PRECIOS_AL_DIA).`,
          "La regla completa está en docs/VERSION-DEL-CATALOGO.md.",
        ].join("\n");

  it("la huella del contenido es la registrada para PRECIOS_AL_DIA", () => {
    expect(HUELLAS_DEL_CATALOGO[PRECIOS_AL_DIA], QUE_HACER).toBe(actual);
  });

  it("PRECIOS_AL_DIA es la ÚLTIMA versión registrada, con fecha válida y no futura", () => {
    expect(PRECIOS_AL_DIA).toMatch(DIA);
    expect(ultima, `PRECIOS_AL_DIA (${PRECIOS_AL_DIA}) debe ser la última entrada de HUELLAS_DEL_CATALOGO`).toBe(PRECIOS_AL_DIA);
    expect(PRECIOS_AL_DIA <= hoy, `PRECIOS_AL_DIA ${PRECIOS_AL_DIA} está en el futuro`).toBe(true);
  });

  it("las versiones van en orden y ninguna repite contenido (no se sube la versión si nada cambió)", () => {
    for (const v of versiones) expect(v, "cada versión es un día AAAA-MM-DD").toMatch(DIA);
    expect([...versiones].sort(), "HUELLAS_DEL_CATALOGO en orden de fecha").toEqual(versiones);
    const huellas = Object.values(HUELLAS_DEL_CATALOGO);
    for (const h of huellas) expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(
      new Set(huellas).size,
      "dos versiones con la misma huella: se subió la versión sin cambiar el contenido. Quita la entrada nueva y deja PRECIOS_AL_DIA en la anterior.",
    ).toBe(huellas.length);
  });

  it("la serialización es canónica: el orden de las claves no cambia la huella", () => {
    expect(canonico({ b: 1, a: { d: [2, 1], c: undefined } })).toBe(canonico({ a: { d: [2, 1] }, b: 1 }));
    expect(canonico(new Set(["y", "x"]))).toBe(canonico(new Set(["x", "y"])));
    expect(canonico({ a: [1, 2] })).not.toBe(canonico({ a: [2, 1] }));
  });

  it("la huella SÍ ve lo que dice ver: una cifra, una fila, un veto, una prima de tier", () => {
    // Sobre la forma ya normalizada (Set y RegExp convertidos), que sí se clona por JSON.
    const base = normalizar(contenidoVersionado()) as Record<string, any>;
    const h = (c: unknown) => createHash("sha256").update(canonico(c)).digest("hex");
    expect(h(base)).toBe(actual);
    const clon = () => JSON.parse(JSON.stringify(base)) as Record<string, any>;
    const primera = Object.keys(base.catalogo)[0]!;

    const cifra = clon();
    cifra.catalogo[primera][0].precio.inputPer1k *= 1.0001;
    const fila = clon();
    delete fila.catalogo[primera];
    const veto = clon();
    veto.sinFilaPropia.push("gpt-9-otro");
    const tier = clon();
    tier.tarifasDeTier.openai.flex["gpt-5"].outputPer1k = 0;

    for (const [nombre, c] of Object.entries({ cifra, fila, veto, tier })) expect(h(c), nombre).not.toBe(actual);
  });
});
