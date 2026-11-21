# Keep what the layer learns

Part of the [BV‑SALA README](https://github.com/BiVelio/bivelio-savings-layer#readme). The examples
continue its quickstart: `provider`, `layer` and `createSavingsLayer` come from there.

## Serverless: keep what the layer learns between instances

Calibrated reuse and `cacheBreakpoints: "auto"` learn from your traffic, and by default
what they learn lives in the process. On serverless platforms (Vercel Functions, AWS
Lambda) an instance may serve one request or live a few minutes, so neither would ever
get past its starting point. Give each one somewhere to keep it. Giving the layer a
`semanticCacheStore` only says where reworded questions are kept; `semanticCacheDefault: true`
is what switches reuse on for every request (a request's own `savings.semanticCache`
still wins), and without it, or `savings.semanticCache` on each request, the cache
stays empty and learns nothing:

```ts
import { InMemorySemanticCache } from "@bivelio/savings-layer";

// Any key-value client your instances share, such as Redis.
type SharedKeyValue = {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, options?: { px: number }): Promise<unknown>;
};

async function serverlessLayer(kv: SharedKeyValue) {
  const semanticCache = new InMemorySemanticCache({ calibration: { maxErrorRate: 0.02 } });
  const saved = await kv.get("bvsala:semantic-calibration");
  if (saved) semanticCache.importCalibration(saved); // the object or its JSON text

  const layer = createSavingsLayer({
    provider,
    // licenseKey: process.env.BIVELIO_LICENSE_KEY,   (optional: cloud)
    semanticCacheStore: semanticCache,
    // Passing the cache does not switch it on; this asks for it on every request.
    semanticCacheDefault: true,
    cacheBreakpoints: "auto",
    cacheBreakpointStore: {
      get: (key) => kv.get(key),
      set: (key, value, ttlMs) => kv.set(key, value, { px: ttlMs }),
    },
  });

  // After handling requests with `layer`, save the calibration:
  const save = async () => {
    await semanticCache.settled();
    await kv.set("bvsala:semantic-calibration", JSON.stringify(semanticCache.exportCalibration()));
  };
  return { layer, save };
}
```

- **Breakpoint placement.** The store holds prompt-prefix fingerprints, timestamps and
  counts, one key per traffic class, never prompt text. The layer reads it before
  placing breakpoints and reads and rewrites it after the provider answers, so every
  instance extends the same measurement. If the store fails, that request is placed as
  a fresh instance would place it and nothing is written over what others learned.
  Without a store nothing changes.
- **Calibration.** The saved state is the whole experiment: both halves of the labels,
  how many tests have already drawn on the confidence budget, and the floor in force.
  Restoring it continues the same calibration, so the bound keeps holding across
  restarts; it never starts the budget over. A state recorded under another embedder,
  verifier, judge or configuration is refused with `CalibrationStateError`. If you pass
  your own `embed`, `verify` or `judge`, name them (`embedderId`, `verifierId`,
  `calibration.judgeId`) so a state can say what it was recorded with.
- **One line of history for in-memory snapshots.** Restoring and saving the latest
  state continues one line. Instances that manually continue the same snapshot at
  the same time each spend its remaining confidence again, and the last save
  overwrites the others. Use one long-lived process or offline calibration for that
  manual model. For shared records and one coordinated history across instances,
  use `PgSemanticCache`: its transactions and observation IDs prevent lost labels
  and repeated confidence spending. The in-memory cached answers still live in
  each instance unless you inject a persistent store.
- **Why a predicted cache read did not happen** (Anthropic's own API). With
  `cacheMissDiagnostics: true`, the layer asks Anthropic to compare each marked request
  with the one whose cache entry it expected to read, and puts the provider's
  `cache_miss_reason` in `report.traces` when that read does not arrive. Anthropic
  keeps a short-lived fingerprint (hashes and token-count estimates) of each request
  that opts in; check that against your data-retention terms first.

## Customer-operated PostgreSQL for caches and learning

The optional `@bivelio/persistence-postgres` package provides `PgExactCache`,
`PgSemanticCache`, `PgCacheBreakpointStore` and `PgConstraintMemoryStore` without
adding a database driver to the core SDK. You supply the `pg` pool, apply its
versioned SQL migrations yourself, and inject the stores; nothing connects or
changes your schema automatically. Exact and semantic entries contain customer
queries, answers or derived embeddings and need the same access, retention and
deletion controls as the original data. Breakpoints contain fingerprints,
timestamps and counters, never prompt text. Constraint learning stores only a
hash of tenant, scope, provider, served model and contract.

**Not on npm yet** (release candidate): until it is published, build it from
`packages/persistence-postgres` in this repository.

The breakpoint adapter uses revisions and compare-and-set. Semantic calibration
uses short transactions and idempotent observation IDs, so concurrent instances
continue one history instead of spending the same confidence budget independently.
Both use the same deterministic candidate guards and statistical journal as memory.
The semantic backend requires the PostgreSQL vector extension and is opt-in; existing key-value stores
and in-memory defaults keep their previous behavior. Removing `constraintMemoryStore`
rolls constraint learning back to process memory without reading the new table.

See [`packages/persistence-postgres/README.md`](../../packages/persistence-postgres/README.md)
for setup, ownership, cleanup, benchmark evidence and shutdown.
