/* Buy links on the page. Cephalo itself is free; the only things for sale are skills on the Agensi marketplace.
 * Nothing here is secret: a link is a public URL. Never put an API key or webhook secret in this file.
 *
 * Each link must be an Agensi skill page, https://www.agensi.io/skills/<name> (or https://agensi.io/skills/<name>).
 * A link on any other host is switched off by checkout.js. Keep these the same as the links in index.html. */
window.CEPHALO_CHECKOUT = {
  skills: {
    "cephalo-agent-guard": "https://www.agensi.io/skills/cephalo-agent-guard",
    "sentrykit-lite": "https://www.agensi.io/skills/sentrykit-lite",
    "sentrykit-core": "https://www.agensi.io/skills/sentrykit-core",
    "sentrykit-pro": "https://www.agensi.io/skills/sentrykit-pro",
  },
};
