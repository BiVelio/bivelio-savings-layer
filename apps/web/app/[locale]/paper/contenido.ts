// GENERADO desde docs/PAPER.md — no editar a mano (ver _research/paper-to-ts.ts).
export type Bloque =
  | { tipo: "h1" | "h2" | "h3" | "p" | "li" | "cita"; texto: string }
  | { tipo: "tabla"; filas: string[][] };

export const BLOQUES: Bloque[] = [
  {
    "tipo": "h1",
    "texto": "BV-SALA Savings Layer v2 — Improved Draft"
  },
  {
    "tipo": "p",
    "texto": "**Verifiable Measurement of Cost Savings in LLM Applications, Open-Core Edition**"
  },
  {
    "tipo": "p",
    "texto": "Joan-Marc Fisa, Founder @ BiVelio — draft for review, November 2026. Improves and supersedes the August 2026 paper (\"BV-SALA Savings Layer: Verifiable Measurement of Cost Savings in Large Language Model Applications\", [bivelio.com/es/research/papers/bv-sala-savings-layer](https://bivelio.com/es/research/papers/bv-sala-savings-layer))."
  },
  {
    "tipo": "p",
    "texto": "---"
  },
  {
    "tipo": "h2",
    "texto": "Abstract"
  },
  {
    "tipo": "p",
    "texto": "Cost claims for LLM optimizations require explicit workloads, uncertainty, and a documented cost basis. This paper extends the August 2026 evaluation of BV-SALA Savings Layer — an in-process SDK and a local gateway that combine provider-reported usage with versioned list prices and four separate savings ledgers — to the open-core release: the layer now runs with no license key (community mode), arms every local saving lever, sends zero telemetry by default, and meters three provider protocols (Anthropic Messages, OpenAI Chat Completions/Responses, and the Gemini protocol) plus the Anthropic-format endpoint of DeepSeek. Live SDK double-runs remain the primary evidence: 31.5 % cost reduction (95 % CI 25.7–36.7; 100 families, 200 requests per arm) on gpt-4o-mini and 75.1 % (95 % CI 69.3–79.6; 31 families, 62 requests per arm) on claude-sonnet-5, of which ≈41 percentage points are a prefix-cache effect enabled by `cache_control` in the instrumented arm. We add: (i) a routing-economics analysis showing, at versioned list prices, the cost deltas of serving identical usage through DeepSeek, Qwen and GLM siblings — presented as conditional arithmetic, not as measured savings; (ii) a semantic-cache positioning against the published AWS benchmark; and (iii) a preregistered research roadmap for the factorial and non-inferiority designs the August edition identified as missing. Amounts remain labelled measured, reference-valued, or estimated; no invoice reconciliation is claimed."
  },
  {
    "tipo": "p",
    "texto": "**Keywords:** LLM; inference cost; provider-reported usage; prefix caching; cluster bootstrap; open core; model routing; semantic caching."
  },
  {
    "tipo": "p",
    "texto": "---"
  },
  {
    "tipo": "h2",
    "texto": "1 · What changed since the August 2026 version"
  },
  {
    "tipo": "p",
    "texto": "The August edition evaluated a commercial, fail-closed distribution: the SDK and gateway executed only with a verified license key, and the gateway metered Anthropic and OpenAI traffic but not Gemini. The November release changes the system, not the measurement doctrine:"
  },
  {
    "tipo": "p",
    "texto": "   `licenseKey` runs the entire local saving stack — exact and semantic cache, request    coalescing, model cascade, compression, prompt-cache placement, output contracts,    four ledgers — with telemetry off. The gateway starts with no keys and arms its    local levers (cache-TTL tuning, sibling routing, per-turn effort). A key that **is**    present but invalid, expired or revoked still fails closed; only its absence stopped    being an error. This removes the adoption barrier documented in §7.4 of the August    edition while preserving every auditable guarantee."
  },
  {
    "tipo": "p",
    "texto": "   the Gemini protocol (`:generateContent` / `:streamGenerateContent`, both SSE with    `alt=sse` and newline-delimited JSON), mapping `usageMetadata` onto the same    `UsoSse` shape used for Anthropic and OpenAI: implicit-cache tokens are discounted    from ordinary input, thinking tokens sum to output. Gemini evidence in this paper is    operational (non-breakage), as in the August edition."
  },
  {
    "tipo": "p",
    "texto": "   V4-pro, priced at *peak* rates; off-peak is half — the conservative direction),    Qwen (3.8/3.7/flash/plus) and GLM (5.3, flash), and the gateway ships first-class    upstream aliases. DeepSeek's Anthropic-format endpoint (`/anthropic`) is rewired    automatically, so a Claude Code session can target DeepSeek without configuration."
  },
  {
    "tipo": "p",
    "texto": "   cloud key sends only the per-request usage fields enumerated in LICENSE §5. The    privacy claim is therefore stronger than \"processing is local\": in community mode    there is no control plane to reach."
  },
  {
    "tipo": "li",
    "texto": "**Community mode (open core).** `createSavingsLayer({ provider })` without a"
  },
  {
    "tipo": "li",
    "texto": "**Three protocols, one meter.** The gateway now reads provider-reported usage from"
  },
  {
    "tipo": "li",
    "texto": "**Chinese providers at list price.** The versioned catalog adds DeepSeek (flash and"
  },
  {
    "tipo": "li",
    "texto": "**Zero-telemetry default.** Community mode sends nothing to BiVelio; the optional"
  },
  {
    "tipo": "p",
    "texto": "Nothing in this release changes the four-ledger accounting, the `measured` / `reference-valued` / `estimated` evidence labels, or the versioned list-price basis. The August results remain the primary evidence; this edition adds analyses, not re-analysis."
  },
  {
    "tipo": "h2",
    "texto": "2 · System (open-core edition)"
  },
  {
    "tipo": "p",
    "texto": "Deployment architecture is unchanged: the SDK runs in-process; the gateway runs locally on the configured provider path; costs are computed from provider-reported usage and versioned list prices. The community gate is a structural `LicenseGate` that answers \"active, entitled to every local feature\" with no network dependency (`src/license/community.ts`). The gateway's community entitlements channel grants the four local levers without a service key; org-scoped entitlements remain the online channel when a key is configured. The Gemini observer (`gateway/gemini.ts`) is a read-only pass-through: it never rewrites a Gemini request, and a stream whose final `usageMetadata` is missing is forwarded and reported `unmeasured`, exactly as with the other two protocols."
  },
  {
    "tipo": "h2",
    "texto": "3 · Routing economics at list prices (new, conditional arithmetic)"
  },
  {
    "tipo": "p",
    "texto": "One of the August edition's open problems was that routing \"lacks evidence of semantic correctness\". This section does not close that gap — it provides the *economic* half: what the same usage costs at each provider's list price, so that the quality side of the cascade can be measured against a known price gradient."
  },
  {
    "tipo": "p",
    "texto": "For a request billed at versioned list prices (USD per 1M tokens), input/output gradients from the catalog (Nov 2026):"
  },
  {
    "tipo": "tabla",
    "filas": [
      [
        "Model",
        "Input",
        "Output",
        "Cached input",
        "Note"
      ],
      [
        "claude-sonnet-5",
        "~2.0",
        "~15.0",
        "0.2",
        "Anthropic 1-h cache writes 2×"
      ],
      [
        "gpt-4o-mini",
        "0.15",
        "0.6",
        "0.075",
        "OpenAI automatic caching"
      ],
      [
        "deepseek-flash",
        "0.30 (peak)",
        "1.20",
        "0.003",
        "off-peak half; Anthropic-format endpoint"
      ],
      [
        "qwen3.8-flash",
        "0.15",
        "0.47",
        "0.015",
        "explicit cache 1.25× writes"
      ],
      [
        "glm-5.3-flash",
        "~0.11",
        "~0.39",
        "—",
        "CNY→USD at 7.2; hit price not split per model"
      ]
    ]
  },
  {
    "tipo": "p",
    "texto": "*Conditional arithmetic, not a measurement:* a workload whose prompts repeat within the cache window pays, at list prices, ~66× less per cached input token on DeepSeek than on Claude Sonnet 5, and off-peak DeepSeek input is ~13× cheaper than Sonnet input. The cross-provider quality gap is exactly what the cascade's deterministic gate must certify before any of this becomes savings; until then the layer may route in shadow mode (measure-only) at zero extra cost. We deliberately publish the price gradient and not a routing win-rate, because we have not measured one yet."
  },
  {
    "tipo": "h2",
    "texto": "4 · Semantic-cache positioning (related evidence)"
  },
  {
    "tipo": "p",
    "texto": "The August edition reported calibration behavior (δ = 15 % certified; 13,121 labels to calibrate) and zero live semantic hits on GSM8K. Independent published evidence [AWS semantic-caching benchmark, 63,796 real chatbot queries] places the achievable range: at cosine threshold 0.95 → 51.9 % cost reduction with 92.6 % accuracy; at 0.75 → 86.3 % with 91.2 % accuracy; hits up to 59× faster. GPTCache's own evaluation reports 61.6–68.8 % hit rates at 0.8. BV-SALA's position: the calibrated floor mechanism (serve nothing until *your* labels certify the floor at 95 % confidence) is the right safety instrument for the 0.90–0.95 region; community mode makes that mechanism available without any commercial gate. A multi-tenant benchmark of the calibrated store is preregistered below."
  },
  {
    "tipo": "h2",
    "texto": "5 · Method (unchanged, restated for completeness)"
  },
  {
    "tipo": "p",
    "texto": "  model and constructed content; cost from provider-reported usage at versioned list   prices; primary metric `R = (C_base − C_opt) / C_base`."
  },
  {
    "tipo": "p",
    "texto": "  (gateway replay) is the resampling unit; 95 % interval = empirical 2.5/97.5   percentiles. Seeds published."
  },
  {
    "tipo": "p",
    "texto": "  `provider_cached_tokens` — never summed into one unconditional figure."
  },
  {
    "tipo": "p",
    "texto": "  (explicit matching conditions against a prior identical executed request),   `estimated` (reconstructed), `unmeasured` (stream without final usage). Labels   describe the evidence basis; they never convert an estimate into an invoice fact."
  },
  {
    "tipo": "li",
    "texto": "**Live double-runs** (condition A without the layer, B instrumented) on the same"
  },
  {
    "tipo": "li",
    "texto": "**Percentile cluster bootstrap**, 10,000 resamples; the family (SDK) or session"
  },
  {
    "tipo": "li",
    "texto": "**Four ledgers** — `avoided_calls`, `eliminated_tokens`, `compressed_tokens`,"
  },
  {
    "tipo": "li",
    "texto": "**Evidence labels** — `measured` (provider counter + documented price), `reference`"
  },
  {
    "tipo": "h2",
    "texto": "6 · Results"
  },
  {
    "tipo": "p",
    "texto": "As in the August edition (unchanged numbers, restated):"
  },
  {
    "tipo": "tabla",
    "filas": [
      [
        "Evidence, system, model",
        "Reduction",
        "95 % CI",
        "Workload and basis"
      ],
      [
        "Live SDK A/B · gpt-4o-mini",
        "**31.5 %**",
        "[25.7; 36.7]",
        "100 families / 200 requests per arm; 30 % exact repeats + 20 % paraphrases; SDK 0.4.31"
      ],
      [
        "Live SDK A/B · claude-sonnet-5",
        "**75.1 %**",
        "[69.3; 79.6]",
        "31 families / 62 requests per arm; `cache_control` enabled in B (≈41 pp of the effect)"
      ],
      [
        "Counterfactual gateway replay · Anthropic TTL",
        "**2.49 %**",
        "[1.50; 3.57]",
        "19,779 requests / 51 sessions / 13 days; partially reconstructed baseline"
      ]
    ]
  },
  {
    "tipo": "p",
    "texto": "**New operational evidence (this edition, labelled operational, no savings interval):**"
  },
  {
    "tipo": "p",
    "texto": "  (SSE with `alt=sse`, and newline-delimited JSON) forward byte-for-byte against a   fake upstream and produce a `measured` record with the provider's `usageMetadata`   mapped to the same ledger shape (implicit cache discounted, thinking tokens summed   to output). This is a non-breakage + metering-fidelity check, not a savings claim."
  },
  {
    "tipo": "p",
    "texto": "  with client headers intact (test-locked). Operational check."
  },
  {
    "tipo": "p",
    "texto": "  this edition's development before publication — evidence that the \"wrong price is   worse than no catalogue\" doctrine is enforced mechanically, not by review."
  },
  {
    "tipo": "li",
    "texto": "Gemini protocol metering: `:generateContent` (JSON) and `:streamGenerateContent`"
  },
  {
    "tipo": "li",
    "texto": "DeepSeek Anthropic-format rewrite: `/v1/messages` travels to `/anthropic/v1/messages`"
  },
  {
    "tipo": "li",
    "texto": "Catalog guard: the price guard test rejected a ×1000 per-million copy error during"
  },
  {
    "tipo": "h2",
    "texto": "7 · Limitations (unchanged, plus two new)"
  },
  {
    "tipo": "p",
    "texto": "All August limitations stand: small constructed samples (100 + 31 families), one gateway organization, no invoice reconciliation, no independent replication, no quality/latency non-inferiority, in-memory linear semantic store, and the authors' developer role. Two additions for this edition:"
  },
  {
    "tipo": "p",
    "texto": "  priced at peak and GLM converted at 7.2 CNY/USD; per-model Kimi/MiniMax prices were   not verifiable from official pages at review time and stay out of the catalog."
  },
  {
    "tipo": "p",
    "texto": "  or entitlement channel at all (by design). A distribution with a *present but   invalid* key remains fail-closed; a user who simply never configures one has an   ungated local product — the intended open-core trade, and the reason the cloud   remains the paid surface."
  },
  {
    "tipo": "li",
    "texto": "The Chinese-provider rows rely on pricing pages consulted 2026-11-03, with DeepSeek"
  },
  {
    "tipo": "li",
    "texto": "Community mode shifts the risk model: without the cloud key there is no revocation"
  },
  {
    "tipo": "h2",
    "texto": "8 · Preregistered research roadmap"
  },
  {
    "tipo": "p",
    "texto": "   with per-cell power analysis."
  },
  {
    "tipo": "p",
    "texto": "   curve (replaces the single-point `r = 1.05` extrapolation)."
  },
  {
    "tipo": "p",
    "texto": "   organizations; releases the immutable resampling artifacts."
  },
  {
    "tipo": "p",
    "texto": "   and adequately powered; includes the routing gate (cheap-model cascade) and the    TTL lever."
  },
  {
    "tipo": "p",
    "texto": "   utilization + Operational Retention Rate, against the AWS/GPTCache reference    points of §4."
  },
  {
    "tipo": "p",
    "texto": "   real organization's provider invoices versus the layer's list-price ledger."
  },
  {
    "tipo": "p",
    "texto": "   from the published branch and artifacts."
  },
  {
    "tipo": "li",
    "texto": "**Factorial design**: deduplication × `cache_control` (attribution of the 41 pp),"
  },
  {
    "tipo": "li",
    "texto": "**ρ sweep**: exact-repeat rate swept across families to estimate the response"
  },
  {
    "tipo": "li",
    "texto": "**Hierarchical multi-day experiment**: families × sessions × days, multiple"
  },
  {
    "tipo": "li",
    "texto": "**Non-inferiority tests**: answer quality, freshness and latency, preregistered"
  },
  {
    "tipo": "li",
    "texto": "**Calibrated semantic cache at scale**: multi-tenant precision across cache"
  },
  {
    "tipo": "li",
    "texto": "**Invoice reconciliation**: negotiated prices, credits, taxes, rounding — one"
  },
  {
    "tipo": "li",
    "texto": "**External replication**: an independent team reproduces the live double-runs"
  },
  {
    "tipo": "h2",
    "texto": "9 · Data and code availability"
  },
  {
    "tipo": "p",
    "texto": "Public-bench summaries remain at savings.bivelio.com. The open-core software ships on npm (`@bivelio/savings-layer`); the gateway test suites (including the Gemini and DeepSeek rewrites) run against fake upstreams with no network. Raw gateway logs remain private."
  },
  {
    "tipo": "h2",
    "texto": "10 · Conflict of interest"
  },
  {
    "tipo": "p",
    "texto": "Unchanged: the author is the founder of BiVelio Inc, which develops the evaluated product. No independent replication is reported."
  },
  {
    "tipo": "h2",
    "texto": "A · Resumen en español"
  },
  {
    "tipo": "p",
    "texto": "Esta edición extiende la evaluación de agosto a la distribución open core: la capa corre sin clave en modo comunitario (todas las palancas locales, telemetría cero), mide tres protocolos de proveedor —incluido el protocolo Gemini— y el endpoint en formato Anthropic de DeepSeek, y añade al catálogo versionado los precios de lista de DeepSeek, Qwen y GLM (DeepSeek a tarifa peak, el lado conservador). Las cifras primarias no cambian: 31,5 % [25,7; 36,7] en OpenAI y 75,1 % [69,3; 79,6] en Anthropic, con ≈41 puntos porcentuales de efecto de caché habilitado por el brazo instrumentado; el replay contrafactual del gateway sigue en 2,49 % [1,50; 3,57]. Se añade un análisis económico del enrutamiento presentado como aritmética condicional —no como ahorro medido— y un mapa de investigación prerregistrado para los diseños factorial y de no inferioridad que la edición de agosto dejó como trabajo futuro."
  }
];
