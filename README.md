# WordPress MCP

Connect one or more self-hosted WordPress sites so Cinatra agents can read posts, create drafts, edit live articles, upload media, and run an in-CMS chat widget in the post editor. To get started, install the wordpress/mcp-adapter plugin on each site, then open the WordPress connector settings page in the Cinatra marketplace and add each site using its URL, admin username, and an Application Password (WordPress: Users → Profile → Application Passwords). A public URL and the plugin are necessary but not sufficient for external MCP toolbox reachability — workspace chat, a per-instance opt-in, and a non-empty verified read allowlist are also required; private/local URLs are skipped regardless. Edits to published posts use a demote-then-edit flow that preserves the previous live revision in WordPress's revision history. To develop locally: `pnpm install`, then `pnpm test` runs the Vitest suite. The connector exports two governed primitives via the extension MCP module — `wordpress_site_tool_call` and `wordpress_site_tools_list` — which forward to whatever ability a connected site's own MCP catalog exposes (list first, then call by `toolName`), plus `wordpress_content_editor_run`, a separately gated dispatch-only relay to the in-CMS content-editor agent that is never itself listed as a callable tool. Every catalog-primitive call runs through the governed invoker's per-instance authorization, failing closed if unbound. If an instance shows "not installed" or "auth_error", verify the plugin is active on that site and the Application Password is current.

This connector owns its WordPress REST client and registers the connection, content, and widget-auth capabilities itself at activation — the Cinatra core ships no WordPress client code. In dev, its `cinatra.devSetup` hook provisions the local WordPress fixture on boot.

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
