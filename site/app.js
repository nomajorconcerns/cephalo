var E=CephaloEngine;
var reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
function $(s,r){return (r||document).querySelector(s);}
function $$(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s));}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
var instant=false;
function psleep(ms){return new Promise(function(r){setTimeout(r,ms);});} /* terminal players always use real time */
function sleep(ms){return new Promise(function(r){if(reduce||instant)r();else setTimeout(r,ms);});}
/* tiny markup: <ok>..</ok> <bad> <warn> <dim> <acc> <b> -> spans (textContent only) */
function markup(parent,text){
  var re=/<(ok|bad|warn|dim|acc|b|cmdc|prompt)>([\s\S]*?)<\/\1>/g,last=0,m;
  while((m=re.exec(text))){
    if(m.index>last)parent.appendChild(document.createTextNode(text.slice(last,m.index)));
    var glyph=(m[1]==='ok'&&/^ALLOW(ED)?$/.test(m[2]))?'\u2713 ':(m[1]==='bad'&&/^(<b>)?BLOCK(ED)?(<\/b>)?$/.test(m[2]))?'\u2715 ':'';var sp=el('span',m[1]);if(glyph)sp.appendChild(document.createTextNode(glyph));markup(sp,m[2]);parent.appendChild(sp);last=re.lastIndex;
  }
  if(last<text.length)parent.appendChild(document.createTextNode(text.slice(last)));
}

function retrigger(node,cls){node.classList.remove(cls);void node.offsetWidth;node.classList.add(cls);}

/* ---------- scroll reveal + nav highlight ---------- */
(function(){
  var targets=$$('.sec-head,.split,.tile,.rb>.rbcol>.card,.hubwrap,.lab,.plug,.explorer,.more>div,.plat,.normer>.card,.inst,.lim,.faq>details,.ctapanel,.feat>.fcard,.subhead,.tiers>.tier,.calc,.pricenote');
  targets.forEach(function(t,i){t.classList.add('reveal');});
  // stagger siblings inside the same grid
  [['.more','div'],['.limits','div'],['.normer','.card'],['#feat','.fcard'],['#planned','.fcard'],['.tiers','.tier']].forEach(function(g){
    var p=$(g[0]);if(!p)return;$$(':scope > '+g[1],p).forEach(function(c,i){c.style.transitionDelay=((i%3)*90)+'ms';});
  });
  if(reduce||!('IntersectionObserver' in window)){targets.forEach(function(t){t.classList.add('in');});}
  else{
    var io=new IntersectionObserver(function(es){es.forEach(function(x){if(x.isIntersecting){x.target.classList.add('in');io.unobserve(x.target);}});},{threshold:.08,rootMargin:'0px 0px -6% 0px'});
    targets.forEach(function(t){io.observe(t);});
  }
  // highlight the nav link of the section in view
  if('IntersectionObserver' in window){
    var links={};$$('nav.top .links a').forEach(function(a){links[a.getAttribute('href')]=a;});
    var spy=new IntersectionObserver(function(es){es.forEach(function(x){
      if(!x.isIntersecting)return;var a=links['#'+x.target.id];
      Object.keys(links).forEach(function(k){links[k].removeAttribute('aria-current');});
      if(a)a.setAttribute('aria-current','true');
    });},{rootMargin:'-45% 0px -50% 0px'});
    $$('section').forEach(function(s){spy.observe(s);}); /* the hero has no id, so entering it clears the highlight */
  }
})();

/* ---------- theme ---------- */
function paintTheme(){var light=document.documentElement.getAttribute('data-theme')==='light';var b=$('#themeBtn');b.setAttribute('aria-label',light?'Switch to dark theme':'Switch to light theme');b.setAttribute('aria-pressed',String(light));}
function live(msg){var n=$('#live');if(!n)return;n.textContent='';setTimeout(function(){n.textContent=msg;},30);}
$('#themeBtn').addEventListener('click',function(){
  var root=document.documentElement,next=root.getAttribute('data-theme')==='light'?'dark':'light';
  function set(){root.setAttribute('data-theme',next);try{localStorage.setItem('cephalo-site-theme',next);}catch(e){}paintTheme();}
  if(reduce||!document.startViewTransition||document.hidden){ /* instant, with the short colour fade */
    root.classList.add('theming');clearTimeout(window.__themingT);window.__themingT=setTimeout(function(){root.classList.remove('theming');},520);set();return;
  }
  var r=this.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
  root.style.setProperty('--tx',x+'px');root.style.setProperty('--ty',y+'px');
  root.style.setProperty('--tr',Math.ceil(Math.hypot(Math.max(x,innerWidth-x),Math.max(y,innerHeight-y)))+'px');
  var ran=false,once=function(){if(ran)return;ran=true;set();},clean=function(){root.classList.remove('vt-theme');};
  root.classList.add('vt-theme');
  var vt=document.startViewTransition(once);vt.finished.then(clean,clean);
  setTimeout(once,400);
});
paintTheme();

/* ---------- top progress bar, mobile menu, sticky install bar ---------- */
(function(){
  var bar=$('#topProg');
  if(bar){
    if(!reduce&&window.CSS&&CSS.supports&&CSS.supports('animation-timeline: scroll()'))bar.classList.add('native');
    else{
      var tick=false,upd=function(){tick=false;var h=document.documentElement.scrollHeight-innerHeight;bar.style.transform='scaleX('+(h>0?Math.min(1,scrollY/h):0)+')';};
      addEventListener('scroll',function(){if(!tick){tick=true;requestAnimationFrame(upd);}},{passive:true});upd();
    }
  }
  var menu=$('#menu'),mb=$('#menuBtn');
  if(menu&&mb&&menu.showPopover){
    menu.addEventListener('toggle',function(e){var open=e.newState==='open';mb.setAttribute('aria-expanded',String(open));mb.setAttribute('aria-label',open?'Close menu':'Open menu');});
    menu.addEventListener('click',function(e){if(e.target.closest('a'))menu.hidePopover();});
  }
  var st=$('#stick'),hero=$('.hero'),inst=$('#install'),cta=$('#cta');
  if(st&&hero&&'IntersectionObserver' in window){
    var vis={hero:true,inst:false,cta:false};
    function sync(){var show=!vis.hero&&!vis.inst&&!vis.cta;st.classList.toggle('show',show);st.inert=!show;}
    [['hero',hero],['inst',inst],['cta',cta]].forEach(function(x){
      if(!x[1])return;new IntersectionObserver(function(es){vis[x[0]]=es[es.length-1].isIntersecting;sync();}).observe(x[1]);
    });
  }
})();

/* ---------- logo (pixel octopus from banner.ts) ---------- */
var PAL={P:'#f472b6',L:'#f9a8d4',W:'#ffffff',K:'#1a1a2e'};
var OCT=["......PPPP......","...PPPPPPPPPP...","..PPLLPPPPPPPP..",".PPLPPPPPPPPPPP.",".PPPWWPPPPWWPPP.",".PPPWKPPPPWKPPP.",".PPPPPPPPPPPPPP.","..PPPPPPPPPPPP..",".PP.PP.PP.PP.PP.","PP..P..PP..P..PP","P..PP..PP..PP..P",".PP..PP..PP..PP."];
function logo(){
  var ns='http://www.w3.org/2000/svg',s=document.createElementNS(ns,'svg');
  s.setAttribute('viewBox','0 0 16 12');s.setAttribute('shape-rendering','crispEdges');s.setAttribute('width','26');s.setAttribute('height','20');
  OCT.forEach(function(row,y){for(var x=0;x<row.length;x++){var c=PAL[row[x]];if(!c)continue;var r=document.createElementNS(ns,'rect');r.setAttribute('x',x);r.setAttribute('y',y);r.setAttribute('width','1');r.setAttribute('height','1');r.setAttribute('fill',c);s.appendChild(r);}});
  return s;
}
$('#logo').appendChild(logo());$('#logo2').appendChild(logo());

/* ---------- copy buttons ---------- */
document.addEventListener('click',function(e){
  var b=e.target.closest('.copy');if(!b)return;
  var t=b.getAttribute('data-copy');
  if(b.hasAttribute('data-copy-from'))t=document.getElementById(b.getAttribute('data-copy-from')).textContent;
  if(t===null)return;
  function ok(){if(!b.hasAttribute('data-label'))b.setAttribute('data-label',b.textContent);var old=b.getAttribute('data-label');b.textContent='\u2713 Copied';b.classList.remove('pop');void b.offsetWidth;b.classList.add('done','pop');live('Copied to clipboard');clearTimeout(b._t);b._t=setTimeout(function(){b.textContent=old;b.classList.remove('done','pop');},1500);}
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(ok,function(){fallback(t,ok);});}else fallback(t,ok);
});
function fallback(t,ok){var ta=el('textarea');ta.value=t;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();try{document.execCommand('copy');ok();}catch(e){}ta.remove();}

/* ---------- terminal player ---------- */
function Player(body,opts){this.body=body;this.token=0;this.opts=opts||{};}
Player.prototype.play=function(script,loop){
  var self=this,tok=++this.token;this.body.textContent='';
  var alive=function(){return self.token===tok;};
  var run=async function(){
    do{
      self.body.textContent='';
      for(var i=0;i<script.length&&alive();i++){
        var it=script[i];
        if(it.k==='wait'){await psleep(it.ms);continue;}
        var line=el('span','ln');self.body.appendChild(line);
        if(it.k==='cmd'){
          markup(line,'<prompt>$ </prompt>');
          var txt=it.t,span=el('span','cmdc');line.appendChild(span);
          var caret=el('span','caret');line.appendChild(caret);
          for(var c=0;c<txt.length&&alive();c++){span.textContent+=txt[c];await psleep(it.speed||26);}
          caret.remove();await psleep(it.after||260);
        }else{
          markup(line,it.t);await psleep(it.d===undefined?70:it.d);
        }
        self.body.scrollTop=self.body.scrollHeight;
      }
      if(loop&&alive())await psleep(2600);
    }while(loop&&alive());
  };
  if(reduce){ // render instantly
    this.body.textContent='';
    script.forEach(function(it){if(it.k==='wait')return;var l=el('span','ln');self.body.appendChild(l);if(it.k==='cmd'){markup(l,'<prompt>$ </prompt>');l.appendChild(el('span','cmdc',it.t));}else markup(l,it.t);});
    return;
  }
  run();
};
Player.prototype.stop=function(){this.token++;};

/* ---------- playground ---------- */
var TOOLS={
  claude:[
    {id:'Bash',kind:'command',label:'Bash (shell command)',field:'command'},
    {id:'Read',kind:'path',access:'read',label:'Read (file path)',field:'file_path'},
    {id:'Write',kind:'path',access:'write',label:'Write (file path)',field:'file_path'},
    {id:'Edit',kind:'path',access:'write',label:'Edit (file path)',field:'file_path'},
    {id:'Grep',kind:'none',label:'Grep (not checked)',field:'pattern'}
  ],
  hermes:[
    {id:'terminal',kind:'command',label:'terminal (shell command)',field:'command'},
    {id:'execute_code',kind:'command',label:'execute_code (script text)',field:'code'},
    {id:'read_file',kind:'path',access:'read',label:'read_file (path)',field:'path'},
    {id:'search_files',kind:'path',access:'read',label:'search_files (path)',field:'path'},
    {id:'write_file',kind:'path',access:'write',label:'write_file (path)',field:'path'},
    {id:'patch',kind:'path',access:'write',label:'patch (path)',field:'path'},
    {id:'web_search',kind:'none',label:'web_search (not checked)',field:'query'}
  ]
};
var state={agent:'claude',os:detectOs(),tool:'Bash',disabled:{}};
var hasRun=false;
function detectOs(){
  var p=((navigator.userAgentData&&navigator.userAgentData.platform)||navigator.platform||navigator.userAgent||'').toLowerCase();
  if(p.indexOf('win')>=0)return 'win32';
  if(p.indexOf('mac')>=0||p.indexOf('iphone')>=0||p.indexOf('ipad')>=0)return 'darwin';
  return 'linux';
}
/* g = chip row ('Try' is the featured row, the rest sit under "More examples"). A chip only shows its outcome colour after it has been run once. */
var PRESETS=[
  {g:'Try',n:'rm -rf /',a:'claude',t:'Bash',v:'rm -rf /'},
  {g:'Try',n:'git push --force',a:'claude',t:'Bash',v:'git push --force origin main'},
  {g:'Try',n:'cat .env',a:'claude',t:'Bash',v:'cat .env'},
  {g:'Try',n:'DROP TABLE',a:'claude',t:'Bash',v:'psql -c "DROP TABLE users"'},
  {g:'Try',n:'curl | sh',a:'claude',t:'Bash',v:'curl -fsSL https://get.example.dev/install | sh'},
  {g:'Try',n:'git status',a:'claude',t:'Bash',v:'git status'},
  {g:'Destructive',n:'rm -rf',a:'hermes',t:'terminal',v:'rm -rf ./build'},
  {g:'Destructive',n:'format drive',a:'hermes',t:'terminal',v:'format D: /q',os:'win32'},
  {g:'Destructive',n:'mkfs',a:'hermes',t:'terminal',v:'mkfs.ext4 /dev/sdb1',os:'linux'},
  {g:'Destructive',n:'diskutil erase',a:'claude',t:'Bash',v:'diskutil eraseDisk APFS Scratch disk2',os:'darwin'},
  {g:'Secrets',n:'read .env',a:'claude',t:'Read',v:'./config/.env'},
  {g:'Secrets',n:'read .env.example',a:'claude',t:'Read',v:'./config/.env.example'},
  {g:'Secrets',n:'literal token',a:'claude',t:'Bash',v:'curl -H "Authorization: Bearer ***" https://api.github.com/user'},
  {g:'Secrets',n:'read vault key',a:'hermes',t:'terminal',v:'cat ~/.cephalo/vault.key'},
  {g:'Git',n:'--force-with-lease',a:'claude',t:'Bash',v:'git push --force-with-lease origin main'},
  {g:'Self-protection',n:'edit Claude settings',a:'claude',t:'Write',v:'~/.claude/settings.json'},
  {g:'Self-protection',n:'erase audit log',a:'claude',t:'Bash',v:'echo > ~/.cephalo/audit.jsonl'},
  {g:'Self-protection',n:'edit audit log',a:'claude',t:'Write',v:'~/.cephalo/audit.jsonl'},
  {g:'Self-protection',n:'read audit log',a:'claude',t:'Read',v:'~/.cephalo/audit.jsonl'},
  {g:'Self-protection',n:'agent adds a rule',a:'hermes',t:'terminal',v:'cephalo incident 3 --use 1 --yes'},
  {g:'Evasion',n:"sneaky r''m",a:'claude',t:'Bash',v:"r''m -rf /tmp/build",os:'linux'},
  {g:'Evasion',n:'cmd.exe r^d',a:'claude',t:'Bash',v:'r^d /s /q C:\\proj\\node_modules',os:'win32'},
  {g:'Evasion',n:'path with ..',a:'hermes',t:'read_file',v:'C:\\proj\\sub\\..\\.env',os:'win32'},
  {g:'MCP',n:'changed MCP tool',go:'mcp'},
  {g:'Safe',n:'npm test',a:'hermes',t:'terminal',v:'npm test'},
  {g:'Safe',n:'unchecked tool',a:'claude',t:'Grep',v:'DROP TABLE'}
];
var seen={};try{seen=JSON.parse(sessionStorage.getItem('cephalo-chips')||'{}')||{};}catch(e){}
function toolDef(){return TOOLS[state.agent].filter(function(t){return t.id===state.tool;})[0]||TOOLS[state.agent][0];}
function setSeg(seg,val){
  var bs=$$('button',seg),idx=0;
  bs.forEach(function(b,i){var on=b.getAttribute('data-v')===val;b.setAttribute('aria-pressed',String(on));if(on)idx=i;});
  if(seg.classList.contains('slide')){seg.style.setProperty('--n',bs.length);seg.style.setProperty('--i',idx);}
}
function fillTools(){
  var seg=$('#segTool');seg.textContent='';seg.classList.remove('ready');seg.appendChild(el('span','thumb'));
  if(!TOOLS[state.agent].some(function(t){return t.id===state.tool;}))state.tool=TOOLS[state.agent][0].id;
  TOOLS[state.agent].forEach(function(t){var b=el('button',null,t.id);b.type='button';b.setAttribute('data-v',t.id);b.title=t.label;b.setAttribute('aria-pressed','false');seg.appendChild(b);});
  setSeg(seg,state.tool);updateInputLabel();
  var on=seg.querySelector('[aria-pressed=true]'),sc=seg.parentNode;if(on)sc.scrollLeft=Math.max(0,on.offsetLeft-(sc.clientWidth-on.offsetWidth)/2);
  requestAnimationFrame(function(){requestAnimationFrame(function(){seg.classList.add('ready');});});
}
function updateInputLabel(){
  var t=toolDef(),inp=$('#input');
  $('#inputLabel').textContent=t.kind==='path'?'File path ('+t.access+')':t.kind==='command'?(t.id==='execute_code'?'Script text':'Shell command'):'Input (this tool is not checked)';
  $('#ps').textContent=t.kind==='command'?'$':t.kind==='path'?'\u203A':'?';
  inp.placeholder=t.kind==='path'?'a file path an agent might touch':'type something an agent might run';
}
function chipClass(i){var o=seen[i];return 'chip'+(PRESETS[i].go?' link':'')+(o==='block'?' b-bad':o==='allow'?' b-ok':'');}
function buildChips(){
  var box=$('#chips');box.textContent='';var g=null,row=null,more=el('details','more-ex'),host=box;
  more.appendChild(el('summary',null,'More examples'));
  PRESETS.forEach(function(p,i){
    if(p.g!==g){
      g=p.g;if(g!=='Try')host=more;
      var grp=el('div','cg'+(g==='Try'?' try':''));grp.appendChild(el('span','gl',g==='Try'?'Try one':g));
      row=el('div','row');row.setAttribute('role','group');row.setAttribute('aria-label',(g==='Try'?'Featured':g)+' examples');grp.appendChild(row);host.appendChild(grp);
    }
    var c=el('button',chipClass(i),p.n);c.type='button';c.setAttribute('data-i',i);row.appendChild(c);
  });
  box.appendChild(more);
}
/* the instant verdict: ALLOW or BLOCK, the rule and its one-line reason, on every keystroke, before the stages play */
function quickVerdict(){
  var q=$('#pgVerdict');if(!q)return;
  var val=$('#input').value,c=mkCall(state.agent,state.tool,val,state.os,state.disabled),r=c.res,block=r.decision==='block';
  q.textContent='';q.className='qv '+(val.trim()?(block?'is-block':'is-allow'):'is-empty');
  if(!val.trim()){q.appendChild(el('span','qv-why','Type a command or pick an example.'));return;}
  q.appendChild(el('span','qv-badge',block?'✕ BLOCK':'✓ ALLOW'));
  if(block){q.appendChild(el('code','qv-rule',r.rule.id));q.appendChild(el('span','qv-why',r.rule.d));}
  else q.appendChild(el('span','qv-why',c.t.kind==='none'?'Cephalo does not check this tool, so it runs (and is logged).':'No rule matched, so the call goes ahead.'));
}
function markSeen(val,res){
  var ch=false;
  PRESETS.forEach(function(p,i){
    if(p.go||p.t!==state.tool||p.v!==val||p.a!==state.agent||(p.os&&p.os!==state.os))return;
    seen[i]=res.decision;ch=true;
    var c=$('#chips [data-i="'+i+'"]');if(c)c.className=chipClass(i);
  });
  if(ch)try{sessionStorage.setItem('cephalo-chips',JSON.stringify(seen));}catch(e){}
}
function buildRuleList(){
  var box=$('#ruleList');box.textContent='';
  E.rulesFor(state.os).forEach(function(r){
    var lab=el('label'),cb=el('input');cb.type='checkbox';cb.checked=!state.disabled[r.id];cb.setAttribute('data-id',r.id);
    var code=el('code',null,r.id),o=el('span','o',r.o==='default'?'default':'platform');
    lab.title=r.d;lab.appendChild(cb);lab.appendChild(code);lab.appendChild(o);box.appendChild(lab);
  });
  $('#ruleCount').textContent='('+E.rulesFor(state.os).length+')';
}
var runToken=0;
function highlight(pre,obj){ // small JSON colourizer, textContent only
  pre.textContent='';
  var json=JSON.stringify(obj,null,2),re=/("(?:\\.|[^"\\])*")(\s*:)?|[{}\[\],]|\S+/g,last=0,m;
  while((m=re.exec(json))){
    if(m.index>last)pre.appendChild(document.createTextNode(json.slice(last,m.index)));
    var cls=m[1]?(m[2]?'k':'s'):null;
    if(cls){pre.appendChild(el('span',cls,m[1]));if(m[2])pre.appendChild(document.createTextNode(m[2]));}
    else pre.appendChild(document.createTextNode(m[0]));
    last=re.lastIndex;
  }
}
/* character diff: which characters of `a` were removed and which of `b` were added */
function charDiff(a,b){
  var n=a.length,m=b.length,del=[],ins=[],i=0,j=0;
  if(n*m>250000){ // very long input: trim the common head and tail only
    while(i<n&&i<m&&a[i]===b[i])i++;
    var t=0;while(t<n-i&&t<m-i&&a[n-1-t]===b[m-1-t])t++;
    for(var x=i;x<n-t;x++)del[x]=1;for(var y=i;y<m-t;y++)ins[y]=1;return {del:del,ins:ins};
  }
  var L=[];for(var r=0;r<=n;r++)L.push(new Uint16Array(m+1));
  for(r=n-1;r>=0;r--)for(var c=m-1;c>=0;c--)L[r][c]=a[r]===b[c]?L[r+1][c+1]+1:Math.max(L[r+1][c],L[r][c+1]);
  while(i<n&&j<m){if(a[i]===b[j]){i++;j++;}else if(L[i+1][j]>=L[i][j+1]){del[i++]=1;}else{ins[j++]=1;}}
  while(i<n)del[i++]=1;while(j<m)ins[j++]=1;
  return {del:del,ins:ins};
}
function diffRun(parent,text,flags,tag,cls){ // text with the flagged characters wrapped in <tag class=cls>
  var i=0;
  while(i<text.length){
    var f=!!flags[i],k=i;while(k<text.length&&!!flags[k]===f)k++;
    var chunk=text.slice(i,k);
    if(f)parent.appendChild(el(tag,cls,chunk));else parent.appendChild(document.createTextNode(chunk));
    i=k;
  }
}
var STEP_BTNS=function(){return $$('#stepper .step');};
function setStep(i,st,sum){
  var b=STEP_BTNS()[i];b.classList.remove('live','done');if(st)b.classList.add(st);
  if(sum!==undefined){var sm=b.querySelector('.sm');sm.textContent=sum;sm.title=sum;}
  b.setAttribute('aria-label','Step '+(i+1)+': '+b.querySelector('.tt').textContent+(sum?'. '+sum:''));
}
function showPane(i,anim){
  $$('#viewer .pane').forEach(function(p,k){
    var on=k===i;p.hidden=!on;
    if(on&&anim){p.classList.remove('enter');void p.offsetWidth;p.classList.add('enter');}
  });
  STEP_BTNS().forEach(function(b,k){b.classList.toggle('viewing',k===i);});
}
function trunc(s,n){s=String(s).replace(/\s+/g,' ');return s.length>n?s.slice(0,n-1)+'\u2026':s;}
async function typeInto(pre,text,tok){
  if(reduce||instant){pre.textContent=text;return;}
  var step=Math.max(3,Math.ceil(text.length/12));
  for(var i=0;i<text.length;i+=step){pre.textContent=text.slice(0,i+step);await sleep(13);if(tok!==runToken)return;}
}
/* Stage painters: the playground and "How it works" both draw the four stages with these. */
function mkCall(agent,toolId,val,os,disabled,rules){
  var t=TOOLS[agent].filter(function(x){return x.id===toolId;})[0]||TOOLS[agent][0],input={},ti={};
  if(t.kind==='command')input.command=val;
  if(t.kind==='path'){input.path=val;input.access=t.access;}
  ti[t.field]=val;
  return {t:t,input:input,val:val,os:os,agent:agent,rules:rules,res:E.evaluate(input,os,disabled||{},rules),payload:{tool_name:t.id,tool_input:ti}};
}
function paintClean(n,c){ // raw and cleaned text with the removed / added characters marked; returns a one-line summary
  n.textContent='';
  var raw=c.t.kind==='command'?c.input.command:c.t.kind==='path'?c.input.path:null;
  if(raw===null||raw===undefined){
    n.appendChild(el('span','l','note'));n.appendChild(el('span','v dim','This tool is not one Cephalo checks, so there is nothing to clean. It is allowed and logged.'));
    return 'not checked';
  }
  var cleaned=c.t.kind==='command'?c.res.command:c.res.path,cl=cleaned[cleaned.length-1],d=charDiff(raw,cl),nd=d.del.filter(Boolean).length,ni=d.ins.filter(Boolean).length;
  n.appendChild(el('span','l','raw'));var rv=el('span','v');diffRun(rv,raw,d.del,'del','rm');n.appendChild(rv);
  n.appendChild(el('span','l','cleaned'));var cv=el('span','v');diffRun(cv,cl,d.ins,'ins','add');n.appendChild(cv);
  n.appendChild(el('span','l dim','how'));
  n.appendChild(el('span','v dim',cleaned.length===1?'Nothing to clean. Rules see the text as written.':'Struck-through characters were removed. Rules see both versions, and a match on either one blocks.'));
  n.appendChild(el('span','l dim','for'));n.appendChild(el('span','v dim',E.ADAPT[c.os].label+(c.t.kind==='path'?' path rules':' shell rules')));
  return cleaned.length===1||nd+ni===0?'no changes':(nd?'removed '+nd:'')+(nd&&ni?', ':'')+(ni?'added '+ni:'');
}
var ICON={pass:'\u2713',hit:'\u2715',na:'\u2013',off:'\u25CB',skip:'\u2013'};
var DESC={pass:'no match',hit:'',na:'does not apply',off:'switched off',skip:'wrong access type'};
async function paintTrace(tr,c,per,alive){ // rule rows one by one (per ms apart; 0 = at once); null if cancelled
  tr.textContent='';var res=c.res,pane=tr.closest('.pane');
  if(c.t.kind==='none'){tr.appendChild(rowEl('na','','(no rules apply)','Cephalo only inspects shell and file tools'));return 'no rules apply';}
  for(var i=0;i<res.steps.length;i++){
    var st=res.steps[i];
    var row=rowEl(st.state,ICON[st.state],st.rule.id,st.state==='hit'?st.rule.d+(st.via==='cleaned'?' (on cleaned text)':''):DESC[st.state]);
    if(st.state==='hit')row.insertBefore(el('span','stamp','MATCH'),row.querySelector('.d'));
    tr.appendChild(row);
    if(pane)pane.scrollTop=st.state==='hit'?Math.max(0,row.offsetTop-pane.clientHeight/2):pane.scrollHeight;
    if(per){await sleep(per);if(alive&&!alive())return null;}
  }
  var all=(c.rules||E.rulesFor(c.os));
  if(res.rule){
    var left=all.slice(res.steps.length);
    left.forEach(function(r){tr.appendChild(rowEl('later na','\u00B7',r.id,'not needed'));});
    if(left.length){var rr=el('div','row na');rr.appendChild(el('span','ic','\u00B7'));rr.appendChild(el('span',null,'First match wins. '+left.length+' later rule'+(left.length===1?'':'s')+' not needed.'));tr.insertBefore(rr,tr.children[res.steps.length]);}
    return '\u2715 '+res.rule.id;
  }
  var rest=el('div','row na');rest.appendChild(el('span','ic','\u2713'));rest.appendChild(el('span',null,'All '+res.total+' rules checked. None matched.'));tr.appendChild(rest);
  if(pane)pane.scrollTop=pane.scrollHeight;
  return '\u2713 none of '+res.total;
}
function paintDecision(v,c){ // badge, what the hook prints, the audit line; returns the sentence for screen readers
  v.textContent='';var res=c.res,block=res.decision==='block',t=c.t;
  v.appendChild(el('div','badge '+(block?'block':'allow'),block?'BLOCKED':'ALLOWED'));
  var right=el('div');
  var msg='\uD83D\uDED1 Cephalo blocked this (rule: '+(res.rule&&res.rule.id)+' - '+(res.rule&&res.rule.d)+'). If it is intended, ask the user to run it themselves.';
  right.appendChild(el('p',null,block?'The agent receives a refusal and the tool call never runs.':t.kind==='none'?'Not a tool Cephalo checks, so it is allowed and logged.':'No rule matched, so the call goes ahead.'));
  right.appendChild(el('div','lab-s','What the hook prints to the agent'));
  var hook=el('pre');
  if(block)highlight(hook,c.agent==='claude'?{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:msg}}:{action:'block',message:msg});
  else hook.textContent=c.agent==='claude'?'(nothing: empty output means allow)':'{}';
  right.appendChild(hook);
  right.appendChild(el('div','lab-s','Line appended to audit.jsonl'));
  var au={ts:new Date().toISOString(),agent:c.agent,tool:t.id};
  if(t.kind==='command')au.command=c.val;
  if(t.kind==='path')au.path=c.val;
  au.decision=res.decision;if(res.rule)au.rule=res.rule.id;
  var p3=el('pre');p3.textContent=JSON.stringify(au);right.appendChild(p3);
  v.appendChild(right);
  return block?'Blocked by rule '+res.rule.id+': '+res.rule.d:(t.kind==='none'?'Allowed: this tool is not checked.':'Allowed: no rule matched.');
}
async function runPlayground(){
  var tok=++runToken,val=$('#input').value;hasRun=true;quickVerdict();
  [0,1,2,3].forEach(function(i){setStep(i,null,'');});
  var c=mkCall(state.agent,state.tool,val,state.os,state.disabled),alive=function(){return tok===runToken;};
  setStep(0,'live');showPane(0,true);
  var pre=$('#payload');await typeInto(pre,JSON.stringify(c.payload,null,2),tok);if(!alive())return;
  highlight(pre,c.payload);
  setStep(0,'done',c.t.id+' \u00B7 '+val.length+' chars');
  await sleep(120);if(!alive())return;
  setStep(1,'live');showPane(1,true);
  var sum1=paintClean($('#norm'),c);
  await sleep(150);if(!alive())return;
  setStep(1,'done',sum1);
  setStep(2,'live');showPane(2,true);
  var sum2=await paintTrace($('#trace'),c,Math.min(28,Math.floor(560/Math.max(1,c.res.steps.length))),alive);if(sum2===null)return;
  await sleep(140);if(!alive())return;
  setStep(2,'done',sum2);
  setStep(3,'live');showPane(3,true);
  var say=paintDecision($('#verdict'),c);
  setStep(3,'done',c.res.decision==='block'?'\u2715 BLOCKED':'\u2713 ALLOWED');
  var lv=$('#decisionLive');lv.textContent='';setTimeout(function(){lv.textContent=say;},30);
  markSeen(val,c.res);
  $('#shareBtn').setAttribute('data-copy',shareUrl(val));
}
function shareUrl(val){
  var u=new URL(location.href);u.search='';u.hash='';
  u.searchParams.set('cmd',val);u.searchParams.set('agent',state.agent);u.searchParams.set('os',state.os);u.searchParams.set('tool',state.tool);
  return u.toString().split('#')[0]+'#playground';
}
function rowEl(cls,icon,id,desc){
  var r=el('div','row '+cls);r.appendChild(el('span','ic',icon));r.appendChild(el('span',null,id));r.appendChild(el('span','d',desc));return r;
}
function applyPreset(p){
  if(p.go){showEx(p.go);$('#commands').scrollIntoView({behavior:reduce?'auto':'smooth',block:'start'});return;}
  if(p.a&&p.a!==state.agent){state.agent=p.a;setSeg($('#segAgent'),p.a);setSeg($('#segPlug'),p.a);renderPlug();}
  if(p.os&&p.os!==state.os){setOs(p.os,true);}
  state.tool=p.t;fillTools();$('#input').value=p.v;runPlayground();
}
function setOs(os,keepRun){
  state.os=os;setSeg($('#segOs'),os);buildRuleList();renderPlat();renderNormer();if(window.renderHub)renderHub();
  if(!keepRun&&hasRun)runPlayground();
}
$('#segAgent').addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;state.agent=b.getAttribute('data-v');setSeg(this,state.agent);setSeg($('#segPlug'),state.agent);fillTools();renderPlug();if(hasRun)runPlayground();});
$('#segOs').addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;setOs(b.getAttribute('data-v'));});
$('#segTool').addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;state.tool=b.getAttribute('data-v');setSeg(this,state.tool);updateInputLabel();if(hasRun)runPlayground();});
$('#run').addEventListener('click',runPlayground);
$('#input').addEventListener('keydown',function(e){if(e.key==='Enter')runPlayground();});
$('#input').addEventListener('input',quickVerdict);
/* "Try a dangerous command" loads a real example into the playground */
$('#ctaDanger').addEventListener('click',function(e){e.preventDefault();applyPreset(PRESETS[0]);history.replaceState(null,'','#playground');$('#playground').scrollIntoView({behavior:reduce?'auto':'smooth',block:'start'});});
$('#chips').addEventListener('click',function(e){var b=e.target.closest('.chip');if(!b)return;applyPreset(PRESETS[+b.getAttribute('data-i')]);});
$('#stepper').addEventListener('click',function(e){var b=e.target.closest('.step');if(!b||!b.classList.contains('done')&&!b.classList.contains('live'))return;showPane(+b.getAttribute('data-s'),true);});
$('#ruleList').addEventListener('change',function(e){var cb=e.target;if(cb.type!=='checkbox')return;var id=cb.getAttribute('data-id');if(cb.checked)delete state.disabled[id];else state.disabled[id]=true;runPlayground();});
$('#rulesReset').addEventListener('click',function(){state.disabled={};buildRuleList();runPlayground();});
/* rules drawer: native popover; without popover support a class toggles it */
(function(){
  var d=$('#rulesDrawer'),btn=$('#rulesBtn');
  if(!('popover' in HTMLElement.prototype)){
    d.removeAttribute('popover');btn.removeAttribute('popovertarget');
    var close=$('#rulesDrawer .iconbtn');close.removeAttribute('popovertarget');
    function tog(open){d.classList.toggle('open',open);}
    btn.addEventListener('click',function(){tog(!d.classList.contains('open'));});
    close.addEventListener('click',function(){tog(false);});
    document.addEventListener('keydown',function(e){if(e.key==='Escape')tog(false);});
  }
})();
/* keyboard: / focuses the prompt unless you are already typing somewhere */
document.addEventListener('keydown',function(e){
  if(e.key!=='/'||e.ctrlKey||e.metaKey||e.altKey)return;
  var t=e.target;if(t&&(/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)||t.isContentEditable))return;
  e.preventDefault();var i=$('#input');i.scrollIntoView({block:'center',behavior:reduce?'auto':'smooth'});i.focus();i.select();
});
/* a shared link restores the state and runs it */
function fromUrl(){
  var q;try{q=new URL(location.href).searchParams;}catch(e){return false;}
  var cmd=q.get('cmd');if(cmd===null)return false;
  var a=q.get('agent'),o=q.get('os'),tl=q.get('tool');
  if(a==='claude'||a==='hermes'){state.agent=a;setSeg($('#segAgent'),a);setSeg($('#segPlug'),a);}
  if(o==='win32'||o==='darwin'||o==='linux'){state.os=o;setSeg($('#segOs'),o);}
  if(tl&&TOOLS[state.agent].some(function(t){return t.id===tl;}))state.tool=tl;
  fillTools();buildRuleList();$('#input').value=cmd.slice(0,600);
  return true;
}

/* ---------- without / with divider ---------- */
(function(){
  var sp=$('#split'),r=$('#splitRange');if(!sp)return;
  function set(){var v=+r.value;sp.style.setProperty('--split',v);r.setAttribute('aria-valuetext',v<=5?'All with Cephalo':v>=95?'All without Cephalo':v+' percent without Cephalo, '+(100-v)+' percent with');}
  r.addEventListener('input',set);set();
})();

/* ---------- How it works: the playground's stage painters, told on scroll ---------- */
(function(){
  var sec=$('#how');if(!sec)return;
  var CASES={linux:{v:"r''m -rf /tmp/build",os:'linux'},win32:{v:'r^d /s /q C:\\proj\\node_modules',os:'win32'}},cur='linux',call,played=false;
  function sums(c,s1){return [c.t.id+' \u00B7 '+c.val.length+' chars',s1,null,null];}
  /* the morph: surviving characters keep a view-transition-name, so they glide into place while the removed ones fade out */
  function chars(host,text,flags,gone){
    host.textContent='';var k=0;
    for(var i=0;i<text.length;i++){
      var sp=el('span','ch'+(flags[i]&&gone?' gone':''),text[i]);
      if(!flags[i])sp.style.viewTransitionName='vt'+(k++);
      host.appendChild(sp);
    }
  }
  function morph(){
    var host=$('#hwMorph'),raw=call.input.command,cl=call.res.command[call.res.command.length-1],d=charDiff(raw,cl);
    chars(host,raw,d.del,true);
    if(reduce||!document.startViewTransition){chars(host,cl,d.ins,false);return;}
    setTimeout(function(){
      document.documentElement.classList.add('vt-morph');
      var ran=false,once=function(){if(ran)return;ran=true;chars(host,cl,d.ins,false);};
      var vt=document.hidden?null:document.startViewTransition(once);
      if(vt)vt.finished.then(function(){document.documentElement.classList.remove('vt-morph');},function(){document.documentElement.classList.remove('vt-morph');});
      else document.documentElement.classList.remove('vt-morph');
      setTimeout(once,900);
    },reduce?0:500);
  }
  function build(){
    var k=CASES[cur];call=mkCall('claude','Bash',k.v,k.os,{});
    highlight($('#hwPayload'),call.payload);
    var s1=paintClean($('#hwNorm'),call);
    paintTrace($('#hwTrace'),call,0).then(function(s2){
      var s3=call.res.decision==='block'?'\u2715 BLOCKED':'\u2713 ALLOWED';paintDecision($('#hwVerdict'),call);
      var all=sums(call,s1);all[2]=s2;all[3]=s3;
      $$('#hnodes .hs').forEach(function(n,i){n.textContent=all[i]||'';});
    });
    var host=$('#hwMorph'),d=charDiff(call.input.command,call.res.command[call.res.command.length-1]);chars(host,call.input.command,d.del,true);played=false;
  }
  function stage(n){
    sec.setAttribute('data-stage',String(n));
    $$('#hnodes .hn').forEach(function(h,i){h.classList.toggle('on',i===n);h.classList.toggle('past',i<n);h.setAttribute('aria-current',i===n?'step':'false');});
    if(n===1&&!played){played=true;morph();}
  }
  $('#hwReplay').addEventListener('click',function(){played=true;morph();});
  $('#hwCase').addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;cur=b.getAttribute('data-v');setSeg(this,cur);build();stage(+sec.getAttribute('data-stage'));});
  if('IntersectionObserver' in window){
    var io=new IntersectionObserver(function(es){es.forEach(function(x){if(x.isIntersecting)stage(+x.target.getAttribute('data-s'));});},{rootMargin:'-45% 0px -50% 0px'});
    $$('.chap',sec).forEach(function(c){io.observe(c);});
  }
  near(sec,function(){build();stage(0);}); /* built as the section nears the screen */
})();

/* ---------- what it catches: examples open in the playground ---------- */
$('#bento').addEventListener('click',function(e){
  var b=e.target.closest('.exb');if(!b)return;
  applyPreset({a:b.getAttribute('data-a'),t:b.getAttribute('data-t'),v:b.getAttribute('data-v'),os:b.getAttribute('data-os')});
  $('#playground').scrollIntoView({behavior:reduce?'auto':'smooth',block:'start'});
});

/* hub and rules builder are wired after PLAT and setOs exist (see the end of this script) */
/* ---------- how it plugs in ---------- */
var PLUG_STEPS=[
  {h:'The agent is about to use a tool',p:'Bash, a file write, a read. Before it runs, the agent consults its pre-tool hook.'},
  {h:'The hook runs Cephalo',p:'The agent starts the registered command and hands it the tool call as JSON on stdin.'},
  {h:'Cephalo checks the rules',p:'It reads the command or path, cleans it for your OS, and tests your rules file in order.'},
  {h:'The decision comes back as JSON',p:'Allow lets the call proceed. Block returns a refusal the agent can read, and the call is skipped. A second hook, after the call, reads what came back for the tripwire and the vault.'}
];
var plugStep=0;
function plugCode(){
  var c=state.agent==='claude';
  var codes=[
    c?'{\n  "hooks": {\n    "PreToolUse": [{\n      "matcher": "Bash|Read|Write|Edit|MultiEdit|NotebookEdit|Grep|Glob|WebFetch|WebSearch|mcp__.*",\n      "hooks": [{ "type": "command",\n        "command": "node C:/Users/you/cephalo/dist/cli.js hook claude" }]\n    }]\n  }\n}'
     :'hooks:\n  pre_tool_call:\n    - matcher: "terminal|read_file|write_file|patch|search_files|execute_code|web_search|web_extract|mcp_.*"\n      command: "node C:/Users/you/cephalo/dist/cli.js hook hermes"\n      timeout: 10',
    c?'# stdin to: node cli.js hook claude\n{\n  "tool_name": "Bash",\n  "tool_input": { "command": "psql -c \\"DROP TABLE users;\\"" }\n}'
     :'# stdin to: node cli.js hook hermes\n{\n  "tool_name": "terminal",\n  "tool_input": { "command": "psql -c \\"DROP TABLE users;\\"" }\n}',
    '// inside Cephalo (src/hooks.ts, src/engine.ts)\nextract(payload)        // -> command or path + read/write\nvariants = [raw, cleaned]\nfor (rule of rules) {   // your rules.yml, then OS rules\n  if (rule matches any variant) return BLOCK(rule)\n}\nreturn ALLOW            // also writes one line to audit.jsonl',
    c?'# stdout, exit code 0\n{"hookSpecificOutput":{"hookEventName":"PreToolUse",\n  "permissionDecision":"deny",\n  "permissionDecisionReason":"\uD83D\uDED1 Cephalo blocked this (rule: no-drop ...)"}}\n\n# allowed calls print nothing'
     :'# stdout, exit code 0\n{"action":"block","message":"\uD83D\uDED1 Cephalo blocked this (rule: no-drop ...)"}\n\n# allowed calls print {}'
  ];
  return codes[plugStep];
}
function renderPlug(boot){
  var ol=$('#plugSteps');ol.textContent='';
  PLUG_STEPS.forEach(function(s,i){
    var li=el('li'),b=el('button','plugbtn');b.type='button';li.setAttribute('data-i',i);
    if(i===plugStep){li.setAttribute('aria-current','true');b.setAttribute('aria-current','step');}
    b.appendChild(el('span','plug-h',s.h));b.appendChild(el('span','plug-p',s.p));li.appendChild(b);ol.appendChild(li);
  });
  $('#plugTitle').textContent=[state.agent==='claude'?'settings.json, added by cephalo init':'config.yaml, added by cephalo init','what the agent sends','what Cephalo does','what Cephalo answers'][plugStep]+' \u00B7 '+(state.agent==='claude'?'Claude Code':'Hermes');
  $('#plugCode').textContent=plugCode();if(boot!=='boot')retrigger($('#plugCode'),'swap');
  var rows=state.agent==='claude'
   ?[['Bash','command'],['Read','file_path (read)'],['Write, Edit, MultiEdit','file_path (write)'],['NotebookEdit','notebook_path (write)'],['mcp__server__tool','server identity, tool, parameters (MCP firewall)'],['WebFetch, WebSearch, Grep, Glob','output only, read after the call (tripwire)']]
   :[['terminal','command'],['execute_code','code, scanned like a command (heuristic)'],['read_file, search_files','path (read)'],['write_file, patch','path (write)'],['mcp_server_tool','server identity, tool, parameters (MCP firewall)'],['web_search, web_extract, browser_*','output only, observed after the call (tripwire)']];
  var t=$('#cover');t.textContent='';
  var hr=el('tr');hr.appendChild(el('th',null,'Tool checked'));hr.appendChild(el('th',null,'Field used'));t.appendChild(hr);
  rows.forEach(function(r){var tr=el('tr'),a=el('td'),b=el('td');a.appendChild(el('code',null,r[0]));b.textContent=r[1];tr.appendChild(a);tr.appendChild(b);t.appendChild(tr);});
  var f=el('tr'),fc=el('td');fc.colSpan=2;fc.className='dim';fc.textContent='Every other tool is allowed and logged.';f.appendChild(fc);t.appendChild(f);
}
function plugPick(e){var li=e.target.closest('li');if(!li)return;var kb=document.activeElement&&document.activeElement.closest&&document.activeElement.closest('#plugSteps');plugStep=+li.getAttribute('data-i');renderPlug();if(kb)$('#plugSteps li[data-i="'+plugStep+'"] button').focus();}
$('#plugSteps').addEventListener('click',plugPick); /* each step is a real button, so Enter and Space click it */
$('#segPlug').addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;state.agent=b.getAttribute('data-v');setSeg(this,state.agent);setSeg($('#segAgent'),state.agent);fillTools();renderPlug();runPlayground();});

/* ---------- command explorer ---------- */
/* EX (the captured command output) comes from commands.js, loaded just before this script. */
var EX=window.EX||{};
var EX_ORDER=['test','doctor','rules','log','watch','init','mcp','tripwire','vault','incident','replay'];
var exP=new Player($('#exTerm')),exCur='test';
var EX_OK=EX_ORDER.every(function(k){return EX[k];});
function buildCmdList(){
  var box=$('#cmdList');
  EX_ORDER.forEach(function(k){
    var b=el('button');b.type='button';b.id='tab-'+k;b.tabIndex=k===exCur?0:-1;b.setAttribute('role','tab');b.setAttribute('aria-controls','exTerm');b.setAttribute('data-k',k);b.setAttribute('aria-selected',String(k===exCur));
    b.appendChild(el('span','c','cephalo '+k));b.appendChild(el('span','s2',EX[k].sub));box.appendChild(b);
  });
}
function showEx(k){
  if(!EX[k])return;
  exCur=k;$$('#cmdList button').forEach(function(b){var on=b.getAttribute('data-k')===k;b.setAttribute('aria-selected',String(on));b.tabIndex=on?0:-1;});$('#exTerm').setAttribute('aria-labelledby','tab-'+k);
  $('#exTitle').textContent=EX[k].cmd;$('#exExplain').textContent=EX[k].explain;
  retrigger($('#exTerm'),'swap');retrigger($('#exExplain'),'swap');
  exP.play(EX[k].script,false);
}
$('#cmdList').addEventListener('click',function(e){var b=e.target.closest('button');if(b)showEx(b.getAttribute('data-k'));});
$('#exReplay').addEventListener('click',function(){showEx(exCur);});
$('#cmdList').addEventListener('keydown',function(e){
  var keys={ArrowDown:1,ArrowRight:1,ArrowUp:-1,ArrowLeft:-1,Home:'h',End:'e'};if(!(e.key in keys))return;
  e.preventDefault();var i=EX_ORDER.indexOf(exCur),v=keys[e.key];
  i=v==='h'?0:v==='e'?EX_ORDER.length-1:(i+v+EX_ORDER.length)%EX_ORDER.length;
  showEx(EX_ORDER[i]);$('#tab-'+EX_ORDER[i]).focus();
});
if(EX_OK)buildCmdList();
else{var ex0=$('.explorer');if(ex0){ex0.insertAdjacentElement('beforebegin',el('p','callout','The command replays could not be loaded (commands.js is missing next to this page). The commands are listed in the README.'));}}

/* ---------- feature cards jump to the matching command replay ---------- */
$('#feat').addEventListener('click',function(e){
  var b=e.target.closest('.try');if(!b)return;
  var k=b.getAttribute('data-ex');if(!EX[k])return;
  showEx(k);
  $('#commands').scrollIntoView({behavior:reduce?'auto':'smooth',block:'start'});
});

/* ---------- plan calculator ---------- */
function renderSeats(){
  var inp=$('#seats'),n=parseInt(inp.value,10);
  if(!(n>=1))n=1;if(n>1000)n=1000;
  var o=$('#seatOut');o.textContent='';
  function money(x){return '$'+x.toLocaleString('en-US');}
  [['Free','$0'],['Pro',money(15*n)],['Team',money(25*n)]].forEach(function(r,i){
    if(i)o.appendChild(document.createTextNode('   ·   '));
    o.appendChild(document.createTextNode(r[0]+' '));o.appendChild(el('b',null,r[1]+(r[0]==='Free'?'':' / month')));
  });
  o.appendChild(document.createTextNode('   ·   Enterprise: annual contract'));
}
$('#seats').addEventListener('input',renderSeats);

/* ---------- platforms ---------- */
var PLAT={
  win32:{name:'Windows',claude:'%USERPROFILE%\\.claude\\settings.json',hermes:'%LOCALAPPDATA%\\hermes\\config.yaml',data:'%USERPROFILE%\\.cephalo',spawn:'through the shell (finds hermes.cmd)',
    clean:['backslashes to /','%VAR% and $env:VAR','~ and \\\\?\\ prefix','cmd ^ and PowerShell ` escapes','empty quotes: r\'\'m']},
  darwin:{name:'macOS',claude:'~/.claude/settings.json',hermes:'~/.hermes/config.yaml',data:'~/.cephalo',spawn:'directly, no shell',
    clean:['~ and $HOME','/private/etc, /var, /tmp','..  and // in paths','\\rm and r\\m escapes','empty quotes: r\'\'m']},
  linux:{name:'Linux',claude:'~/.claude/settings.json',hermes:'~/.hermes/config.yaml',data:'~/.cephalo',spawn:'directly, no shell',
    clean:['~ and $HOME','..  and // in paths','\\rm and r\\m escapes','line continuations','empty quotes: r\'\'m']}
};
function renderPlat(){
  var g=$('#plat');g.textContent='';
  var order=['win32','darwin','linux'];
  function row(label,fn){
    g.appendChild(el('div','rl',label));
    order.forEach(function(os){var c=el('div','pc'+(os===state.os?' sel':''));fn(c,os);g.appendChild(c);});
  }
  g.appendChild(el('div','rl',''));
  order.forEach(function(os){var c=el('div','pc h'+(os===state.os?' sel':''));var b=el('button','pick',PLAT[os].name);b.type='button';b.setAttribute('data-os',os);b.setAttribute('aria-pressed',String(os===state.os));c.appendChild(b);g.appendChild(c);});
  row('Claude settings',function(c,os){c.appendChild(el('code',null,PLAT[os].claude));});
  row('Hermes config',function(c,os){c.appendChild(el('code',null,PLAT[os].hermes));});
  row('Cephalo data',function(c,os){c.appendChild(el('code',null,PLAT[os].data));});
  row('Runs hermes',function(c,os){c.textContent=PLAT[os].spawn;});
  row('Cleans up',function(c,os){var t=el('div','tagrow');PLAT[os].clean.forEach(function(x){t.appendChild(el('span','tag',x));});c.appendChild(t);});
  row('Built-in rules',function(c,os){var t=el('div','tagrow');E.RULES[os].forEach(function(r){t.appendChild(el('span','tag'+(r.os==='posix'||r.os==='system'?' posix':''),r.id));});c.appendChild(t);});
}
$('#plat').addEventListener('click',function(e){var b=e.target.closest('.pick');if(b)setOs(b.getAttribute('data-os'));});

/* ---------- rules you own ---------- */
(function(){
  var root=$('#rb');if(!root)return;
  var uid=0,MAX=8,sel=0,prevSet=null,anim=!reduce&&!!document.startViewTransition;
  function mk(id,d,t,p){return {u:++uid,id:id,d:d,t:t,on:'any',p:p,a:'block',sh:false};}
  var rules=[mk('no-prod-db','psql against the production database','command','\\bpsql\\b.*\\bprod\\b'),
    mk('no-npm-publish','Publishing a package to npm','command','\\bnpm\\s+publish\\b'),
    mk('no-terraform-destroy','Destroying infrastructure','command','\\bterraform\\s+destroy\\b')];
  var kind='command',dragU=null;
  function yq(v){return v===''||/^[\s'"\[\]{}&*!|>%@`#?,-]|: | #|:$|\s$/.test(v)?"'"+v.replace(/'/g,"''")+"'":v;}
  function check(r){
    if(!r.id.trim())return 'Give the rule an id.';
    if(rules.some(function(o){return o!==r&&o.id===r.id;}))return 'Another rule already uses this id.';
    if(!r.p)return 'Add a pattern. An empty pattern would match everything, so it is left out of the test.';
    try{new RegExp(r.p,'i');}catch(e){return 'Not a valid regular expression, so this rule is left out of the test.';}
    return '';
  }
  function yamlLines(){
    var L=[{c:1,t:'# Cephalo rules. Patterns are case-insensitive JavaScript regexes.'},{c:1,t:'# type: command | path    on (path rules only): read | write | any'},{c:1,t:'# action: block (default) | allow (an exception) | ask (you approve or deny)    shadow: true logs what the rule would do and lets the call through'},{t:'rules:',k:'rules',v:''}];
    rules.forEach(function(r){
      L.push({i:'  - ',k:'id',v:yq(r.id)});L.push({i:'    ',k:'description',v:yq(r.d)});L.push({i:'    ',k:'type',v:r.t});
      if(r.t==='path')L.push({i:'    ',k:'on',v:r.on});
      L.push({i:'    ',k:'pattern',v:yq(r.p)});L.push({i:'    ',k:'action',v:r.a});
      if(r.sh)L.push({i:'    ',k:'shadow',v:'true'});
    });
    return L;
  }
  function lineText(l){return l.c?l.t:(l.i||'')+l.k+':'+(l.v?' '+l.v:'');}
  function renderYaml(){
    var L=yamlLines(),pre=$('#rbYaml'),code=el('code'),set={},all=[];
    L.forEach(function(l){
      var t=lineText(l),d=el('span','yl'+(l.c?' cm':''));all.push(t);set[t]=1;
      if(prevSet&&!prevSet[t]&&!reduce)d.classList.add('flash');
      if(l.c)d.textContent=t;else{d.appendChild(document.createTextNode(l.i||''));d.appendChild(el('span','k',l.k));d.appendChild(document.createTextNode(':'+(l.v?' ':'')));if(l.v)d.appendChild(el('span','s',l.v));}
      code.appendChild(d);
    });
    prevSet=set;pre.textContent='';pre.appendChild(code);$('#rbCopy').setAttribute('data-copy',all.join('\n')+'\n');
  }
  function renderList(focusSel){
    var ol=$('#rbList');ol.textContent='';
    rules.forEach(function(r,i){
      var li=el('li','rbi');li.setAttribute('data-u',r.u);li.draggable=true;li.style.viewTransitionName='rb'+r.u;
      var b=el('button','rbsel');b.type='button';b.setAttribute('aria-pressed',String(i===sel));b.setAttribute('data-i',i);
      b.appendChild(el('span','no',String(i+1)));b.appendChild(el('span','nm',r.id||'(no id)'));b.appendChild(el('span','ty',r.t));li.appendChild(b);
      [['\u25B2',-1,'up'],['\u25BC',1,'down']].forEach(function(m){
        var mv=el('button','mv',m[0]);mv.type='button';mv.setAttribute('data-d',m[1]);mv.setAttribute('data-i',i);mv.setAttribute('aria-label','Move '+(r.id||'rule')+' '+m[2]);
        if((m[1]<0&&i===0)||(m[1]>0&&i===rules.length-1))mv.disabled=true;li.appendChild(mv);
      });
      ol.appendChild(li);
    });
    $('#rbDel').disabled=rules.length<2;$('#rbAdd').disabled=rules.length>=MAX;
  }
  function loadForm(){
    var r=rules[sel];$('#rbId').value=r.id;$('#rbDesc').value=r.d;$('#rbPat').value=r.p;
    setSeg($('#rbType'),r.t);setSeg($('#rbOn'),r.on);setSeg($('#rbAct'),r.a);$('#rbShadow').checked=!!r.sh;$('#rbOnF').hidden=r.t!=='path';$('#rbErr').textContent=check(r);
  }
  function engineRules(){
    var mine=[];rules.forEach(function(r){if(check(r))return;mine.push({id:r.id,d:r.d,t:r.t,on:r.t==='path'?r.on:undefined,p:r.p,a:r.a,sh:r.sh,o:'custom'});});
    return mine.concat(E.rulesFor(state.os));
  }
  function runTest(){
    var v=$('#rbIn').value,input=kind==='command'?{command:v}:{path:v,access:kind},res=E.evaluate(input,state.os,{},engineRules());
    var box=$('#rbRes');box.textContent='';var block=res.decision==='block',ask=res.decision==='ask';
    box.appendChild(el('div','badge '+(block?'block':ask?'ask':'allow'),block?'BLOCKED':ask?'ASK':'ALLOWED'));
    var right=el('div'),msg;
    var who=function(r){return r.o==='custom'?'Your rule '+r.id:'A built-in rule, '+r.id;};
    if(!v.trim())msg='Type something to test.';
    else if(block)msg=res.rule.o==='custom'?'Your rule '+res.rule.id+' matched, and it was checked before the built-in rules.':'A built-in rule, '+res.rule.id+', matched. '+res.rule.d+'.';
    else if(ask)msg=who(res.rule)+' says ask. Claude Code shows you an approval prompt. Hermes, Codex and Cursor cannot, so there it follows ask-default in config.yml (block unless you change it).';
    else if(res.allowedBy)msg=who(res.allowedBy)+' is an allow rule and matched first, so later rules are skipped (Cephalo\u2019s own protections still apply).';
    else msg='No rule matched, so the call would go ahead.';
    if(res.shadow&&res.shadow.length)msg+=' Shadow mode: '+res.shadow.map(function(x){return x.rule.id+' would '+x.would;}).join(', ')+' (logged, not enforced).';
    right.appendChild(el('p',null,msg));
    var chips=el('div','rbchips');
    res.steps.forEach(function(st){
      if(st.rule.o!=='custom')return;
      chips.appendChild(el('span','rbchip '+(st.state==='hit'?(st.rule.a==='ask'?'ask':'hit'):st.state==='allow'?'pass':st.state==='shadow'?'shadow':st.state==='pass'?'pass':'skip'),(st.state==='hit'?(st.rule.a==='ask'?'? ':'\u2715 '):st.state==='allow'||st.state==='pass'?'\u2713 ':'\u2013 ')+st.rule.id+(st.state==='hit'?(st.rule.a==='ask'?' ASK':' MATCH'):st.state==='allow'?' ALLOW (exception)':st.state==='shadow'?' would '+(st.rule.a||'block')+' (shadow)':st.state==='exempt'?' skipped after allow':st.state==='pass'?' no match':st.state==='na'?' n/a':'')));
    });
    var reached={};res.steps.forEach(function(st){reached[st.rule.id]=1;});
    rules.forEach(function(r){if(!check(r)&&!reached[r.id])chips.appendChild(el('span','rbchip skip','\u2013 '+r.id+' not needed'));});
    right.appendChild(chips);box.appendChild(right);
    $('#rbOs').textContent=E.ADAPT[state.os].label+' rules follow yours';
  }
  function refresh(){renderList();renderYaml();runTest();}
  function reorder(fn,label){
    var apply=function(){fn();renderList();renderYaml();runTest();};
    if(anim&&!document.hidden){
      var h=document.documentElement,ran=false,once=function(){if(ran)return;ran=true;apply();};
      h.classList.add('vt-morph');var vt=document.startViewTransition(once);var done=function(){h.classList.remove('vt-morph');};vt.finished.then(done,done);
      setTimeout(once,400); /* never leave the list stale if the browser does not run the transition */
    }else apply();
    if(label)$('#rbLive').textContent=label;
  }
  function moveTo(from,to){
    if(to<0||to>=rules.length||from===to)return;
    var r=rules[from],cur=rules[sel];
    reorder(function(){rules.splice(from,1);rules.splice(to,0,r);sel=rules.indexOf(cur);},r.id+' moved to position '+(to+1)+' of '+rules.length);
  }
  $('#rbList').addEventListener('click',function(e){
    var b=e.target.closest('button');if(!b||b.disabled)return;var i=+b.getAttribute('data-i');
    if(b.classList.contains('mv')){
      var to=i+(+b.getAttribute('data-d'));moveTo(i,to);
      var r=rules[to];setTimeout(function(){var nb=$('#rbList .rbi[data-u="'+r.u+'"] .mv[data-d="'+b.getAttribute('data-d')+'"]');if(nb&&!nb.disabled)nb.focus();else{var o=$('#rbList .rbi[data-u="'+r.u+'"] .mv:not(:disabled)');if(o)o.focus();}},anim?400:0);
      return;
    }
    sel=i;renderList();loadForm();
  });
  var ol=$('#rbList');
  ol.addEventListener('dragstart',function(e){var li=e.target.closest('.rbi');if(!li)return;dragU=+li.getAttribute('data-u');li.classList.add('dragging');e.dataTransfer.effectAllowed='move';try{e.dataTransfer.setData('text/plain',String(dragU));}catch(x){}});
  ol.addEventListener('dragend',function(){dragU=null;$$('.rbi.dragging',ol).forEach(function(n){n.classList.remove('dragging');});});
  ol.addEventListener('dragover',function(e){if(dragU!==null)e.preventDefault();});
  ol.addEventListener('drop',function(e){
    var li=e.target.closest('.rbi');if(!li||dragU===null)return;e.preventDefault();
    var from=rules.findIndex(function(r){return r.u===dragU;}),to=rules.findIndex(function(r){return r.u===+li.getAttribute('data-u');});
    dragU=null;moveTo(from,to);
  });
  function edit(fn){var r=rules[sel];fn(r);$('#rbErr').textContent=check(r);renderList();renderYaml();runTest();}
  $('#rbId').addEventListener('input',function(){var v=this.value;edit(function(r){r.id=v;});});
  $('#rbDesc').addEventListener('input',function(){var v=this.value;edit(function(r){r.d=v;});});
  $('#rbPat').addEventListener('input',function(){var v=this.value;edit(function(r){r.p=v;});});
  $('#rbType').addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;var v=b.getAttribute('data-v');setSeg(this,v);$('#rbOnF').hidden=v!=='path';edit(function(r){r.t=v;});});
  $('#rbAct').addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;var v=b.getAttribute('data-v');setSeg(this,v);edit(function(r){r.a=v;});});
  $('#rbShadow').addEventListener('change',function(){var v=this.checked;edit(function(r){r.sh=v;});});
  $('#rbOn').addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;var v=b.getAttribute('data-v');setSeg(this,v);edit(function(r){r.on=v;});});
  $('#rbAdd').addEventListener('click',function(){
    if(rules.length>=MAX)return;var n=1;while(rules.some(function(r){return r.id==='my-rule-'+n;}))n++;
    rules.push(mk('my-rule-'+n,'What this rule stops','command',''));sel=rules.length-1;refresh();loadForm();$('#rbId').focus();$('#rbId').select();
  });
  $('#rbDel').addEventListener('click',function(){
    if(rules.length<2)return;var gone=rules.splice(sel,1)[0];sel=Math.min(sel,rules.length-1);refresh();loadForm();$('#rbLive').textContent='Deleted '+gone.id;
  });
  $('#rbKind').addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;kind=b.getAttribute('data-v');setSeg(this,kind);runTest();});
  $('#rbIn').addEventListener('input',runTest);
  [['terraform destroy -auto-approve','command'],['psql -h prod-db -c "select 1"','command'],['npm publish','command'],['git status','command'],['rm -rf ./build','command']].forEach(function(x){
    var c=el('button','chip',x[0]);c.type='button';c.addEventListener('click',function(){kind=x[1];setSeg($('#rbKind'),kind);$('#rbIn').value=x[0];runTest();});$('#rbChips').appendChild(c);
  });
  root.__rbRefresh=runTest;
  near(root,function(){loadForm();refresh();}); /* built as the section nears the screen */
})();

/* ---------- platforms hub: the selected OS lights up ---------- */
function renderHub(){
  $$('.hub .os').forEach(function(n){var on=n.getAttribute('data-os')===state.os;n.classList.toggle('on',on);n.setAttribute('aria-pressed',String(on));});
  $$('.hub .ln.hot').forEach(function(n){n.classList.toggle('on',n.getAttribute('data-os')===state.os);});
  var cap=$('#hubCap');if(cap)cap.textContent=PLAT[state.os].name+' adapter';
  var rb=$('#rb');if(rb&&rb.__rbRefresh)rb.__rbRefresh();
}
$$('.hub .os').forEach(function(n){
  n.addEventListener('click',function(){setOs(n.getAttribute('data-os'));});
  n.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();setOs(n.getAttribute('data-os'));}});
});

window.renderHub=renderHub;renderHub();
/* ---------- cleaner widget ---------- */
var NORM_EX=[
  {n:"r''m",v:"r''m -rf /tmp/x"},{n:'\\rm',v:'\\rm -rf ~/work'},{n:'cmd ^',v:'r^d /s /q C:\\x'},{n:'PS backtick',v:'Remove`-Item x -Recurse -Force'},
  {n:'.. path',v:'~/proj/../.claude/settings.json'},{n:'%VAR% path',v:'%USERPROFILE%\\.env'},{n:'macOS /private',v:'/private/etc/hosts'}
];
function renderNormer(){
  $('#normOsLabel').textContent=E.ADAPT[state.os].label+' adapter';
  var box=$('#normChips');if(!box.childNodes.length){NORM_EX.forEach(function(x,i){var c=el('button','chip',x.n);c.type='button';c.setAttribute('data-i',i);box.appendChild(c);});}
  var raw=$('#normIn').value,out=$('#normOut');out.textContent='';
  if(!raw){out.appendChild(el('span','dim','Type or pick an example.'));$('#normNote').textContent='';return;}
  var a=E.ADAPT[state.os],nc=a.normalizeCommand(raw),np=a.normalizePath(raw,E.envFor(state.os),E.HOMES[state.os]);
  function line(l,v){var d=el('div');d.appendChild(el('span','dim',l+'  '));var s=el('span');diffMark(s,raw,v);d.appendChild(s);out.appendChild(d);}
  line('as command',nc);line('as path   ',np);
  $('#normNote').textContent=(nc===raw&&np===raw)?'Nothing to clean here: both forms equal what you typed.':'Highlighted parts changed. Cephalo checks the raw text and these cleaned forms, and a match on any blocks.';
}
$('#normIn').addEventListener('input',renderNormer);
$('#normChips').addEventListener('click',function(e){var b=e.target.closest('.chip');if(!b)return;$('#normIn').value=NORM_EX[+b.getAttribute('data-i')].v;renderNormer();});

/* ---------- install checklist ---------- */
var KEY='cephalo-site-install-v1',done={};
try{done=JSON.parse(localStorage.getItem(KEY)||'{}')||{};}catch(e){done={};}
function save(){try{localStorage.setItem(KEY,JSON.stringify(done));}catch(e){}}
function renderInstall(){
  var steps=$$('.istep'),n=0;
  steps.forEach(function(s){var i=s.getAttribute('data-step'),d=!!done[i];if(d)n++;s.classList.toggle('done',d);$('.chk',s).setAttribute('aria-pressed',String(d));});
  $('#progBar').style.transform='scaleX('+(n/steps.length)+')';
  $('#progText').textContent=n===steps.length?'All done. Cephalo is on watch.':n+' of '+steps.length+' steps done';
}
$('#isteps').addEventListener('click',function(e){var b=e.target.closest('.chk');if(!b)return;var s=b.closest('.istep'),i=s.getAttribute('data-step');done[i]=!done[i];save();renderInstall();});
$('#progReset').addEventListener('click',function(){done={};save();renderInstall();});
function renderShell(sh,os){
  setSeg($('#segShell'),sh);
  var cmds='npm install -g @nomajorconcerns/cephalo'; /* the same on every system */
  $('#buildCmds').textContent=cmds;
}
$('#segShell').addEventListener('click',function(e){var b=e.target.closest('button');if(b)renderShell(b.getAttribute('data-v'));});

/* ---------- boot ---------- */
$$('.seg.slide').forEach(function(g){if(!g.querySelector('.thumb'))g.insertBefore(el('span','thumb'),g.firstChild);});
setSeg($('#segOs'),state.os);setSeg($('#segAgent'),state.agent);
requestAnimationFrame(function(){requestAnimationFrame(function(){$$('.seg.slide').forEach(function(g){g.classList.add('ready');});});});
renderShell(state.os==='win32'?'ps':'sh',state.os);
var linked=false;
/* the rest is below the fold: build it in small idle-time steps so no single task blocks the page */
function idle(f){if(window.requestIdleCallback)requestIdleCallback(f,{timeout:600});else setTimeout(f,16);}
function endInstant(){instant=false;}
/* run fn once when el comes within 800px of the screen (sections far below the fold are only built when needed) */
function near(node,fn){if(!node||!('IntersectionObserver' in window))return fn();var io=new IntersectionObserver(function(es){if(es.some(function(x){return x.isIntersecting;})){io.disconnect();fn();}},{rootMargin:'800px 0px'});io.observe(node);}
var later=[function(){fillTools();buildChips();$('#input').value='psql -c "DROP TABLE users;"';linked=fromUrl();quickVerdict();},buildRuleList,function(){renderPlug('boot');},renderPlat,renderNormer,renderInstall,renderSeats,function(){
  near($('#commands'),function(){if(!$('#exTerm').childNodes.length)showEx(exCur);});
},function(){
  /* show a finished result as the playground nears the screen (at once for a shared link), then replay it animated the first time it is in view */
  var ran=false;
  function first(){if(ran||hasRun)return;ran=true;instant=true;runPlayground().then(function(){endInstant();hasRun=linked;},function(e){endInstant();console.error(e);});}
  if(linked)first();else near($('#result'),first);
  if('IntersectionObserver' in window&&!reduce){
    var started=false;
    new IntersectionObserver(function(es,o){es.forEach(function(x){if(x.isIntersecting&&!started){started=true;o.disconnect();if(!ran&&!hasRun)first();else if(!linked)runPlayground();}});},{threshold:.15}).observe($('#result'));
  }
}];
function drain(){var f=later.shift();if(!f)return;f();if(later.length)idle(drain);}
idle(drain);

/* used by home.js (hero, update demo, rules explorer) */
export { E, $, $$, el, live, reduce, applyPreset };
