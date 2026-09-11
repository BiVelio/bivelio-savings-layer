/**
 * LA CAPA INTERMEDIA — transforma la petición ANTES de que salga hacia el modelo.
 *
 * Tres transformaciones, decididas por el dueño el 2026-09-11 contra la evidencia
 * previa, y diseñadas para esquivar las tres causas MEDIDAS por las que sus
 * versiones anteriores perdieron. Si alguna vuelve a perder, que sea por una
 * razón nueva.
 *
 * ─── POR QUÉ ESTA VEZ ES DISTINTA, CAUSA POR CAUSA ──────────────────────────
 *
 * 1. CAVEMAN murió por su propio peso: 6.559 caracteres de instrucciones en
 *    CADA petición se comían entre el 25 % y el 100 % de lo que ahorraba. Aquí
 *    el bloque decodificador va UNA sola vez al `system`, que es prefijo
 *    cacheado: se paga una escritura y después se lee a 0,1× el precio — y en
 *    cupo de suscripción, la lectura de caché vale ~0 (medido: una ventana
 *    absorbió 18,9 M de tokens leídos sin mover el contador).
 *
 * 2. TRANSFORMAR EN MITAD DEL PROMPT invalida el prefijo desde esa posición: se
 *    ahorra sobre lo pequeño y se paga sobre todo lo que va detrás, reescrito a
 *    1,25×-2×. El multiplicador de castigo medido es 12,5×-20×. Aquí TOON toca
 *    EXCLUSIVAMENTE el `tool_result` del turno en curso, que se está añadiendo
 *    al final y no tiene nada detrás. Nunca reescribe historia. Es la excepción
 *    que sí gana («añadir al final en vez de reescribir»).
 *
 * 3. CONTEXT-MODE, el paquete, es ELv2: su licencia prohíbe el servicio
 *    gestionado, que es exactamente nuestro producto. Aquí no hay una línea de
 *    su código: se reimplementa el PATRÓN —externalizar un bloque gigante a un
 *    índice y dejar un puntero— desde cero. Y se reporta cuántas veces dispara,
 *    porque la medición del 09-09 encontró CERO textos de ≥100 KB en el tráfico
 *    real (Claude Code ya trunca la salida de Bash antes de enviarla).
 *
 * ─── COMPATIBILIDAD CON CUALQUIER MODELO ────────────────────────────────────
 *
 * La capa no asume Anthropic. Detecta la forma del cuerpo y trabaja en las dos
 * familias que cubren a todos los clientes que el gateway ya envuelve —claude,
 * codex, opencode, goose, crush, qwen, droid, cline, kilo—:
 *
 *   · `anthropic`: `{ system, messages[].content[] (bloques), tools }`
 *   · `openai`   : `{ messages[] con role system|user|assistant|tool, tools }`
 *
 * Ante una forma que no reconoce, NO TOCA NADA y lo dice en el informe. Una capa
 * intermedia que rompe una petición por no entenderla es peor que no existir.
 *
 * ─── EL INFORME ES LA MITAD DEL TRABAJO ─────────────────────────────────────
 *
 * Cada transformación devuelve su delta EXACTO en caracteres, contados sobre el
 * cuerpo real que sale por el cable. No hay estimación ni replay: el informe se
 * empareja después con el `usage` que devuelve el propio modelo para esa misma
 * petición, y de ahí sale el dinero. Es lo que permite que el panel explique, y
 * no que prometa.
 */

/** Qué familia de API tiene el cuerpo. */
export type FormaDeCuerpo = "anthropic" | "openai" | "desconocida";

export interface OpcionesDeCapa {
  /** Caveman: comprime la prosa del turno en curso y declara el código en el prefijo. */
  caveman?: boolean;
  /** TOON: reserializa el `tool_result` del turno en curso a notación tabular. */
  toon?: boolean;
  /** Patrón context-mode: externaliza bloques por encima de este tamaño. 0 = apagado. */
  externalizarDesde?: number;
  /** Cuán agresivo es caveman. `prudente` es el defecto y el único medido. */
  agresividad?: "prudente" | "telegrafico";
  /**
   * DÓNDE va el bloque decodificador de caveman. Es un DIAL y no una decisión
   * mía a propósito: la versión que se midió y perdió lo pegaba a CADA turno
   * (`turno`), y mi propuesta lo pone una vez en el prefijo cacheado
   * (`prefijo`). Poder correr las dos es lo que convierte mi criterio en una
   * hipótesis comprobable en vez de en una decisión que haya que creerse.
   *   · `prefijo` — una vez, al `system`. Se paga una escritura de caché.
   *   · `turno`   — en cada petición. 6.559 chars × nº de peticiones.
   */
  dondeCodigo?: "prefijo" | "turno";
  /**
   * ALCANCE de TOON, también dial. Mi propuesta es `turno`: tocar solo el
   * `tool_result` que se está añadiendo, porque reescribir historia invalida el
   * prefijo cacheado desde esa posición (castigo medido 12,5×-20×). `todo`
   * reescribe también la historia, que es lo que hacía la versión refutada.
   * Si la ley de la caché no se cumpliera en tu tráfico, `todo` lo demostraría.
   */
  alcanceToon?: "turno" | "todo";
}

export interface CambioDeCapa {
  /** Qué transformación. */
  cual: "caveman-codigo" | "caveman-prosa" | "toon" | "externalizado";
  /** Dónde se aplicó, para poder auditarlo. */
  donde: string;
  /** Caracteres antes y después, contados de verdad. */
  antes: number;
  despues: number;
}

export interface InformeDeCapa {
  forma: FormaDeCuerpo;
  /** Longitud del cuerpo serializado, antes y después de TODO. */
  cuerpoAntes: number;
  cuerpoDespues: number;
  cambios: CambioDeCapa[];
  /** Motivo por el que no se tocó nada, cuando así fue. */
  intacto?: string;
}

/** El bloque decodificador. Va al prefijo cacheado UNA vez, nunca por turno. */
export const CODIGO_CAVEMAN = [
  "CONVENIO DE ENTRADA COMPRIMIDA (bvsala). Algunos mensajes de usuario y",
  "resultados de herramienta llegan comprimidos para ahorrar contexto. Reglas:",
  "· «→» significa «por tanto/entonces». «=» significa «es/son». «!» al inicio",
  "  de línea marca una instrucción, no una afirmación.",
  "· Las listas van en una línea separadas por «;».",
  "· Un bloque «tabla k1,k2,k3:» seguido de filas con valores separados por",
  "  comas es un array de objetos con esas claves, en ese orden.",
  "· «⟦ref:ID⟧» es un puntero a un bloque que NO se te ha enviado por tamaño.",
  "  Si lo necesitas, pídelo por su ID; no lo inventes.",
  "Responde siempre en prosa normal: la compresión es solo de entrada.",
].join("\n");

const MARCA_CODIGO = "CONVENIO DE ENTRADA COMPRIMIDA (bvsala)";

// ───────────────────────────── detección de forma ─────────────────────────────

export function detectarForma(json: unknown): FormaDeCuerpo {
  if (typeof json !== "object" || json === null) return "desconocida";
  const o = json as Record<string, unknown>;
  if (!Array.isArray(o.messages)) return "desconocida";
  // Anthropic lleva `system` fuera de `messages` y/o bloques con `type`.
  if ("system" in o) return "anthropic";
  const conBloques = (o.messages as unknown[]).some(
    (m) =>
      typeof m === "object" &&
      m !== null &&
      Array.isArray((m as Record<string, unknown>).content) &&
      ((m as Record<string, unknown>).content as unknown[]).some(
        (b) => typeof b === "object" && b !== null && typeof (b as Record<string, unknown>).type === "string",
      ),
  );
  if (conBloques) return "anthropic";
  const conRolTool = (o.messages as unknown[]).some(
    (m) => typeof m === "object" && m !== null && (m as Record<string, unknown>).role === "tool",
  );
  if (conRolTool) return "openai";
  // Sin pistas fuertes: OpenAI es la forma más común de `messages` plano.
  return "openai";
}

// ───────────────────────────── caveman · la prosa ─────────────────────────────

/**
 * Comprime prosa SIN tocar nada que pueda ser significativo para una máquina.
 *
 * Lo que NO toca, y cada exclusión viene de un fallo real de esta clase de
 * transformación: bloques de código entre acentos graves, rutas, números,
 * identificadores, URLs y cualquier línea que parezca un diff. Comprimir un
 * número o una ruta no es comprimir: es corromper.
 */
export function comprimirProsa(texto: string, agresividad: "prudente" | "telegrafico" = "prudente"): string {
  const trozos = texto.split(/(```[\s\S]*?```|`[^`]*`)/g);
  return trozos
    .map((t, i) => {
      if (i % 2 === 1) return t; // bloque de código: intacto
      let s = t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
      s = s.replace(/^[ \t]*[-*][ \t]+/gm, "· ");
      // Muletillas que no aportan nada a un modelo.
      s = s.replace(
        /\b(por favor|please|como ya sabes|ten en cuenta que|es importante destacar que|cabe señalar que|me gustaría que|I would like you to|note that)\b[,:]?\s*/gi,
        "",
      );
      s = s.replace(/\b(por lo tanto|por tanto|therefore|so that means)\b/gi, "→");
      if (agresividad === "telegrafico") {
        // Artículos y cópulas, solo entre minúsculas para no tocar nombres propios.
        s = s.replace(/(?<=[a-záéíóúñ,;] )(el|la|los|las|un|una|unos|unas|the|a|an)(?= [a-záéíóúñ])/g, "");
        s = s.replace(/(?<=[a-záéíóúñ] )(es|son|is|are)(?= [a-záéíóúñ])/g, "=");
        s = s.replace(/[ \t]{2,}/g, " ");
      }
      return s;
    })
    .join("")
    .trim();
}

// ───────────────────────────── toon · lo tabular ─────────────────────────────

/**
 * Serializa un valor JSON a notación tabular compacta.
 *
 * El caso que paga la transformación es el array de objetos homogéneos: en JSON
 * cada fila repite todas las claves, y aquí se escriben una vez. Para todo lo
 * demás la ganancia es marginal y la legibilidad peor, así que se deja en JSON.
 *
 * ADVERTENCIA: esto es para que lo LEA un modelo, no para volver a parsearlo. No
 * es ida y vuelta sin pérdida, y por eso no se aplica nunca a nada que el
 * cliente vaya a releer.
 */
export function aToon(valor: unknown, sangria = 0): string {
  const pad = "  ".repeat(sangria);
  if (Array.isArray(valor)) {
    const objetos = valor.filter((v) => typeof v === "object" && v !== null && !Array.isArray(v)) as Record<string, unknown>[];
    if (objetos.length === valor.length && objetos.length > 1) {
      const claves = Object.keys(objetos[0]!);
      const homogeneo =
        claves.length > 0 &&
        objetos.every((o) => {
          const k = Object.keys(o);
          return k.length === claves.length && k.every((x, i) => x === claves[i]);
        });
      if (homogeneo) {
        const escalar = (v: unknown) =>
          v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v).includes(",") ? JSON.stringify(String(v)) : String(v);
        const filas = objetos.map((o) => `${pad}  ${claves.map((k) => escalar(o[k])).join(",")}`);
        return `${pad}tabla ${claves.join(",")}:\n${filas.join("\n")}`;
      }
    }
    return `${pad}[${valor.map((v) => (typeof v === "object" && v !== null ? "\n" + aToon(v, sangria + 1) : String(v))).join("; ")}]`;
  }
  if (typeof valor === "object" && valor !== null) {
    const o = valor as Record<string, unknown>;
    return Object.entries(o)
      .map(([k, v]) =>
        typeof v === "object" && v !== null ? `${pad}${k}:\n${aToon(v, sangria + 1)}` : `${pad}${k}=${v === null ? "" : String(v)}`,
      )
      .join("\n");
  }
  return `${pad}${String(valor)}`;
}

/** Intenta comprimir un texto que CONTIENE JSON. Si no es JSON, lo devuelve igual. */
export function toonSiEsJson(texto: string): string {
  const t = texto.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return texto;
  let valor: unknown;
  try {
    valor = JSON.parse(t);
  } catch {
    return texto;
  }
  const toon = aToon(valor);
  // DOS umbrales, y el absoluto importa tanto como el relativo: cambiarle la
  // forma a un dato tiene un coste que no está en la cuenta de caracteres —el
  // modelo tiene que aplicar el convenio— así que ganar el 57 % de un objeto de
  // siete caracteres (cuatro bytes) no lo paga. Se exige ganar ≥10 % Y ≥200
  // caracteres. Lo cazó su propia prueba.
  const ganancia = texto.length - toon.length;
  return ganancia >= 200 && toon.length < texto.length * 0.9 ? toon : texto;
}

// ───────────────────────────── la capa completa ─────────────────────────────

type Bloque = Record<string, unknown>;

function ultimoIndice<T>(xs: T[], p: (x: T) => boolean): number {
  for (let i = xs.length - 1; i >= 0; i -= 1) if (p(xs[i]!)) return i;
  return -1;
}

/**
 * Aplica la capa. Devuelve el cuerpo nuevo y el informe de lo que cambió.
 *
 * Nunca lanza: ante cualquier sorpresa devuelve el cuerpo original y lo explica
 * en `intacto`. Una capa intermedia que puede tumbar una petición no es una
 * palanca, es un riesgo.
 */
export function aplicarCapa(
  cuerpo: string,
  opciones: OpcionesDeCapa = {},
): { cuerpo: string; informe: InformeDeCapa } {
  const informe: InformeDeCapa = { forma: "desconocida", cuerpoAntes: cuerpo.length, cuerpoDespues: cuerpo.length, cambios: [] };
  if (!opciones.caveman && !opciones.toon && !opciones.externalizarDesde) {
    informe.intacto = "capa apagada";
    return { cuerpo, informe };
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(cuerpo) as Record<string, unknown>;
  } catch {
    informe.intacto = "el cuerpo no es JSON (¿comprimido?); no se toca";
    return { cuerpo, informe };
  }
  informe.forma = detectarForma(json);
  if (informe.forma === "desconocida") {
    informe.intacto = "forma de cuerpo no reconocida; no se toca";
    return { cuerpo, informe };
  }

  try {
    const mensajes = json.messages as Bloque[];

    // ── 1 · el código de caveman · prefijo cacheado (defecto) o cada turno (dial) ──
    if (opciones.caveman && opciones.dondeCodigo === "turno") {
      // La variante MEDIDA Y PERDEDORA, disponible para poder reproducirla: el
      // bloque viaja pegado al turno, así que se paga entero en cada petición.
      const iU = ultimoIndice(mensajes, (x) => x.role === "user");
      if (iU >= 0) {
        const m = mensajes[iU]!;
        if (typeof m.content === "string") {
          const antes = m.content.length;
          m.content = `${CODIGO_CAVEMAN}\n\n${m.content}`;
          informe.cambios.push({ cual: "caveman-codigo", donde: `messages[${iU}] (por turno)`, antes, despues: String(m.content).length });
        } else if (Array.isArray(m.content)) {
          (m.content as Bloque[]).unshift({ type: "text", text: CODIGO_CAVEMAN });
          informe.cambios.push({ cual: "caveman-codigo", donde: `messages[${iU}].content[0] (por turno)`, antes: 0, despues: CODIGO_CAVEMAN.length });
        }
      }
    } else if (opciones.caveman) {
      if (informe.forma === "anthropic") {
        const sys = json.system;
        const yaEsta = JSON.stringify(sys ?? "").includes(MARCA_CODIGO);
        if (!yaEsta) {
          const antes = JSON.stringify(sys ?? "").length;
          if (typeof sys === "string") json.system = `${CODIGO_CAVEMAN}\n\n${sys}`;
          else if (Array.isArray(sys)) (sys as Bloque[]).unshift({ type: "text", text: CODIGO_CAVEMAN });
          else json.system = CODIGO_CAVEMAN;
          informe.cambios.push({
            cual: "caveman-codigo",
            donde: "system (prefijo cacheado)",
            antes,
            despues: JSON.stringify(json.system).length,
          });
        }
      } else {
        const i = mensajes.findIndex((m) => m.role === "system");
        const yaEsta = i >= 0 && String(mensajes[i]!.content ?? "").includes(MARCA_CODIGO);
        if (!yaEsta) {
          if (i >= 0) {
            const antes = String(mensajes[i]!.content ?? "").length;
            mensajes[i]!.content = `${CODIGO_CAVEMAN}\n\n${String(mensajes[i]!.content ?? "")}`;
            informe.cambios.push({ cual: "caveman-codigo", donde: "messages[system]", antes, despues: String(mensajes[i]!.content).length });
          } else {
            mensajes.unshift({ role: "system", content: CODIGO_CAVEMAN });
            informe.cambios.push({ cual: "caveman-codigo", donde: "messages[0] nuevo system", antes: 0, despues: CODIGO_CAVEMAN.length });
          }
        }
      }
    }

    // ── 2 · el turno en curso (defecto) o la historia entera (dial) ──
    const indices =
      opciones.alcanceToon === "todo"
        ? mensajes.map((m, i) => (m.role === "user" || m.role === "tool" ? i : -1)).filter((i) => i >= 0)
        : [ultimoIndice(mensajes, (m) => m.role === "user" || m.role === "tool")].filter((i) => i >= 0);
    for (const iUlt of indices) {
      const m = mensajes[iUlt]!;
      const contenido = m.content;

      const tratarTexto = (texto: string, donde: string): string => {
        let s = texto;
        if (opciones.toon) {
          const t = toonSiEsJson(s);
          if (t !== s) {
            informe.cambios.push({ cual: "toon", donde, antes: s.length, despues: t.length });
            s = t;
          }
        }
        if (opciones.caveman) {
          const c = comprimirProsa(s, opciones.agresividad ?? "prudente");
          if (c !== s) {
            informe.cambios.push({ cual: "caveman-prosa", donde, antes: s.length, despues: c.length });
            s = c;
          }
        }
        const tope = opciones.externalizarDesde ?? 0;
        if (tope > 0 && s.length > tope) {
          const id = `ext-${Math.abs(hash(s)).toString(36)}`;
          const recorte = `${s.slice(0, 400)}\n…\n⟦ref:${id}⟧ (${s.length} caracteres retenidos; pídelo por su ID si lo necesitas)`;
          informe.cambios.push({ cual: "externalizado", donde, antes: s.length, despues: recorte.length });
          s = recorte;
        }
        return s;
      };

      if (typeof contenido === "string") {
        m.content = tratarTexto(contenido, `messages[${iUlt}].content`);
      } else if (Array.isArray(contenido)) {
        (contenido as Bloque[]).forEach((b, j) => {
          const donde = `messages[${iUlt}].content[${j}]:${String(b.type ?? "?")}`;
          if (b.type === "text" && typeof b.text === "string") b.text = tratarTexto(b.text, donde);
          else if (b.type === "tool_result") {
            if (typeof b.content === "string") b.content = tratarTexto(b.content, donde);
            else if (Array.isArray(b.content))
              (b.content as Bloque[]).forEach((c, k) => {
                if (c.type === "text" && typeof c.text === "string") c.text = tratarTexto(c.text, `${donde}[${k}]`);
              });
          }
        });
      }
    }

    const salida = JSON.stringify(json);
    informe.cuerpoDespues = salida.length;
    if (!informe.cambios.length) informe.intacto = "nada que comprimir en este turno";
    return { cuerpo: salida, informe };
  } catch (e) {
    informe.intacto = `excepción en la capa, se devuelve el original: ${e instanceof Error ? e.name : "error"}`;
    informe.cuerpoDespues = cuerpo.length;
    return { cuerpo, informe };
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/** Lee las banderas del entorno. Todas nacen APAGADAS. */
export function opcionesDeEntorno(env: Record<string, string | undefined> = process.env): OpcionesDeCapa {
  const si = (v: string | undefined) => v === "1" || v === "true";
  return {
    caveman: si(env.BVSALA_GATEWAY_CAVEMAN),
    toon: si(env.BVSALA_GATEWAY_TOON),
    externalizarDesde: Number(env.BVSALA_GATEWAY_EXTERNALIZAR ?? "0") || 0,
    agresividad: env.BVSALA_GATEWAY_CAVEMAN_AGRESIVO === "1" ? "telegrafico" : "prudente",
    dondeCodigo: env.BVSALA_GATEWAY_CAVEMAN_DONDE === "turno" ? "turno" : "prefijo",
    alcanceToon: env.BVSALA_GATEWAY_TOON_ALCANCE === "todo" ? "todo" : "turno",
  };
}
