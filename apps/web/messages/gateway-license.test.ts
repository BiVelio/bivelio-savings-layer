import { readdirSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

/**
 * La copia del panel sobre la pasarela no promete lo que el servidor ya no da.
 *
 * Desde que la org sin licencia ni suscripción recibe 402 en la ingesta (no hay
 * free tier), «bvsala claude» no mide nada a quien no ha pagado. El verificador
 * del panel —lo que se puede comprobar ANTES de pagar— se lo ofrecía a quien
 * solo usa suscripción de chat, así que `onlyChatBody` deja de ofrecerlo en los
 * 12 idiomas. Es cierto con cualquier versión del paquete, por eso va con el
 * cambio de servidor y no espera a la publicación npm.
 *
 * El resto de textos de la pasarela (gatewayNote, landing.gateway.note,
 * caseCodeBody, cxNota, step2) cambia cuando la versión que verja por licencia
 * esté publicada, y sus comprobaciones se añaden aquí entonces.
 */

const DIR = new URL(".", import.meta.url).pathname;

type Plano = Record<string, string>;

function aplanar(o: unknown, p = ""): Plano {
  if (o !== null && typeof o === "object") {
    return Object.entries(o as Record<string, unknown>).reduce<Plano>(
      (acc, [k, v]) => Object.assign(acc, aplanar(v, p ? `${p}.${k}` : k)),
      {},
    );
  }
  return { [p]: String(o) };
}

const cargar = (loc: string): Plano =>
  aplanar(JSON.parse(readFileSync(`${DIR}${loc}.json`, "utf8")));

const LOCALES = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -5));

const ONLY_CHAT = "dashboard.projectorVerifier.onlyChatBody";

describe("copia de la pasarela: sin free tier", () => {
  const en = cargar("en");

  it("onlyChatBody no ofrece «bvsala claude» en ningún idioma", () => {
    for (const loc of LOCALES) {
      expect(cargar(loc)[ONLY_CHAT], loc).not.toContain("bvsala claude");
    }
  });

  it("onlyChatBody está traducido: cada idioma distinto de en tiene su propio texto", () => {
    for (const loc of LOCALES.filter((l) => l !== "en")) {
      expect(cargar(loc)[ONLY_CHAT], loc).not.toBe(en[ONLY_CHAT]);
    }
  });
});
