// Stateless proxy between the Spin PWA and the Zephr MCP server.
//
// POST { tool, args, sessionId } -> { ok, sessionId, result, raw: { request, response }, ms }
// GET                            -> { mapboxToken } (public, URL-restricted token)
//
// The Zephr API key only ever lives here. See docs/notes.md for why the session id is
// usually null (Zephr doesn't currently issue one).

const ALLOWED_TOOLS = new Set([
  'get_location',
  'find_nearest_to_me',
  'get_place_details',
  'navigate_to_place',
  'check_navigation_progress',
]);

const PROD_HOSTS = new Set(['spin.brightrain.com']);

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function originAllowed(origin) {
  if (!origin) return false;
  let host;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return true;
  if (PROD_HOSTS.has(host)) return true;
  // Netlify sets these to the site's own URLs (primary and deploy preview).
  for (const u of [process.env.URL, process.env.DEPLOY_PRIME_URL, process.env.DEPLOY_URL]) {
    if (!u) continue;
    try {
      if (new URL(u).hostname === host) return true;
    } catch {}
  }
  return false;
}

// Zephr may answer with plain JSON or an SSE stream; return the last JSON-RPC message.
function parseBody(contentType, text) {
  if (!text || !text.trim()) return null;
  if ((contentType || '').includes('text/event-stream')) {
    let last = null;
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (data) last = JSON.parse(data);
    }
    return last;
  }
  return JSON.parse(text);
}

class SessionExpired extends Error {}

function makeClient(endpoint, key) {
  let nextId = 1;

  async function send(body, sessionId) {
    const headers = {
      'x-api-key': key,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await res.text();
    if (sessionId && (res.status === 404 || (res.status === 400 && /session/i.test(text)))) {
      throw new SessionExpired(text);
    }
    if (!res.ok) throw new Error(`Zephr HTTP ${res.status}: ${text.slice(0, 300)}`);
    return { sessionId: res.headers.get('mcp-session-id'), message: parseBody(res.headers.get('content-type'), text) };
  }

  async function initialize() {
    const init = await send({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'zephr-spin', version: '0.1.0' },
      },
    });
    if (init.message?.error) throw new Error(`initialize: ${init.message.error.message}`);
    const sid = init.sessionId || null;
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
    return sid;
  }

  async function callTool(tool, args, sessionId) {
    const request = { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: tool, arguments: args } };
    const { message } = await send(request, sessionId);
    return { request, response: message };
  }

  return { initialize, callTool };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'GET') {
    return json(200, { mapboxToken: process.env.MAPBOX_TOKEN || null });
  }
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  const origin = event.headers.origin || event.headers.Origin;
  if (!originAllowed(origin)) return json(403, { ok: false, error: 'Origin not allowed' });

  const key = process.env.ZEPHR_API_KEY;
  const base = process.env.ZEPHR_API_BASE;
  if (!key || !base) return json(500, { ok: false, error: 'Server is missing ZEPHR_API_KEY or ZEPHR_API_BASE' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { ok: false, error: 'Body must be JSON' });
  }
  const { tool, args = {}, sessionId = null } = body;
  if (!ALLOWED_TOOLS.has(tool)) return json(400, { ok: false, error: `Tool not allowed: ${tool}` });
  if (typeof args !== 'object' || Array.isArray(args) || args === null) {
    return json(400, { ok: false, error: 'args must be an object' });
  }

  const client = makeClient(base.replace(/\/+$/, '') + '/mcp/', key);
  const started = Date.now();
  let sid = sessionId;
  let raw;
  try {
    if (!sid) sid = await client.initialize();
    try {
      raw = await client.callTool(tool, args, sid);
    } catch (err) {
      if (!(err instanceof SessionExpired)) throw err;
      sid = await client.initialize();
      raw = await client.callTool(tool, args, sid);
    }
  } catch (err) {
    return json(502, { ok: false, error: err.message, sessionId: sid, ms: Date.now() - started });
  }

  const ms = Date.now() - started;
  const msg = raw.response;
  if (!msg) return json(502, { ok: false, error: 'Empty response from Zephr', sessionId: sid, raw, ms });
  if (msg.error) return json(200, { ok: false, error: msg.error.message || 'JSON-RPC error', sessionId: sid, raw, ms });
  return json(200, { ok: true, sessionId: sid, result: msg.result, raw, ms });
};
