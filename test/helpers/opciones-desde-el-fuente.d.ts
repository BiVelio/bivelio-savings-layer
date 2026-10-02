// LAS OPCIONES DE LICENCIA QUE LA 0.5 SACÓ DEL TIPO PÚBLICO, VISTAS DESDE EL FUENTE.
//
// `licenseGate`, `licensePublicKey` y `devUnlicensed` ya no están en
// `SavingsLayerConfig` (docs/MIGRAR-A-0.5.md §6): para el cliente del paquete
// publicado son un error de tipos. Pero los tests, el banco y los ejemplos de
// licencia de este repo corren DESDE EL FUENTE, donde el pipeline todavía los
// lee (ConfiguracionDesdeElFuente, en src/pipeline/config.ts), y montan con
// ellos sus escenarios. Esta ampliación se los devuelve al tipo SOLO dentro del
// programa de `tsc` del repo: no está bajo src/, así que no llega al `.d.ts`
// publicado, y test/api-publica-congelada.test.ts lo comprueba contra `dist`.
import type { LicenseGate } from "../../src/contracts/types.js";
import type { LicenseKeyset } from "../../src/license/verify.js";

declare module "../../src/pipeline/config.js" {
  interface SavingsLayerConfig {
    licenseGate?: LicenseGate;
    licensePublicKey?: string | LicenseKeyset;
    devUnlicensed?: boolean;
  }
}
