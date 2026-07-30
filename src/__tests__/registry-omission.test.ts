import { describe, expect, it } from "vitest";

import { registerWordPressPrimitives } from "../mcp/registry";

// cinatra-ai/cinatra#2022 S7 (PR-θ) FINAL rewrite. Two invariants, permanently
// load-bearing:
//
// (1) cinatra#246 regression guard — the content-editor RELAY
//     (`wordpress_content_editor_run`) must NOT be registered as a
//     self-MCP tool: when the wordpress-content-editor agent has the cinatra
//     MCP server injected, a visible dispatcher tool let the model call it
//     and re-dispatch itself (observed recursive mcp_call -> 504). The host
//     relays to the agent directly via dispatchContentEditorViaA2A. The relay
//     was extracted into its own module (`../mcp/relay.ts`,
//     `runContentEditorRelay`) and is no longer part of the handlers map
//     `registerWordPressPrimitives` iterates over at all — this assertion
//     holds structurally, not just by an explicit skip-by-name check in the
//     registration loop.
//
// (2) The 12 old `wordpress_*` facade tools (the 10 always-dead entries plus
//     `wordpress_post_get`/`wordpress_post_update`, deleted under D4-REVISED)
//     are ABSENT — they routed through the plugin's own
//     `cinatra-content-server` (S8's deletion target) or, transitionally,
//     through the governed invoker under the same old names. The two generic,
//     already-governed primitives (`wordpress_site_tool_call` /
//     `wordpress_site_tools_list`) are what every caller reaches a connected
//     site's own MCP catalog through now.
describe("registerWordPressPrimitives — post-deletion tool surface (cinatra-ai/cinatra#2022 PR-θ)", () => {
  it("registers the two generic governed-invoker primitives but OMITS wordpress_content_editor_run and all 12 deleted facade tools", () => {
    const registered: string[] = [];
    const server = {
      registerTool: (name: string) => {
        registered.push(name);
      },
    } as unknown as Parameters<typeof registerWordPressPrimitives>[0];

    registerWordPressPrimitives(server);

    // The generic governed-invoker primitives ARE the model-visible surface now.
    expect(registered).toContain("wordpress_site_tool_call");
    expect(registered).toContain("wordpress_site_tools_list");

    // The dispatcher relay is excluded from the MCP surface (cinatra#246,
    // permanently — not just until S7).
    expect(registered).not.toContain("wordpress_content_editor_run");

    // All 12 old facade tools are gone — the 10 always-dead entries plus the
    // two in-admin editing tools (wordpress_post_get/wordpress_post_update):
    // "everything working as before" is preserved by migrating the
    // review-before-publish gate onto the generic path first, not by
    // keeping the old tool names.
    const deletedFacadeTools = [
      "wordpress_status",
      "wordpress_instances_list",
      "wordpress_post_create_draft",
      "wordpress_post_status",
      "wordpress_post_delete",
      "wordpress_media_upload",
      "wordpress_posts_list",
      "wordpress_pages_list",
      "wordpress_post_get_latest",
      "wordpress_post_get",
      "wordpress_post_update_meta",
      "wordpress_post_update",
    ];
    expect(deletedFacadeTools).toHaveLength(12);
    for (const deleted of deletedFacadeTools) {
      expect(registered).not.toContain(deleted);
    }

    // Exactly the two generic primitives are registered — nothing else survived.
    expect(registered.sort()).toEqual(["wordpress_site_tool_call", "wordpress_site_tools_list"]);
  });
});
