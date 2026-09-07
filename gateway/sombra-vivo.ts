import { createHash } from "node:crypto";

import {
  CacheDePrefijos,
  CadenaDeSimulacion,
  aplicarPolitica,
  compactarCuerpo,
  identidad,
  type TurnoSombra,
} from "./sombra.js";
import type { UsoSse } from "./medidor.js";

/**
 * S2.4-vivo · EL CARRIL SOMBRA del gateway — la política v0 del replay como
 * INSTRUMENTO de medición (no «ganadora»: con el simulador que reproduce al
 * proveedor pierde dinero; la cifra vigente es la del artefacto
 * benchmarks/evidencia/sombra-corpus-*-reparto.json más reciente) corriendo contra el tráfico real, EN ASÍNCRONO
 * tras servir la respuesta y sin tocar un byte de lo reenviado. Por petición
 * medible mantiene dos cadenas del mismo simulador (baseline y v0) y emite la
 * diferencia de ESE turno como registro `basis:"shadow"`.
 *
 * Doctrina: hipotético por construcción. El registro sombra jamás entra en la
 * base de la comisión ni en measured (la RPC 0021 lo acumula solo en
 * shadow_*), y su requestId lleva sufijo `:shadow` para no chocar en la
 * idempotencia con el registro medido de la misma petición.
 *
 * MEMORIA ACOTADA: las cadenas viven en un mapa con tope; al superarlo cae la
 * más antigua por último uso. La caché de PREFIJOS no vive en la cadena sino
 * en un mapa por modelo (una por variante: base y v0 no comparten hashes),
 * como la del proveedor, que es de la organización: una cadena que se pierde
 * y vuelve, o una sesión nueva, sigue acertando en el prefijo que otra
 * escribió. Cada caché poda sus entradas caducadas y tiene su propio tope.
 */

/** Tope de cadenas vivas (sesión×modelo×agente). Claude Code típico: 2-6. */
export const MAX_CADENAS = 64;

interface Cadena {
  base: CadenaDeSimulacion;
  v0: CadenaDeSimulacion;
  ultimoUso: number;
}

/** Lo que el carril devuelve para UN turno: los dos costes simulados del paso. */
export interface PasoSombra {
  baselineUsd: number;
  politicaUsd: number;
}

export class CarrilSombra {
  private readonly cadenas = new Map<string, Cadena>();
  private readonly cachesPorModelo = new Map<string, { base: CacheDePrefijos; v0: CacheDePrefijos }>();

  /**
   * Alimenta el carril con una petición YA medida. `cuerpo` es el JSON parseado
   * del POST /v1/messages (el contenido se compacta aquí mismo y no se retiene).
   * Devuelve null si el turno no es simulable (sin entrada, sin precio).
   */
  observar(entrada: {
    cuerpo: { model?: unknown; messages?: unknown; system?: unknown; tools?: unknown };
    uso: UsoSse;
    model: string;
    at: number;
    sessionId?: string;
    agentId?: string;
  }): PasoSombra | null {
    const escritura =
      entrada.uso.cache_creation_input_tokens ??
      (entrada.uso.cache_creation?.ephemeral_5m_input_tokens ?? 0) + (entrada.uso.cache_creation?.ephemeral_1h_input_tokens ?? 0);
    const entradaReal = (entrada.uso.input_tokens ?? 0) + (entrada.uso.cache_read_input_tokens ?? 0) + escritura;
    if (entradaReal <= 0) return null;

    const turno: TurnoSombra = {
      bloques: compactarCuerpo(entrada.cuerpo),
      at: entrada.at,
      model: entrada.model,
      entradaReal,
      escritura1h: (entrada.uso.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0,
    };
    if (turno.bloques.length === 0) return null;

    const cadena = this.cadenaPara(this.clave(entrada), entrada.model);
    const base = cadena.base.paso(turno);
    const v0 = cadena.v0.paso(turno);
    if (base.totalUsd <= 0 && v0.totalUsd <= 0) return null;
    return { baselineUsd: base.totalUsd, politicaUsd: v0.totalUsd };
  }

  /** La cadena es por (sesión, agente, MODELO): una sesión de Claude Code
   *  entrelaza el modelo principal con llamadas haiku que son conversaciones
   *  distintas — encadenarlas rompería el prefijo en cada alternancia. Sin
   *  cabecera de sesión, el hash del primer mensaje (una conversación conserva
   *  su primer mensaje). */
  private clave(e: { cuerpo: { messages?: unknown }; model: string; sessionId?: string; agentId?: string }): string {
    if (e.sessionId) return `s:${e.sessionId}·a:${e.agentId ?? ""}·${e.model}`;
    const primero = Array.isArray(e.cuerpo.messages) ? (e.cuerpo.messages as unknown[])[0] : undefined;
    const hash = createHash("sha256").update(JSON.stringify(primero ?? null)).digest("hex").slice(0, 16);
    return `m:${hash}·${e.model}`;
  }

  private cachesDe(model: string): { base: CacheDePrefijos; v0: CacheDePrefijos } {
    let c = this.cachesPorModelo.get(model);
    if (!c) {
      c = { base: new CacheDePrefijos(), v0: new CacheDePrefijos() };
      this.cachesPorModelo.set(model, c);
    }
    return c;
  }

  private cadenaPara(clave: string, model: string): Cadena {
    let c = this.cadenas.get(clave);
    if (!c) {
      const caches = this.cachesDe(model);
      c = {
        base: new CadenaDeSimulacion((b) => identidad(b), caches.base),
        v0: new CadenaDeSimulacion((b, estado, turno) => aplicarPolitica("v0", b, estado, turno), caches.v0),
        ultimoUso: 0,
      };
      this.cadenas.set(clave, c);
      if (this.cadenas.size > MAX_CADENAS) {
        let victima: string | null = null;
        let masVieja = Infinity;
        for (const [k, v] of this.cadenas) {
          if (v.ultimoUso < masVieja) {
            masVieja = v.ultimoUso;
            victima = k;
          }
        }
        if (victima !== null) this.cadenas.delete(victima);
      }
    }
    c.ultimoUso = Date.now();
    return c;
  }
}
