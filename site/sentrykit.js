/* The SentryKit section: the edition tabs (WAI-ARIA tabs: arrow keys, Home, End) and the scan replay.
 * Loaded by a small script in index.html when the section comes near the screen. Without it the page still works:
 * the Core edition shows (every edition, with JavaScript off), the full transcript is printed, and the links are plain links.
 * The replay never starts by itself, and it only re-prints the transcript already in the page (#skScript): the real,
 * unedited output of the SentryKit scripts. With reduced motion on, the transcript simply stays as it is. */
(function () {
  'use strict';
  var root = document.getElementById('sentrykit');
  if (!root || root.hasAttribute('data-ready')) return;
  root.setAttribute('data-ready', '');

  /* ---- tabs ---- */
  var tabs = Array.prototype.slice.call(root.querySelectorAll('[role="tab"]'));
  function select(tab, focus) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) tab.focus();
  }
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { select(t, false); });
    t.addEventListener('keydown', function (e) {
      var n = tabs.length;
      var j = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i + n - 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
      if (j < 0) return;
      e.preventDefault();
      select(tabs[j], true);
    });
  });

  /* ---- scan replay ---- */
  var demo = root.querySelector('.skdemo');
  var btn = document.getElementById('skRun');
  var screen = document.getElementById('skScreen');
  var script = document.getElementById('skScript');
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!demo || !btn || !screen || !script || reduce) return;

  var run = 0; // bumps on every start, so a replay cancels the one before it
  function el(tag, cls, html) {
    var x = document.createElement(tag);
    if (cls) x.className = cls;
    if (html != null) x.innerHTML = html;
    return x;
  }
  function idle() {
    screen.textContent = '';
    var pre = el('pre', null, '<span class="pr">~/acme-shop $ </span><span class="caret"></span>\n<span class="hint">Press Run scan to replay real SentryKit output.</span>');
    screen.appendChild(pre);
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function bottom() { screen.scrollTop = screen.scrollHeight; }

  async function play() {
    var me = ++run;
    btn.textContent = 'Replay'; // stays enabled (and focused): pressing it again starts over
    screen.textContent = '';
    var chapters = script.querySelectorAll('.skch');
    for (var c = 0; c < chapters.length; c++) {
      var box = el('div', 'skch');
      box.appendChild(chapters[c].querySelector('.skch-h').cloneNode(true));
      var pre = el('pre');
      box.appendChild(pre);
      screen.appendChild(box);
      var lines = chapters[c].querySelector('pre').innerHTML.split('\n');
      for (var i = 0; i < lines.length; i++) {
        if (me !== run) return;
        if (i) pre.appendChild(document.createTextNode('\n'));
        var row = el('span', null, lines[i]);
        var cmd = lines[i].indexOf('<span class="pr">') === 0 ? row.querySelector('.cm') : null;
        if (cmd) {
          // type the command, then pause as a shell would while it runs
          var full = cmd.textContent;
          cmd.textContent = '';
          pre.appendChild(row);
          for (var k = 0; k < full.length; k += 3) {
            if (me !== run) return;
            cmd.textContent = full.slice(0, k + 3);
            bottom();
            await wait(14);
          }
          await wait(380);
        } else {
          pre.appendChild(row);
          bottom();
          await wait(32);
        }
      }
      await wait(260);
    }
  }

  demo.classList.add('anim'); // the transcript stays in the page for screen readers; the screen shows the replay
  script.removeAttribute('tabindex'); // visually hidden now, so it is not a keyboard stop
  screen.hidden = false;
  idle();
  btn.hidden = false;
  btn.addEventListener('click', function () { play(); });
})();
