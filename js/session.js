/* WRI Staff Check-In — client session state (localStorage).
 * Keys are wri_checkin_* — whitewaterrescue.github.io is ONE origin shared
 * with wri-respond and every other WRI Pages app; never reuse their keys. */
(function () {
  var KEY = 'wri_checkin_session';
  var PROFILE_KEY = 'wri_checkin_profile';   // prefill for the check-in form

  window.Session = {
    get: function () {
      try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; }
    },
    set: function (s) {
      s.session_date = new Date().toISOString().slice(0, 10); // day-scoped (midnight sweep checks everyone out)
      localStorage.setItem(KEY, JSON.stringify(s));
    },
    clear: function () { localStorage.removeItem(KEY); },

    isToday: function () {
      var s = this.get();
      return !!(s && s.session_date === new Date().toISOString().slice(0, 10));
    },

    // Offline check-in placeholder — real checkin_id/session_token arrive
    // when the queued record drains (Outbox.reconcile back-fills).
    setPending: function (p) {
      p.pending = true;
      p.session_date = new Date().toISOString().slice(0, 10);
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
