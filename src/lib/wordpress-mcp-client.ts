import "server-only";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// In-admin CMS-assistant MCP-only egress (cinatra#1214 S1). The in-admin
// WordPress assistant must reach WordPress content ONLY through the site's MCP
// integration — never a direct `/wp/v2/*` REST call carrying the stored
// Application Password. This is the WordPress sibling of `drupal-mcp-client.ts`
// `callDrupalMcp`: a StreamableHTTP MCP client that speaks to the Cinatra
// content MCP server the WordPress plugin registers (cinatra-ai/wordpress-plugin
// #81 / S0), calling the plugin-owned `cinatra-post-get` / `cinatra-post-update`
// tools instead of the direct REST client.
//
// AUTH: the Adapter endpoint is a WordPress REST route authenticated with the
// SAME Application Password the REST client uses — only the TRANSPORT changes.
// The Basic header is resolved HOST-SIDE through the connector's own relocated
// client (`resolveWordPressBasicAuth` → Nango credential + the #1077
// instance-connection use-gate + audit `source:"wordpress-api"`), bound into the
// deps slot as `buildWordPressBasicAuthHeader`. This preserves the existing
// use-gate + audit semantics; the connector never reads a raw credential field
// (NOT the toolbox.ts direct `username:applicationPassword` shortcut).
import { getWordPressDeps, type WordPressMcpInstance } from "../deps";

/**
 * The dedicated Cinatra content MCP server the WordPress plugin registers with
 * the MCP Adapter (`cinatra_register_mcp_content_server` →
 * `$adapter->create_server('cinatra-content-server', …)`, cinatra-ai/wordpress-plugin
 * #81). Built connector-side from the instance `siteUrl` in the query-string
 * (`?rest_route=`) form so it resolves WITHOUT pretty permalinks — the same
 * WordPress-config-agnostic form the REST client and the external-MCP toolbox
 * use. (The existing `deps.resolveMcpServerUrl` resolves the Adapter's DEFAULT
 * server, not this dedicated Cinatra server, so the Cinatra route is a
 * connector-side constant — the WordPress analogue of the Drupal client's
 * `/_mcp_tools` path.)
 */
const CINATRA_CONTENT_MCP_ROUTE = "/index.php?rest_route=/mcp/cinatra-content-server";

/** First-class MCP tool names the plugin exposes for the two abilities. The MCP
 * Adapter derives each tool name from its ability id by turning
 * "namespace/name" into "namespace-name" (the abilities-api id regex forbids
 * underscores), so `cinatra/post-get` → `cinatra-post-get`. */
export const CINATRA_POST_GET_TOOL = "cinatra-post-get";
export const CINATRA_POST_UPDATE_TOOL = "cinatra-post-update";
// wordpress-plugin#82 — the remaining in-admin content primitives, rehomed onto
// plugin MCP abilities. Same "namespace/name" → "namespace-name" derivation.
export const CINATRA_POST_STATUS_TOOL = "cinatra-post-status";
export const CINATRA_POSTS_LIST_TOOL = "cinatra-posts-list";
export const CINATRA_POST_DELETE_TOOL = "cinatra-post-delete";
export const CINATRA_MEDIA_UPLOAD_TOOL = "cinatra-media-upload";
export const CINATRA_POST_CREATE_DRAFT_TOOL = "cinatra-post-create-draft";
export const CINATRA_POST_UPDATE_META_TOOL = "cinatra-post-update-meta";

/** Build the dedicated Cinatra content MCP server URL for an instance. */
function resolveCinatraContentServerUrl(siteUrl: string): string {
  return siteUrl.replace(/\/+$/, "") + CINATRA_CONTENT_MCP_ROUTE;
}

/**
 * Call a Cinatra content MCP tool on the WordPress plugin's dedicated MCP
 * server. A near-copy of `drupal-mcp-client.ts` `callDrupalMcp`, with WordPress
 * auth (Application-Password Basic via the host `buildWordPressBasicAuthHeader`
 * dep) and a REQUIRED runtime tool-detection step.
 *
 * FAIL-CLOSED (cinatra#1214 design §A). Before trusting the Adapter,
 * this probes the server's `tools/list` and REFUSES (throws a descriptive
 * error) when the requested Cinatra tool is absent — an older plugin install
 * that predates the content abilities degrades gracefully to a hard error and
 * NEVER silently falls back to a direct `/wp/v2/*` REST call. This makes the
 * S0→S1 dependency (the plugin abilities must exist) enforced at RUNTIME, not
 * just at deploy order.
 *
 * The Application Password is resolved host-side and never appears in an error
 * message.
 */
export async function callWordPressMcp(
  instance: WordPressMcpInstance,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const baseUrl = resolveCinatraContentServerUrl(instance.siteUrl);

  // Host-side Basic-auth resolution (Nango + #1077 use-gate + audit). Throws
  // fail-closed on a use-gate deny or a missing credential; the token never
  // appears in the thrown message.
  const authHeader = await getWordPressDeps().buildWordPressBasicAuthHeader({ instance });
  if (!authHeader || typeof authHeader.Authorization !== "string" || authHeader.Authorization.length === 0) {
    throw new Error(
      `WordPress MCP call failed: credential unavailable for site ${instance.siteUrl}`,
    );
  }

  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: {
      headers: { Authorization: authHeader.Authorization },
    },
  });
  const client = new Client({ name: "cinatra-connector-wordpress", version: "1.0.0" });
  try {
    await client.connect(transport);

    // Runtime tool-detection + fail-closed. The Cinatra content abilities ship
    // in the plugin (S0); an install without them (missing/too-old plugin)
    // exposes no such tool, and this path must NOT degrade to direct REST.
    const listed = await client.listTools();
    const available = Array.isArray(listed?.tools) ? listed.tools : [];
    const hasTool = available.some((t) => t?.name === toolName);
    if (!hasTool) {
      throw new Error(
        `WordPress MCP tool "${toolName}" is not available on ${instance.siteUrl} — ` +
          "the Cinatra WordPress plugin is missing or too old to expose the content " +
          "abilities (cinatra-content-server). Refusing to fall back to a direct REST " +
          "call (cinatra#1214). Update the Cinatra WordPress plugin to enable in-admin editing.",
      );
    }

    const result = await client.callTool({ name: toolName, arguments: args });
    return unwrapToolResult(result, toolName);
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Unwrap the MCP `tools/call` result the Adapter returns for a Cinatra ability.
 * The Adapter maps the ability's `output_schema` to `structuredContent` (the
 * clean JSON payload) alongside a text content block; a WordPress `WP_Error`
 * surfaces as an error result. Prefer `structuredContent`; fall back to parsing
 * the text block; surface a real error rather than a misleading "not found".
 */
function unwrapToolResult(result: unknown, toolName: string): unknown {
  const r = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type: string; text?: string }>;
  };

  const textItem = Array.isArray(r.content)
    ? r.content.find((c) => c.type === "text" && typeof c.text === "string")
    : undefined;

  // The Adapter flags a WP_Error / failed ability with isError:true.
  if (r.isError) {
    const detail = textItem?.text ?? errorMessageFrom(r.structuredContent);
    throw new Error(`WordPress ${toolName} failed: ${detail || "unknown error"}`);
  }

  // Prefer the structured payload (the ability output-schema object).
  if (r.structuredContent && typeof r.structuredContent === "object") {
    const sc = r.structuredContent as Record<string, unknown>;
    // A serialized WP_Error envelope ({ code, message, data:{status} }) carries
    // no post `id` — surface it as an error, not a post payload.
    if (isWpErrorShape(sc)) {
      throw new Error(`WordPress ${toolName} error (${String(sc.code)}): ${String(sc.message)}`);
    }
    return sc;
  }

  // Text fallback — the Adapter returns the ability result as JSON text.
  if (!textItem || typeof textItem.text !== "string") {
    throw new Error(`WordPress ${toolName}: unexpected response format (no structured or text content)`);
  }
  try {
    const parsed = JSON.parse(textItem.text) as Record<string, unknown>;
    if (isWpErrorShape(parsed)) {
      throw new Error(`WordPress ${toolName} error (${String(parsed.code)}): ${String(parsed.message)}`);
    }
    return parsed;
  } catch (err) {
    // Re-throw a WP_Error we detected; otherwise return the raw text.
    if (err instanceof Error && err.message.startsWith(`WordPress ${toolName} error`)) throw err;
    return textItem.text;
  }
}

/** A serialized WordPress `WP_Error` payload: `code` + `message`, no post `id`. */
function isWpErrorShape(o: Record<string, unknown>): boolean {
  return (
    typeof o.code === "string" &&
    typeof o.message === "string" &&
    !("id" in o)
  );
}

function errorMessageFrom(structured: unknown): string | undefined {
  if (structured && typeof structured === "object") {
    const s = structured as Record<string, unknown>;
    if (typeof s.message === "string") return s.message;
  }
  return undefined;
}
