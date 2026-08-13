import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * A quién pertenece un evento de Stripe cuando dos productos comparten cuenta.
 *
 * Los dos errores posibles son opuestos y los dos caros:
 *   · tratar como NUESTRO un evento ajeno → 503 en bucle hasta que Stripe
 *     deshabilita el endpoint y se cae el cobro entero;
 *   · tratar como AJENO un evento nuestro → se descarta en silencio un cobro
 *     real, y el cliente paga sin recibir producto.
 * El segundo es peor, y por eso existe el tercer estado: `sin_senal`.
 */

const original = { ...process.env };

async function conPrecios(mensual?: string, anual?: string) {
  vi.resetModules();
  if (mensual === undefined) delete process.env.STRIPE_PRICE_ID_MONTHLY;
  else process.env.STRIPE_PRICE_ID_MONTHLY = mensual;
  if (anual === undefined) delete process.env.STRIPE_PRICE_ID_YEARLY;
  else process.env.STRIPE_PRICE_ID_YEARLY = anual;
  return import("./atribucion");
}

beforeEach(() => vi.resetModules());
afterEach(() => {
  process.env = { ...original };
  vi.resetModules();
});

describe("atribución por precio", () => {
  it("un precio nuestro es NUESTRO", async () => {
    const { atribuirPorPrecio } = await conPrecios("price_mensual", "price_anual");
    expect(atribuirPorPrecio("price_mensual")).toBe("nuestro");
    expect(atribuirPorPrecio("price_anual")).toBe("nuestro");
  });

  it("un precio de otro producto es AJENO — y ese es el incidente", async () => {
    // La suscripción real de BV-PRGA que llevaba 20 minutos rebotando en nuestro
    // webhook y devolviendo 503.
    const { atribuirPorPrecio } = await conPrecios("price_mensual", "price_anual");
    expect(atribuirPorPrecio("price_de_privacy_gateway")).toBe("ajeno");
  });

  it("sin precio en el evento NO se declara ajeno: se declara SIN SEÑAL", async () => {
    // Es el matiz que hace correcta toda la regla. Si "sin precio" fuese "ajeno",
    // un evento NUESTRO con el metadato roto —un fallo real y grave— se
    // silenciaría, y perderíamos justo la señal que más importa.
    const { atribuirPorPrecio } = await conPrecios("price_mensual", "price_anual");
    expect(atribuirPorPrecio(null)).toBe("sin_senal");
    expect(atribuirPorPrecio(undefined)).toBe("sin_senal");
    expect(atribuirPorPrecio("")).toBe("sin_senal");
  });

  it("sin catálogo configurado tampoco se declara nada ajeno", async () => {
    // Si no hay precios en el entorno no se puede atribuir NADA. Decidir "ajeno"
    // aquí dejaría de procesar todo en silencio, que es la peor caída posible:
    // el cobro entero parado y el panel de Stripe en verde.
    const { atribuirPorPrecio } = await conPrecios(undefined, undefined);
    expect(atribuirPorPrecio("price_cualquiera")).toBe("sin_senal");
  });

  it("⛔ con el catálogo A MEDIAS no se descarta NADA", async () => {
    // El riesgo de un despliegue incompleto: si faltara el precio anual, una
    // renovación anual NUESTRA se habría visto como ajena y se habría descartado
    // en silencio — un cobro real perdido por una variable de entorno. Con el
    // catálogo incompleto todo es "sin_senal": se procesa y se avisa.
    const { atribuirPorPrecio } = await conPrecios("price_mensual", undefined);
    expect(atribuirPorPrecio("price_mensual")).toBe("sin_senal");
    expect(atribuirPorPrecio("price_anual")).toBe("sin_senal");
    expect(atribuirPorPrecio("price_de_otro")).toBe("sin_senal");
  });

  it("los precios propios se leen del entorno, sin huecos", async () => {
    const { preciosPropios } = await conPrecios("a", undefined);
    expect(preciosPropios()).toEqual(["a"]);
  });
});

describe("el cambio a tax_behavior exclusive (2026-08-13)", () => {
  /**
   * Los precios se recrearon `exclusive` sobre los MISMOS productos, y la
   * suscripción que ya existía se quedó con el precio VIEJO — Stripe no deja
   * cambiar `tax_behavior` en un precio vivo.
   *
   * A partir de ahí hay una forma concreta de perder un cobro real: si la
   * atribución solo mirase los precios NUEVOS, la renovación de esa suscripción
   * llegaría con el precio viejo, no estaría en la lista, y se descartaría como
   * ajena. En silencio, y con el panel de Stripe en verde.
   */
  const NUEVO = "price_nuevo_exclusive";
  const VIEJO = "price_viejo_inclusive";
  const NUESTRO = "prod_nuestro";

  async function comoEnProduccion() {
    vi.resetModules();
    process.env.STRIPE_PRICE_ID_MONTHLY = NUEVO;
    process.env.STRIPE_PRICE_ID_YEARLY = "price_nuevo_anual";
    process.env.STRIPE_PRICE_IDS_EXTRA = VIEJO;
    process.env.STRIPE_PRODUCT_IDS = NUESTRO;
    return import("./atribucion");
  }

  it("⛔ la renovación con el precio VIEJO sigue siendo NUESTRA", async () => {
    const { atribuirPorPrecio } = await comoEnProduccion();
    expect(atribuirPorPrecio(VIEJO, NUESTRO)).toBe("nuestro");
    // Y también sin conocer el producto, gracias a STRIPE_PRICE_IDS_EXTRA.
    expect(atribuirPorPrecio(VIEJO, null)).toBe("nuestro");
  });

  it("el precio nuevo también, evidentemente", async () => {
    const { atribuirPorPrecio } = await comoEnProduccion();
    expect(atribuirPorPrecio(NUEVO, NUESTRO)).toBe("nuestro");
  });

  it("⛔ y lo de BV-PRGA sigue siendo ajeno", async () => {
    // Su suscripción vive en la MISMA cuenta de Stripe (price_1TxknI…, producto
    // "BiVelio Shield"). Si el cambio de precios la hubiera vuelto nuestra,
    // habríamos empezado a escribir su cobro en nuestro esquema.
    const { atribuirPorPrecio } = await comoEnProduccion();
    expect(atribuirPorPrecio("price_de_shield", "prod_shield")).toBe("ajeno");
  });

  it("el producto MANDA sobre el precio: es lo que sobrevive a recrear el catálogo", async () => {
    // Un `price_id` se rompe cada vez que se toca el importe o el impuesto. El
    // product id no. Por eso la regla mira primero el producto.
    const { atribuirPorPrecio } = await comoEnProduccion();
    expect(atribuirPorPrecio("price_que_nadie_conoce", NUESTRO)).toBe("nuestro");
  });
});
