// The 0.3.0 homepage parts: install/update tabs, the live hero demo, the cephalo update demo, the rules explorer,
// and the nav's scrolled state. Verdicts in the hero come from the same engine and rules.json as the playground.

export function init(app, data) {
  const { E, $, $$, el, live, reduce, applyPreset } = app;
  tabs($, $$);
  navState($);
  hero(E, $, $$, el, reduce);
  updateDemo($, el, live, reduce);
  explorer(data, $, $$, el, applyPreset);
}

/* ---------- install / update tabs (WAI-ARIA tabs, automatic activation) ---------- */
function tabs($, $$) {
  const list = $(".cmdbox [role=tablist]");
  if (!list) return;
  const all = $$("[role=tab]", list);
  const KEY = "cephalo-site-cmdtab";
  const select = (t, focus) => {
    all.forEach((x) => {
      const on = x === t;
      x.setAttribute("aria-selected", String(on));
      x.tabIndex = on ? 0 : -1;
      $("#" + x.getAttribute("aria-controls")).hidden = !on;
    });
    if (focus) t.focus();
    try { localStorage.setItem(KEY, t.id); } catch (e) { /* storage off: the choice is not remembered */ }
  };
  list.addEventListener("click", (e) => { const t = e.target.closest("[role=tab]"); if (t) select(t, false); });
  list.addEventListener("keydown", (e) => {
    const i = all.indexOf(document.activeElement);
    if (i < 0) return;
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: all.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    select(all[(to + all.length) % all.length], true);
  });
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) { /* ignore */ }
  const t = saved && all.find((x) => x.id === saved);
  if (t) select(t, false);
}

/* ---------- nav: a border and blur once the page has scrolled; exact in-page jumps ---------- */
function navState($) {
  const nav = $("#topnav");
  if (!nav) return;
  // Offscreen sections use content-visibility:auto, so their height is an estimate until rendered. Before any jump
  // (a #link, the / shortcut, or a URL with a #hash), lay everything out so the target lands under the sticky nav.
  const root = document.documentElement;
  const exact = () => root.classList.add("cv-off");
  if (location.hash.length > 1) { exact(); const t = document.getElementById(location.hash.slice(1)); if (t) t.scrollIntoView(); }
  document.addEventListener("click", (e) => { const a = e.target.closest('a[href^="#"]'); if (a) exact(); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "/") exact(); }, true);
  let queued = false;
  const set = () => { queued = false; nav.classList.toggle("scrolled", scrollY > 8); };
  addEventListener("scroll", () => { if (!queued) { queued = true; requestAnimationFrame(set); } }, { passive: true });
  set();
}

/* ---------- hero: cephalo watch lines light up the diagram, one at a time ---------- */
// c / h: the tool name in Claude Code / Hermes Agent (the names the hooks receive, src/hooks.ts).
const DEMO = [
  { c: "Bash", h: "terminal", v: "git status", dest: "Shell" },
  { c: "Read", h: "read_file", v: "src/app.ts", dest: "Files", access: "read" },
  { c: "Bash", h: "terminal", v: "rm -rf ./build", dest: "Shell" },
  { c: "Read", h: "read_file", v: "config/.env", dest: "Files", access: "read" },
  { c: "Bash", h: "terminal", v: "git push --force", dest: "Shell" },
  // MCP calls are checked against the approved servers and tools, not regex rules; this is the id the CLI writes (src/mcp/check.ts).
  { c: "mcp__fs__read", h: "mcp_fs_read", v: '{"id":3}', dest: "MCP", mcp: "mcp-tool-changed" },
  { c: "Bash", h: "terminal", v: "npm test", dest: "Shell" },
];
const STEP_MS = 1700;
const REST_MS = 2600;

function hero(E, $, $$, el, reduce) {
  const scene = $("#scene"), log = $("#watchLog");
  if (!scene || !log) return;
  const pause = $("#pauseBtn"), prev = $("#demoPrev"), next = $("#demoNext"), seg = $("#segDemo"), text = $("#sceneText");
  let agent = "claude", shown = 0, cur = -1, timer = 0, userPaused = false, onScreen = true;

  const verdict = (d) => {
    if (d.mcp) return { block: true, rule: d.mcp };
    const r = E.evaluate(d.access ? { path: d.v, access: d.access } : { command: d.v }, "linux", {});
    return { block: r.decision === "block", rule: r.rule && r.rule.id };
  };
  const V = DEMO.map(verdict);
  const time = (i) => { const s = 11 * 3600 + 4 * 60 + 11 + i * 4; return [s / 3600, (s / 60) % 60, s % 60].map((n) => String(Math.floor(n)).padStart(2, "0")).join(":"); };
  const who = (d) => `${agent}/${agent === "claude" ? d.c : d.h}`;

  /* the exact cephalo watch layout (src/watch.ts formatWatchLine): time, label, agent/tool, [rule], subject */
  function row(i) {
    const d = DEMO[i], v = V[i], li = el("li", "ln");
    li.append(el("span", "dim", time(i)), "  ", el("span", v.block ? "bad b" : "ok", v.block ? "BLOCK" : "ALLOW"), "  " + who(d));
    if (v.rule) li.append(" ", el("span", "warn", `[${v.rule}]`));
    li.append("  " + d.v);
    return li;
  }
  function render() {
    log.textContent = "";
    for (let i = 0; i < shown; i++) log.append(row(i));
    $$(".aname", scene).forEach((n) => { n.textContent = agent === "claude" ? "Claude Code" : "Hermes Agent"; });
    light(cur);
    text.textContent = `Example cephalo watch output for ${agent === "claude" ? "Claude Code" : "Hermes Agent"}. ` +
      DEMO.map((d, i) => `${time(i)}: ${V[i].block ? "blocked" : "allowed"} ${who(d)}${V[i].block ? ` by rule ${V[i].rule}` : ""}, ${d.v}, going to ${d.dest}.`).join(" ");
  }
  /* light the connection of line i and highlight its row, at the same moment */
  function light(i) {
    $$(".wire,.node.dest,.gate", scene).forEach((n) => n.classList.remove("lit-allow", "lit-block"));
    $$(".ln", log).forEach((n, j) => n.classList.toggle("cur", j === i));
    if (i < 0) return;
    const cls = V[i].block ? "lit-block" : "lit-allow";
    $$(`.wire[data-w="in"],.wire[data-w="${DEMO[i].dest}"],.node.dest[data-dest="${DEMO[i].dest}"],.gate`, scene).forEach((n) => n.classList.add(cls));
  }
  function step() {
    if (shown >= DEMO.length) { shown = 0; cur = -1; render(); return schedule(STEP_MS / 2); }
    shown++; cur = shown - 1;
    log.append(row(cur));
    light(cur);
    schedule(shown >= DEMO.length ? REST_MS : STEP_MS);
  }
  const running = () => !reduce && !userPaused && onScreen && !document.hidden;
  function schedule(ms) { clearTimeout(timer); if (running()) timer = setTimeout(step, ms); }
  function sync() {
    const manual = reduce || userPaused;
    pause.setAttribute("aria-pressed", String(userPaused));
    pause.setAttribute("aria-label", userPaused ? "Play demo" : "Pause demo");
    prev.hidden = next.hidden = !manual;
    if (running()) schedule(STEP_MS); else clearTimeout(timer);
  }
  /* manual step-through (reduced motion, or paused): every line stays shown, the arrows move the highlight */
  function move(by) {
    if (shown < DEMO.length) { shown = DEMO.length; render(); }
    cur = (Math.max(cur, 0) + by + DEMO.length) % DEMO.length;
    light(cur);
  }
  prev.addEventListener("click", () => move(-1));
  next.addEventListener("click", () => move(1));
  pause.addEventListener("click", () => { userPaused = !userPaused; sync(); });
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    agent = b.getAttribute("data-v");
    $$("button", seg).forEach((x, i) => { const on = x === b; x.setAttribute("aria-pressed", String(on)); if (on) seg.style.setProperty("--i", i); });
    render();
  });
  document.addEventListener("visibilitychange", sync);
  if ("IntersectionObserver" in window) new IntersectionObserver((es) => { onScreen = es[es.length - 1].isIntersecting; sync(); }, { threshold: 0.15 }).observe(scene);

  if (reduce) { shown = DEMO.length; cur = DEMO.length - 1; render(); sync(); return; } /* the final state, no loop */
  pause.hidden = false;
  render();
  sync();
}

/* ---------- cephalo update: a typed example session, only when asked ---------- */
// The lines the CLI prints (src/updatecmd.ts:110,130 and :141-146); 0.3.1 stands in for the newest version on npm.
const SESSION = [
  { cmd: "cephalo update" },
  { out: "Update available: 0.3.0 -> 0.3.1. Install it now? [y/N] ", answer: "y" },
  { out: "Updated Cephalo 0.3.0 -> 0.3.1.", cls: "ok" },
  { out: "Your rules, audit log, settings and license were not touched. Next: cephalo doctor" },
  { out: "If the release notes mention new hook matchers, run once: cephalo install claude (and cephalo install hermes if you use Hermes).", cls: "dim" },
  { out: "To see default rules your rules file does not have yet: cephalo rules", cls: "dim" },
];

function updateDemo($, el, live, reduce) {
  const term = $("#updTerm"), run = $("#updRun"), again = $("#updReplay");
  if (!term || !run) return;
  let token = 0;
  const wait = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));
  async function play() {
    const my = ++token, alive = () => my === token;
    term.textContent = "";
    run.hidden = true;
    again.hidden = true;
    for (const s of SESSION) {
      const line = el("span", "ln" + (s.cls ? " " + s.cls : ""));
      term.append(line);
      if (s.cmd) {
        line.append(el("span", "prompt", "$ "));
        const c = el("span", "cmdc");
        line.append(c);
        for (const ch of s.cmd) { if (!alive()) return; c.textContent += ch; await wait(45); }
        await wait(420);
      } else {
        line.textContent = s.out;
        if (s.answer) { await wait(700); if (!alive()) return; line.append(el("span", "cmdc", s.answer)); await wait(500); }
        else await wait(260);
      }
      if (!alive()) return;
    }
    again.hidden = false;
    live("Example update session shown.");
  }
  run.addEventListener("click", play);
  again.addEventListener("click", () => { play(); again.focus(); });
}

/* ---------- rules explorer: search, filter by category, expand for pattern and example ---------- */
const CAT = { shell: "Shell", files: "Files", mcp: "MCP" };
const OSN = { win32: "Windows", darwin: "macOS", linux: "Linux" };

function explorer(data, $, $$, el, applyPreset) {
  const list = $("#rxList"), q = $("#rxQ"), catSeg = $("#rxCat"), osSeg = $("#rxOs"), count = $("#rxCount");
  if (!list) return;
  let cat = "all", os = "linux";
  const ex = data.examples || {};
  const items = () => [
    ...data.defaults.concat(data[os]).map((r) => ({ id: r.id, d: r.d, p: r.p, cat: r.t === "path" ? "files" : "shell", on: r.on, sys: !!r.l, ex: ex[r.id] })),
    ...(data.mcp || []).map((m) => ({ id: m.id, d: m.d, why: m.why, cat: "mcp" })),
  ];
  const exText = (x) => (x ? (x.c !== undefined ? x.c : x.p) : "");

  function card(r, i) {
    const li = el("li", "rx-item"), id = "rx-b-" + i;
    const btn = el("button", "rx-head");
    btn.type = "button";
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", id);
    btn.append(el("code", "rx-id", r.id), el("span", "rx-d", r.d), el("span", "rx-cat c-" + r.cat, CAT[r.cat]));
    const body = el("div", "rx-body");
    body.id = id;
    body.hidden = true;
    const dl = el("dl");
    const add = (k, v) => { dl.append(el("dt", null, k)); const dd = el("dd"); dd.append(v); dl.append(dd); };
    if (r.cat === "mcp") {
      add("Checks", "MCP tool calls are checked against the servers and tool definitions you approved, not against a pattern.");
      add("Blocks", r.d + ".");
      add("Then", r.why);
    } else {
      add("Pattern", el("code", "rx-pat", r.p));
      add("Blocks", r.d + (r.cat === "files" ? ` (${r.on === "write" ? "writes" : r.on === "read" ? "reads" : "reads and writes"})` : "") + ".");
      if (r.ex) {
        const v = el("span");
        v.append(el("code", null, exText(r.ex)));
        const notes = [];
        if (r.ex.a) notes.push(r.ex.a === "write" ? "a file write" : "a file read");
        if (r.ex.os) notes.push("on " + OSN[r.ex.os]);
        if (r.ex.hit) notes.push("blocked first by " + r.ex.hit + ", which runs earlier");
        if (notes.length) v.append(" ", el("span", "rx-note", "(" + notes.join(", ") + ")"));
        const t = el("button", "chip", "Try it in the playground");
        t.type = "button";
        t.addEventListener("click", () => {
          applyPreset({ a: "claude", t: r.ex.c !== undefined ? "Bash" : r.ex.a === "write" ? "Write" : "Read", v: exText(r.ex), os: r.ex.os || os });
          $("#playground").scrollIntoView({ block: "start" });
          $("#input").focus({ preventScroll: true });
        });
        v.append(" ", t);
        add("Example", v);
      }
      if (r.sys) add("Note", "One of Cephalo's own protections: an allow rule cannot lift it.");
    }
    body.append(dl);
    btn.addEventListener("click", () => { const open = btn.getAttribute("aria-expanded") !== "true"; btn.setAttribute("aria-expanded", String(open)); body.hidden = !open; });
    li.append(btn, body);
    return li;
  }
  function render() {
    const term = q.value.trim().toLowerCase();
    const shown = items().filter((r) => (cat === "all" || r.cat === cat) && (!term || [r.id, r.d, r.p, exText(r.ex)].some((s) => s && s.toLowerCase().includes(term))));
    list.textContent = "";
    shown.forEach((r, i) => list.append(card(r, i)));
    count.textContent = shown.length ? `${shown.length} rule${shown.length === 1 ? "" : "s"} on ${OSN[os]}` : `No rule matches "${q.value.trim()}" on ${OSN[os]}.`;
  }
  const segPick = (seg, fn) => seg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    $$("button", seg).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    fn(b.getAttribute("data-v"));
    render();
  });
  segPick(catSeg, (v) => { cat = v; });
  segPick(osSeg, (v) => { os = v; });
  q.addEventListener("input", render);
  // built as the section nears the screen (at once without IntersectionObserver)
  if (!("IntersectionObserver" in window)) return render();
  const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { io.disconnect(); render(); } }, { rootMargin: "800px 0px" });
  io.observe(list);
}
