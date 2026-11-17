/**
 * DÓNDE VIVE LA INSTRUCCIÓN DE CADA HITO de la puesta en marcha.
 *
 * Los cinco hitos los decide `activationSteps` (data.ts) y se identifican por
 * su `id` estable, nunca por la etiqueta traducida. Aquí solo se dice a qué
 * pantalla lleva pulsar cada uno — pulsar ABRE la instrucción, no acredita
 * nada: un hito pasa a «listo» únicamente cuando el producto lo mide.
 *
 * Mismos destinos que ya usaba la espina del Resumen (cuenta y licencia en
 * Cuenta; SDK/gateway y primera petición en Primeros pasos).
 */
const DESTINOS: Record<string, string> = {
  "Account created": "/dashboard/account",
  "License active": "/dashboard/account",
  "SDK or gateway installed": "/dashboard/install#sdk",
  "First real request": "/dashboard/install",
  "Report ready": "/dashboard",
};

export function destinoDelHito(id: string): string | undefined {
  return DESTINOS[id];
}
