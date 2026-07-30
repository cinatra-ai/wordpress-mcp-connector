import { z } from "zod";
import type { ExtensionPrimitiveRequest } from "@cinatra-ai/sdk-extensions";
// Every host surface arrives through the host-bound deps slot (cinatra#172
// Stage H3): instance/status reads from the extended
// `@cinatra-ai/host:wordpress-mcp` service, the carve-out post/media CRUD from
// the `@cinatra-ai/host:wordpress-content` service, pagination from
// `@cinatra-ai/host:mcp-pagination` — no `@/lib/wordpress-api` import.
//
// EXCEPT the two in-admin editing primitives: `wordpress_post_get` /
// `wordpress_post_update` reach WordPress content through the GOVERNED
// CONNECTOR-INSTANCE INVOKER (`getWordPressDeps().invokeSiteTool`, the SAME
// channel `wordpress_site_tool_call` uses), calling the community "Enable
// Abilities for MCP" catalog's `ewpa/get-post` / `ewpa/get-page` /
// `ewpa/update-post` abilities — never `cinatra-content-server` and never a
// direct `/wp/v2/*` REST call (cinatra-ai/cinatra#2022; see the section
// comment above `readPostViaMcp` below for the retarget's evidence + the
// fail-loud content guard).
import {
  getWordPressDeps,
  listInstancesSorted,
  type WordPressMcpInstance,
  type WordPressMcpPublicInstance,
  type WidgetActorContext,
  type WidgetActorOverride,
} from "../deps";
import {
  evaluateStagedContentWrite,
  type CmsCurrentContent,
} from "../integration/cms-review-trigger";
import { WORDPRESS_CONNECTOR_ID } from "../integration/pointer-writer-core";
import {
  callWordPressMcp,
  CINATRA_POST_STATUS_TOOL,
  CINATRA_POSTS_LIST_TOOL,
  CINATRA_POST_DELETE_TOOL,
  CINATRA_MEDIA_UPLOAD_TOOL,
  CINATRA_POST_CREATE_DRAFT_TOOL,
  CINATRA_POST_UPDATE_META_TOOL,
} from "../lib/wordpress-mcp-client";

// READ-BOUNDARY redaction. A read/list primitive must NEVER emit credential
// material. This projection drops `applicationPassword` AND the
// Nango credential binding (`providerConfigKey`/`connectionId`) — anything a
// caller could use to authenticate against the site — and returns only
// non-secret display fields. Write primitives are unaffected: they re-resolve
// the FULL row via `listInstancesSorted().find(...)` and thread it host-side,
// where Basic auth is resolved from the row's binding; callers never receive
// the password.
function toPublicInstance(i: WordPressMcpInstance): WordPressMcpPublicInstance {
  return {
    id: i.id,
    name: i.name,
    siteUrl: i.siteUrl,
    username: i.username,
    lastValidatedAt: i.lastValidatedAt,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    blogConnectorId: i.blogConnectorId,
  };
}

// Strip Markdown code fences from LLM-emitted JSON before parse. The
// wayflow-wordpress-content-editor agent's LLM occasionally wraps its JSON
// output in ```json ... ``` fences; the regex only matches at string
// boundaries so internal triplets survive.
function stripCodeFences(text: string): string {
  return text.replace(/^```(?:json)?\n?|\n?```$/g, "").trim();
}

// Per-user / per-connector-instance WRITE-authority gate (cinatra#409).
//
// EVERY write primitive calls this AFTER resolving the instance and BEFORE
// dispatching the write to the host writer. The host dep derives the trusted
// user actor from the active MCP request frame (NEVER from connector tool
// input), denies a null actor (no userId+orgId), and enforces the user's
// per-instance `use` entitlement via requireConnectorAuthority — throwing on
// deny.
//
// FAIL-CLOSED: the registry passes only an SDK-shape `actor` literal that is NO
// LONGER an authz input (the SDK types `request.actor` as `unknown`). If the
// host is old / skewed and the dep is unbound (or not a function), this guard
// THROWS rather than letting the write proceed under a synthetic/anonymous
// actor — the write path is deny-by-default when authorization cannot run.
async function requireWriteAuthority(instanceId: string, primitiveName: string): Promise<void> {
  const gate = getWordPressDeps().requireInstanceWriteAuthority;
  if (typeof gate !== "function") {
    // Unbound on an old/partial host: deny — never write without the gate.
    throw new Error(
      `WordPress write "${primitiveName}" denied: per-user write-authority gate is unavailable ` +
        "(host requireInstanceWriteAuthority unbound). Refusing to write without authorization.",
    );
  }
  // Throws on deny (non-member / member-without-right / null actor / cross-org
  // instance / platform-admin on the widget path). Resolving == authorized.
  await gate({ instanceId, primitiveName });
}

// S5 delegated-widget OBO reconstruction (cinatra S5-W1 §5 G3/G4). Build the
// carrier-run actor override from the TRUSTED widget actor context the host
// derives from the MCP request frame — NEVER from tool input. Fail-closed:
//   • a `public_site_widget` delegation MISSING pinned fields (blank runBy /
//     orgId / instanceId) is a malformed delegation → THROW (never fall through
//     to the normal identity path — the "missing override on a widget call"
//     negative case);
//   • G3 INSTANCE PIN — the model-supplied tool-arg `toolInstanceId` MUST equal
//     the actor's SERVER-PINNED `instanceId`, else `instance_pin_mismatch` (a
//     prompt-injected / confused-model attempt to target a different
//     origin-matched instance in the same org is refused, no write).
// The returned override drives `dispatchContentEditor`'s `actorOverride`, so the
// carrier run authorizes AS THE END USER against the pinned instance with the
// platform-admin-suppressing `sourceType`.
function buildWidgetActorOverride(
  actor: WidgetActorContext,
  toolInstanceId: string,
  primitiveName: string,
): WidgetActorOverride {
  if (!actor.runBy || !actor.orgId || !actor.instanceId) {
    throw new Error(
      `${primitiveName} denied: public_site_widget delegation is missing the pinned actor fields (runBy/orgId/instanceId).`,
    );
  }
  if (toolInstanceId !== actor.instanceId) {
    throw new Error(
      `instance_pin_mismatch: ${primitiveName} tool-arg instanceId "${toolInstanceId}" ` +
        "does not match the widget actor's server-pinned instance.",
    );
  }
  return {
    runBy: actor.runBy,
    orgId: actor.orgId,
    instanceId: actor.instanceId,
    sourceType: "public_site_widget",
  };
}

export const instanceIdSchema = z.object({
  instanceId: z.string().min(1),
});

export const postsListSchema = z.object({
  instanceId: z.string().min(1),
  cursor: z.string().optional(),
});

export const createDraftSchema = z.object({
  instanceId: z.string().min(1),
  title: z.string(),
  content: z.string(),
  excerpt: z.string().default(""),
});

export const postStatusSchema = z.object({
  instanceId: z.string().min(1),
  postId: z.coerce.number().int().positive().describe("WordPress post ID (string from widget coerced to number)"),
  postType: z.string().optional().describe("Post type slug — pass 'page' to target a WordPress page instead of a post."),
});

export const uploadMediaSchema = z.object({
  instanceId: z.string().min(1),
  imageBase64: z.string(),
  imageMimeType: z.string(),
  title: z.string(),
});

export const updateMetaSchema = z.object({
  instanceId: z.string().min(1),
  postId: z.coerce.number().int().positive().describe("WordPress post ID (string from widget coerced to number)"),
  meta: z.record(z.string(), z.unknown()),
});

// ---------------------------------------------------------------------------
// Governed connector-instance invoker primitives (cinatra#2017 S2, gateway).
//
// `wordpress_site_tool_call` / `wordpress_site_tools_list` are the model-visible,
// connector-owned entry points to the governed invoker (Plane C): they schema-
// parse, then call the host invoker capability through the deps slot. They carry
// NO `connectorKey` and NO `kind` (host-derived from the verified `packageName`,
// M6) and pass NO actor (host-derived from the MCP request frame, §2.4). They
// ship DARK in S2 — delegated chat/widget deny-by-default keeps them off those
// perimeters and they are on no agent-run allowlist; S7 performs the exposure.
// ---------------------------------------------------------------------------

export const siteToolCallSchema = z.object({
  toolName: z
    .string()
    .min(1)
    .describe(
      "The site tool / ability to call. On the default aggregator server this is the inner ability id, which may contain a slash (e.g. \"core/get-site-info\").",
    ),
  // Forwarded to the resolved tool's advertised schema UNMODIFIED (§3.7).
  // Defaults to {} so a no-argument tool is callable without an explicit args.
  args: z
    .record(z.string(), z.unknown())
    .default({})
    .describe("Arguments for the target tool, matching its advertised input schema. Omit or pass {} for a no-argument tool."),
  instanceId: z
    .string()
    .min(1)
    .optional()
    .describe("Target connected-site instance. Required only when your session is not pinned to a single site."),
  serverId: z
    .string()
    .min(1)
    .optional()
    .describe("Target MCP server. Required only when the tool name is ambiguous across the site's enrolled servers."),
});

export const siteToolsListSchema = z.object({
  instanceId: z
    .string()
    .min(1)
    .optional()
    .describe("Target connected-site instance. Required only when your session is not pinned to a single site."),
  serverId: z
    .string()
    .min(1)
    .optional()
    .describe("Restrict the listing to a single MCP server. Optional."),
  cursor: z
    .string()
    .optional()
    .describe("Pagination cursor from a previous page's nextCursor. Pages are consistent within one catalog revision."),
});

// Blocking A2A dispatch to wayflow-wordpress-content-editor (port 3021).
// postId uses z.coerce.number().int().positive() so widget callers (which send
// String(postId) from buildContentContext) work.
export const contentEditorRunSchema = z.object({
  instanceId:   z.string().min(1).describe("WordPress instance ID from connector administration"),
  postId:       z.coerce.number().int().positive().describe("WordPress post ID (string from widget coerced to number)"),
  postType:     z.string().optional().default("post").describe("Post type slug"),
  postStatus:   z.string().optional().default("").describe("Current publish status: publish or draft"),
  instructions: z.string().min(1).describe("Natural language editing instructions"),
});

// Top-level field updates are needed by the SKILL.md demote-then-edit pattern.
// Refinement requires at least one editable field so the primitive can never
// silently no-op.
export const postUpdateSchema = z
  .object({
    instanceId: z.string().min(1),
    postId:     z.coerce.number().int().positive().describe("WordPress post ID (string from widget coerced to number)"),
    postType:   z.string().optional().describe("Post type slug — 'page' targets a WordPress page instead of a post"),
    title:      z.string().optional(),
    // min(1) prevents the LLM from accidentally passing content:"" which WordPress applies literally,
    // wiping the entire post body. Omit content entirely when not changing it.
    content:    z.string().min(1).optional().describe("New post body. Must be non-empty. OMIT entirely if the user did not ask to change content."),
    excerpt:    z.string().optional(),
    status:     z.enum(["publish", "future", "draft", "pending", "private"]).optional(),
    meta:       z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (val) =>
      typeof val.title === "string" ||
      typeof val.content === "string" ||
      typeof val.excerpt === "string" ||
      typeof val.status === "string" ||
      (val.meta !== undefined && typeof val.meta === "object"),
    { message: "At least one editable field (title, content, excerpt, status, meta) is required." },
  );

// ---------------------------------------------------------------------------
// In-admin content read/update — GOVERNED INVOKER retarget (cinatra-ai/
// cinatra#2022).
//
// `wordpress_post_get` / `wordpress_post_update` USED TO reach WordPress
// content only through the site's Cinatra-owned MCP integration
// (`callWordPressMcp` → the plugin's `cinatra-post-get` / `cinatra-post-update`
// abilities on `cinatra-content-server`, cinatra-ai/wordpress-plugin #81).
// They now reach it through the GOVERNED CONNECTOR-INSTANCE INVOKER
// (`getWordPressDeps().invokeSiteTool`, the SAME channel
// `wordpress_site_tool_call` already uses), calling the community "Enable
// Abilities for MCP" catalog's `ewpa/get-post` / `ewpa/get-page` /
// `ewpa/update-post` abilities. Tool NAMES are UNCHANGED — only the transport
// underneath moves; the old cinatra-content-server path is a later,
// separately reviewed deletion once this soaks.
//
// ABILITY EXISTENCE. `ewpa/get-post` was never VERIFY-executed against the
// pinned WordPress e2e fixture (only the LIST ability `ewpa/get-posts` was,
// and that list response carries NO post-body field at all — evidenced
// directly in cinatra/tests/e2e/wp-mcp-gateway/captures/verify-verdicts.json,
// whose `ewpa/get-posts` PASS record's returned items carry `post_title` /
// `post_status` / `post_date` / `post_excerpt` / `permalink` / `categories` /
// `tags` and NO `post_content`/`content` key — the exact gap this change
// must not silently inherit). `ewpa/get-post`'s EXISTENCE, however, is
// directly evidenced by a live discovery capture against the SAME pinned
// fixture (WordPress 6.9 / mcp-adapter 0.5.0 / Enable Abilities for MCP
// 2.0.20, captured 2026-07-29, CI run
// https://github.com/cinatra-ai/cinatra/actions/runs/30442320352):
// `cinatra/tests/e2e/wp-mcp-gateway/captures/annotations-c-gateway-triad.json`
// (and its sibling annotations-f) record the `mcp-adapter-discover-abilities`
// response listing `ewpa/get-post` with the self-described purpose
// "Retrieves all details of a specific post by ID, including full content,
// metadata, and featured image." A companion `ewpa/get-page` ability exists
// for pages in the SAME capture; no page-specific UPDATE ability exists
// (only `ewpa/update-post`) — WordPress core's `wp_update_post()` is
// post-type-agnostic, so the same update ability is used for both.
//
// FAIL-LOUD CONTENT GUARD. This change could not execute a live
// `ewpa/get-post` call (no dev/verify stack boots on this box) to confirm
// its exact response FIELD NAMES, only its existence + advertised purpose.
// `extractEwpaContent` below checks the WP_Post-native `post_content` key
// first (the SAME snake_case `post_*` convention already VERIFIED on
// `ewpa/get-posts`'s list items and on `ewpa/delete-post`'s captured
// `input_schema` — a real, evidenced pattern, not a guess) and `content` as
// a fallback — but NEVER silently coerces an absent key to `""`. An absent
// key throws a descriptive error instead, so a wrong field-name inference
// fails LOUD in CI/e2e (the pinned-fixture `wordpress-uat.spec.ts` /
// `wordpress-render-parity-uat.spec.ts` suites) rather than shipping a
// silent content-losing read.
// ---------------------------------------------------------------------------

const EWPA_GET_POST_ABILITY = "ewpa/get-post";
const EWPA_GET_PAGE_ABILITY = "ewpa/get-page";
const EWPA_UPDATE_POST_ABILITY = "ewpa/update-post";

/** WordPress admin edit URL for a post/page id (the old REST client's shape). */
function buildAdminUrl(siteUrl: string, postId: number): string {
  return `${siteUrl.replace(/\/+$/, "")}/wp-admin/post.php?post=${postId}&action=edit`;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Call an `ewpa/*` ability through the governed connector-instance invoker
 * and unwrap its `{success, data}` response envelope — the community
 * catalog's own convention, evidenced directly by the pinned-fixture S1
 * VERIFY captures for `ewpa/create-post`, `ewpa/update-post-meta`, and
 * `ewpa/get-posts` (all three PASS records return `{success:true,
 * data:{...}}`, cinatra/tests/e2e/wp-mcp-gateway/captures/verify-verdicts.json).
 * FAIL-CLOSED: the governed invoker unbound, an explicit `success:false`, or
 * a non-object `data` all throw rather than returning a guessed/empty shape —
 * the same fail-closed posture `wordpress_site_tool_call` already carries.
 */
async function callEwpaAbility(
  instance: WordPressMcpInstance,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const invoke = getWordPressDeps().invokeSiteTool;
  if (typeof invoke !== "function") {
    throw new Error(
      `WordPress "${toolName}" denied: the governed connector-instance invoker is unavailable ` +
        "(host @cinatra-ai/host:connector-instance-invoker unbound). Refusing to call without the governed channel.",
    );
  }
  const raw = await invoke({ toolName, args, instanceId: instance.id });
  const envelope = raw as { success?: unknown; data?: unknown } | null | undefined;
  // Codex-adopted hardening: require the EXPLICIT `success:true` the envelope
  // contract promises, not merely "not false" — an envelope missing the
  // `success` key entirely is a malformed/unexpected response, not an
  // implicit pass, and must fail closed the same as an explicit false.
  if (!envelope || typeof envelope !== "object" || envelope.success !== true) {
    throw new Error(`WordPress ${toolName} failed: the site reported an unsuccessful result.`);
  }
  if (!envelope.data || typeof envelope.data !== "object") {
    throw new Error(`WordPress ${toolName}: unexpected response shape (no "data" object).`);
  }
  return envelope.data as Record<string, unknown>;
}

/**
 * The community catalog's pinned-fixture discovery capture registers
 * DISTINCT read abilities for posts and pages (`ewpa/get-post` /
 * `ewpa/get-page`) and SEPARATE abilities entirely for custom post types
 * (`ewpa/get-cpt-item` / `ewpa/get-cpt-items`, not wired up by this retarget).
 * Codex-adopted hardening: an unsupported `postType` (a CPT slug, a typo,
 * anything besides the default/"post"/"page") is refused rather than
 * silently mis-routed to a post- or page-shaped ability that was never
 * proven to handle it.
 */
function assertSupportedReadPostType(postType: string | undefined, primitiveName: string): void {
  if (postType !== undefined && postType !== "post" && postType !== "page") {
    throw new Error(
      `${primitiveName}: postType "${postType}" is not supported by the governed-invoker retarget ` +
        '(only the default and "page" have a proven ewpa/* ability behind them — "page" routes to ' +
        "ewpa/get-page). Custom post types need their own ewpa/get-cpt-item-based primitive, not this one.",
    );
  }
}

/**
 * Extract the post body from an `ewpa/get-post` / `ewpa/get-page` result.
 * HARD REQUIREMENT: NEVER silently coerce an absent content key to `""` —
 * that is exactly how the earlier `ewpa/get-posts` re-point lost post bodies
 * unnoticed (see the section comment above). Throws when neither known key
 * is present, so a wrong field-name inference fails loud instead of shipping
 * empty content.
 */
function extractEwpaContent(data: Record<string, unknown>, toolName: string): string {
  if (typeof data.post_content === "string") return data.post_content;
  if (typeof data.content === "string") return data.content;
  throw new Error(
    `WordPress ${toolName}: response carried no recognizable content field ` +
      '(checked "post_content", "content") — refusing to return empty content silently.',
  );
}

/** Read a post for editing via the governed invoker. Returns the same field
 * shape the old direct-REST `readWordPressPost` (and, before this PR, the
 * `cinatra-post-get`-backed version) returned — the before-values the
 * content-editor agent's field-diff reads — with `adminUrl` built
 * connector-side. `postType:"page"` dispatches to `ewpa/get-page` instead of
 * `ewpa/get-post` (the pinned fixture's discovery capture registers them as
 * distinct abilities; see the section comment above). */
async function readPostViaMcp(
  instance: WordPressMcpInstance,
  postId: number,
  postType?: string,
) {
  assertSupportedReadPostType(postType, "wordpress_post_get");
  const ability = postType === "page" ? EWPA_GET_PAGE_ABILITY : EWPA_GET_POST_ABILITY;
  const data = await callEwpaAbility(instance, ability, { post_id: postId });
  const content = extractEwpaContent(data, ability);
  const idRaw = data.ID ?? data.id ?? data.post_id;
  const id = Number(idRaw);
  const resolvedId = Number.isFinite(id) ? id : postId;
  const title = data.post_title ?? data.title;
  const excerpt = data.post_excerpt ?? data.excerpt;
  const status = data.post_status ?? data.status;
  const link = data.permalink ?? data.link;
  const slug = data.post_name ?? data.slug;
  return {
    id: resolvedId,
    status: asString(status) || "unknown",
    title: asString(title),
    content,
    excerpt: asString(excerpt),
    slug: typeof slug === "string" ? slug : undefined,
    link: typeof link === "string" ? link : undefined,
    adminUrl: buildAdminUrl(instance.siteUrl, resolvedId),
  };
}

/** Update a post via the governed invoker (title/content/excerpt/status;
 * demote-then-edit via status:"draft"). Returns the same field shape the old
 * direct-REST `updateWordPressPost` returned.
 *
 * The community ability's own response envelope is NOT proven to echo the
 * full updated post back (the evidenced pattern — `ewpa/create-post`'s PASS
 * response is `{post_id, permalink, status, message}`, no title/content
 * echo). Rather than guess at an echoed shape and risk silently returning
 * stale/empty content to the caller, this independently RE-READS the post
 * after applying the write, reusing the SAME content-preserving read path
 * `readPostViaMcp` uses above — mirroring what `wordpress_post_update`'s own
 * review-gate post-apply verification already does one level up. */
async function updatePostViaMcp(input: {
  instance: WordPressMcpInstance;
  postId: number;
  postType?: string;
  fields: {
    title?: string;
    content?: string;
    excerpt?: string;
    status?: "publish" | "future" | "draft" | "pending" | "private";
    meta?: Record<string, unknown>;
  };
}) {
  // `ewpa/update-post` (the community catalog's ability, replacing
  // `cinatra-post-update`) covers title/content/excerpt/status only — NOT
  // `meta`. Rather than silently drop a requested change, fail closed and
  // route the caller to the dedicated meta primitive
  // (`wordpress_post_update_meta` stays on its REST carve-out). DEFENSIVE
  // BACKSTOP: the `wordpress_post_update` handler above already rejects this
  // pre-gate; this repeats the check for `updatePostViaMcp`'s own callers.
  if (input.fields.meta !== undefined) {
    throw new Error(
      "wordpress_post_update cannot write post meta over the MCP content server — " +
        "use wordpress_post_update_meta for meta writes.",
    );
  }

  // Build the ability args: strip undefined; drop empty-string content/excerpt
  // (WordPress applies them literally and would wipe the body). Only literal
  // "" is dropped so a legitimate title clear still works. `post_id` matches
  // the community catalog's own identify-by-id convention (evidenced on
  // `ewpa/delete-post`'s captured input_schema, which requires `post_id`).
  const args: Record<string, unknown> = { post_id: input.postId };
  if (typeof input.fields.title === "string") args.title = input.fields.title;
  if (typeof input.fields.content === "string" && input.fields.content.length > 0) args.content = input.fields.content;
  if (typeof input.fields.excerpt === "string" && input.fields.excerpt.length > 0) args.excerpt = input.fields.excerpt;
  if (typeof input.fields.status === "string") args.status = input.fields.status;

  // Guard against dispatching an update with no editable field left after
  // stripping (the ability would reject it anyway; surface it precisely).
  // DEFENSIVE BACKSTOP: the handler above already rejects this pre-gate.
  const editableKeys = Object.keys(args).filter((k) => k !== "post_id");
  if (editableKeys.length === 0) {
    throw new Error("No editable fields to update (title/content/excerpt/status).");
  }

  // No page-specific update ability exists in the pinned fixture's discovery
  // capture (only `ewpa/get-page` for reads) — WordPress core's
  // `wp_update_post()` is post-type-agnostic, so `ewpa/update-post` targets
  // pages too (`input.postType` is not sent — the ability keys purely off
  // `post_id`, same as `ewpa/delete-post`'s evidenced schema).
  await callEwpaAbility(input.instance, EWPA_UPDATE_POST_ABILITY, args);

  return readPostViaMcp(input.instance, input.postId, input.postType);
}

// ---------------------------------------------------------------------------
// Remaining in-admin content primitives over MCP (wordpress-plugin#82).
//
// status / list / delete / media / draft / meta reach WordPress ONLY through the
// plugin's content MCP server (`callWordPressMcp` → cinatra-post-status /
// cinatra-posts-list / cinatra-post-delete / cinatra-media-upload /
// cinatra-post-create-draft / cinatra-post-update-meta), never a direct
// `/wp/v2/*` REST call. `callWordPressMcp` detects each tool at runtime and
// throws FAIL-CLOSED when the plugin is missing/too old — it never degrades to
// direct REST. Each helper maps the plugin ability's output back to the field
// shape the old direct-REST dep returned so the callers are unchanged.
//
// BLOG-PUBLISH CARVE-OUT: the `wordpress_post_create_draft` / `wordpress_media_upload`
// MCP PRIMITIVES here are the IN-ADMIN assistant's tools, so rerouting them behind
// MCP affects ONLY the in-admin path. The (non-in-admin) blog-publish pipeline does
// NOT call these primitives — the blog-wordpress-publish agent uses the
// `blog_post_publish_wordpress_start` blog primitive, which resolves the post +
// hero-image artifacts host-side and writes through the published
// `@cinatra-ai/host:wordpress-content` capability (the connector-owned REST client
// wired in register.ts). That REST path is DELIBERATELY RETAINED — a non-in-admin
// caller remains — so blog-publish is unaffected and the direct-REST client is not
// deleted. The Cinatra plugin thus becomes required for the IN-ADMIN content tools,
// not for blog-publish. The per-user #409 write-authority gate is unchanged.
// ---------------------------------------------------------------------------

/** Coerce a raw MCP list item to the metadata-only projection callers expect. */
function normalizeListItem(raw: unknown): { id: number; title: string; status: string; date: string; url: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const id = Number(r.id);
  return {
    id: Number.isFinite(id) ? id : 0,
    title: asString(r.title),
    status: asString(r.status) || "unknown",
    date: asString(r.date),
    url: asString(r.url),
  };
}

/** Read a post/page publish status over MCP (cinatra-post-status). Returns the
 * shape the old direct-REST readPostStatus returned. */
async function readPostStatusViaMcp(instance: WordPressMcpInstance, postId: number, postType?: string) {
  const args: Record<string, unknown> = { id: postId };
  if (postType !== undefined) args.postType = postType;
  const raw = (await callWordPressMcp(instance, CINATRA_POST_STATUS_TOOL, args)) as {
    id?: unknown; status?: unknown; link?: unknown;
  };
  const id = Number(raw?.id);
  const resolvedId = Number.isFinite(id) ? id : postId;
  const link = typeof raw?.link === "string" && raw.link.length > 0 ? raw.link : undefined;
  return { id: resolvedId, status: asString(raw?.status) || "unknown", adminUrl: buildAdminUrl(instance.siteUrl, resolvedId), publicUrl: link };
}

/** List published posts (postType:"page" → pages) over MCP (cinatra-posts-list).
 * Returns the metadata-only { items, total } the old list deps returned. */
async function listPublishedViaMcp(
  instance: WordPressMcpInstance,
  options: { offset: number; limit: number; postType?: string },
) {
  const args: Record<string, unknown> = { perPage: options.limit, offset: options.offset };
  if (options.postType !== undefined) args.postType = options.postType;
  const raw = (await callWordPressMcp(instance, CINATRA_POSTS_LIST_TOOL, args)) as {
    items?: unknown; total?: unknown;
  };
  const items = Array.isArray(raw?.items) ? raw.items.map(normalizeListItem) : [];
  const total = Number(raw?.total);
  return { items, total: Number.isFinite(total) ? total : items.length };
}

/** Delete a post/page over MCP (cinatra-post-delete). */
async function deletePostViaMcp(instance: WordPressMcpInstance, postId: number, postType?: string) {
  const args: Record<string, unknown> = { id: postId };
  if (postType !== undefined) args.postType = postType;
  const raw = (await callWordPressMcp(instance, CINATRA_POST_DELETE_TOOL, args)) as {
    deleted?: unknown; previousStatus?: unknown;
  };
  return { deleted: raw?.deleted === true, previousStatus: typeof raw?.previousStatus === "string" ? raw.previousStatus : undefined };
}

/** Sideload an image over MCP (cinatra-media-upload). */
async function uploadMediaViaMcp(
  instance: WordPressMcpInstance,
  input: { imageBase64: string; imageMimeType: string; title: string },
) {
  const raw = (await callWordPressMcp(instance, CINATRA_MEDIA_UPLOAD_TOOL, {
    imageBase64: input.imageBase64,
    imageMimeType: input.imageMimeType,
    title: input.title,
  })) as { mediaId?: unknown; sourceUrl?: unknown };
  const mediaId = Number(raw?.mediaId);
  // Fail fast: a successful upload MUST carry a real attachment id. A missing/
  // invalid id is a bad plugin response — surface it rather than returning a
  // bogus mediaId:0 the caller would treat as a real attachment.
  if (!Number.isInteger(mediaId) || mediaId < 1) {
    throw new Error("WordPress media upload returned no valid attachment id.");
  }
  return { mediaId, sourceUrl: typeof raw?.sourceUrl === "string" ? raw.sourceUrl : undefined };
}

/** Create a new draft over MCP (cinatra-post-create-draft). Returns the shape the
 * old direct-REST createDraft returned ({ wordpressPostId, publicUrl?, adminUrl }). */
async function createDraftViaMcp(
  instance: WordPressMcpInstance,
  input: { title: string; content: string; excerpt: string },
) {
  const raw = (await callWordPressMcp(instance, CINATRA_POST_CREATE_DRAFT_TOOL, {
    title: input.title,
    content: input.content,
    excerpt: input.excerpt,
  })) as { id?: unknown; status?: unknown; link?: unknown };
  const id = Number(raw?.id);
  // Fail fast: a created draft MUST carry a real post id. A missing/invalid id
  // is a bad plugin response — surface it rather than building a bogus
  // wordpressPostId:0 + `post=0` admin URL the caller would treat as a real draft.
  if (!Number.isInteger(id) || id < 1) {
    throw new Error("WordPress draft creation returned no valid post id.");
  }
  const link = typeof raw?.link === "string" && raw.link.length > 0 ? raw.link : undefined;
  return { wordpressPostId: id, publicUrl: link, adminUrl: buildAdminUrl(instance.siteUrl, id) };
}

/** Write post meta over MCP (cinatra-post-update-meta). Returns { id, updated }. */
async function updateMetaViaMcp(instance: WordPressMcpInstance, postId: number, meta: Record<string, unknown>) {
  return callWordPressMcp(instance, CINATRA_POST_UPDATE_META_TOOL, { id: postId, meta });
}

export function createWordPressPrimitiveHandlers() {
  return {
    "wordpress_status": async (_request: ExtensionPrimitiveRequest<unknown>) => {
      return getWordPressDeps().getApiStatus();
    },

    "wordpress_instances_list": async (_request: ExtensionPrimitiveRequest<unknown>) => {
      // Redact credential material at the read boundary.
      return listInstancesSorted().map(toPublicInstance);
    },

    "wordpress_post_create_draft": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = createDraftSchema.parse(request.input);
      const instances = listInstancesSorted();
      const instance = instances.find((i) => i.id === input.instanceId);
      if (!instance) throw new Error("WordPress instance not found.");
      await requireWriteAuthority(input.instanceId, "wordpress_post_create_draft");
      // MCP-only egress (wordpress-plugin#82): create the draft through the
      // plugin's cinatra-post-create-draft tool, never a direct /wp/v2/* POST.
      return createDraftViaMcp(instance, { title: input.title, content: input.content, excerpt: input.excerpt });
    },

    "wordpress_post_status": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = postStatusSchema.parse(request.input);
      const instances = listInstancesSorted();
      const instance = instances.find((i) => i.id === input.instanceId);
      if (!instance) throw new Error("WordPress instance not found.");
      // MCP-only egress (wordpress-plugin#82): read status through the plugin's
      // cinatra-post-status tool. postType:"page" is forwarded to resolve a page.
      return readPostStatusViaMcp(instance, input.postId, input.postType);
    },

    "wordpress_post_delete": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = postStatusSchema.parse(request.input);
      const instances = listInstancesSorted();
      const instance = instances.find((i) => i.id === input.instanceId);
      if (!instance) throw new Error("WordPress instance not found.");
      await requireWriteAuthority(input.instanceId, "wordpress_post_delete");
      // MCP-only egress (wordpress-plugin#82): delete through the plugin's
      // cinatra-post-delete tool. postType:"page" resolves a page.
      await deletePostViaMcp(instance, input.postId, input.postType);
      return { ok: true };
    },

    "wordpress_media_upload": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const { instanceId, ...rest } = uploadMediaSchema.parse(request.input);
      const instances = listInstancesSorted();
      const instance = instances.find((i) => i.id === instanceId);
      if (!instance) throw new Error("WordPress instance not found.");
      await requireWriteAuthority(instanceId, "wordpress_media_upload");
      // MCP-only egress (wordpress-plugin#82): sideload through the plugin's
      // cinatra-media-upload tool, never a direct /wp/v2/media POST.
      return uploadMediaViaMcp(instance, rest);
    },

    "wordpress_posts_list": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const { instanceId, cursor } = postsListSchema.parse(request.input);
      const instances = listInstancesSorted();
      const instance = instances.find((i) => i.id === instanceId);
      if (!instance) throw new Error("WordPress instance not found.");
      const offset = getWordPressDeps().decodeCursor(cursor);
      const limit = 10;
      // MCP-only egress (wordpress-plugin#82): list through the plugin's
      // cinatra-posts-list tool, never a direct /wp/v2/posts GET.
      const { items, total } = await listPublishedViaMcp(instance, { offset, limit });
      return getWordPressDeps().buildListPage(items, total, offset, limit);
    },

    // Page discovery. Mirrors wordpress_posts_list exactly (same cursor
    // pagination + metadata-only projection) but lists pages through the plugin's
    // cinatra-posts-list tool with postType:"page". Lets an external MCP caller
    // find a WordPress page, then read its status or content with
    // wordpress_post_status / wordpress_post_get passing postType: "page" (both
    // proven to support pages), or delete it with wordpress_post_delete. NOT
    // wordpress_post_update — the governed-invoker retarget (cinatra-ai/
    // cinatra#2022) fails closed on postType:"page" for updates specifically
    // (no proven/distinct ewpa update-a-page ability exists yet; see that
    // handler's own comment) — page editing has no supported primitive today.
    "wordpress_pages_list": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const { instanceId, cursor } = postsListSchema.parse(request.input);
      const instances = listInstancesSorted();
      const instance = instances.find((i) => i.id === instanceId);
      if (!instance) throw new Error("WordPress instance not found.");
      const offset = getWordPressDeps().decodeCursor(cursor);
      const limit = 10;
      // MCP-only egress (wordpress-plugin#82): list pages through the plugin's
      // cinatra-posts-list tool with postType:"page", never a direct /wp/v2/pages GET.
      const { items, total } = await listPublishedViaMcp(instance, { offset, limit, postType: "page" });
      return getWordPressDeps().buildListPage(items, total, offset, limit);
    },

    // RENAME-02: forwarding alias — kept so in-flight LLM sessions and
    // stored compiled plans that reference the old name continue to work.
    // Routes to the IDENTICAL handler logic as wordpress_posts_list.
    "wordpress_post_get_latest": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const { instanceId, cursor } = postsListSchema.parse(request.input);
      const instances = listInstancesSorted();
      const instance = instances.find((i) => i.id === instanceId);
      if (!instance) throw new Error("WordPress instance not found.");
      const offset = getWordPressDeps().decodeCursor(cursor);
      const limit = 10;
      // MCP-only egress (wordpress-plugin#82): list through the plugin's
      // cinatra-posts-list tool, never a direct /wp/v2/posts GET.
      const { items, total } = await listPublishedViaMcp(instance, { offset, limit });
      return getWordPressDeps().buildListPage(items, total, offset, limit);
    },

    "wordpress_post_get": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const { instanceId, postId, postType } = postStatusSchema.parse(request.input);
      const instances = listInstancesSorted();
      const instance = instances.find((i) => i.id === instanceId);
      if (!instance) throw new Error("WordPress instance not found.");
      // GOVERNED-INVOKER egress (cinatra-ai/cinatra#2022): read via the
      // community catalog's ewpa/get-post (or ewpa/get-page for
      // postType:"page") ability
      // through the governed connector-instance invoker, never
      // cinatra-content-server and never a direct /wp/v2/* fetch. Fail-closed
      // if the invoker is unbound (see readPostViaMcp's section comment).
      return readPostViaMcp(instance, postId, postType);
    },

    "wordpress_post_update_meta": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const { instanceId, postId, meta } = updateMetaSchema.parse(request.input);
      const instances = listInstancesSorted();
      const instance = instances.find((i) => i.id === instanceId);
      if (!instance) throw new Error("WordPress instance not found.");
      await requireWriteAuthority(instanceId, "wordpress_post_update_meta");
      // Distinguish "no fields supplied" from "all fields stripped".
      // `z.record` allows {} so the schema cannot reject the empty-object
      // case; surface a precise error instead of claiming everything was an
      // empty string.
      if (Object.keys(meta).length === 0) {
        throw new Error("No meta fields provided.");
      }
      // Strip empty-string meta values. An LLM that emits
      // `meta: { _yoast_wpseo_metadesc: "" }` for a meta field it did not
      // intend to clear would otherwise wipe the SEO description. Strict
      // equality on "" only — null/false/0 pass through.
      const safeMeta = Object.fromEntries(
        Object.entries(meta).filter(([, v]) => v !== ""),
      );
      // Guard against all-empty dispatch. null/undefined intentionally NOT
      // filtered — legitimate meta clears.
      if (Object.keys(safeMeta).length === 0) {
        throw new Error("All submitted meta values were empty strings — nothing to update.");
      }
      // MCP-only egress (wordpress-plugin#82): write meta through the plugin's
      // cinatra-post-update-meta tool (which enforces the per-key protected-meta
      // guard host-in-process), never a direct /wp/v2/* meta write.
      return updateMetaViaMcp(instance, postId, safeMeta);
    },

    // Top-level WordPress post update (title/content/excerpt/status) via the
    // governed connector-instance invoker (ewpa/update-post —
    // cinatra-ai/cinatra#2022), never cinatra-content-server and never a
    // direct REST call. This is the primitive the wordpress-content-editor
    // SKILL.md uses for the demote-then-edit pattern (status:draft + edits in
    // one call). Meta-only writes stay on the wordpress_post_update_meta
    // carve-out (the ability does not cover post meta).
    "wordpress_post_update": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = postUpdateSchema.parse(request.input);
      // CodeRabbit-adopted hardening: fail closed on an input `updatePostViaMcp`
      // could never apply BEFORE the review gate below captures anything — same
      // reason the postType checks further down are hoisted pre-gate. Without
      // this, a request that mixes a real field change (e.g. `title`) with
      // `meta`, or that reduces to no editable field, can get captured and HELD
      // for human review, then fail permanently at apply time — stranding an
      // APPROVED-but-inapplicable review and wasting the reviewer's decision.
      // The matching checks stay in `updatePostViaMcp` too as a defensive
      // backstop (it has no other caller today, but the redundancy is cheap).
      if (input.meta !== undefined) {
        throw new Error(
          "wordpress_post_update cannot write post meta over the MCP content server — " +
            "use wordpress_post_update_meta for meta writes.",
        );
      }
      const hasEditableField =
        typeof input.title === "string" ||
        (typeof input.content === "string" && input.content.length > 0) ||
        (typeof input.excerpt === "string" && input.excerpt.length > 0) ||
        typeof input.status === "string";
      if (!hasEditableField) {
        throw new Error("No editable fields to update (title/content/excerpt/status).");
      }
      const instances = listInstancesSorted();
      const instance = instances.find((i) => i.id === input.instanceId);
      if (!instance) throw new Error("WordPress instance not found.");
      // Codex-adopted hardening: refuse an unproven postType BEFORE the
      // review-gate captures anything below — not at apply time, which would
      // strand an APPROVED-but-inapplicable review. Unlike the read side
      // (ewpa/get-page is proven to exist for postType:"page"), there is no
      // captured schema or execution proving ewpa/update-post accepts a page
      // id, and no distinct ewpa/update-page ability exists in the pinned
      // fixture's discovery capture — so "page" is refused here too, not
      // just arbitrary/CPT postType values.
      if (input.postType === "page") {
        throw new Error(
          'wordpress_post_update: postType "page" is not supported by the governed-invoker retarget — ' +
            "ewpa/update-post's behavior against a page id has not been proven (no captured schema or " +
            "execution, and no distinct page-update ability exists in the pinned fixture's discovery " +
            "capture). Refusing to write rather than guess.",
        );
      }
      if (input.postType !== undefined && input.postType !== "post") {
        throw new Error(
          `wordpress_post_update: postType "${input.postType}" is not supported by the governed-invoker ` +
            "retarget. Custom post types need their own ewpa/get-cpt-item-based primitive, not this one.",
        );
      }
      // cinatra#409 — per-user / per-instance write authorization (fail-closed).
      // Transport-independent: it gates BEFORE any write reaches WordPress.
      await requireWriteAuthority(input.instanceId, "wordpress_post_update");

      // cinatra#2043 S5 — review-before-publish TRIGGER at the staged content-write
      // seam. When the host review fence is ON, the PROPOSED content is captured as
      // an immutable review target and the effect is HELD before it can reach
      // WordPress; only an approved gate releases the apply. FENCE-OFF / no seam
      // bound → `{action:"pass"}` with no capture and no extra fetch, so the write
      // below is byte-identical to pre-S5. Meta-only writes are NOT content review
      // targets (the ability does not cover meta) — a write that carries `meta`
      // still routes through the trigger for its title/content/excerpt/status
      // fields, and `updatePostViaMcp` fail-closes on meta anyway.
      //
      // NOT YET migrated onto cinatra core's generic content-review hook slot
      // (`connector-instance-invoker.ts`'s `contentReviewHook`, cinatra-ai/
      // cinatra#2215). That migration requires BINDING a WordPress hook
      // implementation into `buildConnectorInstanceInvokerDeps` (cinatra
      // core, `register-host-connector-services.ts` — the exact spot
      // `destructiveHook` is bound today), which is cinatra-core work no
      // wordpress-mcp-connector-only change can reach (connector packages
      // carry no `@/lib/*` host import edge — the whole reason this deps-DI
      // slot exists). Disclosed gap, not silently dropped — see this PR's
      // body. This inline wiring stays the ENFORCEMENT POINT until that
      // companion cinatra-core change ships and is verified; the review gate
      // is unchanged and fully active, exactly as before.
      const review = await evaluateStagedContentWrite({
        seam: getWordPressDeps().cmsReview,
        connectorId: WORDPRESS_CONNECTOR_ID,
        instanceId: input.instanceId,
        postId: input.postId,
        postType: input.postType,
        proposed: {
          title: input.title,
          content: input.content,
          excerpt: input.excerpt,
          status: input.status,
        },
        fetchCurrent: async (): Promise<CmsCurrentContent> => {
          const cur = await readPostViaMcp(instance, input.postId, input.postType);
          return {
            title: cur.title,
            content: cur.content,
            excerpt: cur.excerpt,
            status: cur.status,
            adminUrl: cur.adminUrl,
            ...(cur.link !== undefined ? { link: cur.link } : {}),
          };
        },
      });

      // HELD: the effect is held pending review — the write does NOT reach
      // WordPress. Return the pending-review descriptor to the caller (the agent
      // learns the edit is staged, not published).
      if (review.action === "hold") return review.pending;
      // REJECTED: a tombstoned effect never writes.
      if (review.action === "reject") {
        throw new Error(`wordpress_post_update: ${review.reason}`);
      }

      // PASS (fence off / org-ungated / nothing to review) or APPLY (an approved
      // gate released the effect). Either way the write proceeds. GOVERNED-
      // INVOKER egress (cinatra-ai/cinatra#2022): update via ewpa/update-post,
      // never cinatra-content-server and never a direct /wp/v2/* fetch. The
      // demote-then-edit gate (status:"draft") is preserved by forwarding the
      // status field.
      const applied = await updatePostViaMcp({
        instance,
        postId: input.postId,
        postType: input.postType,
        fields: {
          title:   input.title,
          content: input.content,
          excerpt: input.excerpt,
          status:  input.status,
          meta:    input.meta,
        },
      });

      // APPLY: record the post-apply read-back verification against the STORED
      // scope manifest (verified / drifted / unmet). Bound only on the
      // approved-release path — the fence-off pass path returns `applied`
      // byte-identically below.
      if (review.action === "apply") {
        const seam = getWordPressDeps().cmsReview;
        // `applied` IS the post-apply re-read the read-back verifier needs —
        // NOT the write response's own echo (updatePostViaMcp independently
        // re-reads via readPostViaMcp internally rather than trusting
        // ewpa/update-post's echo, which carries no content field at all; see
        // its doc comment). Re-reading the persisted remote state (never the
        // request that was sent) is what lets the read-back verifier catch an
        // out-of-scope rewrite as `drifted` (a codex convergence finding) —
        // that property holds for `applied` exactly as it would for a SECOND
        // independent read, so reusing it here (codex-adopted simplification)
        // drops a redundant WordPress round-trip without weakening the check.
        const readback = seam
          ? await seam.recordApplyVerification({
              operationId: review.operationId,
              gateId: review.gate.gateId,
              runId: review.gate.runId,
              postApplyFields: {
                title: applied.title,
                content: applied.content,
                excerpt: applied.excerpt,
                status: applied.status,
              },
            })
          : { ok: false, code: "seam-unbound" as const };
        return { ...applied, review: { operationId: review.operationId, ...readback } };
      }

      return applied;
    },

    // cinatra#2017 S2 — governed connector-instance invoker (Plane C). Thin:
    // schema-parse then forward the NON-IDENTITY coordinates to the host invoker
    // capability via the deps slot. connectorKey/kind are NOT connector-facing
    // (host-derived from the verified packageName, M6); the actor is host-derived
    // from the MCP request frame (§2.4) — the synthetic request.actor literal is
    // never read here for any decision. Ship-dark: no live model surface reaches
    // these in S2 (delegated deny-by-default + no agent-run allowlist).
    "wordpress_site_tool_call": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = siteToolCallSchema.parse(request.input);
      // FAIL-CLOSED: the invoker is host-bound (register.ts resolves the capability
      // fail-loud). If the deps slot is skewed/partial and the member is unbound,
      // DENY descriptively rather than crash — never reach WordPress off-channel.
      const invoke = getWordPressDeps().invokeSiteTool;
      if (typeof invoke !== "function") {
        throw new Error(
          "wordpress_site_tool_call denied: the governed connector-instance invoker is unavailable " +
            "(host @cinatra-ai/host:connector-instance-invoker unbound). Refusing to call without the governed channel.",
        );
      }
      // Forward args UNMODIFIED (§3.7); omit absent optionals rather than send an
      // explicit `undefined` over the capability boundary. NO connectorKey/kind
      // (host-derived, M6) and NO actor (host-derived from the MCP frame, §2.4).
      return invoke({
        toolName: input.toolName,
        args: input.args,
        ...(input.instanceId !== undefined ? { instanceId: input.instanceId } : {}),
        ...(input.serverId !== undefined ? { serverId: input.serverId } : {}),
      });
    },

    "wordpress_site_tools_list": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = siteToolsListSchema.parse(request.input);
      // FAIL-CLOSED (same posture as wordpress_site_tool_call).
      const list = getWordPressDeps().listSiteTools;
      if (typeof list !== "function") {
        throw new Error(
          "wordpress_site_tools_list denied: the governed connector-instance invoker is unavailable " +
            "(host @cinatra-ai/host:connector-instance-invoker unbound). Refusing to list without the governed channel.",
        );
      }
      // The host governed list surface runs the pin + live per-instance USE
      // authority gate BEFORE any catalog read (B2) — an unauthorized list is a
      // typed error, never a catalog.
      return list({
        ...(input.instanceId !== undefined ? { instanceId: input.instanceId } : {}),
        ...(input.serverId !== undefined ? { serverId: input.serverId } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      });
    },

    // Blocking A2A dispatch to wayflow-wordpress-content-editor.
    //
    // The A2A client, the bearer-token mint, and the `task.history` walk live
    // HOST-SIDE behind `getWordPressDeps().dispatchContentEditor` (the host owns
    // `@cinatra-ai/a2a` + `@cinatra-ai/llm`). The connector never sees an A2A
    // `Task`: the host returns the raw last-agent text reply. This connector
    // keeps the code-fence-strip + JSON.parse (the demote-then-edit output is
    // JSON the LLM occasionally wraps in ```json fences). timeoutMs: 300_000
    // aligns with the Cinatra /chat blocking budget.
    "wordpress_content_editor_run": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = contentEditorRunSchema.parse(request.input);
      const deps = getWordPressDeps();

      // S5 delegated-widget OBO reconstruction (cinatra S5-W1). When the turn is
      // driven by a trusted `public_site_widget` delegated actor, the downstream
      // CMS write must authorize AS THE END USER against the SERVER-PINNED
      // instance. Read the actor context the host derives from the MCP request
      // frame (NEVER from tool input); `null` on the normal (non-widget) agent
      // path, where the dispatch stays byte-identical to today. On the widget
      // path `buildWidgetActorOverride` fail-closes on a missing pin field and
      // asserts the tool-arg instance pin (G3) before the override is built.
      const widgetActor = deps.resolveWidgetActor?.() ?? null;
      const actorOverride: WidgetActorOverride | undefined = widgetActor
        ? buildWidgetActorOverride(widgetActor, input.instanceId, "wordpress_content_editor_run")
        : undefined;

      // Boundary rule (cinatra#978): connector code never reads process.env.
      // The optional per-deployment URL override arrives through the
      // host-bound `resolveContentEditorAgentUrl` dep (`settings` host port,
      // key "content_editor_a2a_url"); absent, unbound, or unset resolves the
      // static default route.
      const agentUrl =
        (await deps.resolveContentEditorAgentUrl?.()) ??
        "http://localhost:3010/agents/cinatra-ai/wordpress-agent";

      const text = await deps.dispatchContentEditor({
        agentUrl,
        payload: input,
        timeoutMs: 300_000, // aligned with /chat blocking budget
        // cinatra#246: lets the host resolve the agent template + pre-create the
        // OBO agent_run so the CMS write authorizes via the production agent-run
        // OBO path (not the dev-admin bypass).
        packageName: "@cinatra-ai/wordpress-agent",
        // S5: present ONLY on the public_site_widget path (undefined omits the
        // key entirely, so the non-widget dispatch is byte-identical to today).
        ...(actorOverride ? { actorOverride } : {}),
      });

      // Strip code fences before JSON.parse.
      try {
        return JSON.parse(stripCodeFences(text));
      } catch {
        return { result: text };
      }
    },
  } as const;
}
