# BV-SALA — Public Launch Plan

> PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.
> Synthesized 2026-07-18 from a multi-agent draft + adversarial review (security-CTO,
> GTM, and compliance personas). "Open to the public" = a **public product launch**
> (self-serve trial + signup + billing at `savings.bivelio.com`) — **not** open-sourcing
> the proprietary SDK.

## The wedge we are launching on

**"Cut your LLM bill without switching providers or sending us a single prompt — and
verify the savings yourself before you pay."** Two reinforcing, unusual guarantees:

1. **Verify, don't trust.** The true A/B live benchmark (`pnpm ab`) meters *both* a naive
   arm and the BV-SALA arm on the customer's *own* real provider, prices both from the
   provider's own token usage, and headlines the **95% bootstrap-CI lower bound**, void if
   the answer fails a quality gate. Plus a browser verifier running the real optimizer
   locally, nothing leaving the page.
2. **Prompts never leave your infra.** The customer self-hosts the data plane; the control
   plane receives only allowlisted counts/metadata — never raw prompts or completions.

Every proxy/gateway cost tool asks you to trust both its numbers *and* its handling of your
prompts. BV-SALA is architected so you trust **neither**.

## Honest status (what the adversarial review found)

The GTM rests on claims that are **not yet all true**. Treat these as gate-zero, not polish:

- ⛔ **The one citable number is not real yet.** `benchmarks/out/ab-live.json` today is
  `mode=MOCK` ("not a savings claim"). No public % may ship until a **committed, dated LIVE
  run** exists. (The web already enforces this — it renders MOCK as `ESTIMATED`.)
- ⛔ **The paid product is unbuilt.** There is no `/api` tree in `apps/web`: signup, Stripe
  checkout/webhook, `/api/licensing/validate`, `/api/metering/usage`, and the dashboard do
  not exist yet.
- ⛔ **CP-0 services are not launch-safe.** `services/{licensing,metering}` fail *open* when
  the token env is unset, keep revocation/usage in in-memory `Set`/`Map` (lost between
  serverless cold starts), trust client-supplied `orgId`, and expose an unauthenticated
  cross-tenant usage read. These must be rebuilt as Postgres-backed, fail-closed functions.
- ⛔ **The SDK is legally uninstallable.** Root `LICENSE` grants no rights; `package.json` is
  `private/UNLICENSED`. A proprietary SDK EULA + a real distribution channel are required
  before even the free tier or a design-partner beta.
- ⛔ **Doc rot / false claims.** `COMMERCIALIZATION-PLAN.md` still names Neon/Hyperswitch/
  Keycloak/Hetzner; any "EU data residency" claim on a Vercel(US)+Supabase+Stripe stack is
  false until proven. One caught false claim retroactively discredits the whole wedge.

**Already real** (the truth foundation we build on): the measured-vs-measured A/B benchmark
with CI lower bound + quality gate + reconciliation (`benchmarks/ab-live.ts`), the
browser-safe SDK bundle powering the verifier, and the four-ledger honest accounting.

**Progress against Phase 1 (landed in code, 2026-07-18).** Several of the security holes
above are now closed as tested code in the CP-0 services + SDK (the parts that don't need
external provisioning):

- ✅ **Privacy code backstop** — `parseUsageRecords` (in `@bivelio/protocol`) rejects any
  field outside the counts/metadata allowlist; a test proves a `prompt`/`completion` field
  can never cross into ingest.
- ✅ **Fail-closed auth** — both services refuse when no credential is configured (dev-open is
  an explicit opt-in), replacing the old `if (!TOKEN) return true`.
- ✅ **Server-derived tenant** — metering ingest books usage to the *authenticated* service
  account's org, never the client-supplied `orgId`; cross-tenant writes are blocked.
- ✅ **Authorized reads** — the usage summary now requires auth and blocks cross-tenant reads
  (403), closing the unauthenticated enumeration hole.
- ✅ **Revocation persistence seam** — a pluggable `RevocationStore` (in-memory default,
  Postgres impl injected in prod) so a revoked license survives a cold start.
- ✅ **SDK reliability contract** — the pipeline is fail-open: any internal optimizer error
  falls back to a direct provider call (a genuine provider error still propagates).

**Still gated on provisioning** (unchanged, still BLOCK): the `/api` Vercel functions on
Supabase Postgres, Stripe signature verification + idempotency, RLS proof against a real DB,
the LIVE `ab-live.json`, the SDK EULA + distribution channel, and everything in Phases 2–4.

---

## Phase 0 — Make the claims true & the software legally runnable

*Nothing ships or is shown to a stranger until this closes.*

- **[BLOCK]** Run `pnpm ab` **LIVE** against the launch model (`openai/gpt-4o-mini` via
  Vercel AI Gateway, `KEEP_PREFIX=1`, judge on, `BVSALA_AB_REPS>=8`); commit a **dated**
  `ab-live.json` + `ab-live-trials.csv` with `mode=LIVE, proven=true` (drop
  `benchmarks/out/` from `.gitignore`). Lock its **95% CI lower bound** as the one citable
  public number.
- **[BLOCK]** Ship a **copy-governance rule**: no public savings figure may derive from MOCK,
  demo, or ablation modeled baselines — only LIVE measured-vs-measured lower bounds.
- **[BLOCK]** Draft a **proprietary SDK EULA** (free capped self-host grant, paid grant tied
  to valid license+seats, graceful-degrade, no-guaranteed-savings, IP/reverse-engineering
  protections). Root `LICENSE` cannot govern a distributed SDK.
- **[BLOCK]** Decide the **SDK distribution channel** (private npm / GitHub Packages /
  dashboard-issued signed tarball) + license-token env convention, so the quickstart install
  line resolves.
- **[BLOCK]** Delete every **false EU-residency** statement (or pin Supabase+Vercel to an EU
  region and restate honestly, disclosing Stripe/Vercel US entities).
- **[BLOCK]** Reconcile **doc rot**: `COMMERCIALIZATION-PLAN.md` → the locked Supabase +
  Stripe + Vercel-first stack; fix the seat definition to bill = purchased quantity.
- Add a **CI check** that fails if `apps/web/vendor/bv-sala.js` differs from a fresh `src/`
  build (make "byte-identical from src" verifiable, not asserted).
- Name the single-threaded **launch owner** + **on-call**; set the date backward from here.

**Exit:** committed LIVE `ab-live.json` (reps≥8, gate passing) reproducible from its CSV; a
real install command resolves for a test customer; no false-residency/doc-rot statement
remains; CI enforces vendor==src; owner + on-call staffed.

## Phase 1 — Make the control plane real, safe & multi-tenant-correct

*100% greenfield — there is no `/api` today.*

- **[BLOCK]** Author the CP-1 Vercel functions in `apps/web/api/`: `/licensing/validate` and
  `/metering/usage`, **Postgres-backed** (Supabase). Delete all module-level `Set`/`Map`
  state (revocation + usage must persist).
- **[BLOCK]** **Fail-closed** auth: refuse the route when the credential env is absent.
  Authenticate M2M callers by `sha256(key)` vs `service_accounts.key_hash`; **derive
  `org_id` server-side**, ignoring any client-claimed id.
- **[BLOCK]** Remove the unauthenticated cross-tenant usage read; serve dashboard usage only
  via Supabase **RLS**.
- **[BLOCK]** Build the **egress boundary** the pitch claims: a `control-plane-client` shim
  emitting only allowlisted `UsageRecord` fields + server-side ingest validation that
  **rejects unknown fields**, with a **test proving no prompt/completion can cross**.
- **[BLOCK]** Verify **Stripe webhook** raw-body signatures (idempotent on event id); replace
  the public `/licenses/issue` with issuance driven **only** by signature-verified Stripe
  events + an owner-role check.
- **[BLOCK]** Apply `db/migrations/0001_init.sql` to prod; **prove RLS** (anon + cross-org →
  zero rows); persistent revocation table.
- **[BLOCK]** **SDK reliability contract**: hard **fail-open to the raw provider** on any
  internal error, bounded overhead, circuit breaker; never block the request path on a live
  validate (offline signature verify + grace).
- **[BLOCK]** **SDK supply-chain**: signed/provenance publish, SBOM, pinned+audited deps,
  documented threat model (a closed-source package in the prompt hot path is the #1 adoption
  blocker for the security ICP).
- Verify the built browser bundle contains **no** server secrets (only `SUPABASE_ANON_KEY`,
  `LICENSE_PUBLIC_KEY`). Network-audit the verifier for **zero egress**.

**Exit:** the four functions exist, are Postgres-backed, hold no in-memory state; every
function fails closed; a committed test proves no prompt/completion crosses the boundary;
Stripe signatures verified + idempotent; RLS proof passes; SDK fails open + provenance
publish in place.

## Phase 2 — Make it self-serve: signup, billing, dashboard & docs

- **[BLOCK]** Signup **after** the gate-free verifier (never a wall before value): Supabase
  Auth "Sign in with BiVelio", org + owner membership with RLS.
- **[BLOCK]** `/api/stripe/checkout` (`mode=subscription`, `STRIPE_PRICE_PRO_SEAT`,
  `quantity=seats`) + webhook branches (`checkout.session.completed`,
  `customer.subscription.*`, `invoice.paid/payment_failed`). Re-issue the signed license on
  `invoice.paid` so `expires_at` tracks `current_period_end`.
- **[BLOCK]** Pin the **seat definition** (billed = Stripe quantity = `license.seats`; metered
  active seats = dashboard reconciliation only, never a surprise charge) and the **free-tier
  cap** (recommend a **3-seat** cap; unlimited local optimizations; a token cap is
  unenforceable offline without breaking never-brick). Show both on the pricing page.
- **[BLOCK]** Decide **Stripe-as-merchant vs Merchant-of-Record**; if Stripe: Stripe Tax,
  B2B VAT-ID/reverse-charge, sequential invoice numbering + imprint. No euro without a tax
  mechanism.
- **[BLOCK]** Publish refund/cancellation/**dunning**/chargeback policy; wire
  `invoice.payment_failed → past_due` with a 14-day grace (only past-grace downgrades to
  free). Stripe Radar + checkout rate-limit vs card-testing.
- **[BLOCK]** Post-signup **"Install the SDK"** screen: license key + resolving install
  command + a real `OpenAICompatibleProvider` wrap snippet (never `createMockProvider`) +
  the never-bricks reassurance.
- **[BLOCK]** **Dashboard** SavingsReport from `usage_daily` (RLS-scoped): the four
  never-summed ledgers + net savings, "X of N seats active", with the "we receive only
  counts, never your prompts" note.
- **[BLOCK]** Public **docs** at `savings.bivelio.com/docs`: 5-min quickstart on a real
  provider, provider setup (OpenAI vs AI Gateway prefix + `response_format`), "reading the
  SavingsReport — the report is the meter", graceful-degrade/licensing, verify-your-savings
  methodology, troubleshooting (`requireUsage` "no usage tokens", gateway prefix, offline
  grace). Strip all CONFIDENTIAL/roadmap content.

**Exit:** a stranger can verifier → signup → checkout N seats → receive a license → install
on a real provider → see a SavingsReport, with no manual step; license lifecycle is
webhook-driven; tax + invoice + refund policy exist; docs live with an executable quickstart.

## Phase 3 — Trust, legal, security attestation & operational readiness

- **[BLOCK]** Publish **ToS** + **Privacy Policy** (with the affirmative "raw
  prompts/completions never received" statement, subprocessor list, SCC transfer) + **DPA**
  (execute Vercel/Supabase/Stripe DPAs); delineate controller vs processor roles. Link from
  checkout.
- **[BLOCK]** Legal **entity + imprint** + footer links; resolve US-entity-processing-EU-data
  (Art. 27 representative or EU establishment + SCC modules).
- **[BLOCK]** Provision prod per `docs/CP-1-SETUP.md`: a **new** Vercel project rooted at
  `apps/web` (never the corporate project), `savings.bivelio.com` CNAME (apex/www untouched),
  remove `noindex`, generate the license keypair, all secrets server-only.
- **[BLOCK]** **Rate limiting + abuse controls** on signup/checkout/M2M endpoints (Upstash
  token bucket / Vercel WAF); **KYB/sanctions/OFAC** screening on org signup.
- **[BLOCK]** Supabase **PITR** + restore runbook (Postgres is the billing system of record);
  launch **alerting** incl. a "usage-ingest dropped to zero" silent-outage detector → one
  channel, named on-call.
- Security-attestation track the ICP gate demands: **vuln-disclosure policy**, **control-plane
  pen-test**, dated **SOC 2 roadmap**. Support model for a blind control plane (diagnostic
  bundle + channel + escalation).
- **Financial controls**: three-way reconciliation (Stripe cash ↔ entitlements ↔
  `usage_daily`), immutable audit log for license/plan changes, ASC-606 revenue recognition.
  Add a **CSP** header to `apps/web/vercel.json`; publish the CTO trust bundle.

**Exit:** ToS/Privacy/DPA/subprocessors/imprint published + linked from checkout;
controller/processor delineated; prod project isolated, secrets server-only + verified absent
from the browser bundle; rate limits + sanctions + PITR + alerting + on-call live;
vuln-disclosure + pen-test + SOC 2 roadmap + support + reconciliation exist.

## Phase 4 — Launch & measure

- **[BLOCK]** Run a **design-partner cohort** (5–10 teams on OpenAI-compatible providers,
  manually licensed under the new EULA) to back the public claim with ≥1 real-traffic segment
  and de-risk demand before the full open.
- Landing copy to the six-part spine, leading with the one-line promise + a **named
  competitive teardown** vs proxy/gateway tools (Helicone, Portkey, LiteLLM, AI Gateway,
  OpenRouter) that separates "SDK in front of your provider" from "we route your traffic".
- Enforce the **honesty-tier wall** on the page: Panel B labeled `ESTIMATED (mock)`; the
  reference A/B section labeled provider-measured with the CI-lower-bound headline + per-
  scenario table + cache break-even K + quality pass count + downloadable CSV. Promote a
  **"verify on your own endpoint"** BYO-key CLI — do **not** promise an in-browser real-dollar
  measure (CORS + key exposure make it infeasible and break the data-plane invariant).
- Instrument only **privacy-safe** funnel events (signup → activation = first SavingsReport →
  trial→paid); the verifier emits no payload. Set numeric targets.
- Model **unit economics**: ~$80/mo ACV for a 20-eng team against a security-gated, self-host
  motion — decide whether PLG carries this buyer or the beta motion is the channel; define the
  retention/expansion path (what keeps them paying beyond free local wins).
- Public **status page** + incident runbook leading on graceful-degrade (control-plane down →
  SDK stays on free local tier; production never bricks). Launch-day content that pre-empts
  "why is a cost-saver proprietary?" with the free self-hosted tier as the openness story.

**Exit:** ≥1 design-partner real-traffic segment backs the CI-lower-bound claim; copy leads
with the verifier + CI lower bound; honesty-tier wall enforced; funnel instrumented with
targets and zero payload egress; status page + runbook live; go/no-go passes; owner signs off.

---

## Top launch risks (ranked)

1. **The one citable number is fake** — committed `ab-live.json` is MOCK/gitignored; a skeptic
   downloading the CSV today gets a fabricated number labeled verified. Gate zero.
2. **The paid product is 100% unbuilt** — no `/api` tree; "launch-ready" is a greenfield CP-1.
3. **The privacy guarantee has no code backstop** — no allowlist package, ingest does
   `body as UsageRecord[]` with zero validation, no boundary test.
4. **Fail-open auth + in-memory state on serverless** — revoked licenses keep validating,
   usage vanishes, any org's data readable by enumeration.
5. **The SDK is legally uninstallable** — no EULA, no distribution channel, no resolving
   install command.
6. **Stripe→license trust path unimplemented** — no signature verify, public issue endpoint
   mints any plan for any org.
7. **False EU-residency claim + doc rot** — one caught false claim discredits everything.
8. **Unaddressed security-ICP blockers** — no supply-chain provenance, no SDK reliability
   contract, no attestation (SOC 2 / pen-test / vuln-disclosure).
9. **No money-handling compliance** — no tax mechanism, refund/dunning policy, imprint, KYB.
10. **Unvalidated demand & thin paid value** — ~$80/mo ACV, no LOIs, and graceful-degrade
    means blocking egress keeps all local wins free forever; defend why they keep paying.

## Go / No-Go checklist

- [ ] LIVE `ab-live.json` (`mode=LIVE`, reps≥8, gate passing, `proven=true`) committed + dated;
      public headline is its 95% CI **lower** bound, reproducible from the CSV. NO-GO if any
      public number traces to MOCK/demo/ablation.
- [ ] Proprietary SDK EULA bundled; distribution channel chosen; install command resolves.
- [ ] `/api/{licensing/validate, metering/usage, stripe/webhook, stripe/checkout}` exist,
      Postgres-backed, zero in-memory state.
- [ ] Every control-plane function fails **closed**; M2M authenticated per service-account;
      `org_id` derived server-side; unauthenticated usage read removed.
- [ ] Committed test proves no prompt/completion crosses the egress/ingest boundary; verifier
      makes zero network calls on a pasted prompt.
- [ ] Stripe webhook verifies raw-body signatures + idempotent; issuance only via verified
      events + owner-role; `expires_at` webhook-driven.
- [ ] RLS proof passes; no server secret in the browser bundle.
- [ ] SDK fails **open** to the raw provider on any internal error; signed/provenance publish
      + SBOM + pinned deps.
- [ ] No false EU-residency claim; one canonical architecture doc governs.
- [ ] ToS + Privacy + DPA (+ executed subprocessor DPAs) + subprocessors + imprint published +
      linked from checkout; tax mechanism + refund/dunning + invoice imprint/numbering exist.
- [ ] Prod Vercel project isolated from corporate apex/www; `noindex` removed; keypair
      generated; rate limits + sanctions + PITR + alerting (incl. zero-ingest detector) + named
      on-call live.
- [ ] Vuln-disclosure + pen-test + SOC 2 roadmap + support/diagnostic path + three-way
      reconciliation exist; a design-partner cohort produced ≥1 real-traffic savings segment.
- [ ] Seat definition + free-tier cap + "active seat" pinned and shown on pricing; CI enforces
      vendor bundle == src build.

## First two weeks

- **Day 1** — Name the launch owner + on-call; freeze the critical path (Phase 0→4); set the
  date backward from it.
- **Day 1–3** — Run `pnpm ab` LIVE (gpt-4o-mini via AI Gateway, judge on, reps≥8); commit
  dated `ab-live.json` + CSV (drop `benchmarks/out/` from `.gitignore`); lock the CI-lower-
  bound headline; write the no-MOCK copy rule.
- **Day 2–4** — Draft the SDK EULA; choose the distribution channel + license-token convention.
- **Day 2–3** — Scrub the false EU-residency claim; reconcile `COMMERCIALIZATION-PLAN.md` doc
  rot; fix the seat definition.
- **Day 3–5** — Add the CI "vendor == src build" check; network-audit the verifier (zero
  egress) and add the "runs entirely in your browser" line.
- **Day 4–9** — Scaffold `apps/web/api/`: `/licensing/validate` + `/metering/usage` on Supabase
  Postgres, fail-closed auth, per-service-account `sha256`, server-derived `org_id`; delete
  module-level `Set`/`Map`; remove the public usage-summary read.
