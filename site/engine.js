// Cephalo rule engine for the site, ported from src/engine.ts and src/platform.ts.
// The rule data (site/rules.json) is generated from the built CLI by scripts/site-rules.mjs; scripts/site-rules.test.mjs
// checks that this engine and the CLI give the same verdict and rule.
export function createEngine(data){
  var RULES=data;
  var HOMES={win32:'C:\\Users\\you',darwin:'/Users/you',linux:'/home/you'};
  function posixNormalize(p){
    var abs=p.charAt(0)==='/',out=[],parts=p.split('/');
    for(var i=0;i<parts.length;i++){var s=parts[i];
      if(!s||s==='.')continue;
      if(s==='..'){if(out.length&&out[out.length-1]!=='..')out.pop();else if(!abs)out.push('..');}
      else out.push(s);}
    var r=(abs?'/':'')+out.join('/');
    return r||(abs?'/':'.');
  }
  function cleanSlashes(s){
    var unc=s.indexOf('//')===0&&s.indexOf('///')!==0;
    var n=posixNormalize(s.replace(/\/{2,}/g,'/'));
    return unc?'/'+n:n;
  }
  function expandPosixHome(raw,home){
    return raw.replace(/^~(?=$|[\\/])/,function(){return home;})
              .replace(/^\$\{HOME\}|^\$HOME(?![A-Za-z0-9_])/,function(){return home;});
  }
  function posixCmd(raw){
    return raw.replace(/\\\r?\n/g,' ')
      .replace(/(?<=\S)(''|"")(?=\S)/g,'')
      .replace(/(?<=[A-Za-z0-9])\\(?=[A-Za-z])/g,'')
      .replace(/(^|[\s;&|(])\\(?=[A-Za-z])/g,'$1');
  }
  var ADAPT={
    win32:{label:'Windows',
      normalizePath:function(raw,env,home){
        var s=raw.trim();
        s=s.replace(/^\\\\\?\\/,'');
        s=s.replace(/^~(?=$|[\\/])/,function(){return home;});
        s=s.replace(/%([A-Za-z0-9_]+)%/g,function(m,k){var v=env[k]!==undefined?env[k]:env[k.toUpperCase()];return v!==undefined?v:m;});
        s=s.replace(/\$env:([A-Za-z0-9_]+)/gi,function(m,k){var v=env[k]!==undefined?env[k]:env[k.toUpperCase()];return v!==undefined?v:m;});
        s=s.replace(/\\/g,'/');
        var m=s.match(/^([A-Za-z]:)(\/.*)?$/);
        if(m)return m[1]+cleanSlashes(m[2]||'/');
        return cleanSlashes(s);
      },
      normalizeCommand:function(raw){
        return raw.replace(/\^(?=[^\r\n])/g,'').replace(/`(?=\S)/g,'').replace(/(?<=\S)(''|"")(?=\S)/g,'');
      }},
    darwin:{label:'macOS',
      normalizePath:function(raw,env,home){
        var s=expandPosixHome(raw.trim(),home);
        s=cleanSlashes(s.replace(/\\/g,'/'));
        return s.replace(/^\/private(?=\/(etc|var|tmp)(\/|$))/,'');
      },
      normalizeCommand:posixCmd},
    linux:{label:'Linux',
      normalizePath:function(raw,env,home){return cleanSlashes(expandPosixHome(raw.trim(),home).replace(/\\/g,'/'));},
      normalizeCommand:posixCmd}
  };
  function envFor(os){var h=HOMES[os];return {USERPROFILE:h,HOME:h,LOCALAPPDATA:h+'\\AppData\\Local'};}
  function rulesFor(os){return RULES.defaults.concat(RULES[os]);}
  function variants(raw,norm){var n=raw;try{n=norm(raw);}catch(e){}return n===raw?[raw]:[raw,n];}
  /* The CLI also reads a command as parts (pipelines, bash -c, $(...)) from 0.2.0; this port checks the text only. */
  /* input: {command?, path?, access?}. disabled: object of rule ids -> true. Returns a full trace. */
  function evaluate(input,os,disabled,rulesOverride){
    disabled=disabled||{};
    var a=ADAPT[os];
    var cmds=input.command!==undefined?variants(input.command,a.normalizeCommand):[];
    var paths=input.path!==undefined?variants(input.path,function(p){return a.normalizePath(p,envFor(os),HOMES[os]);}):[];
    var rules=rulesOverride||rulesFor(os),steps=[],hit=null,allowedBy=null,shadow=[];
    for(var i=0;i<rules.length;i++){
      var r=rules[i];
      if(disabled[r.id]){steps.push({rule:r,state:'off'});continue;}
      var re;try{re=new RegExp(r.p,'i');}catch(e){steps.push({rule:r,state:'off'});continue;}
      var texts;
      if(r.t==='command'){
        if(!cmds.length){steps.push({rule:r,state:'na'});continue;}
        texts=cmds;
      }else{
        if(!paths.length){steps.push({rule:r,state:'na'});continue;}
        var on=r.on||'any',acc=input.access||'read';
        if(on!=='any'&&on!==acc){steps.push({rule:r,state:'skip'});continue;}
        texts=paths;
      }
      var hv=-1;for(var j=0;j<texts.length;j++){if(re.test(texts[j])){hv=j;break;}}
      if(hv<0){steps.push({rule:r,state:'pass'});continue;}
      var via=hv===0?'raw':'cleaned',act=r.a||'block';
      /* after an allow rule has matched, only Cephalo's own protections (r.l) are still checked */
      if(allowedBy&&!r.l){steps.push({rule:r,state:'exempt',via:via});continue;}
      if(act==='allow'){if(!allowedBy)allowedBy=r;steps.push({rule:r,state:'allow',via:via});continue;}
      if(r.sh){shadow.push({rule:r,would:act});steps.push({rule:r,state:'shadow',via:via});continue;}
      steps.push({rule:r,state:'hit',via:via});hit=r;break;
    }
    return {decision:hit?(hit.a==='ask'?'ask':'block'):'allow',rule:hit,allowedBy:allowedBy,shadow:shadow,steps:steps,total:rules.length,
            command:cmds,path:paths};
  }
  return {RULES:RULES,HOMES:HOMES,ADAPT:ADAPT,evaluate:evaluate,rulesFor:rulesFor,envFor:envFor};
}
