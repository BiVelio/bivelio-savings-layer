import { describe, it, expect } from "vitest";

import { RateLimiter, ipDe } from "./rate-limit";

/**
 * El limitador que impide que /api/contacto agote la cuota de Resend compartida
 * con los correos de auth (fail-closed). Reloj inyectado: cero dependencia del
 * tiempo real.
 */

function conReloj() {
  let t = 1_000_000;
  return { ahora: () => t, avanzar: (ms: number) => (t += ms) };
}

describe("RateLimiter", () => {
  it("deja pasar hasta el máximo por clave y luego 429", () => {
    const r = conReloj();
    const rl = new RateLimiter(10_000, 3, 100, r.ahora);
    expect(rl.permitir("ip-a").ok).toBe(true);
    expect(rl.permitir("ip-a").ok).toBe(true);
    expect(rl.permitir("ip-a").ok).toBe(true);
    const cuarta = rl.permitir("ip-a");
    expect(cuarta.ok).toBe(false);
    if (!cuarta.ok) expect(cuarta.motivo).toBe("clave");
  });

  it("una clave no consume el cupo de otra", () => {
    const r = conReloj();
    const rl = new RateLimiter(10_000, 2, 100, r.ahora);
    expect(rl.permitir("ip-a").ok).toBe(true);
    expect(rl.permitir("ip-a").ok).toBe(true);
    // ip-a agotada, pero ip-b sigue teniendo su propio cupo.
    expect(rl.permitir("ip-a").ok).toBe(false);
    expect(rl.permitir("ip-b").ok).toBe(true);
  });

  it("la ventana DESLIZA: pasado el tiempo, se vuelve a permitir", () => {
    const r = conReloj();
    const rl = new RateLimiter(10_000, 1, 100, r.ahora);
    expect(rl.permitir("ip-a").ok).toBe(true);
    expect(rl.permitir("ip-a").ok).toBe(false);
    r.avanzar(10_001); // fuera de la ventana
    expect(rl.permitir("ip-a").ok).toBe(true);
  });

  it("⛔ el TOPE GLOBAL protege la cuota esencial aunque cada IP esté bajo su límite", () => {
    const r = conReloj();
    // Global 5: aunque cada IP distinta tenga cupo, el endpoint entero no manda
    // más de 5 correos por ventana — el resto de la cuota queda para el auth.
    const rl = new RateLimiter(10_000, 3, 5, r.ahora);
    for (let i = 0; i < 5; i++) expect(rl.permitir(`ip-${i}`).ok).toBe(true);
    const sexta = rl.permitir("ip-nueva");
    expect(sexta.ok).toBe(false);
    if (!sexta.ok) expect(sexta.motivo).toBe("global");
  });

  it("no cuenta las peticiones rechazadas (no penaliza doble)", () => {
    const r = conReloj();
    const rl = new RateLimiter(10_000, 1, 100, r.ahora);
    expect(rl.permitir("ip-a").ok).toBe(true);
    rl.permitir("ip-a"); // rechazada
    rl.permitir("ip-a"); // rechazada
    r.avanzar(10_001);
    // Si las rechazadas hubieran contado, seguiría bloqueada; desliza limpia.
    expect(rl.permitir("ip-a").ok).toBe(true);
  });
});

describe("ipDe", () => {
  const req = (h: Record<string, string>) =>
    new Request("https://x/api/contacto", { method: "POST", headers: h });

  it("toma la primera IP de x-forwarded-for", () => {
    expect(ipDe(req({ "x-forwarded-for": "203.0.113.7, 10.0.0.1, 10.0.0.2" }))).toBe("203.0.113.7");
  });

  it("cae a x-real-ip y luego a 'desconocida'", () => {
    expect(ipDe(req({ "x-real-ip": "198.51.100.9" }))).toBe("198.51.100.9");
    expect(ipDe(req({}))).toBe("desconocida");
  });
});
