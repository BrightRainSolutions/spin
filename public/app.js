// Spin: field tester for the Zephr places grounding MCP.
// docs/notes.md overrides the spec where they differ (lng not lon, no session ids, etc.).
(() => {
  'use strict';

  const { esc, fmtDistance, directionWord, placeRow, renderPlaceDetails, fetchNearby } = window.ZephrHere;
  const $ = (s) => document.querySelector(s);
  const FN = '/.netlify/functions/zephr';

  // ---------- geometry ----------
  const R = 6371008.8;
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;
  function distance(a, b) {
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function bearing(a, b) {
    const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  function destination(a, brg, m) {
    const d = m / R;
    const t = rad(brg);
    const lat1 = rad(a.lat);
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(t));
    const lng2 = rad(a.lng) + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    return [deg(lng2), deg(lat2)];
  }
  const angleDiff = (a, b) => ((b - a + 540) % 360) - 180; // signed, -180..180
  const CARD = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const cardinal = (h) => CARD[Math.round(h / 45) % 8];
  const placePt = (p) => ({ lat: p.latitude, lng: p.longitude });

  // ---------- state ----------
  const params = new URLSearchParams(location.search);
  const num = (k) => {
    const v = params.get(k);
    if (v == null || v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const simLat = num('lat');
  const simLng = num('lon') ?? num('lng');
  const sim = { pos: simLat != null && simLng != null, heading: num('heading') != null };

  const state = {
    pos: sim.pos ? { lat: simLat, lng: simLng, accuracy: 0 } : null,
    heading: sim.heading ? (num('heading') % 360 + 360) % 360 : null,
    sessionId: null,
    mode: null,
    rawOpen: false,
  };
  try {
    state.sessionId = sessionStorage.getItem('zephrSessionId') || null;
  } catch {}

  function setSession(id) {
    state.sessionId = id || null;
    try {
      if (id) sessionStorage.setItem('zephrSessionId', id);
      else sessionStorage.removeItem('zephrSessionId');
    } catch {}
  }

  // ---------- toast ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  // ---------- proxy calls + log ----------
  const log = [];
  const raws = { here: [], go: [], what: [] };
  let logSeq = 0;

  const textOf = (result) => (result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

  async function zephr(tool, args, mode) {
    const entry = {
      id: ++logSeq, time: new Date(), tool, args, mode,
      pos: state.pos ? { lat: state.pos.lat, lng: state.pos.lng } : null,
      accuracy: state.pos?.accuracy ?? null, simulated: sim.pos,
      ms: null, zephrMs: null, ok: null, error: null, raw: null,
    };
    log.unshift(entry);
    if (mode) {
      raws[mode].unshift(entry);
      raws[mode].length = Math.min(raws[mode].length, 12);
    }
    refreshLogAndRaw();

    const t0 = performance.now();
    let data;
    try {
      const res = await fetch(FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, args, sessionId: state.sessionId }),
      });
      data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    } catch (err) {
      data = { ok: false, error: `Network: ${err.message}` };
    }
    entry.ms = Math.round(performance.now() - t0);
    entry.zephrMs = data.ms ?? null;
    entry.raw = data.raw || null;
    if ('sessionId' in data) setSession(data.sessionId);

    let error = data.ok ? null : data.error || 'Unknown error';
    const result = data.result;
    // Zephr can report a tool failure as a normal result with only text (docs/notes.md).
    if (!error && result?.isError) error = textOf(result) || 'Tool reported an error';
    if (!error && !result?.structuredContent) error = textOf(result) || 'No structured content in result';
    entry.ok = !error;
    entry.error = error;
    refreshLogAndRaw();
    if (error) throw new Error(error);
    // Keep Zephr's text alongside: an empty result's only explanation can be in it (docs/notes.md).
    return { ...result.structuredContent, _text: textOf(result) };
  }
  const callFor = (mode) => (tool, args) => zephr(tool, args, mode);

  function posArgs(extra = {}) {
    const a = { lat: round6(state.pos.lat), lng: round6(state.pos.lng), ...extra };
    if (state.heading != null) a.heading = Math.round(state.heading);
    return a;
  }
  const round6 = (n) => Math.round(n * 1e6) / 1e6;

  // ---------- status bar ----------
  function renderStatus() {
    const acc = $('#stat-acc');
    if (!state.pos) acc.textContent = tracking ? 'locating…' : 'tap to locate';
    else if (sim.pos) acc.textContent = 'pos sim';
    else acc.textContent = `± ${Math.round(state.pos.accuracy)} m`;
    acc.classList.toggle('stat-warn', !!state.pos && !sim.pos && state.pos.accuracy > 30);
    $('#stat-heading').textContent = state.heading == null ? '—°' : `${Math.round(state.heading)}° ${cardinal(state.heading)}`;
    $('#badge-sim').hidden = !(sim.pos || sim.heading);
  }

  // ---------- position ----------
  const posWaiters = [];
  let firstFix = !state.pos;
  function setPosition(lat, lng, accuracy) {
    state.pos = { lat, lng, accuracy };
    renderStatus();
    if (firstFix && map) map.jumpTo({ center: [lng, lat], zoom: 17 });
    firstFix = false;
    while (posWaiters.length) posWaiters.shift()(state.pos);
    updateSimMarker();
    onMoved();
  }
  function whenPos() {
    if (state.pos) return Promise.resolve(state.pos);
    return new Promise((resolve) => posWaiters.push(resolve));
  }
  function startWatchPosition() {
    if (sim.pos || !navigator.geolocation) return;
    navigator.geolocation.watchPosition(
      (p) => setPosition(p.coords.latitude, p.coords.longitude, p.coords.accuracy),
      (err) => toast(`Location: ${err.message}`),
      { enableHighAccuracy: true, maximumAge: 2000 }
    );
  }

  // ---------- heading ----------
  // The app only listens. On iOS, Mapbox's GeolocateControl asks for motion permission
  // when location tracking starts from a tap; once granted, these listeners get events too.
  const compass = {
    needsPermission: typeof window.DeviceOrientationEvent?.requestPermission === 'function',
    // Diagnostics, shown on the Log screen.
    counts: { deviceorientation: 0, deviceorientationabsolute: 0 },
    last: null,
  };
  function onOrientation(e) {
    compass.counts[e.type] = (compass.counts[e.type] || 0) + 1;
    compass.last = { type: e.type, webkitCompassHeading: e.webkitCompassHeading, webkitCompassAccuracy: e.webkitCompassAccuracy, alpha: e.alpha, absolute: e.absolute };
    if (sim.heading) return;
    let h = null;
    // iOS: true compass heading (-1 while uncalibrated). Elsewhere: only alpha from an
    // earth-referenced event is a compass; a relative alpha would be a made-up heading.
    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) h = e.webkitCompassHeading;
    else if ((e.type === 'deviceorientationabsolute' || e.absolute) && e.alpha != null) h = 360 - e.alpha;
    if (h == null || Number.isNaN(h)) return;
    setHeading(h);
  }
  window.addEventListener('deviceorientation', onOrientation);
  if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onOrientation);
  function compassSummary() {
    const c = compass.counts;
    const l = compass.last;
    const fmt = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : String(v));
    return `Compass: events ${c.deviceorientation} orientation, ${c.deviceorientationabsolute} absolute` +
      (l ? ` · last ${l.type}: compassHeading ${fmt(l.webkitCompassHeading)}, accuracy ${fmt(l.webkitCompassAccuracy)}, alpha ${fmt(l.alpha)}, absolute ${l.absolute}` : '');
  }
  let headingFrame = 0;
  function setHeading(h) {
    state.heading = ((h % 360) + 360) % 360;
    if (headingFrame) return;
    headingFrame = requestAnimationFrame(() => {
      headingFrame = 0;
      renderStatus();
      updateSimMarker();
      if (state.mode === 'what') onWhatHeading();
    });
  }

  // ---------- map ----------
  let map = null;
  let geolocate = null;
  let tracking = false;
  let simMarker = null;
  const markers = [];

  // Start Mapbox location tracking from inside a tap, so its iOS motion-permission request
  // (and with it the heading arrow) is allowed. Taps on the locate button itself are left
  // to Mapbox, or this would toggle tracking twice.
  function startTracking(e) {
    if (tracking || !geolocate || e.target.closest('.mapboxgl-ctrl-geolocate')) return;
    tracking = geolocate.trigger();
    renderStatus();
  }
  document.addEventListener('click', startTracking, true);

  async function initMap() {
    let token = null;
    try {
      token = (await (await fetch(FN)).json()).mapboxToken;
    } catch {}
    if (!token || !window.mapboxgl) {
      const note = $('#map-note');
      note.hidden = false;
      note.textContent = token ? 'Map library failed to load.' : 'No map: set MAPBOX_TOKEN. Panels still work.';
      startWatchPosition();
      return;
    }
    mapboxgl.accessToken = token;
    map = new mapboxgl.Map({
      container: 'map',
      style: 'mapbox://styles/mapbox/streets-v12',
      center: state.pos ? [state.pos.lng, state.pos.lat] : [-105.0775, 40.5875],
      zoom: state.pos ? 17 : 14,
      attributionControl: true,
    });
    if (!sim.pos) {
      geolocate = new mapboxgl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
        showUserHeading: true,
      });
      map.addControl(geolocate, 'top-right');
      geolocate.on('geolocate', (e) => setPosition(e.coords.latitude, e.coords.longitude, e.coords.accuracy));
      geolocate.on('error', (e) => toast(`Location: ${e.message || 'unavailable'}`));
      geolocate.on('trackuserlocationstart', () => (tracking = true));
      // No trigger() on load: Mapbox asks iOS for motion permission when tracking starts,
      // and iOS only allows that from a tap. The first tap starts it (see startTracking).
    }
    map.on('load', () => {
      map.addSource('route', { type: 'geojson', data: emptyFC() });
      map.addLayer({ id: 'route-casing', type: 'line', source: 'route', paint: { 'line-color': '#ffffff', 'line-width': 9 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
      map.addLayer({ id: 'route', type: 'line', source: 'route', paint: { 'line-color': '#1f3bff', 'line-width': 5 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
      map.addSource('wedge', { type: 'geojson', data: emptyFC() });
      map.addLayer({ id: 'wedge', type: 'fill', source: 'wedge', paint: { 'fill-color': '#ff4a1c', 'fill-opacity': 0.18 } });
      map.addLayer({ id: 'wedge-edge', type: 'line', source: 'wedge', paint: { 'line-color': '#ff4a1c', 'line-width': 2, 'line-opacity': 0.7 } });
      updateSimMarker();
      if (pendingRoute) setRoute(pendingRoute);
    });
    if (sim.pos) {
      // Desktop testing: click the map to move the simulated position.
      map.on('click', (e) => {
        setPosition(e.lngLat.lat, e.lngLat.lng, 0);
        params.set('lat', e.lngLat.lat.toFixed(6));
        params.set('lon', e.lngLat.lng.toFixed(6));
        history.replaceState(null, '', `?${params}`);
      });
    }
  }
  const emptyFC = () => ({ type: 'FeatureCollection', features: [] });

  // Simulated position only (desktop testing); live position is Mapbox's GeolocateControl.
  function updateSimMarker() {
    if (!map || !sim.pos || !state.pos) return;
    if (!simMarker) {
      const el = document.createElement('div');
      el.className = 'sim-me';
      el.innerHTML = '<span class="sim-arrow"></span>';
      simMarker = new mapboxgl.Marker({ element: el, rotationAlignment: 'map' }).setLngLat([state.pos.lng, state.pos.lat]).addTo(map);
    }
    simMarker.setLngLat([state.pos.lng, state.pos.lat]);
    simMarker.getElement().classList.toggle('has-heading', state.heading != null);
    simMarker.setRotation(state.heading ?? 0);
  }

  let pendingRoute = null;
  function setRoute(geometry) {
    pendingRoute = geometry;
    const src = map?.getSource?.('route');
    if (!src) return;
    src.setData(geometry ? { type: 'Feature', geometry, properties: {} } : emptyFC());
  }

  function setWedge(show) {
    const src = map?.getSource?.('wedge');
    if (!src) return;
    if (!show || !state.pos || state.heading == null) return src.setData(emptyFC());
    const ring = [[state.pos.lng, state.pos.lat]];
    for (let a = -30; a <= 30; a += 5) ring.push(destination(state.pos, state.heading + a, 250));
    ring.push(ring[0]);
    src.setData({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} });
  }

  // onTap(place) handles a marker tap for the mode that drew it.
  function setMarkers(places, onTap) {
    while (markers.length) markers.pop().marker.remove();
    if (!map) return;
    places.forEach((p, i) => {
      if (p.latitude == null || p.longitude == null) return;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'pin';
      el.innerHTML = `<span class="pin-shape"><span>${i + 1}</span></span>`;
      el.title = p.name;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        onTap(p);
      });
      const marker = new mapboxgl.Marker({ element: el }).setLngLat([p.longitude, p.latitude]).addTo(map);
      markers.push({ marker, el, place: p });
    });
  }

  function fitTo(points) {
    if (!map || !points.length) return;
    const b = new mapboxgl.LngLatBounds();
    points.forEach((p) => b.extend(p));
    if (state.pos) b.extend([state.pos.lng, state.pos.lat]);
    map.fitBounds(b, { padding: { top: 40, bottom: panelCover() + 30, left: 40, right: 40 }, maxZoom: 18, duration: 600 });
  }

  // Pixels of map hidden behind the open panel, taken at its CSS max-height: camera moves
  // usually happen while the panel's content is still loading and it hasn't grown yet.
  function panelCover() {
    const panel = $('#panel');
    if (!map || panel.hidden) return 0;
    const mapH = map.getContainer().getBoundingClientRect().height;
    const css = getComputedStyle(panel).maxHeight; // may come back as "58%" or in px
    const maxH = css.endsWith('%') ? (mapH * parseFloat(css)) / 100 : parseFloat(css);
    return Math.min(mapH - 80, Number.isFinite(maxH) ? maxH : mapH * 0.58);
  }

  // Put the user in the middle of the map area above the panel.
  function centerOnUser(zoom) {
    if (!map || !state.pos) return;
    map.easeTo({ center: [state.pos.lng, state.pos.lat], offset: [0, -panelCover() / 2], zoom: zoom ?? Math.max(map.getZoom(), 16.5), duration: 500 });
  }

  // ---------- panel + modes ----------
  const TITLES = { here: 'Here', go: 'Go', what: "What's that?" };

  function openMode(mode) {
    const prev = state.mode;
    state.mode = mode;
    $('#panel').hidden = false;
    $('#panel-title').textContent = TITLES[mode];
    document.querySelectorAll('.mode').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    setRawOpen(false);
    if (prev !== mode) {
      setWedge(false);
      setMarkers([], () => {});
      if (mode === 'go') redrawGoMarkers();
      if (mode === 'what') redrawWhatMarkers();
      if (mode === 'here') setMarkers(herePlaces, (p) => here.showDetails({ overture_id: p.overture_id }, hereArgsPos()));
      if (mode !== 'go' && !nav.active) setRoute(null);
      if (mode === 'go' && nav.active) {
        setRoute(nav.geometry);
        renderNav();
      }
    }
    if (mode === 'what') onWhatHeading();
  }

  function closePanel() {
    $('#panel').hidden = true;
    $('#panel').classList.remove('expanded');
    document.querySelectorAll('.mode').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    setWedge(false);
    state.mode = null;
  }

  function setRawOpen(open) {
    state.rawOpen = open;
    $('#btn-raw').setAttribute('aria-pressed', String(open));
    document.querySelectorAll('.view[data-view]').forEach((v) => (v.hidden = open || v.dataset.view !== state.mode));
    $('#raw-view').hidden = !open;
    if (open) renderRaw();
  }

  function renderRaw() {
    const list = raws[state.mode] || [];
    $('#raw-view').innerHTML = list.length
      ? `<p class="hint">Newest first. Last ${list.length} call${list.length === 1 ? '' : 's'} from this panel.</p>` + list.map((e, i) => rawBlock(e, i === 0)).join('')
      : '<p class="hint">No calls yet from this panel.</p>';
  }

  function rawBlock(e, open) {
    const status = e.ok == null ? 'pending' : e.ok ? 'ok' : 'error';
    const body = e.raw ? JSON.stringify(e.raw, null, 2) : JSON.stringify({ args: e.args, error: e.error }, null, 2);
    return `
      <details class="raw" ${open ? 'open' : ''}>
        <summary><span class="raw-tool">${esc(e.tool)}</span><span class="tag tag-${status}">${status}</span><span class="raw-ms">${e.ms != null ? `${e.ms} ms` : '…'}</span></summary>
        ${e.error ? `<p class="raw-err">${esc(e.error)}</p>` : ''}
        <button type="button" class="chip copy" data-copy="${e.id}">Copy</button>
        <pre>${esc(body)}</pre>
      </details>`;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        toast('Copied');
      } catch {
        toast('Copy failed');
      }
      ta.remove();
    }
  }

  function entryJson(id) {
    const e = log.find((x) => x.id === Number(id));
    if (!e) return '';
    return JSON.stringify(e.raw || { args: e.args, error: e.error }, null, 2);
  }

  // ---------- log screen ----------
  const fmtTime = (d) => d.toLocaleTimeString([], { hour12: false });
  function renderLog() {
    $('#log-sub').innerHTML = `${log.length} call${log.length === 1 ? '' : 's'} this session · session id: ${esc(state.sessionId || 'none issued')}<br>${esc(compassSummary())}`;
    $('#log-list').innerHTML = log.map((e) => `
      <li class="log-item ${e.ok === false ? 'is-err' : ''}">
        <details>
          <summary>
            <span class="log-time">${fmtTime(e.time)}</span>
            <span class="log-tool">${esc(e.tool)}</span>
            <span class="log-ms">${e.ms != null ? `${e.ms} ms` : '…'}</span>
            <span class="log-pos">${e.pos ? `${e.pos.lat.toFixed(5)}, ${e.pos.lng.toFixed(5)}` : 'no position'} · ${e.simulated ? 'simulated' : e.accuracy != null ? `±${Math.round(e.accuracy)} m` : ''}${e.zephrMs != null ? ` · proxy ${e.zephrMs} ms` : ''}</span>
          </summary>
          ${e.error ? `<p class="raw-err">${esc(e.error)}</p>` : ''}
          <button type="button" class="chip copy" data-copy="${e.id}">Copy</button>
          <pre>${esc(JSON.stringify(e.raw || { args: e.args }, null, 2))}</pre>
        </details>
      </li>`).join('');
  }
  let refreshQueued = false;
  function refreshLogAndRaw() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => {
      refreshQueued = false;
      if (!$('#log-screen').hidden) renderLog();
      if (state.rawOpen) renderRaw();
    });
  }

  // ---------- Here ----------
  let herePlaces = [];
  const hereArgsPos = () => (state.pos ? { lat: round6(state.pos.lat), lng: round6(state.pos.lng), heading: state.heading } : null);
  const here = window.ZephrHere.createHerePanel($('#here-view'), {
    call: callFor('here'),
    onPlaces: (places, done) => {
      herePlaces = places;
      if (state.mode === 'here') {
        setMarkers(places, (p) => here.showDetails({ overture_id: p.overture_id }, hereArgsPos()));
        if (done) fitTo(places.slice(0, 10).map((p) => [p.longitude, p.latitude]));
      }
    },
  });
  async function runHere() {
    openMode('here');
    $('#here-view').innerHTML = '<p class="hint">Waiting for location…</p>';
    await whenPos();
    here.load(hereArgsPos());
  }

  // ---------- Go ----------
  const go = { results: [], query: '', selected: null };
  const nav = { active: false, place: null, dest: null, steps: [], crossings: [], status: null, geometry: null, lastCheck: null, lastCheckPos: null, inFlight: false, timer: 0, mismatch: null, error: null };
  const goBody = () => $('#go-body');
  const goCall = callFor('go');

  function redrawGoMarkers() {
    if (nav.active && nav.dest) setMarkers([nav.dest], () => {});
    else setMarkers(go.results, (p) => goDetails(p));
  }

  async function goSearch(q) {
    q = q.trim();
    if (!q) return;
    go.query = q;
    $('#go-q').value = q;
    $('#go-q').blur();
    goBody().innerHTML = '<p class="hint">Waiting for location…</p>';
    await whenPos();
    goBody().innerHTML = `<p class="hint">Finding the nearest “${esc(q)}”…</p>`;
    try {
      const s = await goCall('find_nearest_to_me', posArgs({ query: q }));
      // name/query matching is mostly semantic, so Zephr's order isn't strictly by distance.
      go.results = (s.places || []).slice().sort((a, b) => a.distance_m - b.distance_m);
      go.text = s._text;
      renderGoResults();
      if (state.mode === 'go' && !nav.active) {
        redrawGoMarkers();
        fitTo(go.results.map((p) => [p.longitude, p.latitude]));
      }
    } catch (err) {
      goBody().innerHTML = `<p class="err">${esc(err.message)}</p>`;
    }
  }

  function renderGoResults() {
    if (!go.results.length) {
      goBody().innerHTML = `<p class="hint">Zephr found nothing for “${esc(go.query)}”.</p>${go.text ? `<p class="hint small">Zephr said: ${esc(go.text)}</p>` : ''}`;
      return;
    }
    goBody().innerHTML = `
      <h4 class="sub">Nearest “${esc(go.query)}” <small>${go.results.length} results, max 5</small></h4>
      <ol class="zh zh-list numbered">${go.results.map((p) => placeRow(p, `data-go-id="${esc(p.overture_id)}"`)).join('')}</ol>`;
  }

  async function goDetails(p) {
    go.selected = p;
    goBody().innerHTML = '<p class="hint">Getting details…</p>';
    try {
      const s = await goCall('get_place_details', posArgs({ overture_id: p.overture_id }));
      go.selected = { ...p, ...(s.place || {}) };
      goBody().innerHTML = `
        <div class="zh">${renderPlaceDetails(go.selected)}</div>
        <div class="actions">
          <button type="button" class="btn-accent btn-big" id="btn-walk">Walk there</button>
          <button type="button" class="btn-ghost" id="btn-go-back">‹ Results</button>
        </div>`;
    } catch (err) {
      goBody().innerHTML = `<p class="err">${esc(err.message)}</p><div class="actions"><button type="button" class="btn-ghost" id="btn-go-back">‹ Results</button></div>`;
    }
  }

  async function startNav(place) {
    stopNav(true);
    Object.assign(nav, { active: true, place, dest: null, steps: [], crossings: [], status: 'starting', geometry: null, lastCheck: null, lastCheckPos: null, inFlight: true, mismatch: null, error: null });
    $('#nav-dot').hidden = false;
    renderNav();
    try {
      // navigate_to_place has no overture_id param: route by name, then verify it's the same place.
      const s = await goCall('navigate_to_place', posArgs({ name: place.name }));
      if (!nav.active) return;
      nav.dest = s.destination;
      nav.steps = s.steps || [];
      nav.crossings = s.street_crossings || [];
      nav.geometry = s.route_geometry || null;
      nav.status = 'navigating';
      if (nav.dest?.latitude != null && place.latitude != null) {
        const off = distance(placePt(nav.dest), placePt(place));
        if (off > 50) nav.mismatch = Math.round(off);
      }
      nav.lastCheck = Date.now();
      nav.lastCheckPos = { ...state.pos };
      if (state.mode === 'go') {
        setRoute(nav.geometry);
        redrawGoMarkers();
        if (nav.geometry) fitTo(nav.geometry.coordinates);
      }
      nav.timer = setInterval(navTick, 1000);
    } catch (err) {
      nav.error = err.message;
      nav.status = 'failed';
      nav.active = false;
      $('#nav-dot').hidden = true;
    } finally {
      nav.inFlight = false;
      renderNav();
    }
  }

  function navTick() {
    if (!nav.active) return;
    if (Date.now() - nav.lastCheck >= 15000) checkProgress();
    else updateNavCountdown();
  }

  async function checkProgress() {
    if (!nav.active || nav.inFlight || !state.pos) return;
    nav.inFlight = true;
    nav.lastCheck = Date.now();
    nav.lastCheckPos = { ...state.pos };
    updateNavCountdown();
    try {
      const s = await goCall('check_navigation_progress', posArgs());
      if (!nav.active) return;
      nav.status = s.status || 'unknown';
      if (s.destination) nav.dest = { ...nav.dest, ...s.destination };
      nav.steps = s.steps || [];
      nav.geometry = s.route_geometry || nav.geometry;
      nav.error = null;
      if (state.mode === 'go') setRoute(nav.geometry);
      if (nav.status === 'arrived') {
        stopNav(false);
        toast(`Arrived at ${nav.dest?.name || nav.place?.name}`);
      }
    } catch (err) {
      nav.error = err.message;
    } finally {
      nav.inFlight = false;
      renderNav();
    }
  }

  function stopNav(silent) {
    clearInterval(nav.timer);
    nav.timer = 0;
    const wasActive = nav.active;
    nav.active = false;
    $('#nav-dot').hidden = true;
    if (!silent && wasActive && nav.status !== 'arrived') nav.status = 'stopped';
  }

  const remaining = () => nav.steps.reduce((sum, s) => sum + (s.distance_m || 0), 0);

  function renderNav() {
    const p = nav.place;
    const dest = nav.dest;
    const statusClass = String(nav.status || '').toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z-]/g, '');
    $('#go-view').classList.toggle('navigating', nav.active);
    const steps = nav.steps.map((s, i) => `
      <li class="${i === 0 && nav.active ? 'current' : ''}">
        <span class="step-text">${esc(s.instruction)}</span>
        <span class="step-dist">${fmtDistance(s.distance_m)}</span>
        ${s.places_along?.length ? `<span class="step-along">past ${s.places_along.map((a) => `${esc(a.name)} (${esc(a.side)})`).join(', ')}</span>` : ''}
      </li>`).join('');
    goBody().innerHTML = `
      <div class="nav">
        <div class="nav-head">
          <div>
            <div class="nav-to">Walking to</div>
            <div class="nav-name">${esc(dest?.name || p?.name || '')}</div>
            <div class="nav-addr">${esc(dest?.address || p?.address || '')}</div>
          </div>
          <span class="status-chip st-${statusClass}">${esc(String(nav.status || '').replace(/[-_]/g, ' '))}</span>
        </div>
        ${dest ? `<div class="nav-stats"><b>${fmtDistance(remaining())}</b> to walk${dest.walking_minutes != null ? ` · ~${dest.walking_minutes} min` : ''}<br><small>Straight line ${fmtDistance(dest.distance_m)}, ${esc(directionWord(dest.direction))}</small></div>` : ''}
        ${nav.mismatch ? `<p class="warn">Zephr routed to a “${esc(dest?.name)}” ${nav.mismatch} m from the one you picked. navigate_to_place can only match by name.</p>` : ''}
        ${nav.error ? `<p class="err">${esc(nav.error)}</p>` : ''}
        ${steps ? `<ol class="steps">${steps}</ol>` : nav.inFlight ? '<p class="hint">Getting directions…</p>' : ''}
        ${nav.crossings.length ? `<details class="crossings"><summary>${nav.crossings.length} street crossings (from start)</summary><ul>${nav.crossings.map((c) => `<li>${esc(c.name)} at ${fmtDistance(c.distance_m)}</li>`).join('')}</ul></details>` : ''}
        <p class="hint" id="nav-countdown"></p>
        <div class="actions">
          ${nav.active ? '<button type="button" class="btn-stop btn-big" id="btn-stop">Stop</button><button type="button" class="btn-ghost" id="btn-check">Check now</button>' : '<button type="button" class="btn-ghost" id="btn-go-back">‹ Results</button>'}
        </div>
      </div>`;
    updateNavCountdown();
  }

  function updateNavCountdown() {
    const el = $('#nav-countdown');
    if (!el) return;
    if (!nav.active) {
      el.textContent = nav.lastCheck ? `Last check ${fmtTime(new Date(nav.lastCheck))}` : '';
      return;
    }
    if (nav.inFlight) {
      el.textContent = 'Checking progress…';
      return;
    }
    const left = Math.max(0, Math.ceil((15000 - (Date.now() - nav.lastCheck)) / 1000));
    const moved = nav.lastCheckPos && state.pos ? Math.round(distance(nav.lastCheckPos, state.pos)) : 0;
    el.textContent = `Next check in ${left}s or after 10 m (moved ${moved} m)`;
  }

  // ---------- What's that? ----------
  const what = { places: [], ahead: null, aheadHeading: null, aheadAt: 0, fetchPos: null, loading: false, errors: [], detail: null, progress: '' };
  const whatCall = callFor('what');
  const whatView = () => $('#what-view');

  function redrawWhatMarkers() {
    setMarkers(what.places, (p) => whatDetails(p));
    markInView();
  }

  async function runWhat() {
    openMode('what');
    whatView().innerHTML = '<p class="hint">Waiting for location…</p>';
    await whenPos();
    what.detail = null;
    centerOnUser(16.5); // shows the whole 250 m cone above the panel
    fetchWhat();
  }

  async function fetchWhat() {
    if (what.loading) return;
    what.loading = true;
    what.fetchPos = { ...state.pos };
    what.progress = '0/' + window.ZephrHere.NEARBY_QUERIES.length;
    renderWhat();
    const pos = { lat: round6(state.pos.lat), lng: round6(state.pos.lng) };
    await fetchAhead(); // fast, and Zephr seems to queue one key's requests, so it goes first
    const previous = what.places;
    const near = await fetchNearby(whatCall, pos, {
      onProgress: (snap) => {
        // While refreshing, keep showing older places until the new set is complete.
        const ids = new Set(snap.places.map((p) => p.overture_id));
        what.places = snap.done < snap.total ? [...snap.places, ...previous.filter((p) => !ids.has(p.overture_id))] : snap.places;
        what.errors = snap.errors;
        what.progress = `${snap.done}/${snap.total}`;
        if (state.mode === 'what') redrawWhatMarkers();
        renderWhat();
      },
    });
    what.places = near.places;
    what.loading = false;
    if (state.mode === 'what') redrawWhatMarkers();
    renderWhat();
  }

  async function fetchAhead() {
    if (state.heading == null) {
      what.ahead = null;
      return;
    }
    what.aheadAt = Date.now();
    what.aheadInFlight = true;
    const args = posArgs();
    what.aheadHeading = args.heading;
    try {
      const s = await whatCall('get_location', args);
      what.ahead = { ...(s.directly_ahead || {}), none: !s.directly_ahead, heading: args.heading };
    } catch (err) {
      what.ahead = { error: err.message, heading: args.heading };
    }
    what.aheadInFlight = false;
    renderWhat();
  }

  function inView() {
    if (!state.pos) return [];
    return what.places
      .map((p) => {
        const pt = placePt(p);
        const b = bearing(state.pos, pt);
        return { p, d: distance(state.pos, pt), b, delta: state.heading == null ? null : angleDiff(state.heading, b) };
      })
      .filter((x) => x.delta == null || Math.abs(x.delta) <= 30)
      .sort((a, b) => a.d - b.d);
  }

  function markInView() {
    const ids = new Set(inView().map((x) => x.p.overture_id));
    markers.forEach((m) => m.el.classList.toggle('dim', state.mode === 'what' && state.heading != null && !ids.has(m.place.overture_id)));
  }

  function onWhatHeading() {
    setWedge(true);
    if (what.detail) return;
    renderWhat();
    markInView();
    maybeRefreshAhead();
  }

  // directly_ahead depends on heading: refresh it after a real turn, at most every 5 s,
  // with a trailing retry so it catches up once the user stops turning.
  let aheadTimer = 0;
  function maybeRefreshAhead() {
    clearTimeout(aheadTimer);
    if (state.mode !== 'what' || state.heading == null || !what.fetchPos) return;
    if (what.aheadHeading != null && Math.abs(angleDiff(what.aheadHeading, state.heading)) <= 20) return;
    const wait = 5000 - (Date.now() - what.aheadAt);
    if (what.loading || what.aheadInFlight || wait > 0) {
      aheadTimer = setTimeout(maybeRefreshAhead, Math.max(wait, 1000));
      return;
    }
    fetchAhead().then(maybeRefreshAhead);
  }

  const sideText = (delta) => {
    const a = Math.round(Math.abs(delta));
    return a <= 5 ? 'dead ahead' : `${a}° ${delta < 0 ? 'left' : 'right'}`;
  };

  function renderWhat() {
    if (state.mode !== 'what' || what.detail) return;
    const v = whatView();
    if (!what.fetchPos) return;
    const rows = inView();
    const ahead = what.ahead;
    let aheadHtml = '';
    if (state.heading == null) {
      const why = compass.needsPermission
        ? 'Allow motion access when asked. If you declined, close and reopen the app. Log shows compass details.'
        : 'On desktop, add ?heading= to the URL or use the ← → keys.';
      aheadHtml = `<p class="warn">No compass heading. ${why} Showing everything nearby.</p>`;
    } else if (ahead?.error) {
      aheadHtml = `<p class="err">get_location: ${esc(ahead.error)}</p>`;
    } else if (ahead) {
      aheadHtml = `<div class="ahead"><span class="ahead-label">Zephr says directly ahead <small>at ${Math.round(ahead.heading)}°</small></span>${
        ahead.none ? '<span class="ahead-name">nothing</span>' : `<span class="ahead-name">${esc(ahead.name)}</span><span class="ahead-meta">${esc(ahead.category || '')} · ${fmtDistance(ahead.distance_m)}</span>`
      }</div>`;
    }
    const list = rows.length
      ? `<ul class="zh zh-list">${rows.map((x) => `
          <li><button type="button" class="zh-place" data-what-id="${esc(x.p.overture_id)}">
            <span class="zh-place-main"><span class="zh-place-name">${esc(x.p.name)}</span><span class="zh-place-cat">${esc(x.p.category || '')}</span></span>
            <span class="zh-place-dist">${fmtDistance(x.d)}<small>${x.delta == null ? `${Math.round(x.b)}° ${cardinal(x.b)}` : sideText(x.delta)}</small></span>
          </button></li>`).join('')}</ul>`
      : `<p class="hint">${what.loading ? 'Looking around…' : 'Nothing in the ±30° cone. Turn around slowly.'}</p>`;
    v.innerHTML = `
      ${aheadHtml}
      <h4 class="sub">In view ±30° <small>${rows.length} of ${what.places.length} places · ${what.loading ? `searching ${what.progress || ''}…` : `refreshes after 25 m (moved ${state.pos && what.fetchPos ? Math.round(distance(what.fetchPos, state.pos)) : 0} m)`}</small></h4>
      ${list}
      ${what.errors.length ? `<p class="err">${what.errors.map(esc).join('<br>')}</p>` : ''}
      <p class="hint small">Places come from ${window.ZephrHere.NEARBY_QUERIES.length} find_nearest_to_me category searches (5 results each); bearings are computed on the phone.</p>`;
  }

  async function whatDetails(p) {
    what.detail = p;
    whatView().innerHTML = '<p class="hint">Getting details…</p>';
    try {
      const s = await whatCall('get_place_details', posArgs({ overture_id: p.overture_id }));
      if (what.detail !== p) return;
      whatView().innerHTML = `<button type="button" class="zh-back" id="btn-what-back">‹ Back</button><div class="zh">${renderPlaceDetails(s.place || {})}</div>`;
    } catch (err) {
      if (what.detail !== p) return;
      whatView().innerHTML = `<button type="button" class="zh-back" id="btn-what-back">‹ Back</button><p class="err">${esc(err.message)}</p>`;
    }
  }

  // ---------- movement triggers ----------
  function onMoved() {
    if (nav.active && !nav.inFlight && nav.lastCheckPos && distance(nav.lastCheckPos, state.pos) > 10) checkProgress();
    if (state.mode === 'what') {
      if (what.fetchPos && !what.loading && distance(what.fetchPos, state.pos) > 25) fetchWhat();
      else onWhatHeading();
    }
    if (nav.active && state.mode === 'go') updateNavCountdown();
  }

  // ---------- events ----------
  document.querySelector('.modes').addEventListener('click', (e) => {
    const b = e.target.closest('.mode');
    if (!b) return;
    const mode = b.dataset.mode;
    if (state.mode === mode && !$('#panel').hidden) return closePanel();
    if (mode === 'here') runHere();
    else if (mode === 'what') runWhat();
    else {
      openMode('go');
      if (!nav.active && !go.results.length && !nav.status) setTimeout(() => $('#go-q').focus(), 50);
    }
  });

  $('#btn-close').addEventListener('click', closePanel);
  $('#btn-expand').addEventListener('click', () => $('#panel').classList.toggle('expanded'));
  $('#btn-raw').addEventListener('click', () => setRawOpen(!state.rawOpen));

  $('#go-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (nav.active) return toast('Stop navigation first');
    goSearch($('#go-q').value);
  });
  $('#go-quick').addEventListener('click', (e) => {
    const b = e.target.closest('[data-q]');
    if (!b) return;
    if (nav.active) return toast('Stop navigation first');
    goSearch(b.dataset.q);
  });
  goBody().addEventListener('click', (e) => {
    const row = e.target.closest('[data-go-id]');
    if (row) return goDetails(go.results.find((p) => p.overture_id === row.dataset.goId));
    const id = e.target.closest('button')?.id;
    if (id === 'btn-walk') startNav(go.selected);
    else if (id === 'btn-go-back') {
      nav.status = null;
      setRoute(null);
      redrawGoMarkers();
      renderGoResults();
    } else if (id === 'btn-stop') {
      stopNav(false);
      setRoute(null);
      redrawGoMarkers();
      renderNav();
    } else if (id === 'btn-check') checkProgress();
  });

  whatView().addEventListener('click', (e) => {
    const row = e.target.closest('[data-what-id]');
    if (row) return whatDetails(what.places.find((p) => p.overture_id === row.dataset.whatId));
    if (e.target.closest('#btn-what-back')) {
      what.detail = null;
      renderWhat();
    }
  });

  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) {
      e.preventDefault();
      copyText(entryJson(c.dataset.copy));
    }
  });

  $('#btn-log').addEventListener('click', () => {
    $('#log-screen').hidden = false;
    renderLog();
  });
  $('#btn-log-close').addEventListener('click', () => ($('#log-screen').hidden = true));
  $('#btn-log-copy').addEventListener('click', () =>
    copyText(JSON.stringify({
      userAgent: navigator.userAgent,
      standalone: window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
      compass: { tracking, counts: compass.counts, last: compass.last, heading: state.heading },
      calls: log.map((e) => ({ time: e.time.toISOString(), tool: e.tool, pos: e.pos, accuracy: e.accuracy, simulated: e.simulated, ms: e.ms, proxyMs: e.zephrMs, ok: e.ok, error: e.error, raw: e.raw })),
    }, null, 2))
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#log-screen').hidden) $('#log-screen').hidden = true;
    // Desktop testing: arrow keys turn a simulated heading.
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.target.closest('input, textarea')) {
      e.preventDefault();
      const step = (e.shiftKey ? 45 : 10) * (e.key === 'ArrowLeft' ? -1 : 1);
      sim.heading = true;
      setHeading((state.heading ?? 0) + step);
      params.set('heading', String(Math.round(state.heading)));
      history.replaceState(null, '', `?${params}`);
    }
  });

  // ---------- boot ----------
  renderStatus();
  initMap();
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
})();
