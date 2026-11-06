/* Curves for the run monitor: a plain canvas line chart (hairline grid, 1.5px lines, end marker,
   crosshair with readout, no animation) and the curves section of a run page. */
(function () {
  "use strict";
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const dark = () => document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  const PALETTE = {
    light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#0f8a8a"],
    dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#2fa02f", "#9085e9", "#3cbcbc"],
  };
  const palette = () => PALETTE[dark() ? "dark" : "light"];

  /* A tick label: as many decimals as the step needs, never trailing zeros; fractions shown as percents. */
  function tickFmt(v, step, unit) {
    if (unit === "frac") { v *= 100; step *= 100; }
    const a = Math.abs(v);
    if (step && step < 1e-4) return v ? v.toExponential(1).replace(".0e", "e") : "0";  // learning rates: 1.5e-5
    if (a >= 1e6) return +(v / 1e6).toFixed(step >= 1e6 ? 0 : 1) + "M" + (unit === "frac" ? "%" : "");
    if (a >= 1e4 || (a >= 1e3 && step >= 1e3)) return +(v / 1e3).toFixed(step >= 1e3 ? 0 : 1) + "k";
    const dec = Math.max(0, Math.min(4, -Math.floor(Math.log10(step) + 1e-9)));
    return (+v.toFixed(dec)).toLocaleString("en-US", { maximumFractionDigits: dec }) + (unit === "frac" ? "%" : "");
  }
  function niceStep(range, count) {
    const raw = range / Math.max(1, count), mag = Math.pow(10, Math.floor(Math.log10(raw || 1))), n = raw / mag;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  }
  function fmtNum(v, unit) {
    if (v == null || !isFinite(v)) return "–";
    if (unit === "frac") return String(+(v * 100).toFixed(Math.abs(v) < 0.001 ? 2 : 1)) + "%";
    if (unit === "r") return v.toFixed(2);  // rewards: two decimals everywhere
    if (unit === "s") return v < 120 ? (+v.toFixed(1)) + "s" : v < 7200 ? Math.round(v / 60) + "m" : (v / 3600).toFixed(1) + "h";  // as the tables: 68.7s, 94m
    const a = Math.abs(v);
    if (a === 0) return "0" + (unit === "%" ? "%" : unit ? " " + unit : "");
    const trim = x => x.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    const s = a >= 1e6 ? trim((v / 1e6).toFixed(2)) + "M" : a >= 1e4 ? trim((v / 1e3).toFixed(1)) + "k" : a >= 100 ? Math.round(v).toLocaleString() :
      unit === "%" ? trim(v.toFixed(a < 0.1 ? 2 : 1)) : a >= 1 ? trim(v.toFixed(2)) : String(+v.toPrecision(3));
    return s + (unit && unit !== "frac" && unit !== "%" ? " " + unit : unit === "%" ? "%" : "");
  }
  function fmtX(x, xType, span, axis) {
    if (xType === "elapsed") { const m = Math.round(x / 60); return (m < 60 ? m + "m" : Math.floor(m / 60) + "h" + (m % 60 ? String(m % 60).padStart(2, "0") : "")) + (axis ? "" : " in"); }
    if (xType !== "time") return (axis ? "" : "step ") + Math.round(x);
    const d = new Date(x * 1000);
    const o = { timeZone: "America/Los_Angeles", hourCycle: "h23" };
    const hm = d.toLocaleTimeString("en-US", { ...o, hour: "2-digit", minute: "2-digit" });
    return (span > 86400 ? d.toLocaleDateString("en-US", { ...o, month: "2-digit", day: "2-digit" }) + " " : "") + hm + (axis ? "" : " PT");
  }

  /* Debiased exponential moving average (the W&B kind): weight a on the past, restarted after a time gap. */
  function ema(points, a, opts) {
    if (!a || points.length < 3) return points;
    const out = [];
    let m = 0, k = 0, prev = null;
    for (const [x, y] of points) {
      if (prev != null && opts.xType !== "step" && x - prev > (opts.gap || 600)) { m = 0; k = 0; }
      m = a * m + (1 - a) * y; k++;
      out.push([x, m / (1 - Math.pow(a, k))]);
      prev = x;
    }
    return out;
  }

  /* A time series per training step: the mean of its samples inside each step's window (previous step's end, this
     step's end]; the first step's window opens step_time before its end. Steps come from Miles' "step N" log lines. */
  function bucket(points, steps) {
    const out = [];
    let j = 0;
    for (let i = 0; i < steps.length; i++) {
      const a = i ? steps[i - 1].t : steps[i].t - (steps[i].step_time || 0), b = steps[i].t;
      let sum = 0, n = 0;
      while (j < points.length && points[j][0] <= a) j++;
      for (let k = j; k < points.length && points[k][0] <= b; k++) { sum += points[k][1]; n++; }
      if (n) out.push([steps[i].n, sum / n]);
    }
    return out;
  }
  /* A per-step series (one point per step, at the time its line was logged) on the step axis. */
  function byStep(points, steps) {
    const at = new Map(steps.map(s => [Math.round(s.t), s.n]));
    return points.map((p, i) => [at.get(Math.round(p[0])) ?? (steps[i] ? steps[i].n : i), p[1]]);
  }
  const stepMode = () => st.xmode === "step" && st.steps.length >= 2;

  /* opts: {series: [{name, points: [[x, y]...]}], unit, xType: "time"|"step", height, smooth (0..0.99; default: the page's control)} */
  function draw(canvas, opts, hoverX, sel) {
    const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = opts.height || 150;
    if (!W) return;
    canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.height = H + "px";
    const g = canvas.getContext("2d");
    g.scale(dpr, dpr);
    g.clearRect(0, 0, W, H);
    const series = opts.series.filter(s => s.points.length);
    const L = 44, R = 10, T = 8, B = 20;  // one fixed y-gutter, so plots line up across cards
    g.font = `11px ${css("--font") || "sans-serif"}`;
    if (!series.length) {
      g.fillStyle = css("--ink-3"); g.fillText("no data yet", L, H / 2); return null;
    }
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of series) for (const [x] of s.points) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
    if (opts.xDomain) [x0, x1] = opts.xDomain;  // this chart's zoom; otherwise its own first to last point
    for (const s of series) for (const [x, y] of s.points) if (x >= x0 && x <= x1) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (!isFinite(y0)) { y0 = 0; y1 = 0; }  // nothing inside the zoomed window
    const ints = opts.unit !== "frac" && series.every(s => s.points.every(p => Number.isInteger(p[1])));
    canvas._map = { x0, x1, L, R, W: 0 };
    if (ints && y1 - Math.min(0, y0) < 4) y1 = Math.min(0, y0) + 4;  // a flat count still gets 0..4
    if (opts.zero !== false && y0 > 0 && y0 < (y1 - y0) * 1.5) y0 = 0;
    if (opts.unit === "frac") { y0 = Math.min(y0, 0); y1 = Math.max(y1, Math.min(1, y1 * 1.1)); }
    if (!(y1 > y0)) { if (y0 === 0) y1 = 1; else if (y0 > 0) { y1 = y0 * 1.1; y0 = 0; } else { const p = Math.abs(y0) * 0.1; y0 -= p; y1 += p; } }
    if (!(x1 > x0)) { x0 -= 30; x1 += 30; }
    const mins = opts.unit === "s" && y1 >= 180;  // long durations tick in minutes, as their values read ("29m")
    const step = mins ? Math.max(60, niceStep((y1 - y0) / 60, 4) * 60) : ints ? Math.max(1, Math.round(niceStep(y1 - y0, 4))) : niceStep(y1 - y0, 4), ylo = Math.floor(y0 / step) * step, yhi = Math.ceil(y1 / step) * step;
    const X = x => L + (W - L - R) * (x - x0) / (x1 - x0), Y = y => T + (H - T - B) * (1 - (y - ylo) / (yhi - ylo));
    g.strokeStyle = css("--grid"); g.fillStyle = css("--ink-3"); g.lineWidth = 1;
    g.textAlign = "right"; g.textBaseline = "middle";
    for (let v = ylo; v <= yhi + step / 2; v += step) {
      const y = Math.round(Y(v)) + 0.5;
      g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke();
      g.fillText(mins ? +(v / 60).toFixed(1) + "m" : opts.unit === "s" ? +v.toFixed(1) + "s" : tickFmt(v, step, opts.unit), L - 6, y);
    }
    g.textAlign = "center"; g.textBaseline = "alphabetic";
    const span = x1 - x0;
    const unit = opts.xType !== "step" ? (span > 6 * 3600 ? 3600 : span > 3600 ? 900 : 300) : 1;
    const xs = Math.max(opts.xType !== "step" ? 0 : 1, niceStep(span / unit, Math.max(2, Math.floor((W - L) / 90))) * unit);
    let prevLabel = null;
    for (let x = Math.ceil(x0 / xs) * xs; x <= x1; x += xs) {
      const lab = fmtX(x, opts.xType, span, true), w = g.measureText(lab).width, px = X(x);
      // keep the outermost labels inside the plot
      g.textAlign = px + w / 2 > W - R ? "right" : px - w / 2 < L ? "left" : "center";
      if (lab !== prevLabel) g.fillText(lab, g.textAlign === "right" ? W - R : g.textAlign === "left" ? L : px, H - 5);
      prevLabel = lab;
    }
    g.textAlign = "center";
    const pal = palette();
    const sm = opts.smooth != null ? opts.smooth : st.smooth;
    const shown = series.map(s => ema(s.points, sm, opts));
    const line = (pts, c, w, alpha) => {
      g.strokeStyle = c; g.lineWidth = w; g.lineJoin = "round"; g.globalAlpha = alpha; g.beginPath();
      let started = false, prev = null;
      for (const [x, y] of pts) {
        if (x < x0) continue;
        const gap = prev != null && opts.xType !== "step" && x - prev > (opts.gap || 600);
        if (!started || gap) { g.moveTo(X(x), Y(y)); started = true; } else g.lineTo(X(x), Y(y));
        prev = x;
      }
      g.stroke(); g.globalAlpha = 1;
    };
    canvas._map.W = W;
    if (sel) {  // the interval being dragged out for a zoom
      const a = Math.max(L, Math.min(...sel)), b = Math.min(W - R, Math.max(...sel));
      g.fillStyle = css("--accent"); g.globalAlpha = 0.12; g.fillRect(a, T, b - a, H - T - B); g.globalAlpha = 1;
    }
    g.save(); g.beginPath(); g.rect(L, T - 4, W - L - R + 4, H - T - B + 8); g.clip();
    series.forEach((s, i) => {
      const c = s.color || pal[i % pal.length];
      const w = s.width || 1.5, a = s.alpha ?? 1;
      if (shown[i] !== s.points && a === 1) line(s.points, c, 1, 0.22);  // the raw curve stays faint behind the smoothed one
      line(shown[i], c, opts.dots ? 2 : w, a);
      if (opts.dots) { g.fillStyle = c; for (const [x, y] of shown[i]) if (x >= x0) { g.beginPath(); g.arc(X(x), Y(y), 3, 0, 7); g.fill(); } }
      if (a < 1) return;
      const last = shown[i][shown[i].length - 1];
      if (last[0] <= x1) { g.fillStyle = c; g.beginPath(); g.arc(X(last[0]), Y(last[1]), 2.5, 0, 7); g.fill(); }
    });
    g.restore();
    if (hoverX != null) {
      const x = x0 + (hoverX - L) / (W - L - R) * (x1 - x0);
      g.strokeStyle = css("--ink-3"); g.lineWidth = 1; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(Math.round(hoverX) + 0.5, T); g.lineTo(Math.round(hoverX) + 0.5, H - B); g.stroke();
      g.setLineDash([]);
      return series.map((s, i) => {
        let best = null;
        for (const p of shown[i]) if (p[0] >= x0 && p[0] <= x1) if (best == null || Math.abs(p[0] - x) < Math.abs(best[0] - x)) best = p;
        if (best) { g.fillStyle = s.color || pal[i % pal.length]; g.beginPath(); g.arc(X(best[0]), Y(best[1]), 3, 0, 7); g.fill(); }
        return { name: s.name, x: best && best[0], y: best && best[1], color: s.color || pal[i % pal.length] };
      }).concat([{ at: fmtX(x, opts.xType, 0) }]);
    }
    return null;
  }

  /* A chart that redraws on resize and shows a crosshair readout in `readout`. */
  function mount(canvas, readout, opts) {
    const base = readout ? readout.innerHTML : "";
    const redraw = (hx, sel) => {
      const r = draw(canvas, opts, hx, sel);
      if (readout) {
        if (r) {
          const at = r.pop().at;
          readout.innerHTML = `<span>${at}</span> ` + r.filter(v => v.y != null).slice(0, 9).map(v =>
            `<span class="nv"><i style="background:${v.color}"></i>${r.length > 1 ? esc(v.name) + " " : ""}${fmtNum(v.y, opts.unit)}</span>`).join(" ");
        } else readout.innerHTML = base;
      }
    };
    // W&B-style zoom, per chart: drag across it to zoom to that interval; double-click to reset
    let down = null;
    const zoomable = !opts.noZoom;
    const toX = px => { const m = canvas._map; return m.x0 + Math.max(0, Math.min(1, (px - m.L) / (m.W - m.L - m.R))) * (m.x1 - m.x0); };
    if (zoomable) {
      canvas.onmousedown = e => { if (e.button === 0) { down = e.offsetX; e.preventDefault(); } };
      canvas.onmouseup = e => {
        if (down != null && Math.abs(e.offsetX - down) > 4) {
          const a = toX(Math.min(down, e.offsetX)), b = toX(Math.max(down, e.offsetX));
          if (b - a >= (opts.xType !== "step" ? 30 : 1)) zoomTo(opts, [a, b], redraw);
        }
        down = null;
      };
      canvas.ondblclick = () => { clearTimeout(canvas._open); zoomTo(opts, null, redraw); };
    }
    // a plain click enlarges the chart; it waits a moment so a double-click (reset zoom) doesn't also open it
    let dragged = false;
    canvas.addEventListener("mousedown", () => { dragged = false; });
    canvas.addEventListener("mousemove", e => { if (e.buttons & 1) dragged = true; });
    canvas.onclick = e => {
      if (dragged || !opts.onOpen || e.detail > 1) { clearTimeout(canvas._open); return; }
      canvas._open = setTimeout(() => opts.onOpen(), zoomable ? 260 : 0);
    };
    canvas.onmousemove = e => redraw(e.offsetX, down != null && Math.abs(e.offsetX - down) > 4 ? [down, e.offsetX] : null);
    canvas.onmouseleave = () => { down = null; redraw(null); };
    canvas._redraw = () => redraw(null);
    redraw(null);
  }
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---- the curves section of a run page --------------------------------------------------------------

  const SOURCES = { Engine: "SGLang decode/prefill log lines (TP0), from the GPU app's logs",
                    GPU: "W&B system metrics of the run: the GPUs of the node W&B runs on (on a training run, trainer GPUs only; engines aren't covered)",
                    Trials: "the monitor's own scans of the trial dirs" };
  // the charts each group shows before "show more": what answers "is it learning, is it fast"
  const KEY = { Training: ["train.loss", "train.val_nll", "train.lr", "train.tok_per_s", "train.raw_reward", "train.raw_reward_unfiltered", "train.response_len", "train.truncated", "train.logprob_diff", "train.grad_norm", "train.step_time", "train.wait_ratio",
                            "train.mis_mask_low", "train.mis_mask_high", "train.sc_masked", "train.sc_weight"],
                Engine: ["engine.gen_tps", "engine.running_req", "engine.queue_req", "engine.kv_usage"], GPU: ["gpu.util", "gpu.power", "gpu.mem_alloc", "gpu.temp_max"] };
  const st = { zooms: {}, data: null, runId: null, wb: [], custom: {}, steps: [], all: new Set(),
               xmode: localStorage_get("mon.xmode") || "time", closed: new Set(JSON.parse(localStorage_get("mon.cgroups") || '["Trials"]')),
               cols: localStorage_get("mon.cols") || "auto",
               smooth: Math.min(0.99, Math.max(0, +(localStorage_get("mon.smooth") || 0) || 0)) };

  function localStorage_get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function localStorage_set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  /* W&B GPU series split by node come as "<name>@<label>", label "<role>-node<k>" (role train | rollout | colocated). */
  const ROLE_ORDER = { train: 0, colocated: 1, rollout: 2 };
  const nodeOf = label => { const m = /^(train|rollout|colocated)-node(\d+)$/.exec(label); return m ? { role: m[1], k: +m[2] } : { role: "other", k: 0 }; };
  const nodeName = label => { const n = nodeOf(label); return n.role === "other" ? label : `${n.role === "train" ? "trainer" : n.role} node ${n.k}`; };
  const byNode = (a, b) => { const x = nodeOf(a), y = nodeOf(b); return (ROLE_ORDER[x.role] ?? 3) - (ROLE_ORDER[y.role] ?? 3) || x.k - y.k || (a < b ? -1 : 1); };
  // one hue per role (trainer blue, rollout orange, colocated green), a lighter step for each further node of it
  const ROLE_SHADES = {
    light: { train: ["#1f63b8", "#6ea4e6", "#a9c9f0"], rollout: ["#d4561f", "#f0a074", "#f6c6a9"], colocated: ["#14916a", "#67c9a5"], other: ["#6d6d69", "#a3a39e"] },
    dark: { train: ["#4a92ea", "#8fbaf0", "#bcd5f5"], rollout: ["#e3672f", "#f0a074", "#f6c6a9"], colocated: ["#22b07f", "#6fd0ac"], other: ["#a3a39e", "#6d6d69"] },
  };
  function nodeColors(labels) {
    const sh = ROLE_SHADES[dark() ? "dark" : "light"], used = {};
    return labels.map(l => { const r = nodeOf(l).role in sh ? nodeOf(l).role : "other", i = used[r] = (used[r] ?? -1) + 1; return sh[r][Math.min(i, sh[r].length - 1)]; });
  }
  const REWARD_KEYS = new Set(["train.raw_reward", "train.raw_reward_unfiltered", "trials.mean_reward"]);
  function cardDefs(catalog, series) {
    const defs = [];
    for (let [k, [group, label, unit]] of Object.entries(catalog)) {
      const labels = Object.keys(series).filter(x => x.startsWith(k + "@") && series[x].length).map(x => x.slice(k.length + 1)).sort(byNode);
      if (labels.length) {  // one line per node
        const cols = nodeColors(labels);
        defs.push({ id: k, group, label, unit, legend: true,
                    series: labels.map((l, i) => ({ name: nodeName(l), color: cols[i], points: series[k + "@" + l] })) });
        if (k === "gpu.util") for (const [li, l] of labels.entries()) {
          const per = Object.keys(series).filter(x => /^gpu\.\d+\.util@/.test(x) && x.endsWith(".util@" + l))
            .sort((a, b) => parseInt(a.split(".")[1]) - parseInt(b.split(".")[1]));
          if (per.length) defs.push({ id: "gpu.per@" + l, group, label: `Each GPU, ${nodeName(l)}`, unit: "%", color: cols[li],
                                      series: [...per.map(p => ({ name: "GPU " + p.split(".")[1], points: series[p], color: cols[li], width: 1, alpha: 0.35 })),
                                               { name: "mean", points: series[k + "@" + l], color: cols[li], width: 2 }] });
        }
        continue;
      }
      if (!series[k] || !series[k].length) continue;
      if (REWARD_KEYS.has(k)) unit = "r";
      defs.push({ id: k, group, label, unit, series: [{ name: label, points: series[k] }] });
      if (k === "gpu.util") {
        const per = Object.keys(series).filter(x => /^gpu\.\d+\.util$/.test(x)).sort((a, b) => parseInt(a.split(".")[1]) - parseInt(b.split(".")[1]));
        if (per.length) defs.push({ id: "gpu.per", group, label: "GPU utilization per GPU", unit: "%",
                                    series: per.map(p => ({ name: "GPU " + p.split(".")[1], points: series[p] })) });
      }
    }
    return defs;
  }

  function lastVal(def) {
    const s = def.series[0], p = s && s.points[s.points.length - 1];
    return p ? fmtNum(p[1], def.unit) : "–";
  }
  const sectionLegend = defs => { const d = defs.find(x => x.legend); return d ? `<div class="legend">${d.series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>` : ""; };
  // the latest value per node, in the card header: "100 · 100 · 71%"
  const nodeVals = def => def.series.map(s => { const p = s.points[s.points.length - 1];
    const v = !p ? "–" : def.unit === "%" ? String(+p[1].toFixed(1)) + "%" : fmtNum(p[1], def.unit);
    return `<span class="nv" title="${esc(s.name)}"><i style="background:${s.color}"></i>${v}</span>`; }).join("");

  function sectionHTML(runId, wbRuns) {
    const d = st.data;
    if (!d) return `<div class="card">loading curves…</div>`;
    const defs = cardDefs(d.catalog, d.series);
    const ORDER = ["Training", "Engine", "GPU", "Trials"];
    const groups = [...new Set(defs.map(x => x.group))].sort((a, b) => (ORDER.indexOf(a) + 1 || 9) - (ORDER.indexOf(b) + 1 || 9));
    const canStep = st.steps.length >= 2;
    const end = xEnd(), stale = Date.now() / 1000 - end > 15 * 60;
    let h = `<div class="page-head"><div class="page-title">Curves <span class="muted" style="font-weight:400;font-size:var(--fs-sm)">times PT</span>${stale ? ` <span class="muted" style="font-weight:400;font-size:var(--fs-sm)">· up to the last sample, ${fmtX(end, "time", 86401)}</span>` : ""}</div><div class="row">${canStep ? `<div class="seg" title="x-axis of the engine, GPU and trial charts: wall-clock time, or one point per training step (the mean over that step's window)">${[["time", "x: time"], ["step", "x: step"]].map(([v, l]) => `<button class="${st.xmode === v ? "on" : ""}" data-xmode="${v}">${l}</button>`).join("")}</div>` : ""}${smoothHTML()}<div class="seg" title="charts per row">${[["auto", "auto"], ["1", "1 per row"], ["2", "2"], ["3", "3"]].map(([v, l]) =>
      `<button class="${st.cols === v ? "on" : ""}" data-cols="${v}">${l}</button>`).join("")}</div><span class="muted small">drag to zoom · double-click to reset · click to enlarge</span></div></div>`;
    if (!defs.length && !wbRuns.length) return `<div class="page-title">Curves</div><div class="muted small" style="margin-top:6px">No engine, GPU or trial samples for this run (they start once its engine serves requests).</div>`;
    if (!defs.length) h += `<div class="card muted">No samples yet. Engine and GPU curves start once the engine serves requests; trial curves with the first trial scan.</div>`;
    for (const gname of groups) {
      const gdefs = defs.filter(x => x.group === gname), split = gname === "GPU" && gdefs.some(x => x.legend);
      // per-step metrics: drawn against the step, and only once there are two steps to join
      if (gname === "Training" && Math.max(...gdefs.map(x => x.series[0].points.length)) < 2) {
        h += `<div class="group-head"><span class="group-title">Training</span><span class="muted small">Per-step curves appear after step 2; step values are in the Training table above.</span></div>`;
        continue;
      }
      const closed = st.closed.has(gname);
      h += `<div class="group-head click" data-cgroup="${esc(gname)}" title="${closed ? "show" : "hide"} these charts"><span class="group-title"><span class="chev" style="display:inline-block;${closed ? "" : "transform:rotate(90deg)"}">▸</span> ${esc(gname)} <span class="muted" style="font-weight:400">${gdefs.length}</span></span><span class="muted small">${esc(split ? "W&B system metrics of every GPU node, one line per node" : SOURCES[gname] || "")}${gname !== "Training" && stepMode() ? " · per training step" : ""}</span>${split && !closed ? sectionLegend(gdefs) : ""}</div>`;
      if (closed) continue;
      const inKey = d => KEY[gname].some(k => d.id === k || d.id.startsWith(k + "@"));
      const extra = KEY[gname] ? gdefs.filter(d => !inKey(d)).length : 0, all = st.all.has(gname), shown = extra && !all ? gdefs.filter(inKey) : gdefs;
      h += `<div class="grid">`;
      for (const def of shown)
        h += `<div class="card chart-card" data-chart="${esc(def.id)}"><div class="card-head${def.legend || /^gpu\./.test(def.id) ? " stack" : ""}"><span class="card-title" title="${esc(def.label)}">${esc(def.label)}</span><span class="card-val">${def.legend ? nodeVals(def) : lastVal(def)}</span></div>
              <canvas></canvas><div class="card-note readout"></div></div>`;
      h += `</div>`;
      if (extra) h += `<div style="margin-top:8px"><button class="linkish" data-gall="${esc(gname)}">${all ? `show only the key ${gname.toLowerCase()} charts` : `show ${extra} more ${gname.toLowerCase()} chart${extra === 1 ? "" : "s"}`}</button></div>`;
    }
    // explorer: any W&B metric
    const custom = st.custom[runId] || [];
    h += `<div class="group-head"><span class="group-title">W&B explorer</span><span class="muted">any metric the run logs to W&B; training curves land here too</span></div>`;
    if (!wbRuns.length) h += `<div class="card muted">No W&B run linked to this run yet.</div>`;
    else {
      h += `<div class="row explorer"><select id="wb-run">${wbRuns.map(w => `<option value="${esc(w.path)}">${esc(w.label)}</option>`).join("")}</select>
            <input id="wb-key" list="wb-keys" placeholder="metric, e.g. rollout/raw_reward" style="min-width:320px;flex:1;max-width:520px">
            <datalist id="wb-keys"></datalist><button id="wb-add">add chart</button><span class="muted" id="wb-msg"></span></div>`;
      h += `<div class="grid">${custom.map((c, i) => `<div class="card chart-card" data-custom="${i}"><div class="card-head"><span class="card-title mono">${esc(c.key)}</span>
            <span><span class="card-val mono"></span> <button class="x" data-del="${i}" title="remove">✕</button></span></div><canvas></canvas><div class="card-note readout">${esc(c.label)}</div></div>`).join("")}</div>`;
    }
    return h;
  }

  const smoothHTML = () => `<label class="smooth" title="exponential moving average; the raw curve stays faint behind it">smoothing
      <input type="range" class="smooth-in" min="0" max="0.99" step="0.01" value="${st.smooth}"><span class="smooth-v">${st.smooth ? st.smooth.toFixed(2) : "off"}</span></label>`;
  function wireSmooth(root) {
    root.querySelectorAll(".smooth-in").forEach(inp => inp.oninput = () => {
      st.smooth = +inp.value; localStorage_set("mon.smooth", String(st.smooth));
      document.querySelectorAll(".smooth-in").forEach(o => { if (o !== inp) o.value = inp.value; });
      document.querySelectorAll(".smooth-v").forEach(v => v.textContent = st.smooth ? st.smooth.toFixed(2) : "off");
      window.Curves.redraw();
    });
  }

  /* The range ends at now while the run logs, else at its last sample, so a finished run keeps its curves. */
  function xEnd() {
    let last = 0;
    for (const pts of Object.values((st.data && st.data.series) || {})) if (pts.length && pts[pts.length - 1][0] > last) last = pts[pts.length - 1][0];
    const now = Date.now() / 1000;
    return last && now - last > 15 * 60 ? last : now;
  }
  // one zoom per chart, kept across the 20 s refreshes; the chart redraws alone
  function zoomTo(opts, z, redraw) {
    opts.xDomain = z;
    if (opts.zoomKey) { if (z) st.zooms[opts.zoomKey] = z; else delete st.zooms[opts.zoomKey]; }
    redraw(null);
  }

  async function loadCustom(c) {
    if (c.data && Date.now() - c.at < 60000) return;
    const r = await fetch(`api/wandb/series?path=${encodeURIComponent(c.path)}&key=${encodeURIComponent(c.key)}&stream=${c.key.startsWith("system.") ? "system" : "default"}`);
    c.data = await r.json(); c.at = Date.now();
  }

  function wire(root, runId, wbRuns) {
    wireSmooth(root);
    root.classList.remove("cols-1", "cols-2", "cols-3");
    if (st.cols !== "auto") root.classList.add("cols-" + st.cols);
    root.querySelectorAll("[data-cols]").forEach(b => b.onclick = () => { st.cols = b.dataset.cols; localStorage_set("mon.cols", st.cols); paint(root, runId, wbRuns); });
    root.querySelectorAll("[data-xmode]").forEach(b => b.onclick = () => { st.xmode = b.dataset.xmode; st.zooms = {}; localStorage_set("mon.xmode", st.xmode); paint(root, runId, wbRuns); });
    root.querySelectorAll("[data-gall]").forEach(b => b.onclick = () => { const g = b.dataset.gall; st.all.has(g) ? st.all.delete(g) : st.all.add(g); paint(root, runId, wbRuns); });
    root.querySelectorAll("[data-cgroup]").forEach(b => b.onclick = () => { const g = b.dataset.cgroup; st.closed.has(g) ? st.closed.delete(g) : st.closed.add(g);
      localStorage_set("mon.cgroups", JSON.stringify([...st.closed])); paint(root, runId, wbRuns); });
    const defs = st.data ? cardDefs(st.data.catalog, st.data.series) : [];
    // each chart spans its own first to last point, and zooms on its own
    root.querySelectorAll("[data-chart]").forEach(card => {
      const def = defs.find(d => d.id === card.dataset.chart);
      if (!def) return;
      const opts = def.group === "Training"  // one point per step: x is the step, not the time
        ? { unit: def.unit, xType: "step", dots: true, xDomain: st.zooms[def.id] || null, zoomKey: def.id, series: def.series.map(s => ({ ...s, points: byStep(s.points, st.steps) })) }
        : stepMode() ? { unit: def.unit, xType: "step", dots: st.steps.length <= 40, xDomain: st.zooms[def.id] || null, zoomKey: def.id, series: def.series.map(s => ({ ...s, points: bucket(s.points, st.steps) })) }
        : { unit: def.unit, xType: "time", xDomain: st.zooms[def.id] || null, zoomKey: def.id, series: def.series };
      mount(card.querySelector("canvas"), card.querySelector(".readout"), opts);
      opts.onOpen = () => openModal(def.label, opts);
    });
    const custom = st.custom[runId] || [];
    root.querySelectorAll("[data-custom]").forEach(card => {
      const c = custom[+card.dataset.custom];
      loadCustom(c).then(() => {
        const pts = (c.data && c.data.points) || [], xType = c.data && c.data.x === "time" ? "time" : "step";
        const opts = { unit: "", xType, xDomain: st.zooms["custom:" + c.key] || null, zoomKey: "custom:" + c.key, series: [{ name: c.key, points: pts }] };
        const last = pts[pts.length - 1];
        card.querySelector(".card-val").textContent = last ? fmtNum(last[1], "") : "–";
        mount(card.querySelector("canvas"), card.querySelector(".readout"), opts);
        opts.onOpen = () => openModal(c.key, opts);
      }).catch(e => { card.querySelector(".readout").textContent = "fetch failed: " + e; });
    });
    root.querySelectorAll("[data-del]").forEach(b => b.onclick = () => {
      custom.splice(+b.dataset.del, 1); saveCustom(runId); paint(root, runId, wbRuns);
    });
    const sel = root.querySelector("#wb-run");
    if (sel) {
      const fillKeys = async () => {
        const msg = root.querySelector("#wb-msg"); msg.textContent = "loading metric names…";
        try {
          const k = await (await fetch("api/wandb/keys?path=" + encodeURIComponent(sel.value))).json();
          root.querySelector("#wb-keys").innerHTML = [...k.default, ...k.system].map(x => `<option value="${esc(x)}">`).join("");
          msg.textContent = `${k.default.length} logged metrics, ${k.system.length} system metrics`;
        } catch (e) { msg.textContent = "could not list metrics: " + e; }
      };
      sel.onchange = fillKeys; fillKeys();
      root.querySelector("#wb-add").onclick = () => {
        const key = root.querySelector("#wb-key").value.trim();
        if (!key) return;
        (st.custom[runId] = st.custom[runId] || []).push({ path: sel.value, key, label: sel.options[sel.selectedIndex].text });
        saveCustom(runId); paint(root, runId, wbRuns);
      };
    }
  }

  function saveCustom(runId) {
    localStorage_set("mon.custom." + runId, JSON.stringify((st.custom[runId] || []).map(({ path, key, label }) => ({ path, key, label }))));
  }

  function paint(root, runId, wbRuns) {
    const ae = document.activeElement;
    if (ae && root.contains(ae) && (ae.id === "wb-key" || ae.classList.contains("smooth-in"))) return;  // don't clobber a control in use  // don't clobber the explorer while someone is typing
    st.root = root; st.wbRuns = wbRuns;
    root.innerHTML = sectionHTML(runId, wbRuns);
    wire(root, runId, wbRuns);
  }

  function openModal(title, opts) {
    const m = document.getElementById("modal");
    m.querySelector(".modal-title").innerHTML = esc(title) + " " + smoothHTML();
    wireSmooth(m);
    m.classList.remove("hidden");
    const cv = m.querySelector("canvas");
    mount(cv, m.querySelector(".modal-readout"), { ...opts, noZoom: true, height: Math.min(460, innerHeight - 200) });
  }

  // public: called by the page on every refresh of a run page
  /* A bare line for a stat tile: the last `span` seconds, no axes. */
  function spark(canvas, points, span) {
    const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight || 28;
    if (!W) return;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const g = canvas.getContext("2d");
    g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
    const t1 = Date.now() / 1000, t0 = t1 - span, pts = points.filter(p => p[0] >= t0);
    if (pts.length < 2) return;
    let y1 = 0; for (const p of pts) if (p[1] > y1) y1 = p[1];
    y1 = y1 || 1;
    const X = x => W * (x - t0) / span, Y = y => H - 2 - (H - 4) * y / y1;
    g.strokeStyle = palette()[0]; g.lineWidth = 1.25; g.beginPath();
    pts.forEach((p, i) => i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1])));
    g.stroke();
    g.globalAlpha = 0.12; g.lineTo(X(pts[pts.length - 1][0]), H); g.lineTo(X(pts[0][0]), H); g.closePath();
    g.fillStyle = palette()[0]; g.fill(); g.globalAlpha = 1;
  }

  // public: the page calls update() on every render; it fetches at most every 20 s and repaints only on new data
  window.Curves = {
    async update(root, runId, wbRuns, steps) {
      const sk = (steps || []).length + ":" + ((steps || []).slice(-1)[0] || {}).t;
      if (sk !== st.stepKey) { st.steps = (steps || []).filter(s => s.t); st.stepKey = sk; if (st.data && st.runId === runId) paint(root, runId, wbRuns); }
      const fresh = st.runId !== runId || root.dataset.curvesFor !== runId;
      if (fresh) {
        st.runId = runId; st.data = null; st.fetched = 0; st.zooms = {}; st.root = root; st.wbRuns = wbRuns; root.dataset.curvesFor = runId;
        try { st.custom[runId] = JSON.parse(localStorage_get("mon.custom." + runId) || "[]"); } catch (e) { st.custom[runId] = []; }
        root.innerHTML = sectionHTML(runId, wbRuns);
      }
      st.wbKey = st.wbKey || "";
      const wbKey = wbRuns.map(w => w.path).join(",");
      if (!fresh && Date.now() - st.fetched < 20000 && wbKey === st.wbKey) return;
      st.fetched = Date.now(); st.wbKey = wbKey;
      try { st.data = await (await fetch("api/series?max=1500&run=" + encodeURIComponent(runId))).json(); } catch (e) { return; }
      if (st.runId === runId) paint(root, runId, wbRuns);
    },
    spark, mount, bucket, byStep, palette, fmtNum, fmtX,
    redraw() { document.querySelectorAll("canvas").forEach(c => c._redraw && c._redraw()); },
  };
  window.addEventListener("resize", () => window.Curves.redraw());
  document.addEventListener("keydown", e => { if (e.key === "Escape") document.getElementById("modal").classList.add("hidden"); });
})();
