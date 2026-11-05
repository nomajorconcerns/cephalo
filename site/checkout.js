/* Turns the inert "Not on sale yet" plan buttons into real checkout links, driven by checkout.config.js.
 * No network requests, no tracking: it only sets link targets. With JavaScript off, or an empty config, the
 * page keeps the honest default ("Not on sale yet"). */
(function () {
  'use strict';

  var HOST = '.lemonsqueezy.com';
  var EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

  /** An https URL on the payment provider's domain, or null. Anything else is ignored. */
  function checkoutUrl(u) {
    if (typeof u !== 'string' || !u) return null;
    try {
      var x = new URL(u);
      if (x.protocol !== 'https:' || x.username || x.password) return null;
      if (x.hostname.slice(-HOST.length) !== HOST) return null;
      return x.href;
    } catch (e) {
      return null;
    }
  }

  function wantsTest(search) {
    return /(^|[?&])checkout=test(&|$)/.test(search || '');
  }

  /** What one plan's button should be. plan: pro | team | enterprise. */
  function resolve(cfg, plan, search) {
    var inert = { kind: 'inert', label: 'Not on sale yet' };
    cfg = cfg || {};
    var p = (cfg.plans || {})[plan] || {};
    if (plan === 'enterprise') {
      if (typeof p.email === 'string' && EMAIL.test(p.email)) {
        return { kind: 'mail', label: 'Contact us', href: 'mailto:' + p.email + '?subject=' + encodeURIComponent('Cephalo Enterprise') };
      }
      return inert;
    }
    if (cfg.mode === 'live') {
      var live = checkoutUrl(p.live);
      return live ? { kind: 'link', label: plan === 'pro' ? 'Subscribe to Pro' : 'Subscribe to Team', href: live } : inert;
    }
    if (cfg.mode === 'test' && wantsTest(search)) {
      var test = checkoutUrl(p.test);
      return test ? { kind: 'link', label: 'Test checkout (no real charge)', href: test, test: true } : inert;
    }
    return inert;
  }

  /** Words that change when something is really for sale. Everything else on the page stays as written. */
  function copy(cfg, results) {
    var anyLink = results.some(function (r) { return r.kind === 'link' && !r.test; });
    var anyTest = results.some(function (r) { return r.test; });
    var who = (cfg && cfg.provider) || 'the payment provider';
    if (anyLink) {
      return {
        head: 'Everything in version 0.1.1 stays free. Pro and Team add the new features marked Launching Nov 10, and exist only once they are built, tested and released.',
        note: 'Nothing checks a licence today. Everything marked Built is in version 0.1.1 and is free. Pro and Team are for the new features, which do not exist until they are released. Checkout is run by ' + who + ', which sells the subscription and sends receipts. Prices ($15 Pro, $25 Team, per developer per month) may change. The CEPHALOG code (20% off the first year) works from launch day. Lines marked Planned are not built.',
      };
    }
    if (anyTest) return { head: null, note: null, banner: 'Test checkout links are showing because this address contains ?checkout=test. Other visitors still see "Not on sale yet". Test links charge nothing.' };
    return { head: null, note: null };
  }

  function apply(doc, cfg, search) {
    var els = doc.querySelectorAll('[data-plan]');
    var results = [];
    Array.prototype.forEach.call(els, function (el) {
      var r = resolve(cfg, el.getAttribute('data-plan'), search);
      results.push(r);
      if (r.kind === 'inert') return;
      var a = doc.createElement('a');
      a.className = 'btn primary';
      a.href = r.href;
      a.rel = 'noopener';
      a.textContent = r.label;
      a.setAttribute('data-plan', el.getAttribute('data-plan'));
      if (r.test) a.setAttribute('data-test', '');
      el.parentNode.replaceChild(a, el);
    });
    var c = copy(cfg, results);
    var head = doc.querySelector('#pricing .sec-head > p:not(.eyebrow)');
    var note = doc.querySelector('#pricing .pricenote');
    if (c.head && head) head.textContent = c.head;
    if (c.note && note) note.textContent = c.note;
    if (c.banner && note) {
      var b = doc.createElement('p');
      b.className = 'pricenote';
      b.textContent = c.banner;
      note.parentNode.insertBefore(b, note);
    }
    var billing = checkoutUrl(cfg && cfg.billing);
    if (billing && cfg.mode === 'live' && note) {
      var p = doc.createElement('p');
      p.className = 'billing';
      var l = doc.createElement('a');
      l.href = billing;
      l.rel = 'noopener';
      l.textContent = 'Manage or cancel a subscription';
      p.appendChild(l);
      p.appendChild(doc.createTextNode(' (opens ' + ((cfg && cfg.provider) || 'the payment provider') + ')'));
      note.parentNode.insertBefore(p, note.nextSibling);
    }
    return results;
  }

  var api = { checkoutUrl: checkoutUrl, resolve: resolve, copy: copy, apply: apply };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    var run = function () { apply(document, window.CEPHALO_CHECKOUT, window.location.search); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
    else run();
  }
})();
