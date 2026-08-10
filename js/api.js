/* WRI Respond — GAS JSON API transport (resilient).
 *
 * GET reads:  apiGet(mode, params)   -> resolves to `data` or rejects with {code,message}
 * POST writes: apiPost(action, payload) -> same
 *
 * Transport notes (must match Api.gs):
 *  - POST uses Content-Type text/plain to stay a CORS "simple request" (no
 *    preflight; GAS web apps don't answer OPTIONS). GAS 302-redirects to
 *    googleusercontent, which the browser follows and returns JSON with
 *    Access-Control-Allow-Origin:*.
 *  - Every response is HTTP 200; success/failure lives in the {ok,...} body.
 *  - No ArcGIS token is ever requested or received here.
 *
 * Resilience (added after the 2026-08 42-person check-in overload):
 *  - Request timeout (AbortController) so the UI never hangs on a stalled call.
 *  - Exponential backoff + jitter on transient failures — jitter decorrelates
 *    a crowd so retries don't stampede in sync.
 *  - Non-JSON detection: under overload GAS returns an HTML error page, not
 *    JSON; treat it as transient and retry instead of throwing a parse error.
 *  - Every POST carries an idempotency_key, reused across retries. Api.gs
 *    replays the first successful response for a repeated key, so a retried
 *    check-in whose response was lost can never write twice.
 */
(function () {
  var MAX_ATTEMPTS = 4;        // 1 try + 3 retries
  var BASE_DELAY_MS = 600;     // 0.6s, 1.2s, 2.4s (pre-jitter)
  var TIMEOUT_MS = 30000;      // GAS cold starts run ~10s; abort runaways

  // Server codes that mean "rejected before doing work" -> safe to retry.
  var RETRYABLE_CODES = { rate_limited: 1, server_error: 1 };

  function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  function backoff(attempt) {
    var d = BASE_DELAY_MS * Math.pow(2, attempt - 1);
    return d + Math.floor(Math.random() * d * 0.5); // + up to 50% jitter
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'idem-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function transient(message) {
    var e = new Error(message);
    e.transient = true;
    return e;
  }

  function unwrap(json) {
    if (json && json.ok) return json.data;
    var err = (json && json.error) || { code: 'bad_response', message: 'Unexpected response' };
    var e = new Error(err.message || err.code);
    e.code = err.code;
    throw e;
  }

  // One HTTP attempt -> parsed JSON body, or throws (transient-marked when retryable).
  function doFetch(url, opts) {
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = null;
    if (ctrl) { opts.signal = ctrl.signal; timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS); }
    function clear() { if (timer) clearTimeout(timer); }

    return fetch(url, opts)
      .then(function (r) { return r.text(); })
      .then(function (text) {
        clear();
        var t = text ? text.replace(/^﻿/, '').trim() : '';
        // GAS success is always HTTP 200 + a JSON object. Anything else is
        // the HTML overload/error page -> transient, retry it.
        if (!t || t.charAt(0) !== '{') throw transient('Server busy — please wait');
        try { return JSON.parse(t); }
        catch (e) { throw transient('Server busy — please wait'); }
      }, function (e) {
        clear();
        if (e && e.transient) throw e;
        throw transient(e && e.name === 'AbortError' ? 'Request timed out' : 'Network error');
      });
  }

  // Retry loop. optsFactory returns FRESH opts per attempt (POST body reused).
  function request(url, optsFactory, maxAttempts) {
    var limit = maxAttempts || MAX_ATTEMPTS;
    var attempt = 0;
    function tryOnce() {
      attempt++;
      return doFetch(url, optsFactory()).then(unwrap, function (e) {
        var retryable = (e && e.transient) || (e && e.code && RETRYABLE_CODES[e.code]);
        if (retryable && attempt < limit) {
          return sleep(backoff(attempt)).then(tryOnce);
        }
        // Exhausted transports surface through the friendlyError() map.
        if (e && e.transient && !e.code) e.code = 'server_error';
        throw e;
      });
    }
    return tryOnce();
  }

  window.apiGet = function (mode, params) {
    var q = Object.assign({ api: mode }, params || {});
    // attach session creds when present (harmless on open modes)
    var s = window.Session && Session.get();
    if (s && s.checkin_id) { q.cid = s.checkin_id; q.tok = s.session_token; }
    var url = CONFIG.API_URL + '?' + Object.keys(q)
      .filter(function (k) { return q[k] != null && q[k] !== ''; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]); })
      .join('&');
    return request(url, function () { return { method: 'GET', redirect: 'follow' }; });
  };

  // opts (optional): { idempotencyKey, maxAttempts }. The offline outbox
  // mints the key at SUBMIT time and passes it here so the same key is
  // shared by the direct attempt and any later queued drain — the server
  // then replays instead of double-writing (durable across reloads, unlike
  // a key minted inside this call).
  window.apiPost = function (action, payload, opts) {
    opts = opts || {};
    var s = window.Session && Session.get();
    var env = { action: action, payload: payload || {}, idempotency_key: opts.idempotencyKey || uuid() };
    if (s && s.checkin_id) { env.checkin_id = s.checkin_id; env.session_token = s.session_token; }
    var body = JSON.stringify(env); // stable across retries -> server dedupes
    return request(CONFIG.API_URL, function () {
      return {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: body,
        redirect: 'follow'
      };
    }, opts.maxAttempts);
  };

  // Exposed for submit-time idempotency-key minting (screens.js outbox paths).
  window.apiUuid = uuid;

  // Small helper for the PIN-gated public reads (users/usercerts)
  window.apiGetWithPin = function (mode, pin, params) {
    return apiGet(mode, Object.assign({ pin: pin }, params || {}));
  };
})();
