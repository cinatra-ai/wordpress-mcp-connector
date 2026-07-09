import { z } from "zod";
import type { ExtensionPrimitiveRequest } from "@cinatra-ai/sdk-extensions";
// Every host surface arrives through the host-bound deps slot (cinatra#172
// Stage H3): instance/status reads from the extended
// `@cinatra-ai/host:wordpress-mcp` service, the carve-out post/media CRUD from
// the `@cinatra-ai/host:wordpress-content` service, pagination from
// `@cinatra-ai/host:mcp-pagination` — no `@/lib/wordpress-api` import.
//
// EXCEPT the two in-admin editing primitives: `wordpress_post_get` /
// `wordpress_post_update` reach WordPress content ONLY through the site's MCP
// integration (`callWordPressMcp` → the plugin's `cinatra-post-get` /
// `cinatra-post-update` tools), never a direct `/wp/v2/*` REST call
// (cinatra#1214 S1). The old `readPost`/`updatePost` direct-REST deps are gone.
import {
  getWordPressDeps,
  listInstancesSorted,
  type WordPressMcpInstance,
  type WordPressMcpPublicInstance,
} from "../deps";
import {
  callWordPressMcp,
  CINATRA_POST_GET_TOOL,
  CINATRA_POST_UPDATE_TOOL,
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
// In-admin MCP-primary content read/update (cinatra#1214 S1).
//
// The in-admin assistant reaches WordPress content ONLY through the site's MCP
// integration: `wordpress_post_get` / `wordpress_post_update` route through
// `callWordPressMcp` to the plugin-owned `cinatra-post-get` /
// `cinatra-post-update` tools (cinatra-ai/wordpress-plugin #81), NEVER a direct
// `/wp/v2/*` REST call. `callWordPressMcp` detects the tools at runtime and
// throws fail-closed when the plugin is missing/too old — it never degrades to
// direct REST. The per-user #409 write-authority gate stays in the handler
// (transport-independent).
// ---------------------------------------------------------------------------

/** WordPress admin edit URL for a post/page id (the old REST client's shape). */
function buildAdminUrl(siteUrl: string, postId: number): string {
  return `${siteUrl.replace(/\/+$/, "")}/wp-admin/post.php?post=${postId}&action=edit`;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The `cinatra-post-get` / `cinatra-post-update` ability payload shape. */
type CinatraPostPayload = {
  id?: unknown;
  status?: unknown;
  title?: unknown;
  content?: unknown;
  excerpt?: unknown;
  slug?: unknown;
  link?: unknown;
};

/** Read a post for editing over MCP. Returns the same field shape the old
 * direct-REST `readWordPressPost` returned (the before-values the
 * content-editor agent's field-diff reads), with `adminUrl` built
 * connector-side. `postType:"page"` is forwarded so the plugin resolves a page. */
async function readPostViaMcp(
  instance: WordPressMcpInstance,
  postId: number,
  postType?: string,
) {
  const args: Record<string, unknown> = { id: postId };
  if (postType !== undefined) args.postType = postType;
  const raw = (await callWordPressMcp(instance, CINATRA_POST_GET_TOOL, args)) as CinatraPostPayload;
  const id = Number(raw?.id);
  const resolvedId = Number.isFinite(id) ? id : postId;
  return {
    id: resolvedId,
    status: asString(raw?.status) || "unknown",
    title: asString(raw?.title),
    content: asString(raw?.content),
    excerpt: asString(raw?.excerpt),
    slug: typeof raw?.slug === "string" ? raw.slug : undefined,
    link: typeof raw?.link === "string" ? raw.link : undefined,
    adminUrl: buildAdminUrl(instance.siteUrl, resolvedId),
  };
}

/** Update a post over MCP (title/content/excerpt/status; demote-then-edit via
 * status:"draft"). Returns the same field shape the old direct-REST
 * `updateWordPressPost` returned. */
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
  // The plugin's `cinatra-post-update` ability (the ratified MCP surface, #81)
  // covers title/content/excerpt/status only — NOT `meta`. Rather than silently
  // drop a requested change, fail closed and route the caller to the dedicated
  // meta primitive (`wordpress_post_update_meta` stays on its REST carve-out per
  // the #1214 design §C — meta over MCP would need a plugin ability that #81
  // does not register).
  if (input.fields.meta !== undefined) {
    throw new Error(
      "wordpress_post_update cannot write post meta over the MCP content server — " +
        "use wordpress_post_update_meta for meta writes.",
    );
  }

  // Build the tool args: strip undefined; drop empty-string content/excerpt
  // (WordPress applies them literally and would wipe the body). Only literal
  // "" is dropped so a legitimate title clear still works.
  const args: Record<string, unknown> = { id: input.postId };
  if (input.postType !== undefined) args.postType = input.postType;
  if (typeof input.fields.title === "string") args.title = input.fields.title;
  if (typeof input.fields.content === "string" && input.fields.content.length > 0) args.content = input.fields.content;
  if (typeof input.fields.excerpt === "string" && input.fields.excerpt.length > 0) args.excerpt = input.fields.excerpt;
  if (typeof input.fields.status === "string") args.status = input.fields.status;

  // Guard against dispatching an update with no editable field left after
  // stripping (the ability rejects it 400 anyway; surface it precisely).
  const editableKeys = Object.keys(args).filter((k) => k !== "id" && k !== "postType");
  if (editableKeys.length === 0) {
    throw new Error("No editable fields to update (title/content/excerpt/status).");
  }

  const raw = (await callWordPressMcp(input.instance, CINATRA_POST_UPDATE_TOOL, args)) as CinatraPostPayload;
  const id = Number(raw?.id);
  const resolvedId = Number.isFinite(id) ? id : input.postId;
  return {
    id: resolvedId,
    status: asString(raw?.status) || "unknown",
    title: asString(raw?.title),
    content: asString(raw?.content),
    excerpt: asString(raw?.excerpt),
    adminUrl: buildAdminUrl(input.instance.siteUrl, resolvedId),
  };
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
      return getWordPressDeps().createDraft({
        instance,
        payload: { title: input.title, content: input.content, excerpt: input.excerpt, status: "draft" },
      });
    },

    "wordpress_post_status": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = postStatusSchema.parse(request.input);
      const instances = listInstancesSorted();
      const instance = instances.find((i) => i.id === input.instanceId);
      if (!instance) throw new Error("WordPress instance not found.");
      // postType: "page" routes the status read to /wp/v2/pages/{id}.
      return getWordPressDeps().readPostStatus({ instance, wordpressPostId: input.postId, postType: input.postType });
    },

    "wordpress_post_delete": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = postStatusSchema.parse(request.input);
      const instances = listInstancesSorted();
      const instance = instances.find((i) => i.id === input.instanceId);
      if (!instance) throw new Error("WordPress instance not found.");
      await requireWriteAuthority(input.instanceId, "wordpress_post_delete");
      // postType: "page" routes the delete to /wp/v2/pages/{id}.
      await getWordPressDeps().deletePost({ instance, wordpressPostId: input.postId, postType: input.postType });
      return { ok: true };
    },

    "wordpress_media_upload": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const { instanceId, ...rest } = uploadMediaSchema.parse(request.input);
      const instances = listInstancesSorted();
      const instance = instances.find((i) => i.id === instanceId);
      if (!instance) throw new Error("WordPress instance not found.");
      await requireWriteAuthority(instanceId, "wordpress_media_upload");
      return getWordPressDeps().uploadMedia({ instance, ...rest });
    },

    "wordpress_posts_list": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const { instanceId, cursor } = postsListSchema.parse(request.input);
      const instances = listInstancesSorted();
      const instance = instances.find((i) => i.id === instanceId);
      if (!instance) throw new Error("WordPress instance not found.");
      const offset = getWordPressDeps().decodeCursor(cursor);
      const limit = 10;
      const { items, total } = await getWordPressDeps().listPublishedPosts(instance, { offset, limit });
      return getWordPressDeps().buildListPage(items, total, offset, limit);
    },

    // Page discovery. Mirrors wordpress_posts_list exactly (same cursor
    // pagination + metadata-only projection) but routes to /wp/v2/pages via the
    // host-bound listPublishedPages dep. Lets an external MCP caller find a
    // WordPress page, then read or update it with wordpress_post_get /
    // wordpress_post_update passing postType: "page".
    "wordpress_pages_list": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const { instanceId, cursor } = postsListSchema.parse(request.input);
      const instances = listInstancesSorted();
      const instance = instances.find((i) => i.id === instanceId);
      if (!instance) throw new Error("WordPress instance not found.");
      const offset = getWordPressDeps().decodeCursor(cursor);
      const limit = 10;
      const { items, total } = await getWordPressDeps().listPublishedPages(instance, { offset, limit });
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
      const { items, total } = await getWordPressDeps().listPublishedPosts(instance, { offset, limit });
      return getWordPressDeps().buildListPage(items, total, offset, limit);
    },

    "wordpress_post_get": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const { instanceId, postId, postType } = postStatusSchema.parse(request.input);
      const instances = listInstancesSorted();
      const instance = instances.find((i) => i.id === instanceId);
      if (!instance) throw new Error("WordPress instance not found.");
      // MCP-only egress (cinatra#1214 S1): read over the plugin's content MCP
      // server (cinatra-post-get), never a direct /wp/v2/* fetch. Fail-closed
      // if the tool is absent (plugin missing/too old).
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
      return getWordPressDeps().updateDraftMeta({ instance, wordpressPostId: postId, meta: safeMeta });
    },

    // Top-level WordPress post update (title/content/excerpt/status) over the
    // site's MCP content server (cinatra-post-update), never a direct REST call
    // (cinatra#1214 S1). This is the primitive the wordpress-content-editor
    // SKILL.md uses for the demote-then-edit pattern (status:draft + edits in
    // one call). Meta-only writes stay on the wordpress_post_update_meta
    // carve-out (the MCP ability does not cover post meta).
    "wordpress_post_update": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = postUpdateSchema.parse(request.input);
      const instances = listInstancesSorted();
      const instance = instances.find((i) => i.id === input.instanceId);
      if (!instance) throw new Error("WordPress instance not found.");
      // cinatra#409 — per-user / per-instance write authorization (fail-closed).
      // Transport-independent: it gates BEFORE any write reaches WordPress.
      await requireWriteAuthority(input.instanceId, "wordpress_post_update");
      // MCP-only egress (cinatra#1214 S1): update over the plugin's content MCP
      // server (cinatra-post-update), never a direct /wp/v2/* fetch. The
      // demote-then-edit gate (status:"draft") is preserved by forwarding the
      // status field; the plugin applies it and WordPress auto-revisions.
      return updatePostViaMcp({
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

      // Boundary rule (cinatra#978): connector code never reads process.env.
      // The optional per-deployment URL override arrives through the
      // host-bound `resolveContentEditorAgentUrl` dep (`settings` host port,
      // key "content_editor_a2a_url"); absent, unbound, or unset resolves the
      // static default route.
      const agentUrl =
        (await getWordPressDeps().resolveContentEditorAgentUrl?.()) ??
        "http://localhost:3010/agents/cinatra-ai/wordpress-agent";

      const text = await getWordPressDeps().dispatchContentEditor({
        agentUrl,
        payload: input,
        timeoutMs: 300_000, // aligned with /chat blocking budget
        // cinatra#246: lets the host resolve the agent template + pre-create the
        // OBO agent_run so the CMS write authorizes via the production agent-run
        // OBO path (not the dev-admin bypass).
        packageName: "@cinatra-ai/wordpress-agent",
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
