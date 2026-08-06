import { sha256 as hashSha256 } from "../util/hash.js";
import type { ChatMessage, SavingsRequest } from "../contracts/types.js";

/**
 * Canonicalization turns a raw request into a normalized, hashable form. This
 * is what makes the exact cache safe and the singleflight key correct: two
 * requests that mean the same thing must canonicalize identically, and two
 * requests that differ in any way that could change the answer must not.
 */
export interface CanonicalRequest {
  model: string;
  modelFamily: string;
  messages: ChatMessage[];
  /** Whitespace/case-normalized text of the user-visible turns. */
  normalizedText: string;
  systemPromptHash: string;
  toolsetHash: string;
  /** Hash of the structured payload; part of the cache key so different data never collides. */
  structuredDataHash: string;
  schemaVersion: string;
  contractId: string | null;
  temperature: number | null;
  seed: number | null;
  tenantId: string;
  authorizationScope: string;
  /**
   * Quién pregunta, dentro del tenant. Sale de `context.sessionId`.
   *
   * Es lo que permite cachear una respuesta PERSONALIZADA sin servírsela a otro:
   * tenant y scope son compartidos por defecto, así que sin esto dos usuarios de
   * la misma organización comparten entrada de caché. `null` cuando no se
   * aporta, y entonces la política apaga la caché exacta para ese tráfico.
   */
  principal: string | null;
  locale: string;
  knowledgeEpoch: string;
  freshnessBucket: string;
  safetyPolicyVersion: string;
  tokenizer: string | undefined;
  original: SavingsRequest;
}

const WS = /\s+/g;

export function normalizeText(text: string): string {
  return text.trim().replace(WS, " ").toLowerCase();
}

export function sha256(input: string): string {
  return hashSha256(input);
}

/** Stable JSON stringify with sorted keys so hashes are order-independent. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function modelFamilyOf(model: string): string {
  // "openai/gpt-4o-mini" -> "openai/gpt-4o", "gpt-4o-mini-2024" -> "gpt-4o".
  const noVersion = model.replace(/[-_]?\d{4,}.*$/, "");
  return noVersion.replace(/[-_](mini|nano|small|large|latest)$/i, "");
}

export function canonicalize(request: SavingsRequest): CanonicalRequest {
  const ctx = request.context ?? {};

  const systemMessages = request.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");

  const conversational = request.messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role}:${normalizeText(m.content)}`)
    .join("\n");

  const tools = (request.tools ?? [])
    .map((t) => ({ id: t.id, risk: t.risk, parameters: t.parameters ?? null }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    model: request.model,
    modelFamily: modelFamilyOf(request.model),
    messages: request.messages,
    normalizedText: conversational,
    systemPromptHash: sha256(systemMessages),
    toolsetHash: sha256(stableStringify(tools)),
    structuredDataHash:
      request.structuredData !== undefined
        ? sha256(stableStringify(request.structuredData))
        : "none",
    schemaVersion: request.response?.version ?? request.response?.contractId ?? "none",
    contractId: request.response?.contractId ?? null,
    temperature: request.temperature ?? null,
    seed: request.seed ?? null,
    tenantId: ctx.tenantId ?? "anonymous",
    authorizationScope: ctx.authorizationScope ?? "default",
    principal: ctx.sessionId ?? null,
    locale: ctx.locale ?? "und",
    knowledgeEpoch: ctx.knowledgeEpoch ?? "none",
    freshnessBucket: ctx.freshnessBucket ?? "any",
    safetyPolicyVersion: ctx.safetyPolicyVersion ?? "none",
    tokenizer: request.tokenizer,
    original: request,
  };
}
