# connector-wordpress — AGENTS.md

Package-specific guidance for `@cinatra-ai/wordpress-connector`. Read alongside the repo-root `AGENTS.md` and `packages/connector-drupal/AGENTS.md` (the Drupal connector is the reference pattern).

## Package role

Exposes MCP primitives that call the WordPress REST API (`/wp/v2/*`) on each configured WordPress site. Also provides the `WordPressSettingsPage` RSC for `/configuration/llm/wordpress` and wires into `src/lib/mcp-server.ts` via `createWordPressModule()`.

Provides `wordpress_content_editor_run` (A2A blocking dispatch to WayFlow) and `wordpress_post_update` (top-level REST update). `wordpress_post_update_meta` writes only the `meta` field and is a separate primitive — do not merge them.

## Key primitive asymmetry vs. Drupal

| Feature | Drupal | WordPress |
|---------|--------|-----------|
| Draft-before-edit | `drupal_node_create_draft_revision` (true draft revision) | `wordpress_post_update(status: "draft")` — **demote-then-edit** (no true revision API) |
| Read by ID | `mcp_tools_search_content` (search proxy) | `/wp/v2/posts/{id}?context=edit` (direct REST lookup) |
| Auth | Bearer token (MCP key) | Basic auth (username + application password) |
| postId type | string (Drupal node IDs may be alphanumeric) | **number** (WordPress always uses numeric IDs) |

## `postId` must be a positive integer — always coerce

Widget sends `String(postId)`. All WordPress handlers that accept a post ID use:

```typescript
z.coerce.number().int().positive()
```

This is required at the Zod schema level. Do not accept raw strings for `postId` — WordPress REST endpoints embed the ID in the URL path and will 404 on non-numeric values.

## `readWordPressPost` returns `content`

`src/lib/wordpress-api.ts:readWordPressPost` fetches with `context=edit` so the response includes `content.raw`. The return value includes `content: payload.content?.raw ?? payload.content?.rendered ?? ""`. This is required by the `wordpress-content-editor` SKILL.md Step 1 for before/after diff construction.

If you add a new field to the `WordPressPostRecord` type, also forward it in `readWordPressPost`'s return statement. Omitting a field silently prevents the agent from building accurate diffs.

## `wordpress_post_update` — at-least-one-field constraint

`postUpdateSchema` uses `.refine(...)` to require at least one of `title`, `content`, `excerpt`, `status`, or `meta`. This prevents silent no-ops. Do not relax this — if the LLM sends an empty update, it should fail fast with a descriptive error.

Status is constrained to a Zod enum: `z.enum(["publish", "future", "draft", "pending", "private"])`. Do not accept arbitrary status strings.

## `wordpress_content_editor_run` — A2A blocking dispatch

Dispatches to `wayflow-wordpress-content-editor` (default `http://localhost:3021`, overridable via `WP_CONTENT_EDITOR_A2A_URL`). Uses `timeoutMs: 300_000` (5 minutes). Reads the result from `task.history` — never `task.artifacts` (WayFlow does not implement `task.artifacts`). Strips Markdown code fences before `JSON.parse`.

## Tests

Tests live in `src/__tests__/` (currently `handlers.test.ts`, `wordpress-api.test.ts`, and `content-editor-run.test.ts`). Run from the package directory:

```bash
cd packages/connector-wordpress && pnpm vitest run --no-coverage
```

Avoid hard-coding a per-file or total test count here — it drifts as tests evolve. All mocks use `vi.hoisted()` — factory closures must be hoisted above import evaluation. Do not use bare `const` outside `vi.hoisted()` for mock variables in `vi.mock()` factories.

## Adding new primitives

1. Add an input schema (`z.object(...)`) in `handlers.ts`.
2. Add the handler to `createWordPressPrimitiveHandlers()`.
3. Add the tool metadata entry to `TOOL_META` in `registry.ts`.
4. Add a test case to `handlers.test.ts`.
5. Run `pnpm typecheck` and `pnpm vitest run` from the package root.

## REST endpoint routing by post type

WordPress REST API separates content by post type:

- **Posts** (`post_type: post`): `/wp/v2/posts/{id}`
- **Pages** (`post_type: page`): `/wp/v2/pages/{id}`
- **Custom post types**: `/wp/v2/{type}/{id}`

`readWordPressPost` and `updateWordPressPost` in `src/lib/wordpress-api.ts` both accept an optional `postType` parameter. When `postType === "page"`, they route to `/wp/v2/pages/{id}`. Thread `postType` from widget context → schema → handler → API function. Missing `postType` defaults to `"post"`.

Both `postStatusSchema` (`wordpress_post_get`) and `postUpdateSchema` (`wordpress_post_update`) include `postType: z.string().optional()`. The WayFlow SKILL.md instructs the agent to always pass `postType` to both tools.

## Empty-field injection guard

WordPress applies field values literally — `content: ""` deletes the post body. LLMs observed passing empty strings for fields they did not intend to change (title-only edit sent `content: ""`, wiping the body).

### `wordpress_post_update` — two-layer defence

1. **Schema** — `postUpdateSchema.content` is `z.string().min(1).optional()`. Empty string fails validation; agent retries without the field.
2. **API layer** — `updateWordPressPost` skips `content` and `excerpt` if their value is an empty string, even if validation somehow passes.

`agents/wordpress-content-editor/skills/wordpress-content-editor/SKILL.md` explicitly warns against passing empty strings for unchanged fields. Keep this warning in sync with any schema changes.

### `wordpress_post_update_meta` — runtime strip filter + all-empty guard

`wordpress_post_update_meta` receives `meta: z.record(z.string(), z.unknown())`. Zod cannot apply per-key `min(1)` guards to free-form records. The runtime guard filters empty strings before dispatch:

```typescript
const safeMeta = Object.fromEntries(
  Object.entries(meta).filter(([, v]) => v !== ""),
);
if (Object.keys(safeMeta).length === 0) {
  throw new Error("No meta fields provided.");
}
return updateWordPressDraftMeta({ instance, wordpressPostId: postId, meta: safeMeta });
```

The filter uses strict equality on `""` so `null`, `false`, and `0` pass through unchanged — legitimate meta clears keep working.

### Watch: `wordpress_post_update.meta` path is **not filtered**

`wordpress_post_update` accepts an optional `meta: Record<string, unknown>` field. This path goes directly to the WordPress REST PATCH body — there is **no empty-string strip filter** on the meta sub-object. If the LLM passes `{ meta: { "_some_key": "" } }` via `wordpress_post_update`, WordPress will write the empty string to that meta key. The empty-string filters only cover the dedicated `wordpress_post_update_meta` primitive. If meta editing is added via `wordpress_post_update`, apply the same `Object.entries(...).filter(([, v]) => v !== "")` pattern to the meta sub-object before dispatch.

## Widget chat tool factory

`src/widget-chat-tool.ts` exports `createWordPressWidgetChatTool({ context })`:

- Wrapped as an `LlmFunctionTool` and passed to `stream` in `src/app/api/agents/[agentSlug]/stream/route.ts`.
- Security: `instanceId` and `postId` are **forcibly overridden** from the server-trusted request context inside `execute()` — any LLM-supplied identity values are dropped. The tool schema only exposes `instructions`.
- Calls `wordpress_content_editor_run` in-process (not via MCP network round-trip).

Skills for widget routing live in `packages/connector-wordpress/skills/wordpress-widget-chat/SKILL.md` (skill ID: `@cinatra/connector-wordpress:wordpress-widget-chat`).
