import type { CostModel } from "../tokenizer/accounting.js";

/**
 * PRECIOS DE LISTA POR MODELO.
 *
 * POR QUÉ EXISTE. Hasta ahora había UN solo precio ilustrativo
 * (`DEFAULT_COST_MODEL`) que se aplicaba a todo lo que el cliente no configurara
 * a mano. El SDK avisaba —bien— pero el efecto práctico es que, de fábrica,
 * ninguna cifra en dólares se correspondía con ninguna factura. Y la promesa
 * central de este producto es exactamente esa: un ahorro que puedes contrastar
 * con lo que te cobra tu proveedor.
 *
 * ⚠️ UN PRECIO EQUIVOCADO AQUÍ ES PEOR QUE NO TENER CATÁLOGO. Un modelo ausente
 * cae en el precio ilustrativo Y AVISA, así que el cliente sabe que esa columna
 * no vale. Un modelo presente con el precio mal calla el aviso y entrega una
 * cifra confiada y falsa — que es justo el fallo que este producto existe para no
 * cometer. Por eso aquí SOLO entran modelos cuyo precio de lista se conoce con
 * certeza, y `PRECIOS_AL_DIA` deja por escrito de cuándo son.
 *
 * Los precios son en USD por 1.000 tokens (la unidad del `CostModel`), aunque los
 * proveedores los publiquen por millón: 1 M → 1 K es dividir entre mil.
 *
 * SE SOBREESCRIBE SIEMPRE con `costModels`, que gana a esto. Un cliente con
 * descuento por volumen, con precios negociados o en una región distinta pone los
 * suyos y este catálogo no le estorba.
 */

/** Fecha de la última revisión de estos precios contra las tarifas públicas. */
export const PRECIOS_AL_DIA = "2026-08-13";

/**
 * Clave = el identificador del modelo tal cual lo publica el proveedor, sin
 * prefijo. El lookup prueba el id exacto, luego el id sin prefijo de proveedor, y
 * por último el PREFIJO más largo que case — para que `gpt-4o-2024-08-06` herede
 * el precio de `gpt-4o` sin tener que enumerar cada instantánea fechada.
 */
export const CATALOGO: Readonly<Record<string, CostModel>> = {
  // ── OpenAI ────────────────────────────────────────────────────────────────
  // `cachedInputPer1k`: el prompt caching de OpenAI factura la entrada cacheada
  // al 50 % en la familia 4o/4.1. Donde no está documentado, se omite en vez de
  // inventarlo: sin el campo, el contable lo trata como entrada normal, que es el
  // lado seguro (nunca infla el ahorro).
  "gpt-4.1":       { inputPer1k: 0.002,   outputPer1k: 0.008,  cachedInputPer1k: 0.0005   },
  "gpt-4.1-mini":  { inputPer1k: 0.0004,  outputPer1k: 0.0016, cachedInputPer1k: 0.0001   },
  "gpt-4.1-nano":  { inputPer1k: 0.0001,  outputPer1k: 0.0004, cachedInputPer1k: 0.000025 },
  "gpt-4o":        { inputPer1k: 0.0025,  outputPer1k: 0.01,   cachedInputPer1k: 0.00125  },
  "gpt-4o-mini":   { inputPer1k: 0.00015, outputPer1k: 0.0006, cachedInputPer1k: 0.000075 },
  "gpt-4-turbo":   { inputPer1k: 0.01,    outputPer1k: 0.03 },
  "gpt-4":         { inputPer1k: 0.03,    outputPer1k: 0.06 },
  "gpt-3.5-turbo": { inputPer1k: 0.0005,  outputPer1k: 0.0015 },

  // ── Anthropic ─────────────────────────────────────────────────────────────
  // La lectura de caché de Anthropic se factura al 10 % de la entrada.
  "claude-opus-4":     { inputPer1k: 0.015,  outputPer1k: 0.075, cachedInputPer1k: 0.0015  },
  "claude-sonnet-4":   { inputPer1k: 0.003,  outputPer1k: 0.015, cachedInputPer1k: 0.0003  },
  "claude-haiku-4-5":  { inputPer1k: 0.001,  outputPer1k: 0.005, cachedInputPer1k: 0.0001  },
  "claude-3-5-sonnet": { inputPer1k: 0.003,  outputPer1k: 0.015, cachedInputPer1k: 0.0003  },
  "claude-3-5-haiku":  { inputPer1k: 0.0008, outputPer1k: 0.004, cachedInputPer1k: 0.00008 },
  "claude-3-opus":     { inputPer1k: 0.015,  outputPer1k: 0.075, cachedInputPer1k: 0.0015  },
  "claude-3-haiku":    { inputPer1k: 0.00025, outputPer1k: 0.00125, cachedInputPer1k: 0.000025 },

  // Los modelos cuyo precio de lista NO se conoce con certeza quedan FUERA a
  // propósito: caen en el ilustrativo y avisan, que es la respuesta honesta.
};

/** Las claves ordenadas de más larga a más corta, para que gane el prefijo más
 *  específico: `claude-haiku-4-5` antes que `claude-haiku`. */
const CLAVES_POR_LONGITUD = Object.keys(CATALOGO).sort((a, b) => b.length - a.length);

/**
 * El precio de lista de un modelo, o `undefined` si no está en el catálogo.
 *
 * @param model el id tal cual lo pide el llamante, con o sin prefijo de proveedor.
 */
export function precioDeLista(model: string): CostModel | undefined {
  if (!model) return undefined;
  const exacto = CATALOGO[model];
  if (exacto) return exacto;

  // "openai/gpt-4o-mini" → "gpt-4o-mini"
  const barra = model.lastIndexOf("/");
  const desnudo = barra >= 0 ? model.slice(barra + 1) : model;
  const porNombre = CATALOGO[desnudo];
  if (porNombre) return porNombre;

  // Instantáneas fechadas: `gpt-4o-2024-08-06`, `claude-sonnet-4-5-20250929`.
  // Se exige que el siguiente carácter NO sea alfanumérico, o `gpt-4` casaría con
  // `gpt-4o` —que cuesta doce veces menos— y el error pasaría desapercibido.
  for (const clave of CLAVES_POR_LONGITUD) {
    if (desnudo.startsWith(clave)) {
      const siguiente = desnudo.charAt(clave.length);
      if (siguiente === "" || siguiente === "-" || siguiente === "." || siguiente === "_") {
        return CATALOGO[clave];
      }
    }
  }
  return undefined;
}
