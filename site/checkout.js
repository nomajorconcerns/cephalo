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

  var api = { skillUrl: skillUrl, applySkills: applySkills };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    var run = function () { applySkills(document, window.CEPHALO_CHECKOUT); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
    else run();
  }
})();
