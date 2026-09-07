/**
 * EL RECIBO — lo que se le enseña a alguien que todavía NO paga.
 *
 * Es la pieza comercial del producto y por eso es la más estricta del
 * repositorio: enseña lo que el cliente se habría ahorrado sobre SU tráfico,
 * separado en tres carriles que no se suman jamás, porque cada uno tiene una
 * calidad de prueba distinta:
 *
 *   MEDIDO      El proveedor declaró los mismos tokens y nosotros pagamos otra
 *               tarifa. Es una resta entre dos precios públicos: se puede
 *               contrastar con la consola del proveedor línea a línea. Es lo
 *               ÚNICO que se factura.
 *   DEL PROVEEDOR  Su propio contador dice cuántos tokens borró. El conteo es
 *               suyo, no nuestro; el DINERO que vale depende de a qué precio se
 *               habrían pagado esos tokens, y esa parte es una estimación
 *               nuestra. Se enseña, no se cobra.
 *   HIPOTÉTICO  Lo que una política habría ahorrado si se hubiera aplicado.
 *               Sale de simular el turno; nadie ejecutó nada. Puede salir
 *               NEGATIVO y se enseña igual. Jamás se cobra.
 *
 * La regla que gobierna todo el fichero: si una cifra no se puede contrastar
 * contra la factura del proveedor, se dice en la misma línea en que aparece.
 * Un recibo que exagera se descubre el primer día que el cliente audite, y ahí
 * se pierde lo único que este producto tiene de verdad.
 */

/** Lo que el gateway acumula durante una sesión, por modelo. */
export interface AcumuladoPorModelo {
  peticiones: number;
  costeUsd: number;
  /** Entrada declarada por el proveedor (fresca + caché leída + caché escrita). */
  tokensEntrada: number;
  tokensSalida: number;
  /** MEDIDO: sobrecoste evitado por la rebaja de TTL. Facturable. */
  ahorroMedidoUsd: number;
  /** DEL PROVEEDOR: tokens que su contador declara borrados. Conteo, no dinero. */
  tokensElididos: number;
  /** HIPOTÉTICO: lo que la política de sombra habría ahorrado. Puede ser < 0. */
  ahorroSombraUsd: number;
  /** Si la verja de aptitud dejó aplicar la elisión en este modelo. */
  verja: string;
}

export interface DatosDelRecibo {
  desde: string;
  hasta: string;
  porModelo: Record<string, AcumuladoPorModelo>;
  /** Versión del catálogo con que se tarifó. Hace el recibo auditable. */
  versionPrecios: string;
  /** Versión del gateway que lo produjo. */
  version: string;
}

export interface Totales {
  peticiones: number;
  costeUsd: number;
  ahorroMedidoUsd: number;
  tokensElididos: number;
  ahorroSombraUsd: number;
  /** Ahorro medido como % del coste. La cifra que se puede defender. */
  pctMedido: number;
  /** Ahorro hipotético como % del coste. La que NO se factura. */
  pctSombra: number;
}

export function totalizar(datos: DatosDelRecibo): Totales {
  const t: Totales = {
    peticiones: 0, costeUsd: 0, ahorroMedidoUsd: 0, tokensElididos: 0,
    ahorroSombraUsd: 0, pctMedido: 0, pctSombra: 0,
  };
  for (const m of Object.values(datos.porModelo)) {
    t.peticiones += m.peticiones;
    t.costeUsd += m.costeUsd;
    t.ahorroMedidoUsd += m.ahorroMedidoUsd;
    t.tokensElididos += m.tokensElididos;
    t.ahorroSombraUsd += m.ahorroSombraUsd;
  }
  // El denominador es el coste REAL pagado más lo que se evitó: la factura que
  // habría salido sin nosotros. Usar el coste pagado a secas inflaría el %.
  const base = t.costeUsd + t.ahorroMedidoUsd;
  t.pctMedido = base > 0 ? (t.ahorroMedidoUsd / base) * 100 : 0;
  t.pctSombra = base > 0 ? (t.ahorroSombraUsd / base) * 100 : 0;
  return t;
}

const usd = (n: number): string => `$${n.toFixed(4)}`;
const pct = (n: number): string => `${n >= 0 ? "" : "−"}${Math.abs(n).toFixed(2)} %`;
const num = (n: number): string => n.toLocaleString("es-ES");

/**
 * Renderiza el recibo en texto plano. Sin colores ni cajas de dibujo: esto se
 * pega en un correo, se manda por chat y se lee en cualquier terminal.
 */
export function renderizarRecibo(datos: DatosDelRecibo): string {
  const t = totalizar(datos);
  const L: string[] = [];
  const modelos = Object.entries(datos.porModelo).sort((a, b) => b[1].costeUsd - a[1].costeUsd);

  L.push("RECIBO DE AHORRO · BiVelio Savings");
  L.push(`Tráfico de ${datos.desde} a ${datos.hasta} · ${num(t.peticiones)} peticiones`);
  L.push("");
  L.push(`Lo que has pagado al proveedor        ${usd(t.costeUsd)}`);
  L.push(`Lo que habrías pagado sin nosotros    ${usd(t.costeUsd + t.ahorroMedidoUsd)}`);
  L.push("");

  L.push("── LO MEDIDO — esto es lo único que se factura ──");
  L.push("");
  L.push(`  Ahorro demostrable                  ${usd(t.ahorroMedidoUsd)}   ${pct(t.pctMedido)}`);
  L.push("");
  L.push("  Son los MISMOS tokens que el proveedor declaró, pagados a otra");
  L.push("  tarifa pública. Puedes cuadrarlo con tu consola línea a línea.");
  L.push("  Si esta cifra es 0, no se te cobra nada: no hay mínimo.");
  L.push("");

  if (t.tokensElididos > 0) {
    L.push("── LO QUE EL PROVEEDOR BORRÓ — se enseña, no se cobra ──");
    L.push("");
    L.push(`  Tokens de entrada retirados         ${num(t.tokensElididos)}`);
    L.push("");
    L.push("  El contador es del proveedor, no nuestro. Cuánto DINERO valen");
    L.push("  depende de a qué precio se habrían pagado, y eso es una");
    L.push("  estimación nuestra: por eso no entra en la factura.");
    L.push("");
  }

  if (t.ahorroSombraUsd !== 0) {
    L.push("── LO HIPOTÉTICO — simulado, nunca cobrado ──");
    L.push("");
    L.push(`  Ahorro que habría dado la política  ${usd(t.ahorroSombraUsd)}   ${pct(t.pctSombra)}`);
    L.push("");
    L.push("  Nadie ejecutó esto: es el mismo turno simulado con la política");
    L.push("  encendida. Puede salir NEGATIVO, y cuando sale lo enseñamos");
    L.push("  igual — este carril existe para decir la verdad antes de");
    L.push("  encender nada.");
    L.push("");
  }

  if (modelos.length > 0) {
    L.push("── POR MODELO ──");
    L.push("");
    L.push("  modelo                        peticiones      coste    medido   hipotético   verja");
    for (const [nombre, m] of modelos) {
      const base = m.costeUsd + m.ahorroMedidoUsd;
      const p = base > 0 ? (m.ahorroSombraUsd / base) * 100 : 0;
      L.push(
        `  ${nombre.padEnd(28).slice(0, 28)}${String(m.peticiones).padStart(10)}` +
          `${usd(m.costeUsd).padStart(11)}${usd(m.ahorroMedidoUsd).padStart(10)}` +
          `${pct(p).padStart(13)}   ${m.verja}`,
      );
    }
    L.push("");
    L.push("  «verja» dice si la política se aplica en ese modelo. Solo se");
    L.push("  aplica donde está MEDIDO que ahorra: donde no hay medición, o");
    L.push("  donde pierde dinero, tu tráfico viaja intacto.");
    L.push("");
  }

  L.push("── LA LETRA PEQUEÑA, que aquí va en grande ──");
  L.push("");
  L.push("  · Solo se cobra sobre LO MEDIDO. Lo estimado y lo hipotético");
  L.push("    nunca entran en la factura, aunque salgan más grandes.");
  L.push("  · Te quedas como mínimo el 90 % de cada euro ahorrado.");
  L.push("  · Un mes sin ahorro es un mes sin comisión: 0 €.");
  L.push("  · Tus prompts no salen de tu máquina. Al panel solo suben");
  L.push("    conteos y coste, jamás contenido.");
  L.push("");
  L.push(`  Precios del catálogo ${datos.versionPrecios} · gateway ${datos.version}`);
  L.push("  Verifícalo contra tu consola del proveedor. Si no cuadra, es un");
  L.push("  fallo nuestro y queremos saberlo: support@bivelio.com");

  return L.join("\n");
}
