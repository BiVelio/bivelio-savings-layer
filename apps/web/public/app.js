/*
 * BV-SALA product web — client logic (extracted for a strict CSP).
 * (c) 2026 BiVelio Inc. Proprietary & confidential.
 */
/*
 * This page runs the REAL BV-SALA optimizer, compiled for the browser from the
 * exact same TypeScript the SDK ships (apps/web/vendor/bv-sala.js). There is no
 * re-implemented token math here: the format verifier and the savings meter use
 * the product's own FormatSelector and execution pipeline, so the numbers you
 * see are the numbers you'd get. Everything runs locally — nothing leaves the page.
 */
import {
  FormatSelector,
  defaultTokenizerRegistry,
  createSavingsLayer,
  MockProvider,
} from "./vendor/bv-sala.js";

(function () {
  "use strict";

  /* ---------- theme ---------- */
  var root = document.documentElement;
  var icon = document.getElementById("themeIcon");
  var label = document.getElementById("themeLabel");
  function apply(t) {
    root.setAttribute("data-theme", t);
    icon.textContent = t === "dark" ? "☾" : "☀";
    label.textContent = t === "dark" ? "Dark" : "Light";
  }
  var storedTheme = null;
  try { storedTheme = localStorage.getItem("bv-theme"); } catch (e) {}
  var startDark = storedTheme
    ? storedTheme === "dark"
    : (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  apply(startDark ? "dark" : "light");
  document.getElementById("themeToggle").addEventListener("click", function () {
    var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    apply(next);
    try { localStorage.setItem("bv-theme", next); } catch (e) {}
  });
  // Keep following the OS while the user hasn't chosen explicitly.
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function (e) {
      var s = null; try { s = localStorage.getItem("bv-theme"); } catch (err) {}
      if (!s) apply(e.matches ? "dark" : "light");
    });
  }

  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- the real optimizer (product code, in your browser) ---------- */
  var MODEL = "openai/gpt-4o-mini";
  var selector = new FormatSelector({ tokenizer: defaultTokenizerRegistry });

  /* ---------- number animation ---------- */
  function animate(el, to, fmt) {
    var from = parseFloat(el.getAttribute("data-v") || "0");
    if (reduce || Math.abs(to - from) < 0.0001) { el.setAttribute("data-v", to); el.textContent = fmt(to); return; }
    var start = null, dur = 420;
    function frame(ts) {
      if (start === null) start = ts;
      var p = Math.min(1, (ts - start) / dur), e = 1 - Math.pow(1 - p, 3), v = from + (to - from) * e;
      el.textContent = fmt(v);
      if (p < 1) requestAnimationFrame(frame); else { el.setAttribute("data-v", to); el.textContent = fmt(to); }
    }
    requestAnimationFrame(frame);
  }
  var pct = function (v) { return (v >= 0 ? "" : "−") + Math.abs(v).toFixed(0) + "%"; };
  function money(v) {
    var a = Math.abs(v);
    if (a >= 1e6) return "$" + (v / 1e6).toFixed(2).replace(/\.00$/, "") + "M";
    if (a >= 1e3) return "$" + (v / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    return "$" + v.toFixed(0);
  }

  /* ---------- panel A: format verifier ---------- */
  var samples = {
    wrapped: { users: Array.from({ length: 30 }, function (_, i) {
      return { id: 1000 + i, name: "user_" + i, role: i % 3 === 0 ? "admin" : "member", plan: i % 2 ? "pro" : "free", active: i % 4 !== 0 };
    }) },
    flat: Array.from({ length: 30 }, function (_, i) {
      return { sku: "SKU-" + (i + 1), name: "Widget " + (i + 1), price: (9.99 + i).toFixed(2), stock: (i * 7) % 100 };
    }),
    config: { service: "billing", region: "eu-central", retries: 3, flags: { beta: true, audit: { enabled: true, level: "info" } } }
  };
  var payloadEl = document.getElementById("payload");
  var errEl = document.getElementById("payloadErr");
  var readoutEl = document.getElementById("readout");
  var maxTok = 1;

  function renderFormat() {
    var text = payloadEl.value;
    var parsed;
    try { parsed = JSON.parse(text); errEl.textContent = ""; }
    catch (e) { errEl.textContent = "Waiting for valid data… " + e.message; return; }

    // BV-SALA re-encodes the payload the leanest way and counts the exact tokens,
    // including the instruction overhead — surfacing only the before/after. A
    // challenger must beat the baseline by an absolute AND a relative margin, or
    // the baseline stands (never worse). The internal encodings stay BV-SALA's own.
    var choice = selector.choose(parsed, { model: MODEL });
    var baseTok = choice.candidateTokens["json-compact"] || 0;
    var switched = choice.chosen !== "json-compact";
    var chosenTok = choice.candidateTokens[choice.chosen] != null ? choice.candidateTokens[choice.chosen] : baseTok;
    maxTok = Math.max(baseTok, chosenTok, 1);

    // Only two bars — your data vs BV-SALA — never the internal representations.
    var rows = [
      { name: "Your data", tokens: baseTok, win: false },
      { name: "BV-SALA", tokens: chosenTok, win: switched },
    ];
    readoutEl.innerHTML = "";
    rows.forEach(function (c) {
      var row = document.createElement("div");
      row.className = "fmt-row";
      row.innerHTML =
        '<div class="fmt-name ' + (c.win ? "win" : "") + '">' + c.name + (c.win ? " ●" : "") + '</div>' +
        '<div class="track"><div class="fill ' + (c.win ? "win" : "") + '" style="width:' + (100 * c.tokens / maxTok).toFixed(1) + '%"></div></div>' +
        '<div class="fmt-tok">' + c.tokens.toLocaleString() + '</div>';
      readoutEl.appendChild(row);
    });

    var abs = baseTok - chosenTok;
    var relPct = baseTok ? (abs / baseTok) * 100 : 0;
    animate(document.getElementById("fmtSaved"), switched ? relPct : 0, pct);
    document.getElementById("fmtChosen").textContent = "BV-SALA";
    document.getElementById("fmtDelta").innerHTML = switched
      ? (abs.toLocaleString() + " tokens saved<br>on every send of this payload")
      : "Already optimal here.<br>BV‑SALA never makes it worse.";
  }

  document.getElementById("samples").addEventListener("click", function (e) {
    var b = e.target.closest("[data-sample]"); if (!b) return;
    Array.prototype.forEach.call(this.querySelectorAll(".chip"), function (c) { c.setAttribute("aria-pressed", "false"); });
    b.setAttribute("aria-pressed", "true");
    payloadEl.value = JSON.stringify(samples[b.getAttribute("data-sample")], null, 2);
    renderFormat();
  });
  payloadEl.addEventListener("input", renderFormat);

  /* ---------- panel B: bill projector ---------- */
  var ids = ["reqs", "inTok", "outTok", "inP", "outP", "seats", "avoid", "elim", "outRed"];
  function num(id) { return parseFloat(document.getElementById(id).value) || 0; }
  function project() {
    var reqs = num("reqs"), inTok = num("inTok"), outTok = num("outTok"), inP = num("inP"), outP = num("outP"), seats = num("seats");
    var avoid = num("avoid") / 100, elim = num("elim") / 100, outRed = num("outRed") / 100;
    document.getElementById("avoidV").textContent = num("avoid") + "%";
    document.getElementById("elimV").textContent = num("elim") + "%";
    document.getElementById("outRedV").textContent = num("outRed") + "%";

    var baseIn = reqs * inTok, baseOut = reqs * outTok;
    var baseline = baseIn / 1e6 * inP + baseOut / 1e6 * outP;
    var served = reqs * (1 - avoid);
    var optIn = served * inTok * (1 - elim), optOut = served * outTok * (1 - outRed);
    var optimized = optIn / 1e6 * inP + optOut / 1e6 * outP;
    var saved = baseline - optimized, relPct = baseline ? (saved / baseline) * 100 : 0;

    var w = baseline > 0 ? Math.max(2, 100 * optimized / baseline) : 100;
    document.getElementById("optFill").style.width = w.toFixed(1) + "%";
    animate(document.getElementById("baseAmt"), baseline, money);
    animate(document.getElementById("optAmt"), optimized, money);
    animate(document.getElementById("savedMo"), saved, money);
    animate(document.getElementById("savedPct"), relPct, pct);
    animate(document.getElementById("savedYr"), saved * 12, money);

    var seatCost = seats * 4;
    var multiple = seatCost > 0 ? saved / seatCost : 0;
    document.getElementById("roi").innerHTML = saved > 0
      ? ("For <b>" + money(seatCost) + "/mo</b> in seats you keep <b>" + money(saved) + "/mo</b> — that's <b>" + (multiple >= 100 ? "100+" : multiple.toFixed(0)) + "×</b> back on what you spend.")
      : "Adjust the levers to see the projection.";
  }
  ids.forEach(function (id) { document.getElementById(id).addEventListener("input", project); });

  // Moving a lever by hand drops the "measured" badge — the projection is no
  // longer tied to a real run.
  ["avoid", "elim", "outRed"].forEach(function (id) {
    document.getElementById(id).addEventListener("input", function () {
      var tag = document.getElementById("measuredTag");
      tag.className = "measured-tag idle";
      tag.textContent = "levers set manually";
    });
  });

  /* ---------- real optimizer run (the actual pipeline, over a sample workload) ----------
   * Panel A already runs the real selector on YOUR data. Here we run the whole
   * execution pipeline over a representative support workload so the projector's
   * levers are grounded in a MEASURED run of the product — not guesses. The LLM
   * itself is mocked (no keys, nothing leaves the page); every optimization
   * decision — cache hits, format compression, output budgets, provider-cached
   * input — is the product's real logic. Token reductions come from the run; the
   * dollar figure applies YOUR prices from the fields above.
   */
  function buildWorkload() {
    var bigSystem =
      "You are BiVelio's customer-support assistant. Adhere to policy P-2026 and the tone guide. " +
      "Be accurate, cite the relevant article, and keep answers concise. ".repeat(24);
    var users = Array.from({ length: 24 }, function (_, i) {
      return { id: 2000 + i, name: "user_" + i, role: i % 4 === 0 ? "admin" : "member", plan: i % 2 ? "pro" : "free", active: i % 5 !== 0 };
    });
    var answer = { type: "object", required: ["answer"], properties: { answer: { type: "string" } } };
    var summary = { type: "object", required: ["summary"], properties: { summary: { type: "string" } } };
    var faqs = [
      "What are your support hours?",
      "How do I reset my password?",
      "Where do I download my invoice?",
      "What is your refund policy?",
      "How do I add a teammate to my workspace?",
    ];
    var w = [];
    // Each FAQ arrives twice — the second as a paraphrase (case/whitespace). The
    // canonicalizer collapses them, so the repeat is an exact-cache hit: a whole
    // call avoided, its input and output eliminated.
    faqs.forEach(function (q) {
      w.push({ model: MODEL, messages: [{ role: "system", content: bigSystem }, { role: "user", content: q }], response: { contractId: "answer:v1", schema: answer, maxOutputTokens: 90 } });
      w.push({ model: MODEL, messages: [{ role: "system", content: bigSystem }, { role: "user", content: "   " + q.toUpperCase() + "  " }], response: { contractId: "answer:v1", schema: answer, maxOutputTokens: 90 } });
    });
    // Structured-data summaries: the table gets re-encoded to the cheapest format
    // (compression) under a tight output budget. Sent 3×, so 2 also cache-hit.
    for (var i = 0; i < 3; i++) {
      w.push({ model: MODEL, messages: [{ role: "system", content: bigSystem }, { role: "user", content: "Summarize the active admins in this table." }], structuredData: { users: users }, response: { contractId: "summary:v1", schema: summary, maxOutputTokens: 70 } });
    }
    return w;
  }

  function clampSlider(id, ratio) {
    var el = document.getElementById(id);
    var max = parseFloat(el.getAttribute("max")) || 100;
    el.value = String(Math.max(0, Math.min(max, Math.round(ratio * 100))));
  }

  var running = false;
  function setLedger(id, value, unit) {
    var el = document.getElementById(id);
    el.textContent = value.toLocaleString();
    el.className = "mval on";
    document.getElementById("lgu-" + id.slice(3)).textContent = unit;
  }

  async function runReal() {
    if (running) return;
    running = true;
    var btn = document.getElementById("runReal");
    var status = document.getElementById("realStatus");
    btn.disabled = true;
    status.innerHTML = '<span class="spin"></span> running the optimizer…';
    // Let the spinner paint before the (fast, synchronous-ish) run.
    await new Promise(function (r) { requestAnimationFrame(function () { r(); }); });

    try {
      // The public web demo is the free trial surface — run ungated.
      var layer = createSavingsLayer({ provider: new MockProvider({ cachedInputTokens: 96 }), devUnlicensed: true });
      var workload = buildWorkload();
      var a = { baselineLlm: 0, avoidedLlm: 0, baselineInput: 0, actualInput: 0, eliminatedInput: 0, eliminatedOutput: 0, compressedInput: 0, providerCachedInput: 0, baselineOutput: 0, actualOutput: 0 };
      for (var i = 0; i < workload.length; i++) {
        var res = await layer.generate(workload[i]);
        var rep = res.report;
        a.baselineLlm += rep.calls.baselineLlm;
        a.avoidedLlm += rep.calls.avoidedLlm;
        a.baselineInput += rep.tokens.baselineInput;
        a.actualInput += rep.tokens.actualInput;
        a.eliminatedInput += rep.tokens.eliminatedInput;
        a.eliminatedOutput += rep.tokens.eliminatedOutput;
        a.compressedInput += rep.tokens.compressedInput;
        a.providerCachedInput += rep.tokens.providerCachedInput || 0;
        a.baselineOutput += rep.tokens.baselineOutput;
        a.actualOutput += rep.tokens.actualOutput;
      }

      var avoidPct = a.baselineLlm ? a.avoidedLlm / a.baselineLlm : 0;
      var inputRedPct = a.baselineInput ? (a.baselineInput - a.actualInput) / a.baselineInput : 0;
      var outputRedPct = a.baselineOutput ? (a.baselineOutput - a.actualOutput) / a.baselineOutput : 0;

      clampSlider("avoid", avoidPct);
      clampSlider("elim", inputRedPct);
      clampSlider("outRed", outputRedPct);
      project();

      setLedger("lg-avoided", a.avoidedLlm, "of " + a.baselineLlm + " calls never ran");
      setLedger("lg-eliminated", a.eliminatedInput + a.eliminatedOutput, "input + output tokens dropped");
      setLedger("lg-compressed", a.compressedInput, "input tokens re-encoded smaller");
      setLedger("lg-cached", a.providerCachedInput, "input tokens billed cheaper");

      var tag = document.getElementById("measuredTag");
      tag.className = "measured-tag";
      tag.textContent = "in-browser estimate · mock model";
      // Honest framing: this runs the REAL optimizer logic, but against a MOCK
      // model — so it is an illustrative estimate, not a provider-measured
      // number. Real dollars come from the A/B benchmark (pnpm ab, LIVE).
      status.innerHTML = "Illustrative estimate from the real optimizer over " + workload.length +
        " requests (mock model): <b>" + num("avoid") + "%</b> calls avoided · <b>" + num("elim") +
        "%</b> input cut · <b>" + num("outRed") + "%</b> output cut. For provider-measured $, run the A/B benchmark (LIVE).";
    } catch (e) {
      status.textContent = "Could not run the optimizer: " + (e && e.message ? e.message : e);
    } finally {
      btn.disabled = false;
      running = false;
    }
  }
  document.getElementById("runReal").addEventListener("click", function () { runReal(); });

  /* ---------- Step 2: render the MEASURED A/B benchmark artifact ---------- */
  function fmtPct(n) { return (n >= 0 ? "" : "−") + Math.abs(n * 100).toFixed(1) + "%"; }

  function abHeadline(ab, live) {
    var s = ab.aggregate.savings;
    var dmin = Math.min(-0.05, s.lower - 0.05), dmax = Math.max(0.6, s.upper + 0.05);
    var xp = function (v) { return Math.max(0, Math.min(100, (v - dmin) / (dmax - dmin) * 100)); };
    var q = ab.aggregate.qualityPassRate, recon = ab.reconciliation ? ab.reconciliation.reconciled : true, fp = ab.fingerprintStable !== false;
    return '<div class="ab-headline">' +
      '<div><div class="ab-hl-num ' + (live ? "" : "est") + '">' + fmtPct(s.point) + '</div>' +
      '<div class="ab-hl-cap">net savings · per cold single call · ' + (live ? "<b>95% CI [" + fmtPct(s.lower) + ", " + fmtPct(s.upper) + "]</b>" : "estimated (mock)") + '</div></div>' +
      '<div class="ci-wrap"><div class="ci-track">' +
        '<div class="ci-band ' + (live ? "" : "est") + '" style="left:' + xp(s.lower) + '%;width:' + (xp(s.upper) - xp(s.lower)) + '%"></div>' +
        '<div class="ci-zero" style="left:' + xp(0) + '%"></div><div class="ci-point" style="left:' + xp(s.point) + '%"></div>' +
      '</div><div class="ci-legend"><span>' + fmtPct(dmin) + '</span><span>0%</span><span>' + fmtPct(dmax) + '</span></div>' +
      '<div class="ab-stats">' +
        '<span>quality <b class="' + (q >= 0.999 ? "ok" : "bad") + '">' + (q * 100).toFixed(0) + '%</b> gate-passed</span>' +
        '<span>reconciles <b class="' + (recon ? "ok" : "bad") + '">' + (recon ? "✓" : "✗") + '</b></span>' +
        '<span>model stable <b class="' + (fp ? "ok" : "bad") + '">' + (fp ? "✓" : "✗") + '</b></span>' +
        (ab.model ? '<span>model <b>' + ab.model + '</b></span>' : "") +
      '</div></div></div>';
  }
  function abLedgers(ab, live) {
    return '<div class="ab-ledgers">' + (ab.ledgers || []).map(function (l) {
      var pos = l.savings.point >= 0;
      var badge = !live ? '<span class="b np">est</span>' : (l.proven ? '<span class="b proven">proven</span>' : '<span class="b np">not proven</span>');
      return '<div class="ab-lg"><div class="n">' + l.ledger + '</div><div class="v ' + (pos ? "pos" : "neg") + '">' + fmtPct(l.savings.point) +
        '</div><div class="lo">95% ≥ ' + fmtPct(l.savings.lower) + '</div>' + badge + '</div>';
    }).join("") + '</div>';
  }
  function abTable(ab) {
    var rows = (ab.scenarios || []).map(function (s) {
      var sv = s.measured.savings, cls = sv.point >= 0 ? "pos" : "neg";
      return '<tr><td>' + s.name + '</td><td class="mono">' + s.kind + '</td>' +
        '<td class="mono">' + Math.round(s.armA.meanInputTokens) + "/" + Math.round(s.armA.meanOutputTokens) + '</td>' +
        '<td class="mono">' + Math.round(s.armB.meanInputTokens) + "/" + Math.round(s.armB.meanOutputTokens) + '</td>' +
        '<td class="mono ' + cls + '">' + fmtPct(sv.point) + '</td><td class="mono">' + fmtPct(sv.lower) + '</td>' +
        '<td class="mono">' + s.quality.passed + "/" + s.quality.total + '</td></tr>';
    }).join("");
    return '<div class="ab-scroll"><table class="ab-table"><thead><tr><th>scenario</th><th>kind</th><th>A in/out</th><th>B in/out</th><th>savings</th><th>95% lo</th><th>qa</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }
  function abCache(ab) {
    var cache = (ab.scenarios || []).filter(function (s) { return s.amortization; });
    if (!cache.length) return "";
    var items = cache.map(function (s) { return s.name + " breaks even at K=" + (s.amortization.breakEvenK == null ? "∞" : s.amortization.breakEvenK); }).join(" · ");
    return '<div class="ab-banner est"><b>Cache = repeat traffic.</b> On a single cold call caches honestly read ≈0%; savings grow with reuse — ' + items + '.</div>';
  }
  function abRepro() {
    return '<div class="ab-repro"><span class="c"># Reproduce against your own endpoint — nothing hidden:</span>\n' +
      'BVSALA_DEMO_BASE_URL=https://ai-gateway.vercel.sh/v1 \\\n' +
      'BVSALA_DEMO_API_KEY=&lt;key&gt; BVSALA_DEMO_MODEL=openai/gpt-4o-mini BVSALA_DEMO_KEEP_PREFIX=1 \\\n' +
      'pnpm ab\n<span class="c"># raw paired trials → benchmarks/out/ab-live-trials.csv — recompute the CI yourself.</span></div>';
  }
  function renderAB(ab) {
    var root = document.getElementById("ab-root"); if (!root) return;
    var live = ab.mode === "LIVE", agg = ab.aggregate;
    var note = document.getElementById("ab-mode-note");
    if (note) note.innerHTML = live
      ? "This run is <b>LIVE</b> — real provider tokens & cost."
      : "This reference run is <b>MOCK</b> (no network): the figures are <b>ESTIMATED</b> plumbing, not a savings claim — it even shows negatives where the mock inflates output, because the harness never fakes a positive. Run <code>pnpm ab</code> against a real endpoint for measured dollars.";
    var banner = live
      ? (agg.proven ? '<div class="ab-banner verified">✓ VERIFIED — savings ≥ ' + fmtPct(agg.savings.lower) + " at 95% confidence, quality-gated</div>"
                    : '<div class="ab-banner est">⚠ NOT PROVEN — 95% CI lower bound ≤ 0, quality regressed, or model changed mid-run</div>')
      : '<div class="ab-banner est">◐ ESTIMATED — mock provider, not a savings claim</div>';
    root.innerHTML = banner + abHeadline(ab, live) + abLedgers(ab, live) + abTable(ab) + abCache(ab) + abRepro();
  }
  function loadAB() {
    var inline = document.getElementById("ab-inline"), initial = null;
    if (inline) { try { initial = JSON.parse(inline.textContent); } catch (e) { /* ignore */ } }
    if (initial) renderAB(initial);
    // Progressive refresh: on the deployed site, pick up the freshest artifact.
    if (window.fetch) fetch("./data/ab-live.json", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j) renderAB(j); })
      .catch(function () { /* offline / artifact preview — inline fallback already rendered */ });
  }

  /* ---------- init ---------- */
  payloadEl.value = JSON.stringify(samples.wrapped, null, 2);
  renderFormat();
  project();
  // Auto-run once so a first-time visitor immediately sees real measured numbers.
  runReal();
  loadAB();
})();
