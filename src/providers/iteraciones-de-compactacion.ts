// LA COMPACTACIÓN DE ANTHROPIC SE FACTURA FUERA DE LOS CONTADORES DE PRIMER NIVEL.
//
// Módulo INTERNO: lo usan el adaptador de Anthropic del SDK y el medidor del
// gateway, y no se reexporta desde el paquete.
//
// Con la compactación del servidor (la de umbral, `compact_20260112` con la beta
// `compact-2026-01-12`, y la bajo demanda, `compaction` con `compact-2026-09-04`)
// la API resume el historial en una iteración de muestreo propia ANTES de la
// respuesta, y la cobra. Pero `usage.input_tokens`/`usage.output_tokens` no la
// incluyen. La documentación oficial, consultada el 2026-09-27
// (https://platform.claude.com/docs/en/build-with-claude/compaction-threshold,
// «Understanding usage»):
//
//   «The top-level `input_tokens` and `output_tokens` do not include compaction
//    iteration usage. They reflect the sum of all non-compaction iterations. To
//    calculate total tokens consumed and billed for a request, sum across all
//    entries in the `usage.iterations` array.»
//
// Y en la bajo demanda (…/compaction-on-demand, «Count compaction usage»), la
// petición que resume trae los contadores de primer nivel a CERO y todo el coste
// en la entrada `compaction` de `usage.iterations`.
//
// Leer solo el primer nivel infra-mide la factura exactamente en lo que costó
// resumir: en el ejemplo oficial, 180.000 tokens de entrada y 3.500 de salida que
// no aparecían en ningún informe.
//
// LO QUE ES INFERENCIA Y NO CITA: LOS CONTADORES DE CACHÉ. La página de
// compactación solo dice que `input_tokens` y `output_tokens` de primer nivel
// excluyen la iteración de compactación; de `cache_read_input_tokens` y
// `cache_creation_input_tokens` no dice nada, y su ejemplo no los trae. Que
// también la excluyan —y que por eso aquí se sumen las de la iteración— se
// infiere de dos frases oficiales: la de arriba («sum across all entries in the
// `usage.iterations` array» para tener lo facturado) y la de la página del
// advisor, consultada el mismo día
// (https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool):
//
//   «Every top-level `usage` field is the sum of that field across all executor
//    iterations, including `input_tokens`, `output_tokens`, and
//    `cache_read_input_tokens`.»
//
// Si la inferencia fallara (el primer nivel ya trajera la caché de la
// compactación), esas lecturas y escrituras se contarían DOS veces: el `actual`
// quedaría por encima de la factura y, en el gateway, la palanca C (el hermano,
// que valora el mismo conteo a dos precios de lectura) se inflaría con ellas.
// Hasta que un sondeo en vivo lo confirme, esto es una suposición declarada, no
// una cifra verificada.
//
// POR QUÉ SE SUMAN SOLO LAS ITERACIONES `compaction` Y NO TODO EL ARRAY. El
// primer nivel ya es «la suma de las iteraciones que no son de compactación»; y
// hay iteraciones que se tarifan con OTRO modelo (el `advisor` factura a la tarifa
// de su propio modelo), así que sumarlas al precio del modelo de la petición
// inventaría un coste. Total = primer nivel + iteraciones `compaction`, que es la
// misma cifra que «sumar todo el array» cuando solo hay mensaje y compactación.

/** Lo que las iteraciones de compactación suman POR ENCIMA del `usage` de primer nivel. */
export interface ExtraDeCompactacion {
  /** Tokens de entrada no cacheados de las iteraciones de compactación. */
  input: number;
  output: number;
  cacheRead: number;
  /** Escritura de caché total (5 min + 1 h). */
  cacheWrite: number;
  /** La parte de `cacheWrite` con TTL de 1 h, si la iteración trae el desglose. */
  cacheWrite1h: number;
  /** Cuántas iteraciones de compactación hubo (≥ 1: sin ninguna, la función da null). */
  iteraciones: number;
}

const contador = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * Las iteraciones `compaction` de un `usage.iterations`, sumadas; `null` si no
 * hay ninguna (o el campo no es un array): entonces el primer nivel ya es la
 * factura entera y no hay nada que añadir.
 */
export function extraDeCompactacion(iterations: unknown): ExtraDeCompactacion | null {
  if (!Array.isArray(iterations)) return null;
  const extra: ExtraDeCompactacion = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, iteraciones: 0 };
  for (const it of iterations) {
    if (it === null || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    if (o["type"] !== "compaction") continue;
    extra.iteraciones++;
    extra.input += contador(o["input_tokens"]);
    extra.output += contador(o["output_tokens"]);
    extra.cacheRead += contador(o["cache_read_input_tokens"]);
    const desglose = o["cache_creation"] as { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown } | null | undefined;
    const d5m = contador(desglose?.ephemeral_5m_input_tokens);
    const d1h = contador(desglose?.ephemeral_1h_input_tokens);
    // El total manda y el desglose solo reparte, como en el primer nivel.
    const escrita = typeof o["cache_creation_input_tokens"] === "number" ? contador(o["cache_creation_input_tokens"]) : d5m + d1h;
    extra.cacheWrite += escrita;
    extra.cacheWrite1h += Math.min(d1h, escrita);
  }
  return extra.iteraciones > 0 ? extra : null;
}
