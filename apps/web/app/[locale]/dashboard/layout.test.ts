import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * La cáscara del panel tiene que VOLVER A LA URL PEDIDA cuando no hay sesión.
 *
 * #277 lo arregló (la guardia leía la cabecera del middleware) y #307 lo perdió
 * al reescribir la cáscara con `next=/dashboard` fijo, sin que ningún test lo
 * cazara: `destino.test.ts` prueba la función, no que el layout la use. Un
 * Server Component con `headers()` y `redirect()` no se monta en vitest sin
 * arrastrar Next entero, así que este test lee el fuente — es la misma clase
 * de verja que `luz-verde` usa sobre `VerdictHero.tsx`, y basta para que la
 * regresión no vuelva en silencio.
 */
const fuente = readFileSync(join(__dirname, "layout.tsx"), "utf8");

describe("dashboard/layout.tsx — sin sesión, vuelve a la URL pedida", () => {
  it("lee el destino de la cabecera del middleware", () => {
    expect(fuente).toMatch(/destinoDeLaPeticion\(await headers\(\)\)/);
    expect(fuente).toMatch(/from "next\/headers"/);
  });
  it("no vuelve a fijar /dashboard a secas", () => {
    expect(fuente).not.toMatch(/next=\/dashboard["'`]/);
    expect(fuente).toMatch(/encodeURIComponent\(destino\)/);
  });
});
