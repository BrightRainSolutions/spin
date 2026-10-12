# Zephr Spin: MVP Spec

A mobile-first PWA for testing the Zephr Places Grounding MCP (full toolkit) on an iPhone, using browser geolocation and compass heading. The goal is to find out what the Zephr data and tools actually return in the real world, so raw responses are always one tap away.

Working name: Zephr Spin. Hosted on Netlify at `spin.brightrain.com` (CNAME to the Netlify site). Do not use "zephr" in the domain; it should not read as an official Zephr product. Show a small "Powered by Zephr" credit linking to zephr.xyz.

**Existing scaffold:** the repo and a `.env` already exist. The `.env` holds the Zephr API key, a Zephr base URL, and an Orcapelago URL. Read it first and use the variable names already there instead of the names in this spec (`ZEPHR_API_KEY` below means whatever the key variable is called). Use the base URL variable instead of hardcoding `https://api.zephr.xyz/mcp/`. Ignore the Orcapelago URL; it is out of scope for this build. Never print the key's value in output or logs.

## Constraints

- **No build step for the front end.** Plain HTML, CSS, and JS. Libraries from CDN only. No bundler, no transpiler, no npm packages in the app.
- **Hosting:** Netlify, deployed from a GitHub repo (push to deploy). One Netlify Function acts as the proxy. Netlify CLI (`netlify dev`) is used for local development only.
- **Function code:** plain JavaScript, Node runtime, using built-in `fetch`. No npm dependencies.
- **Map:** Mapbox GL JS (CDN), same as bratlas. Use `mapboxgl.GeolocateControl` with `trackUserLocation: true` and `showUserHeading: true`. Mapbox token restricted to the app's domain.
- **Target device:** iPhone 11, current iOS, installed to the home screen as a PWA. Must also work in desktop Firefox for development.
- **No LLM in the loop.** The app calls Zephr tools directly.

## Architecture

```
iPhone PWA (HTML/JS)  --->  /.netlify/functions/zephr  --->  https://api.zephr.xyz/mcp/
   lat, lon, heading,         adds API key,                   MCP over streamable HTTP
   MCP session id             forwards, stateless             (JSON-RPC 2.0)
```

### Why a proxy

The Zephr API key must never reach the browser. The function holds it and relays calls.

### Session handling (stateless proxy)

MCP sessions are identified by an `Mcp-Session-Id` header that Zephr returns after `initialize`. Rather than storing it server-side, the **browser holds it** (in memory, plus `sessionStorage` wrapped in try/catch) and sends it with every call. The id is not a secret; the API key is. This keeps the function stateless.

The session matters because `check_navigation_progress` is stateful: it remembers the route set by `navigate_to_place` within the same MCP session.

### netlify/functions/zephr.js

- Reads the key from the Netlify environment variable `ZEPHR_API_KEY`. For local dev, `netlify dev` reads it from a `.env` file that is gitignored.
- Accepts `POST` with JSON body `{ "tool": "<name>", "args": { ... }, "sessionId": "<id or null>" }`.
- Allowlist: only `get_location`, `find_nearest_to_me`, `get_place_details`, `navigate_to_place`, `check_navigation_progress`. Reject anything else with 400.
- Talks to Zephr as an MCP client over streamable HTTP:
  - Headers on every request: `x-api-key: <key>`, `Content-Type: application/json`, `Accept: application/json, text/event-stream`, plus `Mcp-Session-Id` when one exists.
  - If `sessionId` is null: send JSON-RPC `initialize`, read the `Mcp-Session-Id` response header, send the `notifications/initialized` notification, then proceed with that id.
  - If Zephr responds 404 or reports the session expired: re-initialize once, retry, and return the new id.
  - Send the tool call as JSON-RPC `tools/call` with `{ name, arguments }`.
  - **Response parsing:** Zephr may answer with plain JSON or an SSE stream (`text/event-stream`, lines starting `data: `). Handle both; read the whole response and return the final JSON-RPC result.
- Returns to the browser: `{ "ok": true, "sessionId": "<current id>", "result": <tool result>, "raw": { "request": <JSON-RPC sent>, "response": <JSON-RPC received> } }`, or `{ "ok": false, "error": "..." }`.
- Basic abuse guard: reject requests whose `Origin` isn't the app's domain or localhost.

## Step 0 (do this before writing UI code)

Discover the real tool schemas. Do not guess parameter names.

1. Write a small one-off Node script (`scripts/list-tools.js`, reads `ZEPHR_API_KEY` from `.env`) that initializes a session and calls `tools/list` against `https://api.zephr.xyz/mcp/`.
2. Save the output to `docs/zephr-tools.json`.
3. Use those schemas for every call below. Note in `docs/notes.md` anything surprising: required vs optional params, units (meters?), what each response actually contains (coordinates? bearings? entrance descriptions?).

**Data points to check and record in `notes.md`:**
- Does `get_place_details` return the brand as a name only, or with a Wikidata QID (Overture places carry brand Wikidata IDs)? If a QID comes back, show a "more about" link to Wikidata for that place, same pattern as bratlas.

If a use case below assumes data the schemas don't provide (for example, place coordinates in `find_nearest_to_me` results), say so in `notes.md` and pick the closest workable approach instead of faking it.

## Location and heading (client side)

- Position: `GeolocateControl` `geolocate` event (`e.coords.latitude`, `e.coords.longitude`, `e.coords.accuracy`). Show the accuracy in meters in the status bar.
- Heading: on iOS, `DeviceOrientationEvent.requestPermission()` must be called from a user tap. Use `event.webkitCompassHeading` when present, otherwise `360 - event.alpha`. Show the current heading in degrees in the status bar.
- **Manual override for testing:** URL params `?lat=&lon=&heading=` replace live values, so the app can be tested from a desktop. Show a visible "SIMULATED" badge when active.

## Use cases

The UI is a full-screen map with three mode buttons along the bottom: **Here**, **Go**, **What's that?** A slide-up panel shows results for the current mode.

### 1. Here (what's around me)

- Tap **Here**: call `get_location` with the current position.
- Panel shows the street you're on and the list of nearby places.
- Build the Here panel as a self-contained module (its own JS file and CSS block, taking a position and a callback for the proxy call). It will later be lifted into bratlas.brightrain.com as a "what's here" section, so avoid coupling it to the rest of this app.
- If results include coordinates, drop markers on the map; tapping a marker or list row calls `get_place_details` and shows contact, address, brand, and the visual/entrance descriptions.

### 2. Go (take me to the nearest X)

- Tap **Go**: text box ("coffee", "bike shop", "ATM") plus a Search button.
- Call `find_nearest_to_me` with the query and current position. List results with distance and cardinal direction as returned by Zephr.
- Tap a result: call `get_place_details`, show it, with a **Walk there** button.
- **Walk there:** call `navigate_to_place`. Show the steps as a list, current step highlighted.
- While navigating, call `check_navigation_progress` with the current position every 15 seconds, or whenever the user has moved more than 10 m since the last check, whichever comes first. Update the highlighted step and remaining distance from the response.
- **Stop** button ends navigation and stops polling.

### 3. What's that? (point the phone)

- Tap **What's that?**: requests compass permission if not granted, then gets nearby places (from `get_location` or `find_nearest_to_me` with a broad query, whichever Step 0 shows works better).
- Client side, compute the bearing from the user to each place and keep the ones within ±30° of the current heading. Sort by distance.
- Panel shows the filtered list, updating live as the user turns. Draw a translucent wedge on the map showing the ±30° view cone.
- Re-fetch places when the user moves more than 25 m.
- If place coordinates aren't available from Zephr, fall back to filtering on the cardinal direction Zephr returns (N, NE, E...) and note the limitation in the panel.

## Raw data view

The point of the app is evaluating Zephr, so:

- Every panel has a **Raw** toggle showing the last JSON-RPC request and response for that call, pretty-printed and copyable.
- A **Log** screen (from a menu) lists every call this session: time, tool, position used, accuracy at the time, response time in ms. Kept in memory only.

## PWA

- `manifest.webmanifest` with name, icons, `display: standalone`, theme color.
- Minimal service worker that caches the app shell only. Never cache `/.netlify/functions/` responses.

## Look and feel

Should have some personality, not a bland default. Bold accent color, clear big touch targets for one-handed use while walking, readable in sunlight. Status bar at top: accuracy, heading, simulated badge.

## Files

```
netlify.toml                  (publish dir, functions dir; no build command)
.env                          (ZEPHR_API_KEY for local dev; gitignored)
.gitignore
public/
  index.html
  app.js
  style.css
  manifest.webmanifest
  sw.js
  icons/
netlify/functions/zephr.js
scripts/list-tools.js         (Step 0)
docs/zephr-tools.json         (from Step 0)
docs/notes.md                 (findings, quirks, schema surprises)
README.md                     (local dev with netlify dev, setting ZEPHR_API_KEY in Netlify, CNAME for the subdomain)
```

## Out of scope for MVP

- Claude or any LLM layer (possible phase 2: natural-language queries)
- User accounts, saved places, persistence
- The Lightweight `/mcplite` server
- Zephr Positioning SDK (Android only)
- Orcapelago gazetteer integration (Zephr uses Overture places; little overlap with water and shoreline entries)
- The bratlas integration itself (just keep Here portable)

## Done when

- On the iPhone PWA, standing outside, each of the three modes returns real Zephr data for the current location.
- A walk to a nearby coffee shop using **Go** shows progress updates along the way.
- Raw request and response are visible for every call.
- The API key is not visible anywhere in browser dev tools or page source.
