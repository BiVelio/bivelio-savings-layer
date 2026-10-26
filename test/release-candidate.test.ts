import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const json = (path: string) => JSON.parse(readFileSync(new URL(path, root), "utf8")) as Record<string, unknown>;
const text = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("release candidate 0.6 packaging guards", () => {
  it("keeps SDK and persistence versions and peers compatible", () => {
    const sdk = json("package.json");
    const persistence = json("packages/persistence-postgres/package.json");
    expect(sdk.version).toBe("0.6.0-rc.1");
    expect(persistence.version).toBe("0.1.0-rc.1");
    expect(text("src/version.ts")).toContain('"0.6.0-rc.1"');
    expect(persistence.peerDependencies).toEqual({
      "@bivelio/savings-layer": ">=0.6.0-rc.1 <1",
      pg: ">=8.23.1 <9",
    });
    expect(persistence.peerDependenciesMeta).toBeUndefined();
    expect(sdk.engines).toEqual({ node: ">=20.19.0" });
    expect(persistence.engines).toEqual({ node: ">=20.19.0" });
  });

  it("keeps proprietary sourcemaps out of persistence", () => {
    expect(text("packages/persistence-postgres/tsup.config.ts")).toContain("sourcemap: false");
    expect(json("package.json").files).toContain("CHANGELOG.md");
    expect(json("packages/persistence-postgres/package.json").files).toContain("CHANGELOG.md");
  });

  it("runs PostgreSQL in both release paths and separates their tags", () => {
    const sdk = text(".github/workflows/publish.yml");
    const persistence = text(".github/workflows/publish-postgres.yml");
    for (const workflow of [sdk, persistence]) {
      expect(workflow).toContain("pgvector/pgvector:pg17");
      expect(workflow).toContain("BIVELIO_TEST_POSTGRES_URL");
      expect(workflow).toContain("trusted");
      expect(workflow).toContain("banco-semanal");
    }
    expect(sdk).toContain("!startsWith(github.event.release.tag_name, 'pg-v')");
    expect(persistence).toContain("startsWith(github.event.release.tag_name, 'pg-v')");
    expect(persistence).toContain("packages/persistence-postgres");
  });
});
