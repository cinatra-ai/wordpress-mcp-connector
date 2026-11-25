# WordPress MCP

Connect self-hosted WordPress sites so Cinatra agents can read posts, create drafts, edit live articles, upload media, and run an in-CMS chat widget. Install the wordpress/mcp-adapter plugin on each site, then add each site in the connector settings page with its URL, admin username, and an Application Password (WordPress: Users > Profile > Application Passwords). External MCP toolbox reachability also needs workspace chat, a per-instance opt-in, and a non-empty verified read allowlist; private or local URLs are skipped. Edits to published posts demote first, so the previous live revision stays in WordPress revision history. The connector exports `wordpress_site_tools_list`, `wordpress_site_tool_call` and `wordpress_site_tool_write`, which reach any ability a site's own MCP catalog exposes (list first, then call by `toolName`). `wordpress_site_tool_call` is read-only: it forwards an ability only when it is a known read or every matching catalog row lists it as a read, and refuses any other, a known write included, with one fixed message. `wordpress_site_tool_write` forwards any ability, publishing included, and is the only tool declared `outward`, so a host that reads it holds each call for the person's recorded decision. Both tools also declare a `passthroughStep` (`"read"` and `"publishing"`) so a flow step can call them without a model, and both accept the ability's arguments as JSON text (`argsJson`) instead of `args`. `wordpress_content_editor_run` is a separately gated, dispatch-only relay to the in-CMS content-editor agent. Calls run through per-instance authorization and fail closed if unbound. If an instance shows "not installed" or "auth_error", check the plugin is active and the Application Password is current.

This connector owns its WordPress REST client and registers its connection, content, and widget-auth capabilities at activation; the core ships no WordPress client code. Its `cinatra.devSetup` hook provisions the local WordPress fixture in dev.

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
