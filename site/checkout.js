/* Checks the buy links on the page (a[data-skill]: the Cephalo agent guard skill and SentryKit, sold on Agensi).
 * Each link points at its Agensi page from checkout.config.js; a link that is not an Agensi skill page is switched off.
 * No network requests, no tracking: it only sets or removes link targets. With JavaScript off, the links in the HTML stay. */
(function () {
  'use strict';

  // Agensi, the marketplace that sells the skills. Exact hosts only: agensi.io.evil.com or evil-agensi.io never match.
  var SKILL_HOSTS = ['www.agensi.io', 'agensi.io'];
  var SKILL_PATH = /^\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/?$/;

  /** An https link to a skill page on Agensi (https://www.agensi.io/skills/<name>), or null. */
  function skillUrl(u) {
    if (typeof u !== 'string' || !u) return null;
    try {
      var x = new URL(u);
      if (x.protocol !== 'https:' || x.username || x.password || x.port) return null;
      if (SKILL_HOSTS.indexOf(x.hostname) < 0 || !SKILL_PATH.test(x.pathname)) return null;
      return x.href;
    } catch (e) {
      return null;
    }
  }

  /** Points each a[data-skill] at its Agensi page from cfg.skills; a link that is not an Agensi skill page is switched off. */
  function applySkills(doc, cfg) {
    var skills = (cfg && cfg.skills) || {};
    var out = [];
    Array.prototype.forEach.call(doc.querySelectorAll('a[data-skill]'), function (a) {
      var name = a.getAttribute('data-skill');
      var href = skillUrl(skills[name]) || skillUrl(a.getAttribute('href'));
      if (href) {
        a.setAttribute('href', href);
      } else {
        a.removeAttribute('href');
        a.setAttribute('aria-disabled', 'true');
      }
      out.push({ skill: name, href: href });
    });
    return out;
  }

  /** True only for a plain left click (or Enter, which the browser reports as one) on an Agensi skill link, with motion
   *  allowed. Ctrl/Cmd/Shift/Alt, middle clicks, links with a target or download, and reduced motion go to the browser. */
  function shouldSnatch(e, a, reduce) {
    if (reduce || !e || !a || e.defaultPrevented) return false;
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return false;
    if (a.getAttribute('target') || a.hasAttribute('download')) return false;
    return !!skillUrl(a.getAttribute('href'));
  }

  /** The Get Cephalo card's Buy link: a tentacle snatches the card (CSS, .snatched), then the browser follows the link.
   *  The link stays a real <a href>; this only delays a plain click. Navigates once, on animationend or after a timeout. */
  function tentacle(doc, win) {
    var card = doc.querySelector('.getcard');
    var a = card && card.querySelector('a[data-skill]');
    if (!a) return null;
    var sec = card.parentNode && card.parentNode.parentNode, timer = 0, gone = false;
    function go() {
      if (gone) return;
      gone = true;
      win.clearTimeout(timer);
      win.location.assign(a.href);
    }
    function reset() {
      win.clearTimeout(timer);
      gone = false;
      card.classList.remove('snatched');
      if (sec && sec.classList) sec.classList.remove('gc-snatching');
    }
    a.addEventListener('click', function (e) {
      var reduce = !!(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
      if (!shouldSnatch(e, a, reduce)) return;
      e.preventDefault();
      if (card.classList.contains('snatched')) return; // a second click while it runs
      card.classList.add('snatched');
      if (sec && sec.classList) sec.classList.add('gc-snatching');
      timer = win.setTimeout(go, 1100);
    });
    card.addEventListener('animationend', function (e) { if (e.target === card && e.animationName === 'gc-snatch') go(); });
    win.addEventListener('pageshow', function (e) { if (e.persisted) reset(); });
    return { go: go, reset: reset };
  }

  var api = { skillUrl: skillUrl, applySkills: applySkills, shouldSnatch: shouldSnatch, tentacle: tentacle };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    var run = function () { applySkills(document, window.CEPHALO_CHECKOUT); tentacle(document, window); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
    else run();
  }
})();
