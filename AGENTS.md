# wordpress-mcp-connector — AGENTS.md

Package-specific guidance for `@cinatra-ai/wordpress-mcp-connector`. This is a standalone, extracted extension repo (a source mirror, per `.github/workflows/ci.yml`) — there is no monorepo `packages/connector-wordpress` tree to read alongside; this file is self-contained. (`@cinatra-ai/wordpress-connector`, without `-mcp-`, is the old, fully-removed package name — do not reintroduce it; the cinatra host bans the import.)

## Package role

Registers via `createWordPressModule()` (`src/mcp/module.ts`), which returns `{ registerCapabilities: registerWordPressPrimitives }` — exported from `src/index.ts` and the `./mcp-module` package subpath for the host to consume. Deps wiring is separate: `cinatra.serverEntry: "./register"` (`package.json`) binds `src/register.ts`'s `register(ctx)`, which adapts host capabilities into this connector's runtime `WordPressConnectorDeps` (`src/deps.ts`) — it does not itself register any MCP tool. The connector exposes two governed, model-visible MCP primitives — `wordpress_site_tool_call` and `wordpress_site_tools_list` — that forward to whatever ability a connected site's own MCP catalog advertises, rather than calling `/wp/v2/*` directly. A fixed set of direct-REST members survive as carve-outs (see below). It also provides the `WordPressSettingsPage` RSC (`src/settings-page.tsx`) for the connector's settings page.

## The generic catalog invoker replaced the 12 named tools

cinatra-ai/cinatra#2022 (S7) deleted the 12 named per-operation tools this connector used to expose — `wordpress_status`, `wordpress_instances_list`, `wordpress_post_create_draft`, `wordpress_post_status`, `wordpress_post_delete`, `wordpress_media_upload`, `wordpress_posts_list`, `wordpress_pages_list`, `wordpress_post_get_latest`, `wordpress_post_get`, `wordpress_post_update_meta`, `wordpress_post_update` (PR #101). Every caller now reaches a connected site's own MCP catalog through two primitives only:

- `wordpress_site_tools_list` — list the site's own catalog (paginated; `instanceId` required only when the session isn't pinned to a single site).
- `wordpress_site_tool_call` — call an ability by that catalog's own `toolName` (e.g. `ewpa/get-post`, `ewpa/update-post`), forwarding `args` unmodified to the site.

Both are thin wrappers over the governed connector-instance invoker (`src/deps.ts`'s `invokeSiteTool` / `listSiteTools`, host capability `@cinatra-ai/host:connector-instance-invoker`) — see `src/mcp/handlers.ts` and `src/mcp/registry.ts`. `docs/external-mcp-adapter-pages.md` has the current walkthrough of which ability ids a community "Enable Abilities for MCP" catalog exposes for posts/pages, and what still has no supported path (page editing).

## The content-review gate now lives on the generic path — `ewpa/update-post` only

The old `wordpress_post_update` tool's inline review-before-publish trigger (`evaluateStagedContentWrite`, cinatra#2043) was relocated (PR #100) onto `wordpress_site_tool_call` itself, keyed on ability name, before the old tool was deleted (PR #101) — the no-silent-publish guarantee never lapsed for one commit. `CONTENT_REVIEW_TARGET_ABILITIES` (`src/mcp/handlers.ts`) is `{"ewpa/update-post"}` — the only ability gated today. When `wordpress_site_tool_call` is called with that `toolName`:

- `instanceId` is required unconditionally (no session-pin fallback) — refuses rather than stage an unattributable review.
- `args.post_id` must be a strict positive integer (`Number.isInteger`, the same semantics as `z.coerce.number().int().positive()` — including accepting an exponential-but-integral string like `"1e2"`).
- `args.meta` is refused outright — meta writes go through `wordpress_site_tool_call` again with `toolName: "ewpa/update-post-meta"` (list the catalog first); they are never folded into the reviewed post payload.
- Any argument outside `post_id`/`title`/`content`/`excerpt`/`status` is refused before any capture, so an out-of-scope field can never ride an unchanged-content "pass" verdict onto WordPress unreviewed.
- On hold/reject the mutating call is never forwarded; on pass/apply it forwards `args` unmodified, then (on `apply`) records a post-apply read-back via `readPostViaMcp` — never trusting the ability's own write-response echo.

Every OTHER ability reachable through `wordpress_site_tool_call` is not content-review-gated today. Widening the keyed set (e.g. a future `ewpa/create-post`) is a deliberate, separate change — do not assume it is already covered.

## `post_id` / `postId` — no single universal rule anymore

There is no longer one schema-level constant across every WordPress primitive:

- `wordpress_content_editor_run`'s schema (`src/mcp/relay.ts`) still declares `postId: z.coerce.number().int().positive()` — the widget sends `String(postId)`, and `.coerce` makes that work.
- The review-gated `ewpa/update-post` path validates the snake_case `post_id` argument by hand inside `callReviewGatedSiteTool` (`src/mcp/handlers.ts`) — `siteToolCallSchema.args` is a generic `z.record(z.string(), z.unknown())`, so Zod can't apply a typed constraint to one key inside it.
- No other ability gets any id validation from this connector at all — `wordpress_site_tool_call` forwards `args` unmodified to whatever the target ability's own schema expects.

## Reading a post for the review trigger — `readPostViaMcp` / `extractEwpaContent`

`readPostViaMcp` (`src/mcp/handlers.ts`) — not `src/lib/wordpress-api.ts`, which does not exist in this repo (cinatra#975 relocated it here as `src/lib/wordpress-client.ts`, and cinatra#1214 S1 later deleted its direct-REST post read/update helpers) — fetches a post/page through the governed invoker (`ewpa/get-post` / `ewpa/get-page`) for the review trigger's current-content fetch and post-apply read-back. `extractEwpaContent` checks `post_content` then `content` and **throws** if neither key is present; it never silently coerces missing content to `""`. `assertSupportedReadPostType` only allows `undefined`/`"post"`/`"page"` — a custom post type is refused rather than mis-routed (custom post types have their own `ewpa/get-cpt-item*` abilities this connector does not wire up).

If you add a field the review trigger needs, extend `readPostViaMcp`'s return shape — the trigger's current-content fetch and its post-apply read-back both depend on it.

## `wordpress_content_editor_run` — A2A blocking dispatch, not a listed MCP tool

Dispatches to `wayflow-wordpress-content-editor` (default `http://localhost:3010/agents/cinatra-ai/wordpress-agent`, overridable via the `content_editor_a2a_url` connector setting read through the `settings` host port — connector code never reads `process.env`). Uses `timeoutMs: 300_000` (5 minutes). Reads the result from `task.history` — never `task.artifacts` (WayFlow does not implement `task.artifacts`). Strips Markdown code fences before `JSON.parse`.

It is **not** a model-visible MCP tool. cinatra#246 extracted it into its own module (`src/mcp/relay.ts`) that is deliberately never wired into `createWordPressPrimitiveHandlers()` / `registerWordPressPrimitives()` — so it is structurally impossible for it to reach `tools/list`. An agent with the Cinatra MCP server injected would otherwise see the tool name and call it, re-dispatching itself (observed: recursive `mcp_call` → 504). Callers (`src/widget-chat-tool.ts`) import `runContentEditorRelay` directly. `src/__tests__/registry-omission.test.ts` is the regression guard.

## Tests

Tests live in `src/__tests__/` (e.g. `handlers.test.ts`, `wordpress-client.test.ts`, `site-tool-review-trigger.test.ts`, `toolbox.test.ts` — avoid hard-coding the full list or a count here, it drifts as tests evolve). Most tests build a plain `WordPressConnectorDeps` object (`vi.fn()` stubs) and call `registerWordPressConnector(deps)` directly — no `vi.mock()` module interception needed, since nearly everything now reaches the host through the `src/deps.ts` DI slot. A few files (e.g. `setup-actions.test.ts`) still need `vi.mock()` for a module-level import; there, factory closures must be hoisted above import evaluation via `vi.hoisted()` — do not use a bare `const` outside `vi.hoisted()` for a mock variable a `vi.mock()` factory closes over.

This repo cannot run its test suite standalone: it is a source mirror (`.github/workflows/ci.yml` skips standalone install/typecheck/test whenever a package declares host-internal `@cinatra-ai/*` peers, which this one does), and `vitest.config.ts`'s aliases (`@/`, `server-only`) resolve three directories up from this file — they assume the repo is checked out inside the cinatra host tree, not standalone. Validate a change here with `node --check` on touched files and `node extension-kind-gate.mjs --package-root .`; treat the cinatra host's own CI Typecheck/Test jobs as authoritative once this connector is embedded there.

## Adding new primitives

1. Add an input schema (`z.object(...)`) in `handlers.ts`.
2. Add the handler to `createWordPressPrimitiveHandlers()`.
3. Add the tool metadata entry to `TOOL_META` in `registry.ts`.
4. Add a test case to `handlers.test.ts`.
5. There is no `pnpm typecheck` script in this repo (`package.json` only declares `test` and `lint`) — run `pnpm lint` (eslint) locally; the cinatra host's CI Typecheck/Test jobs are authoritative here (see "Tests" above).

## Post-type routing

Reads route post vs. page distinctly at two different layers:

- The governed-invoker read (`readPostViaMcp`) dispatches `postType === "page"` to `ewpa/get-page`, everything else to `ewpa/get-post` — the pinned-fixture discovery capture registers them as distinct abilities.
- The direct-REST carve-outs (`readWordPressPostStatus`, `deleteWordPressPost` in `src/lib/wordpress-client.ts`) route `postType === "page"` to `/wp/v2/pages/{id}`, else `/wp/v2/posts/{id}`.

**No page-specific update ability exists.** `ewpa/update-post` is post-type-agnostic (WordPress core's `wp_update_post()` doesn't distinguish), so the review-gated write path always targets the post-shaped read ability for its current-content fetch and post-apply read-back, regardless of whether the resource is actually a page. `docs/external-mcp-adapter-pages.md` covers the practical fallout: page editing has no known supported ability today.

## Empty-field handling — scoped to the reviewed write only

There is no longer a connector-wide "never write an empty field" guard covering every write. The one place it survives:

- `resolveProposedState` (`src/integration/cms-review-trigger.ts`) drops an empty-string `content`/`excerpt` proposal as "not proposed" before diffing against current — WordPress applies `content: ""` as a literal wipe, so a title-only edit that also carries `content: ""` is treated as not touching content.
- This only runs on the review-gated `ewpa/update-post` path (see above). Every other ability reached through `wordpress_site_tool_call` gets `args` forwarded unmodified — whatever that ability does with an empty string is between the caller and the site, not something this connector guards.

## Direct-REST carve-outs

`src/lib/wordpress-client.ts` still calls `/wp/v2/*` directly (Basic auth via `resolveWordPressBasicAuth`) for a fixed set of members that never moved onto the governed invoker: `uploadWordPressMedia`, `deleteWordPressPost`, `readWordPressPostStatus`, `readLatestPublishedWordPressPost`, instance CRUD/validation (`saveWordPressInstance`, `validateWordPressInstanceConnection`, …), and webhook subscription management. `createDraft`, `updateDraftMeta`, and the `listPublished*` helpers were retired in the same cutover (PR #102) once their only callers (cinatra core's blog-publish path) moved onto the invoker — an org-wide grep found zero remaining callers of any of them.

## Widget chat tool factory

`src/widget-chat-tool.ts` exports `createWordPressWidgetChatTool({ context })`:

- Wrapped as an `LlmFunctionTool` and passed to `stream` in `src/app/api/agents/[agentSlug]/stream/route.ts`.
- Security: `instanceId` and `postId` are **forcibly overridden** from the server-trusted request context inside `execute()` — any LLM-supplied identity values are dropped. The tool schema only exposes `instructions`.
- Calls `runContentEditorRelay` in-process (not via an MCP network round-trip, and not by looking up `wordpress_content_editor_run` as a tool name — that name is never registered; see above).

The widget-routing skill lives in the `@cinatra-ai/wordpress-widget-chat-skill` extension at `extensions/cinatra-ai/wordpress-widget-chat-skill/skills/wordpress-widget-chat/SKILL.md` (skill id: `@cinatra-ai/wordpress-widget-chat-skill:wordpress-widget-chat`). This connector reaches it through the declared runtime dependency edge in `package.json`; it ships no bundle of its own, and `cinatra.widgetStream.skillCapability` names the `widget-chat.wordpress-content-editor` capability that the skill package provides.
