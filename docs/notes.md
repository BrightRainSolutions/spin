# Zephr MCP: Step 0 findings

Discovered 2026-10-12 with `scripts/list-tools.js` against `https://api.zephr.xyz/mcp/`
(`ZEPHR_API_BASE` + `/mcp/`). Server: `zephr-grounding-mcp` 3.2.4 (FastMCP), protocol `2025-06-18`.
Full schemas are in `zephr-tools.json`. Real responses from Old Town Fort Collins (40.5875, -105.0775)
are in `samples/`.

## Surprises that change the spec

1. **The parameter is `lng`, not `lon`.** Every tool takes `lat` / `lng`. (The URL override can stay
   `?lon=`; the proxy call must send `lng`.)
2. **No `Mcp-Session-Id` header is returned.** `initialize` succeeds, but the server never issues a
   session id. The server looks stateless at the MCP transport level.
3. **Navigation state is not tied to an MCP session.** `navigate_to_place` and
   `check_navigation_progress` were sent in two separate processes, each with its own `initialize` and
   no session id, and the progress call still knew the destination. State appears to be keyed to the
   **API key** (or something else server-side). Consequences:
   - The browser-held session id in the spec has nothing to hold. Keep the plumbing (harmless, and
     future-proof if Zephr starts issuing ids), but don't rely on it.
   - Everyone using the app shares one API key, so two people navigating at once would overwrite each
     other's destination. Fine for a single tester; worth knowing.
   - The "re-initialize on 404 / expired session" path can't be exercised right now.
4. **`get_location` returns no coordinates and no `overture_id` for nearby places**, and only returned
   2 places here. Markers on the map and tap-for-details can't come from `get_location` alone.
   `find_nearest_to_me` *does* return `overture_id`, `latitude`, `longitude`, and `address`.
5. **Responses are plain JSON** (`application/json`), not SSE, for every call so far. The proxy should
   still handle both.
6. **Every result has both `content[0].text`** (human/LLM-readable summary) **and `structuredContent`**
   (machine-readable). The app should read `structuredContent`. No tool declares an `outputSchema`, so
   the shapes below are observed, not guaranteed.

## Units and conventions

- Distances: integer meters (`distance_m`).
- Heading in: degrees, 0 = north, 90 = east. Optional on every tool except `get_place_details`
  (optional there too). When given, directions become relative ("ahead", "to your left").
- `direction` out: a string combining the 8-point cardinal word and the distance, e.g.
  `"southeast (14m)"`. Parse the word before ` (`. No numeric bearing is returned anywhere; compute it
  client-side from coordinates when they exist.
- `distance_m` on a destination is straight-line, not walking distance (193 m straight vs ~347 m of
  steps in the progress sample).

## Tools

### get_location
- Required: `lat`, `lng`. Optional: `heading`.
- `structuredContent`: `coordinates {latitude, longitude}`, `heading`, `street` (string or null),
  `nearby_places[]`, `directly_ahead` (null without heading; presumably filled when heading given,
  untested).
- Each nearby place: `name`, `category`, `distance_m`, `direction`, `website`, `facebook_url`,
  `visual_description`, `entrance`, `amenities`. **No coordinates, no `overture_id`, no address.**
- At the test point `street` was null ("not near any road"); the point is mid-block, so expect this
  often away from a centerline.

### find_nearest_to_me
- Required: `lat`, `lng`. Optional: `query` (category/description), `name` (specific place; weighted
  90% semantic / 10% distance), `heading`. Both `query` and `name` are optional in the schema; calling
  with neither is untested.
- `structuredContent.places[]`: `overture_id`, `name`, `category`, `distance_m`, `direction`,
  `address`, `latitude`, `longitude`, `website`, `facebook_url`, `visual_description`, `entrance`,
  `crossings`, `amenities`.
- "coffee" returned 5 results sorted by distance (116 m to 704 m).

### get_place_details
- No required params in the schema, but in practice: either `overture_id` (preferred, exact), or
  `name` + `lat` + `lng`. `lat`/`lng` are optional with `overture_id` and add distance/direction.
  Optional: `heading`.
- `structuredContent.place`: `overture_id`, `name`, `category`, `address`, `latitude`, `longitude`,
  `website`, `facebook_url`, `phone`, `brand`, `distance_m`, `direction`, `visual_description`,
  `entrance`, `hours`, `cuisine`, `price_range`, `menu_url`, `rating`, `amenities_crawled_at`.
- For Dazbog Coffee, `visual_description`, `entrance`, `hours`, `cuisine`, `price_range`, `menu_url`,
  `rating` were all null. So far the "visual/entrance descriptions" advertised in the description
  haven't appeared in any response (also null in every `find_nearest_to_me` result).

### navigate_to_place
- Required: `lat`, `lng`. Optional: `query`, `name`, `heading` (first step becomes relative).
  **No `overture_id` parameter**: you can't navigate to the exact place picked from a list, only to a
  name/query match. Pass the selected place's `name`; with 90% semantic weighting it should resolve to
  the same place, but compare the returned `destination` lat/lng against the selected place and flag a
  mismatch in the UI.
- `structuredContent`: `destination {name, category, distance_m, direction, address, latitude,
  longitude, walking_minutes}`, `steps[] {instruction, distance_m, places_along[] {name, side}}`,
  `street_crossings[] {name, distance_m}`, `route_geometry` (GeoJSON LineString, `[lng, lat]`).
- `route_geometry` can be drawn directly on the Mapbox map.
- Quirks in the text summary: "Start by: around" (empty value), and
  `Navigation tips: {"venue_type": "office"}` as raw JSON for a coffee shop. One street crossing was at
  478 m on a ~409 m route.

### check_navigation_progress
- Required: `lat`, `lng`. Optional: `heading`.
- `structuredContent`: `status` (`on-track` / `off-route` / `arrived` / `regressed` per the
  description; observed `regressed`), `destination {name, distance_m, direction, latitude, longitude,
  walking_minutes}`, `steps[]` (same shape as above), `route_geometry`.
- **It re-routes from the current position every call** and returns a fresh step list. There is no
  "current step index" into the original route. For the Go UI: replace the step list with the new one
  and highlight its first step; remaining walking distance = sum of `steps[].distance_m`.
- Moving ~70 m east (toward the destination, but off the original "head south" first step) reported
  `regressed`. Status is measured against the original route, not straight-line progress.

## Wikidata brand QID

**Answer: no QID. `brand` is a plain string.** `get_place_details` on Starbucks, 460 S College Ave
(`overture_id` d4ef8dbb-8220-41d6-8817-608b158a0f21) returned `"brand": "Starbucks"`, with no object
and no `wikidata` field. Zephr flattens Overture's brand to its name, so the "more about" Wikidata
link from bratlas **can't be built from Zephr data**. The app shows the brand name only. It does not
guess a QID from the name. Dazbog Coffee (a regional chain) had `brand: null`.

Also from the Starbucks lookup: `find_nearest_to_me {name: "Starbucks"}` returned 5 Starbucks, but
**not in distance order** (601, 1026, 2399, 1895, 2563 m), since `name` weighting is 90% semantic.
Sort client-side by `distance_m` when showing results. The store's `website` is the generic
store locator.

## Follow-up calls (2026-10-12)

Samples: `samples/get_place_details_starbucks.json`, `samples/find_nearest_no_query.json`,
`samples/get_location_heading.json`, `samples/find_starbucks.json`.

### find_nearest_to_me with no query: refused, and not flagged as an error
- Response is `isError: false`, **no `structuredContent`**, and `content[0].text` =
  "Either query or name must be provided." **Tool-level errors can arrive as ordinary results.** The
  app treats a result with no `structuredContent` as an error and shows the text.
- **Results are capped at 5** for every query tried. There is no limit/radius parameter.
- Broad queries are matched semantically, partly against the place *name*: `"place"` returned
  "Sense of Place" and "The Place Setting Company". `"shop"`, `"restaurant"` and `"business"` each gave
  5 sensible, distinct, nearby results (35–717 m).
- **Decision for What's that?:** fan out several category queries in parallel (restaurant, cafe, bar,
  shop, store, business), merge by `overture_id`, and filter by bearing client-side. That's 6 calls per
  refresh (every 25 m of movement) and yields up to 30 places with coordinates. Shown in the panel and
  Log as separate calls.

### get_location with heading: `directly_ahead` fills in
- `heading: 90` gave `heading: {degrees: 90, cardinal: "East"}` and
  `directly_ahead: {name, category, distance_m}` (Rocky Mountain Goldworks, 109 m). **No coordinates
  or `overture_id`** on `directly_ahead`, and the place was not one of the `nearby_places`.
- `nearby_places[].direction` becomes relative prose: "in front of you to the right, towards the
  southeast". It no longer has the "(14m)" form.
- What's that? shows Zephr's own `directly_ahead` answer at the top of the panel, next to the
  client-side ±30° list, so the two can be compared.

## Implications for the use cases (these override the spec)

- **Here:** `get_location` (with heading when known) for the street, `directly_ahead` and its nearby
  list, plus the same category fan-out as What's that? to get places with coordinates for map
  markers. `get_location` rows open details via `get_place_details {name, lat, lng}`, a fuzzy lookup;
  fan-out rows and markers use `overture_id`.
- **Go:** `find_nearest_to_me {query}`, sorted by `distance_m`. "Walk there" calls `navigate_to_place`
  by `name` (no `overture_id` param) and warns if the returned destination is more than 50 m from the
  selected place. Draw `route_geometry`. Progress replaces the step list each call and highlights step
  1; remaining = sum of step distances.
- **What's that?:** category fan-out above, bearing filter ±30° client-side, plus `get_location`
  `directly_ahead`. The cardinal-direction fallback in the spec isn't needed.
- **Proxy:** all calls send `lng`. Session-id plumbing stays, but Zephr currently issues none.
  Navigation state is shared per API key.
- **Brand:** show the name only. No Wikidata link.
