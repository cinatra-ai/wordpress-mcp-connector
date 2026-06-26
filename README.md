# WordPress MCP

Connect one or more self-hosted WordPress sites so Cinatra agents can read posts, create drafts, edit live articles, upload media, and run an in-CMS chat widget right inside the post editor. To get started, install the wordpress/mcp-adapter plugin on each site, then open the WordPress connector settings page in the Cinatra marketplace and add each site using its URL, admin username, and an Application Password (generated in WordPress under Users → Profile → Application Passwords). Each site with a public URL and the plugin installed becomes reachable through the external MCP toolbox; sites on private/local URLs are visible in the admin UI but are skipped from LLM toolbox injection. Edits to published posts use a demote-then-edit flow that preserves the previous live revision in WordPress's revision history. To develop locally, clone the repo, run `pnpm install`, and run `pnpm test` to execute the Vitest suite. The connector exports typed primitives (`wordpress_posts_list`, `wordpress_post_get`, `wordpress_post_create_draft`, `wordpress_post_update`, `wordpress_post_delete`, `wordpress_media_upload`, `wordpress_post_update_meta`, `wordpress_content_editor_run`) via the extension MCP module. Every write primitive enforces per-user write authority before dispatching; a missing or unbound authority gate fails closed. If an instance shows "not installed" or "auth_error", verify the plugin is active on that site and the Application Password is current; private/local URLs are intentionally excluded from LLM toolbox injection.

## Works with

- WordPress (self-hosted, version 5.6 or later with the Cinatra mcp-adapter plugin)

## Capabilities

- Connect one or more WordPress sites to your Cinatra workspace
- Browse and read recent published posts on any connected site
- Create new draft posts and update existing ones from your agents
- Edit live published posts while preserving the previous revision in WordPress history
- Upload images to a site's media library
- Run an in-CMS chat widget that makes inline edits to the open post in the WordPress editor
- Receive a webhook notification when a post is published on a connected site
