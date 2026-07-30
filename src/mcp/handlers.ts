import { z } from "zod";
import type { ExtensionPrimitiveRequest } from "@cinatra-ai/sdk-extensions";
// cinatra-ai/cinatra#2022 S7 (PR-θ): the 12 old wordpress_* facade tools that
// used to live here (wordpress_status, _instances_list, _post_create_draft,
// _post_status, _post_delete, _media_upload, _posts_list, _pages_list,
// _post_get_latest, _post_get, _post_update_meta, _post_update) are DELETED.
// They were thin wrappers around either the plugin's own
// `cinatra-content-server` (`callWordPressMcp`, `../lib/wordpress-mcp-client`,
// now also deleted) or — for the two in-admin editing tools this design
// called `wordpress_post_get`/`wordpress_post_update` — the governed
// connector-instance invoker under the same transitional names during PR-τ's
// soak window. Every caller now reaches a connected site's own MCP catalog
// directly through the two generic, already-governed primitives below
// (`wordpress_site_tool_call` / `wordpress_site_tools_list`), which have been
// registered — dark until S7's perimeter cutover — since S2.
import { getWordPressDeps } from "../deps";

export const instanceIdSchema = z.object({
  instanceId: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Governed connector-instance invoker primitives (cinatra#2017 S2, gateway).
//
// `wordpress_site_tool_call` / `wordpress_site_tools_list` are the model-visible,
// connector-owned entry points to the governed invoker (Plane C): they schema-
// parse, then call the host invoker capability through the deps slot. They carry
// NO `connectorKey` and NO `kind` (host-derived from the verified `packageName`,
// M6) and pass NO actor (host-derived from the MCP request frame, §2.4).
// ---------------------------------------------------------------------------

export const siteToolCallSchema = z.object({
  toolName: z
    .string()
    .min(1)
    .describe(
      "The site tool / ability to call. On the default aggregator server this is the inner ability id, which may contain a slash (e.g. \"core/get-site-info\").",
    ),
  // Forwarded to the resolved tool's advertised schema UNMODIFIED (§3.7).
  // Defaults to {} so a no-argument tool is callable without an explicit args.
  args: z
    .record(z.string(), z.unknown())
    .default({})
    .describe("Arguments for the target tool, matching its advertised input schema. Omit or pass {} for a no-argument tool."),
  instanceId: z
    .string()
    .min(1)
    .optional()
    .describe("Target connected-site instance. Required only when your session is not pinned to a single site."),
  serverId: z
    .string()
    .min(1)
    .optional()
    .describe("Target MCP server. Required only when the tool name is ambiguous across the site's enrolled servers."),
});

export const siteToolsListSchema = z.object({
  instanceId: z
    .string()
    .min(1)
    .optional()
    .describe("Target connected-site instance. Required only when your session is not pinned to a single site."),
  serverId: z
    .string()
    .min(1)
    .optional()
    .describe("Restrict the listing to a single MCP server. Optional."),
  cursor: z
    .string()
    .optional()
    .describe("Pagination cursor from a previous page's nextCursor. Pages are consistent within one catalog revision."),
});

export function createWordPressPrimitiveHandlers() {
  return {
    // cinatra#2017 S2 — governed connector-instance invoker (Plane C). Thin:
    // schema-parse then forward the NON-IDENTITY coordinates to the host invoker
    // capability via the deps slot. connectorKey/kind are NOT connector-facing
    // (host-derived from the verified packageName, M6); the actor is host-derived
    // from the MCP request frame (§2.4) — the synthetic request.actor literal is
    // never read here for any decision.
    "wordpress_site_tool_call": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = siteToolCallSchema.parse(request.input);
      // FAIL-CLOSED: the invoker is host-bound (register.ts resolves the capability
      // fail-loud). If the deps slot is skewed/partial and the member is unbound,
      // DENY descriptively rather than crash — never reach WordPress off-channel.
      const invoke = getWordPressDeps().invokeSiteTool;
      if (typeof invoke !== "function") {
        throw new Error(
          "wordpress_site_tool_call denied: the governed connector-instance invoker is unavailable " +
            "(host @cinatra-ai/host:connector-instance-invoker unbound). Refusing to call without the governed channel.",
        );
      }
      // Forward args UNMODIFIED (§3.7); omit absent optionals rather than send an
      // explicit `undefined` over the capability boundary. NO connectorKey/kind
      // (host-derived, M6) and NO actor (host-derived from the MCP frame, §2.4).
      return invoke({
        toolName: input.toolName,
        args: input.args,
        ...(input.instanceId !== undefined ? { instanceId: input.instanceId } : {}),
        ...(input.serverId !== undefined ? { serverId: input.serverId } : {}),
      });
    },

    "wordpress_site_tools_list": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = siteToolsListSchema.parse(request.input);
      // FAIL-CLOSED (same posture as wordpress_site_tool_call).
      const list = getWordPressDeps().listSiteTools;
      if (typeof list !== "function") {
        throw new Error(
          "wordpress_site_tools_list denied: the governed connector-instance invoker is unavailable " +
            "(host @cinatra-ai/host:connector-instance-invoker unbound). Refusing to list without the governed channel.",
        );
      }
      // The host governed list surface runs the pin + live per-instance USE
      // authority gate BEFORE any catalog read (B2) — an unauthorized list is a
      // typed error, never a catalog.
      return list({
        ...(input.instanceId !== undefined ? { instanceId: input.instanceId } : {}),
        ...(input.serverId !== undefined ? { serverId: input.serverId } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      });
    },

    // `wordpress_content_editor_run` is NOT in this map. cinatra-ai/cinatra
    // #2022 S7 extracted it into its own relay-only module (`./relay`,
    // `runContentEditorRelay`) — a DISPATCH primitive that must never be a
    // model-visible MCP tool (cinatra#246), now structurally impossible to
    // reach via `registerWordPressPrimitives()`'s tools/list registration
    // loop since it is never part of this handlers object. Callers (the
    // widget-chat tool) import `runContentEditorRelay` directly.
  } as const;
}
