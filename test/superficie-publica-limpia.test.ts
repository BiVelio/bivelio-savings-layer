import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * LO QUE SE PUBLICA EN NPM ES UNA SUPERFICIE PÚBLICA, Y HAY QUE TRATARLA COMO TAL.
 *
 * POR QUÉ EXISTE. `dist/index.d.ts` se publica SIN minificar y CON todos los
 * comentarios del código fuente: 2.203 líneas de las que ~900 son JSDoc. Nadie lo
 * había mirado nunca desde fuera, y llevaba publicado desde la 0.1.0:
 *
 *   · La confesión, en primera persona, de una fuga de datos entre usuarios del
 *     mismo tenant en la caché semántica. Sin acotar a ninguna versión. Leída por
 *     el equipo legal de un cliente regulado, eso no es documentación: es un
 *     incidente que hemos notificado nosotros.
 *   · Un post-mortem con dos decimales explicando que el sello `measured` —el
 *     argumento de venta— se estampó sobre cifras falsas.
 *   · Rutas del repositorio PRIVADO, una de ellas con número de línea.
 *
 * Nada de eso rompe un test, ni el build, ni el typecheck. Solo se ve abriendo el
 * paquete publicado, y eso no lo hace nadie. De ahí esta verja.
 *
 * ⚠️ npm es INMUTABLE: la 0.1.0 sigue descargable con ese texto dentro. Esto corta
 * la hemorragia hacia adelante, no borra el pasado.
 */

const DIST = fileURLToPath(new URL("../dist/index.d.ts", import.meta.url));

// El build corre ANTES que los tests en CI (`build:all` → `test`, ci.yml:51-55),
// así que aquí el fichero existe siempre. Si no existe, se falla en vez de
// saltarse la comprobación: un test que se salta solo en el sitio donde importa
// es peor que no tenerlo.
const hayDist = existsSync(DIST);
const d = hayDist ? readFileSync(DIST, "utf8") : "";
const lineas = d.split("\n");

describe("la superficie pública del paquete", () => {
  it("hay algo que revisar (el build tiene que haber corrido)", () => {
    expect(hayDist, `falta ${DIST}: ejecuta \`pnpm run build\` antes de los tests`).toBe(true);
    expect(lineas.length).toBeGreaterThan(500);
  });

  it("⛔ no menciona rutas del repositorio PRIVADO", () => {
    // Le describen a quien lee la estructura interna del código, y a un cliente
    // no le sirven de nada: no puede abrirlas.
    const malas = lineas
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => /\b(src|contracts|test)\/[\w/-]+\.ts\b|\b[\w-]+\.ts:\d+/.test(l));
    expect(malas.map(([n, l]) => `${n}: ${l.trim()}`)).toEqual([]);
  });

  it("⛔ no cuenta incidentes ni defectos pasados", () => {
    // Un `.d.ts` documenta el CONTRATO, no la historia del proyecto. Lo que se
    // arregló se cuenta en el commit y en el CHANGELOG, que es donde tiene
    // contexto y fecha; aquí queda descontextualizado y para siempre.
    const delatoras = [
      /\bfuga\b/i,
      /\bfaltaba\b/i,
      /\bpost-?mortem\b/i,
      /\bel (bug|fallo|defecto)\b/i,
      /\bse publicaba con\b/i,
      /\bmarcar como rota\b/i,
      /\bantes (solo|no) se\b/i,
      /\bwas missing\b/i,
      /\bused to (leak|be broken)\b/i,
      /\bthe bug\b/i,
    ];
    const malas = lineas
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => l.includes("*") && delatoras.some((r) => r.test(l)));
    expect(malas.map(([n, l]) => `${n}: ${l.trim()}`)).toEqual([]);
  });

  it("⛔ ningún nombre EXPORTADO está en español", () => {
    // Los comentarios internos son deuda; un identificador que el cliente tiene
    // que escribir en su código es la cara del producto.
    //
    // Los alias marcados `@deprecated` se permiten a propósito: existen para no
    // romperle el código a quien ya los usara, y llevan su fecha de caducidad
    // escrita al lado.
    const espanolas: string[] = [];
    lineas.forEach((l, i) => {
      const m = /^\s*(?:declare )?(?:export )?(?:declare )?(?:const|function|class|interface|type|let) ([A-Za-z_$][\w$]*)/.exec(l);
      if (!m) return;
      const nombre = m[1]!;
      // Un nombre "en español" se detecta por sus letras propias o por raíces que
      // no existen en inglés. No es perfecto; caza lo que se nos ha escapado.
      if (/[áéíóúñ]/i.test(nombre) || /(CION|cion|Codificador|Modelos|registrar|silenciar|avisos)/.test(nombre)) {
        const contexto = lineas.slice(Math.max(0, i - 6), i).join(" ");
        if (!contexto.includes("@deprecated")) espanolas.push(`${i + 1}: ${nombre}`);
      }
    });
    expect(espanolas).toEqual([]);
  });

  /**
   * LO QUE SE ANUNCIA NO PUEDE SER EL ÍNDICE DE LA RECETA.
   *
   * Las `keywords` de npm decían `prompt-compression, semantic-cache,
   * singleflight, adaptive-rag, filas, constrained-decoding`, y el README traía la
   * cascada en orden, los umbrales exactos (`≥64` tokens, `≥8%`) y las cifras
   * medidas de una comparación de formatos. Eso no le dice a un comprador QUÉ
   * hace el producto: le dice a un competidor CÓMO está hecho, gratis y en la
   * primera pantalla.
   *
   * Lo que se queda es la propuesta —hay etapas, se mide, se reporta por
   * petición— porque es lo que un comprador técnico necesita para creer que esto
   * no es un envoltorio. Lo que se va es el plano.
   */
  it("⛔ ni el README ni las keywords nombran las técnicas internas", () => {
    const raiz = fileURLToPath(new URL("../", import.meta.url));
    const readme = readFileSync(`${raiz}README.md`, "utf8");
    const pkg = readFileSync(`${raiz}package.json`, "utf8");
    // Nombres de técnica y de dependencias evaluadas. No son secretos de estado,
    // pero juntos son la lista de la compra de quien quiera reproducirlo.
    const delatores = [
      "compact-rows", "the compact encoder", "singleflight", "LLMLingua", "XGrammar", "llguidance",
      "adaptive-rag", "Adaptive-RAG", "prompt-compression", "semantic-cache",
      "constrained-decoding", "adaptive-k", "pgvector", "Qdrant",
    ];
    const encontrados: string[] = [];
    for (const d of delatores) {
      if (readme.includes(d)) encontrados.push(`README: ${d}`);
      if (pkg.includes(d)) encontrados.push(`package.json: ${d}`);

    }
    expect(encontrados).toEqual([]);
  });

  /**
   * EN LOS TIPOS PUBLICADOS, SOLO LO QUE NO SEA CONTRATO.
   *
   * Aquí no se puede usar la misma lista que en el README. `singleflight` es un
   * VALOR de `CacheOutcome` y `xgrammar`/`llguidance` son ids de
   * `ConstraintBackendId`: eso es API funcional, y sacarlo es una decisión de
   * producto —rompe a quien lea `report.cache.result`— no una limpieza.
   *
   * Lo que sí sobra sin discusión son los nombres de TERCEROS citados en prosa:
   * decirle al mundo qué dependencias evaluamos no le sirve de nada a un cliente
   * y le ahorra a un competidor la parte más lenta, que es elegir.
   */
  it("⛔ los tipos publicados no citan dependencias de terceros", () => {
    const tipos = readFileSync(fileURLToPath(new URL("../dist/index.d.ts", import.meta.url)), "utf8");
    const terceros = ["LLMLingua", "Qdrant", "pgvector", "RouteLLM", "GPTCache", "LiteLLM", "TOON", "toon"];
    const hallados = terceros.filter((t) => tipos.includes(t));
    expect(hallados).toEqual([]);
  });

  it("⛔ tampoco umbrales ni cifras medidas de comparación", () => {
    // Un umbral publicado es un parámetro que un competidor no tiene que buscar.
    const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
    expect(readme).not.toMatch(/≥\s*\d+%|≥\s*\d+\s*tokens/);
    expect(readme).not.toMatch(/json\s+\d{3,}/i);
  });

  it("no lleva secretos, y sí la clave PÚBLICA de verificación", () => {
    expect(d).not.toMatch(/sk_(live|test)_|rk_live_|whsec_|BEGIN (RSA |EC )?PRIVATE KEY/);
  });

  /**
   * TRINQUETE DEL ESPAÑOL EN LOS COMENTARIOS.
   *
   * Quedan ~91 líneas de JSDoc en español en los tipos publicados. NO es una
   * fuga —no revelan nada que el bundle no diga ya— pero son lo que ve el tooltip
   * del IDE de un cliente que instaló leyendo un README en inglés, y eso lee como
   * inmadurez antes de que nadie mire una línea de lógica.
   *
   * Traducirlas es un trabajo aparte y honesto de hacer despacio. Mientras tanto
   * esto impide que CREZCAN: cada vez que se traduzca un bloque, baja el número.
   * Un trinquete que solo puede apretarse.
   */
  it("el español en los comentarios no crece", () => {
    const TECHO = 91;
    const cuantas = lineas.filter((l) => /[áéíóúñ¿¡]/.test(l)).length;
    expect(
      cuantas,
      cuantas > TECHO
        ? `han aparecido ${cuantas - TECHO} líneas nuevas en español en los tipos PÚBLICOS`
        : `bien: bajaron a ${cuantas}. Baja TECHO a ${cuantas} en este fichero.`,
    ).toBeLessThanOrEqual(TECHO);
  });
});
