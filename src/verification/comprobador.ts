import type { SavingsRequest, SavingsResult } from "../contracts/types.js";
import type {
  VerificationCheck,
  VerificationReport,
  VerificationStratum,
} from "../contracts/verification.js";
import { cerrarParada } from "../providers/motivo-de-parada.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../providers/types.js";
import type { CostModel } from "../tokenizer/accounting.js";
import type { DeadlineDePeticion } from "../pipeline/request-deadline.js";
import type { AjustesDeVerificacion } from "./ajustes.js";
import { AVISO_VERIFICACION_FALLO_INTERNO } from "./ajustes.js";
import { construirPeticionSinCapa } from "./brazo-sin-capa.js";
import { clasificar, type ViaDeServicio } from "./clasificar.js";
import { enLaMuestraDeVerificacion } from "./muestreo.js";
import { precioDelUso } from "./precio.js";

/** Adónde van los pares y los recuentos. Lo arma create.ts (emisor + onCheck). */
export interface SumideroDeVerificacion {
  /** Un par decidido (cualquier `outcome`). Nunca lanza hacia el comprobador. */
  encolar(check: VerificationCheck): void;
  /** Una petición contada en su estrato o su exclusión, por día UTC. Solo con emisor. */
  contar?: (dia: string, categoria: string) => void;
  /** Ya no queda ninguna copia en vuelo: buen momento para vaciar el emisor. */
  enReposo(): Promise<void> | void;
}

/** Tope de copias en vuelo: la 33.ª muestreada sale `dropped`, sin llamada (D13). */
export const MAX_EN_VUELO = 32;
/** Una copia que no vuelve en 10 minutos se da por fallida y se aborta (D13). */
export const TIMEOUT_DE_COPIA_MS = 600_000;

type Base = Omit<VerificationCheck, "outcome" | "naive">;

interface Vuelo {
  base: Base;
  abortar: AbortController;
  decidido: boolean;
  reloj: ReturnType<typeof setTimeout> | undefined;
  relojDelDeadline: ReturnType<typeof setTimeout> | undefined;
  quitarEscucha: (() => void) | undefined;
  /** Se resuelve cuando el par está decidido y, si era el último, el emisor vaciado. */
  terminar: () => void;
}

/** `YYYY-MM-DD` en UTC. */
export function diaUTC(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// EL COMPROBADOR A/B. Decide, para cada petición servida, si entra en la
// muestra y si es elegible; si lo es, manda la copia sin capa DESPUÉS de servir.
//
// Garantías (cada una con su test en test/verificacion-ab.test.ts):
//   · nunca muta el resultado servido: devuelve un objeto NUEVO (el del líder de
//     singleflight es compartido con sus seguidores);
//   · nunca lanza hacia el llamante: un fallo interno devuelve el resultado intacto;
//   · la copia no pasa por cachés, singleflight, resolvers, verjas ni emisor de
//     uso: va directa a `provider.generate` y su respuesta se descarta;
//   · `cerrar()` decide en el acto cada copia en vuelo como `abandoned`.
export class ComprobadorAB {
  private readonly tasa: number;
  private readonly tope: number | undefined;
  private readonly onCheck: ((check: VerificationCheck) => void) | undefined;
  private readonly waitUntil: ((promise: Promise<void>) => void) | undefined;
  private readonly provider: Provider;
  private readonly precio: (model: string) => CostModel | undefined;
  private readonly contrato: (peticion: ProviderRequest, resp: ProviderResponse) => "met" | "missed" | "none";
  private readonly now: () => number;
  private readonly sumidero: SumideroDeVerificacion;
  private readonly avisar: (clave: string, mensaje: string) => void;
  private readonly enVuelo = new Set<Vuelo>();
  private cerrado = false;

  constructor(o: {
    ajustes: Extract<AjustesDeVerificacion, { activo: true }>;
    provider: Provider;
    precio: (model: string) => CostModel | undefined;
    // Recibe la copia (su `schema` quedó fijado al decidir), no la petición del
    // llamante, que puede haber cambiado desde entonces.
    contrato: (peticion: ProviderRequest, resp: ProviderResponse) => "met" | "missed" | "none";
    now: () => number;
    sumidero: SumideroDeVerificacion;
    avisar: (clave: string, mensaje: string) => void;
  }) {
    this.tasa = o.ajustes.tasa;
    this.tope = o.ajustes.tope;
    this.onCheck = o.ajustes.onCheck;
    this.waitUntil = o.ajustes.waitUntil;
    this.provider = o.provider;
    this.precio = o.precio;
    this.contrato = o.contrato;
    this.now = o.now;
    this.sumidero = o.sumidero;
    this.avisar = o.avisar;
  }

  /** Cuántas copias siguen en vuelo (tests). */
  get copiasEnVuelo(): number {
    return this.enVuelo.size;
  }

  decidir<T>(
    request: SavingsRequest,
    result: SavingsResult<T>,
    via: ViaDeServicio,
    deadline?: DeadlineDePeticion,
  ): SavingsResult<T> {
    if (this.cerrado) return result;
    try {
      const report = result.report;
      const sampled = enLaMuestraDeVerificacion(report.requestId, this.tasa);
      const clase = clasificar({
        request,
        result: result as SavingsResult<unknown>,
        via,
        precio: this.precio,
        ...(this.tope !== undefined ? { tope: this.tope } : {}),
      });
      // Todo lo que puede lanzar va ANTES de contar y de lanzar la copia: un
      // fallo aquí devuelve el resultado intacto sin dejar nada a medias.
      let copia: { peticion: ProviderRequest; precios: CostModel; estrato: VerificationStratum } | undefined;
      if (sampled && "estrato" in clase) {
        const precios = this.precio(request.model);
        if (!precios) throw new Error("price vanished between classification and launch");
        copia = { peticion: construirPeticionSinCapa(request), precios, estrato: clase.estrato };
      }
      const at = this.now();
      this.sumidero.contar?.(diaUTC(at), "estrato" in clase ? clase.estrato : clase.excluida);
      if (copia && !deadline?.haVencido()) this.lanzar(request, result as SavingsResult<unknown>, at, copia, deadline);
      const bloque: VerificationReport =
        "estrato" in clase ? { sampled, stratum: clase.estrato } : { sampled, excluded: clase.excluida };
      return { ...result, report: { ...report, verification: bloque } };
    } catch {
      this.avisar("verificacion-fallo-interno", AVISO_VERIFICACION_FALLO_INTERNO);
      return result;
    }
  }

  // Síncrono: al volver, cada copia en vuelo ya está decidida como `abandoned`,
  // su evento emitido y su señal abortada. Una respuesta tardía se ignora.
  cerrar(): void {
    this.cerrado = true;
    const vuelos = [...this.enVuelo];
    this.enVuelo.clear();
    for (const vuelo of vuelos) {
      if (vuelo.decidido) continue;
      vuelo.decidido = true;
      if (vuelo.reloj) clearTimeout(vuelo.reloj);
      if (vuelo.relojDelDeadline) clearTimeout(vuelo.relojDelDeadline);
      vuelo.quitarEscucha?.();
      vuelo.quitarEscucha = undefined;
      try {
        vuelo.abortar.abort();
      } catch {
        /* un listener de abort que lanza no para el cierre */
      }
      this.registrar({ ...vuelo.base, outcome: "abandoned" });
      vuelo.terminar();
    }
  }

  private lanzar(
    request: SavingsRequest,
    result: SavingsResult<unknown>,
    at: number,
    copia: { peticion: ProviderRequest; precios: CostModel; estrato: VerificationStratum },
    deadline?: DeadlineDePeticion,
  ): void {
    const r = result.report;
    const p = copia.precios;
    const base: Base = {
      requestId: r.requestId,
      at,
      stratum: copia.estrato,
      requestedModel: request.model,
      servedModel: r.model,
      cacheResult: r.cache.result,
      optimized: {
        cost: r.cost.actual,
        inputTokens: r.tokens.actualInput,
        cachedInputTokens: r.tokens.providerCachedInput ?? 0,
        outputTokens: r.tokens.actualOutput,
      },
      prices: {
        inputPer1k: p.inputPer1k,
        ...(p.cachedInputPer1k !== undefined ? { cachedInputPer1k: p.cachedInputPer1k } : {}),
        outputPer1k: p.outputPer1k,
      },
    };
    if (this.enVuelo.size >= MAX_EN_VUELO) {
      this.registrar({ ...base, outcome: "dropped" });
      return;
    }

    if (deadline?.haVencido()) return;
    let terminar: () => void = () => {};
    const terminado = new Promise<void>((resolve) => {
      terminar = resolve;
    });
    const vuelo: Vuelo = {
      base,
      abortar: new AbortController(),
      decidido: false,
      reloj: undefined,
      relojDelDeadline: undefined,
      quitarEscucha: undefined,
      terminar,
    };
    this.enVuelo.add(vuelo);

    vuelo.reloj = setTimeout(() => {
      try {
        vuelo.abortar.abort();
      } catch {
        /* nada que hacer */
      }
      void this.resolverVuelo(vuelo, { ...base, outcome: "check_failed" });
    }, TIMEOUT_DE_COPIA_MS);
    (vuelo.reloj as unknown as { unref?: () => void }).unref?.();

    // DESPUÉS DE SERVIR: la copia sale en la siguiente vuelta del bucle de
    // eventos, cuando la continuación del `await` del llamante ya ha corrido.
    // Cero latencia en su camino. El vencimiento absoluto sigue vivo aquí aunque
    // el temporizador de la entrada principal ya se haya limpiado.
    setTimeout(() => {
      if (vuelo.decidido) return; // cerrada antes de salir: ni se llama
      const vencer = (): void => {
        try {
          vuelo.abortar.abort();
        } catch {
          /* nada que hacer */
        }
        void this.resolverVuelo(vuelo, { ...base, outcome: "check_failed" });
      };
      if (deadline?.haVencido()) {
        vencer();
        return;
      }
      const restante = deadline?.restanteMs();
      if (restante !== undefined) {
        if (restante <= 0) {
          vencer();
          return;
        }
        vuelo.relojDelDeadline = setTimeout(vencer, Math.max(1, Math.ceil(restante)));
        (vuelo.relojDelDeadline as unknown as { unref?: () => void }).unref?.();
      }
      const externa = deadline?.externalSignal;
      if (externa) {
        if (externa.aborted) {
          vencer();
          return;
        }
        externa.addEventListener("abort", vencer, { once: true });
        vuelo.quitarEscucha = () => externa.removeEventListener("abort", vencer);
      }
      let llamada: Promise<ProviderResponse>;
      try {
        llamada = Promise.resolve(this.provider.generate(copia.peticion, { signal: vuelo.abortar.signal }));
      } catch (err) {
        llamada = Promise.reject(err);
      }
      llamada.then(
        (resp) => {
          let check: VerificationCheck;
          try {
            check = this.checkDeLaRespuesta(base, copia.peticion, resp, p);
          } catch {
            check = { ...base, outcome: "check_failed" };
          }
          void this.resolverVuelo(vuelo, check);
        },
        () => void this.resolverVuelo(vuelo, { ...base, outcome: "check_failed" }),
      );
    }, 0);

    if (this.waitUntil) {
      try {
        this.waitUntil(terminado.catch(() => {}));
      } catch {
        /* el waitUntil del cliente no puede tumbar nada */
      }
    }
  }

  private checkDeLaRespuesta(
    base: Base,
    peticion: ProviderRequest,
    resp: ProviderResponse,
    precios: CostModel,
  ): VerificationCheck {
    const u = resp?.usage;
    const entrada = u?.inputTokens;
    const salida = u?.outputTokens;
    const cached = u?.cachedInputTokens ?? 0;
    const contable = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
    if (
      !u ||
      u.complete === false ||
      !contable(entrada) ||
      !contable(salida) ||
      !contable(cached) ||
      (entrada === 0 && salida === 0)
    ) {
      return { ...base, outcome: "check_unmeasured" };
    }
    const cachedEfectivo = Math.min(cached, entrada);
    // EL MOTIVO DE LA COPIA, en el MISMO conjunto cerrado que el brazo con capa
    // (`stop | length | tool_calls | content_filter | other`, 0.5): los
    // adaptadores propios ya lo entregan cerrado y `cerrarParada` cierra el de un
    // proveedor de terceros, que sigue siendo abierto. Así `clasificar.ts`
    // excluye con la misma regla a los dos lados. El literal del proveedor
    // (`finishReasonDetail`) no viaja en el par: el panel solo compara motivos.
    const { finishReason } = cerrarParada(resp.finishReason, resp.finishReasonDetail);
    return {
      ...base,
      outcome: "paired",
      naive: {
        cost: precioDelUso({ inputTokens: entrada, outputTokens: salida, cachedInputTokens: cachedEfectivo }, precios),
        inputTokens: entrada,
        cachedInputTokens: cachedEfectivo,
        outputTokens: salida,
        ...(finishReason !== undefined ? { finishReason } : {}),
        contract: this.contrato(peticion, resp),
      },
    };
  }

  private async resolverVuelo(vuelo: Vuelo, check: VerificationCheck): Promise<void> {
    if (vuelo.decidido) return;
    vuelo.decidido = true;
    if (vuelo.reloj) clearTimeout(vuelo.reloj);
    if (vuelo.relojDelDeadline) clearTimeout(vuelo.relojDelDeadline);
    vuelo.quitarEscucha?.();
    vuelo.quitarEscucha = undefined;
    this.enVuelo.delete(vuelo);
    this.registrar(check);
    if (this.enVuelo.size === 0) {
      try {
        await this.sumidero.enReposo();
      } catch {
        /* el emisor nunca lanza; y si lo hiciera, no es asunto del llamante */
      }
    }
    vuelo.terminar();
  }

  private registrar(check: VerificationCheck): void {
    try {
      this.sumidero.encolar(check);
    } catch {
      /* el emisor nunca afecta al llamante */
    }
    if (this.onCheck) {
      try {
        this.onCheck(check);
      } catch {
        /* «Errors thrown here are ignored» (VerificationSettings.onCheck) */
      }
    }
  }
}
