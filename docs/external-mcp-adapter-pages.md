# External MCP adapter and WordPress pages

Cinatra can inject a public WordPress site's **external MCP adapter**
(`WordPress/mcp-adapter`, which depends on `WordPress/abilities-api`) as an
external MCP server, so an LLM provider can talk to the site directly. Because
the adapter's tool set is version-dependent, the connector injects it with
`allowedTools: null` and `requireApproval: "read-only"` rather than a static,
possibly-wrong tool allowlist.

This note records what that adapter actually exposes for **pages**, and the
supported path for callers working from outside Cinatra.

## What the adapter exposes

Validated against a live WordPress running `mcp-adapter` 0.4.1 and
`abilities-api` 0.4.0 (the versions the connector's dev fixture provisions).
Reproduce with [`scripts/probe-mcp-adapter.mjs`](../scripts/probe-mcp-adapter.mjs);
the recording is pinned in
[`src/__tests__/fixtures/mcp-adapter-tools.json`](../src/__tests__/fixtures/mcp-adapter-tools.json)
and asserted by `src/__tests__/external-adapter-pages.test.ts`.

The default MCP server is reachable at
`/wp-json/mcp/mcp-adapter-default-server` (and, without pretty permalinks, at
`?rest_route=/mcp/mcp-adapter-default-server` — the form the host injects). It
speaks the MCP streamable-HTTP transport: `initialize` returns an
`Mcp-Session-Id` response header that every later request must echo.

`tools/list` returns exactly three **generic ability-gateway** tools — not
first-class content tools:

- `mcp-adapter-discover-abilities`
- `mcp-adapter-get-ability-info`
- `mcp-adapter-execute-ability`

These gate the WordPress **Abilities API**. On a stock site the default server
discovers an **empty** ability set, and the site's ability registry
(`/wp-json/wp-abilities/v1/abilities`) holds only read-only site metadata
(`core/get-site-info`, `core/get-environment-info`). There is **no page or post
ability**, so:

- there is **no adapter-native page list / read / update / delete tool**; and
- even the generic `execute-ability` tool has no page ability to run.

## Which path to use for pages

**Use the two general-purpose primitives, `wordpress_site_tool_call` and
`wordpress_site_tools_list`.** cinatra-ai/cinatra#2022 (S7, PR-θ) deleted the
12 named Cinatra facade tools that used to cover this (`wordpress_pages_list`,
`wordpress_post_get`, `wordpress_post_status`, `wordpress_post_delete`,
`wordpress_post_update`, and the rest) — there is no dedicated per-operation
page tool anymore. Both primitives forward, through the same governed
connector-instance invoker (the same per-instance authorization + policy path
the deleted named tools used internally), directly to whatever ability the
connected site's own MCP catalog exposes — call `wordpress_site_tools_list`
first to discover the exact ability ids a given site advertises, then
`wordpress_site_tool_call` with that `toolName` and matching `args`.

For a site running the community "Enable Abilities for MCP" catalog, page
discovery/read routes through that catalog's own ability ids (e.g.
`ewpa/get-posts` filtered/paginated for listing, `ewpa/get-page` for reading a
single page by id — a distinct ability from `ewpa/get-post`, per the
catalog's own discovery capture). **Page editing still has no known supported
ability**: no distinct page-update ability was ever proven to exist in that
catalog's discovery capture (only `ewpa/update-post`, which is post-shaped) —
that was true of the old, now-deleted `wordpress_post_update` tool (which
failed closed on `postType: "page"` for exactly this reason) and remains true
of the generic path, since the underlying site catalog hasn't changed. Call
`wordpress_site_tools_list` to check what a given site's catalog actually
advertises before assuming otherwise — a future adapter/plugin version could
add one.

Treat the injected adapter server as a version-dependent, read-biased extra
surface — **not** a page-editing path either (see above: it exposes no page
abilities on the validated version). If a future adapter (or a site plugin)
registers page abilities, they will appear through `discover-abilities` /
`execute-ability`; re-run the probe to confirm before relying on them.

## Requirements for the external adapter path

For Cinatra to inject a site's adapter at all, every one of these must hold:

1. **Public site URL** — the site must be reachable by the LLM provider.
   Private/local URLs are shown in the admin UI but skipped from injection.
2. **Adapter active** — both `WordPress/mcp-adapter` and its `abilities-api`
   dependency must be installed and activated (abilities-api first; the adapter
   needs `wp_register_ability()` to exist or the MCP route 404s).
3. **Valid Application Password** — a current WordPress Application Password for
   the configured user (Users → Profile → Application Passwords). The connector
   builds the adapter's `Authorization: Basic` header from it.
4. **Cinatra instance authorization** — the acting user must hold `use`
   authority on that connector instance; the host resolves the trusted actor
   from the MCP request frame and fails closed otherwise.

## Troubleshooting

- **Instance shows `not_installed`** — the adapter (or abilities-api) is not
  active on that site. Activate both; abilities-api must load first.
- **Instance shows `auth_error`** — the Application Password is missing, revoked,
  or wrong. Regenerate it and re-save the instance.
- **Adapter injected but no page tools appear** — expected. See above: the
  adapter exposes no page tools on the supported version. Use
  `wordpress_site_tool_call` / `wordpress_site_tools_list` against the site's
  own MCP catalog instead.
- **`Missing Mcp-Session-Id header`** — the caller skipped the `initialize`
  handshake or dropped the session header. Capture the `Mcp-Session-Id` from the
  `initialize` response and send it on every subsequent request.
