import { z } from "zod";
import type { ExtensionMcpToolServer, ExtensionMcpToolResult } from "@cinatra-ai/sdk-extensions";
import {
  createWordPressPrimitiveHandlers,
  postsListSchema,
  createDraftSchema,
  postStatusSchema,
  uploadMediaSchema,
  updateMetaSchema,
  contentEditorRunSchema,
  postUpdateSchema,
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
    description: "Get the current status of a WordPress post by its ID.",
    inputSchema: postStatusSchema,
  },
  "wordpress_post_delete": {
    description: "Delete a WordPress post by its ID.",
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
  "wordpress_post_get_latest": {
    description:
      "DEPRECATED ALIAS for wordpress_posts_list. List recently published posts from a WordPress instance, ordered newest first. Returns metadata-only items (id, title, status, date, url) — no rendered HTML body or excerpt. If nextCursor is present, call again with cursor=<nextCursor> to retrieve the next page.",
    inputSchema: postsListSchema,
  },
  "wordpress_post_get": {
    description: "Get a WordPress post by ID. Returns the post's title, status, excerpt, slug, link, featured media, categories, tags, and admin URL.",
    inputSchema: postStatusSchema,
  },
  "wordpress_post_update_meta": {
    description:
      "Update the meta fields of a WordPress post. Used to write Elementor layout data (_elementor_data, _elementor_edit_mode, _elementor_template_type) and other custom meta after a draft is created.",
    inputSchema: updateMetaSchema,
  },
  "wordpress_post_update": {
    description:
      "Update a WordPress post's top-level fields (title, content, excerpt, status, meta). Sends a POST to /wp/v2/posts/{id} with all provided fields. Used by the wordpress-content-editor agent's demote-then-edit pattern: passing { status: 'draft', title, content } in one call demotes a published post AND applies edits, leaving the previous live revision in WordPress's revision history. Requires at least one editable field (title/content/excerpt/status/meta). Returns { id, status, title, content, excerpt, adminUrl }. For meta-only updates, prefer wordpress_post_update_meta.",
    inputSchema: postUpdateSchema,
  },
  "wordpress_content_editor_run": {
    description:
      "Edit a WordPress post using natural language instructions. Dispatches to the wordpress-content-editor WayFlow agent. Note: WordPress lacks a true draft-revision primitive, so when postStatus is 'publish' the agent uses a demote-then-edit pattern via wordpress_post_update with status:draft — the live revision is preserved in WordPress's revision history but the front-of-site copy becomes a draft until re-published. Provide instanceId, postId, instructions. Optional: postType, postStatus. Returns { postId, changes: [{ field, before, after }] } or { result: <text> }.",
    inputSchema: contentEditorRunSchema,
  },
};

export function registerWordPressPrimitives(server: ExtensionMcpToolServer) {
  const handlers = createWordPressPrimitiveHandlers();

  for (const [name, handler] of Object.entries(handlers)) {
    // cinatra#246: NEVER expose the content-editor RELAY as an MCP tool. It is
    // a dispatch primitive (it sends an A2A task to the wordpress-content-editor
    // agent), not a CMS read/write capability. When the leaf agent has the
    // cinatra MCP server injected it would otherwise see `wordpress_content_editor_run`
    // in tools/list and call it — re-dispatching itself (observed: recursive
    // mcp_call -> 504). The host relays to the agent directly via
    // dispatchContentEditorViaA2A; this name must not be a model-visible tool.
    if (name === "wordpress_content_editor_run") continue;
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
