import { describe, it, expect } from "vitest";
// Fichero de PRUEBA de la verja de CI. Debe borrarse en cuanto se compruebe.
describe("prueba de la verja", () => {
  it("falla a propósito para comprobar que CI bloquea el merge", () => {
    expect(1).toBe(2);
  });
});
