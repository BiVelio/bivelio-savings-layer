import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { RevocationPoller } from "../src/license/poller.js";
import { RevocationSnapshot } from "../src/license/revocation.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";

/**
 * EL FALLO SILENCIOSO DEL SDK.
 *
 * El sondeo de revocaciones es fail-open a propósito: una red caída no puede
 * tumbar la producción de un cliente. Pero la consecuencia es que un endpoint mal
 * configurado, un cortafuegos nuevo o una URL cambiada no producen NINGÚN
 * síntoma: la licencia sigue funcionando, las peticiones siguen pasando, y lo
 * único que ocurre es que la lista de revocaciones se queda congelada durante
 * días. `onEvent` existía para verlo, pero es opcional y casi nadie lo cablea.
 *
 * Y había algo peor, que es el paso previo: el ETag se guardaba ANTES de
 * verificar la firma. Una lista rechazada quedaba cacheada, el siguiente sondeo
 * mandaba `If-None-Match`, el servidor contestaba 304 y el rechazo no volvía a
 * ocurrir hasta once ciclos después. Un fallo visible una vez cada tres horas es
 * un fallo invisible.
 */

const URL_CP = "https://savings.bivelio.com/licenses/revocations";
const CLAVE = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAWBiklf0kmDIVmM7nMiCxwiEAkwQIiqWGuRiRDJonsFY=
-----END PUBLIC KEY-----`;

let avisos: string[];
beforeEach(() => {
  avisos = [];
  reiniciarAvisos();
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    avisos.push(a.map(String).join(" "));
  });
});
afterEach(() => vi.restoreAllMocks());

function poller(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new RevocationPoller({
    url: URL_CP,
    publicKeyPem: CLAVE,
    snapshot: new RevocationSnapshot(),
    fetchImpl,
    nowSeconds: () => 1_800_000_000,
    ...extra,
  });
}

/** Respuesta con una lista que NO verifica (firma inventada) y un ETag. */
const listaMala = (etag = 'W/"malo"') =>
  ({
    status: 200,
    ok: true,
    headers: { get: (h: string) => (h.toLowerCase() === "etag" ? etag : null) },
    json: async () => ({ list: "no.es.una.lista.firmada" }),
  }) as unknown as Response;

const trescientosCuatro = () =>
  ({
    status: 304,
    ok: false,
    headers: { get: () => null },
    json: async () => ({}),
  }) as unknown as Response;

describe("⛔ el ETag NO se guarda hasta que la lista verifica", () => {
  it("una lista rechazada NO deja ETag, así que el siguiente sondeo la vuelve a pedir entera", async () => {
    // Es el paso previo sin el cual el aviso de abajo saldría una vez cada once
    // ciclos: con el ETag guardado, el segundo sondeo mandaría `If-None-Match` y
    // se comería un 304 tratado como ÉXITO.
    const enviados: (string | undefined)[] = [];
    const f = vi.fn(async (_u: unknown, init?: { headers?: Record<string, string> }) => {
      enviados.push(init?.headers?.["if-none-match"]);
      return listaMala();
    }) as unknown as typeof fetch;

    const p = poller(f);
    await p.pollOnce();
    await p.pollOnce();

    expect(enviados).toEqual([undefined, undefined]);
  });

  it("y el rechazo se comunica en CADA sondeo, no una vez cada tres horas", async () => {
    const eventos: string[] = [];
    const f = vi.fn(async () => listaMala()) as unknown as typeof fetch;
    const p = poller(f, { onEvent: (e: { type: string }) => eventos.push(e.type) });
    await p.pollOnce();
    await p.pollOnce();
    await p.pollOnce();
    expect(eventos).toEqual(["rejected", "rejected", "rejected"]);
  });

  it("una lista rechazada avisa por consola aunque nadie cablee onEvent", async () => {
    // Una lista que no verifica no es una incidencia de red: o hay un fallo de
    // despliegue o alguien está sirviendo algo que no hemos firmado nosotros.
    const f = vi.fn(async () => listaMala()) as unknown as typeof fetch;
    await poller(f).pollOnce();
    expect(avisos.join(" ")).toContain("NO verifica");
    expect(avisos.join(" ")).toContain(URL_CP);
  });

  it("el aviso de rechazo no se repite en bucle", async () => {
    const f = vi.fn(async () => listaMala()) as unknown as typeof fetch;
    const p = poller(f);
    for (let i = 0; i < 5; i++) await p.pollOnce();
    expect(avisos.filter((a) => a.includes("NO verifica"))).toHaveLength(1);
  });

  it("un 304 sigue siendo un éxito silencioso: no avisa de nada", async () => {
    const f = vi.fn(async () => trescientosCuatro()) as unknown as typeof fetch;
    const p = poller(f);
    for (let i = 0; i < 3; i++) await p.pollOnce();
    expect(avisos).toEqual([]);
  });
});

describe("el call-home caído deja de ser mudo", () => {
  const caido = () =>
    vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

  it("no avisa al primer fallo: una petición perdida es normal", async () => {
    // El sondeo es fail-open por diseño. Avisar al primero entrenaría a ignorarlo.
    const p = poller(caido());
    await p.pollOnce();
    await p.pollOnce();
    expect(avisos).toEqual([]);
  });

  it("⛔ al tercer fallo seguido SÍ avisa, sin necesidad de onEvent", async () => {
    // El defecto que esto cierra: sin `onEvent` —que casi nadie cablea— un
    // cortafuegos nuevo o una URL cambiada no producían ningún síntoma. La
    // licencia seguía funcionando y la lista se quedaba congelada durante días.
    const p = poller(caido());
    for (let i = 0; i < 3; i++) await p.pollOnce();
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain("3 times in a row");
    // El mensaje dice qué significa, no solo que algo falló.
    expect(avisos[0]).toContain("NEW ones are not arriving");
    expect(avisos[0]).toContain(URL_CP);
  });

  it("se repite cada doce fallos: una caída de una semana sigue recordándose", async () => {
    // Un aviso único se pierde en el arranque de un despliegue.
    const p = poller(caido());
    for (let i = 0; i < 15; i++) await p.pollOnce();
    expect(avisos).toHaveLength(2);
  });

  it("no inunda la consola: 40 fallos no son 40 avisos", async () => {
    const p = poller(caido());
    for (let i = 0; i < 40; i++) await p.pollOnce();
    expect(avisos.length).toBeLessThanOrEqual(4);
  });

  it("una recuperación reinicia la cuenta", async () => {
    let falla = true;
    const f = vi.fn(async () => {
      if (falla) throw new Error("ECONNREFUSED");
      return trescientosCuatro();
    }) as unknown as typeof fetch;
    const p = poller(f);
    await p.pollOnce();
    await p.pollOnce();
    falla = false;
    await p.pollOnce(); // se recupera
    falla = true;
    await p.pollOnce();
    await p.pollOnce();
    // Solo dos fallos desde la recuperación: por debajo del umbral.
    expect(avisos).toEqual([]);
  });

  it("quien tenga su propia observabilidad puede callarlos", async () => {
    const p = poller(caido(), { silenciarAvisos: true });
    for (let i = 0; i < 20; i++) await p.pollOnce();
    expect(avisos).toEqual([]);
  });

  it("⛔ pero el defecto es AVISAR: silenciar hay que pedirlo", async () => {
    // Si el defecto fuese el silencio, el arreglo no serviría de nada: nadie
    // enciende una opción cuyo problema no sabe que tiene.
    const p = poller(caido());
    for (let i = 0; i < 3; i++) await p.pollOnce();
    expect(avisos.length).toBeGreaterThan(0);
  });

  it("avisar NO cambia el comportamiento: sigue siendo fail-open", async () => {
    // Lo importante: esto añade ruido en la consola, no una excepción. Ni un
    // `pollOnce` puede lanzar, o una red caída tumbaría la producción del cliente.
    const p = poller(caido());
    for (let i = 0; i < 5; i++) await expect(p.pollOnce()).resolves.toBeUndefined();
  });
});
