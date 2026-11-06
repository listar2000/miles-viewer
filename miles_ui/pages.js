/* Run monitor pages beyond a single run's live view: the results of an eval or bench (from its summary.json),
   and the side-by-side comparison of two runs. Helpers come from app.js (window.MONH) at call time. */
(function () {
  "use strict";
  const H = () => window.MONH;

  // ---- eval and bench results ------------------------------------------------------------------------------
  /* An OOD-task eval keeps, per reasoning effort ("chat", "low", ...), one block per level with pass@1 and counts. */
  function levelBlocks(e) {
    const out = [];
    for (const [effort, v] of Object.entries(e || {})) {
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      const levels = Object.entries(v).filter(([, x]) => x && typeof x === "object" && "pass@1" in x);
      if (levels.length) out.push({ effort, secs: v.secs, levels: levels.map(([name, x]) => ({ name, ...x })) });
    }
    return out;
  }
  const levelName = n => n.replace(/^L(?=[a-z])/, "").replace(/^L(\d)/, "level $1");
  const weighted = lv => { const n = lv.reduce((a, x) => a + (x.tries || 0), 0); return n ? lv.reduce((a, x) => a + x["pass@1"] * (x.tries || 0), 0) / n : null; };
  /* The best decode throughput of a bench, over its arms and concurrency levels. */
  function armBest(e) {
    let best = null;
    for (const [arm, a] of Object.entries(e.arms || {}))
      for (const [c, s] of Object.entries(a.sweep || {}))
        if (s && s.gen_throughput_mean != null && (!best || s.gen_throughput_mean > best.v)) best = { v: s.gen_throughput_mean, arm, c };
    return best;
  }
  const checkSections = e => Object.entries(e || {}).filter(([, v]) => v && typeof v === "object" && !Array.isArray(v) && ("miles_ok" in v || "error" in v || "samples" in v));

  /* One line for a run list and the run page head: {value, label, sub, bar 0..1}. */
  function evalHeadline(e) {
    if (!e) return null;
    const lb = levelBlocks(e);
    if (lb.length) {
      const all = lb.flatMap(b => b.levels), p = weighted(all);
      return { value: p == null ? "–" : p.toFixed(2), label: `pass@1 · ${all.length} levels`, sub: `${e.tasks || "?"} prompts × ${e.tries || "?"} tries${lb.length > 1 ? ` · ${lb.map(b => b.effort).join(", ")}` : ` · ${lb[0].effort}`}`, bar: p };
    }
    if (e.arms) {
      const arms = Object.values(e.arms), failed = arms.filter(a => a.error && !a.sweep).length, b = armBest(e);
      if (b) return { value: `${Math.round(b.v).toLocaleString()} tok/s`, label: `best decode · ${b.arm} at ${b.c}`, sub: `${arms.length - failed} of ${arms.length} arms ran` };
      return { value: failed ? "failed" : "no sweep", label: failed ? `${failed === arms.length ? "every" : failed + " of " + arms.length} arm${arms.length === 1 ? "" : "s"} failed before the sweep` : "no throughput measured", sub: "" };
    }
    const cs = checkSections(e);
    if (cs.length) {
      const ok = cs.filter(([, v]) => v.miles_ok === true).length;
      return { value: `${ok}/${cs.length}`, label: "checks passed", sub: cs.filter(([, v]) => v.error).length ? `${cs.filter(([, v]) => v.error).length} errored` : "", bar: ok / cs.length };
    }
    return null;
  }

  const KIND_COL = { ok: "var(--good)", wrong: "var(--bad)", multi_answer: "var(--warn)", bad_format: "var(--verify)", truncated: "var(--idle)" };
  const kindCol = k => KIND_COL[k] || "var(--ink-3)";
  const TRIES = {};
  function triesOf(rid, level, kind) {
    const k = `${rid}|${level}|${kind}`;
    if (!(k in TRIES)) {
      TRIES[k] = undefined;
      fetch(`api/evaltries?run=${encodeURIComponent(rid)}&level=${encodeURIComponent(level)}&kind=${encodeURIComponent(kind)}`).then(r => r.json())
        .then(d => { TRIES[k] = d || []; }, () => { TRIES[k] = []; }).finally(() => H().schedule());
    }
    return TRIES[k];
  }
  const evSel = {};  // run_id -> {level, kind} picked for sample answers

  function levelsHTML(e, r) {
    const { esc, int, more, plural } = H();
    const lb = levelBlocks(e), kinds = [...new Set(lb.flatMap(b => b.levels.flatMap(x => Object.keys(x.kinds || {}))))].sort((a, b) => (a === "ok" ? -1 : b === "ok" ? 1 : a < b ? -1 : 1));
    let h = "";
    for (const b of lb) {
      const p = weighted(b.levels);
      h += `<h3>${esc(b.effort)} <span style="text-transform:none;letter-spacing:0;font-weight:400">· pass@1 ${p == null ? "–" : p.toFixed(2)}${b.secs ? ` · ${H().dur(b.secs)} of sampling` : ""}</span></h3>
        <div class="scroll"><table class="lvl"><thead><tr><th>Level</th><th>pass@1</th><th class="num" title="prompts where every try passed / some passed / none passed">All pass · mixed · all fail</th><th>Answer kinds</th><th class="num">Tokens p50 · p90</th><th class="num">Truncated</th><th></th></tr></thead><tbody>
        ${b.levels.map(x => {
          const tot = Object.values(x.kinds || {}).reduce((a, v) => a + v, 0) || 1, full = x.prompts_full || 0, mixed = Math.round((x.mixed || 0) * full);
          return `<tr data-key="lv-${esc(b.effort)}-${esc(x.name)}"><td><b>${esc(levelName(x.name))}</b></td>
            <td class="nowrap"><span class="pbar"><i style="width:${(100 * x["pass@1"]).toFixed(1)}%"></i></span><b>${x["pass@1"].toFixed(2)}</b></td>
            <td class="num small">${x.all_pass ?? "–"} · ${mixed} · ${x.all_fail ?? "–"} <span class="muted">of ${full}</span></td>
            <td><div class="kbar" title="${esc(Object.entries(x.kinds || {}).map(([k, v]) => `${k} ${v}`).join(" · "))}">${kinds.filter(k => (x.kinds || {})[k]).map(k => `<i style="width:${(100 * x.kinds[k] / tot).toFixed(1)}%;background:${kindCol(k)}"></i>`).join("")}</div></td>
            <td class="num small">${int(x.tokens_p50)} · ${int(x.tokens_p90)}</td>
            <td class="num small">${x.truncated != null ? (100 * x.truncated).toFixed(0) + "%" : "–"}</td>
            <td>${(e._tries_files || []).length ? `<button class="linkish" onclick="Pages.pickTries('${esc(r.run_id)}','${esc(x.name.replace(/^L/, ""))}')">answers</button>` : ""}</td></tr>`;
        }).join("")}</tbody></table></div>`;
    }
    h += `<div class="barkey" style="margin-top:6px">${kinds.map(k => `<span><i style="background:${kindCol(k)}"></i>${esc(k.replace(/_/g, " "))}</span>`).join("")}</div>`;
    const sel = evSel[r.run_id];
    if (sel) {
      const rows = triesOf(r.run_id, sel.level, sel.kind);
      const kseg = ["", ...kinds].map(k => `<button class="${sel.kind === k ? "on" : ""}" onclick="Pages.pickTries('${esc(r.run_id)}','${esc(sel.level)}','${esc(k)}')">${k ? esc(k.replace(/_/g, " ")) : "any"}</button>`).join("");
      h += `<div class="spread" style="margin-top:12px"><h3 style="margin:0">Sampled answers · ${esc(sel.level)}</h3><div class="row"><div class="seg">${kseg}</div><button class="x" onclick="Pages.pickTries('${esc(r.run_id)}', null)" title="close">✕</button></div></div>
        ${rows === undefined ? `<div class="muted small">loading…</div>` : !rows.length ? `<div class="muted small">No answers of that kind.</div>` :
          rows.slice(0, 6).map(x => `<div class="small"><span class="dot" style="background:${kindCol(x.kind)}"></span><b>${esc(x.id)}</b> try ${x.try} · ${esc(x.kind)} · reward ${x.reward} · ${int(x.tokens)} tokens · ${x.secs}s${x.label ? ` <span class="muted mono">${esc(String(x.label).slice(0, 120))}</span>` : ""}</div><div class="answer">${esc(x.answer)}</div>`).join("")}`;
    }
    return h;
  }

  function armsHTML(e) {
    const { esc, int, more, dur } = H();
    const arms = Object.entries(e.arms || {});
    const levels = [...new Set(arms.flatMap(([, a]) => Object.keys(a.sweep || {})))].sort((a, b) => +a - +b);
    const max = Math.max(1, ...arms.flatMap(([, a]) => Object.values(a.sweep || {}).map(s => s.gen_throughput_mean || 0)));
    const cell = s => !s ? `<span class="muted">–</span>` : `<div class="nowrap"><span class="res-bar" style="width:46px"><i style="width:${(100 * (s.gen_throughput_mean || 0) / max).toFixed(0)}%;background:var(--t-bench)"></i></span><b>${int(s.gen_throughput_mean)}</b> <span class="muted small">tok/s</span></div>
      <div class="muted small">${s.per_request_tok_s_p50 != null ? `${Math.round(s.per_request_tok_s_p50)} per request` : ""}${s.spec_accept_length_mean ? ` · accept ${s.spec_accept_length_mean.toFixed(2)}` : ""}${s.errors ? ` · <span class="err">${s.errors} errors</span>` : ""}</div>`;
    // what tells the arms apart: their server args and env, minus what every arm shares
    const argsOf = a => [...(a.args || []).reduce((o, x, i, xs) => { if (x.startsWith("--")) o.push(x + (xs[i + 1] && !xs[i + 1].startsWith("--") ? " " + xs[i + 1] : "")); return o; }, []),
      ...Object.entries(a.env || {}).map(([k, v]) => `${k}=${v}`), ...Object.entries(a.set || {}).map(([k, v]) => `${k}=${v}`)];
    const common = arms.length > 1 ? argsOf(arms[0][1]).filter(x => arms.every(([, a]) => argsOf(a).includes(x))) : [];
    return `<div class="scroll"><table><thead><tr><th>Arm</th><th>Outcome</th><th class="num">Startup</th>${levels.map(c => `<th>${esc(c)} in flight</th>`).join("")}<th class="num" title="mean |train - rollout| log-prob over teacher-forced tokens">Log-prob gap</th></tr></thead><tbody>
      ${arms.map(([name, a]) => `<tr data-key="arm-${esc(name)}"><td><b>${esc(name)}</b><div class="muted small">${esc(argsOf(a).filter(x => !common.includes(x)).join(" ").slice(0, 140))}</div></td>
        <td class="small">${a.error ? `<span class="err" title="${esc(a.error)}">failed</span><div class="muted">${esc(String(a.error).slice(0, 90))}</div>` : a.sweep ? `<span class="dot t-good"></span>ran` : `<span class="muted">no sweep</span>`}</td>
        <td class="num small">${a.startup_s ? dur(a.startup_s) : "–"}</td>${levels.map(c => `<td>${cell((a.sweep || {})[c])}</td>`).join("")}
        <td class="num small">${a.lp && a.lp.tf_mean_abs != null ? a.lp.tf_mean_abs.toFixed(3) : "–"}</td></tr>`).join("")}</tbody></table></div>
      ${common.length ? more("arms-common", "server args every arm shares", () => `<div class="muted small mono" style="word-break:break-all">${esc(common.join(" "))}</div>`) : ""}`;
  }

  function checksHTML(e) {
    const { esc, more } = H();
    const fmtv = v => v == null ? "–" : typeof v === "number" ? String(+v.toPrecision(4)) : typeof v === "boolean" ? (v ? "yes" : "no") : typeof v === "object" && "mean" in v ? `${+(+v.mean).toPrecision(4)} <span class="muted">(${+(+v.min).toPrecision(3)}…${+(+v.max).toPrecision(3)})</span>` : esc(JSON.stringify(v)).slice(0, 80);
    return `<div class="scroll"><table><thead><tr><th>Check</th><th>miles_ok</th><th>Samples</th><th>Key values (mean, min…max)</th></tr></thead><tbody>
      ${checkSections(e).map(([name, v]) => `<tr data-key="chk-${esc(name)}"><td><b>${esc(name)}</b></td><td>${v.error ? `<span class="err">error</span>` : v.miles_ok ? `<span class="dot t-good"></span>yes` : v.miles_ok === false ? `<span class="err">no</span>` : "–"}</td>
        <td class="num">${v.samples ?? "–"}</td><td class="small">${v.error ? esc(String(v.error).slice(0, 160)) : Object.entries(v).filter(([k, x]) => !["samples", "errors", "miles_ok", "error"].includes(k) && (typeof x === "number" || (x && typeof x === "object" && "mean" in x))).slice(0, 5)
          .map(([k, x]) => `<span class="nowrap">${esc(k)} ${fmtv(x)}</span>`).join(" · ")}</td></tr>`).join("")}</tbody></table></div>`;
  }

  /* The results panel of an eval or bench run page. e: its summary.json (null: none on the volume). */
  function evalResults(e, r) {
    const { esc, dur, more } = H();
    if (e === undefined) return `<div class="panel" data-key="p-results"><h2>Results</h2><div class="muted small">loading the run's summary.json…</div></div>`;
    if (e === null) return `<div class="panel" data-key="p-results"><h2>Results</h2><div class="muted small">No summary.json for this run on the results volume yet (written when the eval or bench ends).</div></div>`;
    const body = levelBlocks(e).length ? levelsHTML(e, r) : e.arms ? armsHTML(e) : checkSections(e).length ? checksHTML(e) : "";
    const facts = [e.gpu && `GPU ${e.gpu}`, e.sglang && `SGLang ${e.sglang}`, e.startup_s && `engine up in ${dur(e.startup_s)}`, e.minutes && `${e.minutes} min budget`, e.max_tokens && `max ${e.max_tokens.toLocaleString()} tokens`, e.mem_frac && `mem ${e.mem_frac}`].filter(Boolean);
    return `<div class="panel" data-key="p-results"><h2>Results</h2>${body || `<div class="muted small">This summary has no format the page knows; see the raw fields below.</div>`}
      <p class="srcnote">${facts.map(esc).join(" · ")}${e.image ? ` · image <span class="mono">${esc(e.image.split("@")[0].split("/").pop())}</span>` : ""}</p>
      ${more("raw-summary", "raw summary.json", () => `<pre class="answer" style="max-height:360px">${esc(JSON.stringify(e, null, 1)).slice(0, 40000)}</pre>`)}</div>`;
  }

  // ---- compare two runs ---------------------------------------------------------------------------------------
  const CMP = { detail: {}, series: {} };
  function fetchOnce(store, k, url) {
    if (k in store) return store[k];
    store[k] = undefined;
    fetch(url).then(r => r.json()).then(d => { store[k] = d; }, () => { store[k] = null; }).finally(() => H().schedule());
    return undefined;
  }
  const cmpState = { mode: null };
  const STEP_METRICS = [["loss", "Train loss", ""], ["val_nll", "Validation NLL", ""], ["lr", "Learning rate", ""], ["tok_per_s", "Trainer tokens/s", "tok/s"], ["raw_reward", "Reward per step", "r"], ["raw_reward_unfiltered", "Reward of groups finished this step (not the trained batch)", "r"], ["response_len", "Response length, mean", "tok"],
    ["truncated", "Truncated samples", "frac"], ["zero_std_all_zero", "Groups with all-zero reward", "frac"], ["zero_std_all_one", "Groups with all-one reward", "frac"],
    ["grad_norm", "Grad norm", ""], ["logprob_diff", "Train vs rollout log-prob gap", ""],
    ["mis_mask_low", "MIS masked, ratio below band", "frac"], ["mis_mask_high", "MIS masked, ratio above band", "frac"], ["sc_masked", "MIS masked (score centering)", "frac"], ["sc_weight", "MIS mean token weight (score centering)", ""], ["staleness", "Weight staleness", ""], ["step_time", "Step time", "s"], ["update_weights_time", "Weight sync time", "s"]];
  const SERIES_METRICS = [["engine.gen_tps", "Output tokens/s (decode)", "tok/s"], ["engine.running_req", "Running requests", ""], ["engine.queue_req", "Queued requests", ""],
    ["engine.kv_usage", "KV cache usage (full attention)", "frac"], ["engine.prefix_hit", "Prefix cache hit rate", "frac"], ["gpu.util", "GPU utilization, mean over nodes", "%"],
    ["gpu.power", "GPU power, mean over nodes", "W"], ["gpu.mem_alloc", "GPU memory allocated, mean over nodes", "%"], ["trials.in_flight", "Trials in flight", ""], ["trials.mean_reward", "Mean reward of finished trials", "r"]];
  /* One series for a metric: the run's own, or the mean over its nodes ("<metric>@<node>"), binned per minute. */
  function seriesOf(d, k) {
    if (!d || !d.series) return [];
    const parts = Object.keys(d.series).filter(x => x === k || x.startsWith(k + "@")).map(x => d.series[x]).filter(p => p.length);
    if (parts.length <= 1) return parts[0] || [];
    const bins = new Map();
    for (const p of parts) for (const [t, v] of p) { const b = Math.floor(t / 60) * 60, o = bins.get(b) || [0, 0]; o[0] += v; o[1]++; bins.set(b, o); }
    return [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([t, [s, n]]) => [t, s / n]);
  }

  function compare(ka, kb) {
    const h = H(), { esc, fmt, dur, usd, mean2, int, plural, tpill, typeOf, statusHTML, stepsOf, started, runDur, costNow, compareHref } = h;
    const A = h.runByKey(ka), B = h.runByKey(kb);
    if (!A || !B) return `<div class="panel">${h.S.runs.length ? "One of the two runs is not in the run list." : "loading…"} <a href="#tab=runs">← runs</a></div>`;
    const dA = fetchOnce(CMP.detail, ka, "api/detail?run=" + encodeURIComponent(ka)), dB = fetchOnce(CMP.detail, kb, "api/detail?run=" + encodeURIComponent(kb));
    const sA = fetchOnce(CMP.series, A.run_id, "api/series?max=800&run=" + encodeURIComponent(A.run_id)), sB = fetchOnce(CMP.series, B.run_id, "api/series?max=800&run=" + encodeURIComponent(B.run_id));
    const evA = ["eval", "bench"].includes(typeOf(A)) ? h.evalOf(A.run_id) : null, evB = ["eval", "bench"].includes(typeOf(B)) ? h.evalOf(B.run_id) : null;
    const stA = stepsOf(A), stB = stepsOf(B);
    const head = (r, c) => `<div class="cmp-run ${c}"><div class="row"><span class="sw ${c}"></span><a class="rid" href="#tab=runs&run=${encodeURIComponent(r.key)}">${esc(r.run_id)}</a>${tpill(typeOf(r))}${statusHTML(r)}</div>
      <div class="small" style="margin-top:4px">${esc((r.registry || {}).title || "")}</div><div class="muted small">${esc(r.group || "")} · started ${fmt(started(r))}</div></div>`;
    const peers = h.S.runs.filter(r => r.group === A.group && r.key !== ka && r.key !== kb);
    // facts side by side; a number gets B's change against A
    const med = xs => { const v = xs.filter(x => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
    const avg = xs => { const v = xs.filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const rw = st => st.filter(s => s.raw_reward != null).map(s => s.raw_reward);
    const F = [
      ["Ran for", r => [dur(runDur(r)), runDur(r)], "lower"],
      ["Modal cost", r => r.cost ? [costNow(r.cost), r.cost.estimate || r.cost.total] : null, "lower"],
      ["GPU", r => (r.registry || {}).gpu ? [esc(h.gpuLabel(r)), null] : null],
      ["Steps done", r => stepsOf(r).length ? [String(stepsOf(r).length), stepsOf(r).length] : null, "higher"],
      ["Train loss, mean of last 10", r => { if (typeOf(r) !== "sft") return null; const v = avg(stepsOf(r).slice(-10).map(s => s.loss)); return v != null ? [v.toFixed(4), v] : null; }, "lower"],
      ["Val NLL, last", r => { const v = ((r.train || {}).vals || []).slice(-1)[0]; return v ? [`${v[1].toFixed(4)} <span class="muted small">after ${v[0]} steps</span>`, v[1]] : null; }, "lower"],
      ["Trainer tokens/s, median", r => { const v = med(stepsOf(r).map(s => s.tok_per_s)); return v != null ? [int(v), v] : null; }, "higher"],
      ["Reward, first step", r => rw(stepsOf(r)).length ? [mean2(rw(stepsOf(r))[0]), rw(stepsOf(r))[0]] : null, "higher"],
      ["Reward, last step", r => rw(stepsOf(r)).length ? [mean2(rw(stepsOf(r)).slice(-1)[0]), rw(stepsOf(r)).slice(-1)[0]] : null, "higher"],
      ["Reward, mean of last 3", r => rw(stepsOf(r)).length >= 3 ? [mean2(avg(rw(stepsOf(r)).slice(-3))), avg(rw(stepsOf(r)).slice(-3))] : null, "higher"],
      ["Step time, median", r => { const v = med(stepsOf(r).map(s => s.step_time)); return v != null ? [dur(v), v] : null; }, "lower"],
      ["Weight sync, median", r => { const v = med(stepsOf(r).map(s => s.update_weights_time)); return v != null ? [h.secs(v), v] : null; }, "lower"],
      ["Response length, mean", r => { const v = avg(stepsOf(r).map(s => s.response_len)); return v != null ? [int(v) + " tok", v] : null; }],
      ["Log-prob gap, mean", r => { const v = avg(stepsOf(r).map(s => s.logprob_diff)); return v != null ? [v.toFixed(4), v] : null; }, "lower"],
      ["Trials finished", r => r.trials ? [int(r.trials.finished), r.trials.finished] : null],
      ["Mean trial reward", r => r.trials && r.trials.with_reward ? [mean2(r.trials.mean_reward), r.trials.mean_reward] : null, "higher"],
      ["Tasks solved", r => r.trials && r.trials.tasks_total ? [`${r.trials.tasks_solved}/${r.trials.tasks_total}`, r.trials.tasks_solved / r.trials.tasks_total] : null, "higher"],
      ["Result", (r, e) => { const x = e && evalHeadline(e); return x ? [`${esc(x.value)} <span class="muted small">${esc(x.label)}</span>`, x.bar ?? null] : null; }, "higher"],
    ];
    const rowsF = F.map(([label, f, better]) => [label, f(A, evA), f(B, evB), better]).filter(([, a, b]) => a || b);
    // pass@1 over different level sets isn't comparable: no delta then
    const lvls = e => levelBlocks(e).flatMap(b => b.levels.map(x => x.name)).sort().join(",");
    if (evA && evB && lvls(evA) !== lvls(evB)) for (const row of rowsF) if (row[0] === "Result" && row[1] && row[2]) { row[1] = [row[1][0], null]; row[2] = [row[2][0] + ` <span class="delta">different levels</span>`, null]; }
    const delta = (a, b, better) => {
      if (!a || !b || a[1] == null || b[1] == null || a[1] === b[1]) return "";
      const d = b[1] - a[1], rel = a[1] ? d / Math.abs(a[1]) : null;
      const good = rel != null && Math.abs(rel) < 0.02 ? null : better === "higher" ? d > 0 : better === "lower" ? d < 0 : null;
      const txt = Math.abs(a[1]) >= 10 || rel == null ? `${rel != null ? (rel > 0 ? "+" : "") + Math.round(rel * 100) + "%" : ""}` : `${d > 0 ? "+" : ""}${+d.toPrecision(2)}`;
      return txt ? `<span class="delta ${good ? "up" : ""}" title="${good == null ? "B vs A" : good ? "better in B" : "worse in B"}">${good === false ? "▾ " : good ? "▴ " : ""}${txt}</span>` : "";
    };
    const facts = `<table class="facts"><colgroup><col style="width:220px"><col><col></colgroup><thead><tr style="text-transform:none;letter-spacing:0"><th></th><th style="text-transform:none;letter-spacing:0"><span class="sw a"></span> A · ${esc(A.run_id)}</th><th style="text-transform:none;letter-spacing:0"><span class="sw b"></span> B · ${esc(B.run_id)}</th></tr></thead><tbody>
      ${rowsF.map(([l, a, b, better]) => `<tr data-key="f-${esc(l)}" class="${a && b && a[0] !== b[0] ? "diff" : ""}"><td class="muted">${l}</td><td class="va">${a ? a[0] : "–"}</td><td class="vb">${b ? b[0] : "–"}${delta(a, b, better)}</td></tr>`).join("")}</tbody></table>`;
    // charts: per step when both trained, else time since each run's start
    const bothSteps = stA.length >= 2 && stB.length >= 2;
    const mode = cmpState.mode && (cmpState.mode !== "step" || bothSteps) ? cmpState.mode : bothSteps ? "step" : "elapsed";
    const ready = sA !== undefined && sB !== undefined;
    let sections = "";
    if (bothSteps || stA.length || stB.length) sections += `<div class="group-head"><span class="group-title">Training, per step</span><span class="muted small">Miles' own per-step log lines</span></div><div class="grid" data-cmp="steps"></div>`;
    sections += `<div class="group-head"><span class="group-title">Engine, GPU and trials</span><span class="muted small">${mode === "step" ? "the mean over each training step's window" : "x is the time since each run started"}; GPU metrics are the mean over the run's nodes</span>
      ${bothSteps ? `<div class="seg" style="margin-left:auto">${[["step", "x: step"], ["elapsed", "x: time since start"]].map(([v, l]) => `<button class="${mode === v ? "on" : ""}" onclick="Pages.cmpMode('${v}')">${l}</button>`).join("")}</div>` : ""}</div>
      <div class="grid" data-cmp="series">${ready ? "" : `<div class="card muted">loading curves…</div>`}</div>`;
    // evals: per level / per arm / per task, side by side
    let evalCmp = "";
    if (evA && evB && levelBlocks(evA).length && levelBlocks(evB).length) {
      const keyed = e => { const bs = levelBlocks(e), multi = bs.length > 1; return Object.fromEntries(bs.flatMap(b => b.levels.map(x => [(multi ? b.effort + " · " : "") + levelName(x.name), { ...x, effort: b.effort }]))); };
      const la = keyed(evA), lb = keyed(evB);
      const keys = [...new Set([...Object.keys(la), ...Object.keys(lb)])];
      const both = Object.keys(la).filter(k => lb[k]);
      evalCmp = `<div class="panel" data-key="cmp-levels"><h2>pass@1 per level <span class="muted" style="font-weight:400">${both.length} of ${new Set([...Object.keys(la), ...Object.keys(lb)]).size} levels in both · A ${esc([...new Set(levelBlocks(evA).map(b => b.effort))].join(", "))}, B ${esc([...new Set(levelBlocks(evB).map(b => b.effort))].join(", "))}</span></h2><table class="facts"><thead><tr><th>Level</th><th><span class="sw a"></span> A</th><th><span class="sw b"></span> B</th></tr></thead><tbody>
        ${keys.map(k => { const a = la[k], b = lb[k]; return `<tr data-key="cl-${esc(k)}"><td>${esc(k)}</td><td class="va">${a ? `<span class="pbar"><i style="width:${100 * a["pass@1"]}%;background:var(--cmp-a)"></i></span>${a["pass@1"].toFixed(2)}` : "–"}</td><td class="vb">${b ? `<span class="pbar"><i style="width:${100 * b["pass@1"]}%;background:var(--cmp-b)"></i></span>${b["pass@1"].toFixed(2)}` : "–"}${a && b ? delta([0, a["pass@1"]], [0, b["pass@1"]], a.effort === b.effort ? "higher" : null) : ""}</td></tr>`; }).join("")}</tbody></table></div>`;
    } else if (evA && evB && (evA.arms || evB.arms)) {
      const best = e => { const o = {}; for (const [n, a] of Object.entries(e.arms || {})) { let m = null; for (const [c, s] of Object.entries(a.sweep || {})) if (s.gen_throughput_mean != null && (!m || s.gen_throughput_mean > m.v)) m = { v: s.gen_throughput_mean, c }; o[n] = m ? m : { err: a.error }; } return o; };
      const ba = best(evA), bb = best(evB), keys = [...new Set([...Object.keys(ba), ...Object.keys(bb)])];
      const c = x => !x ? "–" : x.v != null ? `<b>${int(x.v)}</b> tok/s <span class="muted small">at ${x.c}</span>` : `<span class="err">failed</span>`;
      evalCmp = `<div class="panel" data-key="cmp-arms"><h2>Best decode throughput per arm</h2><table class="facts"><thead><tr><th>Arm</th><th><span class="sw a"></span> A</th><th><span class="sw b"></span> B</th></tr></thead><tbody>
        ${keys.map(k => `<tr data-key="ca-${esc(k)}"><td><b>${esc(k)}</b></td><td class="va">${c(ba[k])}</td><td class="vb">${c(bb[k])}${ba[k] && bb[k] && ba[k].v && bb[k].v ? delta([0, ba[k].v], [0, bb[k].v], "higher") : ""}</td></tr>`).join("")}</tbody></table></div>`;
    }
    const ta = dA && dA.trials && dA.trials.tasks, tb = dB && dB.trials && dB.trials.tasks;
    if (ta && tb && ta.length && tb.length) {
      const ma = Object.fromEntries(ta.map(x => [x.task, x])), mb = Object.fromEntries(tb.map(x => [x.task, x]));
      const keys = [...new Set([...Object.keys(ma), ...Object.keys(mb)])].map(k => ({ k, a: ma[k], b: mb[k], d: ma[k] && mb[k] && ma[k].mean != null && mb[k].mean != null ? mb[k].mean - ma[k].mean : null }))
        .sort((x, y) => Math.abs(y.d ?? -1) - Math.abs(x.d ?? -1));
      const c = (x, col) => x ? `<span class="pbar" style="width:70px"><i style="width:${100 * (x.mean || 0)}%;background:${col}"></i></span>${x.mean != null ? (+x.mean).toFixed(2) : "–"} <span class="muted small">${x.solved}/${x.finished}</span>` : "–";
      evalCmp += `<div class="panel" data-key="cmp-tasks"><h2>Per task <span class="muted" style="font-weight:400">${keys.length} tasks · biggest changes first · mean reward, solved/finished</span></h2>
        <div class="scroll"><table class="facts"><thead><tr><th>Task</th><th><span class="sw a"></span> A</th><th><span class="sw b"></span> B</th></tr></thead><tbody>
        ${keys.slice(0, h.ui.cmpTasksAll ? 1e9 : 15).map(x => `<tr data-key="ct-${esc(x.k)}"><td class="mono small">${esc(x.k)}</td><td class="va">${c(x.a, "var(--cmp-a)")}</td><td class="vb">${c(x.b, "var(--cmp-b)")}${x.d != null && x.d !== 0 ? delta([0, x.a.mean], [0, x.b.mean], "higher") : ""}</td></tr>`).join("")}</tbody></table></div>
        ${keys.length > 15 ? `<div class="tfoot"><span></span><button onclick="MON.toggle('cmpTasksAll')">${h.ui.cmpTasksAll ? "show fewer" : `all ${keys.length}`}</button></div>` : ""}</div>`;
    }
    CUR = { A, B, sA, sB, mode, ready, stA, stB };
    return `<div class="panel" data-key="cmp-head"><div class="spread" style="margin-bottom:10px"><div class="row"><a href="#tab=runs">← runs</a><h2 style="margin:0">Compare two runs</h2></div>
        <div class="row"><button onclick="location.hash='${compareHref(kb, ka)}'">swap A and B</button>${peers.length ? `<select onchange="if(this.value)location.hash=this.value"><option value="">Replace B with…</option>${peers.map(p => `<option value="${esc(compareHref(ka, p.key))}">${esc(p.run_id)}</option>`).join("")}</select>` : ""}</div></div>
      <div class="cmp-head">${head(A, "a")}${head(B, "b")}</div></div>
      <div class="panel" data-key="cmp-facts"><h2>At a glance</h2>${facts}<p class="srcnote">Bold rows differ. ▴ green: B is better where the direction is clear (cost, time, reward); ▾: B is worse. Changes under 2% are left plain.</p></div>
      ${evalCmp}
      <div class="panel" data-key="cmp-charts" id="cmp-charts" data-keep="${esc(ka + "|" + kb + "|" + mode + "|" + ready + "|" + stA.length + "|" + stB.length)}">${sections}</div>`;
  }
  let CUR = null;
  /* Mount the overlay charts once their data is in; the container is kept across re-renders until its key changes. */
  function after() {
    const el = document.getElementById("cmp-charts");
    if (!el || !CUR || el.dataset.painted === el.dataset.keep) return;
    el.dataset.painted = el.dataset.keep;
    const { A, B, sA, sB, mode, ready, stA, stB } = CUR, { esc, typeOf } = H();
    const ca = getComputedStyle(document.documentElement).getPropertyValue("--cmp-a").trim(), cb = getComputedStyle(document.documentElement).getPropertyValue("--cmp-b").trim();
    const card = (id, label) => `<div class="card chart-card" data-c="${esc(id)}"><div class="card-head"><span class="card-title">${esc(label)}</span><span class="card-val"></span></div><canvas></canvas><div class="card-note readout"></div></div>`;
    const plots = [];
    const steps = el.querySelector('[data-cmp="steps"]');
    if (steps) {
      // an RL run's train/loss is its policy loss: compared only when one of the two is an SFT run
      const sft = [A, B].some(r => typeOf(r) === "sft");
      const defs = STEP_METRICS.filter(([k]) => (k !== "loss" || sft) && (stA.some(s => s[k] != null) || stB.some(s => s[k] != null)));
      steps.innerHTML = defs.map(([k, l]) => card("s-" + k, l)).join("");
      for (const [k, l, unit] of defs) plots.push(["s-" + k, l, { unit, xType: "step", dots: stA.length + stB.length <= 80, series: [
        { name: A.run_id, color: ca, points: stA.filter(s => s[k] != null).map(s => [s.n, s[k]]) }, { name: B.run_id, color: cb, points: stB.filter(s => s[k] != null).map(s => [s.n, s[k]]) }] }]);
    }
    const ser = el.querySelector('[data-cmp="series"]');
    if (ser && ready) {
      const t0A = H().started(A) || 0, t0B = H().started(B) || 0;
      const shape = (d, st, t0) => k => { const p = seriesOf(d, k); return mode === "step" ? Curves.bucket(p, st) : p.map(([t, v]) => [t - t0, v]); };
      const fa = shape(sA, stA, t0A), fb = shape(sB, stB, t0B);
      const defs = SERIES_METRICS.map(([k, l, u]) => [k, l, u, fa(k), fb(k)]).filter(([, , , a, b]) => a.length || b.length);
      ser.innerHTML = defs.map(([k, l]) => card("t-" + k, l)).join("");
      if (!defs.length) { ser.previousElementSibling.remove(); ser.remove(); if (!steps) el.style.display = "none"; }
      for (const [k, l, unit, a, b] of defs) plots.push(["t-" + k, l, { unit, xType: mode === "step" ? "step" : "elapsed", dots: mode === "step" && stA.length + stB.length <= 80,
        series: [{ name: A.run_id, color: ca, points: a }, { name: B.run_id, color: cb, points: b }] }]);
    }
    for (const [id, label, opts] of plots) {
      const c = el.querySelector(`[data-c="${CSS.escape(id)}"]`);
      const last = s => { const p = s.points[s.points.length - 1]; return p ? Curves.fmtNum(p[1], opts.unit) : "–"; };
      c.querySelector(".card-val").innerHTML = `<span class="muted small" style="margin-right:6px">last</span>` + opts.series.map(s => `<span class="nv"><i style="background:${s.color}"></i>${last(s)}</span>`).join("");
      Curves.mount(c.querySelector("canvas"), c.querySelector(".readout"), opts);
    }
  }

  window.Pages = {
    evalHeadline, evalResults, compare, after,
    pickTries(rid, level, kind) { if (level == null) delete evSel[rid]; else evSel[rid] = { level: level.startsWith("L") ? level : level, kind: kind || "" }; H().schedule(); },
    cmpMode(m) { cmpState.mode = m; H().schedule(); },
  };
})();
