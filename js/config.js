/* WRI Staff Check-In — static config. All values here are public, non-secret.
 * Attached to `self` (not `window`) so sw.js can importScripts() this file.
 * API = the wri-gateway JSON API's PIN-free staff modes (staff-checkin /
 * staff-checkout POST actions; status/checkout/staffrefs/staffcontact/
 * staffusercerts GET modes). */
self.CONFIG = {
  // Dedicated gateway JSON API deployment (same one wri-respond uses).
  API_URL: 'https://script.google.com/macros/s/AKfycbx7p4-A8F6G_VedgHsw3RDJgwJK1GKVAFcvSah1JdjIdG5g7PAcvXhHRKHk_ULIhdL0KA/exec'
};
