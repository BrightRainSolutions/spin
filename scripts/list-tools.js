// Step 0: discover Zephr MCP tool schemas.
//
//   node scripts/list-tools.js                       -> writes docs/zephr-tools.json
//   node scripts/list-tools.js <tool> '<json args>'  -> calls one tool, prints the JSON-RPC response
//
// Reads ZEPHR_API_KEY and ZEPHR_API_BASE from .env. Never prints the key.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function loadEnv() {
  const env = {};
  const text = fs.readFileSync(path.join(root, '.env'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

const env = loadEnv();
const KEY = env.ZEPHR_API_KEY;
const ENDPOINT = (env.ZEPHR_API_BASE || '').replace(/\/+$/, '') + '/mcp/';
if (!KEY || !env.ZEPHR_API_BASE) {
  console.error('ZEPHR_API_KEY and ZEPHR_API_BASE must be set in .env');
  process.exit(1);
}

let sessionId = null;
let nextId = 1;

// Zephr may answer with plain JSON or an SSE stream; return the last JSON-RPC message.
function parseBody(contentType, text) {
  if (!text.trim()) return null;
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

async function rpc(method, params, { notification = false } = {}) {
  const body = { jsonrpc: '2.0', method };
  if (params !== undefined) body.params = params;
  if (!notification) body.id = nextId++;

  const headers = {
    'x-api-key': KEY,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const res = await fetch(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${text.slice(0, 500)}`);
  return parseBody(res.headers.get('content-type'), text);
}

async function initialize() {
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'zephr-spin-list-tools', version: '0.1.0' },
  });
  await rpc('notifications/initialized', undefined, { notification: true });
  return init;
}

async function main() {
  const [tool, argsJson] = process.argv.slice(2);
  const init = await initialize();

  if (tool) {
    const res = await rpc('tools/call', { name: tool, arguments: argsJson ? JSON.parse(argsJson) : {} });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  const list = await rpc('tools/list', {});
  const out = {
    endpoint: ENDPOINT,
    fetchedAt: new Date().toISOString(),
    sessionIdReturned: Boolean(sessionId),
    serverInfo: init?.result?.serverInfo,
    protocolVersion: init?.result?.protocolVersion,
    capabilities: init?.result?.capabilities,
    instructions: init?.result?.instructions,
    tools: list?.result?.tools,
  };
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'zephr-tools.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote docs/zephr-tools.json: ${out.tools?.length ?? 0} tools`);
  for (const t of out.tools || []) console.log(' -', t.name);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
