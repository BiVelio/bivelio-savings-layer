/**
 * ¿LA CUENTA DE SAVINGS ES LA MISMA QUE LA DEL RESTO DE BIVELIO? — un interruptor, APAGADO por defecto.
 *
 * Hoy sí: Savings y Privacy usan el mismo proyecto de Supabase, y la web lo
 * promete en tres sitios (la nota del alta, la entradilla de Cuenta y la nota
 * «Personal» del plan): «¿Ya usas BiVelio Shield o Privacy? La misma cuenta te
 * sirve aquí». El día que las cuentas se separen (Privacy en su propio
 * proyecto, o Savings en el suyo) esas frases pasan a ser falsas: quien siga el
 * consejo e intente entrar con la cuenta de Privacy no podrá.
 *
 * `BVSALA_CUENTA_PROPIA=1` las quita. Se enciende EL MISMO DÍA que se separan
 * las cuentas, no antes. Vacía o con cualquier otro valor (hoy) = como siempre.
 * Solo la leen componentes de servidor (no es `NEXT_PUBLIC_`).
 */
export const VAR_CUENTA_PROPIA = "BVSALA_CUENTA_PROPIA";

export function cuentaCompartidaConLaSuite(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[VAR_CUENTA_PROPIA]?.trim() !== "1";
}
