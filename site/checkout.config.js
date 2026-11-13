/* Checkout settings for the Plans section. This is the only file to edit to connect payments.
 * Nothing here is secret: a checkout link is a public URL. Never put an API key or webhook secret in this file.
 *
 * mode "off"   every paid plan shows "Not on sale yet" (the default).
 * mode "test"  visitors still see "Not on sale yet". Open the page with ?checkout=test to see and try the test links.
 * mode "live"  visitors see working buy buttons.
 *
 * Links must be Polar URLs: https://buy.polar.sh/... (a checkout link) or https://polar.sh/... (for example the customer
 * portal). The page ignores any other host. Enterprise is a contact button: set an email address and it shows in every mode. */
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
};
