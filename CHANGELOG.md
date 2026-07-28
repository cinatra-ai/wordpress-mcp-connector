# Changelog

All notable changes to this project are documented here, derived from the
project's merged pull request and release-tag history.

## Unreleased

Requires the Cinatra WordPress plugin's content abilities (cinatra-ai/wordpress-plugin#81 and cinatra-ai/wordpress-plugin#82) to be installed on the connected site — an older plugin without them makes the in-admin content tools fail closed rather than silently falling back to direct REST.

- fix(test): drop the `s` (dotAll) regex flag from the trusted-site card test in favour of an equivalent `[\s\S]*`. The Cinatra host typechecks this repo's sources against its own ES2017 target, where the flag is a TS1501 error; the break was invisible until the host advanced its pin past the change that introduced it.

- refactor(skills): the widget-chat bundle leaves this connector for its own extension. `skills/wordpress-widget-chat/SKILL.md` moves verbatim into `@cinatra-ai/wordpress-widget-chat-skill`, the now-purposeless `cinatra/plugin.json` skills pointer is deleted, `skills` drops out of the published `files` list, and the `cinatra.capabilities` declaration of `widget-chat.wordpress-content-editor` moves to the package that ships the bundle. In its place the manifest declares a required runtime dependency edge on that package, so the install closure still pulls the prompt in. `cinatra.widgetStream.skillCapability` is unchanged: the connector still NAMES the capability its widget needs, and the skill package now solely PROVIDES it. Required by the packaging contract that bans a skill bundle inside a non-skill extension (cinatra-ai/cinatra#2089, migrated by cinatra-ai/cinatra#2090).

- feat(gateway): add the governed connector-instance invoker primitives `wordpress_site_tool_call` and `wordpress_site_tools_list` — model-visible, connector-owned entry points that reach a connected site's own MCP catalog through a single governed host channel (authorization → per-instance policy → classification → confirmation hook → execute → audit, all resolved host-side). The connector-facing shapes carry NO connector or caller identity: the host derives the connector from this package's verified identity and the actor from the active request frame, so a tool argument can never assert or select either. Shipped DARK — no live model surface reaches them yet (they are denied by default on the delegated chat/widget perimeters and are on no agent-run allowlist); a later change performs the exposure cutover. The host capability (`@cinatra-ai/host:connector-instance-invoker`) that backs them ships alongside the Cinatra core change that pins this connector version; until then the primitives fail closed. To keep this connector building standalone ahead of that core change, the invoker capability id and its structural type are VENDORED locally (no unreleased SDK symbol is imported); a follow-up release swaps them for the shared `@cinatra-ai/sdk-extensions` contract (cinatra-ai/cinatra#2017 S2).

- refactor(gateway): consume the governed connector-instance invoker contract from the shared `@cinatra-ai/sdk-extensions` package now that the Cinatra core change that ships and publishes it has landed; the connector drops its local vendored mirror of the invoker types and imports the canonical contract instead. Pure type/import swap — the vendored and published shapes are structurally identical, so the invoker primitives behave exactly as before (cinatra-ai/cinatra#2017 S2).

- feat(mcp): the in-admin post read + update reach WordPress ONLY through the site's MCP integration — `wordpress_post_get` / `wordpress_post_update` reroute to the plugin's `cinatra-post-get` / `cinatra-post-update` tools via a new `callWordPressMcp` client (Application-Password Basic over StreamableHTTP, resolved through the same Nango credential + connection use-gate + audit the REST client used). Runtime tool-detection FAILS CLOSED when the plugin/tools are absent — it never falls back to a direct `/wp/v2/*` call. The demote-then-edit gate (`status:"draft"`) and the per-user write-authority gate are preserved. The direct-REST `readWordPressPost` / `updateWordPressPost` helpers are deleted (cinatra#1214 S1).
- feat(mcp): the remaining in-admin content primitives — `wordpress_post_status`, `wordpress_posts_list`, `wordpress_pages_list`, `wordpress_post_delete`, `wordpress_media_upload`, `wordpress_post_create_draft`, `wordpress_post_update_meta` — also reach WordPress ONLY through the plugin's content MCP tools (`cinatra-post-status` / `cinatra-posts-list` / `cinatra-post-delete` / `cinatra-media-upload` / `cinatra-post-create-draft` / `cinatra-post-update-meta`), never a direct `/wp/v2/*` call; runtime tool-detection FAILS CLOSED when the plugin is missing/too old. `wordpress_pages_list` routes through `cinatra-posts-list` with `postType:"page"`. The per-user write-authority gate on the writes is preserved (cinatra-ai/wordpress-plugin#82).
- note(carve-out): `create_draft` / `media_upload` are also used by the (non-in-admin) blog-publish pipeline. The connector-owned REST client + the published `@cinatra-ai/host:wordpress-content` provider are RETAINED for that carve-out — a non-in-admin caller remains — so the direct-REST client is not deleted; only the in-admin egress moved behind MCP.
- test(guard): the egress guard now also covers the six rehomed primitives — each invokes the MCP client with its `cinatra-*` tool and makes zero direct fetches; the static guard asserts the handler source no longer calls the direct-REST content deps (cinatra#1214 S4, WordPress half).
- feat(setup): wrap the settings page in the shared `@cinatra-ai/sdk-ui` Tabs primitive — Setup · Connections · Help, Help always last — per the extended connector setup-page design (this is a multi-connection connector, one Nango connection per WordPress site: the Setup tab keeps the add-a-site form + a "Connections status" count card, the new Connections tab stacks every configured site as its own card with a Disconnect action, and the new read-only Help tab carries the setup how-to). No local `tabs.tsx` copy — imports the shared primitive only (#70).
- feat(setup): add a per-site **Trusted-site mode** opt-in on each connection card — a default-off control that (once a connected site advertises Cinatra-verified read tools) lets those specific reads run directly at the model provider instead of only through Cinatra's governed path. Enabling flows through an explicit, versioned residual-risk disclosure — it states plainly that the site's Application Password is shared with the model provider and that a same-site plugin could swap the implementation behind a verified read without detection — and requires a fresh acknowledgement whenever that disclosure or the verified set later changes. The card shows a LIVE preview of how many tools currently qualify (none, on today's plugin stack). Writes always stay on the governed path; the feature can only ever shrink what is injected, never widen it. The opt-in store, the shipped read-tool set, and the fingerprint verifier are all host-computed and consumed here as optional, skew-safe dependencies — an older Cinatra renders the card as unavailable rather than failing. Ships dark: even when enabled, nothing is injected until a later release ships the verified read set (cinatra-ai/cinatra#2019).
- feat(gateway): the external-MCP toolbox's hard default-off guard is replaced by the real **trusted-site mode** gate — the toolbox now emits an injected MCP server for a WordPress instance ONLY when the host-built build context says the assembling surface is workspace chat AND the host's per-instance native read-injection decision grants it (opt-in on, consent acknowledgement exactly current, catalog verifiable, and a non-empty descriptor-verified trusted-READ set). Every emitted entry carries EXACTLY the host-granted read-tool allowlist — the old `allowedTools: null` full-catalog form is unrepresentable — plus the pinned per-instance server label, the instance's Application-Password Basic header, `approval: "auto_execute"`, and a declared `streamable-http` transport. Everything else stays dark, fail-closed: an absent context (a host predating the SDK context widening), agent-run/public-widget/session surfaces, an unbound host member (a pre-S4 Cinatra), a null grant, a grant for a non-default catalog server (v1 injects the default adapter server only), and a malformed/empty allowlist all emit nothing, and the pre-flip boundary gates (per-instance `use` authority, private-URL skip, adapter probe) are preserved unchanged. A host-built `connectorInstancePin` narrows consideration to exactly the pinned instance (purely subtractive; run surfaces still never emit). On today's pinned community plugin stack the host's verified set is EMPTY by capture, so even a fully opted-in site injects nothing yet — writes never travel this path either way (they stay on the governed invoker with its audit and destructive confirmation). The server-label helper additionally ships the (currently never-emitted) per-server suffix rule `wordpress-<instanceId>--s-<enrolled-server digest>` for the day a non-default server is authorized (cinatra-ai/cinatra#2019).

## v0.1.6 — 2026-07-07

Required rider alongside Cinatra 0.1.7: this release takes ownership of WordPress-specific capability code that Cinatra 0.1.7 removes from core.

- feat(widget-auth): own the WordPress widget-auth store and register the capability — on a Cinatra 0.1.7 host, widget sessions on connected sites need this version (cinatra#975 W2) (#56)
- feat(client): own the relocated WordPress REST client, registered under the same host capability id (provider flip, no contract change) (cinatra#975 W3) (#57)
- fix(boundary): resolve the per-deployment content-editor agent URL via the granted settings port instead of the process environment (#50)
- feat(dev-setup): dev-mode provisioning moves into a connector-owned `devSetup` hook (cinatra#976) (#51); the dev fixture probe runs in-container, dropping the `node:fs` host precheck (#55)
- fix(tests): align test typings with the deps row type and the narrow SDK buildTools contract (#49)

## v0.1.5 — 2026-07-04

- feat: final connection access-scoping declaration — default scope "workspace" (cinatra#954 W4) (#48)
- fix: declare `wordpress_post_update` in the mcp.json primitives (#45)
- fix(setup): remove the extension-rendered connection-status pill (#42)
- chore(manifest): backfill the declared SDK ABI range (#43); declare `cinatra.consumes` for closure-gate enrollment (#46)
- docs/ci: CHANGELOG derived from tag and merged-PR history (#47); release workflow pinned to the gated reusable extension-release flow (release-approval wall) (#44); private tracker references stripped from workflow comments (#41)

## v0.1.4 — 2026-06-28

- fix: declared `cinatra.vendor` identity ahead of a marketplace re-submit (#40)
- chore: stripped private tracker references from public source (#37)

## v0.1.3 — 2026-06-28

- feat: declared `cinatra.webhooks` and a post-published handler (#28)
- fix: gated per-instance tool injection via host use-authority, requiring approval on writes; project public fields only in instance listing, omitting credentials; shadcn raw-element fixes and ramped the UI gate to error (#31, #32, #33)
- docs: expanded README to the org standard (#30)
- ci: re-vendored the UI-gate preset with the dynamic-import ban; adopted source-leak-gate (#36, #34, #35)

## v0.1.2 — 2026-06-23

- feat: declared `relayAgentPackage` for the content-editor relay; passed `packageName` for production OBO identity; enforced per-user/per-instance write authority in the WordPress MCP write handlers (#22, #21, #26)
- ci: added the truthful-attribution gate (WARN mode); adopted the reusable extension→host IoC conformance gate, the tag-driven GitHub release workflow, and secret-scan-gate (#19, #20, #23, #24)

## v0.1.1 — 2026-06-13

- feat: shipped the external-MCP toolbox module and capability marker; declared the widget-stream surface and widget-chat skill capability; declared the package exports map (incl. `./register`) for the serverEntry builder (#6, #7, #14)
- chore: adopted source-leak-gate, SHA-pinned org gate callers, npm packaging hygiene, Renovate config, reusable release-workflow pinning (#1–#5, #8, #9, #11–#13, #16, #17)

## v0.1.0 — 2026-06-03

- Initial release.

## Unreleased

- fix: declared `wordpress_post_update` in `mcp.json` primitives; removed the extension-rendered connection-status pill (#45, #42)
- chore: stripped private tracker references from workflow comments; backfilled `cinatra.sdkAbiRange`; pinned the reusable extension-release workflow to the gated version (release-approval wall); declared `cinatra.consumes` for closure-gate enrollment (#41, #43, #44, #46)
