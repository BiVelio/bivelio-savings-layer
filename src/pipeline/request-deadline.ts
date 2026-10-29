import type { SavingsRequestOptions } from "../contracts/types.js";
import type { ProviderStreamOptions } from "../providers/types.js";
import { RequestTimeoutError } from "./errors.js";

export const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647;

export interface DeadlineDePeticion {
  readonly options: SavingsRequestOptions;
  readonly signal: AbortSignal;
  readonly externalSignal: AbortSignal | undefined;
  readonly timeoutMs: number | undefined;
  readonly deadlineAt: number | undefined;
  haVencido(): boolean;
  comprobar(requestSent: boolean): void;
  restanteMs(): number | undefined;
  dispose(): void;
}

function errorDeAbort(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

export function comprobarAbortExterno(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw errorDeAbort(signal);
}

export function crearDeadline(
  options: SavingsRequestOptions,
  now: () => number,
): DeadlineDePeticion | undefined {
  const timeoutMs = options.requestTimeoutMs;
  if (
    timeoutMs !== undefined &&
    (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_REQUEST_TIMEOUT_MS)
  ) {
    throw new RangeError(
      `[bvsala] requestTimeoutMs must be a positive finite integer no greater than ${MAX_REQUEST_TIMEOUT_MS}`,
    );
  }
  const externalSignal = options.signal;
  if (
    externalSignal !== undefined &&
    (typeof externalSignal !== "object" ||
      externalSignal === null ||
      typeof externalSignal.aborted !== "boolean" ||
      typeof externalSignal.addEventListener !== "function" ||
      typeof externalSignal.removeEventListener !== "function")
  ) {
    throw new TypeError("[bvsala] options.signal must be an AbortSignal");
  }
  if (timeoutMs === undefined && externalSignal === undefined) return undefined;

  const controlador = timeoutMs === undefined ? undefined : new AbortController();
  let quitarEscucha: (() => void) | undefined;
  if (controlador && externalSignal) {
    if (externalSignal.aborted) {
      controlador.abort(externalSignal.reason);
    } else {
      const alAbortar = (): void => controlador.abort(externalSignal.reason);
      externalSignal.addEventListener("abort", alAbortar, { once: true });
      quitarEscucha = () => externalSignal.removeEventListener("abort", alAbortar);
    }
  }

  const deadlineAt = timeoutMs === undefined ? undefined : now() + timeoutMs;
  let vencido = false;
  let reloj: ReturnType<typeof setTimeout> | undefined;
  const vencer = (): void => {
    if (vencido) return;
    vencido = true;
    controlador?.abort();
  };
  if (timeoutMs !== undefined && !controlador!.signal.aborted) {
    reloj = setTimeout(vencer, timeoutMs);
  }

  const deadline: DeadlineDePeticion = {
    options,
    signal: controlador?.signal ?? externalSignal!,
    externalSignal,
    timeoutMs,
    deadlineAt,
    haVencido: () => vencido || (deadlineAt !== undefined && now() >= deadlineAt),
    comprobar(requestSent: boolean): void {
      if (!this.haVencido()) return;
      vencer();
      throw new RequestTimeoutError(requestSent, timeoutMs!);
    },
    restanteMs(): number | undefined {
      return deadlineAt === undefined ? undefined : Math.max(0, deadlineAt - now());
    },
    dispose(): void {
      if (reloj !== undefined) clearTimeout(reloj);
      reloj = undefined;
      quitarEscucha?.();
      quitarEscucha = undefined;
    },
  };
  return deadline;
}

export function opcionesDelProvider(
  deadline: DeadlineDePeticion | undefined,
): ProviderStreamOptions | undefined {
  return deadline ? { signal: deadline.signal } : undefined;
}
