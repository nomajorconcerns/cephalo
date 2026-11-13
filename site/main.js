// Entry point: load the rule data generated from the CLI (rules.json), then the page scripts.
import { createEngine } from "./engine.js";

let data = null;
try {
  const r = await fetch("rules.json");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  data = await r.json();
} catch (e) {
  document.documentElement.classList.add("no-rules");
  console.error("Cephalo: rules.json could not be loaded, so the interactive parts are off.", e);
}
if (data) {
  globalThis.CephaloEngine = createEngine(data);
  const app = await import("./app.js");
  const { init } = await import("./home.js");
  init(app, data);
}
