/**
 * ¿LA CUENTA DE SAVINGS ES LA MISMA QUE LA DEL RESTO DE BIVELIO? — un interruptor, APAGADO por defecto.
 *
 * Hoy sí: Savings y Privacy usan el mismo proyecto de Supabase, y la web lo
 * promete en cinco sitios (claves en `LAS_PROMESAS`, cuenta-compartida.test.ts):
 *   · la entradilla de la entrada    `auth.loginSubtitle`  («…la misma que usas en toda la suite»);
 *   · la entradilla del alta         `auth.signupSubtitle` («Una cuenta BiVelio para toda la suite…»);
 *   · la nota del alta               `auth.signupSsoNote`  («¿Ya usas BiVelio Shield o Privacy? La misma cuenta te sirve aquí»);
 *   · la entradilla de Cuenta        `dashboard.account.intro`;
 *   · la nota «Personal» del plan    `dashboard.accountPlanStrip.personalNote`.
 * El día que las cuentas se separen (Privacy en su propio proyecto, o Savings
 * en el suyo) esas frases pasan a ser falsas: quien siga el consejo e intente
 * entrar con la cuenta de Privacy no podrá.
 *
 * `BVSALA_CUENTA_PROPIA=1` las quita: las dos entradillas de acceso y la nota
 * «Personal» pasan a su variante `…SinSuite` (la misma frase sin la parte de la
 * suite), y la nota del alta y la entradilla de Cuenta no se pintan. Un test
 * busca la suite y Shield en todos los mensajes para que no se escape una
 * sexta. Se enciende EL MISMO DÍA que se separan
 * las cuentas, no antes. Vacía o con cualquier otro valor (hoy) = como siempre.
 * Solo la leen componentes de servidor (no es `NEXT_PUBLIC_`).
 */
export const VAR_CUENTA_PROPIA = "BVSALA_CUENTA_PROPIA";

export function cuentaCompartidaConLaSuite(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[VAR_CUENTA_PROPIA]?.trim() !== "1";
}
