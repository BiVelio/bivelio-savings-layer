/**
 * DEL CÓDIGO DE ERROR DE SUPABASE A UNA CLAVE DE TEXTO NUESTRA.
 *
 * Hasta el 2026-09-12 el formulario de acceso enseñaba `err.message` tal cual:
 * «Invalid login credentials», «Password should be at least 6 characters»,
 * «For security purposes, you can only request this after 52 seconds»… en
 * inglés y con la voz de Supabase, en una web que habla doce idiomas. Para un
 * probador que se equivoca de contraseña es el primer sobresalto de la cuenta.
 *
 * Supabase adjunta un `code` estable a casi todos sus errores HTTP
 * (`AuthApiError.code`, tipo `ErrorCode`). Se mapean los que un usuario puede
 * provocar desde el formulario; lo demás conserva el mensaje original, porque
 * un texto en inglés es mejor que un «algo salió mal» que no dice nada.
 */

/** Clave dentro del espacio `auth.errors.*` de los mensajes. */
export type ClaveDeErrorDeAuth =
  | "userExists"
  | "weakPassword"
  | "rateLimit"
  | "invalidCredentials"
  | "emailNotConfirmed"
  | "samePassword"
  | "emailInvalid"
  | "signupDisabled"
  | "network";

const POR_CODIGO: Record<string, ClaveDeErrorDeAuth> = {
  user_already_exists: "userExists",
  email_exists: "userExists",
  weak_password: "weakPassword",
  over_email_send_rate_limit: "rateLimit",
  over_request_rate_limit: "rateLimit",
  over_sms_send_rate_limit: "rateLimit",
  invalid_credentials: "invalidCredentials",
  email_not_confirmed: "emailNotConfirmed",
  same_password: "samePassword",
  email_address_invalid: "emailInvalid",
  validation_failed: "emailInvalid",
  signup_disabled: "signupDisabled",
  email_provider_disabled: "signupDisabled",
};

/**
 * Devuelve la clave de texto para un error de auth, o `null` si no hay
 * traducción conocida (y entonces el llamante enseña el mensaje original).
 */
export function claveDeErrorDeAuth(err: unknown): ClaveDeErrorDeAuth | null {
  if (!err || typeof err !== "object") return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && code in POR_CODIGO) return POR_CODIGO[code];
  // Sin red: `fetch` revienta con un TypeError antes de que Supabase conteste.
  // No trae `code`, pero es el error más común en una demo con wifi de hotel.
  if (err instanceof TypeError && /fetch|network|load failed/i.test(err.message)) return "network";
  return null;
}

/**
 * El texto que enseña el formulario: traducido si el código se conoce, el
 * mensaje original si no, y el genérico solo cuando ni eso hay.
 */
export function textoDeErrorDeAuth(
  err: unknown,
  t: (clave: string) => string,
): string {
  const clave = claveDeErrorDeAuth(err);
  if (clave) return t(`errors.${clave}`);
  if (err instanceof Error && err.message) return err.message;
  return t("somethingWrong");
}
