import { createHash } from "node:crypto";

/**
 * F2 · COALESCENCIA DE DUPLICADOS — la primera palanca del gateway.
 *
 * Dos peticiones IDÉNTICAS (mismo método, misma ruta, mismos bytes de cuerpo)
 * en vuelo a la vez solo viajan una: la primera va al proveedor y su respuesta
 * se captura mientras se sirve; las gemelas esperan y reciben la réplica.
 *
 * Reglas del plan maestro que esta pieza respeta:
 *   · APAGADA POR DEFECTO (BVSALA_GATEWAY_COALESCE=1 la enciende): ninguna
 *     palanca entra en servicio hasta que el arnés de F2 demuestre cero
 *     degradación sobre el corpus.
 *   · Solo coalesce mientras la primaria está EN VUELO. Terminada la primaria,
 *     la siguiente idéntica viaja normal: esto no es una caché, no guarda nada.
 *   · Fallo o desbordamiento de la primaria → las gemelas van al proveedor por
 *     su cuenta. Degradar a passthrough, jamás a error.
 *   · El ahorro de una gemela se reporta con `basis: "estimated"` aunque el
 *     contador de la primaria sea real: la doctrina de la capa dice que una
 *     llamada evitada no tiene contador PROPIO, y la comisión solo factura lo
 *     medido. Reclasificarlo es una decisión de doctrina del dueño, no de esta
 *     pieza. (Queda anotado en el plan.)
 */
// El SDK ya valora sus evitadas idénticas por referencia (basis reference); la
// gemela sigue estimated hasta el sí del dueño (Parte G).

export interface RespuestaCapturada {
  status: number;
  /** Cabeceras YA saneadas (sin las de transporte), listas para reenviar. */
  headers: Record<string, string>;
  chunks: Buffer[];
}

/** Por encima de esto la primaria deja de capturarse y sus gemelas van solas. */
export const MAX_CAPTURA_BYTES = 5 * 1024 * 1024;

/**
 * Las cabeceras que IDENTIFICAN la respuesta y por tanto tienen que entrar en la
 * clave: si dos peticiones difieren en cualquiera de ellas, su respuesta puede
 * diferir y NO se pueden coalescer. La credencial es la crítica —jamás servir la
 * respuesta de una credencial a otra— junto a la versión y los betas de la API,
 * que cambian el formato del cuerpo. En minúsculas: las cabeceras HTTP no
 * distinguen mayúsculas.
 */
export const CABECERAS_DE_IDENTIDAD = [
  "authorization",
  "x-api-key",
  "anthropic-version",
  "anthropic-beta",
] as const;

/**
 * La clave de coalescencia. Incluye el método, la ruta, el CUERPO y las
 * cabeceras de identidad: antes solo miraba método+ruta+cuerpo, así que dos
 * peticiones idénticas de cuerpo pero con OTRA credencial (u otra
 * anthropic-version / anthropic-beta) compartían clave y la gemela recibía la
 * respuesta de la primaria — una fuga entre credenciales. `cabeceras` lo aporta
 * quien llama, ya normalizado (ver `materialDeCabeceras`).
 */
export function claveDePeticion(method: string, path: string, cuerpo: Buffer, cabeceras = ""): string {
  return createHash("sha256")
    .update(method)
    .update("\n")
    .update(path)
    .update("\n")
    .update(cabeceras)
    .update("\n")
    .update(cuerpo)
    .digest("hex");
}

/** El material de las cabeceras de identidad para la clave, en orden estable. */
export function materialDeCabeceras(get: (nombre: string) => string | undefined): string {
  return CABECERAS_DE_IDENTIDAD.map((n) => `${n}=${get(n) ?? ""}`).join("\n");
}

interface EnVuelo {
  promesa: Promise<RespuestaCapturada | null>;
  resolver: (r: RespuestaCapturada | null) => void;
}

export class Coalescedor {
  private enVuelo = new Map<string, EnVuelo>();
  /** Contadores para el log y para el arnés. */
  primarias = 0;
  gemelas = 0;

  /**
   * Registra una primaria. Devuelve el capturador que el servidor alimenta
   * mientras sirve, o null si ya hay una primaria en vuelo con esta clave
   * (entonces la petición es una gemela: usar `esperar`).
   */
  registrar(clave: string): {
    capturar: (chunk: Buffer) => void;
    terminar: (status: number, headers: Record<string, string>) => void;
    abortar: () => void;
  } | null {
    if (this.enVuelo.has(clave)) return null;
    this.primarias += 1;
    let resolver!: (r: RespuestaCapturada | null) => void;
    const promesa = new Promise<RespuestaCapturada | null>((res) => (resolver = res));
    this.enVuelo.set(clave, { promesa, resolver });

    const chunks: Buffer[] = [];
    let bytes = 0;
    let desbordada = false;
    return {
      capturar: (chunk: Buffer) => {
        if (desbordada) return;
        bytes += chunk.length;
        if (bytes > MAX_CAPTURA_BYTES) {
          desbordada = true;
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
      },
      terminar: (status, headers) => {
        // Solo se replica un 2xx íntegro: una primaria con error no debe
        // multiplicarse — sus gemelas irán al proveedor y tendrán su propia
        // oportunidad (p. ej. tras un 529 transitorio).
        const valida = !desbordada && status >= 200 && status < 300;
        this.enVuelo.get(clave)?.resolver(valida ? { status, headers, chunks } : null);
        this.enVuelo.delete(clave);
      },
      abortar: () => {
        this.enVuelo.get(clave)?.resolver(null);
        this.enVuelo.delete(clave);
      },
    };
  }

  /** La espera de una gemela: la réplica de la primaria, o null (ir sola). */
  async esperar(clave: string): Promise<RespuestaCapturada | null> {
    const vuelo = this.enVuelo.get(clave);
    if (!vuelo) return null;
    const r = await vuelo.promesa;
    if (r) this.gemelas += 1;
    return r;
  }

  tieneEnVuelo(clave: string): boolean {
    return this.enVuelo.has(clave);
  }
}
