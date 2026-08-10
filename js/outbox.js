/* WRI Respond — persistent offline outbox (IndexedDB).
 *
 * CONTEXT-AGNOSTIC: loaded by the page (script tag) AND by sw.js via
 * importScripts(), so Background Sync can drain the queue with no page open.
 * Nothing at top level may touch the DOM or localStorage; page-only
 * integration sits behind the typeof-document guard at the bottom.
 *
 * Scope (offline pilot 2026-08): ONLY checkin + checkout queue offline.
 * recon-submit / resource-submit / resource-parse are deliberately NOT
 * queued — they show needs-connection states instead.
 *
 * Invariants (match Api.gs):
 *  - record.id IS the idempotency key, minted at submit time — a drain of a
 *    request whose direct attempt actually landed replays server-side
 *    instead of double-writing.
 *  - Every record carries its incident context FROM QUEUE TIME
 *    (queued_incident_id); the server validates it at drain and rejects
 *    with incident_mismatch rather than silently re-stamping.
 *  - pin_invalid at drain marks the record needs_pin; the queue is NEVER
 *    dropped — the page re-PIN prompt rewrites payload.pin and re-queues.
 *  - A checkout queued while its own check-in is still queued rides behind
 *    it via depends_on and inherits the session minted by the check-in's
 *    drain response.
 */
(function () {
  'use strict';

  var DB_NAME = 'wri-checkin';  // NAMESPACED: whitewaterrescue.github.io is ONE origin shared with wri-respond
  var DB_VERSION = 1;
  var STORE = 'outbox';
  var SEND_TIMEOUT_MS = 30000;
  var PAGE_RETRY_BASE_MS = 30 * 1000;
  var PAGE_RETRY_MAX_MS = 10 * 60 * 1000;
  var SENT_TTL_MS = 24 * 3600 * 1000;

  var isPage = (typeof document !== 'undefined');

  // Actions here are staff-checkin / staff-checkout; matchers keep the
  // drain logic shared with the wri-respond original.
  function isCheckin(r) { return String(r.action || '').indexOf('checkin') > -1; }
  function isCheckout(r) { return String(r.action || '').indexOf('checkout') > -1; }

  /* ═══════════════════════════════════════════
     INDEXEDDB PLUMBING (promise-wrapped)
     ═══════════════════════════════════════════ */
  var dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('by_status', 'status');
          os.createIndex('by_queued_at', 'queued_at');
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { dbPromise = null; reject(req.error); };
    });
    return dbPromise;
  }

  function objectStore(mode) {
    return openDb().then(function (db) {
      return db.transaction(STORE, mode).objectStore(STORE);
    });
  }
  function reqP(r) {
    return new Promise(function (res, rej) {
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function putRec(rec) {
    rec.updated_at = new Date().toISOString();
    return objectStore('readwrite').then(function (os) { return reqP(os.put(rec)); });
  }
  function delRec(id) {
    return objectStore('readwrite').then(function (os) { return reqP(os.delete(id)); });
  }
  function allRecs() {
    return objectStore('readonly').then(function (os) { return reqP(os.getAll()); })
      .then(function (rows) {
        rows = rows || [];
        rows.sort(function (a, b) { return String(a.queued_at).localeCompare(String(b.queued_at)); });
        return rows;
      });
  }

  /* ═══════════════════════════════════════════
     TRANSPORT (self-contained — api.js is not loaded in the SW,
     and its retry loop reads Session; this sender is the honest
     cost of the dual-context design)
     ═══════════════════════════════════════════ */
  function transientErr(msg) { var e = new Error(msg || 'No connection'); e.transient = true; return e; }

  function send(env) {
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, SEND_TIMEOUT_MS) : null;
    var opts = {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // simple request — GAS answers no OPTIONS
      body: JSON.stringify(env),
      redirect: 'follow'
    };
    if (ctrl) opts.signal = ctrl.signal;
    return fetch(self.CONFIG.API_URL, opts)
      .then(function (r) { return r.text(); })
      .then(function (text) {
        if (timer) clearTimeout(timer);
        var t = text ? text.replace(/^\uFEFF/, '').trim() : '';
        // GAS success is always HTTP 200 + a JSON object; anything else is
        // the HTML overload/error page -> transient.
        if (!t || t.charAt(0) !== '{') throw transientErr('Server busy');
        try { return JSON.parse(t); } catch (e) { throw transientErr('Server busy'); }
      }, function (e) {
        if (timer) clearTimeout(timer);
        if (e && e.transient) throw e;
        throw transientErr();
      });
  }

  /* ═══════════════════════════════════════════
     CHANGE NOTIFICATION (page: DOM event; SW: postMessage to clients)
     ═══════════════════════════════════════════ */
  function notifyChange(detail) {
    if (isPage) {
      try { document.dispatchEvent(new CustomEvent('outbox:changed', { detail: detail || {} })); } catch (e) {}
    } else if (self.clients && self.clients.matchAll) {
      self.clients.matchAll({ includeUncontrolled: true }).then(function (cs) {
        cs.forEach(function (c) { c.postMessage({ type: 'outbox:changed' }); });
      }).catch(function () {});
    }
  }

  /* ═══════════════════════════════════════════
     DRAIN
     ═══════════════════════════════════════════ */
  // Server codes that keep the record queued and stop the pass (connectivity
  // or load — retrying later will help). Everything else terminal.
  var RETRY_CODES = { rate_limited: 1, server_error: 1 };

  var drainActive = false; // fallback when Web Locks is unavailable
  function withDrainLock(fn) {
    if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
      return navigator.locks.request('wri-checkin-drain', { ifAvailable: true }, function (lock) {
        if (!lock) return { skipped: true };
        return fn();
      });
    }
    if (drainActive) return Promise.resolve({ skipped: true });
    drainActive = true;
    return Promise.resolve().then(fn).then(
      function (v) { drainActive = false; return v; },
      function (e) { drainActive = false; throw e; }
    );
  }

  function drainPass() {
    var summary = { sent: 0, failed: 0, remaining: 0, stopped: false, skipped: false };
    return allRecs().then(function (rows) {
      var byId = {};
      rows.forEach(function (r) { byId[r.id] = r; });
      // 'sending' records are stale claims from an interrupted drain — retry.
      var queue = rows.filter(function (r) { return r.status === 'queued' || r.status === 'sending'; });
      var i = 0;

      // When a queued check-in delivers, hand its minted session to any
      // checkout that was queued behind it — the dependent then owns its
      // creds and no longer needs the check-in record kept around.
      function promoteDependents(sentRec) {
        var updates = [];
        Object.keys(byId).forEach(function (id) {
          var r = byId[id];
          if (r.depends_on === sentRec.id && r.status !== 'sent' && sentRec.result && sentRec.result.checkin_id) {
            r.session = { checkin_id: sentRec.result.checkin_id, session_token: sentRec.result.session_token };
            r.depends_on = null;
            updates.push(putRec(r));
          }
        });
        return Promise.all(updates);
      }

      function step() {
        if (i >= queue.length) return Promise.resolve();
        var rec = queue[i++];

        if (rec.depends_on) {
          var dep = byId[rec.depends_on];
          if (!dep || dep.status !== 'sent' || !dep.result) {
            // FIFO means the dependency ran earlier in this pass; if it is
            // still not sent, it failed or the pass will stop — leave this
            // record queued and note why.
            if (dep && dep.status === 'failed') {
              rec.last_error = { code: 'blocked', message: 'Waiting on a check-in that could not be sent' };
              return putRec(rec).then(step);
            }
            return step();
          }
          rec.session = { checkin_id: dep.result.checkin_id, session_token: dep.result.session_token };
          rec.depends_on = null;
        }

        var env = {
          action: rec.action,
          payload: rec.payload || {},
          idempotency_key: rec.id,
          queued_at: rec.queued_at,
          queued_incident_id: rec.queued_incident_id || ''
        };
        if (rec.session && rec.session.checkin_id) {
          env.checkin_id = rec.session.checkin_id;
          env.session_token = rec.session.session_token;
        }

        rec.status = 'sending';
        return putRec(rec)
          .then(function () { return send(env); })
          .then(function (json) {
            if (json && json.ok) {
              rec.status = 'sent';
              rec.result = json.data || {};
              rec.last_error = null;
              summary.sent++;
              return putRec(rec).then(function () { return promoteDependents(rec); }).then(step);
            }
            var err = (json && json.error) || { code: 'bad_response', message: 'Unexpected response' };
            if (isCheckout(rec) && err.code === 'checked_out') {
              // Goal state already holds (e.g. a retried drain whose first
              // attempt landed) — success.
              rec.status = 'sent';
              rec.result = { checked_out: true, already: true };
              rec.last_error = null;
              summary.sent++;
              return putRec(rec).then(step);
            }
            if (RETRY_CODES[err.code]) {
              rec.status = 'queued';
              rec.attempts = (rec.attempts || 0) + 1;
              rec.last_error = err;
              summary.stopped = true;
              return putRec(rec); // stop the pass — retry later helps
            }
            // Terminal failure: keep the record (surfaced in the UI, user
            // decides retry/discard). pin_invalid additionally stops the
            // pass — later check-ins carry the same stale PIN.
            rec.status = 'failed';
            rec.needs_pin = (err.code === 'pin_invalid');
            rec.last_error = err;
            summary.failed++;
            return putRec(rec).then(function () {
              if (rec.needs_pin) { summary.stopped = true; return null; }
              return step();
            });
          }, function () {
            // Transport failure — connectivity is bad; stop the pass.
            rec.status = 'queued';
            rec.attempts = (rec.attempts || 0) + 1;
            rec.last_error = { code: 'network', message: 'No connection' };
            summary.stopped = true;
            return putRec(rec);
          });
      }

      return step().then(function () {
        return allRecs().then(function (after) {
          summary.remaining = after.filter(function (r) { return r.status === 'queued' || r.status === 'sending'; }).length;
          summary.failedCount = after.filter(function (r) { return r.status === 'failed'; }).length;
          summary.needsPin = after.some(function (r) { return r.status === 'failed' && r.needs_pin; });
          return summary;
        });
      });
    });
  }

  var pageRetryDelay = 0;
  var pageRetryTimer = null;
  function schedulePageRetry() {
    pageRetryDelay = Math.min(pageRetryDelay ? pageRetryDelay * 2 : PAGE_RETRY_BASE_MS, PAGE_RETRY_MAX_MS);
    clearTimeout(pageRetryTimer);
    pageRetryTimer = setTimeout(function () { drain({ source: 'retry' }); }, pageRetryDelay);
  }

  function drain(opts) {
    opts = opts || {};
    return withDrainLock(drainPass).then(function (summary) {
      if (!summary || summary.skipped) return summary || { skipped: true };
      if (summary.sent || summary.failed || summary.stopped) notifyChange(summary);
      if (isPage) {
        if (summary.stopped && summary.remaining > 0) schedulePageRetry();
        else pageRetryDelay = 0;
      } else if (opts.source === 'sync' && summary.stopped && summary.remaining > 0) {
        // Reject the sync event so native Background Sync retries later.
        throw transientErr('drain incomplete');
      }
      return summary;
    });
  }

  /* ═══════════════════════════════════════════
     PUBLIC API
     ═══════════════════════════════════════════ */
  function enqueue(rec) {
    rec.status = 'queued';
    rec.attempts = 0;
    rec.needs_pin = false;
    rec.last_error = null;
    rec.result = null;
    rec.notified = false;
    rec.reconciled = false;
    if (!rec.queued_at) rec.queued_at = new Date().toISOString();
    return putRec(rec).then(function () {
      notifyChange({ enqueued: rec.id });
      if (isPage) {
        registerSync();
        // Immediate attempt: offline it fails in ms and schedules backoff;
        // if the network is actually back it delivers right away.
        setTimeout(function () { drain({ source: 'enqueue' }); }, 50);
      }
      return rec;
    });
  }

  function registerSync() {
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready.then(function (reg) {
          if (reg.sync && reg.sync.register) return reg.sync.register('wri-checkin-outbox');
        }).catch(function () {});
      }
    } catch (e) {}
  }

  function pending() {
    return allRecs().then(function (rows) {
      return {
        queued: rows.filter(function (r) { return r.status === 'queued' || r.status === 'sending'; }),
        failed: rows.filter(function (r) { return r.status === 'failed'; }),
        sent: rows.filter(function (r) { return r.status === 'sent'; })
      };
    });
  }

  // Re-PIN at drain: rewrite the stale PIN on every needs_pin record and
  // re-queue them. The queue is never dropped.
  function updatePin(pin) {
    return allRecs().then(function (rows) {
      var updates = rows
        .filter(function (r) { return r.status === 'failed' && r.needs_pin; })
        .map(function (r) {
          r.payload = r.payload || {};
          r.payload.pin = pin;
          r.status = 'queued';
          r.needs_pin = false;
          r.last_error = null;
          return putRec(r);
        });
      return Promise.all(updates);
    }).then(function () { notifyChange({ pin_updated: true }); });
  }

  function retry(id) {
    return allRecs().then(function (rows) {
      var rec = rows.filter(function (r) { return r.id === id; })[0];
      if (!rec || rec.status !== 'failed') return null;
      rec.status = 'queued';
      rec.last_error = null;
      return putRec(rec);
    }).then(function () { return drain({ source: 'manual-retry' }); });
  }

  function discard(id) {
    return delRec(id).then(function () { notifyChange({ discarded: id }); });
  }

  // Page-only: fold drained results back into app state — back-fill a
  // pending localStorage session from its check-in's drain response, toast
  // delivery confirmations once, then prune old sent records.
  function reconcile() {
    if (!isPage) return Promise.resolve();
    return allRecs().then(function (rows) {
      var chain = Promise.resolve();
      rows.forEach(function (rec) {
        if (rec.status !== 'sent') return;
        if (isCheckin(rec) && !rec.reconciled) {
          chain = chain.then(function () {
            var s = (self.Session && Session.get()) || null;
            if (s && s.pending && s.outbox_id === rec.id && rec.result && rec.result.checkin_id) {
              Session.set(rec.result);
              if (self.APP) APP.session = Session.get();
              if (self.showToast) showToast('✓ Check-in delivered — you are checked in.');
            }
            rec.reconciled = true;
            return putRec(rec);
          });
        } else if (isCheckout(rec) && !rec.notified) {
          chain = chain.then(function () {
            if (self.showToast) showToast('✓ Check-out delivered.');
            rec.notified = true;
            return putRec(rec);
          });
        }
      });
      return chain.then(function () { return clearSent(SENT_TTL_MS); });
    }).catch(function () { /* reconcile is best-effort */ });
  }

  // Prune sent records, but never one that (a) a still-pending record
  // depends on, or (b) hasn't been folded into app state yet.
  function clearSent(olderThanMs) {
    var cutoff = Date.now() - olderThanMs;
    return allRecs().then(function (rows) {
      var referenced = {};
      rows.forEach(function (r) { if (r.depends_on && r.status !== 'sent') referenced[r.depends_on] = true; });
      var dels = rows.filter(function (r) {
        if (r.status !== 'sent') return false;
        if (referenced[r.id]) return false;
        if (isCheckin(r) && !r.reconciled) return false;
        if (isCheckout(r) && !r.notified) return false;
        var t = Date.parse(r.updated_at || r.queued_at || '') || 0;
        return t < cutoff;
      }).map(function (r) { return delRec(r.id); });
      return Promise.all(dels);
    });
  }

  self.Outbox = {
    enqueue: enqueue,
    drain: drain,
    pending: pending,
    updatePin: updatePin,
    retry: retry,
    discard: discard,
    reconcile: reconcile,
    clearSent: clearSent
  };

  /* ═══════════════════════════════════════════
     PAGE-ONLY WIRING (iOS has no Background Sync — the 'online'
     event and app-start drains are its delivery path)
     ═══════════════════════════════════════════ */
  if (isPage) {
    self.addEventListener('online', function () { drain({ source: 'online' }); });
  }
})();
