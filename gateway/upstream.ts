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
    error: `[bvsala gateway] invalid upstream "${valor}": use openai, anthropic or an http(s) origin URL`,
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
