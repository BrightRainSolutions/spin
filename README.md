# Spin

A phone-first PWA for field-testing the [Zephr](https://zephr.xyz) places grounding MCP tools with
real GPS and compass heading. Three modes: **Here** (what's around me), **Go** (walk to the nearest
X), and **What's that?** (point the phone). Every call's raw JSON-RPC request and response is one tap
away (**Raw** in each panel, **Log** for the whole session).

Spec: `zephr-spin-spec.md`. Findings that override the spec: `docs/notes.md`.

## Layout

```
public/                  static app, no build step (Mapbox GL JS from CDN)
  here.js, here.css      portable "what's here" module (meant to be lifted into bratlas)
  app.js, style.css      the rest of the app
netlify/functions/zephr.js   proxy: holds the API key, speaks MCP to Zephr
scripts/list-tools.js    Step 0 discovery; also `node scripts/list-tools.js <tool> '<json>'`
scripts/make-icons.js    regenerates public/icons/*.png
docs/                    tool schemas, sample responses, notes
```

## Environment variables

| Name | Where | What |
| --- | --- | --- |
| `ZEPHR_API_KEY` | Netlify + local `.env` | Zephr API key. Never sent to the browser. |
| `ZEPHR_API_BASE` | Netlify + local `.env` | `https://api.zephr.xyz` (the proxy appends `/mcp/`). |
| `MAPBOX_TOKEN` | Netlify + local `.env` | Public Mapbox token (`pk.…`). Restrict it to `spin.brightrain.com`, your `*.netlify.app` URL and `localhost` in the Mapbox account. Served to the page by `GET /.netlify/functions/zephr`. Without it the app runs with no map. |

`.env` is gitignored. Never commit it.

## Local development

```bash
npm install -g netlify-cli
netlify dev
```

`netlify dev` reads `.env`, serves `public/` and runs the function, usually at
http://localhost:8888.

### Simulating position and heading on a desktop

Add URL params: `?lat=40.5875&lon=-105.0775&heading=90`. A yellow **SIMULATED** badge shows. With a
simulated position:

- click the map to move there (useful for testing Go progress);
- press ← / → to turn the heading 10° (hold Shift for 45°). This works without URL params too.

## Deploying

1. In Netlify: **Add new site → Import from Git →** `BrightRainSolutions/spin`. No build command;
   publish directory `public` and functions directory come from `netlify.toml`.
2. **Site configuration → Environment variables:** add `ZEPHR_API_KEY`, `ZEPHR_API_BASE` and
   `MAPBOX_TOKEN`. Mark the API key as secret.
3. **Domain management → Add a domain:** `spin.brightrain.com`. At the DNS host for
   `brightrain.com`, add `CNAME spin → <site-name>.netlify.app`. Netlify issues the certificate.
4. Pushing to `main` deploys.

The proxy only accepts POSTs whose `Origin` is `spin.brightrain.com`, localhost, or the site's own
Netlify URLs, and only the five allowlisted tools.

## On the iPhone

Open `https://spin.brightrain.com` in Safari, then **Share → Add to Home Screen**. Tap **What's
that?** (or **Enable compass**) once to grant motion and orientation access. iOS only asks from a tap.

## Known limits (details in docs/notes.md)

- Zephr issues no MCP session id, and navigation state is shared per API key, so two people
  navigating at once will clash.
- `find_nearest_to_me` returns at most 5 results, so "around you" lists come from 5 category
  searches run one after another (Zephr seems to queue a key's requests).
- `navigate_to_place` can't take a place id. Spin routes by name and warns if the destination is
  more than 50 m from the place you picked.
- Brand comes back as a plain name with no Wikidata id, so there's no "more about" link.

Powered by [Zephr](https://zephr.xyz). Not an official Zephr product.
