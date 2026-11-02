/* Renders the "Open numbers" section from stats.json (written hourly by scripts/stats.mjs in the Pages workflow).
   Plain script, no libraries. Everything is built with textContent and SVG attributes, never innerHTML. */
(function () {
  var body = document.getElementById('stBody');
  if (!body) return;
  var NS = 'http://www.w3.org/2000/svg';

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function svg(tag, attrs) { var n = document.createElementNS(NS, tag); for (var k in attrs) n.setAttribute(k, attrs[k]); return n; }
  function num(n) { return typeof n === 'number' ? n.toLocaleString('en-US') : '\u2014'; }
  function date(s) { if (!s) return ''; var d = new Date(s); return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }
  function ago(s) {
    var d = new Date(s), m = Math.round((Date.now() - d) / 60000);
    if (isNaN(m)) return '';
    if (m < 2) return 'just now';
    if (m < 60) return m + ' minutes ago';
    var h = Math.round(m / 60);
    if (m < 60 * 36) return h + (h === 1 ? ' hour ago' : ' hours ago');
    var d2 = Math.round(m / 1440);
    return d2 + (d2 === 1 ? ' day ago' : ' days ago');
  }
  function setSeg(seg, v) { Array.prototype.forEach.call(seg.querySelectorAll('button'), function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === v)); }); }

  function tile(label, value, note, bad) {
    var t = el('div', 'stk' + (bad ? ' off' : ''));
    t.appendChild(el('div', 'sv', value));
    t.appendChild(el('div', 'sl', label));
    if (note) t.appendChild(el('div', 'sn', note));
    return t;
  }
  function card(title, sub) {
    var c = el('div', 'card stc'), h = el('div', 'hd', title);
    if (sub) { h.appendChild(el('span', 'sp')); h.appendChild(el('span', 'dim', sub)); }
    c.appendChild(h);
    var b = el('div', 'bd'); c.appendChild(b);
    return { card: c, body: b };
  }
  function why(sec, fallback) { return el('p', 'dim stwhy', sec && sec.error ? sec.error : fallback); }
  function stale(sec) { return sec && sec.stale ? 'Last good numbers from ' + date(sec.staleSince) + '; refreshing failed (' + sec.error + ').' : ''; }

  /* ---------- growth chart ---------- */
  function series(sec, days) {
    if (!sec || !sec.ok || !sec.daily || !sec.daily.length) return null;
    var map = {}; sec.daily.forEach(function (d) { map[d.day] = d.count; });
    var end = new Date(); end.setUTCHours(0, 0, 0, 0);
    var first = sec.daily[0].day, out = [];
    for (var i = days - 1; i >= 0; i--) {
      var d = new Date(end - i * 86400000), k = d.toISOString().slice(0, 10);
      if (k < first && out.length === 0) continue;
      out.push({ day: k, count: map[k] || 0 });
    }
    return out;
  }
  function chart(d) {
    var c = card('Growth over time', 'last 90 days'), st = { what: d.downloads && d.downloads.ok ? 'downloads' : 'visitors', total: false };
    var seg1 = el('div', 'seg'), seg2 = el('div', 'seg');
    seg1.setAttribute('role', 'group'); seg1.setAttribute('aria-label', 'Series'); seg2.setAttribute('role', 'group'); seg2.setAttribute('aria-label', 'Daily or running total');
    [['downloads', 'npm downloads'], ['visitors', 'Site visitors']].forEach(function (x) { var b = el('button', null, x[1]); b.type = 'button'; b.setAttribute('data-v', x[0]); seg1.appendChild(b); });
    [['day', 'Per day'], ['total', 'Running total']].forEach(function (x) { var b = el('button', null, x[1]); b.type = 'button'; b.setAttribute('data-v', x[0]); seg2.appendChild(b); });
    var bar = el('div', 'stbar2'); bar.appendChild(seg1); bar.appendChild(seg2);
    c.body.appendChild(bar);
    var host = el('div', 'stchart'); c.body.appendChild(host);
    function draw() {
      setSeg(seg1, st.what); setSeg(seg2, st.total ? 'total' : 'day');
      host.textContent = '';
      var sec = d[st.what], s = series(sec, 90);
      if (!s || s.length < 2) { host.appendChild(why(sec, 'No data yet.')); return; }
      var run = 0, vals = s.map(function (p) { return st.total ? (run += p.count) : p.count; }), max = Math.max.apply(null, vals) || 1;
      var W = 640, H = 200, P = 8, pts = vals.map(function (v, i) { return [P + (W - 2 * P) * i / (vals.length - 1), H - 22 - (H - 40) * v / max]; });
      var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
      var s1 = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'class': 'stsvg' });
      var total = vals[vals.length - 1];
      s1.setAttribute('aria-label', (st.what === 'downloads' ? 'npm downloads' : 'Site visitors') + ', ' + (st.total ? 'running total' : 'per day') + ', ' + date(s[0].day) + ' to ' + date(s[s.length - 1].day) + '. Highest value ' + num(max) + '.');
      [0, 0.5, 1].forEach(function (f) { var y = H - 22 - (H - 40) * f; s1.appendChild(svg('line', { x1: P, x2: W - P, y1: y, y2: y, 'class': 'grid' })); });
      s1.appendChild(svg('path', { d: line + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + (H - 22) + ' L' + P + ' ' + (H - 22) + ' Z', 'class': 'area' }));
      s1.appendChild(svg('path', { d: line, 'class': 'ln' }));
      var t1 = svg('text', { x: P, y: H - 4, 'class': 'ax' }); t1.textContent = date(s[0].day); s1.appendChild(t1);
      var t2 = svg('text', { x: W - P, y: H - 4, 'class': 'ax', 'text-anchor': 'end' }); t2.textContent = date(s[s.length - 1].day); s1.appendChild(t2);
      var t3 = svg('text', { x: P, y: 12, 'class': 'ax' }); t3.textContent = num(max); s1.appendChild(t3);
      host.appendChild(s1);
      var det = el('details', 'sttab'), sm = el('summary', null, 'Show as a table'), tbl = el('table'), cap = el('caption', 'sr', 'Last 30 days');
      det.appendChild(sm); tbl.appendChild(cap);
      var tr = el('tr'); ['Day', st.total ? 'Running total' : 'Count'].forEach(function (h) { tr.appendChild(el('th', null, h)); }); tbl.appendChild(tr);
      for (var i = vals.length - 1; i >= Math.max(0, vals.length - 30); i--) { var r = el('tr'); r.appendChild(el('td', null, date(s[i].day))); r.appendChild(el('td', null, num(vals[i]))); tbl.appendChild(r); }
      det.appendChild(tbl); host.appendChild(det);
      host.appendChild(el('p', 'dim stnote', (sec.note || '') + (stale(sec) ? ' ' + stale(sec) : '')));
    }
    seg1.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) { st.what = b.getAttribute('data-v'); draw(); } });
    seg2.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) { st.total = b.getAttribute('data-v') === 'total'; draw(); } });
    draw();
    return c.card;
  }

  /* ---------- bars ---------- */
  function bars(list, label, sec, emptyMsg) {
    var wrap = el('ul', 'stbars');
    if (!list || !list.length) return why(sec, emptyMsg);
    var max = list[0].count || 1;
    list.forEach(function (x, i) {
      var li = el('li'), row = el('div', 'r');
      row.appendChild(el('span', 'n', label(x))); row.appendChild(el('span', 'c', num(x.count)));
      var track = el('div', 'tr'), fill = el('i'); fill.style.setProperty('--w', (Math.max(0.03, x.count / max)).toFixed(3));
      track.appendChild(fill); li.appendChild(row); li.appendChild(track); wrap.appendChild(li);
    });
    requestAnimationFrame(function () { requestAnimationFrame(function () { wrap.classList.add('in'); }); });
    return wrap;
  }

  function render(d) {
    body.textContent = '';
    var up = document.getElementById('stUpdated');
    if (up) { up.textContent = ''; up.appendChild(document.createTextNode('Updated ')); var t = el('time', null, ago(d.generatedAt)); t.setAttribute('datetime', d.generatedAt); t.title = d.generatedAt; up.appendChild(t); up.appendChild(document.createTextNode(', then every hour.')); }

    var v = d.visitors, n = d.downloads, g = d.github, r = d.registry, tiles = el('div', 'sttiles');
    tiles.appendChild(tile('Site visitors, last 7 days', v.ok ? num(v.week) : '\u2014', v.ok ? 'GoatCounter' : (v.error || ''), !v.ok));
    tiles.appendChild(tile('Site visitors, last 30 days', v.ok ? num(v.month) : '\u2014', v.ok ? 'GoatCounter' : '', !v.ok));
    tiles.appendChild(tile('npm downloads, last 7 days', n.ok ? num(n.week) : '\u2014', n.ok ? 'npm' : (n.error || ''), !n.ok));
    tiles.appendChild(tile('npm downloads, last 30 days', n.ok ? num(n.month) : '\u2014', n.ok ? 'npm' : '', !n.ok));
    tiles.appendChild(tile('npm downloads, all time', n.ok ? num(n.total) : '\u2014', n.ok ? 'since the first release' : '', !n.ok));
    tiles.appendChild(tile('GitHub stars', g.ok ? num(g.stars) : '\u2014', g.ok ? num(g.forks) + ' forks, ' + num(g.openIssues) + ' open issues' : (g.error || ''), !g.ok));
    body.appendChild(tiles);
    var st = stale(v) || stale(n); if (st) body.appendChild(el('p', 'dim stnote', st));

    body.appendChild(chart(d));

    var geo = el('div', 'stgrid');
    var c1 = card('Countries', 'visitors, last 30 days');
    c1.body.appendChild(bars(v.ok ? v.countries : null, function (x) { return x.name; }, v, 'No visitor data yet.'));
    var c2 = card('Regions', 'within the top countries');
    c2.body.appendChild(bars(v.ok ? v.regions : null, function (x) { return x.name + ', ' + x.country; }, v, 'No visitor data yet.'));
    geo.appendChild(c1.card); geo.appendChild(c2.card); body.appendChild(geo);

    var two = el('div', 'stgrid');
    var rel = card('Release history', r.ok ? 'latest ' + (r.latest || 'none') : '');
    if (r.ok && r.versions.length) {
      var ol = el('ol', 'stlist');
      r.versions.slice().reverse().forEach(function (x) { var li = el('li'); li.appendChild(el('b', null, x.version)); if (x.version === r.latest) li.appendChild(el('span', 'tag', 'latest')); if (x.deprecated) li.appendChild(el('span', 'tag', 'deprecated')); li.appendChild(el('span', 'dim', date(x.date))); ol.appendChild(li); });
      rel.body.appendChild(ol);
    } else rel.body.appendChild(why(r, 'No releases found.'));
    var lk = el('p', 'dim stnote'); var a = el('a', null, 'Full changelog'); a.href = 'https://github.com/nomajorconcerns/cephalo/blob/master/CHANGELOG.md'; a.rel = 'noopener'; lk.appendChild(a); rel.body.appendChild(lk);

    var ms = card('Milestones', '');
    var m = d.milestones || { reached: [], next: [] };
    if (m.reached.length) {
      var ol2 = el('ol', 'stlist');
      m.reached.forEach(function (x) { var li = el('li'); li.appendChild(el('b', null, x.label)); li.appendChild(el('span', 'dim', date(x.date) || 'date not recorded')); ol2.appendChild(li); });
      ms.body.appendChild(ol2);
    } else ms.body.appendChild(el('p', 'dim', 'Nothing reached yet.'));
    (m.next || []).forEach(function (x) {
      var w = el('div', 'stnext'), row = el('div', 'r'); row.appendChild(el('span', 'n', 'Next: ' + x.label)); row.appendChild(el('span', 'c', num(x.have) + ' / ' + num(x.need)));
      var tr = el('div', 'tr'), f = el('i'); f.style.setProperty('--w', Math.max(0.02, Math.min(1, x.have / x.need)).toFixed(3)); tr.appendChild(f); w.appendChild(row); w.appendChild(tr);
      ms.body.appendChild(w);
    });
    two.appendChild(rel.card); two.appendChild(ms.card); body.appendChild(two);

    var rl = card('Reliability', '');
    var tl = el('div', 'sttiles small'), dp = g.ok ? g.deploys : null;
    tl.appendChild(tile('Site deploys that succeeded', dp && dp.runs ? dp.succeeded + ' of ' + dp.runs : '\u2014', dp && dp.runs ? 'last ' + dp.runs + ' runs on GitHub Actions' : 'no deploy history yet', !(dp && dp.runs)));
    tl.appendChild(tile('Last site deploy', dp && dp.lastAt ? ago(dp.lastAt) : '\u2014', dp && dp.lastConclusion ? dp.lastConclusion : '', !(dp && dp.lastAt)));
    tl.appendChild(tile('npm package', r.ok ? 'available' : 'not reachable', r.ok ? 'latest ' + r.latest : (r.error || ''), !r.ok));
    rl.body.appendChild(tl);
    rl.body.appendChild(el('p', 'dim stnote', 'The website is static pages on GitHub Pages and the command runs on your own machine, so there is no Cephalo server whose uptime could be measured here. These checks cover what can be measured: whether releases and site deploys succeed and whether the package is on npm.'));
    body.appendChild(rl.card);

    body.appendChild(el('p', 'dim stnote', 'Sources: ' + [d.sources.registry, d.sources.downloads, d.sources.github, d.sources.visitors].filter(Boolean).join(', ') + '. The raw numbers are in stats.json.'));
  }

  fetch('stats.json', { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(render).catch(function () {
    body.textContent = '';
    body.appendChild(el('p', 'callout', location.protocol === 'file:' ? 'The live numbers load on the published site. They are not available when this page is opened from a file.' : 'The numbers could not be loaded right now. Try again in a minute; they are rebuilt every hour.'));
  });
})();
