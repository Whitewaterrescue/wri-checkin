/* WRI Staff Check-In — client session state (localStorage).
 * Keys are wri_checkin_* — whitewaterrescue.github.io is ONE origin shared
 * with wri-respond and every other WRI Pages app; never reuse their keys. */
(function () {
  var KEY = 'wri_checkin_session';
  var PROFILE_KEY = 'wri_checkin_profile';   // prefill for the check-in form

  // 2026-11-05 (batch 11 Part B): "today" is the phone's own date. It was the UTC date, which rolls over at
  // 5-6 PM in Montana, so an evening reload forgot you were checked in. A night shift isn't day-scoped: it holds
  // until 16 h after check-in (the server checks night shifts out then, not at midnight).
  var NIGHT_MS = 16 * 3600 * 1000;
  function localDay(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function current(s) {
    if (!s) return false;
    if (s.shift === 'night') return Date.now() - (Date.parse(s.checkin_time || s.set_at || '') || 0) < NIGHT_MS;
    return s.session_date === localDay();
  }

  window.Session = {
    get: function () {
      try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; }
    },
    set: function (s) {
      s.session_date = localDay(); s.set_at = s.set_at || new Date().toISOString();   // day-scoped (the midnight sweep checks day shifts out)
      localStorage.setItem(KEY, JSON.stringify(s));
    },
    clear: function () { localStorage.removeItem(KEY); },

    isToday: function () { return current(this.get()); },

    // Offline check-in placeholder — real checkin_id/session_token arrive
    // when the queued record drains (Outbox.reconcile back-fills).
    setPending: function (p) {
      p.pending = true;
      p.session_date = localDay(); p.set_at = p.set_at || new Date().toISOString();
      localStorage.setItem(KEY, JSON.stringify(p));
    },
    isPending: function () {
      var s = this.get();
      return !!(s && s.pending);
    },

    profile: {
      get: function () { try { return JSON.parse(localStorage.getItem(PROFILE_KEY)) || {}; } catch (e) { return {}; } },
      set: function (p) { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); }
    }
  };
})();
