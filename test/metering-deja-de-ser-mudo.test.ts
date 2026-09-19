import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { UsageEmitter } from "../src/metering/emitter.js";
import type { SavingsReport } from "../src/contracts/types.js";

/**
 * EL ÚLTIMO ESLABÓN DE LA PROMESA, Y EL QUE SE ROMPÍA EN SILENCIO.
 *
 * El producto promete tres cosas: te ahorra, lo mide, y te lo enseña. Las dos
 * primeras funcionan aunque el ingest esté roto — el cliente sigue ahorrando y el
 * `SavingsReport` sigue siendo correcto en su proceso. La tercera no, y no había
 * forma de enterarse.
 *
 * SE ENCONTRÓ PROBÁNDOLO DE VERDAD. Al ejecutar el paquete publicado contra un
 * proveedor real, se le pasó `meteringUrl: "https://savings.bivelio.com"` sin la
 * ruta (por defecto es `${licenseServerUrl}/api/metering/usage`). La raíz del
 * sitio contesta con una página, así que no era 5xx ni 401/403: el lote caía en
 * el `else` que no existía y se descartaba SIN UNA SOLA SEÑAL. Cero filas en la
 * base, cero avisos, y un panel que le habría dicho al cliente «aún no vemos tu
 * tráfico: instala el SDK» durante meses. El síntoma apunta al sitio opuesto de
 * la causa.
 */

/**
 * Un informe MÍNIMO PERO VÁLIDO. Con `{}` el emisor revienta al serializarlo y el
 * aviso sale del `catch` de red en vez de la rama que se quiere probar: el test
 * pasaba a verde por el motivo equivocado. Un fixture inválido es un test que
 * mide otra cosa.
 */
const informe = (): SavingsReport =>
  ({
    requestId: "req-1",
    model: "gpt-4o-mini",
    calls: { avoidedLlm: 0, actualLlm: 1 },
    tokens: {
      baselineInput: 10, actualInput: 10, eliminatedInput: 0,
      compressedInput: 0, baselineOutput: 5, actualOutput: 5,
    },
    cache: { result: "miss" },
    cost: { baselineEstimate: 0.001, actual: 0.001, netSavings: 0, basis: "measured" },
  }) as unknown as SavingsReport;

let avisos: string[];
beforeEach(() => {
  avisos = [];
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    avisos.push(a.map(String).join(" "));
  });
});
afterEach(() => vi.restoreAllMocks());

function emisor(respuesta: () => Promise<Response> | Response, extra: Record<string, unknown> = {}) {
  return new UsageEmitter({
    url: "https://savings.bivelio.com",
    serviceAccountKey: "bvk_de_prueba",
    fetchImpl: (async () => respuesta()) as unknown as typeof fetch,
    ...extra,
  });
}
const resp = (status: number) =>
  ({ ok: status >= 200 && status < 300, status }) as Response;

/** Un envío completo: encolar y forzar el vaciado. */
async function enviar(e: UsageEmitter, veces = 1) {
  for (let i = 0; i < veces; i++) {
    e.record(informe());
    await e.flush();
  }
}

describe("una URL de envío equivocada deja de ser muda", () => {
  it("⛔ un 404 avisa: es el caso de la meteringUrl sin la ruta", async () => {
    const e = emisor(() => resp(404));
    await enviar(e, 3);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain("404");
    expect(avisos[0]).toContain("the reporting URL looks wrong");
    // El mensaje dice DÓNDE mirar, no solo que algo falló.
    expect(avisos[0]).toContain("meteringUrl");
  });

  it("un 405 también (POST a algo que no lo acepta)", async () => {
    const e = emisor(() => resp(405));
    await enviar(e, 3);
    expect(avisos[0]).toContain("405");
  });

  it("⛔ dice lo que SIGNIFICA, no solo que falló", async () => {
    // «El panel dirá que no ve tráfico» es lo que convierte un aviso en algo
    // accionable: sin eso, quien lo lea no relaciona la causa con el síntoma.
    const e = emisor(() => resp(404));
    await enviar(e, 3);
    expect(avisos[0]).toContain("keep working");
    expect(avisos[0]).toMatch(/not arriving|billable seats/);
  });

  it("no avisa a la primera: un envío perdido es normal", async () => {
    const e = emisor(() => resp(500));
    await enviar(e, 2);
    expect(avisos).toEqual([]);
  });

  it("un 5xx sostenido también avisa, y NO pierde el lote", async () => {
    const e = emisor(() => resp(503));
    await enviar(e, 3);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain("503");
  });

  it("se repite cada doce: una caída larga sigue recordándose", async () => {
    const e = emisor(() => resp(404));
    await enviar(e, 15);
    expect(avisos).toHaveLength(2);
  });

  it("no inunda: 40 fallos no son 40 avisos", async () => {
    const e = emisor(() => resp(404));
    await enviar(e, 40);
    expect(avisos.length).toBeLessThanOrEqual(4);
  });

  it("un error de red también cuenta", async () => {
    const e = emisor(() => {
      throw new Error("ECONNREFUSED");
    });
    await enviar(e, 3);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain("ECONNREFUSED");
  });

  it("⛔ recuperarse REINICIA la cuenta", async () => {
    let fallando = true;
    const e = emisor(() => resp(fallando ? 404 : 202));
    await enviar(e, 2);
    fallando = false;
    await enviar(e, 1); // se recupera
    fallando = true;
    await enviar(e, 2);
    // Solo dos fallos desde la recuperación: por debajo del umbral.
    expect(avisos).toEqual([]);
  });

  it("un envío correcto no dice nada", async () => {
    const e = emisor(() => resp(202));
    await enviar(e, 10);
    expect(avisos).toEqual([]);
  });

  it("quien tenga su propia observabilidad puede callarlos", async () => {
    const e = emisor(() => resp(404), { silenceWarnings: true });
    await enviar(e, 20);
    expect(avisos).toEqual([]);
  });

  it("⛔ pero el defecto es AVISAR", async () => {
    // Nadie enciende una opción cuyo problema no sabe que tiene.
    const e = emisor(() => resp(404));
    await enviar(e, 3);
    expect(avisos.length).toBeGreaterThan(0);
  });

  it("avisar NO cambia el comportamiento: sigue sin lanzar nunca", async () => {
    // Lo esencial: medir es best-effort y no puede tumbar la petición del cliente.
    const e = emisor(() => {
      throw new Error("boom");
    });
    for (let i = 0; i < 5; i++) {
      e.record(informe());
      await expect(e.flush()).resolves.toBeUndefined();
    }
  });

  it("el 401 sigue teniendo su propio aviso, más específico", async () => {
    // Una credencial mala no se cura sola y pide otra acción: revisar la `bvk_`.
    const e = emisor(() => resp(401));
    await enviar(e, 1);
    expect(avisos.join(" ")).toContain("serviceAccountKey");
  });
});
