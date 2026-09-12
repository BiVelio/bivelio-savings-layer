import { describe, it, expect } from "vitest";

import { claveDeErrorDeAuth, textoDeErrorDeAuth } from "./error-de-auth";

/** Como los construye @supabase/auth-js: un Error con `code` y `status`. */
const errorDeSupabase = (code: string, message = "mensaje de supabase") =>
  Object.assign(new Error(message), { name: "AuthApiError", code, status: 400 });

const t = (clave: string) => `[${clave}]`;

describe("del código de Supabase a nuestra clave de texto", () => {
  it.each([
    ["invalid_credentials", "invalidCredentials"],
    ["user_already_exists", "userExists"],
    ["email_exists", "userExists"],
    ["weak_password", "weakPassword"],
    ["over_email_send_rate_limit", "rateLimit"],
    ["over_request_rate_limit", "rateLimit"],
    ["email_not_confirmed", "emailNotConfirmed"],
    ["same_password", "samePassword"],
    ["email_address_invalid", "emailInvalid"],
    ["signup_disabled", "signupDisabled"],
  ])("%s → %s", (code, clave) => {
    expect(claveDeErrorDeAuth(errorDeSupabase(code))).toBe(clave);
  });

  it("un código desconocido NO se traduce: se enseña el mensaje original, no un genérico", () => {
    const err = errorDeSupabase("hook_timeout", "Hook timed out");
    expect(claveDeErrorDeAuth(err)).toBeNull();
    expect(textoDeErrorDeAuth(err, t)).toBe("Hook timed out");
  });

  it("sin red se dice que no hay conexión: supabase-js envuelve el fallo de fetch en AuthRetryableFetchError con status 0", () => {
    const sinRed = Object.assign(new Error("Failed to fetch"), { name: "AuthRetryableFetchError", status: 0, code: undefined });
    expect(claveDeErrorDeAuth(sinRed)).toBe("network");
    // Y el TypeError desnudo también, por si algún día deja de envolverlo.
    expect(claveDeErrorDeAuth(new TypeError("Load failed"))).toBe("network");
  });

  it("validation_failed NO se traduce como «correo no válido»: Supabase lo usa para cualquier validación", () => {
    const err = errorDeSupabase("validation_failed", "Password cannot be longer than 72 characters");
    expect(claveDeErrorDeAuth(err)).toBeNull();
    expect(textoDeErrorDeAuth(err, t)).toBe("Password cannot be longer than 72 characters");
  });

  it("lo que no es ni un Error cae al genérico", () => {
    expect(claveDeErrorDeAuth("cadena")).toBeNull();
    expect(claveDeErrorDeAuth(null)).toBeNull();
    expect(textoDeErrorDeAuth(undefined, t)).toBe("[somethingWrong]");
  });

  it("el texto traducido sale del espacio auth.errors.*", () => {
    expect(textoDeErrorDeAuth(errorDeSupabase("invalid_credentials"), t)).toBe("[errors.invalidCredentials]");
  });
});
