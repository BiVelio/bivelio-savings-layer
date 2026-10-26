import { createHash, randomUUID } from "node:crypto";
import {
  CalibrationStateError,
  LOCAL_EMBEDDING_THRESHOLD,
  SemanticCacheSafety,
  SemanticCalibrationJournal,
  localEmbedding,
} from "@bivelio/savings-layer";
import type {
  CachedAnswer,
  EmbeddingFn,
  SemanticCacheOptions,
  SemanticCacheStore,
  SemanticCalibrationState,
  SemanticCalibrationStatus,
  SemanticHit,
  SemanticLookup,
  SemanticProbe,
  SemanticRecord,
  SemanticVerifier,
} from "@bivelio/savings-layer";
import { deserializeCachedAnswer, serializeCachedAnswer } from "./exact.js";
import {
  DATABASE_NOW_MS,
  PgStore,
  type PgPersistenceOptions,
  type PgQueryResultRow,
  type PgQueryRunner,
} from "./shared.js";

interface CanonicalRequest {
  normalizedText: string;
  tenantId: string;
  authorizationScope: string;
  principal: string | null;
  knowledgeEpoch: string;
  contractId: string | null;
  model: string;
  systemPromptHash: string;
  structuredDataHash: string;
  locale: string;
  schemaVersion: string;
  safetyPolicyVersion: string;
  toolsetHash: string;
  toolTurnsHash?: string;
  temperature: number | null;
  seed: number | null;
  reasoningEffort?: string;
}

export interface PgSemanticCacheOptions extends SemanticCacheOptions, PgPersistenceOptions {
  namespace: string;
  candidateLimit?: number;
  lockTimeoutMs?: number;
}

export interface PgSemanticCalibrationSnapshot {
  state: SemanticCalibrationState;
  revision: string | null;
}

interface CalibrationRow extends PgQueryResultRow {
  revision: string;
  backend_identity: string;
  state: unknown;
}

interface SemanticRow extends PgQueryResultRow {
  record_id: string;
  seq: string;
  embedding: string;
  embedding_dimensions: number;
  embedding_norm: number;
  query: string;
  answer: unknown;
  tenant_id: string;
  authorization_scope: string;
  principal: string | null;
  knowledge_epoch: string;
  contract_id: string | null;
  model: string;
  system_prompt_hash: string;
  structured_data_hash: string;
  locale: string;
  schema_version: string;
  safety_policy_version: string;
  toolset_hash: string;
  tool_turns_hash: string | null;
  temperature: number | null;
  seed: number | null;
  reasoning_effort: string | null;
  stored_at_ms: string;
  failed_at_score: number | null;
  similarity: number;
  age_ms: string;
  backend_identity: string | null;
  calibration_state: unknown;
}

const RECORD_COLUMNS = `record_id, seq, embedding, embedding_dimensions, embedding_norm,
  query, answer, tenant_id, authorization_scope, principal, knowledge_epoch,
  contract_id, model, system_prompt_hash, structured_data_hash, locale,
  schema_version, safety_policy_version, toolset_hash, tool_turns_hash,
  temperature, seed, reasoning_effort, stored_at_ms, failed_at_score`;

export class PgSemanticCache extends PgStore implements SemanticCacheStore {
  private readonly namespace: string;
  private readonly candidateLimit: number;
  private readonly lockTimeoutMs: number;
  private readonly embed: EmbeddingFn;
  private readonly verify: SemanticVerifier | undefined;
  private readonly builtInEmbedder: boolean;
  private readonly similarityThreshold: number;
  private readonly acceptThreshold: number;
  private readonly explicitAcceptance: boolean;
  private readonly ttlMs: number | undefined;
  private readonly maxRecords: number;
  private readonly names: { embedder?: string; verifier?: string; judge?: string };
  private readonly calibration: {
    maxErrorRate: number;
    confidence: number;
    auditRate: number;
    judge: NonNullable<SemanticCacheOptions["calibration"]>["judge"];
    perRecordFloors: boolean;
    random: () => number;
  } | undefined;
  private readonly pending = new Set<Promise<boolean | null>>();

  constructor(options: PgSemanticCacheOptions) {
    super(options);
    if (typeof options.namespace !== "string" || options.namespace.trim() === "") {
      throw new TypeError("PgSemanticCache requires a non-empty namespace");
    }
    this.namespace = options.namespace;
    this.candidateLimit = options.candidateLimit ?? 32;
    if (!Number.isSafeInteger(this.candidateLimit) || this.candidateLimit < 1 || this.candidateLimit > 128) {
      throw new RangeError("candidateLimit must be an integer in [1, 128]");
    }
    this.lockTimeoutMs = options.lockTimeoutMs ?? 50;
    if (!Number.isFinite(this.lockTimeoutMs) || this.lockTimeoutMs <= 0) {
      throw new TypeError("lockTimeoutMs must be positive and finite");
    }
    this.builtInEmbedder = options.embed == null;
    this.embed = options.embed ?? localEmbedding;
    this.verify = options.verify;
    this.similarityThreshold = options.similarityThreshold ?? (this.builtInEmbedder ? LOCAL_EMBEDDING_THRESHOLD : 0.9);
    this.acceptThreshold = options.acceptThreshold ?? 0.85;
    this.explicitAcceptance = options.acceptThreshold != null;
    this.ttlMs = options.ttlMs;
    this.maxRecords = options.maxRecords ?? 5_000;
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1) {
      throw new RangeError("maxRecords must be a positive safe integer");
    }
    this.names = {
      ...(options.embedderId != null ? { embedder: options.embedderId } : {}),
      ...(options.verifierId != null ? { verifier: options.verifierId } : {}),
      ...(options.calibration?.judgeId != null ? { judge: options.calibration.judgeId } : {}),
    };
    if (options.calibration) {
      const maxErrorRate = options.calibration.maxErrorRate;
      const confidence = options.calibration.confidence ?? 0.95;
      const auditRate = options.calibration.auditRate ?? 0.05;
      if (!(maxErrorRate > 0 && maxErrorRate <= 0.5)) throw new RangeError("calibration.maxErrorRate must be in (0, 0.5]");
      if (!(confidence > 0.5 && confidence < 1)) throw new RangeError("calibration.confidence must be in (0.5, 1)");
      if (!(auditRate >= 0 && auditRate < 1)) throw new RangeError("calibration.auditRate must be in [0, 1)");
      this.calibration = {
        maxErrorRate,
        confidence,
        auditRate,
        judge: options.calibration.judge ?? SemanticCacheSafety.sameAnswer,
        perRecordFloors: options.calibration.perRecordFloors ?? true,
        random: options.calibration.random ?? Math.random,
      };
    }
  }

  get calibrated(): boolean {
    return this.calibration != null;
  }

  async lookup(c: CanonicalRequest, opts: { agentic?: boolean } = {}): Promise<SemanticLookup> {
    const cal = this.calibration;
    if (!cal) return { hit: null, probe: null };
    const queryEmbedding = await this.embed(c.normalizedText);
    const vector = vectorLiteral(queryEmbedding);
    const distance = this.builtInEmbedder ? "embedding_256" : "embedding";
    const lookup = async (client: PgQueryRunner): Promise<SemanticLookup> => {
      const rows = await client.query<SemanticRow>(
        `SELECT ${RECORD_COLUMNS},
                1 - (${distance} <=> $2::vector) AS similarity,
                ${DATABASE_NOW_MS} - stored_at_ms AS age_ms,
                (SELECT backend_identity FROM bivelio_savings.semantic_calibrations
                 WHERE namespace = $1) AS backend_identity,
                (SELECT state FROM bivelio_savings.semantic_calibrations
                 WHERE namespace = $1) AS calibration_state
         FROM bivelio_savings.semantic_cache_records
         WHERE namespace = $1
           AND embedding_dimensions = $3
           AND embedding_norm > 0
           AND tenant_id = $4
           AND authorization_scope = $5
           AND principal IS NOT DISTINCT FROM $6
           AND knowledge_epoch = $7
           AND contract_id IS NOT DISTINCT FROM $8
           AND model = $9
           AND system_prompt_hash = $10
           AND structured_data_hash = $11
           AND locale = $12
           AND schema_version = $13
           AND safety_policy_version = $14
           AND toolset_hash = $15
           AND tool_turns_hash IS NOT DISTINCT FROM $16
           AND temperature IS NOT DISTINCT FROM $17
           AND seed IS NOT DISTINCT FROM $18
           AND reasoning_effort IS NOT DISTINCT FROM $19
           AND ($20::bigint IS NULL OR stored_at_ms + $20 >= ${DATABASE_NOW_MS})
           AND (${distance} <=> $2::vector) <= 1.0 - $21::double precision
         ORDER BY ${distance} <=> $2::vector, seq
         LIMIT $22`,
        [
          this.namespace, vector, queryEmbedding.length, c.tenantId,
          c.authorizationScope, c.principal, c.knowledgeEpoch, c.contractId,
          c.model, c.systemPromptHash, c.structuredDataHash, c.locale,
          c.schemaVersion, c.safetyPolicyVersion, c.toolsetHash,
          c.toolTurnsHash ?? null, c.temperature, c.seed,
          c.reasoningEffort ?? null, this.ttlMs ?? null,
          this.similarityThreshold, this.candidateLimit,
        ],
      );
      let best: SemanticHit | null = null;
      for (const row of rows.rows) {
        if (!(Number(row.similarity) >= this.similarityThreshold)) continue;
        if (!SemanticCacheSafety.keyTokensMatch(c.normalizedText, row.query)) continue;
        const record = this.record(row);
        const computed = SemanticCacheSafety.cosine(queryEmbedding, record.embedding);
        const similarity = computed >= 1 - 1e-12 ? 1 : computed;
        if (similarity < this.similarityThreshold) continue;
        const verifierScore = this.verify
          ? await this.verify(c.normalizedText, record.query)
          : similarity;
        const confidence = Math.min(similarity, verifierScore);
        if (!best || confidence > best.confidence) {
          best = {
            record,
            similarity,
            verifierScore,
            confidence,
            ageMs: Number(row.age_ms),
            similarityFloor: this.similarityThreshold,
            acceptFloor: this.acceptThreshold,
            embedder: this.builtInEmbedder ? "built_in" : "custom",
            verifierRan: this.verify != null,
          };
        }
      }
      const candidate = best as SemanticHit | null;
      if (!candidate) return { hit: null, probe: null };
      const journal = this.journal(false);
      const calibration = rows.rows[0];
      if (calibration?.backend_identity != null) {
        this.assertBackend(calibration.backend_identity);
        journal.import(calibration.calibration_state);
      }
      const segment: SemanticProbe["segment"] = opts.agentic ? "agentic" : "single_shot";
      const status = journal.status(segment);
      const score = candidate.confidence;
      const probe = (reason: SemanticProbe["reason"]): SemanticLookup => ({
        hit: null,
        probe: {
          reason,
          score,
          segment,
          record: candidate.record,
          observationId: randomUUID(),
        },
      });
      if (status.floor == null) return probe("calibrating");
      if (score < status.floor || (this.explicitAcceptance && score < this.acceptThreshold)) {
        return probe("below_floor");
      }
      if (cal.perRecordFloors && candidate.record.failedAtScore != null && score <= candidate.record.failedAtScore) {
        return probe("record_floor");
      }
      if (cal.auditRate > 0 && cal.random() < cal.auditRate) return probe("audit");
      return {
        hit: {
          ...candidate,
          acceptFloor: this.explicitAcceptance
            ? Math.max(status.floor, this.acceptThreshold)
            : status.floor,
          calibration: {
            maxErrorRate: cal.maxErrorRate,
            confidence: cal.confidence,
            floor: status.floor,
            heldOutAtFloor: status.heldOutAtFloor,
            wrongHeldOutAtFloor: status.wrongHeldOutAtFloor,
            labeled: status.labeled,
            segment,
          },
        },
        probe: null,
      };
    };
    if (this.candidateLimit <= 32) {
      return lookup({ query: (text, values) => this.query(text, values) });
    }
    return this.transaction(lookup, {
      lockTimeoutMs: this.lockTimeoutMs,
      efSearch: Math.max(64, this.candidateLimit * 2),
    });
  }

  async store(c: CanonicalRequest, answer: CachedAnswer): Promise<void> {
    const embedding = await this.embed(c.normalizedText);
    const vector = vectorLiteral(embedding);
    const norm = Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0));
    const serialized = serializeCachedAnswer(answer);
    const recordId = randomUUID();
    const values: unknown[] = [
      this.namespace, recordId, vector,
      this.builtInEmbedder && embedding.length === 256 ? vector : null,
      embedding.length, norm, c.normalizedText, serialized,
      c.tenantId, c.authorizationScope, c.principal, c.knowledgeEpoch,
      c.contractId, c.model, c.systemPromptHash, c.structuredDataHash,
      c.locale, c.schemaVersion, c.safetyPolicyVersion, c.toolsetHash,
      c.toolTurnsHash ?? null, c.temperature, c.seed, c.reasoningEffort ?? null,
    ];
    const columns = `namespace, record_id, embedding, embedding_256,
      embedding_dimensions, embedding_norm, query, answer, tenant_id,
      authorization_scope, principal, knowledge_epoch, contract_id, model,
      system_prompt_hash, structured_data_hash, locale, schema_version,
      safety_policy_version, toolset_hash, tool_turns_hash, temperature,
      seed, reasoning_effort, stored_at_ms`;
    await this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7919))", [this.namespace]);
      await client.query(
        `INSERT INTO bivelio_savings.semantic_cache_records (${columns})
         VALUES (${values.map((_, index) => `$${index + 1}`).join(", ")}, ${DATABASE_NOW_MS})`,
        values,
      );
      await client.query(
        `DELETE FROM bivelio_savings.semantic_cache_records
         WHERE namespace = $1 AND seq <= (
           SELECT seq FROM bivelio_savings.semantic_cache_records
           WHERE namespace = $1 ORDER BY seq DESC OFFSET $2 LIMIT 1
         )`,
        [this.namespace, this.maxRecords],
      );
    }, { lockTimeoutMs: this.lockTimeoutMs });
  }

  observe(probe: SemanticProbe, fresh: CachedAnswer): Promise<boolean | null> {
    const pending = this.label(probe, fresh);
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending));
    return pending;
  }

  private async label(probe: SemanticProbe, fresh: CachedAnswer): Promise<boolean | null> {
    const cal = this.calibration;
    if (!cal || !probe.observationId || !probe.record.recordId) return null;
    let correct: boolean;
    try {
      correct = (await cal.judge!(probe.record.answer, fresh)) === true;
    } catch {
      return null;
    }
    const fingerprint = observationFingerprint(probe, fresh, correct);
    try {
      return await this.transaction(async (client) => {
        const empty = this.journal(false).export();
        await client.query(
          `INSERT INTO bivelio_savings.semantic_calibrations
             (namespace, revision, backend_identity, state, updated_at_ms)
           VALUES ($1, 0, $2, $3::jsonb, ${DATABASE_NOW_MS})
           ON CONFLICT (namespace) DO NOTHING`,
          [this.namespace, this.backendIdentity(), JSON.stringify(empty)],
        );
        const current = await client.query<CalibrationRow>(
          `SELECT revision, backend_identity, state
           FROM bivelio_savings.semantic_calibrations
           WHERE namespace = $1 FOR UPDATE`,
          [this.namespace],
        );
        const row = current.rows[0];
        if (!row) throw new CalibrationStateError("calibration row disappeared during observation");
        this.assertBackend(row.backend_identity);
        const duplicate = await client.query<{ correct: boolean; payload_fingerprint: string }>(
          `SELECT correct, payload_fingerprint
           FROM bivelio_savings.semantic_calibration_observations
           WHERE namespace = $1 AND observation_id = $2`,
          [this.namespace, probe.observationId],
        );
        const previous = duplicate.rows[0];
        if (previous) {
          if (previous.payload_fingerprint !== fingerprint) {
            throw new CalibrationStateError("observationId was already used for a different payload");
          }
          return previous.correct;
        }
        const journal = this.journal(false);
        journal.import(row.state);
        journal.record(probe.segment, probe.score, correct);
        await client.query(
          `UPDATE bivelio_savings.semantic_calibrations
           SET state = $2::jsonb, revision = revision + 1, updated_at_ms = ${DATABASE_NOW_MS}
           WHERE namespace = $1`,
          [this.namespace, JSON.stringify(journal.export())],
        );
        if (!correct && cal.perRecordFloors) {
          await client.query(
            `UPDATE bivelio_savings.semantic_cache_records
             SET failed_at_score = GREATEST(COALESCE(failed_at_score, '-Infinity'::double precision), $3)
             WHERE namespace = $1 AND record_id = $2`,
            [this.namespace, probe.record.recordId, probe.score],
          );
        }
        await client.query(
          `INSERT INTO bivelio_savings.semantic_calibration_observations
             (namespace, observation_id, segment, record_id, score, correct,
              payload_fingerprint, created_at_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, ${DATABASE_NOW_MS})`,
          [
            this.namespace, probe.observationId, probe.segment,
            probe.record.recordId, probe.score, correct, fingerprint,
          ],
        );
        return correct;
      }, { lockTimeoutMs: this.lockTimeoutMs });
    } catch {
      return null;
    }
  }

  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  async calibrationStatus(
    segment: SemanticProbe["segment"] = "single_shot",
  ): Promise<SemanticCalibrationStatus | null> {
    if (!this.calibration) return null;
    return this.transaction(async (client) => (await this.readJournal(client)).status(segment));
  }

  async exportCalibrationSnapshot(): Promise<PgSemanticCalibrationSnapshot> {
    this.journal(true);
    await this.settled();
    return this.transaction(async (client) => {
      const result = await client.query<CalibrationRow>(
        `SELECT revision, backend_identity, state
         FROM bivelio_savings.semantic_calibrations WHERE namespace = $1`,
        [this.namespace],
      );
      const row = result.rows[0];
      if (!row) return { state: this.journal(true).export(), revision: null };
      this.assertBackend(row.backend_identity);
      return { state: row.state as SemanticCalibrationState, revision: String(row.revision) };
    });
  }

  async exportCalibration(): Promise<SemanticCalibrationState> {
    return (await this.exportCalibrationSnapshot()).state;
  }

  async importCalibration(snapshot: PgSemanticCalibrationSnapshot): Promise<void> {
    const journal = this.journal(true);
    journal.import(snapshot.state);
    await this.settled();
    await this.transaction(async (client) => {
      const state = JSON.stringify(journal.export());
      if (snapshot.revision === null) {
        const inserted = await client.query(
          `INSERT INTO bivelio_savings.semantic_calibrations
             (namespace, revision, backend_identity, state, updated_at_ms)
           VALUES ($1, 0, $2, $3::jsonb, ${DATABASE_NOW_MS})
           ON CONFLICT (namespace) DO NOTHING RETURNING revision`,
          [this.namespace, this.backendIdentity(), state],
        );
        if (inserted.rows.length !== 1) throw new CalibrationStateError("calibration already exists");
        return;
      }
      const updated = await client.query(
        `UPDATE bivelio_savings.semantic_calibrations
         SET state = $2::jsonb, revision = revision + 1, updated_at_ms = ${DATABASE_NOW_MS}
         WHERE namespace = $1 AND revision = $3::bigint AND backend_identity = $4
         RETURNING revision`,
        [this.namespace, state, snapshot.revision, this.backendIdentity()],
      );
      if (updated.rows.length !== 1) throw new CalibrationStateError("calibration revision or backend changed");
    }, { lockTimeoutMs: this.lockTimeoutMs });
  }

  async invalidateEpoch(knowledgeEpoch: string): Promise<number> {
    const result = await this.query(
      "DELETE FROM bivelio_savings.semantic_cache_records WHERE namespace = $1 AND knowledge_epoch = $2",
      [this.namespace, knowledgeEpoch],
    );
    return result.rowCount ?? 0;
  }

  async deleteTenant(tenantId: string): Promise<number> {
    const result = await this.query(
      "DELETE FROM bivelio_savings.semantic_cache_records WHERE namespace = $1 AND tenant_id = $2",
      [this.namespace, tenantId],
    );
    return result.rowCount ?? 0;
  }

  async count(): Promise<number> {
    const result = await this.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM bivelio_savings.semantic_cache_records WHERE namespace = $1",
      [this.namespace],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  override async close(): Promise<void> {
    await this.settled();
    await super.close();
  }

  private record(row: SemanticRow): SemanticRecord {
    return {
      recordId: row.record_id,
      embedding: parseVector(row.embedding),
      query: row.query,
      answer: deserializeCachedAnswer(row.answer, false),
      tenantId: row.tenant_id,
      authorizationScope: row.authorization_scope,
      principal: row.principal,
      knowledgeEpoch: row.knowledge_epoch,
      contractId: row.contract_id,
      model: row.model,
      systemPromptHash: row.system_prompt_hash,
      structuredDataHash: row.structured_data_hash,
      locale: row.locale,
      schemaVersion: row.schema_version,
      safetyPolicyVersion: row.safety_policy_version,
      toolsetHash: row.toolset_hash,
      ...(row.tool_turns_hash != null ? { toolTurnsHash: row.tool_turns_hash } : {}),
      temperature: row.temperature,
      seed: row.seed,
      ...(row.reasoning_effort != null ? { reasoningEffort: row.reasoning_effort } : {}),
      storedAtMs: Number(row.stored_at_ms),
      ...(row.failed_at_score != null ? { failedAtScore: row.failed_at_score } : {}),
    };
  }

  private async readJournal(client: PgQueryRunner): Promise<SemanticCalibrationJournal> {
    const result = await client.query<CalibrationRow>(
      `SELECT revision, backend_identity, state
       FROM bivelio_savings.semantic_calibrations WHERE namespace = $1`,
      [this.namespace],
    );
    const journal = this.journal(false);
    const row = result.rows[0];
    if (row) {
      this.assertBackend(row.backend_identity);
      journal.import(row.state);
    }
    return journal;
  }

  private journal(strictNames: boolean): SemanticCalibrationJournal {
    const missing = (option: string): string => {
      if (strictNames) throw new CalibrationStateError(`pass ${option} before importing or exporting PostgreSQL calibration`);
      return "unnamed";
    };
    return new SemanticCalibrationJournal({
      embedder: this.builtInEmbedder
        ? "built_in:lexical-256-v1"
        : `custom:${this.names.embedder ?? missing("embedderId")}`,
      verifier: this.verify == null
        ? null
        : `custom:${this.names.verifier ?? missing("verifierId")}`,
      judge: this.calibration?.judge === SemanticCacheSafety.sameAnswer
        ? "built_in:same-answer-v1"
        : `custom:${this.names.judge ?? missing("calibration.judgeId")}`,
      maxErrorRate: this.calibration!.maxErrorRate,
      confidence: this.calibration!.confidence,
      similarityThreshold: this.similarityThreshold,
      backend: this.backendIdentity(),
    });
  }

  private backendIdentity(): string {
    return `postgres-${this.builtInEmbedder ? "hnsw" : "scan"}-cosine-v1;guard=key-tokens-v1;candidates=${this.candidateLimit}`;
  }

  private assertBackend(actual: string): void {
    if (actual !== this.backendIdentity()) {
      throw new CalibrationStateError(`PostgreSQL calibration backend mismatch: ${actual} !== ${this.backendIdentity()}`);
    }
  }
}

function vectorLiteral(embedding: number[]): string {
  if (!Array.isArray(embedding) || embedding.length === 0 || embedding.some((value) => !Number.isFinite(value))) {
    throw new TypeError("Embedding must be a non-empty array of finite numbers");
  }
  return `[${embedding.join(",")}]`;
}

function parseVector(value: string): number[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new TypeError("PostgreSQL returned an invalid embedding");
  }
  return parsed as number[];
}

function observationFingerprint(probe: SemanticProbe, fresh: CachedAnswer, correct: boolean): string {
  return createHash("sha256").update(JSON.stringify({
    observationId: probe.observationId,
    segment: probe.segment,
    recordId: probe.record.recordId,
    score: probe.score,
    correct,
    fresh,
  })).digest("hex");
}
