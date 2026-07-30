import { z } from "zod";
import type { ExtensionPrimitiveRequest } from "@cinatra-ai/sdk-extensions";
// cinatra-ai/cinatra#2022 S7 (PR-θ): the 12 old wordpress_* facade tools that
// used to live here (wordpress_status, _instances_list, _post_create_draft,
// _post_status, _post_delete, _media_upload, _posts_list, _pages_list,
// _post_get_latest, _post_get, _post_update_meta, _post_update) are DELETED.
// They were thin wrappers around either the plugin's own
// `cinatra-content-server` (`callWordPressMcp`, `../lib/wordpress-mcp-client`,
// now also deleted) or — for the two in-admin editing tools this design
// called `wordpress_post_get`/`wordpress_post_update` — the governed
// connector-instance invoker under the same transitional names during PR-τ's
// soak window. Every caller now reaches a connected site's own MCP catalog
// directly through the two generic, already-governed primitives below
// (`wordpress_site_tool_call` / `wordpress_site_tools_list`), which have been
// registered — dark until S7's perimeter cutover — since S2.
//
// SURVIVING SUPPORT CODE, not dead weight: `wordpress_post_update`'s own
// inline cinatra#2043 review-before-publish trigger (`evaluateStagedContentWrite`)
// was RELOCATED, before this deletion, onto the generic path itself — see the
// "Ability-name-keyed content-review trigger" section below. `readPostViaMcp`
// (current-content fetch + post-apply read-back) and its supporting helpers
// are kept for exactly that reason: they no longer back a dedicated tool,
// they back the relocated trigger `wordpress_site_tool_call` now runs inline
// for `ewpa/update-post` (cinatra-ai/cinatra#2022, wmc#100).
import {
  getWordPressDeps,
  listInstancesSorted,
  type WordPressConnectorDeps,
  type WordPressMcpInstance,
} from "../deps";
import {
  evaluateStagedContentWrite,
  type CmsCurrentContent,
} from "../integration/cms-review-trigger";
import { WORDPRESS_CONNECTOR_ID } from "../integration/pointer-writer-core";

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

// ---------------------------------------------------------------------------
// Governed connector-instance invoker primitives (cinatra#2017 S2, gateway).
//
// `wordpress_site_tool_call` / `wordpress_site_tools_list` are the model-visible,
// connector-owned entry points to the governed invoker (Plane C): they schema-
// parse, then call the host invoker capability through the deps slot. They carry
// NO `connectorKey` and NO `kind` (host-derived from the verified `packageName`,
// M6) and pass NO actor (host-derived from the MCP request frame, §2.4).
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

// ---------------------------------------------------------------------------
// Current-content read via the governed invoker (cinatra-ai/cinatra#2022).
//
// This used to back the dedicated `wordpress_post_get`/`wordpress_post_update`
// tools (deleted by PR-θ, once their inline review-before-publish trigger was
// relocated onto the generic path — see the section below). It survives
// θ's deletion because the RELOCATED trigger still needs it: the same
// current-content fetch + post-apply read-back `wordpress_post_update` used
// to perform is now performed by `wordpress_site_tool_call`'s own
// ability-keyed branch.
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
 * `cinatra-post-get`-backed version) returned. Reused by the relocated
 * content-review trigger below for both its current-content fetch and its
 * post-apply read-back — the same helper the (now-deleted) dedicated
 * `wordpress_post_get` tool used. `postType:"page"` dispatches to
 * `ewpa/get-page` instead of `ewpa/get-post` (the pinned fixture's discovery
 * capture registers them as distinct abilities; see the section comment
 * above). */
async function readPostViaMcp(
  instance: WordPressMcpInstance,
  postId: number,
  postType?: string,
) {
  assertSupportedReadPostType(postType, "wordpress_site_tool_call");
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

// ---------------------------------------------------------------------------
// Ability-name-keyed content-review trigger for the GENERIC invoker path
// (cinatra-ai/cinatra#2022).
//
// `wordpress_post_update`'s handler used to be the ONLY place in this
// connector that called `evaluateStagedContentWrite` — the review-before-
// publish TRIGGER that holds a staged content write fail-closed until a
// human approves it. The GENERIC forwarding primitive, `wordpress_site_tool_call`,
// was a bare pass-through with NO review-triggering logic of any kind: a
// caller reaching the SAME mutating ability (`ewpa/update-post`) directly
// through the generic path bypassed the gate entirely. wmc#100 relocated the
// trigger call here, keyed on ability name, BEFORE `wordpress_post_update`
// (and the other 11 dead facade tools) were deleted by this same PR-θ — so
// the guarantee this trigger provides is never dropped even for one commit.
//
// An earlier plan considered registering this trigger against a NEW hook
// slot in cinatra core's governed invoker (`connector-instance-invoker.ts`'s
// `contentReviewHook`) — that slot shipped (cinatra#2215) but is bound
// HOST-SIDE, once, for the WHOLE invoker; there is no connector-facing
// registration mechanism to attach WordPress's business logic to without
// cinatra core importing this connector's own composition — exactly the
// per-ability hardcoding this epic exists to remove. The fix here instead:
// relocate the SAME trigger call into THIS handler, keyed on ability name —
// no invoker hook, no new cinatra-core plumbing, no new capability.
// `cmsReview` and `invokeSiteTool` are already members of the SAME `deps`
// object this file already reads.
//
// SCOPE — only `ewpa/update-post` is keyed here, the exact ability
// `wordpress_post_update`'s own gate used to protect — a 1:1 relocation of
// an existing guarantee, not a widening. `ewpa/create-post` (or any future
// WordPress write ability) is a real, DISCLOSED completeness question left
// OPEN by this change, not silently decided: `evaluateStagedContentWrite`'s
// mechanics (fetch an EXISTING resource, diff the proposal against it) do
// not extend to a CREATE with no prior state, and widening the keyed set is
// a separate design decision this change does not make — flagged as a
// review focus, not assumed closed.
// ---------------------------------------------------------------------------

export const CONTENT_REVIEW_TARGET_ABILITIES: ReadonlySet<string> = new Set([EWPA_UPDATE_POST_ABILITY]);

/**
 * The relocated review-before-publish trigger for the generic invoker path —
 * the SAME `evaluateStagedContentWrite` call the (now-deleted) dedicated
 * `wordpress_post_update` tool used to make, reusing the SAME `readPostViaMcp`
 * helper for the current-content fetch and the post-apply read-back, now
 * keyed generically off the ability name reaching `wordpress_site_tool_call`
 * directly (rather than off a dedicated tool's own schema-parsed fields).
 *
 * ORDER: runs BEFORE the mutating ability is forwarded. On `hold`/`reject`
 * the mutating `invoke()` call for `ewpa/update-post` is NEVER made — the
 * write does not reach WordPress. On `pass`/`apply` the SAME raw `input.args`
 * are forwarded UNMODIFIED (§3.7) to `invoke()`, exactly as the generic
 * primitive already does for every other ability; only on `apply` is the
 * post-apply read-back additionally recorded.
 *
 * FAIL-CLOSED ON instanceId: the dedicated tool's own schema used to require
 * `instanceId` unconditionally (fence on or off) — this branch mirrors that
 * SAME unconditional requirement for parity, even though the generic schema
 * otherwise allows an absent instanceId for a session pinned to a single
 * site. This connector has no way to resolve WHICH instance that is;
 * refusing, rather than guessing or silently skipping review, keeps the
 * no-silent-publish guarantee intact for this ability.
 */
async function callReviewGatedSiteTool(
  invoke: NonNullable<WordPressConnectorDeps["invokeSiteTool"]>,
  input: { toolName: string; args: Record<string, unknown>; instanceId?: string; serverId?: string },
): Promise<unknown> {
  const instanceId = input.instanceId;
  if (!instanceId) {
    throw new Error(
      `wordpress_site_tool_call: "${input.toolName}" is a content-review-gated write and requires an ` +
        "explicit instanceId — refusing without one rather than staging an unattributable review.",
    );
  }
  const instance = listInstancesSorted().find((i) => i.id === instanceId);
  if (!instance) throw new Error("WordPress instance not found.");

  const args = input.args;
  const rawPostId = args.post_id;
  const postId = typeof rawPostId === "number" ? rawPostId : Number(rawPostId);
  // Integer-strict (CodeRabbit-adopted hardening): mirrors the dedicated
  // tool's own `z.coerce.number().int().positive()` exactly. A bare
  // `Number(...)` finite/positive check let a decimal string ("42.5")
  // through as a fractional "post_id" — Number.isInteger rejects it the same
  // way `.int()` does (both still accept exponential-but-integral input
  // like "1e2" -> 100, matching the dedicated tool's own coercion behavior —
  // parity, not a new restriction).
  if (!Number.isInteger(postId) || postId <= 0) {
    throw new Error(`wordpress_site_tool_call: "${input.toolName}" requires a positive integer "post_id" argument.`);
  }

  // Mirror the dedicated tool's own pre-gate hardening exactly: meta is not
  // covered by this ability, and a request with no editable field would
  // strand an APPROVED-but-inapplicable review at apply time. Fail BEFORE
  // any capture, not after. `wordpress_post_update_meta` no longer exists
  // (cinatra-ai/cinatra#2022 S7, PR-θ) — meta writes are NOT unsupported,
  // they simply live on a different ability than this review-gated one:
  // the site's own catalog exposes `ewpa/update-post-meta` separately from
  // `ewpa/update-post` (evidenced by the pinned-fixture S1 VERIFY capture,
  // see `callEwpaAbility`'s doc comment above), so a caller reaches it by
  // invoking `wordpress_site_tool_call` again with that `toolName` directly
  // (list via `wordpress_site_tools_list` first) — not by folding `meta`
  // into this ability's reviewed title/content/excerpt/status payload.
  if (args.meta !== undefined) {
    throw new Error(
      `wordpress_site_tool_call: "${input.toolName}" cannot write post meta through the governed connector-instance ` +
        'invoker — call wordpress_site_tool_call again with toolName "ewpa/update-post-meta" (list the catalog via ' +
        "wordpress_site_tools_list first) for meta writes.",
    );
  }

  // Reject unreviewed fields fail-closed (CodeRabbit-adopted hardening).
  // `evaluateStagedContentWrite` below only ever diffs/reviews
  // title/content/excerpt/status — those are the ONLY fields this trigger
  // captures for review. Forwarding `input.args` raw on the pass/apply path
  // below (§3.7) would let an out-of-scope field (slug, author, date,
  // categories, ...) ride alongside an unchanged title on a no-gate `pass`
  // verdict and write completely unreviewed. Mirrors the dedicated tool's
  // OWN accepted-field surface exactly (title/content/excerpt/status via its
  // schema; meta explicitly refused above, never silently stripped) — refuse
  // BEFORE any capture, not after.
  const REVIEWED_ARG_KEYS = new Set(["post_id", "title", "content", "excerpt", "status"]);
  const outOfScopeKeys = Object.keys(args).filter((k) => !REVIEWED_ARG_KEYS.has(k));
  if (outOfScopeKeys.length > 0) {
    throw new Error(
      `wordpress_site_tool_call: "${input.toolName}" received field(s) outside the content-review scope ` +
        `(${outOfScopeKeys.join(", ")}) — only post_id/title/content/excerpt/status are reviewed for this ability.`,
    );
  }

  const title = typeof args.title === "string" ? args.title : undefined;
  const content = typeof args.content === "string" ? args.content : undefined;
  const excerpt = typeof args.excerpt === "string" ? args.excerpt : undefined;
  const status = typeof args.status === "string" ? args.status : undefined;
  const hasEditableField =
    typeof title === "string" ||
    (typeof content === "string" && content.length > 0) ||
    (typeof excerpt === "string" && excerpt.length > 0) ||
    typeof status === "string";
  if (!hasEditableField) {
    throw new Error(`wordpress_site_tool_call: "${input.toolName}" has no editable fields (title/content/excerpt/status).`);
  }

  // cinatra#409 — per-user / per-instance write-authority gate. Mirrors the
  // dedicated tool's OWN ordering exactly: after all pre-gate validation
  // above, BEFORE the review capture/write below. This ability reaches the
  // SAME governed invoker channel the dedicated tool used
  // (getWordPressDeps().invokeSiteTool) — but the invoker's own host-side
  // authz is a separate concern from THIS connector's audited,
  // primitiveName-keyed write-authority record (see deps.ts's
  // requireInstanceWriteAuthority doc: "the write primitive name, for the
  // audit row only"). Parity with the dedicated tool requires this explicit
  // gate too, not just the shared channel.
  await requireWriteAuthority(instanceId, "wordpress_site_tool_call");

  // No page-specific update ability exists (see readPostViaMcp's own section
  // comment above) — `ewpa/update-post`'s own wire shape carries no postType
  // at all (it keys purely off post_id), so the current-content fetch and
  // post-apply read-back below always target the post-shaped read ability.
  const review = await evaluateStagedContentWrite({
    seam: getWordPressDeps().cmsReview,
    connectorId: WORDPRESS_CONNECTOR_ID,
    instanceId,
    postId,
    postType: undefined,
    proposed: { title, content, excerpt, status },
    fetchCurrent: async (): Promise<CmsCurrentContent> => {
      const cur = await readPostViaMcp(instance, postId, undefined);
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

  // HELD: the effect is held pending review — the mutating invoke() call is
  // NEVER made. The write does not reach WordPress.
  if (review.action === "hold") return review.pending;
  // REJECTED: a tombstoned effect never writes.
  if (review.action === "reject") {
    throw new Error(`wordpress_site_tool_call: ${review.reason}`);
  }

  // PASS (fence off / org-ungated / nothing to review) or APPLY (an approved
  // gate released the effect). Either way the write proceeds, forwarding the
  // RAW args UNMODIFIED (§3.7) to the SAME governed invoker — identical to
  // how wordpress_site_tool_call forwards every other ability.
  const applied = await invoke({
    toolName: input.toolName,
    args: input.args,
    instanceId,
    ...(input.serverId !== undefined ? { serverId: input.serverId } : {}),
  });

  if (review.action !== "apply") return applied;

  // APPLY: record the post-apply read-back verification. This generic path
  // forwards the raw ability call directly (§3.7) — so it performs its OWN
  // independent post-apply re-read here, via the SAME readPostViaMcp the
  // dedicated tool used to use, never trusting the ability's own
  // write-response echo.
  //
  // TRANSIENT READ-BACK FAILURE ≠ WRITE FAILURE (CodeRabbit-adopted
  // hardening): the mutating invoke() call above already landed. A
  // subsequent readPostViaMcp throw (a transient MCP hiccup) must not be
  // reported to the caller as a FAILED apply, and must not skip recording an
  // outcome for the released gate — caught and surfaced as an unverified
  // read-back instead.
  const seam = getWordPressDeps().cmsReview;
  let postApply: Awaited<ReturnType<typeof readPostViaMcp>> | undefined;
  try {
    postApply = await readPostViaMcp(instance, postId, undefined);
  } catch {
    postApply = undefined;
  }
  const readback = seam
    ? postApply
      ? await seam.recordApplyVerification({
          operationId: review.operationId,
          gateId: review.gate.gateId,
          runId: review.gate.runId,
          postApplyFields: {
            title: postApply.title,
            content: postApply.content,
            excerpt: postApply.excerpt,
            status: postApply.status,
          },
        })
      : { ok: false as const, code: "readback-unavailable" as const }
    : { ok: false as const, code: "seam-unbound" as const };

  const reviewMeta = { operationId: review.operationId, ...readback };
  // Best-effort merge: the ability's own response shape is not pinned by this
  // change (this change is scoped to the trigger relocation, not field-shape
  // equivalence). A non-object response is wrapped rather than spread into.
  if (applied && typeof applied === "object" && !Array.isArray(applied)) {
    return { ...(applied as Record<string, unknown>), review: reviewMeta };
  }
  return { result: applied, review: reviewMeta };
}

export function createWordPressPrimitiveHandlers() {
  return {
    // cinatra#2017 S2 — governed connector-instance invoker (Plane C). Thin:
    // schema-parse then forward the NON-IDENTITY coordinates to the host invoker
    // capability via the deps slot. connectorKey/kind are NOT connector-facing
    // (host-derived from the verified packageName, M6); the actor is host-derived
    // from the MCP request frame (§2.4) — the synthetic request.actor literal is
    // never read here for any decision.
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
      // cinatra-ai/cinatra#2022 — the relocated ability-name-keyed
      // content-review trigger. This is now the ONLY place in this connector
      // that calls `evaluateStagedContentWrite`: the dedicated tool that
      // originally carried it (`wordpress_post_update`) is deleted (PR-θ),
      // once this relocation shipped and soaked (wmc#100). Runs BEFORE the
      // mutating ability is forwarded; on hold/reject the invoke() call
      // below is never made for that ability.
      if (CONTENT_REVIEW_TARGET_ABILITIES.has(input.toolName)) {
        return callReviewGatedSiteTool(invoke, input);
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

    // `wordpress_content_editor_run` is NOT in this map. cinatra-ai/cinatra
    // #2022 S7 extracted it into its own relay-only module (`./relay`,
    // `runContentEditorRelay`) — a DISPATCH primitive that must never be a
    // model-visible MCP tool (cinatra#246), now structurally impossible to
    // reach via `registerWordPressPrimitives()`'s tools/list registration
    // loop since it is never part of this handlers object. Callers (the
    // widget-chat tool) import `runContentEditorRelay` directly.
  } as const;
}
