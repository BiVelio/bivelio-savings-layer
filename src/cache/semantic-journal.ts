import {
  CalibrationStateError,
  EstadoDeCalibracion,
  escribirEstado,
  leerEstado,
  umbralDeIndice,
} from "./calibracion.js";
import type {
  SemanticCalibrationState,
  SemanticCalibrationStatus,
} from "./calibration.js";
import type { SemanticProbe } from "./semantic.js";

export interface SemanticCalibrationIdentity {
  embedder: string;
  verifier: string | null;
  judge: string;
  maxErrorRate: number;
  confidence: number;
  similarityThreshold: number;
  backend?: string;
}

/** Pure, shared online calibration state, without storage or I/O. */
export class SemanticCalibrationJournal {
  private readonly estados = new Map<SemanticProbe["segment"], EstadoDeCalibracion>();

  constructor(private readonly identity: SemanticCalibrationIdentity) {}

  floorIndex(segment: SemanticProbe["segment"]): number | null {
    return this.estadoDe(segment).suelo;
  }

  record(segment: SemanticProbe["segment"], score: number, correct: boolean): void {
    this.estadoDe(segment).anotar(score, correct);
  }

  status(segment: SemanticProbe["segment"]): SemanticCalibrationStatus {
    const r = this.estadoDe(segment).resumen();
    return {
      maxErrorRate: this.identity.maxErrorRate,
      confidence: this.identity.confidence,
      floor: r.suelo == null ? null : umbralDeIndice(r.suelo),
      labeled: r.etiquetas,
      heldOut: r.retenidas,
      heldOutAtFloor: r.retenidasEnSuelo,
      wrongHeldOutAtFloor: r.erroneasEnSuelo,
      minHeldOutToCertify: r.minimasParaLaSiguiente,
      nextTestAt: r.etiquetasParaLaSiguiente,
    };
  }

  export(): SemanticCalibrationState {
    return escribirEstado(this.identity, this.estados);
  }

  import(state: unknown): void {
    let datos = state;
    if (typeof state === "string") {
      try {
        datos = JSON.parse(state);
      } catch {
        throw new CalibrationStateError("importCalibration: the state is a string but not JSON");
      }
    }
    const leidos = leerEstado(datos, this.identity);
    for (const [segmento] of leidos) {
      const actual = this.estados.get(segmento);
      if (actual && actual.resumen().etiquetas > 0) {
        throw new CalibrationStateError(
          `importCalibration: this cache has already recorded ${actual.resumen().etiquetas} labels in the ` +
            `${segmento} segment; import right after constructing it`,
        );
      }
    }
    for (const [segmento, estado] of leidos) this.estados.set(segmento, estado);
  }

  private estadoDe(segment: SemanticProbe["segment"]): EstadoDeCalibracion {
    let estado = this.estados.get(segment);
    if (!estado) {
      estado = new EstadoDeCalibracion(this.identity.maxErrorRate, 1 - this.identity.confidence);
      this.estados.set(segment, estado);
    }
    return estado;
  }
}
