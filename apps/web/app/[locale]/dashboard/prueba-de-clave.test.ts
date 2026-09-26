import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { estadoDeLaPrueba } from "./prueba-de-clave";

/**
 * La sonda «Test my key» del paso 2 de /dashboard/install manda un lote vacío a
 * /api/metering/usage. Desde que la org sin licencia ni suscripción recibe 402
 * (no hay free tier), ese 402 lo ve quien crea la clave antes de suscribirse, y
 * el panel lo pintaba como «Unexpected response (402). Try again in a moment.»:
 * una clave buena presentada como un fallo pasajero que reintentar no cura.
 * El otro extremo del contrato —que el lote vacío de esa org reciba 402 y el de
 * una org con derecho 202— lo fija api/metering/usage/route.test.ts.
 */

const LOCALES = ["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"] as const;

const leer = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const keyNoPlan = (loc: string): string =>
  (JSON.parse(leer(`../../../messages/${loc}.json`)) as {
    dashboard: { serviceAccountKeySection: { keyNoPlan: string } };
  }).dashboard.serviceAccountKeySection.keyNoPlan;

describe("la sonda «Test my key»: qué significa cada respuesta de la ingesta", () => {
  it("202 → válida; 401 → no reconocida", () => {
    expect(estadoDeLaPrueba(202)).toBe("valid");
    expect(estadoDeLaPrueba(401)).toBe("invalid");
  });

  it("402 → clave reconocida en una org sin licencia ni suscripción: estado propio, nunca «inesperado»", () => {
    expect(estadoDeLaPrueba(402)).toBe("noPlan");
  });

  it("el resto (400, 403, 404, 500, 503) sigue siendo inesperado", () => {
    for (const s of [200, 400, 403, 404, 500, 503]) expect(estadoDeLaPrueba(s), String(s)).toBe("error");
  });

  it("el componente decide con este mapeo y pinta keyNoPlan para el 402", () => {
    const fuente = leer("./components/ServiceAccountKeySection.tsx");
    expect(fuente).toContain("estadoDeLaPrueba(res.status)");
    expect(fuente).toMatch(/tState === "noPlan"[\s\S]{0,200}serviceAccountKeySection\.keyNoPlan/);
  });

  it("keyNoPlan está en los 12 idiomas, traducido, y manda a Cuenta en vez de invitar a reintentar", () => {
    const en = keyNoPlan("en");
    expect(en).toMatch(/license or subscription/);
    expect(en).toMatch(/\bAccount\b/);
    expect(en).not.toMatch(/try again in a moment/i);
    expect(keyNoPlan("es")).toMatch(/Cuenta/);
    expect(keyNoPlan("es")).not.toMatch(/Vuelve a intentarlo en un momento/);
    for (const loc of LOCALES) {
      const v = keyNoPlan(loc);
      expect(v.length, loc).toBeGreaterThan(0);
      if (loc !== "en") expect(v, `${loc} sin traducir`).not.toBe(en);
    }
  });
});
