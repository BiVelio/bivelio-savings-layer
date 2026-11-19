import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A2-27, LA PARTE QUE NO ERA `bvsala init`. El fragmento de `init` quedó con las
 * tres líneas de la nube activas, pero los otros sitios de donde copia quien
 * paga seguían desenchufados:
 *
 *   · el README y docs/guias/medir.md llevaban `serviceAccountKey` ACTIVA y
 *     `licenseServerUrl` COMENTADA: con la clave de servicio exportada la capa
 *     avisaba por consola y no mandaba nada al panel;
 *   · el fragmento del panel (WRAP) llevaba las tres comentadas;
 *   · la nota final del panel decía «sin licencia válida → generate() se
 *     rechaza», que sin clave es falso: la capa corre en modo comunitario.
 *
 * Sin claves, `licenseServerUrl` sola no abre ninguna conexión
 * (test/init-fragmento-red.test.ts lo comprueba ejecutando el fichero).
 */
const RAIZ = join(__dirname, "..");
const leer = (ruta: string) => readFileSync(join(RAIZ, ruta), "utf8");

/** Los bloques de código de un Markdown. */
function bloques(md: string): string[] {
  return [...md.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

describe("los fragmentos públicos con clave de servicio también llevan `licenseServerUrl`", () => {
  for (const ruta of ["README.md", "docs/guias/medir.md"]) {
    it(`${ruta}: ningún bloque activa serviceAccountKey sin licenseServerUrl`, () => {
      const conClave = bloques(leer(ruta)).filter((b) => /^\s*serviceAccountKey:/m.test(b));
      expect(conClave.length).toBeGreaterThan(0);
      for (const b of conClave) expect(b).toMatch(/^\s*licenseServerUrl: "https:\/\/savings\.bivelio\.com",$/m);
    });
  }

  it("el fragmento del panel lleva las tres líneas activas y leídas del entorno", () => {
    const src = leer("apps/web/app/[locale]/dashboard/components/InstallLicensePanel.tsx");
    const wrap = /const WRAP = `([\s\S]*?)`;/.exec(src)?.[1] ?? "";
    expect(wrap).toMatch(/^\s*licenseKey: process\.env\.BIVELIO_LICENSE_KEY \|\| undefined,/m);
    expect(wrap).toMatch(/^\s*serviceAccountKey: process\.env\.BIVELIO_SERVICE_KEY \|\| undefined,/m);
    expect(wrap).toMatch(/^\s*licenseServerUrl: "https:\/\/savings\.bivelio\.com",/m);
  });

  it("la nota final del panel no dice que sin licencia la capa se niega, en ningún idioma", () => {
    const dir = join(RAIZ, "apps", "web", "messages");
    const idiomas = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(idiomas.length).toBe(12);
    const viejas = /No valid license|Sin licencia válida|Sense llicència vàlida|Pas de licence valide|Keine gültige Lizenz|Brak ważnej licencji|Geen geldige licentie|Tanpa lisensi valid|Nessuna licenza valida|Không có giấy phép hợp lệ|Sem licença válida|Geçerli lisans yoksa/;
    for (const f of idiomas) {
      const notas = [...readFileSync(join(dir, f), "utf8").matchAll(/"finalNote": "([^"]*)"/g)].map((m) => m[1]!);
      expect(notas.length, f).toBeGreaterThan(0);
      for (const n of notas) expect(n, f).not.toMatch(viejas);
    }
  });
});
