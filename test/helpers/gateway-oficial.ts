/**
 * El gateway contra el ORIGEN OFICIAL del proveedor, sin salir a Internet.
 *
 * Detrás de un upstream que no es la API del proveedor el gateway mide pero no
 * acredita dinero (decisión del dueño, 2026-09-28; ver construirInforme en
 * gateway/medidor.ts), y un upstream falso en 127.0.0.1 es justamente eso. Los
 * tests que comprueban que una palanca ACREDITA su ahorro arrancan el gateway
 * con `upstream: "https://api.anthropic.com"` y este `fetchImpl`, que lleva ese
 * origen al mock local; todo lo demás (la ingesta, el canal de entitlements)
 * sale por el fetch de siempre. Es el mismo montaje que ya usaba
 * test/gateway-coalescencia.test.ts para la Parte G.
 */
export const ORIGEN_OFICIAL = "https://api.anthropic.com";

export function oficialHaciaElMock(puerto: number): { upstream: string; fetchImpl: typeof fetch } {
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.origin === ORIGEN_OFICIAL) return fetch(`http://127.0.0.1:${puerto}${u.pathname}${u.search}`, init);
    return fetch(input, init);
  }) as typeof fetch;
  return { upstream: ORIGEN_OFICIAL, fetchImpl };
}
