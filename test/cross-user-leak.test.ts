import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { InMemorySemanticCache } from "../src/cache/semantic.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { SavingsRequest } from "../src/contracts/types.js";
import type { CanonicalRequest } from "../src/canonicalization/canonicalize.js";
import { CALIBRACION_DE_PRUEBA, certificarCacheSemantica } from "./helpers/semantic-cache.js";

/**
 * La clase de fallo más cara de una capa de caché: servir a un usuario la
 * respuesta calculada para otro. La auditoría de publicación la encontró por DOS
 * vías independientes, las dos en features de pago:
 *
 *   B2 — la caché semántica no tenía el campo `principal`, así que dos personas
 *        del mismo tenant con la misma pregunta casaban por embedding.
 *   B3 — singleflight fusiona dos peticiones idénticas concurrentes y le da a
 *        las dos la misma respuesta; ignoraba `personalizedWithoutPrincipal`.
 */

/** Responde algo distinto a cada llamada, para poder detectar la fuga. */
class ProveedorPersonal implements Provider {
  readonly id = "personal";
  private n = 0;
  constructor(private readonly demora = 0) {}
  async generate(_r: ProviderRequest): Promise<ProviderResponse> {
    const mio = ++this.n; // capturar ANTES del await: si no, dos concurrentes leen el mismo contador
    if (this.demora) await new Promise((r) => setTimeout(r, this.demora));
    return { text: `saldo del usuario ${mio}`, usage: { inputTokens: 40, outputTokens: 8 } };
  }
}

/** Embedding de juguete: dos textos casi iguales salen casi idénticos. */
const embed = async (t: string): Promise<number[]> =>
  [0, 1, 2, 3].map((i) => [...t].filter((c) => c.charCodeAt(0) % 4 === i).length);

/**
 * B2 se prueba DIRECTO contra la caché, no vía el pipeline. Motivo honesto: la
 * política ya apaga la caché semántica para una petición detectada como
 * personalizada (`!isPersonalized` es condición de `allowSemanticCache`), así que
 * una petición "mi saldo" nunca llega a almacenarse. El filtro por `principal`
 * es defensa en profundidad: cierra el hueco cuando la detección de
 * personalización falla y una respuesta con dueño acaba guardada igualmente.
 * Aquí se guarda a mano —simulando ese hueco— y se comprueba el aislamiento.
 */
describe("B2 · la caché semántica aísla por principal", () => {
  const canonical = (principal: string | null): CanonicalRequest =>
    ({
      normalizedText: "cual es el saldo de la cuenta",
      tenantId: "acme", authorizationScope: "default", principal,
      knowledgeEpoch: "e1", contractId: null,
      model: "openai/gpt-4o-mini", systemPromptHash: "h", structuredDataHash: "d",
      locale: "es", schemaVersion: "v1", safetyPolicyVersion: "v1",
    }) as unknown as CanonicalRequest;

  it("la respuesta de un usuario NO se sirve a otro", async () => {
    const cache = new InMemorySemanticCache({ embed, similarityThreshold: 0.3, acceptThreshold: 0.3, calibration: CALIBRACION_DE_PRUEBA });
    await certificarCacheSemantica(cache, canonical("ana"), { text: "saldo de Ana", data: null, storedAtMs: 0 });

    // Mismo texto, mismo tenant, OTRA persona. Sin el filtro por principal,
    // Luis recibía el saldo de Ana.
    const hit = await cache.find(canonical("luis"));
    expect(hit).toBeNull();
  });

  it("la MISMA persona sí reutiliza su respuesta (sin regresión)", async () => {
    const cache = new InMemorySemanticCache({ embed, similarityThreshold: 0.3, acceptThreshold: 0.3, calibration: CALIBRACION_DE_PRUEBA });
    await certificarCacheSemantica(cache, canonical("ana"), { text: "saldo de Ana", data: null, storedAtMs: 0 });

    const hit = await cache.find(canonical("ana"));
    expect(hit?.record.answer.text).toBe("saldo de Ana");
  });

  it("dos peticiones anónimas del mismo tenant sí comparten (null === null)", async () => {
    // No hay a quién aislar: apagar esto sería el bug opuesto, matar el cacheo.
    const cache = new InMemorySemanticCache({ embed, similarityThreshold: 0.3, acceptThreshold: 0.3, calibration: CALIBRACION_DE_PRUEBA });
    await certificarCacheSemantica(cache, canonical(null), { text: "dato público", data: null, storedAtMs: 0 });

    const hit = await cache.find(canonical(null));
    expect(hit?.record.answer.text).toBe("dato público");
  });
});

describe("B3 · singleflight no cruza de usuario", () => {
  it("dos peticiones personalizadas concurrentes SIN principal no se fusionan", async () => {
    // El proveedor tarda, así que las dos entran a la vez: es la condición de la
    // fuga. Sin principal, la política ahora apaga singleflight, y cada usuario
    // recibe su propia llamada.
    const provider = new ProveedorPersonal(30);
    const layer = createSavingsLayer({ provider, devUnlicensed: true });
    // Petición personalizada ("mi saldo") SIN sessionId. El toggle de caché no
    // interviene aquí: lo que se prueba es la fusión concurrente.
    const personal = (): SavingsRequest => ({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "cuál es mi saldo actual, por favor" }],
      context: { tenantId: "acme", knowledgeEpoch: "e1" },
    });

    const [a, b] = await Promise.all([layer.generate(personal()), layer.generate(personal())]);

    expect(a.text).not.toBe(b.text);
  });

  it("tráfico NO personalizado sí puede fusionar (sin regresión)", async () => {
    const provider = new ProveedorPersonal(30);
    const layer = createSavingsLayer({ provider, devUnlicensed: true });
    const generica: SavingsRequest = {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "en qué año se firmó el tratado de Utrecht" }],
      context: { tenantId: "acme" },
    };

    const [a, b] = await Promise.all([layer.generate(generica), layer.generate(generica)]);
    // Sin marca de personalización, fusionar es seguro y deseable.
    expect(a.text).toBe(b.text);
  });
});
