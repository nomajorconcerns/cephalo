/* Checkout settings for the Plans section and the skill links. This is the only file to edit to connect payments.
 * Nothing here is secret: a checkout link is a public URL. Never put an API key or webhook secret in this file.
 *
 * Pro and Team (plans):
 * mode "off"   every paid plan shows "Not on sale yet" (the default).
 * mode "test"  visitors still see "Not on sale yet". Open the page with ?checkout=test to see and try the test links.
 * mode "live"  visitors see working buy buttons.
 * Plan links must be Polar URLs: https://buy.polar.sh/... (a checkout link) or https://polar.sh/... (for example the customer
 * portal). The page ignores any other host. Enterprise is a contact button: set an email address and it shows in every mode.
 *
 * Skills (sold on Agensi, separate from the plans; an Agensi purchase is a skill download and never a Pro or Team license):
 * each link must be an Agensi skill page, https://www.agensi.io/skills/<name> (or https://agensi.io/skills/<name>). The
 * page shows these links in every mode; a link on any other host is switched off. Keep them the same as the links in index.html. */
window.CEPHALO_CHECKOUT = {
  mode: "off",
  provider: "Polar",
  plans: {
    pro: { test: "", live: "" },
    team: { test: "", live: "" },
    enterprise: { email: "" },
  },
  /* Customer billing portal (manage or cancel a subscription), shown only in live mode. */
  billing: "",
  skills: {
    "cephalo-agent-guard": "https://www.agensi.io/skills/cephalo-agent-guard",
    "sentrykit-lite": "https://www.agensi.io/skills/sentrykit-lite",
    "sentrykit-core": "https://www.agensi.io/skills/sentrykit-core",
    "sentrykit-pro": "https://www.agensi.io/skills/sentrykit-pro",
  },
};
