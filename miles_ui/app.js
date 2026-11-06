/* Run monitor page. A long-poll loop on api/poll carries every change the server sees (topics replaced
   whole, only when they changed, the moment they change); the page re-renders by patching the DOM in
   place, so scroll position, focus, open panels and the charts survive every update. */
(function () {
  "use strict";

  // ---- state ---------------------------------------------------------------------------------------
  const S = { apps: [], runs: [], sail: {}, wandb: [], startup: {}, errors: {}, updated: {}, watchdogs: {}, cost: {}, gpus: {}, events: [], meta: {} };
  let detail = null, skew = 0, loaded = false;
  const ui = { finFilter: "all", runQuery: "", kind: "all", feedProblems: false, logCats: new Set(["stage", "trial", "error", "other"]),
               logQuery: "", follow: true, showAllApps: false, appQuery: "", docFile: null, docText: "", docFiles: [], docQuery: "",
               logsFor: null, logsText: "", sort: { inflight: "start" }, feedN: {},
               runType: ls0("mon.runType") || "all", showOther: false, grpN: {}, cmp: [], phZoom: {} };
  const LOG = { app: null, lines: [], max: 3000 };
  const SPARK = {};  // run_id -> {t, series}
  const seenEvents = new Set();
  const now = () => Date.now() / 1000 + skew;
  function ls0(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
               set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };

  // ---- formatting ------------------------------------------------------------------------------------
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const tsOf = s => !s ? null : typeof s === "number" ? s : Date.parse(String(s).replace(" ", "T").replace("+00:00", "Z")) / 1000;
  const dur = s => s == null || !isFinite(s) ? "–" : s < 0 ? "0s" : s < 120 ? Math.round(s) + "s" : s < 7200 ? Math.round(s / 60) + "m" : s < 172800 ? (s / 3600).toFixed(1) + "h" : Math.round(s / 86400) + "d";
  const agoTxt = t => !t ? "–" : (now() - t < 5 ? "just now" : dur(now() - t) + " ago");
  const ago = t => `<span data-ago="${t || ""}">${agoTxt(t)}</span>`;
  // every time on the page is US Pacific (the user's rule); the IANA zone switches PDT/PST by itself
  const TZ = "America/Los_Angeles";
  const PT = {
    hm: new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    hms: new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }),
    md: new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "2-digit", day: "2-digit" }),
  };
  const hm = t => t ? PT.hm.format(t * 1000) + " PT" : "–";
  const hms = t => PT.hms.format(t * 1000);
  const fmt = t => t ? PT.md.format(t * 1000) + " " + PT.hm.format(t * 1000) + " PT" : "–";
  const when = t => !t ? "–" : now() - t < 86400 ? hm(t) : fmt(t);
  const link = (u, t, cls) => `<a href="${esc(u)}" target="_blank" rel="noopener"${cls ? ` class="${cls}"` : ""}>${esc(t)}</a>`;
  const num = (v, d = 3) => v == null ? "–" : typeof v === "number" ? (+v.toFixed(d)).toString() : esc(v);
  const meta = () => ({ title: "Run monitor", modal_environments: [], app_prefixes: [], wandb_project_prefix: "", ...S.meta });
  const prefixes = () => meta().app_prefixes.map(p => p + "*").join(", ");
  const usd = v => v == null ? "–" : "$" + (v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2));
  // running text that only breaks between words, never at a hyphen inside one ("C-ROLL-3")
  const words = t => String(t || "").split(/(\s+)/).map(w => /\S-\S/.test(w) ? `<span class="nowrap">${esc(w)}</span>` : esc(w)).join("");
  const mean2 = v => v == null ? "–" : (+v).toFixed(2);  // mean rewards: always two decimals
  const sig3 = v => v == null ? "–" : String(+(+v).toPrecision(3));  // grad norm and other small magnitudes
  const secs = s => s == null || !isFinite(s) ? "–" : s < 120 ? (+s.toFixed(1)) + "s" : dur(s);  // short durations keep a decimal: 68.7s
  const int = v => v == null ? "–" : Math.round(v).toLocaleString();
  const billedNote = () => S.cost && S.cost.through ? `Modal bills hourly; billed through ${hm(S.cost.through)}` : "Modal billing not loaded yet";
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  const PH = { setup: ["setting up", "var(--warn)"], agent: ["agent running", "var(--run)"], verifying: ["verifying", "var(--verify)"],
               done: ["finished", "var(--good)"], error: ["exception", "var(--bad)"], stale: ["cut off", "var(--idle)"], unknown: ["unreadable", "var(--idle)"] };
  const LEVEL = { bad: "bad", warn: "warn", ok: "ok", info: "info", good: "good" };

  // ---- routing ---------------------------------------------------------------------------------------
  const TABS = [["now", "Now"], ["runs", "Runs"], ["gpus", "GPUs"], ["apps", "Modal apps"], ["sail", "Sail"], ["wandb", "W&B"], ["docs", "Notes & logs"]];
  function parseHash() { const h = new URLSearchParams(location.hash.slice(1)); return { tab: h.get("tab") || "now", run: h.get("run"), a: h.get("a"), b: h.get("b") }; }
  let route = parseHash();
  window.onhashchange = () => {
    const prev = route; route = parseHash();
    if (prev.run !== route.run) { detail = null; LOG.app = null; LOG.pick = null; LOG.lines = []; ui.logsFor = null; window.scrollTo(0, 0); ver = 0; }
    connect(); render();
  };
  window.go = (tab, run) => { const p = new URLSearchParams({ tab }); if (run) p.set("run", run); location.hash = p.toString(); };
  const compareHref = (a, b) => "#" + new URLSearchParams({ tab: "compare", a, b }).toString();

  // ---- live updates: a long-poll loop -----------------------------------------------------------------
  // Each request carries the last version seen; the server answers as soon as anything changes (only what
  // changed) or after 25 s. A route change aborts the request in flight so the new view loads at once.
  let ver = 0, ctl = null, connState = "connecting", failures = 0, loopKey = 0;
  function pollParams() {
    const p = new URLSearchParams({ since: ver });
    if (route.run) {
      p.set("run", route.run);
      const r = S.runs.find(x => x.key === route.run);
      const att = r && (r.attempts || []).filter(a => a.log).slice(-1)[0];
      const app = LOG.pick || (att && att.app_id);
      if (app) { p.set("log", app); p.set("after", LOG.app === app && LOG.lines.length ? LOG.lines[LOG.lines.length - 1][0] : 0); }
    }
    return p;
  }
  function connect() {  // (re)start the loop, e.g. after a route change
    if (ctl) ctl.abort();
    loop(++loopKey);
  }
  async function loop(key) {
    while (key === loopKey) {
      ctl = new AbortController();
      const t0 = Date.now();
      try {
        const r = await fetch("api/poll?" + pollParams(), { signal: ctl.signal, cache: "no-store" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const m = await r.json();
        if (key !== loopKey) return;
        failures = 0; setConn("live");
        apply(m);
        if (m.v !== undefined) ver = m.v;
        if (Date.now() - t0 < 150 && !m.log) await sleep(150);  // never spin
      } catch (e) {
        if (e.name === "AbortError" || key !== loopKey) return;
        failures++; setConn(failures > 2 ? "down" : "reconnecting");
        await sleep(Math.min(15000, 1000 * 2 ** failures));
      }
    }
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function apply(m) {
    if (m.now) skew = m.now - Date.now() / 1000;
    if (m.topics && Object.keys(m.topics).length) {
      for (const [k, v] of Object.entries(m.topics)) {
        if (k === "detail") detail = v; else S[k] = v;
      }
      if (m.topics.events) notifyNew(m.topics.events);
      loaded = true;
      schedule();
    }
    if (m.log) appendLog(m.log);
  }
  function setConn(s) {
    if (s === connState) return;
    connState = s;
    const el = document.getElementById("conn");
    el.className = "conn " + (s === "live" ? "live" : s === "down" || s === "reconnecting" ? "down" : "");
    el.querySelector(".txt").textContent = s;
    el.title = s === "live" ? "Updates arrive as the server sees them (long-poll)" : s;
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && connState !== "live") connect(); });

  // ---- notifications -------------------------------------------------------------------------------------
  let notifyOn = ls.get("mon.notify") === "1";
  function notifyNew(events) {
    const fresh = events.filter(e => !seenEvents.has(e.key));
    const first = seenEvents.size === 0;
    fresh.forEach(e => seenEvents.add(e.key));
    if (first || !notifyOn || !("Notification" in window) || Notification.permission !== "granted") return;
    for (const e of fresh.filter(e => (e.level === "good" || e.level === "bad") && now() - e.t < 600).slice(-3))
      try { new Notification(`${e.run_id}`, { body: e.text, tag: e.key }); } catch (err) {}
  }
  document.getElementById("notify").onclick = async () => {
    if (!("Notification" in window)) return alert("This browser has no notifications.");
    if (!notifyOn && Notification.permission !== "granted") await Notification.requestPermission();
    notifyOn = !notifyOn && Notification.permission === "granted";
    ls.set("mon.notify", notifyOn ? "1" : "0");
    paintNotify();
  };
  function paintNotify() { const b = document.getElementById("notify"); b.classList.toggle("on", notifyOn); b.title = notifyOn ? "Notifications on (solved trials, problems)" : "Turn on browser notifications for solved trials and problems"; }
  paintNotify();

  // ---- DOM patching ----------------------------------------------------------------------------------------
  function morph(el, html) {
    const t = document.createElement(el.tagName);
    t.innerHTML = html;
    morphChildren(el, t);
  }
  function morphNode(a, b) {
    if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) { a.replaceWith(b); return; }
    if (a.nodeType === 3 || a.nodeType === 8) {
      if (a.nodeValue !== b.nodeValue) {
        a.nodeValue = b.nodeValue;
        const p = a.parentElement && a.parentElement.closest("[data-flash]");
        if (p && loaded) { p.classList.remove("flash"); void p.offsetWidth; p.classList.add("flash"); }
      }
      return;
    }
    if (a.hasAttribute("data-keep") && a.getAttribute("data-keep") === b.getAttribute("data-keep")) return;
    for (const { name } of [...a.attributes]) if (!b.hasAttribute(name) && name !== "open" && !(name === "class" && a.classList.contains("flash"))) a.removeAttribute(name);
    for (const { name, value } of [...b.attributes]) {
      if (name === "class" && a.classList.contains("flash")) { if (!value.split(" ").every(c => a.classList.contains(c))) a.className = value + " flash"; continue; }
      if (a.getAttribute(name) !== value) a.setAttribute(name, value);
    }
    if (a.tagName === "INPUT" || a.tagName === "SELECT" || a.tagName === "TEXTAREA") {
      if (a !== document.activeElement && b.value !== undefined && a.value !== b.getAttribute("value") && b.hasAttribute("value")) a.value = b.getAttribute("value");
      if (a.tagName !== "SELECT") return;
    }
    morphChildren(a, b);
  }
  function morphChildren(a, b) {
    const keyed = new Map();
    for (const c of a.children) if (c.dataset.key) keyed.set(c.dataset.key, c);
    let cur = a.firstChild;
    for (const nb of [...b.childNodes]) {
      const k = nb.nodeType === 1 ? nb.dataset.key : null;
      let match = null;
      if (k && keyed.has(k)) { match = keyed.get(k); keyed.delete(k); if (match !== cur) a.insertBefore(match, cur); }
      else if (!k && cur && !(cur.nodeType === 1 && cur.dataset.key) && cur.nodeName === nb.nodeName) match = cur;
      if (match) { cur = match.nextSibling; morphNode(match, nb); }
      else a.insertBefore(nb, cur);
    }
    while (cur) { const n = cur.nextSibling; a.removeChild(cur); cur = n; }
  }
  let raf = 0;
  function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }
  setInterval(() => {  // relative times tick without a re-render
    document.querySelectorAll("[data-ago]").forEach(el => { const t = +el.dataset.ago; if (t) el.textContent = agoTxt(t); });
    document.querySelectorAll("[data-for]").forEach(el => { const t = +el.dataset.for; if (t) el.textContent = dur(now() - t); });
  }, 5000);

  // ---- tables (search, facets, sort, pages) and folds: one implementation for every list on the page ----------
  const TBL = {};  // table id -> {q, by, dir, n, f}; survives re-renders, not reloads
  let FOLD = {};
  try { FOLD = JSON.parse(ls.get("mon.folds") || "{}"); } catch (e) {}
  /* cols: [{k, label, cls, sort: row => value (sortable when given), desc: first click sorts high to low, cell: row => html}]
     o: {key: row => id, text: row => searchable text, facets: [[name, row => bool]], sort, dir, page, rowAttrs: row => attrs, empty} */
  function table(id, rows, cols, o = {}) {
    const s = TBL[id] || (TBL[id] = { q: "", by: o.sort || null, dir: o.dir || 1, n: o.page || 20, f: null });
    s.cols = cols; s.page = o.page || 20;
    let rs = rows;
    const facets = o.facets || [];
    const fc = facets.find(f => f[0] === s.f) || facets[0];
    if (fc) rs = rs.filter(fc[1]);
    if (s.q && o.text) { const q = s.q.toLowerCase(); rs = rs.filter(r => o.text(r).toLowerCase().includes(q)); }
    const col = cols.find(c => c.k === s.by && c.sort);
    if (col) rs = rs.map(r => [col.sort(r), r]).sort((a, b) => ((a[0] == null) - (b[0] == null)) || (a[0] < b[0] ? -s.dir : a[0] > b[0] ? s.dir : 0)).map(x => x[1]);
    const tools = (facets.length ? `<div class="seg">${facets.map(([n, f]) => `<button class="${fc[0] === n ? "on" : ""}" onclick="MON.tfacet('${id}','${esc(n)}')">${esc(n)} <span class="muted">${rows.filter(f).length}</span></button>`).join("")}</div>` : "") +
      (o.text ? `<input type="search" placeholder="search" value="${esc(s.q)}" oninput="MON.tq('${id}', this.value)">` : "");
    const th = cols.map(c => c.sort ? `<th class="sort ${c.cls || ""}" onclick="MON.tsort('${id}','${c.k}')" title="sort">${c.label}${s.by === c.k ? (s.dir > 0 ? " ↑" : " ↓") : ""}</th>` : `<th class="${c.cls || ""}">${c.label}</th>`).join("");
    const body = rs.slice(0, s.n).map(r => `<tr data-key="${esc(id)}-${esc(o.key(r))}"${o.rowAttrs ? " " + o.rowAttrs(r) : ""}>${cols.map(c => `<td class="${c.cls || ""}">${c.cell(r)}</td>`).join("")}</tr>`).join("");
    const more = rs.length > s.n ? `<button onclick="MON.tmore('${id}', ${s.page})">show ${Math.min(s.page, rs.length - s.n)} more</button> <button onclick="MON.tmore('${id}', 1e9)">all ${rs.length}</button>` : s.n > s.page && rs.length > s.page ? `<button onclick="MON.tmore('${id}', 0)">show fewer</button>` : "";
    return `${o.toolsTo ? "" : tools ? `<div class="ttools">${tools}</div>` : ""}${rs.length ? `<div class="scroll"><table>${o.colgroup || ""}<thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>` : `<div class="muted small">${o.empty || (s.q ? "Nothing matches." : "None.")}</div>`}
      <div class="tfoot"><span class="muted small">${rs.length > s.n ? `${s.n} of ${rs.length}` : rs.length !== rows.length ? `${rs.length} of ${rows.length}` : ""}</span>${more}</div>`;
  }
  const tableTools = (id, o) => {  // the search box and facets, for a panel header
    const s = TBL[id]; if (!s) return "";
    if (!(o.rows || []).length && !s.q) return "";  // nothing to search: no controls
    const facets = o.facets || [], fc = facets.find(f => f[0] === s.f) || facets[0], rows = o.rows || [];
    return (facets.length ? `<div class="seg">${facets.map(([n, f]) => `<button class="${fc[0] === n ? "on" : ""}" onclick="MON.tfacet('${id}','${esc(n)}')">${esc(n)} <span class="muted">${rows.filter(f).length}</span></button>`).join("")}</div>` : "") +
      (o.text ? `<input type="search" placeholder="search" value="${esc(s.q)}" oninput="MON.tq('${id}', this.value)">` : "");
  };
  /* A panel whose body opens on a click; closed panels show their summary line. Open state is remembered per section. */
  function section(id, title, sub, body, o = {}) {
    const open = FOLD[id] ?? !!o.open;
    return `<div class="panel fold ${open ? "open" : ""}" data-key="sec-${id}"><div class="spread"><h2 class="fold-h" onclick="MON.fold('${id}', ${!open})"><span class="chev">▸</span>${title}${sub ? ` <span class="muted" style="font-weight:400">${sub}</span>` : ""}</h2>${open && o.right ? `<div class="row">${o.right()}</div>` : ""}</div>
      ${open ? body() : ""}</div>`;
  }
  /* An inline "more" toggle inside a panel. */
  function more(id, label, body, o = {}) {
    const open = FOLD[id] ?? !!o.open;
    return `<div class="more" data-key="more-${id}"><button class="linkish" onclick="MON.fold('${id}', ${!open})">${open ? "hide " + label : label + " ▸"}</button>${open ? body() : ""}</div>`;
  }

  // ---- shared bits ------------------------------------------------------------------------------------------
  const runByKey = k => S.runs.find(r => r.key === k);
  const latest = r => (r.attempts || []).slice(-1)[0] || null;
  function bar(t, w) {
    if (!t) return "";
    const tot = Math.max(t.expected || 0, t.dirs) || 1, p = t.phases || {};
    const seg = (k) => p[k] ? `<span style="width:${100 * p[k] / tot}%;background:${PH[k][1]}" title="${p[k]} ${PH[k][0]}"></span>` : "";
    return `<div class="bar"${w ? ` style="width:${w}"` : ""}>${["done", "error", "verifying", "agent", "setup", "stale", "unknown"].map(seg).join("")}</div>`;
  }
  const barKey = t => { const p = (t && t.phases) || {};
    return `<div class="barkey">${["done", "error", "verifying", "agent", "setup", "stale", "unknown"].filter(k => p[k]).map(k => `<span><i style="background:${PH[k][1]}"></i>${PH[k][0]} ${int(p[k])}</span>`).join("")}</div>`; };
  function stepper(su, r) {
    if (!su || !su.stages) return "";
    const stages = r && !trains(r) ? su.stages.filter(([k]) => k !== "training") : su.stages;
    const at = stages.findIndex(([k]) => k === su.stage);
    // a run that has ended without reaching "done": finished ends on a green "done"; stopped early, on an amber "stopped"
    const ended = r && r.tone !== "run" && su.stage !== "done", ok = ended && r.tone === "good";
    const endT = ended ? (r.trials && r.trials.last_finish) || null : null;
    const short = { queued: "queued", container: "container", ray: "Ray", sessions: "sessions", loading: "loading", loaded: "loaded",
                    ready: "engine ready", rollout: "rollout", trials: "trials", training: "training", done: "done" };
    return `<div class="stepper">${stages.map(([k, l], i) => {
      const stopped = ended && !ok && k === "done";
      const cls = stopped ? "stopped" : ended ? (ok || i <= at ? "done" : "") : i < at || (i === at && k === "done") ? "done" : i === at ? "cur" : "";
      const t = (su.seen && su.seen[k]) || (ended && k === "done" ? endT : null);
      const extra = k === "loading" && i === at && su.shards ? " " + su.shards : "";
      const name = stopped ? "stopped" : k === "trials" && /^rollout filling/.test(l) && trains(r) ? "filling batch 0" : short[k] || k;
      if (stopped) l = `stopped early: ${r.status}${endT ? " · last trial write" : ""}`;
      return `<div class="step ${cls}" title="${esc(l)}${t ? " · " + fmt(t) : ""}">${esc(name)}${esc(extra)}<span class="when">${t ? hm(t) : "&nbsp;"}</span></div>`;
    }).join("")}</div>`;
  }
  function signalsHTML(sigs, id) {
    if (!sigs || !sigs.length) return "";
    const order = { bad: 0, warn: 1, info: 2, ok: 3 };
    const all = [...sigs].sort((a, b) => order[a.level] - order[b.level]);
    const one = s => `<div class="signal ${LEVEL[s.level]}" data-key="sig-${esc(s.id)}"><b>${s.level === "ok" ? "ok" : s.level}</b><span>${esc(s.text)}</span></div>`;
    const top = all.filter(s => s.level === "bad" || s.level === "warn"), rest = all.filter(s => !top.includes(s));
    return `<div class="signals">${top.map(one).join("")}${rest.length ? more("sig-" + (id || "x"), top.length ? `${rest.length} more checks ok` : `all ${rest.length} checks ok`, () => rest.map(one).join("")) : ""}</div>`;
  }

  function linksHTML(r, opts = {}) {
    const j = r.links || {}, reg = r.registry || {}, out = [];
    for (const a of (j.gpu_apps || []).slice(0, opts.all ? 4 : 1)) out.push(link(a.url, "Modal " + (opts.all ? a.app_id.slice(-6) + " " : "") + "↗", "chip"));
    if (j.sail && !(opts.noSail && !j.sail.live)) out.push(`<a class="chip" href="https://app.sailresearch.com" target="_blank" rel="noopener">Sail ${j.sail.live} live ↗</a>`);
    if (j.modal_sandboxes && !(opts.noSail && !j.modal_sandboxes.tasks)) out.push(link(j.modal_sandboxes.url, `sandboxes ${j.modal_sandboxes.tasks} live ↗`, "chip"));
    for (const w of (j.wandb || []).slice(0, opts.all ? 4 : 1)) out.push(link(w.url, "W&B " + (opts.all && (j.wandb || []).length > 1 ? w.id + " " + w.state : w.project) + " ↗", "chip"));
    for (const d of reg.docs || []) out.push(link(d, "design doc ↗", "chip"));
    return out.join(" ");
  }
  function watchdogLine(rid) {
    const w = S.watchdogs[rid];
    if (!w) return "";
    const st = w.status || {};
    return `<span><span class="dot ${w.running ? "t-good" : "t-idle"}"></span>watchdog ${w.running ? "armed" : "not running"} · checked ${ago(w.checked)}${st.decode ? ` · last decode ${esc(st.decode[1])} req` : ""}</span>`;
  }
  const isLiveRun = r => r.tone === "run" || (r.attempts || []).some(a => a.latest && /^ephemeral|^running/.test(a.app_state || ""));

  // ---- Now: live runs, what happened, recent history ---------------------------------------------------------
  function engineKpi(r, att) {
    const d = att && att.log && att.log.decode;
    const sp = `<canvas data-keep="spark-${esc(r.run_id)}" data-spark="${esc(r.run_id)}"></canvas>`;
    if (!d) return `<div class="kpi"><div class="v">–</div><div class="k">Decode tok/s</div>${sp}</div>`;
    return `<div class="kpi"><div class="v" data-flash>${int(d[2])}</div><div class="k">Decode tok/s</div><div class="s">${d[1]} req · ${ago(d[0])}</div>${sp}</div>`;
  }
  function costKpi(r, k) {
    const c = r.cost;
    if (!c) return k("–", "Modal cost", S.cost && S.cost.through ? "nothing billed yet" : "");
    return k(`<span title="${esc(costTitle(c))}">${costNow(c)}</span>`, "Modal cost", costSub(c));
  }
  // Modal bills whole hours after they end; the server adds an estimate for the time since, at the app's latest rate
  const costNow = c => c.unbilled ? `~${usd(c.estimate)}` : usd(c.total);
  const costSub = c => c.unbilled ? `${usd(c.total)} billed + ~${usd(c.unbilled)} est.` : `${c.last_hour ? usd(c.last_hour) + "/h · " : ""}billed to ${hm(S.cost.through)}`;
  const costTitle = c => c.unbilled ? `Billed through ${hm(S.cost.through)}; the rest is the monitor's estimate since then at the app's latest billed rate` : `Billed through ${hm(S.cost.through)}`;
  // ---- training runs: steps from Miles' per-step log lines ------------------------------------------------------
  const stepsOf = r => (r.train && r.train.steps) || [];
  const pct = v => v == null ? "–" : `${(100 * v).toFixed(1)}%`;
  /* An eval's pass@k from the server (pass_at): over each task's first k trials, refill extras left out. */
  const evalPass = r => typeOf(r) === "eval" && r.pass && r.pass.at1 != null ? r.pass : null;
  function evalPanel(r, p) {
    const t = r.trials, a = p.all || {}, nexc = Object.values(t.exceptions || {}).reduce((x, y) => x + y, 0);
    const big = (v, k, s) => `<div class="tile"><div class="v">${v}</div><div class="k">${k}</div><div class="s">${s || "&nbsp;"}</div></div>`;
    return `<div class="panel" data-key="p-results"><h2>Results</h2>
      <div class="tiles">${big(mean2(t.mean_reward), "Mean reward", t.extras ? "all trials" : "")}${big(int(nexc), "Exceptions", nexc ? Object.entries(t.exceptions).slice(0, 2).map(([e, n]) => `${esc(e.replace(/Error$/, ""))} ${n}`).join(" · ") : "")}</div>
      ${t.extras ? `<p class="small" style="margin:10px 0 0"><b>${int(t.finished)} trials ran for ${int(t.finished - t.extras)} planned.</b> Some sample groups were aborted (serving aborts), and Miles refilled them by re-sampling the whole batch, so tasks got more than ${p.k} trials. The headline numbers count each task's first ${p.k} trials by start time; the ${int(t.extras)} later ones are refill extras, faded in the tables below. With them, pass@${p.k} would read ${pct(a.atk)}, pass@1 ${pct(a.at1)}, ${a.tasks_solved} tasks solved.</p>` : ""}
      ${p.tasks_k < p.tasks ? `<p class="muted small" style="margin:6px 0 0">${p.tasks - p.tasks_k} tasks have fewer than ${p.k} finished trials and are left out of pass@${p.k}.</p>` : ""}</div>`;
  }
  function trainKpis(r, k) {
    const tr = r.train || {}, steps = stepsOf(r), exp = tr.expected_steps || (r.registry || {}).expected_steps;
    const last = steps[steps.length - 1], first = steps[0];
    const left = exp && last ? exp - 1 - last.n : null;
    const eta = left > 0 && tr.median_step_s ? last.t + left * tr.median_step_s : null;
    return [
      k(last ? `${last.n + 1}<small>/${exp || "?"}</small>` : `0<small>/${exp || "?"}</small>`, "Steps done",
        tr.training_now ? `step ${(tr.trains_started || 1) - 1} training now` : last ? `last ${agoTxt(last.t)}` : "rollout filling the first batch"),
      k(last && last.raw_reward != null ? mean2(last.raw_reward) : "–", "Reward, last step", first && last && first !== last && first.raw_reward != null ? `step ${first.n}: ${mean2(first.raw_reward)}` : ""),
      k(tr.median_step_s ? dur(tr.median_step_s) : "–", "Step time", tr.median_step_s ? `median${eta ? ` · last ~${hm(eta)}` : ""}` : ""),
    ];
  }
  function trainPanel(r) {
    const tr = r.train, steps = stepsOf(r);
    if (!tr && typeOf(r) !== "train") return "";
    const kk = (v, label, sub) => `<div class="tile"><div class="v" data-flash>${v ?? "–"}</div><div class="k">${label}</div><div class="s">${sub || "&nbsp;"}</div></div>`;
    const last = steps[steps.length - 1] || {}, saves = (tr && tr.saves) || [];
    const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    const rw = steps.filter(s => s.raw_reward != null).map(s => s.raw_reward);
    const head = mean(rw.slice(0, 3)), tail = mean(rw.slice(-3));
    const cols = [
      { k: "n", label: "Step", cls: "num", sort: s => s.n, cell: s => s.n },
      { k: "t", label: "Done", cls: "small nowrap", desc: true, sort: s => s.t, cell: s => `<span title="${fmt(s.t)}">${hm(s.t)}</span>` },
      { k: "raw_reward", label: "Reward", cls: "num", desc: true, sort: s => s.raw_reward, cell: s => `<b>${mean2(s.raw_reward)}</b>` },
      { k: "raw_reward_unfiltered", label: "Before<br>filter", cls: "num w14", desc: true, sort: s => s.raw_reward_unfiltered, cell: s => mean2(s.raw_reward_unfiltered) },
      { k: "zero", label: "All-0 / all-1<br>groups", cls: "num small", sort: s => s.zero_std_all_zero, cell: s => s.zero_std_all_zero != null ? `${Math.round(100 * s.zero_std_all_zero)}% / ${Math.round(100 * (s.zero_std_all_one || 0))}%` : "–" },
      { k: "samples", label: "Samples", cls: "num", sort: s => s.samples, cell: s => s.samples ?? "–" },
      { k: "truncated", label: "Truncated", cls: "num", desc: true, sort: s => s.truncated, cell: s => s.truncated != null ? Math.round(100 * s.truncated) + "%" : "–" },
      { k: "response_len", label: "Resp.<br>len", cls: "num", desc: true, sort: s => s.response_len, cell: s => s.response_len != null ? Math.round(s.response_len).toLocaleString() : "–" },
      { k: "staleness", label: "Staleness", cls: "num w14", desc: true, sort: s => s.staleness, cell: s => num(s.staleness, 2) },
      { k: "grad_norm", label: "Grad norm", cls: "num", desc: true, sort: s => s.grad_norm, cell: s => sig3(s.grad_norm) },
      { k: "logprob_diff", label: "Log-prob<br>gap", cls: "num", desc: true, sort: s => s.logprob_diff, cell: s => num(s.logprob_diff, 4) },
      { k: "step_time", label: "Step time", cls: "num", desc: true, sort: s => s.step_time, cell: s => dur(s.step_time) },
      { k: "update_weights_time", label: "Weight<br>sync", cls: "num", desc: true, sort: s => s.update_weights_time, cell: s => secs(s.update_weights_time) },
    ];
    const ex = tr && tr.exit;
    return `<div class="panel" data-key="p-train"><h2>Training</h2>
      <div class="tiles">${trainKpis(r, kk).slice(2).join("")}
        ${kk(head != null && tail != null && rw.length >= 4 ? `${mean2(head)} → ${mean2(tail)}` : "–", "Reward, mean of 3", "first 3 steps → last 3")}
        ${kk(saves.length ? saves[saves.length - 1][1] : "–", "Last checkpoint", saves.length ? ago(saves[saves.length - 1][0]) : "none yet")}
        ${kk(tr && tr.last_sync_s != null ? secs(tr.last_sync_s) : "–", "Weight sync", tr && tr.syncs ? `last of ${tr.syncs}${tr.sync_failed ? ` · ${tr.sync_failed} failed` : ""}` : "")}
        ${kk(last.logprob_diff != null ? num(last.logprob_diff, 4) : "–", "Log-prob gap", "train vs rollout")}</div>
      ${ex ? `<p class="${ex.reason === "success" ? "muted" : "err"} small">Trainer exited: ${esc(ex.reason)}${ex.step != null ? ` at step ${ex.step}` : ""}${ex.note ? " · " + esc(ex.note) : ""} (${fmt(ex.t)})</p>` : ""}
      ${steps.length ? more("train-steps", `table of every step (${steps.length})`, () => `<div class="tight">${table("steps", steps, cols, { key: s => s.n, sort: "n", dir: -1, page: 15,
          rowAttrs: s => `title="step ${s.n} · before filter ${mean2(s.raw_reward_unfiltered)} · staleness ${num(s.staleness, 2)}"` })}</div>`) :
        `<p class="muted small">${tr && tr.training_now ? "Step 0 is training now; its" : "No step yet. The first step trains once a full batch of trials has finished; its"} reward, step time and weight sync show here from Miles' own per-step log lines once it ends.</p>`}</div>`;
  }
  // ---- SFT runs (manifest kind "sft"): loss, held-out NLL, throughput, checkpoints and the evals of them ----------
  const isSft = r => typeOf(r) === "sft";
  const loss4 = v => v == null ? "–" : (+v).toFixed(4);
  const lastOf = (steps, k) => { for (let i = steps.length - 1; i >= 0; i--) if (steps[i][k] != null) return steps[i]; return null; };
  const avgOf = xs => { const v = xs.filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  // the train loss is noisy step to step: tiles show the mean of the last 10 steps
  const lossTail = steps => avgOf(steps.slice(-10).map(s => s.loss));
  function sftKpis(r, k) {
    const tr = r.train || {}, steps = stepsOf(r), exp = tr.expected_steps || (r.registry || {}).expected_steps;
    const last = steps[steps.length - 1], vals = tr.vals || [], v0 = vals[0], v1 = vals[vals.length - 1];
    const left = exp && last ? exp - 1 - last.n : null, eta = left > 0 && tr.median_step_s ? last.t + left * tr.median_step_s : null;
    const tps = lastOf(steps, "tok_per_s");
    return [
      k(last ? `${last.n + 1}<small>/${exp || "?"}</small>` : `0<small>/${exp || "?"}</small>`, "Steps done", last ? `last ${agoTxt(last.t)}${eta ? ` · done ~${hm(eta)}` : ""}` : "trainer loading"),
      k(loss4(lossTail(steps)), "Train loss", steps.length ? `mean of last ${Math.min(10, steps.length)}${steps[0].loss != null && steps.length > 10 ? ` · first ${loss4(steps[0].loss)}` : ""}` : ""),
      k(v1 ? loss4(v1[1]) : "–", "Val NLL", v1 ? (v0 && v0 !== v1 ? `${v0[0] ? "step " + v0[0] : "before training"}: ${loss4(v0[1])}` : v1[0] ? `after ${v1[0]} steps` : "before training") : "no validation yet"),
      k(tps ? int(tps.tok_per_s) : "–", "Tokens/s", tps && tps.mfu != null ? `trainer · MFU ${Math.round(100 * tps.mfu)}%` : "trainer"),
      k(tr.median_step_s ? secs(tr.median_step_s) : "–", "Step time", tr.median_step_s ? "median" : ""),
    ];
  }
  /* The evals that name this run in "evaluates" (manifest or runs.json): one row per checkpoint eval. */
  function evalsHTML(r) {
    const evs = r.evals || [];
    if (!evs.length) return `<p class="muted small">No eval of this run's checkpoints yet. An eval links here when its manifest (or runs.json entry) says <span class="mono">"evaluates": {"run": "${esc(r.run_id)}", "step": N}</span>; <span class="mono">register.py --evaluates ${esc(r.run_id)}@N</span> writes it.</p>`;
    const cols = [
      { k: "step", label: "Checkpoint", sort: e => e.step ?? -1, cell: e => esc(e.label || (e.step === 0 || e.step === "base" ? "base model" : e.step != null ? `step ${e.step}` : "–")) },
      { k: "run", label: "Eval run", sort: e => e.run_id, cell: e => `<a href="#tab=runs&run=${encodeURIComponent(e.key)}">${esc(e.run_id)}</a>` },
      { k: "status", label: "Status", sort: e => e.status, cell: e => `<span class="nowrap"><span class="dot t-${e.tone}"></span>${esc(e.status)}</span>` },
      { k: "atk", label: "pass@k", cls: "num", desc: true, sort: e => e.pass && e.pass.atk, cell: e => e.pass && e.pass.atk != null ? `<b>${(100 * e.pass.atk).toFixed(1)}%</b> <span class="muted small">@${e.pass.k}</span>` : "–" },
      { k: "at1", label: "pass@1", cls: "num", desc: true, sort: e => e.pass && e.pass.at1, cell: e => e.pass ? `${(100 * e.pass.at1).toFixed(1)}%` : "–" },
      { k: "tasks", label: "Tasks", cls: "num", sort: e => e.pass && e.pass.tasks, cell: e => e.pass ? (e.pass.tasks_k !== e.pass.tasks ? `${e.pass.tasks_k} of ${e.pass.tasks}` : int(e.pass.tasks)) : "–" },
      { k: "trials", label: "Trials", cls: "num", sort: e => e.finished, cell: e => e.finished != null ? `${int(e.finished)}${e.expected ? "/" + int(e.expected) : ""}` : "–" },
      { k: "cost", label: "Cost", cls: "num", sort: e => e.cost, cell: e => e.cost != null ? usd(e.cost) : "–" },
    ];
    return `<div class="tight">${table("sft-evals", evs, cols, { key: e => e.key, sort: "step", dir: 1 })}</div>
      <p class="muted small">pass@k is the unbiased estimate over the tasks with at least k finished trials (reward 1 = solved); k is the eval's n_samples.</p>`;
  }
  function sftPanel(r) {
    const tr = r.train || {}, steps = stepsOf(r), saves = tr.saves || [], hf = tr.hf || [], vals = tr.vals || [];
    const kk = (v, label, sub) => `<div class="tile"><div class="v" data-flash>${v ?? "–"}</div><div class="k">${label}</div><div class="s">${sub || "&nbsp;"}</div></div>`;
    const lr = lastOf(steps, "lr"), gn = lastOf(steps, "grad_norm");
    const cols = [
      { k: "n", label: "Step", cls: "num", sort: s => s.n, cell: s => s.n },
      { k: "t", label: "Done", cls: "small nowrap", desc: true, sort: s => s.t, cell: s => `<span title="${fmt(s.t)}">${hm(s.t)}</span>` },
      { k: "loss", label: "Train loss", cls: "num", desc: true, sort: s => s.loss, cell: s => `<b>${loss4(s.loss)}</b>` },
      { k: "val_nll", label: "Val NLL", cls: "num", desc: true, sort: s => s.val_nll, cell: s => s.val_nll != null ? `<b>${loss4(s.val_nll)}</b>` : "" },
      { k: "lr", label: "LR", cls: "num", sort: s => s.lr, cell: s => sig3(s.lr) },
      { k: "grad_norm", label: "Grad norm", cls: "num", desc: true, sort: s => s.grad_norm, cell: s => sig3(s.grad_norm) },
      { k: "tok_per_s", label: "Tokens/s", cls: "num", desc: true, sort: s => s.tok_per_s, cell: s => int(s.tok_per_s) },
      { k: "mfu", label: "MFU", cls: "num", desc: true, sort: s => s.mfu, cell: s => s.mfu != null ? Math.round(100 * s.mfu) + "%" : "–" },
      { k: "step_time", label: "Step time", cls: "num", desc: true, sort: s => s.step_time || s.dt, cell: s => secs(s.step_time || s.dt) },
    ];
    const ckpts = [...saves.map(([t, n]) => ({ t, what: `checkpoint, step ${n}` })), ...hf.map(([t, p]) => ({ t, what: `HF export ${p.split("/").slice(-2).join("/")}`, title: p }))].sort((a, b) => b.t - a.t);
    return `<div class="panel" data-key="p-train"><h2>SFT training</h2>
      <div class="tiles">${sftKpis(r, kk).slice(1).join("")}
        ${kk(lr ? sig3(lr.lr) : "–", "Learning rate", lr ? `at step ${lr.n}` : "")}
        ${kk(gn ? sig3(gn.grad_norm) : "–", "Grad norm", gn ? `at step ${gn.n}` : "")}
        ${kk(saves.length ? saves[saves.length - 1][1] : "–", "Last checkpoint", saves.length ? `${ago(saves[saves.length - 1][0])}${hf.length ? ` · ${plural(hf.length, "HF export")}` : ""}` : hf.length ? plural(hf.length, "HF export") : "none yet")}</div>
      ${(tr.loss_nan || []).length ? `<p class="err small">train/loss was not finite at step ${tr.loss_nan.slice(-5).join(", ")}</p>` : ""}
      ${tr.exit ? `<p class="${tr.exit.reason === "success" ? "muted" : "err"} small">Trainer exited: ${esc(tr.exit.reason)}${tr.exit.step != null ? ` at step ${tr.exit.step}` : ""}${tr.exit.note ? " · " + esc(tr.exit.note) : ""} (${fmt(tr.exit.t)})</p>` : ""}
      <h3>Evals of its checkpoints</h3>${evalsHTML(r)}
      ${vals.length ? more("sft-vals", `validation passes (${vals.length})`, () => `<table class="tight"><thead><tr><th>After</th><th class="num">Val NLL</th><th>When</th></tr></thead><tbody>${vals.map(([n, v, t]) => `<tr><td>${n ? plural(n, "step") : "before training"}</td><td class="num">${loss4(v)}</td><td class="small muted">${fmt(t)}</td></tr>`).join("")}</tbody></table>`) : ""}
      ${ckpts.length ? more("sft-ckpts", `checkpoints and HF exports (${ckpts.length})`, () => `<table class="tight"><tbody>${ckpts.map(c => `<tr><td${c.title ? ` title="${esc(c.title)}"` : ""}>${esc(c.what)}</td><td class="small muted">${fmt(c.t)}</td></tr>`).join("")}</tbody></table>`) : ""}
      ${steps.length ? more("train-steps", `table of every step (${steps.length})`, () => `<div class="tight">${table("steps", steps, cols, { key: s => s.n, sort: "n", dir: -1, page: 15 })}</div>`) :
        `<p class="muted small">No step yet. Loss, learning rate and throughput show here from Miles' own per-step log lines (<span class="mono">step N: {...}</span>, <span class="mono">perf N: {...}</span>) once the first step ends; validation NLL from <span class="mono">validation at step N: {'val/nll': ...}</span>.</p>`}</div>`;
  }
  function trainerNow(r, su, ended) {
    const tr = r.train || {}, ph = tr.phases || [], seen = (su && su.seen) || {};
    const trains = ph.filter(x => x[0] === "train"), open = [...ph].reverse().find(x => x[2] == null);
    const k = trains.length - (open && open[0] === "train" ? 1 : 0);  // the batch rollout is filling now
    if (tr.exit) return { text: `Trainer exited (${tr.exit.reason}) ${ago(tr.exit.t)}`, filling: null };
    const att = latest(r);
    if (att && /^stopped/.test(att.app_state || "")) return { text: `<b>Stopped.</b> The GPU app ended${att.stopped_at ? " " + ago(tsOf(att.stopped_at)) : ""} after ${plural(trains.length, "training step")} started`, filling: null };
    if (ended) return { text: `<b>Ended (${esc(ended.status)}).</b> ${plural(trains.length, "training step")} ran; last activity ${hm(ended.t)}`, filling: null };
    if (open && open[0] === "train") return { text: `<b>Training step ${trains.length - 1}</b> since ${hm(open[1])} (${dur(now() - open[1])}); rollout keeps going for batch ${k + 1}`, filling: k + 1 };
    if (open && open[0] === "update_weights") return { text: `<b>Weight sync</b> since ${hm(open[1])} (${dur(now() - open[1])}): engines pause for new weights`, filling: k };
    if (open && open[0] === "train_wait") return { text: `<b>Rollout only: filling batch ${k}.</b> No training yet${trains.length ? " for this batch" : ""}; the trainer has waited since ${hm(open[1])} (${dur(now() - open[1])})`, filling: k };
    if (seen.rollout || seen.trials) return { text: `<b>Rollout only: filling batch 0.</b> The trainer is still loading`, filling: 0 };
    return { text: "Starting up", filling: null };
  }
  function evalNow(r, ended) {
    const t = r.trials || {}, att = latest(r), fin = t.extras ? `${int(t.finished)} trials finished (${int(t.finished - t.extras)} counted + ${int(t.extras)} refill extras)` : `${int(t.finished)} of ${int(t.expected || t.dirs)} trials finished`;
    if (ended || att && /^stopped/.test(att.app_state || "")) return { text: `<b>${ended ? `Ended (${esc(ended.status)})` : "Done"}.</b> ${fin}${t.last_finish ? `; last finish ${hm(t.last_finish)}` : ""}` };
    return { text: t.dirs ? `<b>Running trials:</b> ${int(t.in_flight)} in flight, ${fin}` : "Starting up" };
  }
  /* Groups per task from the trial dirs: n trials in start order make a group (close, not exact); a group whose
     rewards are all equal carries no signal and Miles' nonzero_std filter drops it. */
  function batchFill(r, rows) {
    const reg = r.registry || {}, n = reg.n_samples, B = reg.batch_size;
    if (!n || !B || !rows.length) return null;
    const by = {};
    for (const x of rows) (by[x.task] = by[x.task] || []).push(x);
    let usable = 0, failed = 0;
    const dropped = {};
    for (const [task, xs] of Object.entries(by)) {
      xs.sort((a, b) => (a.start || 0) - (b.start || 0));
      for (let i = 0; i + n <= xs.length; i += n) {
        const g = xs.slice(i, i + n);
        if (!g.every(x => x.phase === "done" || x.phase === "error")) continue;
        if (g.some(x => x.phase === "error")) { failed++; continue; }  // a failed trial drops its whole group
        const rw = g.map(x => x.reward || 0);
        if (reg.group_filter === "nonzero_std" && rw.every(v => v === rw[0])) {
          const d = dropped[task] = dropped[task] || { n: 0, r: rw[0] }; d.n++;
        } else usable++;
      }
    }
    const used = (((r.train || {}).phases) || []).filter(x => x[0] === "train").length * B;
    return { usable, failed, have: Math.max(0, usable - used), B, n, dropped };
  }
  /* RL phases over time: engine startup, the trainer's own phases (from rank 0's Megatron timers: loading,
     waiting for a batch, weight sync, step N) and rollout as trials in flight, on one time axis. Hover reads out
     every lane at that moment; drag across to zoom, click a training step to zoom to it, double-click to reset. */
  const PHM = {};  // run_id -> the drawn model, for the hover readout
  /* isTrain false (an eval): engine startup and trials in flight only, no trainer lane. */
  function phaseTimeline(r, rows, su, isTrain) {
    const tr = isTrain ? r.train || {} : {}, ph = tr.phases || [], seen = (su && su.seen) || {};
    if (!isTrain && !rows.length) return "";
    const T0 = seen.container || seen.ray || Math.min(...rows.map(x => x.start || Infinity));
    if (!isFinite(T0)) return "";
    // a run that is over ends its chart at its last activity, not now
    const sm = runByKey(r.key) || r, last = Math.max((r.trials || {}).last_finish || 0, ...ph.map(x => x[2] || x[1]), ...Object.values(seen));
    const ended = sm.tone && sm.tone !== "run" && !tr.exit ? { status: sm.status, t: last } : null;
    const T1 = Math.max(tr.exit ? tr.exit.t : ended ? last + 300 : now(), T0 + 900);
    const z = ui.phZoom[r.run_id], t0 = z ? z[0] : T0, t1 = z ? z[1] : T1;
    const W = Math.max(640, Math.min(innerWidth, 1440) - 72), L = 132, R = 10, X = t => L + (W - L - R) * (Math.min(t1, Math.max(t0, t)) - t0) / (t1 - t0);
    const lane = isTrain ? { start: [6, 18], trainer: [32, 22], rollout: [76, 58] } : { start: [6, 18], rollout: [46, 88] }, H = 160;
    const M = { t0, t1, T0, T1, L, R, W, H, isTrain, start: [], trainer: [], pts: [], steps: {} };
    for (const s of stepsOf(r)) M.steps[s.n] = s;
    const labels = [];
    const rect = (t, u, [y, h], fill, label, op = 1, cls = "", data = "") => {
      if (u < t0 || t > t1) return "";
      const x = X(t), w = Math.max(1.5, X(u) - x);
      if (label) labels.push({ x, end: x + w, y, h, label, cls });
      return `<rect class="seg" x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${h}" rx="2" fill="${fill}" opacity="${op}"${data}/>`;
    };
    let g = "";
    // engine startup, from the stepper's stage times
    const order = [["container", "container", "var(--idle)"], ["ray", "Ray", "var(--idle)"], ["sessions", "sessions", "var(--idle)"], ["loading", "engine loading", "var(--verify)"], ["loaded", "warm-up", "var(--verify)"], ["ready", "engine ready", "var(--good)"]];
    const st = order.filter(([k]) => seen[k]);
    st.forEach(([k, label, c], i) => {
      const a = seen[k], b = i + 1 < st.length ? seen[st[i + 1][0]] : seen.rollout || seen.trials || T1;
      M.start.push({ a, b, label, c });
      g += rect(a, b, lane.start, c, label, 0.55);
    });
    // trainer: loading until its first timer, then its phases
    const first = ph.length ? ph[0][1] : null, tStart = seen.ray || T0;
    if (seen.ray && isTrain) { M.trainer.push({ a: tStart, b: first || T1, label: "trainer loading", c: "var(--idle)" }); g += rect(tStart, first || T1, lane.trainer, "var(--idle)", "trainer loading", 0.45); }
    let step = 0, batch = 0;
    const n0 = stepsOf(r).length ? stepsOf(r)[0].n : 0;
    for (const [name, a, b0] of ph) {
      const b = b0 || T1, open = !b0;
      if (name === "train_wait") { M.trainer.push({ a, b, open, label: `waiting for batch ${batch}`, c: "var(--surface-2)" }); g += rect(a, b, lane.trainer, "var(--surface-2)", "waiting for batch"); }
      else if (name === "update_weights") { M.trainer.push({ a, b, open, label: "weight sync (engines paused)", c: "var(--warn)" }); g += rect(a, b, lane.trainer, "var(--warn)", "sync"); }
      else if (name === "train") {
        M.trainer.push({ a, b, open, label: `training step ${n0 + step}`, step: n0 + step, c: "var(--accent)" });
        g += rect(a, b, lane.trainer, "var(--accent)", `step ${n0 + step}`, 1, "w", ` data-a="${a}" data-b="${b}"`); step++; batch++;
      }
    }
    // rollout: trials in flight over time
    const ev = [];
    for (const x of rows) {
      if (!x.start) continue;
      const end = x.finished || (["done", "error", "stale"].includes(x.phase) ? x.last_write || x.start : T1);
      ev.push([x.start, 1], [end, -1]);
    }
    ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0, peak = 1;
    const pts = [[T0, 0]];
    for (const [t, d] of ev) { pts.push([t, cur]); cur += d; pts.push([t, cur]); if (t >= t0 && t <= t1) peak = Math.max(peak, cur); }
    pts.push([T1, cur]);
    M.pts = pts;
    const [ry, rh] = lane.rollout, Y = v => ry + rh - rh * Math.min(v, peak) / peak;
    const vis = pts.filter(([t], i) => (t >= t0 || (pts[i + 1] && pts[i + 1][0] >= t0)) && (t <= t1 || (pts[i - 1] && pts[i - 1][0] <= t1)));
    if (vis.length) {
      const line = vis.map(([t, v], i) => `${i ? "L" : "M"}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join("");
      g += `<path d="${line}L${X(vis[vis.length - 1][0]).toFixed(1)},${ry + rh}L${X(vis[0][0]).toFixed(1)},${ry + rh}Z" fill="var(--roll)" opacity="0.28"/><path d="${line}" fill="none" stroke="var(--roll)" stroke-width="1.2"/>`;
    }
    g += `<text x="${L - 8}" y="${ry + 9}" text-anchor="end" class="tl-k">${peak}</text>`;
    // engines pause during each weight sync; each training step starts when its batch is full
    let b = 0;
    const syncs = [];
    for (const [name, a, b0] of ph) {
      if ((b0 || T1) < t0 || a > t1) { if (name === "train") b++; continue; }
      if (name === "update_weights") { syncs.push([X(a), Math.max(X(a) + 1.5, X(b0 || T1))]); g += `<rect x="${X(a).toFixed(1)}" y="${lane.trainer[0]}" width="${Math.max(1.5, X(b0 || T1) - X(a)).toFixed(1)}" height="${ry + rh - lane.trainer[0]}" fill="var(--warn)" opacity="0.18" pointer-events="none"/>`; }
      if (name === "train") { g += `<line x1="${X(a).toFixed(1)}" x2="${X(a).toFixed(1)}" y1="${lane.trainer[0]}" y2="${ry + rh}" stroke="var(--accent)" stroke-dasharray="3 3" pointer-events="none"/><text x="${(X(a) + 4).toFixed(1)}" y="${ry - 6}" class="tl-mark">batch ${b} full</text>`; b++; }
    }
    // a label only where it fits, so a zoom shows more of them
    let lastEnd = -1;
    for (const l of labels.sort((a, b) => a.y - b.y || a.x - b.x)) {
      let x = l.x;
      for (const [a, z2] of syncs) if (a <= x + 2 && z2 > x) x = z2;
      x += 5;
      if (l.end - x >= l.label.length * 6.2 + 4) g += `<text x="${x.toFixed(1)}" y="${l.y + l.h / 2 + 4}" class="tl-in ${l.cls}">${esc(l.label)}</text>`;
      lastEnd = l.end;
    }
    // axis in PT, and now
    const span = t1 - t0, stepS = [60, 120, 300, 900, 1800, 3600, 7200, 14400].find(s => span / s <= 9) || 28800;
    let ax = "";
    const tick = (x, lab) => { const hw = lab.length * 3.3, end = x + hw > W - R, start = x - hw < L;
      return `<text x="${(end ? W - R : start ? L : x).toFixed(1)}" y="${H - 2}" text-anchor="${end ? "end" : start ? "start" : "middle"}" class="tl-k">${lab}</text>`; };
    for (let t = Math.ceil(t0 / stepS) * stepS; t <= t1; t += stepS) ax += `<line x1="${X(t).toFixed(1)}" x2="${X(t).toFixed(1)}" y1="${lane.start[0]}" y2="${H - 14}" stroke="var(--grid)"/>${tick(X(t), PT.hm.format(t * 1000))}`;
    if (!tr.exit && !ended && now() <= t1) ax += `<line x1="${X(now()).toFixed(1)}" x2="${X(now()).toFixed(1)}" y1="2" y2="${H - 14}" stroke="var(--ink-3)" stroke-width="1"/>`;
    const names = [["start", "engine startup"], ...(isTrain ? [["trainer", "trainer"]] : []), ["rollout", "trials in flight"]].map(([k, l]) => `<text x="${L - 8}" y="${lane[k][0] + Math.min(lane[k][1], 22) / 2 + 4 + (k === "rollout" ? 14 : 0)}" text-anchor="end" class="tl-l">${l}</text>`).join("");
    PHM[r.run_id] = M;
    const nowTxt = isTrain ? trainerNow(r, su, ended) : evalNow(r, ended), fill = isTrain && batchFill(r, rows);
    const drop = fill && Object.entries(fill.dropped);
    const fillTxt = fill && nowTxt.filling != null ? ` · batch ${nowTxt.filling}: <b>~${Math.min(fill.have, fill.B)}/${fill.B}</b> usable groups of ${fill.n} (estimate from trial rewards)${fill.failed ? `, ${fill.failed} dropped by a failed trial` : ""}` : "";
    const dropTxt = drop && drop.length ? more("phase-drop", `${drop.reduce((a, [, d]) => a + d.n, 0)} groups dropped by the ${esc((r.registry || {}).group_filter || "")} filter`, () => `<div class="muted small">Every reward in the group equal, so no learning signal: ${drop.map(([t, d]) => `<span class="chip">${esc(t)} × ${d.n} (all ${d.r})</span>`).join(" ")}</div>`) : "";
    return `<div class="panel" data-key="p-phases"><div class="spread"><h2>Phases over time</h2><span class="muted small">${z ? `zoomed to ${hm(t0)} to ${hm(t1)} · <button class="linkish" onclick="MON.phZoom('${esc(r.run_id)}', null)">show the whole run</button>` : `hover for details · drag across to zoom${isTrain ? " · click a step to zoom to it" : ""}`}</span></div>
      <p style="margin:4px 0 8px">${nowTxt.text}${fillTxt}</p>${dropTxt}
      <div class="scroll"><div class="tl-wrap" data-run="${esc(r.run_id)}" style="width:${W}px"><svg class="tl" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="max-width:none;display:block">${ax}${g}${names}</svg>
        <div class="tl-cursor" data-keep="cur" style="height:${H - 14}px"></div><div class="tl-sel" data-keep="sel" style="height:${H - 14}px"></div></div></div>
      <div class="tl-legend muted small"><span><i style="background:var(--idle)"></i>loading</span><span><i style="background:var(--verify)"></i>engine loading weights</span><span><i style="background:var(--good)"></i>engine ready</span>${isTrain ? `<span><i style="background:var(--surface-2);border:1px solid var(--line)"></i>trainer waiting for a batch</span><span><i style="background:var(--warn)"></i>weight sync (engines paused)</span><span><i style="background:var(--accent)"></i>training step</span>` : ""}<span><i style="background:var(--roll)"></i>trials in flight${isTrain ? " (rollout)" : ""}</span></div></div>`;
  }
  /* What every lane of the phases chart was doing at time t. */
  function phaseTip(M, t) {
    const inSeg = xs => xs.find(s => t >= s.a && t < s.b);
    const e = inSeg(M.start), tr = inSeg(M.trainer);
    let n = 0;
    for (const [x, v] of M.pts) { if (x > t) break; n = v; }
    const row = (k, c, v) => `<div><span class="tk">${k}</span>${c ? `<i style="background:${c}"></i>` : ""}${v}</div>`;
    let h = `<div><b>${hms(t)} PT</b> <span class="muted">· ${dur(t - M.T0)} in</span></div>`;
    h += row("engine", e && e.c, e ? esc(e.label) : M.start.length && t >= M.start[M.start.length - 1].b ? "serving" : "–");
    if (tr) {
      const s = tr.step != null ? M.steps[tr.step] : null;
      h += row("trainer", tr.c, `${esc(tr.label)} <span class="muted">· ${dur(tr.b - tr.a)}${tr.open ? " so far" : ""}</span>`);
      if (s) h += row("", "", `<span class="muted">reward</span> <b>${mean2(s.raw_reward)}</b>${s.response_len != null ? ` <span class="muted">· resp.</span> ${int(s.response_len)} tok` : ""}${s.update_weights_time != null ? ` <span class="muted">· sync</span> ${secs(s.update_weights_time)}` : ""}`);
    } else if (M.isTrain) h += row("trainer", "", "–");
    h += row("rollout", "var(--roll)", `${n} trial${n === 1 ? "" : "s"} in flight`);
    return h;
  }
  function wirePhases(wrap) {
    if (wrap._wired) return;
    wrap._wired = true;
    const tip = document.getElementById("tip"), cur = () => wrap.querySelector(".tl-cursor"), sel = () => wrap.querySelector(".tl-sel");
    let down = null;
    const M = () => PHM[wrap.dataset.run];
    const tAt = x => { const m = M(); return m.t0 + (Math.max(m.L, Math.min(m.W - m.R, x)) - m.L) / (m.W - m.L - m.R) * (m.t1 - m.t0); };
    const xOf = e => e.clientX - wrap.getBoundingClientRect().left;
    wrap.addEventListener("mousemove", e => {
      const m = M(); if (!m) return;
      const x = xOf(e);
      if (x < m.L || x > m.W - m.R) { cur().style.display = "none"; tip.style.display = "none"; return; }
      cur().style.display = "block"; cur().style.left = x + "px";
      if (down != null && Math.abs(x - down) > 4) { const s = sel(); s.style.display = "block"; s.style.left = Math.min(x, down) + "px"; s.style.width = Math.abs(x - down) + "px"; }
      tip.innerHTML = phaseTip(m, tAt(x)); tip.style.display = "block";
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      tip.style.left = (e.clientX + 16 + tw > innerWidth ? e.clientX - tw - 12 : e.clientX + 16) + "px";
      tip.style.top = Math.min(innerHeight - th - 8, e.clientY + 14) + "px";
    });
    wrap.addEventListener("mouseleave", () => { cur().style.display = "none"; sel().style.display = "none"; tip.style.display = "none"; down = null; });
    wrap.addEventListener("mousedown", e => { if (e.button === 0) { down = xOf(e); e.preventDefault(); } });
    wrap.addEventListener("mouseup", e => {
      const x = xOf(e), m = M(); sel().style.display = "none";
      if (down != null && Math.abs(x - down) > 6) { const a = tAt(Math.min(x, down)), b = tAt(Math.max(x, down)); if (b - a >= 60) MON.phZoom(wrap.dataset.run, [a, b]); }
      else if (e.target.dataset && e.target.dataset.a) { const a = +e.target.dataset.a, b = +e.target.dataset.b, pad = (b - a) * 0.25; MON.phZoom(wrap.dataset.run, [a - pad, b + pad]); }
      down = null;
    });
    wrap.addEventListener("dblclick", () => MON.phZoom(wrap.dataset.run, null));
  }
  /* Per task, the mean reward of the trials that finished while each step trained (a trial doesn't record the
     step its sample went into, so this bins by finish time: close, not exact, in fully async). */
  function taskStepsHTML(r, rows) {
    const steps = stepsOf(r).filter(s => s.t);
    if (!steps.length) return "";
    const fin = rows.filter(x => ["done", "error"].includes(x.phase) && x.finished);
    const bounds = steps.map(s => s.t);
    const win = t => { let i = bounds.findIndex(b => t <= b); return i < 0 ? steps.length : i; };  // window i: up to step i's end
    const tasks = {};
    for (const x of fin) {
      const w = win(x.finished), row = tasks[x.task] || (tasks[x.task] = { task: x.task, cells: {} });
      (row.cells[w] = row.cells[w] || []).push(x.reward || 0);
    }
    const ncol = steps.length + (fin.some(x => win(x.finished) === steps.length) ? 1 : 0);
    const label = i => i < steps.length ? `≤${steps[i].n}` : "now";
    const cell = xs => { if (!xs) return `<td class="hm"></td>`; const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return `<td class="hm" title="${xs.length} trials, mean ${m.toFixed(2)}" style="background:color-mix(in srgb, var(--good) ${Math.round(m * 85)}%, var(--surface-2))">${m.toFixed(2)}</td>`; };
    const list = Object.values(tasks).map(t => { const all = Object.values(t.cells).flat(); return { ...t, mean: all.reduce((a, b) => a + b, 0) / all.length }; })
      .sort((a, b) => b.mean - a.mean || (a.task < b.task ? -1 : 1));
    return section("task-steps", "Per task over steps", `${list.length} tasks · mean reward of trials that finished while each step trained`, () => `
      <p class="muted small">Trials don't record which step their sample trained in, so each column holds the trials that finished before that step ended and after the previous one: close, not exact, with fully async rollout.</p>
      <div class="scroll"><table class="heat"><thead><tr><th>Task</th><th class="hc">All</th>${Array.from({ length: ncol }, (_, i) => `<th class="hc small">${label(i)}</th>`).join("")}</tr></thead><tbody>
      ${list.map(t => `<tr data-key="ts-${esc(t.task)}"><td class="mono small">${esc(t.task)}</td><td class="hc small"><b>${t.mean.toFixed(2)}</b></td>${Array.from({ length: ncol }, (_, i) => cell(t.cells[i])).join("")}</tr>`).join("")}
      </tbody></table></div>`);
  }
  // a run with no trials and no trainer (a probe, a research app): only what is known about its GPU app
  function appKpis(r, att, su, start, k) {
    const live = ((r.links || {}).gpu_apps || []).filter(a => !String(a.state).startsWith("stopped"));
    const held = ((S.gpus || {}).workstreams || []).flatMap(w => w.apps || []).filter(a => live.some(l => l.app_id === a.app_id));
    const gpus = held.reduce((n, a) => n + (a.gpus || 0), 0), types = [...new Set(held.flatMap(a => (a.containers || []).map(c => c.gpu_type)))];
    const up = Math.min(...live.map(a => tsOf(a.created_at)).filter(Boolean)) || start;
    return [
      k(gpus ? `${gpus}× ${esc(types.join("/") || "GPU")}` : live.length ? "0" : "–", "GPUs", live.length ? esc(live.map(a => a.name).join(", ")) : "no app running"),
      su ? k(esc((su.stages.find(([x]) => x === su.stage) || [, su.stage])[1]), "Stage") : "",
      k(isFinite(up) && up ? `<span data-for="${up}">${dur(now() - up)}</span>` : "–", "Up", isFinite(up) && up ? `since ${hm(up)}` : ""),
      att && att.log && att.log.decode ? engineKpi(r, att) : "",
      costKpi(r, k),
    ].join("");
  }
  // what the nodes reported themselves (pushed, or under /results): for a run no provider can tell us about
  function nodeStateLine(r) {
    const st = r.node_state || {}, run = st.run, pool = st.pool;
    if (!run && !pool) return "";
    const parts = [];
    if (run) {
      if (run.phase) parts.push(esc(run.phase));
      if (run.next_rollout_id != null && run.num_rollout != null) parts.push(`step ${run.next_rollout_id}/${run.num_rollout}`);
      if (run.heartbeat_at) parts.push(`heartbeat ${ago(run.heartbeat_at)}`);
    }
    if (pool && pool.nodes) {
      const engines = pool.nodes.flatMap(n => n.load || []);
      const waiting = engines.reduce((a, e) => a + (e.waiting || 0), 0);
      parts.push(`${pool.nodes.length} rollout node${pool.nodes.length === 1 ? "" : "s"} · ${engines.length} engines · ${waiting} waiting`);
    }
    return `<div class="sub">Nodes report: ${parts.join(" · ")}</div>`;
  }
  function runCard(r) {
    const t = r.trials, att = latest(r), su = S.startup[r.run_id], reg = r.registry || {}, p = (t && t.phases) || {};
    const lim = reg.limits || {}, start = att ? tsOf(att.started_at) : t && t.first_start;
    const n = (r.attempts || []).length;
    const k = (v, label, sub) => `<div class="kpi"><div class="v" data-flash>${v}</div><div class="k">${label}</div>${sub ? `<div class="s">${sub}</div>` : ""}</div>`;
    const tr = r.train;
    const kpis = isSft(r) ? [
      ...sftKpis(r, k),
      k(start ? `<span data-for="${start}">${dur(now() - start)}</span>` : "–", "Elapsed", lim.hard_stop_h && start ? `limit ${hm(start + lim.hard_stop_h * 3600)}` : ""),
      costKpi(r, k),
    ].join("") : trains(r) ? [
      ...trainKpis(r, k),
      t ? k(t.in_flight, "Trials in flight", `${t.finished} finished · ${t.solved} reward 1`) : "",
      engineKpi(r, att),
      k(start ? `<span data-for="${start}">${dur(now() - start)}</span>` : "–", "Elapsed", lim.hard_stop_h && start ? `limit ${hm(start + lim.hard_stop_h * 3600)}` : ""),
      costKpi(r, k),
    ].join("") : t ? [
      evalPass(r) && evalPass(r).atk != null ? k(pct(evalPass(r).atk), `pass@${evalPass(r).k}`, `pass@1 ${pct(evalPass(r).at1)} · ${evalPass(r).tasks_k} tasks`) : "",
      k(`${int(t.finished)}<small>/${int(t.expected || t.dirs)}</small>`, "Finished", t.rate_per_min && t.finished >= 10 ? `${t.rate_per_min}/min · ETA ${t.eta_min > 0 ? dur(t.eta_min * 60) : "–"}` : t.last_finish ? `last ${agoTxt(t.last_finish)}` : ""),
      k(int(t.in_flight), "In flight", `${p.agent || 0} agent · ${p.setup || 0} setup · ${p.verifying || 0} verify`),
      k(`${t.solved}<small> / ${t.with_reward || 0}</small>`, "Reward 1", t.tasks_total ? `${t.tasks_solved}/${t.tasks_total} tasks solved` : ""),
      k(mean2(t.mean_reward), "Mean reward", Object.keys(t.exceptions || {}).length ? `${Object.values(t.exceptions).reduce((a, b) => a + b, 0)} exceptions` : ""),
      engineKpi(r, att),
      k(start ? `<span data-for="${start}">${dur(now() - start)}</span>` : "–", "Elapsed", lim.hard_stop_h && start ? `hard stop ${hm(start + lim.hard_stop_h * 3600)}` : ""),
      costKpi(r, k),
    ].join("") : appKpis(r, att, su, start, k);
    const lastEv = S.events.filter(e => e.run_id === r.run_id).slice(-1)[0];
    return `<div class="runcard typed t-${typeOf(r)}" data-key="card-${esc(r.key)}">
      <div class="runcard-head"><div>
        <div class="runcard-title"><span class="dot t-${r.tone}"></span><a href="#tab=runs&run=${encodeURIComponent(r.key)}">${esc(r.run_id)}</a> <span class="muted" style="font-weight:400">· ${esc(r.status)}</span></div>
        <div class="sub">${esc(reg.title || "")}</div></div>
        <div class="row">${tpill(typeOf(r))}${reg.gpu ? `<span class="chip">${esc(gpuLabel(r))}</span>` : ""}${n ? `<span class="chip">attempt ${n}</span>` : ""}${linksHTML(r)}</div></div>
      ${trains(r) || t ? stepper(su, r) : ""}
      <div class="kpis">${kpis}</div>
      ${nodeStateLine(r)}
      ${t ? bar(t, "100%") + barKey(t) : ""}
      ${signalsHTML(r.signals, "card")}
      <div class="foot">${watchdogLine(r.run_id)}<span>trials scanned ${ago(S.updated.runs)}</span>${lastEv ? `<span>latest: ${esc(lastEv.text.slice(0, 90))} · ${ago(lastEv.t)}</span>` : ""}</div>
    </div>`;
  }
  function feedHTML(events, opts = {}) {
    let ev = [...events].reverse();
    if (ui.feedProblems && !opts.noFilter) ev = ev.filter(e => e.level === "bad" || e.level === "warn");
    if (!ev.length) return `<div class="muted small">Nothing yet.</div>`;
    const fid = opts.id || "feed", n = ui.feedN[fid] || opts.n || 12, total = ev.length;
    // consecutive events with the same text collapse into one row: "x solved (reward 1) ×6 · 16-21m"
    const rows = [];
    for (const e of ev) {
      const base = e.text.replace(/ in \d+m$/, ""), mins = (/ in (\d+)m$/.exec(e.text) || [])[1], prev = rows[rows.length - 1];
      if (prev && prev.base === base && prev.e.run_id === e.run_id && prev.e.level === e.level) { prev.n++; if (mins) prev.m.push(+mins); continue; }
      rows.push({ e, base, n: 1, m: mins ? [+mins] : [] });
    }
    const shown = rows.slice(0, n);
    const oneRun = opts.noRun || new Set(S.runs.filter(isLiveRun).map(r => r.run_id)).size <= 1 && new Set(shown.map(x => x.e.run_id)).size <= 1;
    const txt = x => x.n === 1 ? esc(x.e.text) : `${esc(x.base)} <b>×${x.n}</b>${x.m.length ? ` · ${Math.min(...x.m)}${Math.max(...x.m) !== Math.min(...x.m) ? "–" + Math.max(...x.m) : ""}m` : ""}`;
    const attN = e => { const r = S.runs.find(x => x.run_id === e.run_id), as = (r && r.attempts) || []; const i = as.findIndex(a => a.app_id === e.app_id); return as.length > 1 && i >= 0 ? ` #${i + 1}` : ""; };
    return `<ul class="feed">${shown.map(({ e, ...x }) => `<li data-key="ev-${esc(e.key)}"><span class="when" title="${fmt(e.t)}">${now() - e.t < 86400 ? PT.hm.format(e.t * 1000) : PT.md.format(e.t * 1000)}</span><span class="lv ${LEVEL[e.level] || "info"}"></span>
      <span>${txt({ e, ...x })}${oneRun ? (attN(e) ? ` <span class="run">· attempt${attN(e)}</span>` : "") : ` <span class="run">· ${esc(e.run_id)}${attN(e)}</span>`}</span></li>`).join("")}</ul>
      <div class="tfoot"><span class="muted small">${rows.length > n ? `${n} of ${rows.length}` : ""}</span>${rows.length > n ? `<button onclick="MON.feedMore('${fid}', ${n + 25})">show 25 more</button>` : n > (opts.n || 12) ? `<button onclick="MON.feedMore('${fid}', 0)">show fewer</button>` : ""}</div>`;
  }
  /* Two or more live runs (an A/B): one table, a column per run, so they read side by side. */
  function compareLive(live) {
    const rows = [
      ["Stage", r => { const su = S.startup[r.run_id]; return su ? esc((su.stages.find(([x]) => x === su.stage) || [, su.stage])[1]) : "–"; }],
      ["Since launch", r => { const a = latest(r), t0 = a && tsOf(a.started_at); return t0 ? `<span data-for="${t0}">${dur(now() - t0)}</span>` : "–"; }],
      ["Trials finished", r => r.trials ? `<b>${r.trials.finished}</b> / ${r.trials.expected || r.trials.dirs}` : "–"],
      ["In flight", r => r.trials ? r.trials.in_flight : "–"],
      ["Reward 1", r => r.trials ? `<b>${r.trials.solved}</b>${r.trials.tasks_total ? ` · ${r.trials.tasks_solved}/${r.trials.tasks_total} tasks` : ""}` : "–"],
      ["Mean reward", r => r.trials && r.trials.mean_reward != null ? num(r.trials.mean_reward) : "–"],
      ["Exceptions", r => r.trials ? Object.values(r.trials.exceptions || {}).reduce((a, b) => a + b, 0) : "–"],
      ["Finished / min (30 m)", r => r.trials && r.trials.rate_per_min ? r.trials.rate_per_min : "–"],
      ["Engine tok/s", r => { const d = ((latest(r) || {}).log || {}).decode; return d ? `${Math.round(d[2]).toLocaleString()} <span class="muted small">${ago(d[0])}</span>` : "–"; }],
      ["Running requests", r => { const d = ((latest(r) || {}).log || {}).decode; return d ? `${d[1]}${d[3] > 1 ? ` <span class="muted small">over ${d[3]} engines</span>` : ""}` : "–"; }],
      ["Live sandboxes", r => (r.links || {}).sail ? r.links.sail.live : (r.links || {}).modal_sandboxes ? r.links.modal_sandboxes.tasks : "–"],
      ["Modal cost", r => r.cost ? `${costNow(r.cost)}${r.cost.last_hour ? ` · ${usd(r.cost.last_hour)}/h` : ""}` : "–"],
      ["Problems", r => { const p = (r.signals || []).filter(x => x.level === "bad" || x.level === "warn"); return p.length ? `<span class="err">${p.map(x => esc(x.text)).join("<br>")}</span>` : `<span class="muted">none</span>`; }],
    ];
    live = [...live].sort((a, b) => a.run_id < b.run_id ? -1 : 1);
    return `<div class="panel" data-key="compare-live"><h2>Side by side <span class="muted" style="font-weight:400">${live.length} live runs</span></h2>
      <div class="scroll"><table><thead><tr><th></th>${live.map(r => `<th><a href="#tab=runs&run=${encodeURIComponent(r.key)}">${esc(r.run_id)}</a><div class="muted small" style="font-weight:400">${esc((r.registry || {}).title || "")}</div></th>`).join("")}</tr></thead>
      <tbody>${rows.map(([l, f]) => `<tr data-key="cmp-${esc(l)}"><td class="muted small nowrap">${l}</td>${live.map(r => `<td data-flash>${f(r)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></div>`;
  }
  function renderNow() {
    const live = S.runs.filter(isLiveRun);
    const recent = S.runs.filter(r => !isLiveRun(r) && typeOf(r) !== "other").slice(0, 6);
    const left = live.length ? `${live.length > 1 ? compareLive(live) : ""}<div class="live-grid">${live.map(runCard).join("")}</div>` :
      `<div class="panel empty">No training or eval run live${((S.gpus || {}).totals || {}).gpus ? ` · <a href="#tab=gpus">${S.gpus.totals.gpus} GPUs held by other apps →</a>` : ""}.${recent[0] ? ` Last run: <a href="#tab=runs&run=${encodeURIComponent(recent[0].key)}">${esc(recent[0].run_id)}</a> (${esc(recent[0].status)}).` : ""}</div>`;
    const feed = `<div class="panel"><div class="spread"><h2>What happened</h2>
        <button class="toggle ${ui.feedProblems ? "on" : ""}" onclick="MON.toggle('feedProblems')">problems only</button></div>${feedHTML(S.events)}</div>`;
    const hist = `<div class="panel"><div class="spread"><h2>Recent runs</h2><a href="#tab=runs">all runs by group →</a></div>
      <table class="recent">${runsColgroup(true)}${runsThead(true)}<tbody>${recent.map(r => runRow(r, { noSel: true, pill: true })).join("")}</tbody></table></div>`;
    return `<div class="two-col"><div>${left}${hist}</div><div>${feed}</div></div>`;
  }

  // ---- Runs: every run, in groups ----------------------------------------------------------------------------
  // the server owns a run's group and type (monitor/groups.json); these are only their labels and colours
  const TYPES = { train: ["RL training", "RL"], sft: ["SFT", "SFT"], eval: ["Evals", "Eval"], bench: ["Benchmarks", "Bench"], smoke: ["Smokes and probes", "Smoke"], other: ["Folders", "Folder"] };
  const typeOf = r => r.type || "other";
  // the run trains: its type says so, or it logs trainer steps and is not an eval (an eval launched through the
  // training launcher with --debug-rollout-only logs an empty trainer too)
  const trains = r => { const ty = typeOf(r); return ty === "train" || ty === "sft" || (!!r.train && ty !== "eval" && ty !== "bench"); };
  /* "1x None:8" in older manifests means the GPU type wasn't recorded: say "8 GPUs" (or the type a bench summary names). */
  const gpuLabel = r => { const g = (r.registry || {}).gpu; if (!g) return ""; const m = /^(\d+)x None:(\d+)$/.exec(g), e = EV[r.run_id];
    return m ? (e && e.gpu ? `${m[1]}x ${e.gpu}:${m[2]}` : `${+m[1] * +m[2]} GPUs`) : g; };
  const tpill = t => `<span class="tpill t-${t}">${TYPES[t] ? TYPES[t][1] : esc(t)}</span>`;
  const started = r => (latest(r) && tsOf(latest(r).started_at)) || (r.trials && r.trials.first_start) || null;
  function endedAt(r) {
    const a = latest(r), steps = stepsOf(r);
    const e = EV[r.run_id], evs = S.events.filter(x => x.run_id === r.run_id);
    // else the bench's own end time, else the run's last event (e.g. "GPU app ... stopped")
    return (a && tsOf(a.stopped_at)) || Math.max((r.trials || {}).last_finish || 0, steps.length ? steps[steps.length - 1].t : 0, (e && e.ended) || 0, evs.length ? evs[evs.length - 1].t : 0) || null;
  }
  const runDur = r => { const a = started(r), b = isLiveRun(r) ? now() : endedAt(r); return a && b && b > a ? b - a : null; };
  const statusHTML = (r, short) => `<span class="nowrap" title="${esc(r.status)}"><span class="dot t-${r.tone}"></span>${esc(short ? r.status.split(",")[0] : r.status)}</span>`;
  const shortTitle = r => ((r.registry || {}).title || "").replace(new RegExp("^" + r.run_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":\\s*"), "");
  /* A reward sparkline over the steps: the row's shape at a glance. */
  function sparkSVG(vals, w = 56, h = 16) {
    const v = vals.filter(x => x != null);
    if (v.length < 2) return "";
    const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
    const pts = v.map((y, i) => `${(1 + (w - 2) * i / (v.length - 1)).toFixed(1)},${(h - 2 - (h - 4) * (y - lo) / span).toFixed(1)}`).join(" ");
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="vertical-align:-3px;margin-right:6px" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
  }
  // script evals and benches keep their result in summary.json on the volume; fetched on demand, a few at a time
  const EV = {}, evQueue = [];
  let evBusy = 0;
  function evalOf(rid) {
    if (!(rid in EV)) { EV[rid] = undefined; evQueue.push(rid); pumpEval(); }
    return EV[rid];
  }
  function pumpEval() {
    while (evBusy < 4 && evQueue.length) {
      const rid = evQueue.shift(); evBusy++;
      fetch("api/eval?run=" + encodeURIComponent(rid)).then(r => r.json()).then(d => { EV[rid] = d || null; }, () => { EV[rid] = null; })
        .finally(() => { evBusy--; schedule(); pumpEval(); });
    }
  }
  /* What a run produced, in one short line, by type: reward over steps, trial score, or the eval/bench headline. */
  function resultHTML(r) {
    if (isSft(r)) {
      const st = stepsOf(r).filter(s => s.loss != null), vals = (r.train || {}).vals || [], v = vals[vals.length - 1];
      const ev = (r.evals || []).filter(e => e.pass && e.pass.atk != null).slice(-1)[0];
      if (!st.length && !v) return `<span class="muted small">–</span>`;
      return `${sparkSVG(st.map(s => s.loss))}${v ? `<b>${loss4(v[1])}</b> <span class="muted small">val NLL` : `<b>${loss4(lossTail(st))}</b> <span class="muted small">loss`} · ${plural(stepsOf(r).length, "step")}${ev ? ` · pass@${ev.pass.k} ${(100 * ev.pass.atk).toFixed(1)}%` : ""}</span>`;
    }
    const steps = stepsOf(r).filter(s => s.raw_reward != null), t = r.trials;
    if (steps.length) {
      const a = steps[0], z = steps[steps.length - 1];
      return `${sparkSVG(steps.map(s => s.raw_reward))}<b>${mean2(z.raw_reward)}</b> <span class="muted small">reward${steps.length > 1 ? ` · from ${mean2(a.raw_reward)}` : ""} · ${plural(stepsOf(r).length, "step")}</span>`;
    }
    if (t && t.with_reward && r.pass && r.pass.k > 1 && r.pass.atk != null) {
      const p = r.pass;
      return `<span class="res-bar" title="pass@${p.k}"><i style="width:${(100 * Math.min(1, p.atk)).toFixed(0)}%"></i></span><b>${(100 * p.atk).toFixed(1)}%</b> <span class="muted small">pass@${p.k} · pass@1 ${(100 * p.at1).toFixed(1)}% · ${p.tasks_k} tasks</span>`;
    }
    if (t && t.with_reward) {
      const m = t.mean_reward || 0;
      return `<span class="res-bar" title="mean reward ${mean2(m)}"><i style="width:${(100 * Math.min(1, m)).toFixed(0)}%"></i></span><b>${mean2(m)}</b> <span class="muted small">mean · ${t.tasks_total ? `${t.tasks_solved}/${t.tasks_total} tasks solved` : `${int(t.solved)} solved`}</span>`;
    }
    if (typeOf(r) === "eval" || typeOf(r) === "bench") {
      const e = evalOf(r.run_id);
      if (e === undefined) return `<span class="muted small">…</span>`;
      const h = e && window.Pages.evalHeadline(e);
      if (h) return `${h.bar != null ? `<span class="res-bar"><i style="width:${(100 * h.bar).toFixed(0)}%;background:var(--t-${typeOf(r)})"></i></span>` : ""}<b>${esc(h.value)}</b> <span class="muted small">${esc(h.label)}</span>`;
    }
    return `<span class="muted small">–</span>`;
  }
  function runRow(r, o = {}) {
    const on = ui.cmp.includes(r.key), t = typeOf(r), first = ui.cmp.length ? runByKey(ui.cmp[0]) : null, other = first && first.group !== r.group;
    return `<tr data-key="rr-${esc(r.key)}" class="click" onclick="go('runs','${esc(r.key)}')">
      ${o.noSel ? "" : `<td class="rt-sel" onclick="event.stopPropagation()"><input type="checkbox" class="cb" data-k="${esc(r.key)}" title="${other ? "compare runs within one group; ticking this starts a new pick" : "pick for comparison"}" ${on ? "checked" : ""} ${other ? 'style="opacity:.35"' : ""} onchange="MON.pick('${esc(r.key)}')"></td>`}
      <td class="rt-status">${statusHTML(r, true)}</td>
      <td><b>${esc(r.run_id)}</b>${o.pill ? " " + tpill(t) : ""}${(r.attempts || []).length > 1 ? ` <span class="muted small nowrap">· ${r.attempts.length} attempts</span>` : ""}<div class="rt-title" title="${esc(shortTitle(r))}">${esc(shortTitle(r))}</div></td>
      <td class="rt-res">${resultHTML(r)}</td>
      ${o.noSel ? "" : `<td class="rt-dur small muted">${dur(runDur(r))}</td><td class="rt-cost num small">${r.cost ? costNow(r.cost) : ""}</td>`}
      <td class="rt-start small muted">${fmt(started(r))}</td></tr>`;
  }
  const runsColgroup = noSel => `<colgroup>${noSel ? "" : `<col class="rt-sel">`}<col class="rt-status"><col><col class="rt-res">${noSel ? "" : `<col class="rt-dur"><col class="rt-cost">`}<col class="rt-start"></colgroup>`;
  const runsThead = noSel => `<thead><tr>${noSel ? "" : "<th></th>"}<th>Status</th><th>Run</th><th>Result</th>${noSel ? "" : `<th>Ran</th><th class="num">Cost</th>`}<th>Started</th></tr></thead>`;
  function groupsOf(runs) {
    const by = new Map();
    for (const r of runs) { const g = r.group || r.run_id; if (!by.has(g)) by.set(g, []); by.get(g).push(r); }
    return [...by.entries()].map(([name, rs]) => ({ name, runs: rs, type: typeOf(rs[0]), t: Math.max(...rs.map(x => x.sort_t || 0)), live: rs.some(isLiveRun) }))
      .sort((a, b) => b.live - a.live || b.t - a.t);
  }
  /* The best result in a group, for its header: highest last-step reward, else highest trial mean. */
  function groupBest(g) {
    if (g.type === "sft") {  // lowest last validation NLL
      let b = null;
      for (const r of g.runs) { const v = ((r.train || {}).vals || []).slice(-1)[0]; if (v && (!b || v[1] < b.v)) b = { v: v[1], r }; }
      return b ? `best val NLL <b>${loss4(b.v)}</b> · ${esc(b.r.run_id)}` : "";
    }
    let best = null;
    for (const r of g.runs) {
      const st = stepsOf(r).filter(s => s.raw_reward != null), v = st.length ? st[st.length - 1].raw_reward : r.trials && r.trials.with_reward ? r.trials.mean_reward : null;
      if (v != null && (!best || v > best.v)) best = { v, r, what: st.length ? "last-step reward" : "mean reward" };
    }
    return best ? `best ${best.what} <b>${mean2(best.v)}</b> · ${esc(best.r.run_id)}` : "";
  }
  function groupHTML(g, q) {
    const fid = "grp-" + g.name, recent = now() - g.t < 3 * 86400;
    const open = q ? true : FOLD[fid] ?? (g.live || recent);
    const cost = g.runs.reduce((a, r) => a + (r.cost ? r.cost.estimate || r.cost.total || 0 : 0), 0);
    const n = ui.grpN[g.name] || 5, shown = q ? g.runs : g.runs.slice(0, n);
    const best = g.type === "train" || g.type === "sft" || g.type === "eval" ? groupBest(g) : "";
    return `<div class="grp typed t-${g.type} ${open ? "open" : ""}" data-key="${esc(fid)}">
      <div class="grp-h" onclick="MON.fold('${esc(fid).replace(/'/g, "\\'")}', ${!open})"><span class="chev">▸</span>
        <div class="grp-name">${esc(g.name)} ${tpill(g.type)}${g.live ? `<span class="muted small" style="font-weight:400"><span class="dot t-run"></span>live</span>` : ""}${best ? `<span class="grp-best">${best}</span>` : ""}</div>
        <div class="grp-meta">${plural(g.runs.length, "run")} · latest ${when(g.t)}${cost ? ` · ${usd(cost)}` : ""}</div></div>
      ${open ? `<div class="grp-body"><table>${runsColgroup()}${runsThead()}<tbody>${shown.map(r => runRow(r)).join("")}</tbody></table>
        ${g.runs.length > shown.length ? `<div class="grp-more"><button onclick="MON.grpMore('${esc(g.name).replace(/'/g, "\\'")}')">show all ${g.runs.length}</button></div>` : ""}</div>` : ""}</div>`;
  }
  function renderRuns() {
    const q = (TBL.runs && TBL.runs.q || "").toLowerCase();
    const counts = {};
    for (const r of S.runs) counts[typeOf(r)] = (counts[typeOf(r)] || 0) + 1;
    const tt = ui.runType;
    let runs = S.runs.filter(r => tt === "all" ? typeOf(r) !== "other" || ui.showOther : typeOf(r) === tt);
    if (q) runs = runs.filter(r => (r.run_id + " " + ((r.registry || {}).title || "") + " " + (r.group || "") + " " + r.status).toLowerCase().includes(q));
    const groups = groupsOf(runs);
    const seg = [["all", "All", S.runs.length - (counts.other || 0)], ...["train", "sft", "eval", "bench", "smoke"].map(k => [k, TYPES[k][0], counts[k] || 0])];
    return `<div class="runs-head"><h2 class="page-title">Runs</h2>
        <div class="seg">${seg.map(([k, l, n]) => `<button class="${tt === k ? "on" : ""}" onclick="MON.runType('${k}')">${l} <span class="muted">${n}</span></button>`).join("")}</div>
        <input type="search" placeholder="search runs" value="${esc(TBL.runs ? TBL.runs.q : "")}" oninput="MON.runsQ(this.value)">
        <span class="muted small" style="margin-left:auto">${plural(groups.length, "group")} · tick two runs to compare them</span></div>
      ${groups.length ? groups.map(g => groupHTML(g, q)).join("") : `<div class="panel muted">No runs match.</div>`}
      ${counts.other && tt === "all" ? `<p class="muted small"><button class="linkish" onclick="MON.toggle('showOther')">${ui.showOther ? "hide" : "show"} ${counts.other} result folders with no launch record</button> (dirs on the results volumes that no launch registered: early probes and scratch).</p>` : ""}`;
  }
  /* Two runs picked for comparison: a tray at the bottom of the Runs tab and run pages. */
  function trayHTML() {
    if (!ui.cmp.length) return "";
    const [a, b] = ui.cmp.map(runByKey);
    const slot = (r, c) => r ? `<span class="slot"><span class="sw ${c}"></span>${esc(r.run_id)}<button class="x" title="remove" onclick="MON.pick('${esc(r.key)}')">✕</button></span>` : `<span class="muted">tick a second run in ${esc(a.group || "the same group")}</span>`;
    return `<div class="tray" data-key="tray">${slot(a, "a")}<span class="muted">vs</span>${slot(b, "b")}
      <button class="primary" ${b ? "" : "disabled"} onclick="location.hash='${b ? compareHref(a.key, b.key) : ""}'">Compare</button><button class="linkish" onclick="MON.clearPick()">clear</button></div>`;
  }

  // ---- one run ------------------------------------------------------------------------------------------------------
  function costLine(r, id) {
    const c = r.cost && r.cost.apps[id];
    if (!c) return "";
    const res = Object.entries(c.by_resource).map(([k, v]) => `${esc(k)} ${usd(v)}`).join(" · ");
    return `<div class="muted" title="${esc(res)}">Modal cost <b>${usd(c.total)}</b>${res ? " · " + res : ""}</div>`;
  }
  function costPanel(r) {
    const c = r.cost;
    if (!c) return "";
    const sail = (r.links || {}).sail ? " Sandboxes ran on Sail, which reports no cost, so they are not included." : "";
    return section("cost", "Modal cost", `${costNow(c)} · ${costSub(c)}`, () => {
      const rows = Object.entries(c.apps).map(([id, a]) => `<tr data-key="cost-${esc(id)}"><td>${esc(a.name)}<div class="muted small mono">${esc(id)}</div></td><td class="num"><b>${usd(a.total)}</b></td>
        <td class="small">${Object.entries(a.by_resource).map(([k, v]) => `${esc(k)} ${usd(v)}`).join("<br>")}</td><td class="small">${fmt(a.first)} → ${hm(a.last)}</td></tr>`).join("");
      return `<p class="muted small">As Modal's billing report states it for this run's apps, last ${S.cost.days} days. Modal bills an hour once it is over, so a running app's bill trails by up to ~80 min; ${c.unbilled ? `the ~${usd(c.unbilled)} on top is the monitor's estimate for that time at each app's latest billed rate` : "nothing is unbilled now"}.${sail}</p>
        <div class="scroll"><table><thead><tr><th>App</th><th class="num">Cost</th><th>By resource</th><th>Billed hours (PT)</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    });
  }

  function attemptsHTML(r, extra) {
    const as = r.attempts || [];
    if (!as.length) return extra ? more("attempts", "launch details", extra) : "";
    const L = as[as.length - 1];
    const sumLine = `${plural(as.length, "attempt")}${as.length > 1 ? `, latest #${L.n} ${esc(L.app_state || "")}` : ` · ${esc(L.app_state || "app not listed")}`}${as.filter(a => (a.outcome || "").startsWith("failed")).length ? ` · ${as.filter(a => (a.outcome || "").startsWith("failed")).length} failed` : ""}`;
    return more("attempts", "launch details: " + sumLine, () => `${extra ? extra() : ""}<div class="attempts">${as.map(a => {
      const t = a.trials, live = /^ephemeral|^running/.test(a.app_state || "");
      return `<div class="attempt ${a.latest ? "latest" : ""}" data-key="att-${esc(a.app_id)}">
        <div class="h"><span>#${a.n} ${a.latest ? "<span class='muted' style='font-weight:400'>latest</span>" : ""}</span><span class="muted mono" style="font-weight:400">${esc(a.app_id.slice(-8))}</span></div>
        <div><span class="dot ${live ? "t-run" : a.outcome && a.outcome.startsWith("failed") ? "t-bad" : "t-idle"}"></span>${esc(a.app_state || "app not listed")}${a.stage ? " · " + esc(a.stage) : ""}</div>
        <div class="muted">${fmt(tsOf(a.started_at))}${a.stopped_at ? " → " + fmt(tsOf(a.stopped_at)).slice(6) : ""}</div>
        ${t ? `<div class="muted">${plural(t.dirs, "trial dir")} · ${t.finished} finished · ${t.solved} solved</div>` : ""}
        ${costLine(r, a.app_id)}
        ${a.outcome ? `<div class="err">${esc(a.outcome)}</div>` : ""}
        <div class="row" style="gap:6px;margin-top:4px">${link(a.url, "Modal ↗", "chip")}${a.log ? `<button class="toggle ${LOG.app === a.app_id ? "on" : ""}" onclick="MON.pickLog('${esc(a.app_id)}')">log</button>` : ""}</div></div>`;
    }).join("")}</div>`);
  }
  function inflightHTML(rows, reg) {
    const lim = reg.limits || {}, cap = lim.trial_secs || lim.agent_secs || null, agentCap = lim.agent_secs || null;
    const live = rows.filter(r => !["done", "error", "stale"].includes(r.phase));
    const phases = [...new Set(live.map(r => r.phase))];
    const o = { key: r => r.trial, text: r => r.trial + " " + r.phase, sort: "start", dir: 1, page: 15, toolsTo: true,
                facets: phases.length > 1 ? [["all", () => true], ...phases.map(p => [PH[p] ? PH[p][0] : p, r => r.phase === p])] : [] };
    const cols = [
      { k: "task", label: "Trial", sort: r => r.trial, cell: r => `<span class="mono small">${esc(r.task)}</span> <span class="muted small mono">${esc(r.trial.split("__").pop())}</span>` },
      { k: "phase", label: "Phase", cls: "nowrap", sort: r => r.phase, cell: r => `<i class="dot" style="background:${PH[r.phase][1]}"></i>${PH[r.phase][0]}` },
      { k: "start", label: "Running for", cls: "small nowrap", sort: r => r.start, cell: r => `<span data-for="${r.start || ""}">${dur(r.start ? now() - r.start : null)}</span>` },
      { k: "cap", label: "Of cap", cell: r => {
        const el = r.start ? now() - r.start : null, f = cap && el ? Math.min(1, el / cap) : 0;
        const color = f > 0.9 ? "var(--bad)" : f > 0.75 ? "var(--warn)" : PH[r.phase][1];
        return cap ? `<div class="cap" title="${Math.round(f * 100)}% of ${dur(cap)}"><span style="width:${(f * 100).toFixed(1)}%;background:${color}"></span>${agentCap && agentCap < cap ? `<i style="left:${(100 * agentCap / cap).toFixed(1)}%"></i>` : ""}</div>` : ""; } },
      { k: "write", label: "Last write", cls: "small", desc: true, sort: r => r.last_write, cell: r => r.last_write ? ago(r.last_write) : esc(r.error || "–") },
    ];
    const body = table("inflight", live, cols, o);
    return `<div class="panel" data-key="p-inflight"><div class="spread"><h2>In flight <span class="muted" style="font-weight:400">${live.length}</span></h2><div class="row">${tableTools("inflight", { ...o, rows: live })}</div></div>
      ${cap ? `<div class="muted small">Bar: time used of the ${dur(cap)} trial cap${agentCap && agentCap !== cap ? `, tick at the ${dur(agentCap)} agent limit` : ""}.</div>` : ""}${body}</div>`;
  }

  /* kk: an eval's k; a task's first kk trials are the counted ones, the rest (refill extras) are drawn faded. */
  function tasksHTML(t, cmp, kk) {
    const ct = cmp ? cmp.tasks : null;
    const prevCell = k => {
      const c = ct && ct[k.task];
      if (!c) return `<span class="muted">–</span>`;
      const [solved, fin] = c, better = k.solved > 0 && solved === 0, worse = k.finished && k.solved === 0 && solved > 0 && k.finished >= fin;
      return `<span style="color:${better ? "var(--good)" : worse ? "var(--bad)" : "inherit"}" title="${esc(cmp.run_id)}: ${solved} solved of ${fin} finished, mean ${c[2] ?? "–"}">${solved}/${fin}</span>`;
    };
    const tasks = t.tasks || [], ex = kk && t.extras;
    const o = { key: k => k.task, text: k => k.task, sort: "task", page: 15, toolsTo: true,
                facets: [["all", () => true], ["solved", k => (ex ? k.k_solved : k.solved) > 0], ...(ex ? [["solved only in extras", k => !k.k_solved && k.solved > 0]] : []), ["unsolved", k => k.finished && !k.solved], ["running", k => k.running > 0], ["with exceptions", k => k.errors > 0],
                         ...(ct ? [["changed vs " + cmp.run_id, k => ct[k.task] && (k.solved > 0) !== (ct[k.task][0] > 0) && k.finished]] : [])] };
    const cols = [
      { k: "task", label: "Task", cls: "small c-task", sort: k => k.task, cell: k => `<span class="mono">${esc(k.task)}</span>` },
      { k: "att", label: kk && t.extras ? "Trials (counted · extras)" : "Attempts", cell: k => `<div class="cells">${(k.cells || []).map((r, i) => {
        const extra = kk && i >= kk, c = r === "run" ? "var(--run)" : r === "x" || r === "cut" ? "var(--ink-3)" : r >= 1 ? "var(--good)" : r > 0 ? "var(--warn)" : "var(--bad)";
        return `<i title="${r === "run" ? "in flight" : r === "x" ? "no reward (exception)" : r === "cut" ? "cut off, no result" : "reward " + r}${extra ? " · refill extra, not counted" : ""}" style="background:${c}${extra ? ";opacity:.3" : ""}${kk && i === kk ? ";margin-left:6px" : ""}"></i>`; }).join("")}</div>` },
      { k: "fin", label: "Finished", cls: "num", desc: true, sort: k => k.finished, cell: k => k.finished },
      { k: "run", label: "In flight", cls: "num", desc: true, sort: k => k.running, cell: k => k.running },
      { k: "err", label: "Exceptions", cls: "num", desc: true, sort: k => k.errors, cell: k => k.errors },
      ...(ex ? [{ k: "ksolved", label: `Solved of ${kk}`, cls: "num", desc: true, sort: k => k.k_solved, cell: k => `<b>${k.k_solved}</b>/${k.k_finished}` }] : []),
      { k: "solved", label: ex ? "Reward 1, all" : "Reward 1", cls: "num", desc: true, sort: k => k.solved + (k.mean || 0) / 10, cell: k => k.solved },
      { k: "mean", label: "Mean", cls: "num", desc: true, sort: k => k.mean, cell: k => mean2(k.mean) },
      ...(ct ? [{ k: "prev", label: esc(cmp.run_id), cls: "num", desc: true, sort: k => ct[k.task] ? ct[k.task][0] : null, cell: prevCell }] : []),
    ];
    const both = ct ? tasks.filter(k => ct[k.task]) : [];
    const summary = ct ? `vs <a href="#tab=runs&run=${encodeURIComponent(cmp.key)}">${esc(cmp.run_id)}</a>: ${both.filter(k => k.solved).length} tasks solved here, ${both.filter(k => ct[k.task][0]).length} there, on the ${both.length} both ran` : "";
    const body = table("tasks", tasks, cols, o);
    return `<div class="panel" data-key="p-tasks"><div class="spread"><h2>Per task <span class="muted" style="font-weight:400">${ex ? `${tasks.filter(k => k.k_solved).length}/${t.tasks_total} solved in the counted trials` : `${t.tasks_solved}/${t.tasks_total} solved at least once`}</span></h2><div class="row">${tableTools("tasks", { ...o, rows: tasks })}</div></div>
      ${summary ? `<div class="muted small">${summary}</div>` : ""}
      <div class="barkey" style="margin:0 0 6px"><span><i style="background:var(--good)"></i>reward 1</span><span><i style="background:var(--warn)"></i>partial</span><span><i style="background:var(--bad)"></i>reward 0</span><span><i style="background:var(--run)"></i>in flight</span>${ex ? `<span><i style="background:var(--bad);opacity:.3"></i>refill extra (not counted)</span>` : ""}</div>${body}</div>`;
  }

  function finishedHTML(rows, extras) {
    const fin = rows.filter(r => ["done", "error"].includes(r.phase));
    const excs = [...new Set(fin.map(r => r.exception).filter(Boolean))];
    const o = { key: r => r.trial, text: r => r.trial + " " + (r.exception || "") + " " + (r.exception_msg || ""), sort: "finished", dir: -1, page: 15, toolsTo: true,
                facets: [["all", () => true], ...(extras ? [["counted", r => !r.extra], ["refill extras", r => r.extra]] : []), ["solved", r => (r.reward || 0) >= 1], ["reward 0", r => r.reward === 0 && !r.exception], ["exceptions", r => !!r.exception], ...excs.map(e => [e, r => r.exception === e])] };
    const cols = [
      { k: "task", label: "Trial", sort: r => r.trial, cell: r => `<span class="mono small">${esc(r.task)}</span> <span class="muted small mono">${esc(r.trial.split("__").pop())}</span>${extras && r.extra ? ` <span class="chip" title="Beyond the first k trials of this task: a refill extra, not counted">extra</span>` : ""}` },
      { k: "reward", label: "Reward", cls: "num", desc: true, sort: r => r.reward, cell: r => `<span style="color:${(r.reward || 0) >= 1 ? "var(--good)" : "inherit"}">${r.reward ?? "–"}</span>` },
      { k: "exc", label: "Exception", cls: "small", sort: r => r.exception, cell: r => `<span title="${esc(r.exception_msg)}">${esc(r.exception || "")}</span>${r.exception_msg ? `<div class="muted">${esc(r.exception_msg.slice(0, 120))}</div>` : ""}` },
      { k: "agent", label: "Agent time", cls: "small", desc: true, sort: r => r.agent_s, cell: r => dur(r.agent_s) },
      { k: "total", label: "Total", cls: "small", desc: true, sort: r => r.total_s, cell: r => dur(r.total_s) },
      { k: "finished", label: "Finished", cls: "small", desc: true, sort: r => r.finished, cell: r => `<span title="${fmt(r.finished)}">${ago(r.finished)}</span>` },
    ];
    const body = table("finished", fin, cols, o);
    return `<div class="panel" data-key="p-finished"><div class="spread"><h2>Finished <span class="muted" style="font-weight:400">${fin.length}</span></h2><div class="row">${tableTools("finished", { ...o, rows: fin })}</div></div>${body}</div>`;
  }

  function timeline(t) {
    if (!t.timeline || !t.timeline.length || !t.first_start) return "";
    const W = 760, H = 120, x0 = t.first_start, x1 = Math.max(now(), t.timeline[t.timeline.length - 1]), tot = t.expected || t.dirs;
    const X = v => 40 + (W - 50) * (v - x0) / Math.max(1, x1 - x0), Y = n => H - 20 - (H - 30) * n / Math.max(1, tot);
    const pts = t.timeline.map((v, i) => `${X(v).toFixed(1)},${Y(i + 1).toFixed(1)}`).join(" ");
    return `<h3>Finished trials over time</h3><div class="scroll"><svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px">
      <line x1="40" x2="${W - 10}" y1="${Y(tot)}" y2="${Y(tot)}" stroke="var(--line)" stroke-dasharray="3 3"/>
      <line x1="40" x2="${W - 10}" y1="${H - 20}" y2="${H - 20}" stroke="var(--line)"/>
      <polyline fill="none" stroke="var(--good)" stroke-width="2" points="40,${H - 20} ${pts}"/>
      <text x="4" y="${Y(tot) + 4}">${tot}</text><text x="4" y="${H - 16}">0</text>
      <text x="40" y="${H - 4}">${fmt(x0)}</text><text x="${W - 10}" y="${H - 4}" text-anchor="end">${fmt(x1)}</text></svg></div>`;
  }
  function logPanel(r) {
    const withLog = (r.attempts || []).filter(a => a.log);
    const gpu = ((r.links || {}).gpu_apps || [])[0];
    if (!withLog.length) {
      return section("log", "Log", "", () => `${gpu ? `<button onclick="MON.loadLogs('${esc(gpu.app_id)}')">fetch the last 400 lines from Modal</button>` : ""}
        ${ui.logsFor ? `<pre>${esc(ui.logsText)}</pre>` : `<div class="muted small">No launch log on this host for this run (it predates manifests, or its launcher didn't redirect stdout).</div>`}`);
    }
    const cats = [["stage", "stages"], ["trial", "trials"], ["error", "errors"], ["engine", "engine"], ["http", "http"], ["other", "other"]];
    const att = (r.attempts || []).find(a => a.app_id === LOG.app) || withLog.slice(-1)[0];
    return section("log", "Live log", `attempt #${att.n}`, () => `<div class="muted small mono">${esc(att.log_path || "")}</div><div class="spread"><span></span>
      <div class="filters">${cats.map(([k, l]) => `<button class="toggle ${ui.logCats.has(k) ? "on" : ""}" onclick="MON.logCat('${k}')">${l}</button>`).join("")}
      <input type="search" placeholder="filter lines" value="${esc(ui.logQuery)}" oninput="MON.logQuery(this.value)" style="min-width:160px">
      <button class="toggle ${ui.follow ? "on" : ""}" onclick="MON.toggle('follow'); MON.repaintLog()">follow</button></div></div>
      <div class="logpane" id="logpane" data-keep="log-${esc(att.app_id)}"></div>
      <div class="muted small" style="margin-top:6px">Streamed from the launch log on the host as lines arrive. Retry and keep-alive noise is dropped; secrets are redacted.</div>`);
  }
  function limitsTxt(l) {
    const name = { agent_secs: "agent", trial_secs: "trial", verifier_secs: "verifier", turns: "turns", context: "context", hard_stop_h: "hard stop" };
    return Object.entries(l).map(([k, v]) => `${esc(name[k] || k.replace(/_/g, " "))} ${/secs$/.test(k) ? dur(v) : k === "hard_stop_h" ? v + " h" :
      k === "context" && v >= 1e6 ? (v / 1048576).toFixed(0) + "M tokens" : k === "context" ? Math.round(v / 1024) + "k tokens" : esc(v)}`).join(" · ");
  }
  function renderDetail() {
    const r = detail || runByKey(route.run);
    if (!r) return `<div class="panel">${loaded ? "Run not found." : "loading…"} <a href="#tab=runs">← all runs</a></div>`;
    const sum = runByKey(route.run) || r;  // the summary (status, signals, links, group, type) from the runs topic
    const reg = sum.registry || {}, t = r.trials, rows = r.rows || [], su = S.startup[r.run_id];
    const type = typeOf(sum), isTrain = trains(sum), live = isLiveRun(sum), pk = !isTrain && t && evalPass(sum);
    const ev = !isTrain && !pk && (type === "eval" || type === "bench") ? evalOf(r.run_id) : null;
    const peers = S.runs.filter(x => x.group && x.group === sum.group && x.key !== sum.key);
    const jumps = [];
    const J = (k, label) => { jumps.push([k, label]); return ""; };
    // what the run produced, first: by type
    const hl = (v, k, s) => `<div><div class="hv">${v}</div><div class="hk">${k}</div>${s ? `<div class="hs">${s}</div>` : ""}</div>`;
    const steps = stepsOf(sum), lastS = steps[steps.length - 1], tr = sum.train || {};
    let head = "";
    const vals = tr.vals || [], v0 = vals[0], v1 = vals[vals.length - 1], bestEv = (sum.evals || []).filter(e => e.pass && e.pass.atk != null).slice(-1)[0];
    if (isSft(sum)) head = [
      hl(`${lastS ? lastS.n + 1 : 0}<small class="muted">/${tr.expected_steps || reg.expected_steps || "?"}</small>`, "Steps done", ""),
      hl(loss4(lossTail(steps)), "Train loss", steps.length > 10 && steps[0].loss != null ? `last 10 · step 0: ${loss4(steps[0].loss)} ${sparkSVG(steps.map(s => s.loss), 64, 14)}` : ""),
      hl(v1 ? loss4(v1[1]) : "–", "Val NLL", v0 && v0 !== v1 ? `${v0[0] ? "step " + v0[0] : "before training"}: ${loss4(v0[1])}` : ""),
      bestEv ? hl(`${(100 * bestEv.pass.atk).toFixed(1)}%`, `pass@${bestEv.pass.k}`, esc(`${bestEv.label || (bestEv.step != null ? "step " + bestEv.step : "")} · ${bestEv.run_id}`)) : "",
    ].join("");
    else if (isTrain) head = [
      hl(`${lastS ? lastS.n + 1 : 0}<small class="muted">/${tr.expected_steps || reg.expected_steps || "?"}</small>`, "Steps done", tr.training_now ? "training now" : ""),
      hl(lastS && lastS.raw_reward != null ? mean2(lastS.raw_reward) : "–", "Reward, last step", steps.length > 1 && steps[0].raw_reward != null ? `step ${steps[0].n}: ${mean2(steps[0].raw_reward)} ${sparkSVG(steps.map(s => s.raw_reward), 64, 14)}` : ""),
    ].join("");
    else if (pk) head = [
      pk.k > 1 ? hl(pct(pk.atk), `pass@${pk.k}`, `${pk.tasks_k} tasks${pk.tasks_k < pk.tasks ? ` of ${pk.tasks}` : ""}`) : "",
      hl(pct(pk.at1), "pass@1", `mean over ${pk.k > 1 ? `each task's ${pk.k} trials` : "tasks"}`),
      hl(`${pk.tasks_solved}<small class="muted">/${pk.tasks}</small>`, "Tasks solved", pk.k > 1 ? `in at least 1 of ${pk.k} trials` : ""),
    ].join("");
    else if (ev) { const h = window.Pages.evalHeadline(ev); if (h) head = hl(esc(h.value), esc(h.label), h.sub ? esc(h.sub) : ""); }
    else if (t && t.with_reward) head = hl(mean2(t.mean_reward), "Mean reward", `${int(t.solved)} of ${int(t.with_reward)} trials reward 1${t.tasks_total ? ` · ${t.tasks_solved}/${t.tasks_total} tasks solved` : ""}`);
    head += hl(`<span ${live ? `data-for="${started(sum) || ""}"` : ""}>${dur(runDur(sum))}</span>`, live ? "Running for" : "Ran for", fmt(started(sum)));
    head += hl(sum.cost ? `<span title="${esc(costTitle(sum.cost))}">${costNow(sum.cost)}</span>` : "–", "Modal cost", sum.cost ? costSub(sum.cost) : live ? "nothing billed yet" : `not in Modal's ${S.cost && S.cost.days ? S.cost.days + "-day " : ""}billing report`);
    let h = `<div class="panel typed t-${type}" data-key="p-head"><div class="run-head-top"><a href="#tab=runs">← runs</a><h2>${esc(r.run_id)}</h2>${tpill(type)}<span>${statusHTML(sum)}</span>
        ${sum.group ? `<span class="muted small">in <a href="#tab=runs" onclick="MON.openGroup('${esc(sum.group).replace(/'/g, "\\'")}')">${esc(sum.group)}</a></span>` : ""}
        <span style="margin-left:auto"></span>${peers.length ? `<select onchange="if(this.value)location.hash=this.value" title="compare this run with another run of its group"><option value="">Compare with…</option>${peers.map(p => `<option value="${esc(compareHref(sum.key, p.key))}">${esc(p.run_id)}</option>`).join("")}</select>` : ""}</div>
      <p style="margin:8px 0 4px">${esc(reg.title || "")}</p>${reg.notes ? `<p class="muted small" style="margin:0 0 6px">${esc(reg.notes)}</p>` : ""}
      <div class="headline">${head}</div>
      <div class="row" style="margin-top:8px">${reg.gpu ? `<span class="chip">${esc(gpuLabel(sum || r))}</span>` : ""}<span class="chip">${esc(r.volume)}/${esc(r.run_id)}</span>${linksHTML(sum, { all: true, noSail: !live })}</div>
      ${su && live && (isTrain || t) ? `<div style="margin-top:10px">${stepper(su, sum)}</div>` : ""}
      ${signalsHTML(sum.signals, "detail")}
      ${attemptsHTML(sum, () => `${su && !(live && (isTrain || t)) ? `<div style="margin:6px 0 8px">${stepper(su, sum)}</div>` : ""}${reg.limits ? `<div class="muted small">limits: ${limitsTxt(reg.limits)}</div>` : ""}${su && su.last ? `<div class="muted small mono" style="margin-top:6px;word-break:break-all">last startup line: ${esc(su.last.slice(0, 260))}</div>` : ""}`)}
      ${S.watchdogs[r.run_id] ? `<div class="foot">${watchdogLine(r.run_id)}</div>` : ""}
      <div class="jump" data-key="jump">@@JUMP@@</div></div>`;
    let body = "";
    if (isSft(sum)) body += J("p-train", "SFT") + sftPanel(sum);
    else if (isTrain) { body += J("p-train", "Training") + trainPanel(sum); }
    if (!isTrain && !pk && (type === "eval" || type === "bench") && !(ev === null && t)) body += J("p-results", "Results") + window.Pages.evalResults(ev, sum);
    if (pk) body += J("p-results", "Results") + evalPanel(sum, pk);
    if (t && !isTrain) body += J("p-tasks", "Per task") + tasksHTML(t, r.compare, pk && pk.k);
    if (t && !isTrain) { const p = phaseTimeline(sum, rows, su, false); if (p) body += J("p-phases", "Phases") + p; }
    const curves = J("curves", "Curves") + `<div id="curves" class="panel" data-key="curves" data-keep="curves-${esc(r.run_id)}"></div>`;
    if (isTrain) body += curves;
    if (isTrain && !isSft(sum)) { const p = phaseTimeline(sum, rows, su, isTrain); if (p) body += J("p-phases", "Phases") + p; }
    if (t && sum.train) { const ts = taskStepsHTML(sum, rows); if (ts) body += J("sec-task-steps", "Per task over steps") + ts; }
    if (t) {
      const p = t.phases, tile = (v, k, sub) => `<div class="tile"><div class="v" data-flash>${v ?? "–"}</div><div class="k">${k}</div><div class="s">${sub || "&nbsp;"}</div></div>`;
      const nexc = Object.values(t.exceptions).reduce((a, b) => a + b, 0);
      body += J("p-progress", "Trials") + `<div class="panel" data-key="p-progress"><h2>Trials <span class="muted" style="font-weight:400">${int(t.finished)} finished${t.in_flight ? ` · ${t.in_flight} in flight` : ""}</span></h2>${bar(t, "100%")}${barKey(t)}<div style="height:12px"></div>
        <div class="tiles">${tile(int(t.finished), "Finished", pk && t.extras ? `<span title="Trials past each task's first ${pk.k}: not counted">${int(t.finished - t.extras)} counted + ${int(t.extras)} refill extras</span>` : t.expected && t.finished > t.expected ? `<span title="Groups the filter drops are refilled with new tries">plan ${int(t.expected)} + refills</span>` : `of ${int(t.expected || t.dirs)}`)}${tile(int(t.in_flight), "In flight", `${p.agent || 0} agent · ${p.setup || 0} setup`)}${tile(int(t.solved), "Reward 1", `of ${int(t.with_reward || 0)} scored`)}${tile(mean2(t.mean_reward), "Mean reward", `${int(t.nonzero)} above 0`)}
        ${live ? tile(t.rate_per_min ?? "–", "Per min", "30 min avg") + tile(t.eta_min > 0 ? dur(t.eta_min * 60) : "–", "ETA", "at that rate") : ""}</div>
        <p class="muted small">${sum.cost && sum.cost.total && t.finished ? `${usd((sum.cost.estimate || sum.cost.total) / t.finished)} per finished trial · ` : ""}First trial ${fmt(t.first_start)} · last finish ${t.last_finish ? ago(t.last_finish) : "–"} · scanned ${ago(S.updated.runs)}</p>
        ${more("progress-more", `breakdown${nexc ? `, ${plural(nexc, "exception")}` : ""}, finishes over time`, () => `
          <div class="tiles">${tile(t.not_started ?? "–", "Not started")}${tile(p.setup || 0, "Setting up")}${tile(p.agent || 0, "Agent running")}${tile(p.verifying || 0, "Verifying")}${p.stale ? tile(p.stale, "Cut off") : ""}${tile(p.error || 0, "Exception")}${tile(t.nonzero, "Reward > 0")}</div>
          ${nexc ? `<h3>Exceptions</h3>${Object.entries(t.exceptions).map(([k, v]) => `<span class="chip">${esc(k)} × ${v}</span>`).join("")}` : ""}
          ${timeline(t)}`)}</div>`;
    }
    if (t && !isTrain) body += finishedHTML(rows, !!(pk && t.extras));
    if (!isTrain) body += curves;
    if (rows.length && live) body += J("p-inflight", "In flight") + inflightHTML(rows, reg);
    if (t && isTrain) body += section("trial-lists", "Per task and finished trials", `${t.tasks_total || 0} tasks · ${int(t.finished)} finished`, () => tasksHTML(t, r.compare) + finishedHTML(rows), { open: live });
    const evs = (r.events || S.events.filter(e => e.run_id === r.run_id)), lastEv = evs[evs.length - 1];
    body += J("sec-happened", "What happened") + section("happened", "What happened", lastEv ? `${evs.length} events · latest ${hm(lastEv.t)}: ${esc(lastEv.text.slice(0, 90))}` : "nothing yet",
                 () => feedHTML(evs, { noRun: true, noFilter: true, n: 8, id: "detail" }), { open: live });
    const cp = costPanel(sum); if (cp) body += J("sec-cost", "Cost") + cp;
    body += J("sec-log", "Log") + logPanel(sum);
    return h.replace("@@JUMP@@", jumps.map(([k, l]) => `<a onclick="MON.jump('${k}')">${l}</a>`).join("")) + body;
  }

  // ---- live log pane -------------------------------------------------------------------------------------------
  function appendLog(m) {
    if (m.reset || LOG.app !== m.app) { LOG.app = m.app; LOG.lines = []; }
    LOG.lines.push(...m.lines);
    if (LOG.lines.length > LOG.max) LOG.lines.splice(0, LOG.lines.length - LOG.max);
    const pane = document.getElementById("logpane");
    if (!pane) return;
    if (m.reset) paintLog(pane); else addLines(pane, m.lines, true);
  }
  const logOk = l => ui.logCats.has(l[2]) && (!ui.logQuery || l[3].toLowerCase().includes(ui.logQuery.toLowerCase()));
  function lineEl(l, fresh) {
    const d = document.createElement("div");
    d.className = "c-" + l[2] + (fresh ? " new" : "");
    d.innerHTML = `<span class="ts">${hms(l[1])}</span>${esc(l[3])}`;
    return d;
  }
  function addLines(pane, lines, fresh) {
    const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
    const frag = document.createDocumentFragment();
    for (const l of lines) if (logOk(l)) frag.appendChild(lineEl(l, fresh));
    pane.appendChild(frag);
    while (pane.childNodes.length > 1500) pane.removeChild(pane.firstChild);
    if (ui.follow && (atBottom || !fresh)) pane.scrollTop = pane.scrollHeight;
  }
  function paintLog(pane) {
    pane = pane || document.getElementById("logpane");
    if (!pane) return;
    pane.innerHTML = "";
    const lines = LOG.lines.filter(logOk).slice(-1500);
    if (!lines.length) pane.innerHTML = `<div class="c-engine">${LOG.lines.length ? "no lines match the filters" : "waiting for lines…"}</div>`;
    addLines(pane, lines, false);
    pane.scrollTop = pane.scrollHeight;
  }

  // ---- other tabs --------------------------------------------------------------------------------------------
  const isLiveApp = a => /^(ephemeral|running)/.test(a.state) || (a.state.startsWith("deployed") && a.tasks > 0);
  function appCost(id) {
    const c = ((S.cost || {}).apps || {})[id];
    return c ? `<span title="${esc(Object.entries(c.by_resource).map(([k, v]) => k + " " + usd(v)).join(", "))}">${usd(c.total)}</span>` : "";
  }
  function renderApps() {
    const recentish = a => !a.state.startsWith("stopped") && (!a.state.startsWith("deployed") || a.tasks > 0 || now() - tsOf(a.created_at) < 3 * 86400);
    const cost = id => (((S.cost || {}).apps || {})[id] || {}).total;
    const o = { key: a => a.app_id, text: a => a.name + " " + a.app_id + " " + a.state, sort: "created", dir: -1, page: 25, toolsTo: true,
                facets: [["active", recentish], ["live", isLiveApp], ["billed this week", a => cost(a.app_id) != null], ["all", () => true]] };
    const cols = [
      { k: "name", label: "App", sort: a => a.name, cell: a => `<span class="dot ${isLiveApp(a) ? "t-run" : "t-idle"}"></span>${link(a.url, a.name)}<div class="muted small mono">${esc(a.app_id)}</div>` },
      { k: "state", label: "State", sort: a => a.state, cell: a => esc(a.state) },
      { k: "tasks", label: "Containers", cls: "num", desc: true, sort: a => a.tasks, cell: a => a.tasks },
      { k: "cost", label: "Cost, 7 d", cls: "num", desc: true, sort: a => cost(a.app_id), cell: a => appCost(a.app_id) },
      { k: "created", label: "Created", cls: "small", desc: true, sort: a => tsOf(a.created_at), cell: a => esc(fmt(tsOf(a.created_at))) },
      { k: "stopped", label: "Stopped", cls: "small", desc: true, sort: a => tsOf(a.stopped_at), cell: a => esc(a.stopped_at ? fmt(tsOf(a.stopped_at)) : "") },
      { k: "log", label: "", cell: a => `<button onclick="MON.loadLogs('${esc(a.app_id)}')">log tail</button>` },
    ];
    const body = table("apps", S.apps, cols, o);
    return `<div class="panel"><div class="spread"><h2>Our Modal apps</h2><div class="row">${tableTools("apps", { ...o, rows: S.apps })}</div></div>
      <p class="muted small">Workspace ${esc((S.meta || {}).modal_workspace || "")}, environment ${esc(meta().modal_environments.join(", "))}, names ${esc(prefixes())} only. Listed ${ago(S.updated["modal apps"])}.
        ${S.cost && S.cost.through ? `Cost as Modal bills it: ${usd(S.cost.today)} today (PT), ${usd(S.cost.total)} over ${S.cost.days} days for these names; ${billedNote().replace("Modal bills hourly; b", "b")}.` : ""}</p>
      ${body}</div>${ui.logsFor ? `<div class="panel"><div class="spread"><h2>Log tail ${esc(ui.logsFor)}</h2><button onclick="MON.set('logsFor', null)">close</button></div><pre>${esc(ui.logsText)}</pre></div>` : ""}`;
  }

  function renderSail() {
    const apps = Object.values(S.sail);
    const o = { key: a => a.name, text: a => a.name, sort: "live", dir: -1, page: 25, toolsTo: true, facets: [["all", () => true], ["live", a => a.live > 0]] };
    const cols = [
      { k: "name", label: "App", sort: a => a.name, cell: a => `<span class="dot ${a.live ? "t-run" : "t-idle"}"></span>${esc(a.name)}` },
      { k: "live", label: "Live", cls: "num", desc: true, sort: a => a.live * 1e10 + (a.created || 0), cell: a => a.live },
      { k: "status", label: "By status", cell: a => Object.entries(a.counts).map(([k, v]) => `<span class="chip">${esc(k)} ${v}</span>`).join("") },
      { k: "cpu", label: "vCPU used", cls: "num", desc: true, sort: a => a.cpu_used, cell: a => a.cpu_used },
      { k: "mem", label: "GiB used", cls: "num", desc: true, sort: a => a.mem_used_gib, cell: a => a.mem_used_gib },
      { k: "created", label: "Created", cls: "small", desc: true, sort: a => a.created, cell: a => fmt(a.created) },
    ];
    const body = table("sail", apps, cols, o);
    return `<div class="panel"><div class="spread"><h2>Our Sail apps</h2><div class="row">${tableTools("sail", { ...o, rows: apps })}</div></div>
      <p class="muted small">Names ${esc(prefixes())} only. ${link("https://app.sailresearch.com", "Sail console")}. Listed ${ago(S.updated.sail)}. Sail does not report cost.</p>${body}</div>`;
  }

  function renderWandb() {
    const states = [...new Set(S.wandb.map(w => w.state))], projects = [...new Set(S.wandb.map(w => w.project))];
    const o = { key: w => w.id, text: w => [w.name, w.id, w.project, w.group, ...(w.tags || [])].join(" "), sort: "created", dir: -1, page: 20, toolsTo: true,
                facets: [["all", () => true], ...states.map(x => [x, w => w.state === x])] };
    const cols = [
      { k: "name", label: "Run", sort: w => w.name, cell: w => `${link(w.url, w.name)}<div class="muted small">${esc(w.id)}${w.group ? " · group " + esc(w.group) : ""}</div>` },
      { k: "project", label: "Project", sort: w => w.project, cell: w => esc(w.project) },
      { k: "state", label: "State", sort: w => w.state, cell: w => `<span class="dot ${w.state === "running" ? "t-run" : w.state === "finished" ? "t-good" : w.state === "crashed" || w.state === "failed" ? "t-bad" : "t-idle"}"></span>${esc(w.state)}` },
      { k: "created", label: "Created", cls: "small", desc: true, sort: w => w.created, cell: w => fmt(w.created) },
      { k: "summary", label: "Summary", cls: "small", cell: w => { const e = Object.entries(w.summary); const one = ([k, v]) => `${esc(k)} <b>${typeof v === "number" ? +v.toFixed(4) : esc(v)}</b>`;
          return e.slice(0, 3).map(one).join("<br>") + (e.length > 3 ? `<details><summary class="muted">${e.length - 3} more</summary>${e.slice(3).map(one).join("<br>")}</details>` : ""); } },
      { k: "tags", label: "Tags", cell: w => w.tags.slice(0, 3).map(t => `<span class="chip">${esc(t)}</span>`).join("") + (w.tags.length > 3 ? `<span class="muted small" title="${esc(w.tags.slice(3).join(", "))}"> +${w.tags.length - 3}</span>` : "") },
    ];
    const body = table("wandb", S.wandb, cols, o);
    return `<div class="panel"><div class="spread"><h2>W&B runs <span class="muted" style="font-weight:400">${esc(meta().wandb_entity || "")}/${esc(meta().wandb_project_prefix)}*, last 21 days, ${projects.length} projects</span></h2><div class="row">${tableTools("wandb", { ...o, rows: S.wandb })}</div></div>
      <p class="muted small">Listed ${ago(S.updated.wandb)}. An eval run logs its rollout metrics once, when its single rollout ends; the Now tab shows live eval progress.</p>${body}</div>`;
  }

  async function loadDocs() {
    if (!ui.docFiles.length) ui.docFiles = (await (await fetch("api/docs")).json()).files;
    if (ui.docFile && !ui.docText) ui.docText = (await (await fetch("api/doc?f=" + encodeURIComponent(ui.docFile))).json()).text;
    render();
  }
  function renderDocs() {
    if (!ui.docFiles.length) { loadDocs(); return `<div class="panel">loading…</div>`; }
    const q = ui.docQuery.toLowerCase();
    return `<div class="two-col" style="grid-template-columns:minmax(220px,1fr) minmax(0,3fr)"><div class="panel"><h2>Notes & logs</h2>
      <input type="search" placeholder="filter" value="${esc(ui.docQuery)}" oninput="MON.set('docQuery', this.value)" style="width:100%;margin-bottom:8px">
      <ul class="feed">${ui.docFiles.filter(f => !q || f.toLowerCase().includes(q)).map(f => `<li style="grid-template-columns:1fr" data-key="doc-${esc(f)}"><a href="javascript:void 0" onclick="MON.openDoc(${esc(JSON.stringify(f))})" style="${f === ui.docFile ? "font-weight:600" : ""}">${esc(f)}</a></li>`).join("")}</ul></div>
      <div class="panel">${ui.docFile ? `<div class="spread"><h2>${esc(ui.docFile)}</h2><button onclick="MON.openDoc(${esc(JSON.stringify(ui.docFile))})">reload</button></div><pre style="max-height:75vh">${esc(ui.docText || "loading…")}</pre>` : `<div class="muted">Pick a file. Logs show their last 400 kB.</div>`}</div></div>`;
  }

  // ---- GPUs: every GPU our Modal apps hold right now, what for, and the last 24 h ----------------------------
  const WS_SLOTS = 8;  // --ws1..--ws8 in index.html; workstreams past that and "Other probes" are gray
  function wsColor(name) {
    const order = ((S.gpus || {}).order || []).filter(n => n !== "Other probes");
    const i = order.indexOf(name);
    return i >= 0 && i < WS_SLOTS ? `var(--ws${i + 1})` : "var(--idle)";
  }
  const wsDot = name => `<span class="wsdot" style="background:${wsColor(name)}"></span>`;
  const gpuMix = byType => Object.entries(byType || {}).map(([t, n]) => `${n}× ${esc(t)}`).join(" + ") || "–";
  function billedCell(b) {
    if (!b || b.total == null) return `<span class="muted">not billed yet</span>`;
    const recent = b.last && b.last >= now() - 3 * 3600;
    return `${usd(b.total)} <span class="muted">so far</span>${recent && b.full_hour != null ? ` · ${usd(b.full_hour)}<span class="muted">/h, last full hour</span>` : ""}`;
  }
  function gpuAppCard(a) {
    const run = a.run_id ? `<a href="#tab=runs&run=${encodeURIComponent(a.run_id)}">${esc(a.run_id)}</a>` : `<span class="muted">no run registered</span>`;
    const conts = a.containers.map(c => `<span class="chip" title="${esc(c.task_id)}${c.started_at ? " · up " + dur(now() - c.started_at) : ""}">${c.queued ? "waiting · " : ""}${c.gpus == null ? "?" : c.gpus}× ${esc(c.gpu_type)}${c.sandbox ? " sandbox" : ""}</span>`).join("");
    const unknown = a.unknown ? `<div class="muted small">${plural(a.unknown, "container")} with a GPU count Modal doesn't say (not in the total)</div>` : "";
    return `<div class="card gpucard" style="border-left-color:${wsColor(a.workstream.name)}">
      <div class="card-head"><div class="card-title">${a.url ? link(a.url, a.name) : esc(a.name)}</div>
        <div class="card-val"><b>${a.gpus}</b> <span class="muted">GPUs</span>${a.queued_gpus ? ` <span class="chip warnchip">+${a.queued_gpus} waiting</span>` : ""}</div></div>
      <div class="row" style="margin-bottom:4px"><span class="chip">${wsDot(a.workstream.name)}${esc(a.workstream.name)}</span></div>
      <div class="small">${esc(a.title || "")}</div>
      <div class="gpu-meta small">
        <span class="k">GPUs</span><span>${gpuMix(a.by_type)}</span>
        <span class="k">Role</span><span>${esc(a.workstream.role || "–")}${a.shape ? ` <span class="muted">(${esc(a.shape)})</span>` : ""}</span>
        <span class="k">Run</span><span>${run}</span>
        <span class="k">Owner</span><span>${esc(a.workstream.owner || "–")}</span>
        <span class="k">Started</span><span>${a.started ? `${when(a.started)} · up ${dur(now() - a.started)}` : "–"}</span>
        <span class="k">Billed</span><span>${billedCell(a.billed)}</span>
      </div>
      <div class="gpu-conts">${conts}</div>${unknown}
      <div class="muted small mono">${esc(a.app_id)}</div></div>`;
  }
  function gpuShareBar(groups, total) {
    if (!total) return "";
    return `<div class="sharebar" role="img" aria-label="GPUs by workstream">${groups.filter(g => g.gpus).map(g =>
      `<span style="flex:${g.gpus};background:${wsColor(g.name)}" title="${esc(g.name)}: ${g.gpus} GPUs"></span>`).join("")}</div>
      <div class="legend small">${groups.filter(g => g.gpus).map(g => `<span>${wsDot(g.name)}${esc(g.name)} <b>${g.gpus}</b></span>`).join("")}</div>`;
  }
  function gpuAxis(t0, t1, w, x0) {
    const ticks = [];
    const step = 3 * 3600, first = Math.ceil(t0 / step) * step;
    for (let t = first; t <= t1; t += step) ticks.push(t);
    return ticks.map(t => { const x = x0 + (t - t0) / (t1 - t0) * w; return `<line x1="${x}" x2="${x}" y1="0" y2="100%" class="gridline"/>`; }).join("");
  }
  // axis labels are HTML over the chart, so a stretched SVG never squashes the text
  // nice y ticks for the 24 h charts: 0 / 20 / 40, $0 / $100 / $200
  function niceTicks(peak) {
    const raw = peak / 2, mag = Math.pow(10, Math.floor(Math.log10(raw || 1))), n = raw / mag;
    const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
    const out = []; for (let v = 0; v < peak + step * 0.999; v += step) out.push(v);
    return out;
  }
  function gpuChartFrame(svg, t0, t1, yticks, H) {
    const step = 3 * 3600, xs = [];
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) if ((t - t0) / (t1 - t0) > 0.04 && (t1 - t) / (t1 - t0) > 0.03) xs.push(t);
    return `<div class="chartwrap">${svg}${yticks.map(([v, y]) => `<span class="ylbl" style="top:${(y / H * 100).toFixed(2)}%">${v}</span>`).join("")}</div>
      <div class="xlbls">${xs.map(t => `<span style="left:${((t - t0) / (t1 - t0) * 100).toFixed(2)}%">${esc(PT.hm.format(t * 1000))}</span>`).join("")}</div>`;
  }
  function gpuAreaChart(G) {
    const series = G.series || [];
    const t1 = now(), t0 = t1 - (G.window || 86400);
    if (!series.length) return `<div class="muted small">Sampling started ${ago(G.checked)}; this fills in as the monitor watches.</div>`;
    const W = 1000, H = 150, top = 8, bot = 2, x = t => (Math.max(t, t0) - t0) / (t1 - t0) * W;
    const order = [...new Set([...(G.order || []), ...series.flatMap(s => Object.keys(s[1]))])];
    const yv = niceTicks(Math.max(8, ...series.map(s => Object.values(s[1]).reduce((a, b) => a + b, 0)))), peak = yv[yv.length - 1];
    const y = v => top + (H - top - bot) * (1 - v / peak);
    let marks = "", hits = "";
    series.forEach((s, i) => {
      const a = x(s[0]), b = x(i + 1 < series.length ? series[i + 1][0] : t1);
      if (b <= 0 || b - a <= 0) return;
      let acc = 0;
      for (const w of order) {
        const v = s[1][w] || 0;
        if (!v) continue;
        marks += `<rect x="${a}" width="${Math.max(b - a, 0.5)}" y="${y(acc + v)}" height="${y(acc) - y(acc + v)}" fill="${wsColor(w)}"/>`;
        acc += v;
      }
      const lines = order.filter(w => s[1][w]).map(w => `${w}: ${s[1][w]}`).join("\n");
      hits += `<rect x="${a}" width="${Math.max(b - a, 2)}" y="0" height="${H}" class="hit"><title>${esc(fmt(s[0]))}\n${acc} GPUs\n${esc(lines)}</title></rect>`;
    });
    const yt = yv.map(v => `<line x1="0" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="gridline"/>`).join("");
    const svg = `<svg class="gpuchart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="GPUs in use, last 24 hours, by workstream">${gpuAxis(t0, t1, W, 0)}${yt}${marks}${hits}</svg>`;
    return gpuChartFrame(svg, t0, t1, yv.map(v => [v, y(v)]), H);
  }
  function gpuLanes(G) {
    const lanes = G.lanes || [];
    if (!lanes.length) return "";
    const t1 = now(), t0 = t1 - (G.window || 86400), pct = t => (Math.max(t, t0) - t0) / (t1 - t0) * 100;
    const trackPx = Math.max(240, Math.min(innerWidth, 1440) - 330);  // the track's width, near enough to judge a label's fit
    // one row per app name (every instance's bars on it), rows grouped by workstream
    const byWs = new Map();
    for (const l of lanes) {
      const g = byWs.get(l.workstream) || byWs.set(l.workstream, new Map()).get(l.workstream);
      const row = g.get(l.name) || g.set(l.name, { name: l.name, ids: [], segs: [] }).get(l.name);
      row.ids.push(l.app_id); row.segs.push(...l.segs.filter(x => x[1] > t0));
    }
    const order = [...(G.order || []).filter(w => byWs.has(w)), ...[...byWs.keys()].filter(w => !(G.order || []).includes(w))];
    const laneHTML = (w, r, agg) => `<div class="lane"><div class="lane-name small" title="${esc(agg ? "all apps of " + w + " on one lane" : r.ids.join(", "))}">${esc(r.name)}${!agg && r.ids.length > 1 ? ` <span class="muted">×${r.ids.length}</span>` : ""}</div><div class="lane-track">${r.segs.map(x => {
      const l = pct(x[0]), wd = pct(x[1]) - l, fits = !agg && wd / 100 * trackPx >= String(x[2]).length * 7 + 6;
      return `<span style="left:${l.toFixed(3)}%;width:max(2px,${wd.toFixed(3)}%);background:${wsColor(w)}" title="${esc(r.name)} · ${x[2]} GPUs · ${esc(when(x[0]))} to ${x[1] >= t1 - 60 ? "now" : esc(when(x[1]))}">${fits ? `<b>${x[2]}</b>` : ""}</span>`; }).join("")}</div></div>`;
    return `<div class="lanes">${order.map(w => {
      const rows = [...byWs.get(w).values()], recent = rows.some(r => r.segs.some(x => x[1] >= t1 - 7200));
      const head = `<div class="lane-group">${wsDot(w)}${esc(w)} <span class="muted">${plural(rows.length, "app")}</span></div>`;
      // a big group gets one combined lane; its apps open below it
      const body = () => rows.length > 8
        ? laneHTML(w, { name: `all ${rows.length} apps`, ids: [], segs: rows.flatMap(r => r.segs) }, true) + more("lanes-all-" + w, `each of the ${rows.length} apps`, () => rows.map(r => laneHTML(w, r)).join(""))
        : rows.map(r => laneHTML(w, r)).join("");
      return recent ? head + body() : more("lanes-" + w, `${esc(w)}: ${plural(rows.length, "app")}, idle for 2 h`, body);
    }).join("")}</div>`;
  }
  // one legend for both 24 h charts: workstream, and its GPU charges over the window
  function gpuLegend(G) {
    const b = G.billing || {}, ws = b.workstreams || {};
    const seen = new Set([...(G.series || []).flatMap(s => Object.keys(s[1])), ...Object.keys(ws)]);
    const order = [...(G.order || []).filter(w => seen.has(w)), ...[...seen].filter(w => !(G.order || []).includes(w))];
    return `<div class="legend small" style="margin:4px 0 10px">${order.map(w => `<span>${wsDot(w)}${esc(w)}${ws[w] ? ` <span class="muted">${usd(ws[w].reduce((a, v) => a + v, 0))}</span>` : ""}</span>`).join("")}</div>`;
  }
  function gpuBillChart(G) {
    const b = G.billing || {}, hours = b.hours || [], rows = Object.entries(b.workstreams || {});
    if (!hours.length || !rows.length) return `<div class="muted small">No GPU charges in the last 24 h yet, or billing not loaded.</div>`;
    const order = [...(G.order || []).filter(w => b.workstreams[w]), ...rows.map(r => r[0]).filter(w => !(G.order || []).includes(w))];
    const tot = hours.map((_, i) => order.reduce((a, w) => a + (b.workstreams[w][i] || 0), 0));
    const yv = niceTicks(Math.max(1, ...tot)), peak = yv[yv.length - 1];
    // same time window as the GPUs chart above, so the hours line up
    const t1 = now(), t0 = t1 - (G.window || 86400);
    const W = 1000, H = 130, top = 8, bot = 2, bw = 3600 / (t1 - t0) * W, bx = t => (t - t0) / (t1 - t0) * W;
    const y = v => top + (H - top - bot) * (1 - v / peak);
    let marks = "";
    hours.forEach((t, i) => {
      if (t + 3600 <= t0) return;
      const xa = Math.max(bx(t), 0), xw = Math.min(bx(t) + bw, W) - xa;
      let acc = 0;
      for (const w of order) {
        const v = b.workstreams[w][i] || 0;
        if (!v) continue;
        marks += `<rect x="${xa + 1}" width="${Math.max(xw - 2, 1)}" y="${y(acc + v)}" height="${Math.max(y(acc) - y(acc + v) - 1, 0.5)}" fill="${wsColor(w)}"/>`;
        acc += v;
      }
      const lines = order.filter(w => b.workstreams[w][i]).map(w => `${w}: ${usd(b.workstreams[w][i])}`).join("\n");
      if (acc) marks += `<rect x="${xa}" width="${xw}" y="0" height="${H}" class="hit"><title>${esc(fmt(t))} hour\n${usd(acc)} GPU charges\n${esc(lines)}</title></rect>`;
    });
    const yt = yv.map(v => `<line x1="0" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="gridline"/>`).join("");
    const svg = `<svg class="gpuchart bill" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Hourly GPU charges by workstream">${gpuAxis(t0, t1, W, 0)}${yt}${marks}</svg>`;
    return `${gpuChartFrame(svg, t0, t1, yv.map(v => ["$" + (+v.toFixed(2)).toLocaleString(), y(v)]), H)}
      <div class="muted small">${billedNote()}. Sum ${usd(tot.reduce((a, v) => a + v, 0))} over the window, GPU resources only (CPU and memory are on the Modal apps tab).</div>`;
  }
  function renderGpus() {
    const G = S.gpus || {};
    if (!G.totals) return `<div class="panel">Loading the GPU inventory…</div>`;
    const T = G.totals, groups = G.workstreams || [];
    const waiting = groups.flatMap(g => g.apps).filter(a => a.queued_gpus);
    const kpis = `<div class="kpis">
      <div class="kpi"><div class="v">${T.gpus}</div><div class="k">GPUs in use</div><div class="s">${gpuMix(T.by_type)}</div></div>
      <div class="kpi"><div class="v">${T.apps}</div><div class="k">apps holding GPUs</div><div class="s">${plural(T.containers, "container")}</div></div>
      <div class="kpi"><div class="v">${T.queued_gpus || 0}</div><div class="k">GPUs waiting</div><div class="s">not placed by Modal yet</div></div>
      <div class="kpi"><div class="v">${T.billed_per_hour == null ? "–" : usd(T.billed_per_hour)}<small>/h</small></div><div class="k">billed per hour</div><div class="s">last full hour${T.unrated_apps ? ` · ${plural(T.unrated_apps, "app")} newer` : ""}</div></div></div>`;
    const cards = groups.flatMap(g => g.apps);
    const sections = cards.length ? `<div class="panel"><h2>Running now <span class="muted" style="font-weight:400">${plural(cards.length, "app")}</span></h2>
      <div class="grid">${cards.map(gpuAppCard).join("")}</div></div>` : "";
    return `<div class="panel"><div class="spread"><h2>GPUs right now</h2><span class="muted small">Checked ${ago(G.checked)} · refreshes every 30 s</span></div>
        ${kpis}${gpuShareBar(groups, T.gpus)}
        ${waiting.length ? `<div class="notice warn small">Waiting for GPUs: ${waiting.map(a => `${esc(a.name)} (${a.queued_gpus})`).join(", ")}. Modal has not placed these containers yet.</div>` : ""}
        ${T.gpus || waiting.length ? "" : `<div class="empty">No GPUs in use by our apps.</div>`}</div>
      ${sections}
      <div class="panel"><h2>Last 24 hours</h2>
        ${gpuLegend(G)}<h3>GPUs in use, by workstream</h3>${gpuAreaChart(G)}${gpuLanes(G)}
        <h3>GPU charges per hour, by workstream (Modal billing)</h3>${gpuBillChart(G)}</div>
      <p class="muted small">Our names only (${esc(prefixes())}); other people's apps in the workspace are not shown. GPU counts come from Modal's container list and each app's function GPU config, so apps launched without a manifest show too; the manifest adds the run id. Workstream, role and owner come from <span class="mono">workstreams.json</span> in the monitor's data dir. Cost is Modal's own bill, about an hour behind; nothing is estimated.</p>`;
  }

  // ---- render -------------------------------------------------------------------------------------------------
  function render() {
    const liveN = S.runs.filter(isLiveRun).length;
    morph(document.getElementById("nav"), TABS.map(([k, n]) => `<a href="#tab=${k}" class="${route.tab === k || (k === "runs" && route.tab === "compare") ? "on" : ""}">${n}${k === "now" && liveN ? ` <span class="count">${liveN}</span>` : ""}${k === "runs" ? ` <span class="count">${S.runs.length}</span>` : ""}${k === "gpus" && ((S.gpus || {}).totals || {}).gpus ? ` <span class="count">${S.gpus.totals.gpus}</span>` : ""}</a>`).join(""));
    // a data source the server could not read: one quiet line with the details on hover, not a red banner
    const errs = Object.entries(S.errors || {});
    document.getElementById("errbar").innerHTML = errs.length ? `<span class="errchip" title="${esc(errs.map(([k, v]) => k + ": " + v).join("\n"))}"><span class="dot"></span>${plural(errs.length, "data source")} failed its last read (${esc(errs.map(([k]) => k).join(", ").slice(0, 80))}); the page shows the last good data. Hover for details.</span>` : "";
    if (!loaded) return;
    const m = document.getElementById("main");
    const html = route.tab === "runs" ? (route.run ? renderDetail() : renderRuns()) : route.tab === "compare" ? window.Pages.compare(route.a, route.b) :
      route.tab === "apps" ? renderApps() : route.tab === "gpus" ? renderGpus() : route.tab === "sail" ? renderSail() :
      route.tab === "wandb" ? renderWandb() : route.tab === "docs" ? renderDocs() : renderNow();
    morph(m, html + (route.tab === "runs" && !route.run ? trayHTML() : ""));
    after();
  }
  function after() {
    const cv = document.getElementById("curves");
    if (cv && route.run) {
      const r = runByKey(route.run) || detail;
      if (r) Curves.update(cv, r.run_id, ((r.links || {}).wandb || []).map(w => ({ path: meta().wandb_entity + "/" + w.project + "/" + w.id, label: w.project + " / " + w.name })), stepsOf(r));
    }
    document.querySelectorAll(".tl-wrap").forEach(wirePhases);
    document.querySelectorAll("input.cb[data-k]").forEach(c => { c.checked = ui.cmp.includes(c.dataset.k); });  // morph keeps the property, not the attribute
    if (route.tab === "compare") window.Pages.after();
    const pane = document.getElementById("logpane");
    if (pane && pane.dataset.painted !== pane.dataset.keep) { pane.dataset.painted = pane.dataset.keep; paintLog(pane); }
    document.querySelectorAll("canvas[data-spark]").forEach(c => {
      const rid = c.dataset.spark, sp = SPARK[rid];
      if (!sp || Date.now() - sp.t > 30000) fetchSpark(rid);
      if (sp && sp.series) Curves.spark(c, sp.series["engine.gen_tps"] || [], 3600);
    });
    // tab title and favicon: the state of what's live, readable from a background tab
    const live = S.runs.filter(isLiveRun);
    const worst = live.some(r => (r.signals || []).some(s => s.level === "bad")) ? "bad" : live.some(r => (r.signals || []).some(s => s.level === "warn")) ? "warn" : live.length ? "run" : "idle";
    const t0 = live[0] && live[0].trials;
    document.title = (live.length ? `${worst === "bad" ? "⚠ " : ""}${t0 ? `${t0.finished}/${t0.expected || t0.dirs} · ${t0.solved} solved · ` : ""}` : "") + meta().title;
    const h1 = document.getElementById("title");
    if (h1 && h1.textContent !== meta().title) h1.textContent = meta().title;
    const color = { bad: "%23e34948", warn: "%23eda100", run: "%232a78d6", idle: "%23b5b5b0" }[worst];
    const fav = document.getElementById("favicon");
    const href = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6' fill='${color}'/%3E%3C/svg%3E`;
    if (fav.getAttribute("href") !== href) fav.setAttribute("href", href);
  }
  async function fetchSpark(rid) {
    SPARK[rid] = { ...(SPARK[rid] || {}), t: Date.now() };
    try {
      const d = await (await fetch("api/series?max=240&run=" + encodeURIComponent(rid))).json();
      SPARK[rid].series = d.series;
      document.querySelectorAll(`canvas[data-spark="${CSS.escape(rid)}"]`).forEach(c => Curves.spark(c, d.series["engine.gen_tps"] || [], 3600));
    } catch (e) {}
  }

  // ---- actions (called from inline handlers) ---------------------------------------------------------------------
  window.MONH = { gpuLabel: r => gpuLabel(r), esc, fmt, hm, hms, dur, usd, int, num, mean2, sig3, secs, plural, words, link, more, section, table, tpill, typeOf, statusHTML, shortTitle, stepsOf, started, runDur,
                  runByKey: k => runByKey(k), costNow, evalOf, compareHref, TYPES, S, ui, FOLD, schedule: () => schedule(), now: () => now() };
  window.MON = {
    set(k, v) { ui[k] = v; render(); },
    toggle(k) { ui[k] = !ui[k]; render(); },
    sort(table, k) { ui.sort[table] = k; render(); },
    tsort(id, k) { const s = TBL[id], c = s.cols.find(x => x.k === k); if (s.by === k) s.dir = -s.dir; else { s.by = k; s.dir = c && c.desc ? -1 : 1; } render(); },
    tq(id, v) { TBL[id].q = v; TBL[id].n = TBL[id].page; render(); },
    tfacet(id, f) { TBL[id].f = f; TBL[id].n = TBL[id].page; render(); },
    tmore(id, n) { const s = TBL[id]; s.n = n === 0 ? s.page : s.n + n; render(); },
    fold(id, open) { FOLD[id] = open; ls.set("mon.folds", JSON.stringify(FOLD)); render(); },
    feedMore(id, n) { ui.feedN[id] = n || 0; render(); },
    logCat(k) { ui.logCats.has(k) ? ui.logCats.delete(k) : ui.logCats.add(k); render(); paintLog(); },
    logQuery(v) { ui.logQuery = v; paintLog(); },
    repaintLog() { paintLog(); },
    pickLog(app) { LOG.pick = app; LOG.app = null; LOG.lines = []; const p = document.getElementById("logpane"); if (p) p.dataset.painted = ""; render(); connect(); },
    async loadLogs(app) { ui.logsFor = app; ui.logsText = "fetching (up to 40 s)…"; render(); const r = await fetch("api/logs?app=" + encodeURIComponent(app)); ui.logsText = (await r.json()).text; render(); },
    openGroup(g) { FOLD["grp-" + g] = true; ls.set("mon.folds", JSON.stringify(FOLD)); },
    openDoc(f) { ui.docFile = f; ui.docText = ""; loadDocs(); },
    runType(t) { ui.runType = t; ls.set("mon.runType", t); render(); },
    runsQ(v) { (TBL.runs = TBL.runs || { q: "" }).q = v; render(); },
    grpMore(g) { ui.grpN[g] = 1e9; render(); },
    pick(k) {  // comparison is within a group: a run from another group starts a new pick
      const i = ui.cmp.indexOf(k), g = (runByKey(k) || {}).group;
      if (i >= 0) ui.cmp.splice(i, 1);
      else { if (ui.cmp.length && (runByKey(ui.cmp[0]) || {}).group !== g) ui.cmp = []; ui.cmp.push(k); if (ui.cmp.length > 2) ui.cmp.shift(); }
      render(); },
    clearPick() { ui.cmp = []; render(); },
    phZoom(rid, z) { if (z) ui.phZoom[rid] = z; else delete ui.phZoom[rid]; document.getElementById("tip").style.display = "none"; render(); },
    jump(k) { const el = document.querySelector(`[data-key="${k}"]`); if (el) window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - 60, behavior: "smooth" }); },
  };
  document.getElementById("theme").onclick = () => {
    const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    ls.set("mon.theme", next);
    Curves.redraw(); after();
  };
  const theme = ls.get("mon.theme");
  if (theme) document.documentElement.dataset.theme = theme;
  window.addEventListener("resize", () => { schedule(); after(); });

  render();
  connect();
})();
