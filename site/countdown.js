/* Countdown to the Cephalo 0.2.0 launch. Reads the launch time from data-launch on #cdBox (an ISO time with an offset),
 * so the date lives in the HTML and nowhere else. No network requests.
 *
 * Accessibility: the digits are aria-hidden and the timer is aria-live="off", so a screen reader never announces the
 * seconds. Its static text gives the launch date. It animates nothing, so prefers-reduced-motion needs no special case.
 * At zero the countdown is replaced by "Cephalo 0.2.0 is out" with a link to the install steps. */
(function () {
  'use strict';

  var pad = function (n) { return (n < 10 ? '0' : '') + n; };

  /** Whole days/hours/minutes/seconds left until `launchMs`, never negative. `done` is true at or after the launch. */
  function remaining(launchMs, nowMs) {
    var left = Math.max(0, launchMs - nowMs);
    var total = Math.floor(left / 1000);
    return {
      done: left <= 0,
      days: Math.floor(total / 86400),
      hours: Math.floor((total % 86400) / 3600),
      minutes: Math.floor((total % 3600) / 60),
      seconds: total % 60,
    };
  }

  /** Parse the launch time; null when it is not a valid date with an explicit offset (a bad date never starts a timer). */
  function parseLaunch(text) {
    if (typeof text !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(text)) return null;
    var ms = Date.parse(text);
    return isNaN(ms) ? null : ms;
  }

  function init(doc, win, now) {
    var clock = typeof now === 'function' ? now : function () { return Date.now(); };
    var box = doc.getElementById('cdBox');
    var out = doc.getElementById('cdOut');
    if (!box || !out) return null;
    var launch = parseLaunch(box.getAttribute('data-launch'));
    if (launch === null) return null;
    var label = doc.getElementById('cdLabel');
    var ids = { days: 'cdD', hours: 'cdH', minutes: 'cdM', seconds: 'cdS' };
    var timer = null;

    function show(r) {
      if (r.done) {
        box.hidden = true;
        out.hidden = false;
        if (timer) win.clearInterval(timer);
        return;
      }
      box.hidden = false;
      out.hidden = true;
      if (label) label.textContent = 'Cephalo 0.2.0 launches in';
      Object.keys(ids).forEach(function (k) {
        var el = doc.getElementById(ids[k]);
        var v = k === 'days' ? String(r[k]) : pad(r[k]);
        if (el && el.textContent !== v) el.textContent = v;
      });
    }

    function tick() { show(remaining(launch, clock())); }
    tick();
    if (!remaining(launch, clock()).done) timer = win.setInterval(tick, 1000);
    return { tick: tick };
  }

  var api = { remaining: remaining, parseLaunch: parseLaunch, init: init };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document !== 'undefined' && typeof window !== 'undefined') init(document, window);
})();
