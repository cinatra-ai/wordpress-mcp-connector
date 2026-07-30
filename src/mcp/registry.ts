import { z } from "zod";
import type { ExtensionMcpToolServer, ExtensionMcpToolResult } from "@cinatra-ai/sdk-extensions";
import {
  createWordPressPrimitiveHandlers,
  postsListSchema,
  createDraftSchema,
  postStatusSchema,
  uploadMediaSchema,
  updateMetaSchema,
  postUpdateSchema,
  siteToolCallSchema,
  siteToolsListSchema,
} from "./handlers";

const TOOL_META: Record<string, { description: string; inputSchema: z.ZodTypeAny }> = {
  "wordpress_status": {
    description: "Get the current WordPress connector connection status.",
    inputSchema: z.object({}),
  },
  "wordpress_instances_list": {
    description: "List all configured WordPress instances.",
    inputSchema: z.object({}),
  },
  "wordpress_post_create_draft": {
    description: "Create a new draft post on a WordPress instance.",
    inputSchema: createDraftSchema,
  },
  "wordpress_post_status": {
    description:
      "Get the current status of a WordPress post by its ID. For a WordPress page, pass postType: \"page\" (required — it routes to /wp/v2/pages/{id}); otherwise the id is read from the posts collection.",
    inputSchema: postStatusSchema,
  },
  "wordpress_post_delete": {
    description:
      "Delete a WordPress post by its ID. For a WordPress page, pass postType: \"page\" (required — it routes to /wp/v2/pages/{id}); otherwise the id is deleted from the posts collection.",
    inputSchema: postStatusSchema,
  },
  "wordpress_media_upload": {
    description: "Upload a base64-encoded image to a WordPress media library.",
    inputSchema: uploadMediaSchema,
  },
  "wordpress_posts_list": {
    description:
      "List recently published posts from a WordPress instance, ordered newest first. Returns metadata-only items (id, title, status, date, url) — no rendered HTML body or excerpt. If nextCursor is present, call again with cursor=<nextCursor> to retrieve the next page.",
    inputSchema: postsListSchema,
  },
  "wordpress_pages_list": {
    description:
      "List recently published pages from a WordPress instance (the /wp/v2/pages collection), ordered newest first. Returns metadata-only items (id, title, status, date, url) — no rendered HTML body or excerpt. Use this to discover a page id, then read it with wordpress_post_get, check its status with wordpress_post_status, or delete it with wordpress_post_delete, passing postType: \"page\". wordpress_post_update does NOT support postType: \"page\" (it fails closed) — page editing has no supported primitive yet. If nextCursor is present, call again with cursor=<nextCursor> to retrieve the next page.",
    inputSchema: postsListSchema,
  },
  "wordpress_post_get_latest": {
    description:
      "DEPRECATED ALIAS for wordpress_posts_list. List recently published posts from a WordPress instance, ordered newest first. Returns metadata-only items (id, title, status, date, url) — no rendered HTML body or excerpt. If nextCursor is present, call again with cursor=<nextCursor> to retrieve the next page.",
    inputSchema: postsListSchema,
  },
  "wordpress_post_get": {
    description: "Get a WordPress post by ID for in-admin editing, through the site's MCP content server (not a direct REST call). Returns the post's title, status, content, excerpt, slug, link, and admin URL. For a WordPress page, pass postType: \"page\".",
    inputSchema: postStatusSchema,
  },
  "wordpress_post_update_meta": {
    description:
      "Update the meta fields of a WordPress post. Used to write Elementor layout data (_elementor_data, _elementor_edit_mode, _elementor_template_type) and other custom meta after a draft is created.",
    inputSchema: updateMetaSchema,
  },
  "wordpress_post_update": {
    description:
      "Update a WordPress post's top-level fields (title, content, excerpt, status). Applies the provided fields to the post through the site's MCP content server (the in-admin editing path), not a direct REST call. Used by the wordpress-content-editor agent's demote-then-edit pattern: passing { status: 'draft', title, content } in one call demotes a published post AND applies edits, leaving the previous live revision in WordPress's revision history. Requires at least one editable field (title/content/excerpt/status). Returns { id, status, title, content, excerpt, adminUrl }. For post meta updates, use wordpress_post_update_meta.",
    inputSchema: postUpdateSchema,
  },
  // `wordpress_content_editor_run` is NOT registered here. cinatra-ai/cinatra
  // #2022 S7 extracted it into its own relay-only module (`./relay`) — see
  // the `registerWordPressPrimitives` loop below for why that keeps it off
  // tools/list (cinatra#246).

  // cinatra#2017 S2 — governed connector-instance invoker (Plane C). Registered
  // + classified + wired, but DARK in S2 (delegated deny-by-default + no
  // agent-run allowlist keep them off every live model surface; S7 cuts over).
  "wordpress_site_tool_call": {
    description:
      "Call any tool exposed by a connected WordPress site's own MCP catalog, through the governed connector-instance invoker. Provide toolName (and args matching that tool's schema). instanceId is required only when your session is not pinned to a single site; serverId only when the tool name is ambiguous across the site's enrolled MCP servers.",
    inputSchema: siteToolCallSchema,
  },
  "wordpress_site_tools_list": {
    description:
      "List the tools available on a connected WordPress site's own MCP catalog — each with its input schema, annotations, derived class, and policy status — through the governed connector-instance invoker. instanceId is required only when your session is not pinned to a single site; pass cursor to page through large catalogs.",
    inputSchema: siteToolsListSchema,
  },
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
