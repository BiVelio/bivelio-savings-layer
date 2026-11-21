import { describe, expect, it, vi } from "vitest";

/**
 * Verificación final de la 1.2.4 (web): sin la clave de servicio de Supabase,
 * createAdminClient() lanza y la previsualización de una invitación devolvía un
 * 500 sin cuerpo. Ahora responde como cuando falla la lectura: 503 {code:"error"},
 * que la pantalla de invitación ya sabe pintar.
 */
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  },
}));

const pet = (cuerpo: unknown) =>
  new Request("http://localhost/api/org/invitations/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cuerpo),
  });

describe("POST /api/org/invitations/preview sin cliente de servicio", () => {
  it("responde 503 {code:'error'} en lugar de un 500", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await import("./route");
    const res = await POST(pet({ token: "bvi_token_de_prueba" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: "error" });
    error.mockRestore();
  });

  it("sin token sigue siendo 400 antes de tocar Supabase", async () => {
    const { POST } = await import("./route");
    const res = await POST(pet({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "invalida" });
  });
});
