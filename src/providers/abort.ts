export function comprobarSenalDeProvider(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  throw error;
}
