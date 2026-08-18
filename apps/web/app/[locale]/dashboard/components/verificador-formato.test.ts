import { describe, it, expect } from "vitest";

import { CARGA_DE_EJEMPLO, FORMATOS_MOSTRADOS } from "./formatos-verificador.js";

/**
 * El verificador del panel muestra el ahorro REAL del SDK sobre su carga de
 * ejemplo — no un 0 fantasma.
 *
 * POR QUÉ ESTE TEST EXISTE. La barra del verificador filtra los candidatos por
 * `FORMATOS_MOSTRADOS`. Cuando el formato tabular del SDK se renombró de `toon` a
 * `compact-rows` (#62) y esta lista se quedó con `toon`, el recuento del formato
 * que el SDK REALMENTE elige se caía, la fila «BV-SALA» retrocedía al baseline y
 * la página `/dashboard/verify` —la que un cliente recién pagado usa para
 * comprobar que el producto hace algo— anunciaba «recorta 0 tokens» mientras el
 * SDK recortaba a la mitad. Ningún test lo cazaba. Este corre el bundle REAL
 * (`public/vendor/bv-sala.js`, el mismo que carga la landing) sobre la misma
 * carga de ejemplo y exige que el formato elegido esté en la lista y que el
 * recorte anunciado sea positivo.
 */

type Selector = {
  choose: (p: unknown, o: { model: string }) => { chosen: string; candidateTokens: Record<string, number> };
};
type SdkModule = { FormatSelector: new (o: { tokenizer: unknown }) => Selector; defaultTokenizerRegistry: unknown };

const bundleUrl = new URL("../../../../public/vendor/bv-sala.js", import.meta.url).href;

describe("verificador del panel — el formato elegido por el SDK está en la barra", () => {
  it("el bundle real elige un formato que FORMATOS_MOSTRADOS incluye, y el recorte es > 0", async () => {
    const m = (await import(/* @vite-ignore */ bundleUrl)) as SdkModule;
    const selector = new m.FormatSelector({ tokenizer: m.defaultTokenizerRegistry });
    const choice = selector.choose(JSON.parse(CARGA_DE_EJEMPLO), { model: "openai/gpt-4o-mini" });

    // La regresión que reintroduciría el bug: si `chosen` (p. ej. "compact-rows")
    // no está en la lista, su recuento se cae y la UI pinta «recorta 0».
    expect(FORMATOS_MOSTRADOS as readonly string[]).toContain(choice.chosen);

    // Y sobre esta carga el SDK SÍ recorta: el formato elegido tiene menos tokens
    // que el baseline json-compact, así que la barra muestra un ahorro real.
    const baseline = choice.candidateTokens["json-compact"];
    const elegido = choice.candidateTokens[choice.chosen];
    expect(baseline, "el bundle debe exponer el candidato json-compact").toBeTypeOf("number");
    expect(elegido, "el candidato elegido debe estar en candidateTokens").toBeTypeOf("number");
    expect(elegido!).toBeLessThan(baseline!);
  });
});
