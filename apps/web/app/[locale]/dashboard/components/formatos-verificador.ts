/**
 * La carga de ejemplo del verificador y los formatos que muestra su barra.
 *
 * Extraído del componente (`ProjectorVerifier.tsx`) a un módulo plano —sin React
 * ni next-intl— para poder ATARLO al bundle real del SDK en un test. La lista
 * `FORMATOS_MOSTRADOS` filtra qué candidatos pinta la barra; si un formato que el
 * SDK elige de verdad no está en ella, su recuento se cae y la fila «BV-SALA»
 * retrocede al baseline, mostrando «recorta 0 tokens» aunque el ahorro sea real.
 * Es lo que pasó cuando el formato `toon` se renombró a `compact-rows` (#62) y
 * esta lista se quedó atrás. `verificador-formato.test.ts` corre el bundle sobre
 * `CARGA_DE_EJEMPLO` y exige que el formato elegido esté aquí.
 */
export const CARGA_DE_EJEMPLO = JSON.stringify(
  {
    users: Array.from({ length: 24 }, (_, i) => ({
      id: 1000 + i,
      name: `user_${i}`,
      role: i % 3 ? "member" : "admin",
      active: i % 4 !== 0,
    })),
  },
  null,
  2,
);

/** Formatos candidatos que la barra del verificador sabe pintar, en orden de
 *  preferencia. DEBE incluir todo formato que el `FormatSelector` del SDK pueda
 *  elegir — atado por test contra el bundle real. */
export const FORMATOS_MOSTRADOS = ["json-compact", "compact-rows", "csv"] as const;
