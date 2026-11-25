# wordpress-mcp-connector — AGENTS.md

Package-specific guidance for `@cinatra-ai/wordpress-mcp-connector`. This is a standalone, extracted extension repo (a source mirror, per `.github/workflows/ci.yml`) — there is no monorepo `packages/connector-wordpress` tree to read alongside; this file is self-contained. (`@cinatra-ai/wordpress-connector`, without `-mcp-`, is the old, fully-removed package name — do not reintroduce it; the cinatra host bans the import.)

## Package role

Registers via `createWordPressModule()` (`src/mcp/module.ts`), which returns `{ registerCapabilities: registerWordPressPrimitives }` — exported from `src/index.ts` and the `./mcp-module` package subpath for the host to consume. Deps wiring is separate: `cinatra.serverEntry: "./register"` (`package.json`) binds `src/register.ts`'s `register(ctx)`, which adapts host capabilities into this connector's runtime `WordPressConnectorDeps` (`src/deps.ts`) — it does not itself register any MCP tool. The connector exposes three governed, model-visible MCP primitives — `wordpress_site_tools_list`, `wordpress_site_tool_call` (read-only) and `wordpress_site_tool_write` — that forward to whatever ability a connected site's own MCP catalog advertises, rather than calling `/wp/v2/*` directly. A fixed set of direct-REST members survive as carve-outs (see below). It also provides the `WordPressSettingsPage` RSC (`src/settings-page.tsx`) for the connector's settings page.

## The generic catalog invoker replaced the 12 named tools

cinatra-ai/cinatra#2022 (S7) deleted the 12 named per-operation tools this connector used to expose (PR #101). Their names are enumerated once, in the CHANGELOG entry for that deletion, and are deliberately not re-spelled here: cinatra#2022's close gate is a shipped-code search that must return zero hits for them — scoped, not raw: this repo's CHANGELOG (a historical record) and the deletion-regression tests that assert the names are ABSENT keep them by design. Every caller reaches a connected site's own MCP catalog through these primitives only:

- `wordpress_site_tools_list` — list the site's own catalog (paginated; `instanceId` required only when the session isn't pinned to a single site).
- `wordpress_site_tool_call` - call a READ ability by that catalog's own `toolName` (e.g. `ewpa/get-post`), forwarding `args` unmodified to the site. It refuses every other ability (see the next section).
- `wordpress_site_tool_write` - call any ability by that catalog's own `toolName` (e.g. `ewpa/update-post`, `ewpa/create-post`), forwarding `args` unmodified to the site. Writes and publishes go through this tool.

All three are thin wrappers over the governed connector-instance invoker (`src/deps.ts`'s `invokeSiteTool` / `listSiteTools`, host capability `@cinatra-ai/host:connector-instance-invoker`) — see `src/mcp/handlers.ts` and `src/mcp/registry.ts`. `docs/external-mcp-adapter-pages.md` has the current walkthrough of which ability ids a community "Enable Abilities for MCP" catalog exposes for posts/pages, and what still has no supported path (page editing).

## Read and write tools - `wordpress_site_tool_call` is read-only

The platform holds a tool call during an agent run for the person's recorded decision when the tool's registration declares `outward`. The declaration is per registration, not per call, and agent runs also read the site through the catalog proxy, so the proxy is split in two:

- `wordpress_site_tool_call` forwards an ability only when it is a known read (`KNOWN_READ_ABILITIES` in `src/mcp/handlers.ts`: the core `get-*` abilities, `cinatra/post-read` and `ewpa/get-posts`, `ewpa/get-post`, `ewpa/get-page`, `ewpa/get-categories`) AND its catalog row on the server that will run it says read-only (`readRow`). The row is identified by `{serverId, name}`: with a `serverId` the only row of the name must be on that server; without one the name must have exactly one row in the catalog. The row must have the host class "read" with a read-only hint and no destructive hint. The `ewpa/*` abilities carry no annotations, so an `ewpa/*` known read with no annotation is accepted only on the default adapter server (`mcp-adapter-default`). The call is then pinned to that row's `serverId`. `KNOWN_WRITE_ABILITIES` (`ewpa/update-post`, `ewpa/create-post`) is refused whatever the catalog says.
- Every other case gets one fixed message (`SITE_TOOL_READ_ONLY_REFUSAL`) before the invoker is called: an unknown name, a write or destructive row, a missing row, a row of another server, several rows of the name, an unbound `listSiteTools`, and a catalog listing that does not end within 20 pages. A listing that throws passes its error on and never reaches the invoker. The catalog is read on each call, and the call follows the listing directly.
- Known limit: the check is not atomic with the call. The host resolves the call against its own catalog snapshot, which can refresh after the listing, and today checks only the destructive class at execution, so an entry that turned into an ordinary write would run. The read tool also sends the validated row's annotations as `expectedRawAnnotations`; it is not in the SDK call input, today's host ignores it, and nothing in this connector relies on it.
- `wordpress_site_tool_write` forwards any ability through the same governed path (the checks in the next section and the write gate included). Its registration declares `outward: {}`, with no `subject`, because its inputs carry no stored item with a revision. It is the only tool that declares `outward`: `OUTWARD_TOOL_NAMES` in `src/mcp/registry.ts` lists it. A declaration only adds a hold; a host that does not read the field ignores it.

- Flow steps without a model (cinatra#3745): `PASSTHROUGH_STEPS` in `src/mcp/registry.ts` declares `passthroughStep: "publishing"` on `wordpress_site_tool_write`; a host that reads the field serves it only to a publishing step whose card a person released. `wordpress_site_tool_call` declares no `passthroughStep`. A "read" declaration (served with no person's decision) is added only after the host enforces the read class at execution. Precondition: in `invokeConnectorInstanceTool` (cinatra `src/lib/connector-instance-invoker.ts`), right after `resolveToolAcrossServers` resolves the entry and before the policy check, the hooks and the execution, the host must (1) refuse with `catalog_entry_changed`, executing nothing, when the call carries `expectedRawAnnotations` (added to the SDK `SiteToolCallInput` and copied by the `invokeSiteTool` adapter in `src/lib/register-host-connector-services.ts`) and the resolved entry's `rawAnnotations` are not canonically equal to it, and (2) for a call from a flow step served through a "read" declaration, refuse with `passthrough_read_not_read_class` unless `classifyAnnotations(entry.rawAnnotations)` is "read" and the name is not on the known-destructive list, whatever the connector sent and whether or not the destructive hook is enabled. Never declare "read" on a tool that can reach a write.
- The connector does not check the arguments or results of `cinatra/post-read` and `cinatra/post-update-if-unchanged`. It forwards `expected` (with the read's `row_token`) unchanged and returns the plugin's result as is, refusal codes such as `post_changed` and `site_policy_conflict` included. The plugin refuses a missing or malformed `row_token` with `invalid`; a plugin older than `row_token` refuses the five-field `expected` with `invalid` too. Both write nothing.
- Both site tools take the ability's arguments either as `args` (an object) or as `argsJson` (the text of a JSON object, for a flow step that sends text), never both. `argsJson` is bounded at `SITE_TOOL_ARGS_JSON_MAX_BYTES` (256 KiB, UTF-8 bytes), must parse to a plain object, and is refused with fixed messages that never repeat the text.

A new tool that writes or publishes on a person's behalf joins `OUTWARD_TOOL_NAMES`. A new read ability that the catalog does not classify as read joins `KNOWN_READ_ABILITIES` only after its read-only behavior is checked on the site.

## The page update ability — `ewpa/update-post` only

`CONTENT_REVIEW_TARGET_ABILITIES` (`src/mcp/handlers.ts`) is `{"ewpa/update-post"}` — the only ability whose arguments are checked before the call. When `wordpress_site_tool_write` is called with that `toolName` (`wordpress_site_tool_call` refuses it before any check):

- `instanceId` is required unconditionally (no session-pin fallback) — the call is refused without one.
- `args.post_id` must be a strict positive integer (`Number.isInteger`, the same semantics as `z.coerce.number().int().positive()` — including accepting an exponential-but-integral string like `"1e2"`).
- `args.meta` is refused outright — meta writes go through `wordpress_site_tool_write` again with `toolName: "ewpa/update-post-meta"` (list the catalog first); they are never folded into the post payload.
- Any argument outside `post_id`/`title`/`content`/`excerpt`/`status` is refused before the call is forwarded.
- The call is forwarded with `args` unmodified, and the invoker's result is returned as is.

Every OTHER ability reachable through `wordpress_site_tool_write` is not content-review-gated today. Widening the keyed set (e.g. a future `ewpa/create-post`) is a deliberate, separate change — do not assume it is already covered.

## `post_id` / `postId` — no single universal rule anymore

There is no longer one schema-level constant across every WordPress primitive:

- `wordpress_content_editor_run`'s schema (`src/mcp/relay.ts`) still declares `postId: z.coerce.number().int().positive()` — the widget sends `String(postId)`, and `.coerce` makes that work.
- The review-gated `ewpa/update-post` path validates the snake_case `post_id` argument by hand inside `callReviewGatedSiteTool` (`src/mcp/handlers.ts`) — `siteToolCallSchema.args` is a generic `z.record(z.string(), z.unknown())`, so Zod can't apply a typed constraint to one key inside it.
- No other ability gets any id validation from this connector at all — the site tools forward `args` unmodified to whatever the target ability's own schema expects.

## `wordpress_content_editor_run` — A2A blocking dispatch, not a listed MCP tool

Dispatches to `wayflow-wordpress-content-editor` (default `http://localhost:3010/agents/cinatra-ai/wordpress-agent`, overridable via the `content_editor_a2a_url` connector setting read through the `settings` host port — connector code never reads `process.env`). Uses `timeoutMs: 300_000` (5 minutes). Reads the result from `task.history` — never `task.artifacts` (WayFlow does not implement `task.artifacts`). Strips Markdown code fences before `JSON.parse`.

It is **not** a model-visible MCP tool. cinatra#246 extracted it into its own module (`src/mcp/relay.ts`) that is deliberately never wired into `createWordPressPrimitiveHandlers()` / `registerWordPressPrimitives()` — so it is structurally impossible for it to reach `tools/list`. An agent with the Cinatra MCP server injected would otherwise see the tool name and call it, re-dispatching itself (observed: recursive `mcp_call` → 504). Callers (`src/widget-chat-tool.ts`) import `runContentEditorRelay` directly. `src/__tests__/registry-omission.test.ts` is the regression guard.

## Tests

Tests live in `src/__tests__/` (e.g. `handlers.test.ts`, `wordpress-client.test.ts`, `site-tool-review-trigger.test.ts`, `toolbox.test.ts` — avoid hard-coding the full list or a count here, it drifts as tests evolve). Most tests build a plain `WordPressConnectorDeps` object (`vi.fn()` stubs) and call `registerWordPressConnector(deps)` directly — no `vi.mock()` module interception needed, since nearly everything now reaches the host through the `src/deps.ts` DI slot. A few files (e.g. `setup-actions.test.ts`) still need `vi.mock()` for a module-level import; there, factory closures must be hoisted above import evaluation via `vi.hoisted()` — do not use a bare `const` outside `vi.hoisted()` for a mock variable a `vi.mock()` factory closes over.

This repo cannot run its test suite standalone: it is a source mirror (`.github/workflows/ci.yml` skips standalone install/typecheck/test whenever a package declares host-internal `@cinatra-ai/*` peers, which this one does), and `vitest.config.ts`'s aliases (`@/`, `server-only`) resolve three directories up from this file — they assume the repo is checked out inside the cinatra host tree, not standalone. Validate a change here with `node --check` on touched files and `node extension-kind-gate.mjs --package-root .`; treat the cinatra host's own CI Typecheck/Test jobs as authoritative once this connector is embedded there.

## Adding new primitives

1. Add an input schema (`z.object(...)`) in `handlers.ts`.
2. Add the handler to `createWordPressPrimitiveHandlers()`.
3. Add the tool metadata entry to `TOOL_META` in `registry.ts`. If the tool writes or publishes on a person's behalf, also add its name to `OUTWARD_TOOL_NAMES` there.
4. Add a test case to `handlers.test.ts`.
5. There is no `pnpm typecheck` script in this repo (`package.json` only declares `test` and `lint`) — run `pnpm lint` (eslint) locally; the cinatra host's CI Typecheck/Test jobs are authoritative here (see "Tests" above).

## Post-type routing

Reads route post vs. page distinctly in the direct-REST carve-outs:

- The direct-REST carve-outs (`readWordPressPostStatus`, `deleteWordPressPost` in `src/lib/wordpress-client.ts`) route `postType === "page"` to `/wp/v2/pages/{id}`, else `/wp/v2/posts/{id}`.

**No page-specific update ability exists.** `ewpa/update-post` is post-type-agnostic (WordPress core's `wp_update_post()` doesn't distinguish), so the same update ability serves posts and pages. `docs/external-mcp-adapter-pages.md` covers the practical fallout: page editing has no known supported ability today.

## Empty-field handling

There is no connector-wide "never write an empty field" guard. Every ability reached through `wordpress_site_tool_write`, `ewpa/update-post` included, gets `args` forwarded unmodified — whatever that ability does with an empty string is between the caller and the site, not something this connector guards.

## Direct-REST carve-outs

`src/lib/wordpress-client.ts` still calls `/wp/v2/*` directly (Basic auth via `resolveWordPressBasicAuth`) for a fixed set of members that never moved onto the governed invoker: `uploadWordPressMedia`, `deleteWordPressPost`, `readWordPressPostStatus`, `readLatestPublishedWordPressPost`, instance CRUD/validation (`saveWordPressInstance`, `validateWordPressInstanceConnection`, …), and webhook subscription management. `createDraft`, `updateDraftMeta`, and the `listPublished*` helpers were retired in the same cutover (PR #102) once their only callers (cinatra core's blog-publish path) moved onto the invoker — an org-wide grep found zero remaining callers of any of them.

## Widget chat tool factory

`src/widget-chat-tool.ts` exports `createWordPressWidgetChatTool({ context })`:

- Wrapped as an `LlmFunctionTool` and passed to `stream` in `src/app/api/agents/[agentSlug]/stream/route.ts`.
- Security: `instanceId` and `postId` are **forcibly overridden** from the server-trusted request context inside `execute()` — any LLM-supplied identity values are dropped. The tool schema only exposes `instructions`.
- Calls `runContentEditorRelay` in-process (not via an MCP network round-trip, and not by looking up `wordpress_content_editor_run` as a tool name — that name is never registered; see above).

The widget-routing skill lives in the `@cinatra-ai/wordpress-widget-chat-skill` extension at `extensions/cinatra-ai/wordpress-widget-chat-skill/skills/wordpress-widget-chat/SKILL.md` (skill id: `@cinatra-ai/wordpress-widget-chat-skill:wordpress-widget-chat`). This connector reaches it through the declared runtime dependency edge in `package.json`; it ships no bundle of its own, and `cinatra.widgetStream.skillCapability` names the `widget-chat.wordpress-content-editor` capability that the skill package provides.
