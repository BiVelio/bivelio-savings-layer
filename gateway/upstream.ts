/**
 * `--upstream`: a qué proveedor habla ESTE gateway. Función pura, para que la
 * decisión se pruebe sin arrancar nada (bin.ts arranca cosas al importarse).
 *
 * Un gateway habla con UN upstream. Para medir un SDK de OpenAI (Python, Node…)
 * se arranca uno con `--upstream openai` en otro puerto; el de Anthropic sigue
 * siendo el de siempre.
 */

/** Los nombres cortos que acepta `--upstream`, con su origen. */
export const UPSTREAM_ALIASES: Readonly<Record<string, string>> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
};

/**
 * ¿Es `upstreamBase` el origen OFICIAL de un proveedor (uno de los alias de
 * arriba)? Parte G · solo entonces el contador que devuelve está en una factura
 * que se pueda enseñar: detrás de un mock local, de vLLM o LiteLLM sirviendo con
 * un nombre del catálogo, de Azure o de un revendedor con otras tarifas, el
 * precio de lista del catálogo no es lo que nadie pagó, y una gemela valorada
 * con él sería comisión sin factura detrás (la misma razón que la E0
 * `simulated-provider` del SDK). Se compara el ORIGEN normalizado: mayúsculas y
 * puerto por defecto no cambian nada, y una ruta pegada tampoco.
 */
export function esUpstreamOficial(upstreamBase: string): boolean {
  let origen: string;
  try {
    origen = new URL(upstreamBase).origin;
  } catch {
    return false;
  }
  return Object.values(UPSTREAM_ALIASES).includes(origen);
}

export type UpstreamResuelto =
  | {
      ok: true;
      /** El ORIGEN elegido, o undefined si nadie eligió (bin.ts sigue con su cadena de siempre). */
      upstream: string | undefined;
      origen: "flag" | "env" | "none";
      /** Una advertencia para imprimir al arrancar (una ruta que se ignora). */
      aviso?: string;
    }
  | { ok: false; error: string };

/**
 * El valor de `--upstream` en los argumentos de `gateway`. undefined: no está;
 * null: está sin valor. Acepta `--upstream openai` y `--upstream=openai`: la
 * segunda forma se ignoraba en silencio y el gateway arrancaba contra Anthropic.
 */
export function flagDeUpstream(args: readonly string[]): string | null | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--upstream") {
      const v = args[i + 1];
      return v !== undefined && !v.startsWith("--") ? v : null;
    }
    if (a.startsWith("--upstream=")) {
      const v = a.slice("--upstream=".length);
      return v.trim() !== "" ? v : null;
    }
  }
  return undefined;
}

/**
 * El valor tal como se puede ENSEÑAR en un error. Una credencial pegada en la
 * variable equivocada (BVSALA_GATEWAY_UPSTREAM=sk-…) no puede acabar en stderr
 * y de ahí en un log pegado en un issue: lo que tiene pinta de clave no se
 * repite, y lo demás se recorta.
 */
function mostrable(valor: string): string {
  const v = valor.trim();
  const pareceClave = /^(sk-|sk_|bvk_|rk_|pk_|key-)/i.test(v) || (v.length >= 32 && !/[\s:/.]/.test(v));
  if (pareceClave) return "(value hidden: it looks like a key)";
  return `"${v.length > 80 ? `${v.slice(0, 80)}…` : v}"`;
}

/**
 * @param flag undefined = no se pasó `--upstream`; null = se pasó sin valor.
 * @param env el valor de BVSALA_GATEWAY_UPSTREAM; el flag manda sobre ella.
 */
export function resolverUpstream(i: { flag?: string | null; env?: string }): UpstreamResuelto {
  if (i.flag === null) {
    return {
      ok: false,
      error: "[bvsala gateway] --upstream needs a value: openai, anthropic or an origin URL such as https://api.openai.com",
    };
  }
  let valor: string;
  let origen: "flag" | "env";
  if (i.flag !== undefined) {
    valor = i.flag;
    origen = "flag";
  } else if (i.env !== undefined && i.env.trim() !== "") {
    valor = i.env;
    origen = "env";
  } else {
    return { ok: true, upstream: undefined, origen: "none" };
  }

  const alias = UPSTREAM_ALIASES[valor.trim().toLowerCase()];
  if (alias !== undefined) return { ok: true, upstream: alias, origen };

  const invalido = {
    ok: false as const,
    error: `[bvsala gateway] invalid upstream ${mostrable(valor)}: use openai, anthropic or an http(s) origin URL`,
  };
  let url: URL;
  try {
    url = new URL(valor.trim());
  } catch {
    return invalido;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return invalido;

  // Siempre el ORIGEN: el servidor resuelve la ruta que manda el cliente contra
  // él, así que un prefijo aquí se perdería en silencio. No se rechaza porque
  // `BVSALA_GATEWAY_UPSTREAM=https://api.openai.com/v1` funcionaba (se descartaba
  // la ruta sin decirlo): ahora se dice.
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return {
      ok: true,
      upstream: url.origin,
      origen,
      aviso:
        `[bvsala gateway] WARNING: the upstream path "${url.pathname}" is ignored: requests keep the path the client ` +
        "sends (for example /v1/chat/completions), so put that prefix in the client's base URL instead.",
    };
  }
  return { ok: true, upstream: url.origin, origen };
}
