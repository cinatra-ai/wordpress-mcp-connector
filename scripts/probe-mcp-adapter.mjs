#!/usr/bin/env node
// Diagnostic: probe a WordPress site's external MCP adapter and record its tool
// surface, so we can VERIFY which tools (esp. page tools) it exposes on a given
// adapter version. This is the same handshake the Cinatra host performs when it
// injects the adapter as an external MCP server.
//
// Usage:
//   WP_URL=http://localhost:8080 WP_USER=admin WP_APP_PASS='xxxx xxxx ...' \
//     node scripts/probe-mcp-adapter.mjs > recording.json
//
// The adapter uses the MCP streamable-HTTP transport: initialize returns an
// Mcp-Session-Id response header that every later request must echo. The
// default server is reachable at /wp-json/mcp/mcp-adapter-default-server and
// (without pretty permalinks) at ?rest_route=/mcp/mcp-adapter-default-server.
const base = (process.env.WP_URL || "http://localhost:8080").replace(/\/+$/, "");
const user = process.env.WP_USER || "admin";
const pass = process.env.WP_APP_PASS || "";
if (!pass) {
  console.error("WP_APP_PASS is required (a WordPress Application Password).");
  process.exit(2);
}
const auth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
const endpoint = `${base}/wp-json/mcp/mcp-adapter-default-server`;
const ACCEPT = "application/json, text/event-stream";

function parseBody(text) {
  const dataLines = text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  return JSON.parse(dataLines.length ? dataLines[dataLines.length - 1] : text);
}

// The negotiated protocol version from `initialize`. Per the MCP 2025-06-18
// Streamable HTTP transport, every request AFTER initialize must carry the
// `MCP-Protocol-Version` header (alongside the `Mcp-Session-Id`).
let negotiatedVersion = "2025-06-18";

async function rpc(sessionId, body) {
  const headers = {
    Authorization: auth,
    "Content-Type": "application/json",
    Accept: ACCEPT,
    "MCP-Protocol-Version": negotiatedVersion,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  return { res, json: body.id != null ? parseBody(await res.text()) : null };
}

async function main() {
  const initRes = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json", Accept: ACCEPT },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cinatra-adapter-probe", version: "1" } } }),
  });
  const initJson = parseBody(await initRes.text());
  negotiatedVersion = initJson?.result?.protocolVersion || negotiatedVersion;
  const sessionId = initRes.headers.get("mcp-session-id") || "";
  await rpc(sessionId, { jsonrpc: "2.0", method: "notifications/initialized" });

  const tools = (await rpc(sessionId, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })).json?.result?.tools || [];
  const toolNames = tools.map((t) => t.name);

  // The adapter's default server gates registered WordPress "abilities" behind a
  // discover/info/execute triad. Enumerate what it actually exposes.
  let discovered = [];
  if (toolNames.includes("mcp-adapter-discover-abilities")) {
    const call = (await rpc(sessionId, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mcp-adapter-discover-abilities", arguments: {} } })).json;
    const text = (call?.result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    try { discovered = JSON.parse(text).abilities || []; } catch { discovered = []; }
  }

  // The WordPress Abilities API registry (what abilities exist at all).
  let registry = [];
  try {
    const abRes = await fetch(`${base}/wp-json/wp-abilities/v1/abilities`, { headers: { Authorization: auth, Accept: "application/json" } });
    const abJson = await abRes.json();
    registry = (Array.isArray(abJson) ? abJson : []).map((a) => a.name).filter(Boolean);
  } catch { registry = []; }

  // Emit the EXACT schema pinned in src/__tests__/fixtures/mcp-adapter-tools.json
  // (minus the hand-written "note"), so re-running this probe reproduces the
  // fixture and keeps the recorded contract honest.
  const recording = {
    endpoint: "/wp-json/mcp/mcp-adapter-default-server",
    endpointQueryStringForm: "/index.php?rest_route=/mcp/mcp-adapter-default-server",
    protocolVersion: initJson?.result?.protocolVersion || null,
    serverName: initJson?.result?.serverInfo?.name || null,
    tools: toolNames,
    discoverAbilities: discovered,
    abilitiesRegistry: registry,
    pageTools: toolNames.filter((n) => /page/i.test(n)),
    postTools: toolNames.filter((n) => /post/i.test(n)),
  };
  console.log(JSON.stringify(recording, null, 2));
}
main().catch((e) => { console.error(e?.message || String(e)); process.exit(1); });
