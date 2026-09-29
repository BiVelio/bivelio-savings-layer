/**
 * LOS INFORMES SE SIRVEN DESDE LA WEB (decisión del dueño, 2026-09-29).
 *
 * El repositorio sigue privado, así que /benchmarks no enlaza a GitHub: cada
 * informe `docs/benchmarks/<fecha>/<fichero>.json` se publica en
 * `/benchmarks/data/<fecha>/<fichero>.json` (app/benchmarks/data/…/route.ts,
 * prerenderizado al construir). Lo servido es el informe entero, con una sola
 * diferencia: se le quitan los datos del ENTORNO de quien midió.
 *
 *   - claves y tokens con forma de secreto (no debería haber ninguno: si
 *     aparece, se sustituye y el test lo señala en el origen);
 *   - rutas absolutas de disco (/Users/…, /home/…, /private/…, C:\Users\…) y
 *     nombres de worktree (bsl-…, .claude/worktrees/…);
 *   - correos, salvo los de dominios de ejemplo (los prompts de BFCL traen
 *     `john.doe@example.com`: son datos del dataset público) y el de contacto.
 *
 * Y una regla de contenido: de XSTest no se sirve texto de respuestas ni de
 * prompts (los informes solo guardan la clase y la longitud; si algún día un
 * arnés los escribiera, aquí se caen).
 *
 * Todo esto es puro (sin disco): lo usan la ruta y los tests.
 */

/** Prefijo público de los informes servidos. */
export const PREFIJO_DATOS = "/benchmarks/data";

const RUTA_INFORME = /^docs\/benchmarks\/(\d{4}-\d{2}-\d{2})\/([a-z0-9][a-z0-9.-]*\.json)$/;
export const FECHA_VALIDA = /^\d{4}-\d{2}-\d{2}$/;
export const FICHERO_VALIDO = /^[a-z0-9][a-z0-9.-]*\.json$/;

/** `docs/benchmarks/2026-09-28/gsm8k.json` → `/benchmarks/data/2026-09-28/gsm8k.json`. */
export function rutaServida(ruta: string): string {
  const m = RUTA_INFORME.exec(ruta);
  if (!m) throw new Error(`banco público: ruta de informe inesperada: ${ruta}`);
  return `${PREFIJO_DATOS}/${m[1]}/${m[2]}`;
}

export function partesDeRuta(ruta: string): { fecha: string; fichero: string } | null {
  const m = RUTA_INFORME.exec(ruta);
  return m ? { fecha: m[1]!, fichero: m[2]! } : null;
}

// ---------------------------------------------------------------------------
// detectores

/** Formas de secreto conocidas. Solo se usan para detectar y tachar, nunca para imprimir. */
const CLAVES: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{16,}/g,
  /\b(?:rk|sk|pk|whsec)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b(?:x-api-key|api[_-]?key|authorization)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{16,}/gi,
];

/** Rutas absolutas de disco (no las relativas al repo, ni `/user/home/…` de los prompts de BFCL). */
const RUTAS_LOCALES: RegExp[] = [
  /(?<![\w./~-])(?:\/Users|\/home|\/private|\/var\/folders|\/Volumes|\/tmp|\/root|\/mnt|\/opt\/homebrew)\/[^\s"'`<>)\]},;]*/g,
  /(?<![\w])[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\s"'`<>)\]},;]*/g,
  /~\/[^\s"'`<>)\]},;]+/g,
];

const WORKTREES: RegExp[] = [/\.claude\/worktrees\/[^\s"'`<>)\]},;]*/g, /(?<![\w-])bsl-[a-z0-9][a-z0-9-]*/g];

const CORREO = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
/** Dominios reservados para ejemplos (RFC 2606) y el contacto público. */
const CORREO_PERMITIDO = (correo: string, dominio: string) =>
  /^(?:.+\.)?example\.(?:com|org|net)$/i.test(dominio) || correo.toLowerCase() === "support@bivelio.com";

export interface Hallazgos {
  claves: number;
  rutasLocales: number;
  worktrees: number;
  correos: number;
}

const vacio = (): Hallazgos => ({ claves: 0, rutasLocales: 0, worktrees: 0, correos: 0 });

/** Cuenta lo sensible de un texto (el test lo pasa por la copia servida entera). */
export function contarSensibles(texto: string): Hallazgos {
  const h = vacio();
  for (const r of CLAVES) h.claves += (texto.match(r) ?? []).length;
  for (const r of RUTAS_LOCALES) h.rutasLocales += (texto.match(r) ?? []).length;
  for (const r of WORKTREES) h.worktrees += (texto.match(r) ?? []).length;
  for (const m of texto.matchAll(CORREO)) if (!CORREO_PERMITIDO(m[0], m[1]!)) h.correos++;
  return h;
}

function limpiarTexto(s: string, h: Hallazgos): string {
  let out = s;
  for (const r of CLAVES)
    out = out.replace(r, () => {
      h.claves++;
      return "[clave retirada]";
    });
  for (const r of RUTAS_LOCALES)
    out = out.replace(r, () => {
      h.rutasLocales++;
      return "[ruta local]";
    });
  for (const r of WORKTREES)
    out = out.replace(r, () => {
      h.worktrees++;
      return "[worktree]";
    });
  out = out.replace(CORREO, (m, dominio: string) => {
    if (CORREO_PERMITIDO(m, dominio)) return m;
    h.correos++;
    return "[correo retirado]";
  });
  return out;
}

/** Campos de texto libre que no se sirven de XSTest (respuestas y prompts inseguros). */
const TEXTO_XSTEST = /^(?:texto|text|respuesta|respuestas|response|responses|output|salida|contenido|content|completion|prompt|pregunta|extracto)(?:[A-Z_].*)?$/;

export function esXSTest(json: unknown): boolean {
  const d = (json as { dataset?: { fuente?: unknown; repo?: unknown; nombre?: unknown } } | null)?.dataset;
  return /exaggerated-safety|xstest/i.test(`${d?.fuente ?? ""} ${d?.repo ?? ""} ${d?.nombre ?? ""}`);
}

export interface InformeLimpio {
  json: unknown;
  hallazgos: Hallazgos;
  /** Campos de texto de XSTest retirados. */
  textosXSTest: number;
}

/** La copia que se sirve: el mismo informe sin datos del entorno ni texto de XSTest. */
export function limpiarInforme(json: unknown): InformeLimpio {
  const h = vacio();
  const xs = esXSTest(json);
  let textosXSTest = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return limpiarTexto(v, h);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (xs && typeof x === "string" && TEXTO_XSTEST.test(k)) {
          textosXSTest++;
          continue;
        }
        out[limpiarTexto(k, h)] = walk(x);
      }
      return out;
    }
    return v;
  };
  return { json: walk(json), hallazgos: h, textosXSTest };
}
