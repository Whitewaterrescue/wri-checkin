/* WRI Staff Check-In — screens: check-in form, status, checkout, thank-you.
 * PIN-free staff flow against the gateway JSON API's staff-checkin /
 * staff-checkout actions, with the wri-respond offline outbox pattern:
 * offline submits queue in IndexedDB with a pending placeholder session and
 * drain when signal returns. Plain ES5, everything public on window.
 */
(function () {
  'use strict';

  /* ═══════════════════════════════════════════
     SHARED HELPERS (ported from wri-respond)
     ═══════════════════════════════════════════ */
  window.esc = function (str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  window.escAttr = function (str) { return window.esc(str); };

  window.formatTime = function (isoStr) {
    if (!isoStr) return '';
    try {
      var d = new Date(isoStr);
      if (isNaN(d.getTime())) return String(isoStr);
      return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    } catch (e) { return String(isoStr); }
  };

  window.formatElapsed = function (sinceIso) {
    var t = Date.parse(sinceIso || '');
    if (!t) return '-';
    var mins = Math.max(0, Math.floor((Date.now() - t) / 60000));
    return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
  };

  window.showLoading = function (msg) {
    document.getElementById('loadingText').textContent = msg || 'Loading...';
    document.getElementById('loadingOverlay').style.display = 'flex';
  };
  window.hideLoading = function () {
    document.getElementById('loadingOverlay').style.display = 'none';
  };

  window.showScreen = function (name) {
    var screens = document.querySelectorAll('.screen');
    for (var i = 0; i < screens.length; i++) screens[i].classList.remove('active');
    var target = document.getElementById('screen-' + name);
    if (target) target.classList.add('active');
  };

  var toastTimer = null;
  window.showToast = function (msg, isError) {
    var el = document.getElementById('ciToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ciToast';
      el.style.cssText = 'position:fixed;left:50%;bottom:40px;transform:translateX(-50%);' +
        'max-width:88%;padding:10px 16px;border-radius:8px;font-size:14px;z-index:9999;' +
        'box-shadow:0 4px 16px rgba(0,0,0,0.4);transition:opacity 0.3s;pointer-events:none;';
      document.body.appendChild(el);
    }
    el.style.background = isError ? '#7f1d1d' : '#1f2937';
    el.style.color = '#fff';
    el.style.border = '1px solid ' + (isError ? '#ef4444' : '#4b5563');
    el.textContent = msg;
    el.style.opacity = '1';
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.style.opacity = '0';
      setTimeout(function () { el.style.display = 'none'; }, 350);
    }, 4000);
  };

  window.friendlyError = function (err) {
    var code = err && err.code;
    var map = {
      auth_required: 'Your check-in session has ended.',
      bad_token: 'Your check-in session has ended.',
      checked_out: 'You are already checked out.',
      rate_limited: 'Too many requests — please wait a moment and try again.',
      validation: (err && err.message) || 'Some information is missing or invalid.',
      incident_mismatch: 'The incident changed while this was waiting to send. Please check in again.',
      blocked: 'Waiting on a saved check-in that could not be sent.',
      server_error: 'Server error — please try again.'
    };
    return map[code] || (err && err.message) || 'Something went wrong. Please try again.';
  };

  window.handleAuthError = function (err) {
    if (window.Session && Session.isPending && Session.isPending()) {
      showToast('Your check-in is still waiting to send.', true);
      return true;
    }
    var code = err && err.code;
    if (code === 'checked_out' || code === 'bad_token' || code === 'auth_required') {
      Session.clear();
      showToast(friendlyError(err), true);
      showScreen('checkin');
      return true;
    }
    return false;
  };

  // Field App checkin-status widget contract (CheckIn_WebApp.html legacy):
  // window.top gets {type:'wri-checkin', action, name, location, time}.
  window.notifyHost = function (action, name, location, time) {
    try {
      if (window.top !== window) {
        window.top.postMessage({ type: 'wri-checkin', action: action, name: name || '',
                                 location: location || '', time: time || '' }, '*');
      }
    } catch (e) {}
  };

  // The widget's OWN state key (wri_checkin_state) — github.io is one
  // origin, so this page can write it directly. postMessage updates a
  // MOUNTED widget; the localStorage write makes the pill correct on the
  // widget's NEXT mount (covers standalone check-ins and drains that land
  // while the Field App is closed — the widget has no storage listener).
  // 2026-11-05 (batch 11): + position (the ICS position picked), so Field Forms fills the 214 position from it
  var WIDGET_STATE_KEY = 'wri_checkin_state';
  // batch 13: + shift, so a night shift still counts as "checked in on this phone" after midnight
  function setWidgetState(name, sinceIso, location, position, shift) {
    try {
      localStorage.setItem(WIDGET_STATE_KEY, JSON.stringify({
        name: String(name || ''), since: String(sinceIso || new Date().toISOString()),
        location: String(location || ''), position: String(position || ''), shift: shift === 'night' ? 'night' : 'day'
      }));
    } catch (e) {}
  }
  function clearWidgetState() {
    try { localStorage.removeItem(WIDGET_STATE_KEY); } catch (e) {}
  }

  /* 2026-11-04 (batch 7): the Field App checklist (panels/tasks, same origin) asks
     for a role under 'wri_role'. Seed it from the ICS position just picked here so
     the crew isn't asked again. Positions with no checklist match leave it alone;
     a Field Technician who already picked Boat Operator / Drone Pilot / Water
     Safety Tech / Tech Manager keeps that pick. */
  var TASK_ROLE_KEY = 'wri_role';
  var FIELD_SUBROLES = { boat: 1, drone: 1, water_safety: 1, tech_manager: 1 };
  window.taskRoleFor = function (ics) {
    var r = String(ics || '');
    if (/^field tech/i.test(r)) return 'field';
    if (/safety officer|\(A?SOFR\)/i.test(r)) return 'safety';
    if (/air operations|\(AOBD\)/i.test(r)) return 'drone';
    if (/^(deputy )?incident commander/i.test(r)) return 'pm';
    if (/operations section chief|group supervisor|task force leader|strike team leader|division supervisor|staging area manager/i.test(r)) return 'supervisor';
    if (/logistics section chief|\((COML|MEDL|SUPL|FACL|FDUL|GSUL|VSUL)\)/i.test(r)) return 'logistics';
    if (/planning section chief|\((SITL|RESL|DOCL|ENVL)\)/i.test(r)) return 'admin_sitl';
    return '';
  };
  function seedTaskRole(ics) {
    var id = taskRoleFor(ics);
    if (!id) return;
    try {
      var cur = localStorage.getItem(TASK_ROLE_KEY) || '';
      if (id === 'field' && FIELD_SUBROLES[cur]) return;
      localStorage.setItem(TASK_ROLE_KEY, id);
    } catch (e) {}
  }

  /* 2026-11-04 (batch 7): the Field App jumps to its Home page the moment it
     hears 'checkin', which hid every confirmation. Inside the Field App the
     message now waits until the crew taps "Go to my checklist" (or a short
     countdown ends), so "You're checked in" is seen first. The device state
     (setWidgetState) is still written at once. */
  var NEXT_SECONDS = 8;
  var nextTimer = null;
  function embedded() { try { return window.top !== window; } catch (e) { return true; } }
  function cancelNext() {
    if (nextTimer) { clearInterval(nextTimer); nextTimer = null; }
  }
  window.armNext = function (name, location, time) {
    cancelNext();
    var wrap = document.getElementById('statusNext');
    if (!embedded()) { notifyHost('checkin', name, location, time); return; }
    var note = document.getElementById('statusNextNote');
    var left = NEXT_SECONDS;
    var sent = false;
    function send() {
      if (sent) return;
      sent = true;
      cancelNext();
      wrap.style.display = 'none';
      notifyHost('checkin', name, location, time);
    }
    function tick() { note.textContent = 'Opening your checklist in ' + left + ' s'; }
    tick();
    wrap.style.display = '';
    document.getElementById('statusNextBtn').onclick = send;
    document.getElementById('statusStayBtn').onclick = function () { cancelNext(); wrap.style.display = 'none'; };
    nextTimer = setInterval(function () {
      left--;
      if (left <= 0) send(); else tick();
    }, 1000);
  };

  // Outbox delivery hooks (called from Outbox.reconcile when queued records
  // land) — refresh both channels so the Field App pill flips without any
  // reload, even when the delivery happened via a drain.
  window.onCheckinDelivered = function (result, payload) {
    var loc = (payload && payload.checkin_location) || (Session.get() || {}).location || '';
    setWidgetState(result.name, result.checkin_time, loc, result.role || (payload && payload.role) || (Session.get() || {}).role,
      result.shift || (payload && payload.shift));
    notifyHost('checkin', result.name, loc, result.checkin_time);
  };
  window.onCheckoutDelivered = function () {
    clearWidgetState();
    notifyHost('checkout', (Session.profile.get() || {}).name || '', '', new Date().toISOString());
  };

  function localDatetimeValue(d) {
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  /* 2026-11-06 (batch 13): the check-in time was the time the PAGE OPENED (opened 9:38, tapped Check In 9:49,
     saved 9:38), so time on site started early. The field now keeps showing the current time while the form is
     open, and the time sent is the moment Check In is tapped, unless the crew changed the field themselves. */
  var tsTimer = null;
  window.seedTimestamp = function () {
    var el = document.getElementById('ciTimestamp');
    if (!el) return;
    el.removeAttribute('data-edited');
    el.value = localDatetimeValue(new Date());
    clearInterval(tsTimer);
    tsTimer = setInterval(function () {
      if (el.getAttribute('data-edited') !== '1' && document.activeElement !== el) el.value = localDatetimeValue(new Date());
    }, 15000);
  };
  (function () {
    var el = document.getElementById('ciTimestamp');
    if (!el) return;
    function mark() { el.setAttribute('data-edited', '1'); }   // only a person's edit fires these
    el.addEventListener('input', mark);
    el.addEventListener('change', mark);
  })();
  // The record time to send: now, or the time the crew typed in (as an ISO instant, so the server never guesses the zone)
  window.checkinTimestamp = function () {
    var el = document.getElementById('ciTimestamp');
    if (el && el.getAttribute('data-edited') === '1' && el.value) {
      var t = new Date(el.value);   // datetime-local value = the phone's local time
      if (!isNaN(t.getTime())) return t.toISOString();
    }
    return new Date().toISOString();
  };

  /* ═══════════════════════════════════════════
     REFERENCE DATA (staffrefs) + CONTACT PREFILL
     ═══════════════════════════════════════════ */
  var REFS_SNAP_KEY = 'wri_checkin_refs';

  function fillDatalist(id, values) {
    var dl = document.getElementById(id);
    if (!dl) return;
    dl.innerHTML = '';
    (values || []).forEach(function (v) {
      var opt = document.createElement('option');
      opt.value = v;
      dl.appendChild(opt);
    });
  }

  /* ── Position dropdown ──
     Identical list to the legacy check-in/out app: the ICS Positions tab of
     the shared workbook, served by ?api=staffrefs. Selection survives refills
     (snapshot → network); values outside the list land on "Other…". The baked
     fallback only matters on a first-ever offline open. */
  var ROLE_FALLBACK = [
    'Field Technician',
    'Incident Commander (IC)', 'Deputy Incident Commander', 'Safety Officer (SOFR)',
    'Asst Safety Officer 1 (ASOFR)', 'Asst Safety Officer 2 (ASOFR)', 'Asst Safety Officer 3 (ASOFR)',
    'Public Information Officer (PIO)', 'Liaison Officer (LOFR)', 'Intelligence Officer (INTEL)',
    'Operations Section Chief (OSC)', 'Deputy Operations Section Chief (DOSC)',
    'Staging Area Manager (STAM)', 'Group Supervisor (GRPS)', 'Task Force Leader (TFLD)',
    'Strike Team Leader (STLD)', 'Division Supervisor A (DIVS-A)', 'Division Supervisor B (DIVS-B)',
    'Air Operations (AOBD)',
    'Planning Section Chief (PSC)', 'Deputy Planning Section Chief (DPSC)',
    'Situation Unit Leader (SITL)', 'Resource Unit Leader (RESL)',
    'Documentation Unit Leader (DOCL)', 'Environmental Unit Leader (ENVL)',
    'Logistics Section Chief (LSC)', 'Deputy Logistics Section Chief (DLSC)',
    'Communications Unit Leader (COML)', 'Medical Unit Leader (MEDL)',
    'Supply Unit Leader (SUPL)', 'Facilities Unit Leader (FACL)',
    'Food Unit Leader (FDUL)', 'Ground Support Unit Leader (GSUL)',
    'Vessel Support Unit Leader (VSUL)',
    'Finance Section Chief (FSC)', 'Time Unit Leader (TIME)',
    'Procurement Unit Leader (PROC)', 'Cost Unit Leader (COST)'
  ];

  window.roleGet = function () {
    var sel = document.getElementById('ciRole');
    if (!sel) return '';
    return sel.value === '__other__'
      ? document.getElementById('ciRoleOther').value.trim()
      : sel.value;
  };
  window.roleSet = function (value) {
    var sel = document.getElementById('ciRole');
    var other = document.getElementById('ciRoleOther');
    if (!sel) return;
    var v = String(value || '').trim();
    var match = false;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === v) { match = true; break; }
    }
    if (v && !match) {
      sel.value = '__other__'; other.value = v; other.style.display = '';
    } else {
      sel.value = v; other.style.display = 'none'; other.value = '';
    }
  };
  // ICS section groupings. staffrefs strips the sheet's blank divider rows,
  // but the order is stable — a new section starts at its section chief.
  // Positions before the first anchor (Field Technician) stay ungrouped.
  var ROLE_SECTIONS = [
    { label: 'Command',    re: /^Incident Commander/i },
    { label: 'Operations', re: /^Operations Section Chief/i },
    { label: 'Planning',   re: /^Planning Section Chief/i },
    { label: 'Logistics',  re: /^Logistics Section Chief/i },
    { label: 'Finance',    re: /^Finance Section Chief/i }
  ];
  var roleListKey = '';
  function fillRoleSelect(values) {
    var sel = document.getElementById('ciRole');
    if (!sel || !values || !values.length) return;
    // batch 13: the snapshot and the network list are almost always the same list. Rebuilding it anyway
    // (innerHTML) a few seconds after the page opens tore down a picker the crew had open, and the pick was lost.
    var key = values.join('\n');
    if (key === roleListKey) return;
    roleListKey = key;
    var current = roleGet();
    sel.innerHTML = '';
    function opt(parent, v, label) {
      var o = document.createElement('option');
      o.value = v; o.textContent = label || v;
      parent.appendChild(o);
    }
    opt(sel, '', 'Select position…');
    var parent = sel;
    values.forEach(function (v) {
      for (var i = 0; i < ROLE_SECTIONS.length; i++) {
        if (ROLE_SECTIONS[i].re.test(v)) {
          parent = document.createElement('optgroup');
          parent.label = ROLE_SECTIONS[i].label;
          sel.appendChild(parent);
          break;
        }
      }
      opt(parent, v);
    });
    opt(sel, '__other__', 'Other…');
    roleSet(current);
  }
  document.getElementById('ciRole').addEventListener('change', function () {
    var other = document.getElementById('ciRoleOther');
    other.style.display = this.value === '__other__' ? '' : 'none';
    if (this.value === '__other__') other.focus();
    if (roleGet()) document.getElementById('ciRoleGroup').classList.remove('role-missing');
  });
  document.getElementById('ciRoleOther').addEventListener('input', function () {
    if (roleGet()) document.getElementById('ciRoleGroup').classList.remove('role-missing');
  });
  fillRoleSelect(ROLE_FALLBACK);

  window.applyRefs = function (refs) {
    if (!refs) return;
    fillDatalist('nameList', refs.names);
    fillRoleSelect(refs.icsPositions);
    fillDatalist('companyList', refs.companies);
    fillDatalist('locationList', refs.locations);
  };

  window.loadRefs = function () {
    // Snapshot first — instant autocompletes on every load (and the whole
    // story offline); the network result refreshes both when it arrives.
    try { applyRefs(JSON.parse(localStorage.getItem(REFS_SNAP_KEY))); } catch (e) {}
    apiGet('staffrefs')
      .then(function (refs) {
        try { localStorage.setItem(REFS_SNAP_KEY, JSON.stringify(refs)); } catch (e) {}
        applyRefs(refs);
      })
      .catch(function () { /* snapshot already applied */ });
  };

  var lastContactLookup = '';
  function tryContactPrefill() {
    var name = document.getElementById('ciName').value.trim();
    if (name.length < 3 || name === lastContactLookup) return;
    lastContactLookup = name;
    apiGet('staffcontact', { name: name })
      .then(function (data) {
        var c = data && data.contact;
        if (!c) return;
        var company = document.getElementById('ciCompany');
        var phone = document.getElementById('ciPhone');
        var email = document.getElementById('ciEmail');
        if (!company.value && c.company) company.value = c.company;
        if (!phone.value && c.phone) phone.value = c.phone;
        if (!email.value && c.email) email.value = c.email;
        ciTryPrefillCerts();
      })
      .catch(function () { /* best-effort */ });
  }

  /* ═══════════════════════════════════════════
     CERTIFICATIONS (opt-in; staffusercerts is PIN-free)
     ═══════════════════════════════════════════ */
  var CI_ACTIVE_CERTS = [];
  var CI_CERTS_LOADED = false;
  var CI_CERTS_PROMISE = null;
  var CI_LAST_PREFILL_KEY = '';
  var CERTS_SNAP_KEY = 'wri_checkin_certs';

  function ciLastNameToken(full) {
    var s = String(full || '').trim();
    if (!s) return '';
    var parts = s.split(/\s+/);
    return parts[parts.length - 1].toLowerCase();
  }

  function ensureCertsLoaded() {
    if (CI_CERTS_PROMISE) return CI_CERTS_PROMISE;
    CI_CERTS_PROMISE = apiGet('certs')
      .then(function (data) {
        CI_ACTIVE_CERTS = (data && data.certifications) || [];
        CI_CERTS_LOADED = true;
        try { localStorage.setItem(CERTS_SNAP_KEY, JSON.stringify(CI_ACTIVE_CERTS)); } catch (e) {}
        ciRenderCertList();
      })
      .catch(function () {
        try { CI_ACTIVE_CERTS = JSON.parse(localStorage.getItem(CERTS_SNAP_KEY)) || []; } catch (e) { CI_ACTIVE_CERTS = []; }
        CI_CERTS_LOADED = true;
        ciRenderCertList();
      });
    return CI_CERTS_PROMISE;
  }

  function ciRenderCertList() {
    var wrap = document.getElementById('ciCertList');
    var loading = document.getElementById('ciCertLoading');
    if (!CI_CERTS_LOADED) { loading.style.display = 'block'; wrap.innerHTML = ''; return; }
    loading.style.display = 'none';
    if (!CI_ACTIVE_CERTS.length) {
      wrap.innerHTML = '<div style="font-size:12px;color:#666;font-style:italic">No certifications available' +
        (navigator.onLine === false ? ' offline' : '') + '.</div>';
      return;
    }
    var groups = {};
    CI_ACTIVE_CERTS.forEach(function (c) {
      var cat = c.category || 'Other';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(c);
    });
    var html = '';
    Object.keys(groups).sort().forEach(function (cat) {
      html += '<div style="margin-bottom:10px">';
      html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#EC2329;letter-spacing:.4px;margin-bottom:6px;padding-bottom:3px;border-bottom:1px solid var(--border)">' + esc(cat) + '</div>';
      groups[cat].forEach(function (c) {
        var id = 'ci_cert_' + c.code;
        html += '<div style="display:flex;align-items:flex-start;gap:8px;padding:5px 0">';
        html += '<input type="checkbox" id="' + escAttr(id) + '" data-code="' + escAttr(c.code) + '" style="width:18px;height:18px;flex-shrink:0;margin-top:1px">';
        html += '<label for="' + escAttr(id) + '" style="font-size:13px;line-height:1.35;cursor:pointer;flex:1">' + esc(c.name);
        if (c.description) html += '<span style="display:block;font-size:11px;color:#9ca3af;font-weight:400;margin-top:2px">' + esc(c.description) + '</span>';
        html += '</label></div>';
      });
      html += '</div>';
    });
    wrap.innerHTML = html;
  }

  function ciGetCheckedCertCodes() {
    var checked = document.querySelectorAll('#ciCertList input[type="checkbox"]:checked');
    var codes = [];
    for (var i = 0; i < checked.length; i++) codes.push(checked[i].getAttribute('data-code'));
    return codes;
  }

  function ciSetCheckedCertCodes(codes) {
    var set = {};
    codes.forEach(function (c) { set[c] = true; });
    var boxes = document.querySelectorAll('#ciCertList input[type="checkbox"]');
    for (var i = 0; i < boxes.length; i++) {
      boxes[i].checked = !!set[boxes[i].getAttribute('data-code')];
    }
  }

  window.ciTryPrefillCerts = function () {
    var email = document.getElementById('ciEmail').value.trim();
    var last = ciLastNameToken(document.getElementById('ciName').value);
    if (!email || !last) return;
    var key = email.toLowerCase() + '|' + last;
    if (key === CI_LAST_PREFILL_KEY) return;
    CI_LAST_PREFILL_KEY = key;
    ensureCertsLoaded().then(function () {
      apiGet('staffusercerts', { email: email, last: last })
        .then(function (data) {
          var codes = (data && data.codes) || [];
          if (!codes.length) return;
          var toggle = document.getElementById('ciCertToggle');
          if (!toggle.checked) {
            toggle.checked = true;
            document.getElementById('ciCertSection').style.display = 'block';
          }
          ciSetCheckedCertCodes(codes);
          var msg = document.getElementById('ciCertPrefilledMsg');
          msg.textContent = '✓ Loaded ' + codes.length + ' saved certification' + (codes.length === 1 ? '' : 's') + '.';
          msg.style.display = 'block';
        })
        .catch(function () { /* best-effort */ });
    });
  };

  /* ═══════════════════════════════════════════
     CHECK-IN SUBMIT (online-first; queues offline)
     ═══════════════════════════════════════════ */
  function saveProfile(payload) {
    try {
      Session.profile.set({
        name: payload.name || '',
        organization: payload.organization || '',
        role: payload.role || '',
        phone: payload.phone || '',
        email: payload.email || '',
        home_state: payload.home_state || '',
        location: payload.checkin_location || ''
      });
    } catch (e) {}
  }

  window.prefillFromProfile = function () {
    try {
      var p = Session.profile.get();
      if (!p) return;
      // batch 13: fill only what's still empty, so a late prefill never undoes a pick (the position saved as "-")
      function put(id, v) { var el = document.getElementById(id); if (v && el && !el.value.trim()) el.value = v; }
      put('ciName', p.name);
      put('ciCompany', p.organization);
      if (p.role && !roleGet()) roleSet(p.role);
      put('ciPhone', p.phone);
      put('ciEmail', p.email);
      put('ciState', p.home_state);
      put('ciLocation', p.location);
      if (p.name && p.email) ciTryPrefillCerts();
    } catch (e) {}
  };

  // Offline path: queue + pending placeholder; drain back-fills the session.
  function queueCheckin(payload, idemKey) {
    var inc = (window.APP && APP.incident) || {};
    var tsIso = (function () {
      var t = new Date(payload.timestamp || '');
      return isNaN(t.getTime()) ? new Date().toISOString() : t.toISOString();
    })();
    return Outbox.enqueue({
      id: idemKey,
      action: 'staff-checkin',
      payload: payload,
      session: null,
      depends_on: null,
      queued_at: new Date().toISOString(),
      queued_incident_id: inc.incident_id || '',
      queued_incident_name: inc.incident_name || ''
    }).then(function () {
      Session.setPending({
        outbox_id: idemKey,
        name: payload.name,
        organization: payload.organization,
        role: payload.role,
        location: payload.checkin_location,
        shift: payload.shift || 'day',
        incident_id: inc.incident_id || '',
        incident_name: inc.incident_name || '',
        checkin_time: tsIso
      });
      saveProfile(payload);
      seedTaskRole(payload.role);
      enterStatus();
      if (window.updateOutboxBanner) updateOutboxBanner();
      // Person IS on site — the pill shows for a queued check-in too.
      setWidgetState(payload.name, tsIso, payload.checkin_location, payload.role, payload.shift);
      armNext(payload.name, payload.checkin_location, tsIso);
    });
  }

  // 2026-11-04 (batch 7): the safety ack sits right above the button; a missed
  // tick flashes the row instead of a small browser bubble two screens up.
  (function () {
    var box = document.getElementById('ciSafetyBriefing');
    var row = document.getElementById('ciSafetyRow');
    if (!box || !row) return;
    function sync() { row.classList.toggle('ack-done', box.checked); if (box.checked) row.classList.remove('ack-missing'); }
    box.addEventListener('change', sync);
    box.addEventListener('invalid', function () {
      row.classList.remove('ack-missing');
      void row.offsetWidth;   // restart the pulse
      row.classList.add('ack-missing');
      try { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
    });
    sync();
  })();

  /* 2026-11-06 (batch 13): the position was optional, so an empty pick went through silently and the check-in
     saved no position (card "-", 214 / Time Tracker blank). It's now asked for like the safety ack. */
  function flashRoleMissing() {
    var g = document.getElementById('ciRoleGroup');
    g.classList.remove('role-missing');
    void g.offsetWidth;   // restart the pulse
    g.classList.add('role-missing');
    try { g.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
    var sel = document.getElementById('ciRole');
    try { (sel.value === '__other__' ? document.getElementById('ciRoleOther') : sel).focus({ preventScroll: true }); } catch (e) {}
  }

  /* 2026-11-06 (batch 13): shared phone. A check-in for someone else replaced the person checked in on this phone
     without a word. Who the phone logs as is wri_checkin_state (Field App, Field Forms, HASP, 214 read it). */
  function normName(s) { return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase(); }
  function localDayOf(t) {
    var d = new Date(t);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }
  // the person this phone logs as, while that check-in is still running (today, or a night shift < 16 h old)
  window.phoneCheckedIn = function () {
    try {
      var w = JSON.parse(localStorage.getItem(WIDGET_STATE_KEY) || 'null');
      if (!w || !w.name) return null;
      var t = Date.parse(w.since || '');
      if (!t) return null;
      var s = Session.get() || {};
      var night = w.shift === 'night' || (normName(s.name) === normName(w.name) && s.shift === 'night');
      var live = localDayOf(t) === localDayOf(Date.now()) || (night && Date.now() - t < 16 * 3600 * 1000);
      return live ? w : null;
    } catch (e) { return null; }
  };
  var switchPending = null;
  function askSwitch(oldName, newName, go) {
    switchPending = go;
    document.getElementById('switchTitle').textContent = oldName + ' is checked in on this phone';
    document.getElementById('switchMsg').textContent = 'Check in ' + newName + ' instead? ' + oldName +
      ' stays checked in on the incident; this phone will log as ' + newName + '.';
    var b = document.getElementById('switchConfirmBtn');
    b.disabled = false; b.removeAttribute('aria-busy');
    b.textContent = 'Check in ' + newName;
    document.getElementById('switchCancelBtn').disabled = false;
    document.getElementById('switchOverlay').classList.add('active');
  }
  window.hideSwitchOverlay = function () {
    switchPending = null;
    document.getElementById('switchOverlay').classList.remove('active');
  };
  window.confirmSwitch = function () {
    var go = switchPending;
    if (!go) return;
    switchPending = null;
    var b = document.getElementById('switchConfirmBtn');
    b.disabled = true; b.setAttribute('aria-busy', 'true');
    b.innerHTML = '<span class="spinner spinner-sm"></span> Checking in...';
    document.getElementById('switchCancelBtn').disabled = true;
    go(function () { document.getElementById('switchOverlay').classList.remove('active'); });
  };

  var checkinBusy = false;
  document.getElementById('checkinForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (checkinBusy) return;   // one tap = one check-in
    if (!roleGet()) { flashRoleMissing(); return; }
    var newName = document.getElementById('ciName').value.trim();
    var onPhone = phoneCheckedIn();
    if (onPhone && normName(onPhone.name) !== normName(newName)) {
      askSwitch(String(onPhone.name).trim(), newName, sendCheckin);
      return;
    }
    sendCheckin(null);
  });

  // done (optional): called once the check-in has an answer (the switch dialog closes then)
  function sendCheckin(done) {
    if (checkinBusy) return;
    checkinBusy = true;
    var finished = false;
    function finish() { if (!finished) { finished = true; if (done) done(); } }
    var btn = document.getElementById('checkinBtn');
    function busyText(t) { btn.innerHTML = '<span class="spinner spinner-sm"></span> ' + esc(t); }
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    busyText('Checking in...');
    // progress for a slow reply (cold start / weak signal)
    var slow = [
      setTimeout(function () { busyText('Saving your check-in...'); }, 4000),
      setTimeout(function () { busyText('Still saving (slow signal). Keep this open.'); }, 12000)
    ];

    var payload = {
      name: document.getElementById('ciName').value.trim(),
      role: roleGet(),
      organization: document.getElementById('ciCompany').value.trim(),
      phone: document.getElementById('ciPhone').value.trim(),
      email: document.getElementById('ciEmail').value.trim(),
      home_state: document.getElementById('ciState').value.trim(),
      checkin_location: document.getElementById('ciLocation').value.trim(),
      work_description: document.getElementById('ciWorkDesc').value.trim(),
      safety_briefing: document.getElementById('ciSafetyBriefing').checked,
      shift: document.getElementById('ciNightShift').checked ? 'night' : 'day',   // batch 11 Part B
      certifications: document.getElementById('ciCertToggle').checked ? ciGetCheckedCertCodes() : [],
      timestamp: checkinTimestamp()   // batch 13: the moment Check In is tapped (or the crew's own edit)
    };

    // Key minted at submit time — shared by the direct attempt and any
    // queued record so the server replays instead of double-writing.
    var idemKey = apiUuid();
    function resetBtn() {
      slow.forEach(clearTimeout);
      checkinBusy = false;
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      btn.textContent = 'Check In';
      finish();
    }

    if (navigator.onLine === false && window.Outbox) {
      resetBtn();
      queueCheckin(payload, idemKey);
      return;
    }

    apiPost('staff-checkin', payload, { idempotencyKey: idemKey, maxAttempts: 2 })
      .then(function (result) {
        resetBtn();
        if (!result || !result.checkin_id) {
          showToast('Check-in failed: unexpected server response.', true);
          return;
        }
        // 2026-11-05 (batch 11): the position picked, when the reply leaves it out (the card showed "-")
        var keep = Object.assign({}, result, { location: payload.checkin_location, role: result.role || payload.role || '',
          shift: result.shift || payload.shift || 'day', checkin_time: result.checkin_time || new Date().toISOString() });
        delete keep.timing_ms; delete keep.followup;
        Session.set(keep);
        if (window.APP && result.incident) APP.incident = result.incident;
        saveProfile(payload);
        seedTaskRole(keep.role);
        enterStatus();
        setWidgetState(result.name, result.checkin_time, payload.checkin_location, keep.role, keep.shift);
        armNext(result.name, payload.checkin_location, result.checkin_time);
        // batch 7: the slow follow-ups (AGOL, logs, autofill) run in a second
        // request the crew never waits on; the server sweeps any this misses.
        if (result.followup) {
          try { apiPost('staff-checkin-followup', {}, { maxAttempts: 1 }).catch(function () {}); } catch (e2) {}
        }
      })
      .catch(function (err) {
        resetBtn();
        // batch 7: rate_limited here can mean "your first try is still saving";
        // queue it under the SAME key so it can never write twice.
        if (err && (err.transient || err.code === 'rate_limited') && window.Outbox) {
          queueCheckin(payload, idemKey);
          return;
        }
        showToast('Check-in error: ' + friendlyError(err), true);
      });
  }

  document.getElementById('ciCertToggle').addEventListener('change', function () {
    var on = this.checked;
    document.getElementById('ciCertSection').style.display = on ? 'block' : 'none';
    if (on) {
      ensureCertsLoaded();
      ciTryPrefillCerts();
    } else {
      document.getElementById('ciCertPrefilledMsg').style.display = 'none';
      CI_LAST_PREFILL_KEY = '';
    }
  });
  document.getElementById('ciName').addEventListener('change', tryContactPrefill);
  document.getElementById('ciName').addEventListener('blur', tryContactPrefill);
  document.getElementById('ciEmail').addEventListener('blur', function () { ciTryPrefillCerts(); });

  /* ═══════════════════════════════════════════
     STATUS SCREEN
     ═══════════════════════════════════════════ */
  var elapsedTimer = null;

  window.enterStatus = function () {
    var s = Session.get() || {};
    var p = Session.profile.get() || {};
    document.getElementById('statusAvatar').textContent = (s.name || 'S').charAt(0).toUpperCase();
    document.getElementById('statusWelcome').textContent = s.pending
      ? (s.name || '') + ' — saved on device'
      : (s.name || '') + ' — on site';
    document.getElementById('statusLocation').textContent = s.location || p.location || '-';
    document.getElementById('statusSince').textContent = s.checkin_time ? formatTime(s.checkin_time) : '-';
    var role = s.role || (p.name && p.name === s.name ? p.role : '') || '';   // batch 11: the picked position, never "-" when one was picked
    document.getElementById('statusRole').textContent = role || '-';
    try {   // a check-in from before batch 11 has no position in the shared state yet
      var w = JSON.parse(localStorage.getItem(WIDGET_STATE_KEY) || 'null');
      if (w && role && w.name === s.name && w.position !== role) { w.position = role; localStorage.setItem(WIDGET_STATE_KEY, JSON.stringify(w)); }
    } catch (e) {}
    // 2026-11-04 (batch 7): "You're checked in to <incident> as <role>, <time>"
    var inc = s.incident_name ||
      ((window.APP && APP.incident && APP.incident.active !== false && APP.incident.incident_name) || '');
    var detail = (inc ? ' to ' + inc : '') + (role ? ' as ' + role : '') +
      (s.checkin_time ? ', ' + formatTime(s.checkin_time) : '') +
      (s.shift === 'night' ? ' (night shift: no midnight check-out)' : '');
    document.getElementById('statusConfirm').classList.toggle('pending', !!s.pending);
    document.getElementById('statusConfirmIcon').innerHTML = s.pending ? '&#8987;' : '&#10003;';
    document.getElementById('statusConfirmTitle').textContent = s.pending ? 'Saved on this phone' : "You're checked in";
    document.getElementById('statusConfirmLine').textContent = s.pending
      ? 'Your check-in' + detail + ' will send when you have signal.'
      : "You're checked in" + detail + '.';
    updateElapsed();
    clearInterval(elapsedTimer);
    elapsedTimer = setInterval(updateElapsed, 30000);
    showScreen('status');
    if (window.updateOutboxBanner) updateOutboxBanner();
  };

  function updateElapsed() {
    var s = Session.get() || {};
    var el = document.getElementById('statusElapsed');
    if (el) el.textContent = s.checkin_time ? formatElapsed(s.checkin_time) : '-';
  }

  /* ═══════════════════════════════════════════
     CHECK-OUT
     ═══════════════════════════════════════════ */
  // mode 'switch' (batch 11): "Check out & sign in as someone else" asks first too
  var checkoutMode = '';
  window.showCheckoutOverlay = function (mode) {
    checkoutMode = mode === 'switch' ? 'switch' : '';
    var s = Session.get() || {};
    document.getElementById('checkoutTitle').textContent = checkoutMode ? 'Check out and hand over?' : 'Check Out?';
    document.getElementById('checkoutMsg').textContent = checkoutMode
      ? 'This checks ' + (s.name || 'you') + ' out for today, then opens a fresh check-in for the next person.'
      : 'This ends your time on site for today.';
    document.getElementById('confirmCheckoutBtn').textContent = checkoutMode ? 'Check out & switch' : 'Check Out';
    document.getElementById('checkoutOverlay').classList.add('active');
  };
  window.hideCheckoutOverlay = function () {
    document.getElementById('checkoutOverlay').classList.remove('active');
  };

  // Session creds snapshot INTO the outbox record before the local session
  // clears — a queued checkout carries everything it needs to drain.
  window.submitCheckout_ = function (done) {
    var creds = Session.get() || {};
    var inc = (window.APP && APP.incident) || {};
    var idemKey = apiUuid();
    // name+location ride in the payload so the drain's name-based fallback
    // works even in the service-worker context (no localStorage there).
    var payload = {
      name: creds.name || (Session.profile.get() || {}).name || '',
      location: creds.location || ''
    };

    function queueIt() {
      if (!window.Outbox) { done(false); return; }
      var pendingId = creds.pending ? creds.outbox_id : null;
      Outbox.enqueue({
        id: idemKey,
        action: 'staff-checkout',
        payload: payload,
        session: (!pendingId && creds.checkin_id)
          ? { checkin_id: creds.checkin_id, session_token: creds.session_token }
          : null,
        depends_on: pendingId || null,
        queued_at: new Date().toISOString(),
        queued_incident_id: creds.incident_id || inc.incident_id || ''
      }).then(function () { done(true); }, function () { done(false); });
    }

    if (creds.pending) { queueIt(); return; }
    if (!creds.checkin_id) { done(false); return; }
    if (navigator.onLine === false && window.Outbox) { queueIt(); return; }

    apiPost('staff-checkout', payload, { idempotencyKey: idemKey, maxAttempts: 2 })
      .then(function () { done(false); })
      .catch(function (err) {
        if (err && err.transient && window.Outbox) { queueIt(); return; }
        done(false); // checked_out or other terminal: local clear is right
      });
  };

  // batch 7: one check-out per tap (the loading overlay is the busy state)
  var checkoutBusy = false;
  window.confirmCheckOut = function () {
    if (checkoutMode === 'switch') { checkoutMode = ''; hideCheckoutOverlay(); checkOutAndSwitch(); return; }
    if (checkoutBusy) return;
    checkoutBusy = true;
    var b = document.getElementById('confirmCheckoutBtn');
    if (b) b.disabled = true;
    hideCheckoutOverlay();
    showLoading('Checking out...');
    submitCheckout_(function (queued) {
      checkoutBusy = false;
      if (b) b.disabled = false;
      hideLoading();
      showThankYou(queued);
    });
  };

  window.checkOutAndSwitch = function () {
    if (checkoutBusy) return;
    checkoutBusy = true;
    showLoading('Checking out...');
    submitCheckout_(function (queued) {
      checkoutBusy = false;
      var s = Session.get() || {};
      clearWidgetState();
      notifyHost('checkout', s.name, s.location, new Date().toISOString());
      Session.clear();
      try { Session.profile.set({}); } catch (e) {}
      hideLoading();
      if (queued) showToast('✓ Check-out saved — it will send when signal returns.');
      clearInterval(elapsedTimer);
      resetFormForNext();
      showScreen('checkin');
    });
  };

  window.showThankYou = function (queued) {
    cancelNext();
    var s = Session.get() || {};
    var msg = document.getElementById('tyMessage');
    if (msg) {
      msg.textContent = queued
        ? 'Your check-out is saved on this device and will send when signal returns.'
        : 'You have been checked out.';
    }
    document.getElementById('tyCheckinTime').textContent = s.checkin_time ? formatTime(s.checkin_time) : '-';
    document.getElementById('tyCheckoutTime').textContent = formatTime(new Date().toISOString());
    clearWidgetState();
    notifyHost('checkout', s.name, s.location, new Date().toISOString());
    Session.clear();
    clearInterval(elapsedTimer);
    // the Field App opens its Time Tracker (Forms page); outside the Field App there's nothing to open it in
    var inApp = window.top !== window;
    document.getElementById('tyHoursBtn').classList.toggle('hidden', !inApp);
    document.getElementById('tyHoursNote').classList.toggle('hidden', !inApp);
    showScreen('thankyou');
  };

  // 2026-11-05 (batch 11 Part B): ask the Field App to open the Time Tracker on its Forms page
  window.openHours = function (btn) {
    btn.disabled = true; btn.innerHTML = '<span class="spinner-sm"></span> Opening the Time Tracker…';
    try { window.top.postMessage({ type: 'wri-open-form', name: 'Time Tracker' }, 'https://whitewaterrescue.github.io'); } catch (e) {}
    setTimeout(function () { btn.disabled = false; btn.textContent = 'Confirm today’s hours'; }, 4000);
  };

  window.restartApp = function () {
    Session.clear();
    resetFormForNext();
    prefillFromProfile();
    showScreen('checkin');
  };

  function resetFormForNext() {
    cancelNext();
    try { document.getElementById('checkinForm').reset(); } catch (e) {}
    var ack = document.getElementById('ciSafetyRow');
    if (ack) ack.classList.remove('ack-done', 'ack-missing');
    seedTimestamp();
    document.getElementById('ciCertSection').style.display = 'none';
    document.getElementById('ciCertPrefilledMsg').style.display = 'none';
    CI_LAST_PREFILL_KEY = '';
    lastContactLookup = '';
  }

  /* ═══════════════════════════════════════════
     OUTBOX BANNER + DETAILS (fixed top strip)
     ═══════════════════════════════════════════ */
  window.updateOutboxBanner = function () {
    if (!window.Outbox) return;
    Outbox.pending().then(function (p) {
      var el = document.getElementById('outboxBanner');
      var queued = p.queued.length;
      var failed = p.failed.length;
      if (!queued && !failed) {
        if (el) el.style.display = 'none';
        return;
      }
      if (!el) {
        el = document.createElement('div');
        el.id = 'outboxBanner';
        el.style.cssText = 'position:fixed;top:0;left:0;right:0;padding:9px 14px;font-size:13px;' +
          'font-weight:600;text-align:center;z-index:9998;';
        document.body.appendChild(el);
      }
      if (failed) {
        el.style.background = '#7f1d1d'; el.style.color = '#fff'; el.style.cursor = 'pointer';
        el.textContent = failed + ' saved record' + (failed === 1 ? '' : 's') + ' could not be sent — tap for details.';
        el.onclick = function () { showOutboxDetails(); };
      } else {
        el.style.background = '#78350f'; el.style.color = '#fde68a'; el.style.cursor = 'default';
        el.textContent = '✓ ' + queued + ' record' + (queued === 1 ? '' : 's') + ' saved on this device — will send when signal returns.';
        el.onclick = null;
      }
      el.style.display = 'block';
    });
  };

  window.showOutboxDetails = function () {
    if (!window.Outbox) return;
    Outbox.pending().then(function (p) {
      var overlay = document.getElementById('outboxOverlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'outboxOverlay';
        overlay.className = 'overlay';
        document.body.appendChild(overlay);
      }
      var rows = '';
      p.failed.concat(p.queued).forEach(function (r) {
        var label = String(r.action).indexOf('checkout') > -1 ? 'Check-out' : 'Check-in';
        var state = r.status === 'failed'
          ? '<span style="color:#ef4444;">' + esc(friendlyError(r.last_error || {})) + '</span>'
          : '<span style="color:#fde68a;">Waiting to send</span>';
        rows += '<div style="border:1px solid var(--border,#55595a);border-radius:8px;padding:10px 12px;margin-bottom:10px;text-align:left;font-size:13px;">' +
          '<div style="font-weight:700;margin-bottom:2px;">' + label + ' — saved ' + esc(formatTime(r.queued_at)) + '</div>' +
          '<div style="margin-bottom:6px;">' + state + '</div>';
        if (r.status === 'failed') {
          rows += '<div style="display:flex;gap:8px;">' +
            '<button class="btn btn-secondary" style="flex:1;padding:8px;" onclick="outboxRetry(\'' + escAttr(r.id) + '\')">Retry</button>' +
            '<button class="btn btn-danger" style="flex:1;padding:8px;" onclick="outboxDiscard(\'' + escAttr(r.id) + '\', this)">Discard</button>' +
            '</div>';
        }
        rows += '</div>';
      });
      if (!rows) rows = '<p class="text-muted">Nothing waiting to send.</p>';
      overlay.innerHTML =
        '<div class="overlay-card">' +
        '<h2>Saved Records</h2>' +
        '<div style="max-height:50vh;overflow-y:auto;margin:12px 0;">' + rows + '</div>' +
        '<div class="btn-row"><button class="btn btn-secondary" onclick="hideOutboxDetails()">Close</button></div>' +
        '</div>';
      overlay.classList.add('active');
    });
  };

  window.hideOutboxDetails = function () {
    var overlay = document.getElementById('outboxOverlay');
    if (overlay) overlay.classList.remove('active');
  };

  window.outboxRetry = function (id) {
    hideOutboxDetails();
    Outbox.retry(id).then(function () { updateOutboxBanner(); });
  };

  // Two-tap inline confirm — native confirm() is suppressed inside embedded
  // iframes (field-observed in the Field App embed; same reason the legacy
  // check-in deployment was built "no alert/confirm").
  window.outboxDiscard = function (id, btn) {
    if (btn && btn.getAttribute('data-armed') !== '1') {
      btn.setAttribute('data-armed', '1');
      var orig = btn.textContent;
      btn.textContent = 'Tap again to discard';
      setTimeout(function () {
        btn.setAttribute('data-armed', '');
        btn.textContent = orig;
      }, 5000);
      return;
    }
    Outbox.discard(id).then(function () {
      hideOutboxDetails();
      updateOutboxBanner();
      var s = Session.get();
      if (s && s.pending && s.outbox_id === id) {
        Session.clear();
        clearInterval(elapsedTimer);
        showScreen('checkin');
      }
    });
  };
})();
