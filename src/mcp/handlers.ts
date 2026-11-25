import { z } from "zod";
import type { ExtensionPrimitiveRequest } from "@cinatra-ai/sdk-extensions";
// cinatra-ai/cinatra#2022 S7 (PR-θ): the 12 old per-operation `wordpress_*`
// facade tools that used to live here are DELETED. They are enumerated once,
// in this repo's CHANGELOG entry for that deletion, and are deliberately NOT
// re-spelled anywhere in shipped code — cinatra#2022's close gate is a
// SHIPPED-CODE search that must return zero hits for those names. It is
// scoped, not a raw tree search: this repo's CHANGELOG (a historical record)
// and the deletion-regression tests that assert the names are ABSENT
// (`src/__tests__/registry-omission.test.ts`) keep them by design.
// They were thin wrappers around either the plugin's own
// `cinatra-content-server` (`callWordPressMcp`, `../lib/wordpress-mcp-client`,
// now also deleted) or — for the two in-admin editing tools (the dedicated
// post-read + post-update pair) — the governed
// connector-instance invoker under the same transitional names during PR-τ's
// soak window. Every caller now reaches a connected site's own MCP catalog
// directly through the two generic, already-governed primitives below
// (`wordpress_site_tool_call` / `wordpress_site_tools_list`), which have been
// registered — dark until S7's perimeter cutover — since S2.
//
// The site's post update ability is forwarded like every other ability: its
// arguments are checked and passed unchanged to the invoker, whose result is
// returned.
import {
  getWordPressDeps,
  listInstancesSorted,
  type WordPressConnectorDeps,
} from "../deps";

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
  // Absent args (and absent argsJson) forward as {}, so a no-argument tool is
  // callable without an explicit args.
  args: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Arguments for the target tool, matching its advertised input schema. Omit or pass {} for a no-argument tool."),
  // cinatra#3745: a flow step without a model renders its arguments as text,
  // so the same arguments may arrive as the text of a JSON object instead.
  argsJson: z
    .string()
    .optional()
    .describe(
      "The same arguments as the text of a JSON object, for a caller that can send only text. Give args or argsJson, not both.",
    ),
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

// The site's post update ability.
const EWPA_UPDATE_POST_ABILITY = "ewpa/update-post";

export const CONTENT_REVIEW_TARGET_ABILITIES: ReadonlySet<string> = new Set([EWPA_UPDATE_POST_ABILITY]);

/**
 * Check the arguments of the post update ability and forward them unchanged
 * to the invoker, returning its result. An absent instanceId is refused: this
 * connector cannot resolve which site is meant.
 */
async function callReviewGatedSiteTool(
  invoke: NonNullable<WordPressConnectorDeps["invokeSiteTool"]>,
  input: { toolName: string; args: Record<string, unknown>; instanceId?: string; serverId?: string },
  tool: string,
): Promise<unknown> {
  const instanceId = input.instanceId;
  if (!instanceId) {
    throw new Error(
      `${tool}: "${input.toolName}" is a content-review-gated write and requires an ` +
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
    throw new Error(`${tool}: "${input.toolName}" requires a positive integer "post_id" argument.`);
  }

  // Post meta is not covered by this ability, and a request with no editable
  // field is refused before the call. Meta writes live on a different
  // ability of the site's own catalog: call this tool again with that
  // toolName (list the catalog first) rather than passing `meta` here.
  if (args.meta !== undefined) {
    throw new Error(
      `${tool}: "${input.toolName}" cannot write post meta through the governed connector-instance ` +
        `invoker — call ${tool} again with toolName "ewpa/update-post-meta" (list the catalog via ` +
        "wordpress_site_tools_list first) for meta writes.",
    );
  }

  // Reject fields outside the accepted set fail-closed: an out-of-scope field
  // (slug, author, date, categories, ...) must not ride along unchecked, so
  // the arguments are refused before the call is forwarded.
  const REVIEWED_ARG_KEYS = new Set(["post_id", "title", "content", "excerpt", "status"]);
  const outOfScopeKeys = Object.keys(args).filter((k) => !REVIEWED_ARG_KEYS.has(k));
  if (outOfScopeKeys.length > 0) {
    throw new Error(
      `${tool}: "${input.toolName}" received field(s) outside the content-review scope ` +
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
    throw new Error(`${tool}: "${input.toolName}" has no editable fields (title/content/excerpt/status).`);
  }

  // cinatra#409 — per-user / per-instance write-authority gate, after all
  // argument checks above and before the call is forwarded. It is this
  // connector's own audited record, separate from the invoker's authorization.
  await requireWriteAuthority(instanceId, tool);

  return invoke({
    toolName: input.toolName,
    args: input.args,
    instanceId,
    ...(input.serverId !== undefined ? { serverId: input.serverId } : {}),
  });
}

// cinatra#3745: `wordpress_site_tool_call` is READ-ONLY. A registration's
// `outward` declaration holds every call of that tool in an agent run, and
// agent runs read through this proxy, so writes and publishes go through
// `wordpress_site_tool_write` (declared outward in the registry) instead. The
// proxy forwards an ability only when it is a known read below or the site's
// catalog lists every row of that name as derivedClass "read"; anything else
// (write, destructive, unlisted, an unbound listing, a catalog that does not
// end) gets this fixed refusal before the invoker. The site's own ewpa
// abilities carry no annotations (the host classifies them as write), so their
// reads are named here.
export const SITE_TOOL_READ_ONLY_REFUSAL =
  "wordpress_site_tool_call is read-only: it calls only a read ability of the site's catalog. " +
  "Call wordpress_site_tool_write for an ability that writes or publishes.";

const KNOWN_READ_ABILITIES: ReadonlySet<string> = new Set([
  "core/get-site-info",
  "core/get-user-info",
  "core/get-environment-info",
  "ewpa/get-posts",
  "ewpa/get-post",
  "ewpa/get-page",
  "ewpa/get-categories",
]);
// cinatra#3745: `argsJson` carries the ability's arguments as the text of a
// JSON object. Exactly one of `args` and `argsJson` may be given. The text is
// bounded at 256 KiB counted in UTF-8 bytes (the host's limit for one action),
// must parse to a plain object, and is then checked by the same `args` schema.
// The refusals are fixed messages and never repeat the text.
export const SITE_TOOL_ARGS_JSON_MAX_BYTES = 256 * 1024;
export const SITE_TOOL_ARGS_BOTH_REFUSAL = "Give the tool arguments as args or as argsJson, not both.";
export const SITE_TOOL_ARGS_JSON_REFUSAL = "argsJson must be the text of a JSON object.";
export const SITE_TOOL_ARGS_JSON_TOO_LARGE_REFUSAL =
  `argsJson is larger than ${SITE_TOOL_ARGS_JSON_MAX_BYTES} bytes.`;

type SiteToolCallInput = {
  toolName: string;
  args: Record<string, unknown>;
  instanceId?: string;
  serverId?: string;
};

function parseArgsJson(text: string): Record<string, unknown> {
  // A string has at least as many UTF-8 bytes as UTF-16 code units, so a long
  // string is refused before it is encoded.
  if (text.length > SITE_TOOL_ARGS_JSON_MAX_BYTES || new TextEncoder().encode(text).length > SITE_TOOL_ARGS_JSON_MAX_BYTES) {
    throw new Error(SITE_TOOL_ARGS_JSON_TOO_LARGE_REFUSAL);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(SITE_TOOL_ARGS_JSON_REFUSAL);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(SITE_TOOL_ARGS_JSON_REFUSAL);
  }
  const checked = siteToolCallSchema.shape.args.safeParse(parsed);
  if (!checked.success || checked.data === undefined) throw new Error(SITE_TOOL_ARGS_JSON_REFUSAL);
  return checked.data;
}

/** Parse a site tool input; `args` is resolved from `args` or `argsJson`. */
function parseSiteToolCallInput(raw: unknown): SiteToolCallInput {
  const { argsJson, args, ...rest } = siteToolCallSchema.parse(raw);
  if (argsJson !== undefined && args !== undefined) throw new Error(SITE_TOOL_ARGS_BOTH_REFUSAL);
  return { ...rest, args: argsJson !== undefined ? parseArgsJson(argsJson) : (args ?? {}) };
}

const KNOWN_WRITE_ABILITIES: ReadonlySet<string> = new Set([...CONTENT_REVIEW_TARGET_ABILITIES, "ewpa/create-post"]);
const MAX_CATALOG_PAGES = 20;

async function isReadAbility(input: SiteToolCallInput): Promise<boolean> {
  if (KNOWN_WRITE_ABILITIES.has(input.toolName)) return false;
  if (KNOWN_READ_ABILITIES.has(input.toolName)) return true;
  const list = getWordPressDeps().listSiteTools;
  if (typeof list !== "function") return false;
  let found = false;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
    const result = await list({
      ...(input.instanceId !== undefined ? { instanceId: input.instanceId } : {}),
      ...(input.serverId !== undefined ? { serverId: input.serverId } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    });
    for (const row of result.tools) {
      if (row.name !== input.toolName) continue;
      if (row.derivedClass !== "read") return false;
      found = true;
    }
    cursor = result.nextCursor;
    if (cursor === undefined) return found;
  }
  return false;
}

// The governed forward both site tools share; `tool` names the calling tool.
async function forwardSiteTool(input: SiteToolCallInput, tool: string): Promise<unknown> {
  // FAIL-CLOSED: the invoker is host-bound (register.ts resolves the capability
  // fail-loud). If the deps slot is skewed/partial and the member is unbound,
  // DENY descriptively rather than crash — never reach WordPress off-channel.
  const invoke = getWordPressDeps().invokeSiteTool;
  if (typeof invoke !== "function") {
    throw new Error(
      `${tool} denied: the governed connector-instance invoker is unavailable ` +
        "(host @cinatra-ai/host:connector-instance-invoker unbound). Refusing to call without the governed channel.",
    );
  }
  // The site's post update ability is forwarded like every other ability:
  // its arguments are checked, then passed unchanged to the invoker, whose
  // result is returned.
  if (CONTENT_REVIEW_TARGET_ABILITIES.has(input.toolName)) {
    return callReviewGatedSiteTool(invoke, input, tool);
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
      const input = parseSiteToolCallInput(request.input);
      if (!(await isReadAbility(input))) throw new Error(SITE_TOOL_READ_ONLY_REFUSAL);
      return forwardSiteTool(input, "wordpress_site_tool_call");
    },

    // cinatra#3745: every write and publish of a site ability; declared outward.
    "wordpress_site_tool_write": async (request: ExtensionPrimitiveRequest<unknown>) =>
      forwardSiteTool(parseSiteToolCallInput(request.input), "wordpress_site_tool_write"),

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
