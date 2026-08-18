import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * `.vercelignore` tiene que cubrir TODO patrón de secreto de `.gitignore`.
 *
 * POR QUÉ ESTE TEST EXISTE. `vercel deploy` NO aplica las reglas de `.gitignore`
 * —el CLI solo lee `.vercelignore` (más una lista fija) y a `.gitignore` lo trata
 * como un fichero a excluir, no como reglas—. Comprobado en la práctica: `.claude/`
 * llevaba en `.gitignore` desde el primer commit y aun así el CLI intentó subir sus
 * 15 GB (#88). Desde que existe `.vercelignore`, ese fichero es el ÚNICO filtro del
 * upload, y nació re-listando los patrones de `.gitignore` A MANO — con una omisión:
 * `keys/`, el directorio de la clave PRIVADA Ed25519 que firma todas las licencias.
 * Un deploy desde la raíz la subía al almacén de deployments de Vercel, anulando el
 * fail-closed entero. Nada ataba las dos listas; esto lo hace.
 *
 * La invariante: para cada fichero que `.gitignore` considera secreto y por tanto
 * ignora, `.vercelignore` DEBE ignorarlo también. Y el control simétrico: los
 * `.example` (que SÍ se versionan y documentan los nombres de las variables) no los
 * ignora ninguno de los dos — si este test los diera por ignorados, su matcher de
 * negaciones estaría roto y la invariante no probaría nada.
 */

const raiz = new URL("../", import.meta.url);
const gitignore = readFileSync(new URL(".gitignore", raiz), "utf8");
const vercelignore = readFileSync(new URL(".vercelignore", raiz), "utf8");

/** Un patrón de `.gitignore` cuenta como secreto si nombra una clave, un `.env`
 *  (salvo los `.example`) o una credencial. Deliberadamente estricto: no queremos
 *  exigir que artefactos regenerables (dist, coverage) estén en ambas listas. */
function esSecreto(patron: string): boolean {
  if (/\.example$/.test(patron)) return false;
  return /(\.key\.pem|\.private\.pem|(^|\/)\.env|secret|token|credential)/i.test(patron);
}

/** Reglas gitignore-style no vacías y no comentadas, en orden (el orden importa:
 *  una `!negación` posterior reincluye). */
function reglas(texto: string): string[] {
  return texto
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

/** ¿`patron` (gitignore-style) casa la ruta `ruta` (relativa a la raíz del repo)? */
function casa(patron: string, ruta: string): boolean {
  let p = patron.startsWith("/") ? patron.slice(1) : patron;
  const partes = ruta.split("/");
  const base = partes[partes.length - 1]!;
  if (p.endsWith("/")) {
    // Directorio: casa el propio dir o cualquier cosa debajo, a cualquier nivel.
    const dir = p.slice(0, -1);
    return ruta === dir || ruta.startsWith(p) || partes.slice(0, -1).includes(dir);
  }
  const aRegex = (s: string) =>
    new RegExp(
      "^" +
        s
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, "[^/]*") +
        "$",
    );
  // Sin barra: casa por nombre de fichero en cualquier directorio (semántica gitignore).
  return p.includes("/") ? aRegex(p).test(ruta) : aRegex(p).test(base);
}

/** Aplica una lista de reglas a una ruta y devuelve si queda ignorada (la última
 *  regla que casa gana; `!` reincluye). */
function ignora(texto: string, ruta: string): boolean {
  let decidido = false;
  for (const regla of reglas(texto)) {
    const negacion = regla.startsWith("!");
    const patron = negacion ? regla.slice(1) : regla;
    if (casa(patron, ruta)) decidido = !negacion;
  }
  return decidido;
}

/** Un ejemplo concreto de fichero que casaría un patrón, para poder preguntarle a
 *  `.vercelignore` si también lo ignora. `keys/*.key.pem` -> `keys/x.key.pem`. */
function ejemploDe(patron: string): string {
  const p = patron.startsWith("/") ? patron.slice(1) : patron;
  if (p.endsWith("/")) return `${p}x`;
  return p.replace(/\*/g, "x");
}

describe(".vercelignore cubre los secretos de .gitignore", () => {
  const secretos = reglas(gitignore).filter((r) => !r.startsWith("!") && esSecreto(r));

  it("hay patrones de secreto en .gitignore que comprobar (el test no es vacuo)", () => {
    expect(secretos.length).toBeGreaterThan(0);
  });

  it.each(secretos)("un fichero que .gitignore ignora por %s, .vercelignore también lo ignora", (patron) => {
    const ejemplo = ejemploDe(patron);
    // Sanidad: el ejemplo derivado del patrón sí lo ignora .gitignore.
    expect(ignora(gitignore, ejemplo), `${ejemplo} debería estar ignorado por .gitignore`).toBe(true);
    // La invariante: y .vercelignore también.
    expect(ignora(vercelignore, ejemplo), `${ejemplo} NO está cubierto por .vercelignore`).toBe(true);
  });

  it("la clave privada de firma nunca sube al deploy", () => {
    expect(ignora(vercelignore, "keys/license.key.pem")).toBe(true);
    expect(ignora(vercelignore, "keys/license.private.pem")).toBe(true);
  });

  it("los .env locales tampoco", () => {
    for (const f of [".env", ".env.local", ".env.production", ".env.bench"]) {
      expect(ignora(vercelignore, f), `${f} debería estar ignorado`).toBe(true);
    }
  });

  it("control: los .example SÍ se versionan (no los ignora ninguno de los dos)", () => {
    // Si esto fallara, el matcher de negaciones estaría roto y la invariante de
    // arriba no probaría nada.
    expect(ignora(gitignore, ".env.example")).toBe(false);
    expect(ignora(vercelignore, ".env.example")).toBe(false);
  });
});
