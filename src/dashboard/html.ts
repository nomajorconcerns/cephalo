import { jsonForScript } from "../replay/html.js";
import type { DashboardData } from "./data.js";

const STYLE = `
:root{color-scheme:dark;--bg:#0e1116;--card:#171b22;--line:#262c36;--fg:#e6e9ef;--mut:#8b94a3;--ok:#3fb68b;--bad:#e5534b;--ask:#e3b341}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,Segoe UI,sans-serif}
main{max-width:1000px;margin:0 auto;padding:24px 16px 60px}h1{font-size:20px;margin:0}.sub{color:var(--mut);margin:2px 0 16px}
nav{display:flex;gap:6px;margin:12px 0 18px;border-bottom:1px solid var(--line)}
nav button{background:none;border:0;color:var(--mut);padding:8px 14px;font:inherit;cursor:pointer;border-bottom:2px solid transparent}
nav button[aria-selected=true]{color:var(--fg);border-bottom-color:var(--fg)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}.card b{display:block;font-size:22px}.card span{color:var(--mut);font-size:12px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:8px;margin-bottom:16px}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top;word-break:break-word}th{color:var(--mut);font-weight:500;font-size:12px}
h2{font-size:14px;margin:18px 0 6px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
.block,.ask,.allow{white-space:nowrap}.block{color:var(--bad)}.ask{color:var(--ask)}.allow{color:var(--ok)}.note{color:var(--mut);font-size:12px}
.bars{display:flex;align-items:flex-end;gap:3px;height:70px;margin-bottom:4px}.bars i{flex:1;background:var(--line);min-height:1px;position:relative}
.bars i s{position:absolute;bottom:0;left:0;right:0;background:var(--bad);display:block}
.hide{display:none}
`;

const SCRIPT = `
const D=JSON.parse(document.getElementById('data').textContent);
const $=(s)=>document.querySelector(s);
function el(t,c,x){const e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e}
function usd(v){return v==null?'n/a':'$'+v.toFixed(2)}
function table(head,rows){const t=el('table');const h=el('tr');head.forEach(x=>h.appendChild(el('th',null,x)));t.appendChild(h);
 rows.forEach(r=>{const tr=el('tr');r.forEach(c=>{const td=el('td',c&&c.cls?c.cls:null,c&&c.cls?c.t:String(c));tr.appendChild(td)});t.appendChild(tr)});return t}
function cards(list){const w=el('div','cards');list.forEach(([n,l])=>{const c=el('div','card');c.appendChild(el('b',null,String(n)));c.appendChild(el('span',null,l));w.appendChild(c)});return w}
function bars(){const w=el('div','bars');const max=Math.max(1,...D.byDay.map(d=>d.calls));
 D.byDay.forEach(d=>{const i=el('i');i.style.height=Math.max(2,100*d.calls/max)+'%';i.title=d.day+': '+d.calls+' calls, '+d.blocked+' blocked, '+d.asked+' asked';
 if(d.blocked){const s=el('s');s.style.height=(100*d.blocked/Math.max(1,d.calls))+'%';i.appendChild(s)}w.appendChild(i)});return w}
const tabs={
 overview(p){const t=D.totals;p.appendChild(cards([[t.calls,'agent calls'],[t.blocked,'blocked'],[t.asked,'asked you'],[t.tripwire,'tripwire events'],[t.secretsInOutput,'secrets seen in output']]));
  p.appendChild(el('h2',null,'Calls per day (red = blocked)'));p.appendChild(bars());
  p.appendChild(el('h2',null,'By agent'));p.appendChild(table(['Agent','Calls'],Object.entries(D.byAgent).map(([a,n])=>[a,n])));
  if(D.scope==='team folder'){p.appendChild(el('h2',null,'By developer'));p.appendChild(table(['User','Calls','Blocked','Asked'],Object.entries(D.byUser).map(([u,v])=>[u,v.calls,v.blocked,v.asked])))}},
 sessions(p){const c=D.cost;if(!c){p.appendChild(el('p','note','Cost and sessions are only shown for this machine (run cephalo dashboard without --team).'));return}
  p.appendChild(cards([[usd(c.totalUsd),'estimated spend'],[c.shippedResults,'shipped results'],[usd(c.costPerShipped),'cost per shipped result'],[usd(c.otherUsd),'spent on work that did not ship']]));
  p.appendChild(el('h2',null,'By outcome'));p.appendChild(table(['Outcome','Sessions','Estimated $'],Object.entries(c.byStatus).map(([k,v])=>[k,v.sessions,usd(v.usd)])));
  p.appendChild(el('h2',null,'Latest sessions'));p.appendChild(table(['When','Agent','$','Outcome','Branch'],c.rows.slice(0,25).map(r=>[r.end.slice(0,16).replace('T',' '),r.agent,usd(r.usd)+(r.partial?'+':''),r.status+(r.pr?' #'+r.pr:''),r.branch||''])));
  c.notes.forEach(n=>p.appendChild(el('p','note',n)))},
 seatbelt(p){p.appendChild(el('h2',null,'Most-hit rules'));p.appendChild(D.byRule.length?table(['Rule','Blocks'],D.byRule.map(r=>[r.rule,r.count])):el('p','note','Nothing blocked in this period.'));
  p.appendChild(el('h2',null,'Needs a look (newest first)'));
  p.appendChild(D.attention.length?table(['When','Who','Tool','Decision','Rule','What'],D.attention.map(a=>[a.ts.slice(0,16).replace('T',' '),(a.user?a.user+' / ':'')+a.agent,a.tool,{cls:a.decision,t:a.decision.toUpperCase()},a.rule||'',a.subject])):el('p','note','Nothing needed attention.'))}
};
function show(name){document.querySelectorAll('nav button').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.t===name)));
 const p=$('#panel');p.textContent='';tabs[name](p)}
document.querySelectorAll('nav button').forEach(b=>b.addEventListener('click',()=>show(b.dataset.t)));
$('#sub').textContent='Source: '+D.source+' · '+D.scope+' · generated '+D.generated.slice(0,16).replace('T',' ');
show('overview');
`;

/** One self-contained page. No network access (the CSP forbids it); all data is set with textContent, never as HTML. */
export function renderDashboard(d: DashboardData): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cephalo dashboard</title>
<style>${STYLE}</style></head>
<body><main>
<h1>Cephalo dashboard</h1><p class="sub" id="sub"></p>
<nav role="tablist"><button data-t="overview" aria-selected="true">Overview</button><button data-t="sessions" aria-selected="false">Sessions and cost</button><button data-t="seatbelt" aria-selected="false">Seatbelt</button></nav>
<div id="panel"></div>
</main>
<script type="application/json" id="data">${jsonForScript(d)}</script>
<script>${SCRIPT}</script>
</body></html>
`;
}
