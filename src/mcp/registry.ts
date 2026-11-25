import { z } from "zod";
import type { ExtensionMcpToolServer, ExtensionMcpToolResult } from "@cinatra-ai/sdk-extensions";
import {
  createWordPressPrimitiveHandlers,
  siteToolCallSchema,
  siteToolsListSchema,
} from "./handlers";

// cinatra-ai/cinatra#2022 S7 (PR-θ): the 12 old per-operation `wordpress_*`
// facade tools are DELETED. They are enumerated once, in this repo's CHANGELOG
// entry for that deletion, and are deliberately NOT re-spelled in shipped code
// (cinatra#2022's close gate is a SHIPPED-CODE search that must return zero
// hits for those names; this repo's CHANGELOG and the deletion-regression
// tests that assert their ABSENCE keep them by design) — they were thin
// wrappers routing through the plugin's own cinatra-content-server
// (Layer C, S8's deletion target) or, for the two in-admin editing tools
// (_post_get/_post_update), through the governed connector-instance invoker
// under the SAME transitional names. Callers reach the site's own MCP catalog
// directly through the two generic primitives below (`wordpress_site_tool_call`
// / `wordpress_site_tools_list`), which have been registered — dark — since S2.
const TOOL_META: Record<string, { description: string; inputSchema: z.ZodTypeAny }> = {
  // `wordpress_content_editor_run` is NOT registered here. cinatra-ai/cinatra
  // #2022 S7 extracted it into its own relay-only module (`./relay`) — see
  // the `registerWordPressPrimitives` loop below for why that keeps it off
  // tools/list (cinatra#246).

  // cinatra#2017 S2 — governed connector-instance invoker (Plane C). Registered
  // + classified + wired; shipped DARK in S2 (delegated deny-by-default + no
  // agent-run allowlist kept them off every live model surface) — S7 cut over
  // the perimeters that reach them and (PR-θ) deleted the old facade these
  // primitives supersede.
  "wordpress_site_tool_call": {
    description:
      "Call a READ ability of a connected WordPress site's own MCP catalog, through the governed connector-instance invoker. Provide toolName (and args matching that tool's schema). An ability that writes or publishes is refused here: call wordpress_site_tool_write for it. instanceId is required only when your session is not pinned to a single site; serverId only when the tool name is ambiguous across the site's enrolled MCP servers.",
    inputSchema: siteToolCallSchema,
  },
  "wordpress_site_tool_write": {
    description:
      "Call an ability of a connected WordPress site's own MCP catalog that writes or publishes, through the governed connector-instance invoker. Provide toolName (and args matching that tool's schema). In an agent run each call waits for the person's recorded decision. instanceId is required only when your session is not pinned to a single site; serverId only when the tool name is ambiguous across the site's enrolled MCP servers.",
    inputSchema: siteToolCallSchema,
  },
  "wordpress_site_tools_list": {
    description:
      "List the tools available on a connected WordPress site's own MCP catalog — each with its input schema, annotations, derived class, and policy status — through the governed connector-instance invoker. instanceId is required only when your session is not pinned to a single site; pass cursor to page through large catalogs.",
    inputSchema: siteToolsListSchema,
  },
};

// cinatra#3745: `wordpress_site_tool_write` writes and publishes on a person's
// behalf, so its registration declares `outward`: the host holds each call of
// it during an agent run for the person's recorded decision. Its inputs carry
// no stored item with a revision, so it names no subject. The read proxy and
// the list tool declare nothing. A declaration only adds a hold; it never
// authorizes a call, and a host that does not read the field ignores it.
// Spread from a constant so an SDK config type without the field accepts it.
const OUTWARD_TOOL_NAMES = new Set(["wordpress_site_tool_write"]);
const OUTWARD = { outward: {} };

// cinatra#3745 (owner decision 1234 A): a flow step reads the page and writes
// the reviewed change without a model. The host serves a connector tool to such
// a step only when its registration declares `passthroughStep`:
//   - "read": served to a verified step whose tool list names the tool, with no
//     person's decision; the host allows it only on a registration with no
//     `outward`. The read tool serves only a known read whose catalog row, on the
//     server that runs it, says read-only (`readRow` in ./handlers), and sends
//     that row's annotations as `expectedRawAnnotations`. The check is not
//     atomic with the call: the read class at execution must be enforced by
//     the host. A host that serves "read" steps must refuse, in the same
//     resolution that executes the call, an entry that is not read-class or
//     whose annotations differ from `expectedRawAnnotations`.
//   - "publishing": served only to a declared publishing step whose card a
//     person released, consumed once per released decision.
// Spread from a constant, like `outward`, so an SDK config type without the
// field accepts it. A host that does not read the field ignores it.
const PASSTHROUGH_STEPS: Record<string, { passthroughStep: "read" | "publishing" }> = {
  wordpress_site_tool_call: { passthroughStep: "read" },
  wordpress_site_tool_write: { passthroughStep: "publishing" },
};

export function registerWordPressPrimitives(server: ExtensionMcpToolServer) {
  const handlers = createWordPressPrimitiveHandlers();

  // cinatra#246: the content-editor RELAY (`wordpress_content_editor_run`,
  // `../mcp/relay.ts`) is a dispatch primitive (it sends an A2A task to the
  // wordpress-content-editor agent), not a CMS read/write capability, and
  // must NEVER be exposed as a model-visible MCP tool — when the leaf agent
  // has the cinatra MCP server injected it would otherwise see the name in
  // tools/list and call it, re-dispatching itself (observed: recursive
  // mcp_call -> 504). It is deliberately never part of `handlers` above (S7
  // extracted it into its own module precisely so this loop cannot
  // accidentally register it); callers import `runContentEditorRelay`
  // directly instead.
  for (const [name, handler] of Object.entries(handlers)) {
    const meta = TOOL_META[name] ?? { description: name, inputSchema: z.object({}).passthrough() };
    server.registerTool(
      name,
      {
        title: name,
        description: meta.description,
        inputSchema: meta.inputSchema,
        ...(OUTWARD_TOOL_NAMES.has(name) ? OUTWARD : {}),
        ...(PASSTHROUGH_STEPS[name] ?? {}),
      },
      async (input): Promise<ExtensionMcpToolResult> => {
        const result = await handler({
          primitiveName: name,
          input,
          // cinatra#409: this synthetic literal is NO LONGER an authorization
          // input. Write authz is enforced inside the handler via the host dep
          // `requireInstanceWriteAuthority`, which derives the trusted user
          // actor host-side from the active MCP request frame
          // (mcpRequestContextStorage) — NEVER from this field or from tool
          // input. `request.actor` is typed `unknown` by the SDK and is kept
          // here only to satisfy the ExtensionPrimitiveRequest shape; nothing
          // in the handlers reads it for an authorization decision.
          actor: { actorType: "model", source: "agent" },
          mode: "agentic",
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: Array.isArray(result)
            ? { items: result }
            : typeof result === "object" && result !== null
              ? (result as Record<string, unknown>)
              : { result },
        };
      },
    );
  }
}
