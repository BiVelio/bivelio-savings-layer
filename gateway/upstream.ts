/**
 * `--upstream`: a qué proveedor habla ESTE gateway. Función pura, para que la
 * decisión se pruebe sin arrancar nada (bin.ts arranca cosas al importarse).
 *
 * Un gateway habla con UN upstream. Para medir un SDK de OpenAI (Python, Node…)
 * se arranca uno con `--upstream openai` en otro puerto; el de Anthropic sigue
 * siendo el de siempre. Además de los dos grandes hay alias para Gemini, los
 * proveedores chinos (DeepSeek, Qwen, GLM, Moonshot, MiniMax), el enrutador
 * OpenRouter y los servidores locales (Ollama, vLLM, LM Studio): cualquiera
 * que hable OpenAI-compatible o (DeepSeek) Anthropic-compatible se mide.
 */

/** Los nombres cortos que acepta `--upstream`, con su origen. */
export const UPSTREAM_ALIASES: Readonly<Record<string, string>> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  deepseek: "https://api.deepseek.com",
  qwen: "https://dashscope.aliyuncs.com",
  glm: "https://open.bigmodel.cn",
  moonshot: "https://api.moonshot.cn",
  minimax: "https://api.minimaxi.com",
  openrouter: "https://openrouter.ai",
  ollama: "http://localhost:11434",
  vllm: "http://localhost:8000",
  lmstudio: "http://localhost:1234",
};

/**
 * Los orígenes OFICIALES de proveedor: solo allí el contador que devuelve el
 * upstream está en una factura a precio de lista (la regla G de la gemela).
 * Los servidores locales (Ollama, vLLM, LM Studio) y los revendedores
 * (OpenRouter, LiteLLM) NO entran: detrás de ellos el precio de lista del
 * catálogo no es lo que nadie pagó, y una gemela valorada con él sería una
 * comisión sin factura detrás.
 */
const ORIGENES_OFICIALES: ReadonlySet<string> = new Set([
  "https://api.openai.com",
  "https://api.anthropic.com",
  "https://generativelanguage.googleapis.com",
  "https://api.deepseek.com",
  "https://dashscope.aliyuncs.com",
  "https://open.bigmodel.cn",
  "https://api.moonshot.cn",
  "https://api.minimaxi.com",
]);

/**
 * ¿Es `upstreamBase` el origen OFICIAL de un proveedor (uno de los alias de
 * arriba, con factura a precio de lista)? Se compara el ORIGEN normalizado:
 * mayúsculas y puerto por defecto no cambian nada, y una ruta pegada tampoco.
 */
export function esUpstreamOficial(upstreamBase: string): boolean {
  let origen: string;
  try {
    origen = new URL(upstreamBase).origin;
  } catch {
    return false;
  }
  return ORIGENES_OFICIALES.has(origen);
}

/** El alias que resuelve a este origen, si lo hay. */
export function aliasDelOrigen(origen: string): string | undefined {
  const o = (() => {
    try {
      return new URL(origen).origin;
    } catch {
      return origen;
    }
  })();
  for (const [alias, valor] of Object.entries(UPSTREAM_ALIASES)) {
    if (valor === o) return alias;
  }
  return undefined;
}

/**
 * La ruta que el upstream espera para el camino que mandó el cliente. Solo
 * DeepSeek la reescribe: su endpoint compatible con Anthropic vive bajo
 * `/anthropic` (https://api.deepseek.com/anthropic/v1/messages), así que un
 * Claude Code apuntando al gateway con `--upstream deepseek` habla con
 * DeepSeek sin tocar su configuración.
 */
export function rutaReescrita(origen: string, pathname: string): string {
  if (aliasDelOrigen(origen) === "deepseek" && pathname.startsWith("/v1/messages")) {
    return `/anthropic${pathname}`;
  }
  return pathname;
}

/**
 * La URL a la que viaja una petición: el ORIGEN es siempre el del upstream y
 * del cliente solo se toman la ruta y la query. Función pura.
 *
 * `new URL(req.url, upstreamBase)` a secas no vale: `//otro-host/ruta` es una
 * URL relativa al esquema y `/\\otro-host` también (WHATWG trata `\\` como
 * `/`), así que la petición salía hacia `otro-host` con la credencial del
 * cliente. Aquí:
 *   · las barras iniciales repetidas se colapsan en una (`//v1/messages` es lo
 *     que manda un cliente cuyo base URL acaba en `/`: debe funcionar);
 *   · la forma absoluta (`http://host/ruta`, la de un proxy HTTP) se reduce a
 *     su ruta: la autoridad que traiga se ignora;
 *   · y, como red final, si el origen resuelto no es el del upstream → null
 *     (el servidor responde 400 y no reenvía nada).
 */
export function urlHaciaElUpstream(objetivo: string | undefined, upstreamBase: string): URL | null {
  let base: URL;
  try {
    base = new URL(upstreamBase);
  } catch {
    return null;
  }
  let ruta = objetivo ?? "/";
  if (/^https?:\/\//i.test(ruta)) {
    try {
      const absoluta = new URL(ruta);
      ruta = `${absoluta.pathname}${absoluta.search}`;
    } catch {
      return null;
    }
  }
  if (!/^[/\\]/.test(ruta)) return null;
  ruta = ruta.replace(/^[/\\]+/, "/");
  let url: URL;
  try {
    url = new URL(ruta, base);
  } catch {
    return null;
  }
  return url.origin === base.origin ? url : null;
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
      error: "[bvsala gateway] --upstream needs a value: an alias (openai, anthropic, gemini, deepseek, qwen, glm…) or an origin URL such as https://api.openai.com",
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
    error: `[bvsala gateway] invalid upstream ${mostrable(valor)}: use an alias (openai, anthropic, gemini, deepseek…) or an http(s) origin URL`,
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
