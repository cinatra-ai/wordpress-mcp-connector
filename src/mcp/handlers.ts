import { z } from "zod";
import type { ExtensionPrimitiveRequest } from "@cinatra-ai/sdk-extensions";
// Every host surface arrives through the host-bound deps slot (cinatra#172
// Stage H3): instance/status reads from the extended
// `@cinatra-ai/host:wordpress-mcp` service, the post/media CRUD from the NEW
// `@cinatra-ai/host:wordpress-content` service, pagination from
// `@cinatra-ai/host:mcp-pagination` — no `@/lib/wordpress-api` import.
import {
  getWordPressDeps,
  listInstancesSorted,
  type WordPressMcpInstance,
  type WordPressMcpPublicInstance,
} from "../deps";

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
  postId: z.number().int(),
  postType: z.string().optional(),
});

export const uploadMediaSchema = z.object({
  instanceId: z.string().min(1),
  imageBase64: z.string(),
  imageMimeType: z.string(),
  title: z.string(),
});

export const updateMetaSchema = z.object({
  instanceId: z.string().min(1),
  postId: z.number().int(),
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
    postType:   z.string().optional().describe("Post type slug — 'page' uses /wp/v2/pages/{id} instead of /posts/{id}"),
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
      return getWordPressDeps().readPostStatus({ instance, wordpressPostId: input.postId });
    },

    "wordpress_post_delete": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = postStatusSchema.parse(request.input);
      const instances = listInstancesSorted();
      const instance = instances.find((i) => i.id === input.instanceId);
      if (!instance) throw new Error("WordPress instance not found.");
      await requireWriteAuthority(input.instanceId, "wordpress_post_delete");
      await getWordPressDeps().deletePost({ instance, wordpressPostId: input.postId });
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
      return getWordPressDeps().readPost({ instance, wordpressPostId: postId, postType });
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

    // Top-level WordPress post update.
    // Sends title/content/excerpt/status/meta to /wp/v2/posts/{id}. This is
    // the primitive the wordpress-content-editor SKILL.md uses for the
    // demote-then-edit pattern (status:draft + edits in one call). The
    // existing wordpress_post_update_meta is preserved for meta-only writes.
    "wordpress_post_update": async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = postUpdateSchema.parse(request.input);
      const instances = listInstancesSorted();
      const instance = instances.find((i) => i.id === input.instanceId);
      if (!instance) throw new Error("WordPress instance not found.");
      await requireWriteAuthority(input.instanceId, "wordpress_post_update");
      return getWordPressDeps().updatePost({
        instance,
        wordpressPostId: input.postId,
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
