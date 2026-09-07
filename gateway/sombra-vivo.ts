import { createHash } from "node:crypto";

import {
  CadenaDeSimulacion,
  aplicarPolitica,
  compactarCuerpo,
  identidad,
  type TurnoSombra,
} from "./sombra.js";
import type { UsoSse } from "./medidor.js";
import { veredictoDeVerja, type MotivoVerja } from "./aptitud.js";

/**
 * S2.4-vivo · EL CARRIL SOMBRA del gateway — la política GANADORA del replay
 * (v0, +20,6 % neto; PR #194) corriendo contra el tráfico real, EN ASÍNCRONO
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
 * más antigua por último uso. Una cadena que se pierde y vuelve arranca de
 * cero (su primer turno simula escritura completa en AMBAS variantes — el
 * sesgo se anula al comparar).
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
  /**
   * El coste que se DECLARA como sombra. Con la verja cerrada para este modelo
   * es igual a `baselineUsd`: no se afirma ahorro donde no lo habríamos aplicado.
   */
  politicaUsd: number;
  /** Lo que v0 habría costado SIN verja. El instrumento no se ciega: esta cifra
   *  es la que alimenta la próxima medición de aptitud por modelo. */
  politicaSinVerjaUsd: number;
  /** Si la verja dejó aplicar la política en este modelo, y por qué. */
  verja: MotivoVerja;
}

export class CarrilSombra {
  private readonly cadenas = new Map<string, Cadena>();

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

    const cadena = this.cadenaPara(this.clave(entrada));
    const base = cadena.base.paso(turno);
    const v0 = cadena.v0.paso(turno);
    if (base.totalUsd <= 0 && v0.totalUsd <= 0) return null;

    // LA VERJA. Las dos cadenas avanzan SIEMPRE —cegar el instrumento en los
    // modelos sin medir haría imposible volver a medirlos— pero lo que se
    // declara como sombra es lo que la política habría hecho DE VERDAD: en un
    // modelo sin evidencia positiva y fresca no se aplica, así que su coste
    // declarado es el baseline y el ahorro de ese turno es exactamente cero.
    const verja = veredictoDeVerja(entrada.model, new Date(entrada.at).toISOString().slice(0, 10));
    return {
      baselineUsd: base.totalUsd,
      politicaUsd: verja.aplica ? v0.totalUsd : base.totalUsd,
      politicaSinVerjaUsd: v0.totalUsd,
      verja: verja.motivo,
    };
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

  private cadenaPara(clave: string): Cadena {
    let c = this.cadenas.get(clave);
    if (!c) {
      c = {
        base: new CadenaDeSimulacion((b) => identidad(b)),
        v0: new CadenaDeSimulacion((b, estado, turno) => aplicarPolitica("v0", b, estado, turno)),
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
