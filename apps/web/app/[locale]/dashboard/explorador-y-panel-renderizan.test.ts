import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import { UsageExplorer } from "./components/UsageExplorer";
import { PanelEditable } from "./components/PanelEditable";
import type { UsageRollup } from "./data";

/**
 * Los dos componentes de cliente nuevos RENDERIZAN EN SERVIDOR con datos reales
 * de forma. No es una prueba visual: es la que caza el error de ejecución que
 * TypeScript no ve (una clave de mensaje construida que no existe, un índice
 * fuera de rango, un `window` tocado en el servidor) antes de que lo vea un
 * cliente. El HTML que sale es el mismo que hidrata el navegador, así que lo
 * que aquí falta, allí también.
 */
const mensajes = JSON.parse(readFileSync(new URL("../../../messages/en.json", import.meta.url), "utf8"));

function fila(day: string, i: number): UsageRollup {
  return {
    day,
    requests: 100 + i,
    avoidedLlm: 10 + i,
    actualLlm: 90,
    eliminatedInputTokens: 1000 * i,
    compressedInputTokens: 500,
    providerCachedInputTokens: 2500,
    baselineCost: 10 + i,
    actualCost: 7,
    measuredRequests: 50,
    measuredBaselineCost: 5,
    measuredActualCost: 3.5,
    actualInputTokens: 20_000 + i,
  };
}
const hoy = new Date();
const dias = Array.from({ length: 40 }, (_, i) => {
  const d = new Date(hoy.getTime() - (45 - i) * 86_400_000);
  return d.toISOString().slice(0, 10);
});
const usage = dias.filter((_, i) => i % 7 !== 3).map(fila);

const conMensajes = (hijo: ReturnType<typeof createElement>) =>
  renderToString(createElement(NextIntlClientProvider, { locale: "en", messages: mensajes, timeZone: "UTC" }, hijo));

describe("los componentes de cliente del panel renderizan en servidor", () => {
  it("el explorador pinta controles, estadísticas, gráfico y procedencia", () => {
    const html = conMensajes(createElement(UsageExplorer, { usage, porModelo: [], periodoInicial: 30 }));
    expect(html).toContain("Export CSV");
    expect(html).toContain("Avoided calls");
    expect(html).toContain("<svg");
    expect(html).toContain("source: bvsala.usage_daily.baseline_cost − actual_cost");
    expect(html).toContain("drag across the chart");
    // Los huecos del calendario se marcan, no se inventan.
    expect(html).toContain("no traffic");
  });

  it("el explorador sin filas dice que no hay uso, sin gráfico", () => {
    const html = conMensajes(createElement(UsageExplorer, { usage: [], porModelo: [], periodoInicial: 120 }));
    expect(html).toContain("No usage in this period yet.");
    expect(html).not.toContain("<svg");
  });

  it("el panel editable renderiza las tarjetas en orden por defecto y el botón de personalizar", () => {
    const html = conMensajes(
      createElement(PanelEditable, {
        tarjetas: [
          { id: "a", titulo: "Primera", contenido: createElement("div", null, "CONTENIDO-A") },
          { id: "b", titulo: "Segunda", contenido: createElement("div", null, "CONTENIDO-B") },
        ],
      }),
    );
    expect(html.indexOf("CONTENIDO-A")).toBeLessThan(html.indexOf("CONTENIDO-B"));
    expect(html).toContain("Customize");
    expect(html).toContain("2 cards · 0 hidden");
    // En servidor nunca hay modo edición ni cabeceras de tarjeta.
    expect(html).not.toContain("pe-head");
  });
});
