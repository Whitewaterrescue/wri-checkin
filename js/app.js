/* WRI Staff Check-In — boot + routing.
 * Boot: fetch incident info (best-effort — staff check-in works with NO
 * active incident, parity with the legacy wri-check-in app), load reference
 * data, reconcile any drained outbox records, then route:
 *   pending (queued) check-in -> status screen in pending mode
 *   same-day session          -> status screen (server revalidate best-effort)
 *   otherwise                 -> check-in form
 */
(function () {
  'use strict';

  window.APP = { incident: null, offline: false };

  var INC_SNAP_KEY = 'wri_checkin_incident_snapshot';

  // Incident pin (api.js): a snapshot of another incident must not boot this one.
  function snapFitsPin(inc) {
    var pin = (window.incidentPin && incidentPin()) || '';
    if (!pin || !inc) return true;
    var p = pin.toLowerCase();
    return String(inc.incident_id || '').toLowerCase() === p || String(inc.recon_project || '').toLowerCase() === p;
  }
  // A remembered pin whose incident has closed falls back to the primary; a pin
  // from the link the user just opened shows "closed" instead.
  function staleRememberedPin(incident) {
    if (!incident || !incident.not_open || (window.incidentPinFromUrl && incidentPinFromUrl())) return false;
    if (window.clearIncidentPin) clearIncidentPin();
    return true;
  }

  function showIncident() {
    var inc = APP.incident || {};
    var box = document.getElementById('incidentBox');
    if (inc.incident_name && inc.active !== false) {
      document.getElementById('checkinIncidentName').textContent = inc.incident_name;
      // P3: client + its color so a crew on two incidents can't miss which one this is
      var code = String(inc.client || '').toLowerCase().replace(/[^a-z]/g, '');
      var key = code.indexOf('bnsf') > -1 ? 'bnsf' : code === 'up' || code.indexOf('union') > -1 ? 'up'
        : code.indexOf('mt') > -1 ? 'mtwy' : code.indexOf('wri') > -1 ? 'wri' : '';
      var COLORS = { bnsf: '#F47A20', up: '#FFC72C', mtwy: '#2E7DD7', wri: '#EC2329' };
      var LABELS = { bnsf: 'BNSF', up: 'UP', mtwy: 'MT/WY Coop', wri: 'WRI' };
      var cl = document.getElementById('checkinIncidentClient');
      if (cl) cl.textContent = LABELS[key] || inc.client || '';
      box.style.borderLeft = COLORS[key] ? '6px solid ' + COLORS[key] : '';
      box.style.display = '';
    } else {
      box.style.display = 'none';
    }
  }

  function route() {
    var stored = Session.get();
    hideLoading();

    if (stored && stored.pending) {
      if (!Session.isToday()) {
        // Yesterday's queued check-in still drains from the outbox; today
        // needs a fresh check-in.
        Session.clear();
        showScreen('checkin');
        prefillFromProfile();
        return;
      }
      enterStatus();
      return;
    }

    if (stored && stored.checkin_id) {
      if (!Session.isToday()) {
        Session.clear();
        showScreen('checkin');
        prefillFromProfile();
        return;
      }
      enterStatus(); // show immediately from local state
      // Best-effort revalidation — a midnight-sweep or widget checkout on
      // another device shows up here.
      apiGet('session')
        .then(function (result) {
          if (!result || !result.valid) {
            Session.clear();
            showToast('Your check-in has ended — check in again if you are on site.', true);
            showScreen('checkin');
            prefillFromProfile();
          }
        })
        .catch(function (err) {
          var code = err && err.code;
          if (code === 'bad_token' || code === 'checked_out' || code === 'auth_required') {
            Session.clear();
            showToast('Your check-in has ended — check in again if you are on site.', true);
            showScreen('checkin');
            prefillFromProfile();
          }
          // transient: stay on status (offline-friendly)
        });
      return;
    }

    showScreen('checkin');
    prefillFromProfile();
  }

  function onOutboxChanged() {
    if (!window.Outbox) return;
    Outbox.reconcile().then(function () {
      if (window.updateOutboxBanner) updateOutboxBanner();
      // A drained check-in back-filled the session — refresh the status view.
      var s = Session.get();
      var statusActive = document.getElementById('screen-status').classList.contains('active');
      if (s && s.checkin_id && statusActive) enterStatus();
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    showLoading('Loading...');

    document.addEventListener('outbox:changed', onOutboxChanged);
    if (navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('message', function (e) {
        if (e.data && e.data.type === 'outbox:changed') onOutboxChanged();
      });
    }

    seedTimestamp();
    loadRefs();

    apiGet('incident')
      .then(function (incident) {
        if (staleRememberedPin(incident)) return apiGet('incident');
        return incident;
      })
      .then(function (incident) {
        APP.incident = incident || {};
        try {
          localStorage.setItem(INC_SNAP_KEY, JSON.stringify({ incident: incident, fetched_at: new Date().toISOString() }));
        } catch (e) {}
        showIncident();
        proceed();
      })
      .catch(function () {
        // Offline or API unreachable — staff check-in must still work.
        var snap = null;
        try { snap = JSON.parse(localStorage.getItem(INC_SNAP_KEY)); } catch (e) {}
        APP.incident = (snap && snap.incident && snapFitsPin(snap.incident)) ? snap.incident : {};
        APP.offline = true;
        showIncident();
        proceed();
      });

    function proceed() {
      if (window.Outbox) {
        Outbox.reconcile().then(route, route);
        setTimeout(function () { Outbox.drain({ source: 'boot' }); }, 1200);
      } else {
        route();
      }
      if (window.updateOutboxBanner) updateOutboxBanner();
    }
  });
})();
