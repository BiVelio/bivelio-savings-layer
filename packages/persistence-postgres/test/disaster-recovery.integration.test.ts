import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createMockProvider,
  createSavingsLayer,
  InMemoryExactCache,
  InMemorySemanticCache,
} from "../../../src/index.js";
import type { CachedAnswer } from "../../../src/cache/exact.js";
import type { SavingsRequest } from "../../../src/contracts/types.js";
import { canonicalize } from "../../../src/canonicalization/canonicalize.js";
import { PgExactCache, PgSemanticCache } from "../src/index.js";

const connectionString = process.env.BIVELIO_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);
const suffix = randomUUID().replaceAll("-", "");
const sourceName = `bivelio_dr_source_${suffix}`;
const restoreName = `bivelio_dr_restore_${suffix}`;
const namespace = `disaster-recovery-${suffix}`;
const exactKey = `${namespace}-exact`;
const timeout = 90_000;
const calibration = { maxErrorRate: 0.5, confidence: 0.9, auditRate: 0 } as const;
const answer = (text: string): CachedAnswer => ({ text, data: { text }, storedAtMs: 0 });

let admin: Pool;
let source: Pool;
let restored: Pool;
let directory: string;
let binariesAvailable = false;
const storesToClose: Array<PgExactCache | PgSemanticCache> = [];

function databaseUrl(name: string): string {
  const url = new URL(connectionString!);
  url.pathname = `/${name}`;
  return url.toString();
}

function identifier(name: string): string {
  if (!/^bivelio_dr_(source|restore)_[a-f0-9]{32}$/.test(name)) throw new Error("unsafe disposable database name");
  return `"${name}"`;
}

const dockerImage = process.env.BIVELIO_PG_CLIENT_DOCKER;

async function run(command: string, args: string[], url: URL): Promise<void> {
  const env = {
    ...process.env,
    PGPASSWORD: decodeURIComponent(url.password),
    ...(url.searchParams.get("sslmode") ? { PGSSLMODE: url.searchParams.get("sslmode")! } : {}),
  };
  const child = dockerImage
    ? spawn("docker", [
        "run", "--rm", "--add-host=host.docker.internal:host-gateway",
        "-v", `${directory}:/backup`,
        "-e", "PGPASSWORD",
        ...(env.PGSSLMODE ? ["-e", "PGSSLMODE"] : []),
        dockerImage, command, ...args.map((arg) => arg.replace(directory, "/backup")),
      ], { env, stdio: ["ignore", "ignore", "pipe"] })
    : spawn(command, args, { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2_000); });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} failed with exit code ${code}: ${stderr.trim()}`)));
  });
}

async function probeBinary(command: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = dockerImage
      ? spawn("docker", ["run", "--rm", dockerImage, command, "--version"], { stdio: "ignore" })
      : spawn(command, ["--version"], { stdio: "ignore" });
    child.once("error", (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? resolve(false) : reject(error));
    child.once("exit", (code) => code === 0 ? resolve(true) : reject(new Error(`${command} --version failed`)));
  });
}

function pgArguments(url: URL): string[] {
  return [
    "--host", dockerImage ? "host.docker.internal" : decodeURIComponent(url.hostname),
    "--port", url.port || "5432",
    "--username", decodeURIComponent(url.username),
  ];
}

function semantic(pool: Pool): PgSemanticCache {
  const store = new PgSemanticCache({ pool, namespace, calibration, queryTimeoutMs: 5_000 });
  storesToClose.push(store);
  return store;
}

function canonical(text: string, tenantId = "tenant-a") {
  return canonicalize({
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user", content: text }],
    context: { tenantId, sessionId: `${tenantId}-principal` },
  } as SavingsRequest);
}

describePostgres("disposable PostgreSQL backup and restore", () => {
  beforeAll(async () => {
    binariesAvailable = await probeBinary("pg_dump") && await probeBinary("pg_restore");
    if (!binariesAvailable) return;
    admin = new Pool({ connectionString, max: 2, query_timeout: 10_000 });
    await admin.query(`CREATE DATABASE ${identifier(sourceName)}`);
    await admin.query(`CREATE DATABASE ${identifier(restoreName)}`);
    directory = await mkdtemp(join(tmpdir(), "bivelio-persistence-dr-"));
  }, timeout);

  afterAll(async () => {
    await Promise.all(storesToClose.map((store) => store.close()));
    await Promise.all([source?.end(), restored?.end()]);
    if (admin != null) {
      await admin.query(`DROP DATABASE IF EXISTS ${identifier(restoreName)}`);
      await admin.query(`DROP DATABASE IF EXISTS ${identifier(sourceName)}`);
      await admin.end();
    }
    if (directory != null) await rm(directory, { recursive: true, force: true });
  }, timeout);

  it("restores cache and calibration state, rejects stale state, and rolls back to memory", async (context) => {
    if (!binariesAvailable) {
      context.skip("pg_dump and pg_restore are required; install matching PostgreSQL client binaries to run this drill");
      return;
    }

    source = new Pool({ connectionString: databaseUrl(sourceName), max: 8, query_timeout: 5_000 });
    for (const file of ["001_exact_and_breakpoints.sql", "002_semantic_cache.sql"]) {
      await source.query(await readFile(new URL(`../sql/${file}`, import.meta.url), "utf8"));
    }
    const exact = new PgExactCache({ pool: source, queryTimeoutMs: 5_000 });
    storesToClose.push(exact);
    const exactValue = { text: "durable exact answer", data: { version: 1 }, storedAtMs: Date.now() };
    await exact.set(exactKey, exactValue);

    const store = semantic(source);
    const request = canonical("summarize this disposable recovery fixture");
    await store.store(request, answer("durable semantic answer"));
    let stale: Awaited<ReturnType<typeof store.exportCalibrationSnapshot>> | undefined;
    for (let index = 0; index < 40; index++) {
      const result = await store.lookup(request);
      if (result.hit) break;
      expect(result.probe).not.toBeNull();
      expect(await store.observe(result.probe!, answer("durable semantic answer"))).toBe(true);
      stale ??= await store.exportCalibrationSnapshot();
    }
    expect((await store.lookup(request)).hit?.record.answer.text).toBe("durable semantic answer");
    expect(stale?.revision).not.toBeNull();
    const current = await store.exportCalibrationSnapshot();
    expect(BigInt(current.revision!)).toBeGreaterThan(BigInt(stale!.revision!));

    const sourceUrl = new URL(databaseUrl(sourceName));
    const restoreUrl = new URL(databaseUrl(restoreName));
    const dump = join(directory, "backup.dump");
    await run("pg_dump", [
      ...pgArguments(sourceUrl), "--format=custom", "--no-owner", "--no-privileges",
      "--file", dump, "--dbname", sourceName,
    ], sourceUrl);
    await run("pg_restore", [
      ...pgArguments(restoreUrl), "--exit-on-error", "--no-owner", "--no-privileges",
      "--dbname", restoreName, dump,
    ], restoreUrl);

    restored = new Pool({ connectionString: databaseUrl(restoreName), max: 8, query_timeout: 5_000 });
    const restoredExact = new PgExactCache({ pool: restored, queryTimeoutMs: 5_000 });
    storesToClose.push(restoredExact);
    const restoredSemantic = semantic(restored);
    expect(await restoredExact.get(exactKey)).toEqual(exactValue);
    const restoredHit = await restoredSemantic.lookup(request);
    expect(restoredHit.hit?.record.answer.text).toBe("durable semantic answer");
    expect(restoredHit.hit?.calibration?.labeled).toBeGreaterThan(0);
    expect((await restoredSemantic.exportCalibrationSnapshot()).revision).toBe(current.revision);
    await expect(restoredSemantic.importCalibration(stale)).rejects.toThrow("revision or backend changed");
    expect((await restoredSemantic.exportCalibrationSnapshot()).revision).toBe(current.revision);

    const expiringKey = `${namespace}-expired`;
    await restoredExact.set(expiringKey, { text: "expired", storedAtMs: Date.now() }, 5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await restoredExact.purgeExpired()).toBeGreaterThanOrEqual(1);
    expect(await restoredExact.get(expiringKey)).toBeNull();

    await restoredSemantic.store(canonical("delete only this tenant", "tenant-a"), answer("a"));
    await restoredSemantic.store(canonical("delete only this tenant", "tenant-b"), answer("b"));
    expect(await restoredSemantic.deleteTenant("tenant-a")).toBeGreaterThanOrEqual(2);
    expect((await restoredSemantic.lookup(canonical("delete only this tenant", "tenant-b"))).hit?.record.answer.text).toBe("b");
    expect((await restoredSemantic.lookup(canonical("delete only this tenant", "tenant-a"))).hit).toBeNull();

    const rollback = createSavingsLayer({
      provider: createMockProvider({ answer: "memory rollback answer" }),
      exactCache: new InMemoryExactCache(),
      semanticCacheStore: new InMemorySemanticCache(),
      semanticCacheDefault: true,
      devUnlicensed: true,
    } as Parameters<typeof createSavingsLayer>[0]);
    const rollbackRequest: SavingsRequest = {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "memory rollback fixture" }],
    };
    expect((await rollback.generate(rollbackRequest)).report.calls.actualLlm).toBe(1);
    const memoryHit = await rollback.generate(rollbackRequest);
    expect(memoryHit.report.cache.result).toBe("exact");
    expect(memoryHit.report.calls.actualLlm).toBe(0);
    await rollback.close();
  }, timeout);
});
