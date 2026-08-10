import { describe, it, expect } from "vitest";

import { canonicalize } from "../src/canonicalization/canonicalize.js";
import { evaluatePolicy } from "../src/policy/policy.js";
import { buildInflightKey } from "../src/canonicalization/keys.js";

const pedir = (text: string, context?: Record<string, unknown>) =>
  evaluatePolicy(
    canonicalize({
      messages: [{ role: "user", content: text }],
      model: "openai/gpt-4o-mini",
      ...(context ? { context } : {}),
    } as never),
  );

/**
 * La política de frescura estaba INVERTIDA: `freshWithoutBucket` solo era cierto
 * con el bucket ausente o "any", así que declarar `freshnessBucket: "live"` —lo
 * más estricto que puede decir un integrador— era justo lo que ENCENDÍA la caché
 * exacta, con TTL de 24 h y una clave que no rota (el bucket es un literal fijo
 * que va crudo al hash). El que hacía bien su trabajo recibía el peor trato.
 */
describe("política de frescura — el bucket manda en la dirección correcta", () => {
  it("live NO se cachea: la respuesta debe ser de ahora", () => {
    const p = pedir("what is the current price of BTC?", { freshnessBucket: "live" });
    expect(p.allowExactCache).toBe(false);
    expect(p.reasons.join(" ")).toContain("live");
  });

  it("hour se cachea pero con techo de 1 h", () => {
    const p = pedir("dame el precio actual", { freshnessBucket: "hour" });
    expect(p.allowExactCache).toBe(true);
    expect(p.maxCacheAgeMs).toBe(3_600_000);
  });

  it("day se cachea con techo de 24 h", () => {
    const p = pedir("precio actual", { freshnessBucket: "day" });
    expect(p.allowExactCache).toBe(true);
    expect(p.maxCacheAgeMs).toBe(86_400_000);
  });

  it("sin bucket y con texto que huele a frescura, sigue sin cachearse", () => {
    expect(pedir("what is the current price of BTC?").allowExactCache).toBe(false);
  });

  it("una consulta estable y sin bucket sí se cachea, sin techo propio", () => {
    const p = pedir("explain what a monad is");
    expect(p.allowExactCache).toBe(true);
    expect(p.maxCacheAgeMs).toBeNull();
  });
});

/**
 * `PERSONAL_MARKERS` solo entendía inglés y español. De ahí sale lo único que
 * apaga la caché exacta y el singleflight cuando no hay `principal`, así que en
 * los otros 10 idiomas dos usuarios del mismo tenant compartían entrada: el
 * segundo recibía los datos del primero, y el informe lo apuntaba como ahorro.
 */
describe("marcadores personales — los 12 idiomas que se venden", () => {
  const casos: [string, string][] = [
    ["de", "Wie hoch ist mein Kontostand?"],
    ["fr", "Quel est le solde de mon compte ?"],
    ["it", "Qual è il saldo del mio conto?"],
    ["pt", "Qual é o saldo da minha conta?"],
    ["nl", "Wat is het saldo van mijn rekening?"],
    ["pl", "Jakie jest saldo mojego konta?"],
    ["tr", "Hesap bakiyem nedir?"],
    ["id", "Berapa saldo akun saya?"],
    ["ca", "Quin és el saldo del meu compte?"],
    ["vi", "Số dư tài khoản của tôi là bao nhiêu?"],
    ["en", "what is my account balance?"],
    ["es", "cuál es el saldo de mi cuenta?"],
  ];

  for (const [idioma, texto] of casos) {
    it(`${idioma}: detecta la personalización y apaga la caché sin principal`, () => {
      const p = pedir(texto);
      expect(p.isPersonalized, `no detectado en ${idioma}: ${texto}`).toBe(true);
      expect(p.allowExactCache).toBe(false);
      expect(p.allowSingleflight).toBe(false);
    });
  }

  it("con principal sí se cachea: la clave ya aísla a quien pregunta", () => {
    const p = pedir("Wie hoch ist mein Kontostand?", { sessionId: "usuario-1" });
    expect(p.isPersonalized).toBe(true);
    expect(p.allowExactCache).toBe(true);
  });

  it("una consulta no personalizada no se ve afectada en ningún idioma", () => {
    expect(pedir("Was ist ein Monad?").isPersonalized).toBe(false);
    expect(pedir("Co to jest monada?").isPersonalized).toBe(false);
  });
});

/**
 * `buildInflightKey` no incluía `schemaVersion`, así que dos generate()
 * concurrentes que solo difieren en el esquema de salida colapsaban en uno y el
 * seguidor recibía un objeto de OTRO contrato marcado como válido.
 */
describe("clave de singleflight — el esquema de salida separa", () => {
  const base = {
    messages: [{ role: "user", content: "dame la respuesta" }],
    model: "openai/gpt-4o-mini",
  };
  // `canonicalize` deriva schemaVersion de `response.version` (canonicalize.ts:104).
  const con = (version: string) =>
    buildInflightKey(canonicalize({ ...base, response: { version } } as never));

  it("dos esquemas distintos NO comparten clave", () => {
    expect(con("v1")).not.toBe(con("v2"));
  });

  it("el mismo esquema sí coalesce", () => {
    expect(con("v1")).toBe(con("v1"));
  });
});
