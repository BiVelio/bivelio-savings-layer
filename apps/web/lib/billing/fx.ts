/**
 * EL CAMBIO USD→EUR DEL CIERRE, DEL BCE DE VERDAD.
 *
 * El bug (caza del 2026-08-27): el cron real del día 1 sellaba el extracto
 * INMUTABLE con `FX_SOMBRA` = 0,9 fijo — el cambio de mentira del modo sombra,
 * cuyo propio texto dice «el cierre usará BCE». Una hora después Stripe factura
 * esa cifra en EUR real. Con el BCE a 0,85 la comisión se infla ~5,9 %; a 0,95
 * se infra-cobra. Y la fila queda sellada para siempre con un FX que nunca fue.
 *
 * EL BCE publica sus tipos de referencia diarios (un solo XML, sin clave, sin
 * cabeceras) como USD por EUR. Nosotros facturamos EUR y contamos en USD, así
 * que el factor que necesitamos es su inverso: eurPorUsd = 1 / (usd por eur).
 *
 * FAIL-CLOSED, y es la decisión que importa: si el BCE no responde, el cierre
 * NO sella nada con un cambio inventado —eso es justo el bug— sino que ABORTA
 * y se reintenta. Retrasar un cierre unas horas es barato; sellar mal una fila
 * inmutable que Stripe va a cobrar, no.
 */

export interface Fx {
  eurPorUsd: number;
  fuente: string;
}

const BCE_DIARIO = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

export class FxNoDisponible extends Error {
  constructor(motivo: string) {
    super(`FX del BCE no disponible: ${motivo}`);
    this.name = "FxNoDisponible";
  }
}

/**
 * El cambio EUR/USD del BCE. Lanza `FxNoDisponible` si no se puede obtener uno
 * fiable — quien llama (el cron) lo traduce en abortar y reintentar, nunca en
 * seguir con un cambio de relleno.
 *
 * `fetchImpl` se inyecta en los tests; en producción es el fetch global.
 */
export async function obtenerFxCierre(
  fetchImpl: typeof fetch = fetch,
): Promise<Fx> {
  let xml: string;
  try {
    const res = await fetchImpl(BCE_DIARIO, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new FxNoDisponible(`HTTP ${res.status}`);
    xml = await res.text();
  } catch (err) {
    if (err instanceof FxNoDisponible) throw err;
    throw new FxNoDisponible(err instanceof Error ? err.name : "error de red");
  }
  return fxDesdeXmlBce(xml);
}

/**
 * Extrae el USD/EUR del XML del BCE y devuelve su inverso. Función PURA: se
 * prueba el parseo —incluida la fecha, que queda en la fuente para poder
 * auditar QUÉ cambio se selló— sin red.
 */
export function fxDesdeXmlBce(xml: string): Fx {
  // <Cube currency='USD' rate='1.0857'/> — atributos en orden variable, comillas
  // simples o dobles. Se localiza el Cube de USD y se lee su rate.
  const cubeUsd = xml.match(/<Cube\s+[^>]*currency=['"]USD['"][^>]*>/i)?.[0];
  const usdPorEur = cubeUsd ? Number(cubeUsd.match(/rate=['"]([\d.]+)['"]/)?.[1]) : NaN;
  if (!Number.isFinite(usdPorEur) || usdPorEur <= 0) {
    throw new FxNoDisponible("no se encontró un rate USD válido en el XML");
  }
  const fecha = xml.match(/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/i)?.[1] ?? "fecha desconocida";
  return {
    eurPorUsd: 1 / usdPorEur,
    fuente: `BCE ${fecha} (USD/EUR ${usdPorEur})`,
  };
}
