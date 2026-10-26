import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const out = join(root, "benchmarks", "out", "release-candidate");
const sdkVersion = "0.6.0-rc.1";
const persistenceVersion = "0.1.0-rc.1";
const sdkTgz = join(out, `bivelio-savings-layer-${sdkVersion}.tgz`);
const persistenceTgz = join(out, `bivelio-persistence-postgres-${persistenceVersion}.tgz`);

function run(command: string, args: string[], cwd = root): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function runAudit(command: string, args: string[], cwd: string): Record<string, unknown> {
  try {
    return JSON.parse(run(command, args, cwd)) as Record<string, unknown>;
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    if (stdout) return JSON.parse(stdout) as Record<string, unknown>;
    throw error;
  }
}

function manifest(tarball: string): Record<string, unknown> {
  const text = run("tar", ["xOf", tarball, "package/package.json"]);
  return JSON.parse(text) as Record<string, unknown>;
}

function verifyTarball(tarball: string, expectedName: string, expectedVersion: string): void {
  const files = run("tar", ["tzf", tarball]);
  if (files.includes(".map") || /PRIVATE KEY|workspace:/i.test(files)) throw new Error(`unsafe files in ${tarball}`);
  const pkg = manifest(tarball);
  if (pkg.name !== expectedName || pkg.version !== expectedVersion) throw new Error(`wrong manifest in ${tarball}`);
  if (JSON.stringify(pkg).includes("workspace:")) throw new Error(`workspace protocol in ${tarball}`);
  if (pkg.license !== "SEE LICENSE IN LICENSE") throw new Error(`missing license in ${tarball}`);
  if (files.includes("PRIVATE KEY")) throw new Error(`private key in ${tarball}`);
  const contents = run("tar", ["xOf", tarball]);
  if (/PRIVATE KEY|UFJJVkFURSBLRV|BSSVZBVEUgS0VZ|QUklWQVRFIEtFW/.test(contents)) {
    throw new Error(`private key material in ${tarball}`);
  }
}

const consumerJs = `import assert from "node:assert/strict";
import { BV_SALA_VERSION, SemanticCacheSafety, SemanticCalibrationJournal } from "@bivelio/savings-layer";
import { PgExactCache, PgSemanticCache, PgCacheBreakpointStore, PgConstraintMemoryStore } from "@bivelio/persistence-postgres";
assert.equal(BV_SALA_VERSION, "0.6.0-rc.1");
assert.equal(SemanticCacheSafety.cosine([1, 0], [1, 0]), 1);
assert.equal(new SemanticCalibrationJournal({embedder:"e",verifier:null,judge:"j",maxErrorRate:0.5,confidence:0.9,similarityThreshold:0.72}).status("single_shot").labeled, 0);
const pool = {
  query: async (text) => {
    if (text.includes("constraint_value_hints") && text.startsWith("SELECT")) return { rows: [{present: 1}], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  },
  end: async () => undefined,
};
const exact = new PgExactCache({ pool });
await exact.set("k", {text:"ok", storedAtMs:0});
assert.equal(exact.constructor.name, "PgExactCache");
const memory = new PgConstraintMemoryStore({ pool });
await memory.remember("k");
assert.equal(await memory.has("k"), true);
assert.equal(new PgSemanticCache({pool,namespace:"consumer"}).calibrated, false);
assert.equal(new PgCacheBreakpointStore({pool}).constructor.name, "PgCacheBreakpointStore");
console.log("ESM consumers OK");
`;

const consumerTs = `import { PgExactCache, PgSemanticCache, PgCacheBreakpointStore, PgConstraintMemoryStore, type PgPersistenceOptions, type PgPool } from "@bivelio/persistence-postgres";
declare const pool: PgPool;
const options: PgPersistenceOptions = { pool, queryTimeoutMs: 50 };
new PgExactCache(options);
new PgSemanticCache({...options, namespace: "typed-consumer"});
new PgCacheBreakpointStore(options);
new PgConstraintMemoryStore(options);
console.log("TypeScript consumer OK");
`;

function prepareConsumer(name: string): string {
  const dir = join(out, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
  writeFileSync(join(dir, "consumer.mjs"), consumerJs);
  writeFileSync(join(dir, "consumer.ts"), consumerTs);
  return dir;
}

function installAndVerify(dir: string, manager: "npm" | "pnpm"): void {
  const installArgs = manager === "npm"
    ? ["install", "--ignore-scripts", "--no-audit", "--no-fund", sdkTgz, persistenceTgz, "pg@8.23.1"]
    : ["add", "--ignore-workspace", "--ignore-scripts", sdkTgz, persistenceTgz, "pg@8.23.1"];
  run(manager, installArgs, dir);
  const devArgs = manager === "npm"
    ? ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-dev", "typescript@5.9.3", "@types/node@22.20.1"]
    : ["add", "--ignore-workspace", "--save-dev", "--ignore-scripts", "typescript@5.9.3", "@types/node@22.20.1"];
  run(manager, devArgs, dir);
  run("node", ["consumer.mjs"], dir);
  const tsc = join(dir, "node_modules", ".bin", "tsc");
  run(tsc, [
    "--noEmit", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext",
    "--target", "ES2022", "consumer.ts",
  ], dir);
}

function dockerVerify(image: string, manager: "npm" | "pnpm"): void {
  const script = `set -euo pipefail
mkdir -p /tmp/consumer && cd /tmp/consumer
${manager === "pnpm" ? "npm install -g pnpm@10.17.1" : ""}
${manager === "npm" ? "npm init -y" : "pnpm init"}
${manager === "npm" ? "npm install --ignore-scripts --no-audit --no-fund" : "pnpm add --ignore-scripts"} /rc/${sdkTgz.split("/").pop()} /rc/${persistenceTgz.split("/").pop()} pg@8.23.1 typescript@5.9.3 @types/node@22.20.1
cp /rc/consumer.mjs /rc/consumer.ts ./
node consumer.mjs
./node_modules/.bin/tsc --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2022 consumer.ts
`;
  run("docker", ["run", "--rm", "-v", `${out}:/rc:ro`, image, "bash", "-lc", script]);
}

mkdirSync(out, { recursive: true });
for (const file of ["consumer.mjs", "consumer.ts"]) writeFileSync(join(out, file), file.endsWith("mjs") ? consumerJs : consumerTs);
run("npm", ["pack", "--silent", "--pack-destination", out]);
run("pnpm", ["--dir", "packages/persistence-postgres", "pack", "--pack-destination", "../../benchmarks/out/release-candidate"]);
verifyTarball(sdkTgz, "@bivelio/savings-layer", sdkVersion);
verifyTarball(persistenceTgz, "@bivelio/persistence-postgres", persistenceVersion);

const hashes: Record<string, { sha256: string; sha512: string }> = {};
for (const [name, file] of Object.entries({ sdk: sdkTgz, persistence: persistenceTgz })) {
  const bytes = readFileSync(file);
  hashes[name] = {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sha512: createHash("sha512").update(bytes).digest("hex"),
  };
}
writeFileSync(join(out, "hashes.json"), `${JSON.stringify(hashes, null, 2)}\n`);
run("pnpm", ["exec", "tsx", "scripts/sbom.ts", sdkTgz, join(out, "sdk.cdx.json")]);
run("pnpm", ["exec", "tsx", "scripts/sbom.ts", persistenceTgz, join(out, "persistence.cdx.json"), "packages/persistence-postgres"]);
for (const [name, file] of Object.entries({ sdk: join(out, "sdk.cdx.json"), persistence: join(out, "persistence.cdx.json") })) {
  const sbom = JSON.parse(readFileSync(file, "utf8")) as {
    metadata: { component: { hashes: { alg: string; content: string }[] } };
  };
  for (const hash of sbom.metadata.component.hashes) {
    const algorithm = hash.alg === "SHA-512" ? "sha512" : "sha256";
    if (hash.content !== hashes[name]![algorithm]) throw new Error(`SBOM ${algorithm} mismatch for ${name}`);
  }
}

const npmConsumer = prepareConsumer("consumer-npm");
installAndVerify(npmConsumer, "npm");
const pnpmConsumer = prepareConsumer("consumer-pnpm");
installAndVerify(pnpmConsumer, "pnpm");
const audits = {
  npm: runAudit("npm", ["audit", "--omit=dev", "--json"], npmConsumer),
  pnpm: runAudit("pnpm", ["audit", "--ignore-workspace", "--prod", "--json"], pnpmConsumer),
  repository: runAudit("pnpm", ["audit", "--json"], root),
};
writeFileSync(join(out, "audits.json"), `${JSON.stringify(audits, null, 2)}\n`);
for (const [name, report] of Object.entries({ npm: audits.npm, pnpm: audits.pnpm })) {
  const metadata = (report as { metadata?: { vulnerabilities?: Record<string, number> } }).metadata;
  const high = metadata?.vulnerabilities?.high ?? 0;
  const critical = metadata?.vulnerabilities?.critical ?? 0;
  if (high + critical > 0) throw new Error(`${name}: ${high} high and ${critical} critical production vulnerabilities`);
}

if (readFileSync(join(root, "pnpm-lock.yaml"), "utf8").includes("release-candidate")) {
  throw new Error("the pnpm consumer polluted the workspace lockfile");
}

if (process.env.RC_SKIP_DOCKER !== "1") {
  dockerVerify("node:20.19.5-bookworm-slim", "npm");
  dockerVerify("node:22.13.1-bookworm-slim", "pnpm");
}
writeFileSync(join(out, "verification.json"), `${JSON.stringify({
  sdk: sdkVersion,
  persistence: persistenceVersion,
  tarballs: true,
  npmConsumer: true,
  pnpmConsumer: true,
  docker: process.env.RC_SKIP_DOCKER !== "1",
  productionAudit: true,
  hashes,
}, null, 2)}\n`);
console.log(`Release candidate verified in ${out}`);
