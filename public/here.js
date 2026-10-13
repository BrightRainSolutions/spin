// "What's here" panel: portable module, no dependencies on the rest of Spin.
// Intended to be lifted into bratlas as-is, together with here.css.
//
//   const here = ZephrHere.createHerePanel(el, {
//     call: (tool, args) => Promise<structuredContent>,  // throws on error
//     onPlaces: (places, done) => {}, // places with overture_id, latitude, longitude; fires as results arrive
//     onDetails: (place, el) => {}, // optional: after a details view renders (to add buttons)
//   });
//   here.load({ lat, lng, heading });
//   here.showDetails({ overture_id } | { name }, { lat, lng, heading });
(function () {
  'use strict';

  // find_nearest_to_me refuses an empty query and caps results at 5, so a broad
  // "what's around" list is several category queries merged by overture_id. Zephr appears to
  // handle one request per API key at a time, so they run in sequence and report progress.
  const NEARBY_QUERIES = ['restaurant', 'cafe', 'shop', 'bar', 'business'];

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function fmtDistance(m) {
    if (m == null) return '';
    return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
  }

  // "southeast (14m)" -> "southeast"; relative prose is left alone.
  function directionWord(direction) {
    return String(direction || '').replace(/\s*\(\d+\s*m\)\s*$/, '');
  }

  function posArgs(pos) {
    const a = { lat: pos.lat, lng: pos.lng };
    if (pos.heading != null) a.heading = Math.round(pos.heading);
    return a;
  }

  // onProgress({ places, errors, done, total }) fires after each query.
  async function fetchNearby(call, pos, { queries = NEARBY_QUERIES, onProgress = () => {}, isCancelled = () => false } = {}) {
    const byId = new Map();
    const errors = [];
    const snapshot = (done) => ({
      places: [...byId.values()].sort((a, b) => a.distance_m - b.distance_m),
      errors: [...errors],
      done,
      total: queries.length,
    });
    for (let i = 0; i < queries.length; i++) {
      if (isCancelled()) break;
      try {
        const s = await call('find_nearest_to_me', { lat: pos.lat, lng: pos.lng, query: queries[i] });
        for (const p of s?.places || []) {
          if (!byId.has(p.overture_id)) byId.set(p.overture_id, { ...p, matched_query: queries[i] });
        }
      } catch (err) {
        errors.push(`${queries[i]}: ${err.message}`);
      }
      if (!isCancelled()) onProgress(snapshot(i + 1));
    }
    return snapshot(queries.length);
  }

  function link(href, label) {
    return `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>`;
  }

  const DETAIL_FIELDS = [
    'address', 'phone', 'website', 'facebook_url', 'brand', 'hours', 'visual_description',
    'entrance', 'cuisine', 'price_range', 'menu_url', 'rating',
  ];

  function renderValue(v) {
    if (v == null) return '';
    if (typeof v === 'object') return `<pre class="zh-obj">${esc(JSON.stringify(v, null, 2))}</pre>`;
    return esc(v);
  }

  function renderPlaceDetails(p) {
    const rows = [];
    const add = (label, html) => rows.push(`<div class="zh-row"><dt>${label}</dt><dd>${html}</dd></div>`);
    if (p.address) add('Address', esc(p.address));
    if (p.phone) add('Phone', link(`tel:${p.phone}`, p.phone));
    if (p.website) add('Website', link(p.website, p.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')));
    if (p.facebook_url) add('Facebook', link(p.facebook_url, 'Facebook page'));
    // Zephr returns brand as a plain name, without Overture's Wikidata id (docs/notes.md).
    if (p.brand) add('Brand', renderValue(p.brand));
    if (p.hours) add('Hours', renderValue(p.hours));
    if (p.visual_description) add('Looks like', renderValue(p.visual_description));
    if (p.entrance) add('Entrance', renderValue(p.entrance));
    if (p.cuisine) add('Cuisine', renderValue(p.cuisine));
    if (p.price_range) add('Price', renderValue(p.price_range));
    if (p.menu_url) add('Menu', link(p.menu_url, 'Menu'));
    if (p.rating) add('Rating', renderValue(p.rating));
    const missing = DETAIL_FIELDS.filter((f) => p[f] == null);
    return `
      <div class="zh-details">
        <h3 class="zh-name">${esc(p.name)}</h3>
        <p class="zh-meta">${esc(p.category || '')}${p.distance_m != null ? ` · ${fmtDistance(p.distance_m)} ${esc(directionWord(p.direction))}` : ''}</p>
        <dl>${rows.join('')}</dl>
        ${missing.length ? `<p class="zh-missing">Not provided by Zephr: ${missing.map((f) => esc(f)).join(', ')}</p>` : ''}
      </div>`;
  }

  function placeRow(p, attrs) {
    return `
      <li><button type="button" class="zh-place" ${attrs}>
        <span class="zh-place-main">
          <span class="zh-place-name">${esc(p.name)}</span>
          <span class="zh-place-cat">${esc(p.category || '')}${p.address ? ` · ${esc(p.address)}` : ''}</span>
        </span>
        <span class="zh-place-dist">${fmtDistance(p.distance_m)}<small>${esc(directionWord(p.direction))}</small></span>
      </button></li>`;
  }

  function createHerePanel(el, opts) {
    const { call, onPlaces = () => {}, onDetails = () => {} } = opts;
    let lastPos = null;
    let lastHtml = '';
    let token = 0;
    let detailOpen = false;

    el.classList.add('zh');

    function setHtml(html) {
      el.innerHTML = html;
    }

    async function load(pos) {
      lastPos = pos;
      detailOpen = false;
      const my = ++token;
      setHtml('<p class="zh-loading">Asking Zephr what\'s here…</p>');
      let loc;
      try {
        loc = { ok: true, value: await call('get_location', posArgs(pos)) };
      } catch (err) {
        loc = { ok: false, error: err.message };
      }
      if (my !== token) return;

      const top = [];
      if (loc.ok) {
        const s = loc.value;
        top.push(`<p class="zh-street">${s.street ? `On <strong>${esc(typeof s.street === 'object' ? s.street.name || JSON.stringify(s.street) : s.street)}</strong>` : 'Not near a named road'}</p>`);
        if (s.directly_ahead) {
          const d = s.directly_ahead;
          top.push(`<p class="zh-ahead">Directly ahead: <button type="button" class="zh-link" data-name="${esc(d.name)}">${esc(d.name)}</button> <span>${esc(d.category || '')} · ${fmtDistance(d.distance_m)}</span></p>`);
        }
        const nearby = s.nearby_places || [];
        top.push(`<h4 class="zh-h">Right here <small>get_location · ${nearby.length}</small></h4>`);
        top.push(nearby.length
          ? `<ul class="zh-list">${nearby.map((p) => placeRow(p, `data-name="${esc(p.name)}"`)).join('')}</ul>`
          : '<p class="zh-empty">No places returned.</p>');
      } else {
        top.push(`<p class="zh-error">get_location failed: ${esc(loc.error)}</p>`);
      }

      const render = ({ places, errors, done, total }) => {
        const parts = [...top];
        parts.push(`<h4 class="zh-h">Around you <small>find_nearest_to_me ${done}/${total} · ${places.length}</small></h4>`);
        if (places.length) parts.push(`<ul class="zh-list">${places.map((p) => placeRow(p, `data-id="${esc(p.overture_id)}"`)).join('')}</ul>`);
        if (done < total) parts.push('<p class="zh-loading">Searching nearby categories…</p>');
        else if (!places.length) parts.push('<p class="zh-empty">No places returned.</p>');
        if (errors.length) parts.push(`<p class="zh-error">${errors.map(esc).join('<br>')}</p>`);
        lastHtml = parts.join('');
        if (!detailOpen) setHtml(lastHtml);
        onPlaces(places, done === total);
      };
      render({ places: [], errors: [], done: 0, total: NEARBY_QUERIES.length });
      await fetchNearby(call, pos, { onProgress: render, isCancelled: () => my !== token });
    }

    let detailToken = 0;
    async function showDetails(ref, pos = lastPos) {
      detailOpen = true;
      const my = ++detailToken;
      setHtml('<p class="zh-loading">Getting details…</p>');
      const args = ref.overture_id ? { overture_id: ref.overture_id } : { name: ref.name };
      if (pos) Object.assign(args, posArgs(pos));
      const back = () => (lastHtml ? '<button type="button" class="zh-back">‹ Back</button>' : '');
      try {
        const s = await call('get_place_details', args);
        if (my !== detailToken || !detailOpen) return;
        setHtml(back() + renderPlaceDetails(s.place || {}));
        onDetails(s.place || {}, el);
      } catch (err) {
        if (my !== detailToken || !detailOpen) return;
        setHtml(`${back()}<p class="zh-error">${esc(err.message)}</p>`);
      }
    }

    el.addEventListener('click', (e) => {
      const back = e.target.closest('.zh-back');
      if (back) {
        detailOpen = false;
        detailToken++;
        setHtml(lastHtml);
        return;
      }
      const t = e.target.closest('[data-id], [data-name]');
      if (!t || !el.contains(t)) return;
      if (t.dataset.id) showDetails({ overture_id: t.dataset.id });
      else showDetails({ name: t.dataset.name });
    });

    return { load, showDetails };
  }

  window.ZephrHere = { createHerePanel, fetchNearby, renderPlaceDetails, placeRow, fmtDistance, directionWord, esc, NEARBY_QUERIES };
})();
