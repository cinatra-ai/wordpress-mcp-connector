import { z } from "zod";
import type { ExtensionPrimitiveRequest, SiteToolRow } from "@cinatra-ai/sdk-extensions";
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
  SITE_TOOL_GUARDED_UNSUPPORTED_REFUSAL,
  type GuardedSiteToolCallInput,
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
// agent runs read through this proxy, so writes and publishes go
// through `wordpress_site_tool_write` (declared outward in the registry)
// instead. The read exemption is decided on the catalog row of the server that
// will run the call, never on the ability name alone (`readRow`
// below); every refusal is this fixed message, given before the invoker.
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
  "cinatra/post-read",
]);
// The site's own MCP adapter server. The `ewpa/*` abilities it serves carry no
// annotations, so their rows are accepted as reads only on this server.
const DEFAULT_CATALOG_SERVER_ID = "mcp-adapter-default";
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

const hint = (annotations: Record<string, unknown>, mcpKey: string, wpKey: string): unknown =>
  annotations[mcpKey] ?? annotations[wpKey];

// Whether the server's own row marks the ability read-only: the host's class
// for the row is "read" (a read-only hint and no destructive hint), and the
// stored annotations carry no destructive hint. A known `ewpa/*` read with no
// annotation at all is accepted only on the default adapter server.
function rowSaysRead(row: SiteToolRow): boolean {
  const annotations = row.rawAnnotations ?? {};
  const destructive = hint(annotations, "destructiveHint", "destructive");
  const readOnly = hint(annotations, "readOnlyHint", "readonly");
  if (row.derivedClass === "destructive" || destructive) return false;
  if (row.derivedClass === "read" && readOnly) return true;
  return (
    row.name.startsWith("ewpa/") &&
    row.serverId === DEFAULT_CATALOG_SERVER_ID &&
    destructive === undefined &&
    readOnly === undefined
  );
}

// The one catalog row that may serve this call as a read, or null. The ability must be a known read AND its row on the server that will
// run it must say read-only (`rowSaysRead`). The row is identified by
// `{serverId, name}`: with a `serverId`, the only row of the name must be on
// that server; without one, the name must have exactly one row in the whole
// catalog. A missing row, a row of another server, several rows, an unbound
// listing or a listing that does not end within MAX_CATALOG_PAGES pages give
// null; a listing that throws passes its error on. The catalog is read on
// every call, and the call follows the listing with no other wait.
//
// The host resolves the call against its own catalog snapshot, which can
// refresh after this listing, so the caller sends the call through the host's
// GUARDED method (`callGuardedRead`): the host runs it only when the row it
// resolves now is this row (same server, same raw annotations, read class).
async function readRow(input: SiteToolCallInput): Promise<SiteToolRow | null> {
  if (KNOWN_WRITE_ABILITIES.has(input.toolName)) return null;
  if (!KNOWN_READ_ABILITIES.has(input.toolName)) return null;
  const list = getWordPressDeps().listSiteTools;
  if (typeof list !== "function") return null;
  const rows: SiteToolRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
    const result = await list({
      ...(input.instanceId !== undefined ? { instanceId: input.instanceId } : {}),
      ...(input.serverId !== undefined ? { serverId: input.serverId } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    });
    rows.push(...result.tools.filter((row) => row.name === input.toolName));
    cursor = result.nextCursor;
    if (cursor === undefined) {
      if (rows.length !== 1) return null;
      const [only] = rows as [SiteToolRow];
      if (input.serverId !== undefined && only.serverId !== input.serverId) return null;
      return rowSaysRead(only) ? only : null;
    }
  }
  return null;
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

// cinatra#3745: the fixed refusal when the host reports that the listed row
// changed before the call ran (`catalog_entry_changed`).
export const SITE_TOOL_CATALOG_CHANGED_REFUSAL =
  "wordpress_site_tool_call refused: the site tool changed after it was listed. " +
  "Nothing was run. Call wordpress_site_tool_call again to read the current catalog.";

// cinatra#3745: the fixed refusal of a listed row the guarded call cannot carry
// (no server id, or annotations that are not a plain object), and of the
// host's `guarded_server_id_required`.
export const SITE_TOOL_LISTED_ROW_REFUSAL =
  "wordpress_site_tool_call refused: the listed site tool has no server id or its annotations are not plain data. " +
  "Nothing was run.";

// Bounds of the annotations walk. Annotations are small; a value past either
// bound is refused like any other value that is not JSON data.
const ANNOTATIONS_MAX_DEPTH = 32; // container nesting below the annotations object
const ANNOTATIONS_MAX_VALUES = 10_000; // values visited, the annotations object included

// Whether `value` is JSON data, at every depth. ALLOWED, and nothing else:
// null, a boolean, a finite number, a string, an array whose every index
// holds such a value (no holes), and a plain object (prototype
// `Object.prototype` or `null`) with only string keys whose every value is
// such a value. A key holding `undefined`, a function or a symbol is NOT
// dropped (the host's canonical form would drop it and compare the row equal
// to one without that key): it fails the check like any other value.
// The walk is iterative (an explicit stack, no recursion) and bounded by
// ANNOTATIONS_MAX_DEPTH and ANNOTATIONS_MAX_VALUES; a cycle exceeds the depth
// bound. It never throws.
function isJsonData(root: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (++visited > ANNOTATIONS_MAX_VALUES) return false;
    if (value === null || typeof value === "boolean" || typeof value === "string") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (typeof value !== "object" || depth > ANNOTATIONS_MAX_DEPTH) return false;
    // Pushing the children of one container cannot pass the value bound by more
    // than its own size, which is checked before anything is pushed.
    if (Array.isArray(value)) {
      if (visited + value.length > ANNOTATIONS_MAX_VALUES) return false;
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) return false;
        stack.push({ value: value[i], depth: depth + 1 });
      }
      continue;
    }
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    if (Object.getOwnPropertySymbols(value).length > 0) return false;
    const keys = Object.keys(value);
    if (visited + keys.length > ANNOTATIONS_MAX_VALUES) return false;
    for (const key of keys) stack.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 });
  }
  return true;
}

// The listed row's annotations as the guarded call carries them: an absent
// value (an unannotated row) becomes a plain `{}`; anything but a plain object
// of JSON data gives null and the call is refused.
function guardAnnotations(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  try {
    // A property getter could throw while the walk reads it; that is not data.
    return isJsonData(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// The read tool's call, through the host's GUARDED method only. It sends the
// listed row's server and raw annotations, and asserts the read class unless
// the row is an unannotated known `ewpa/*` read on the default adapter server
// (the host's classifier calls an unannotated row "write"; the annotation
// guard still refuses a row that changed). Never falls back to
// `invokeSiteTool`: an older host runs that call without the guards, and a
// host with the guarded method refuses it when it carries a guard field.
async function callGuardedRead(input: SiteToolCallInput, row: SiteToolRow): Promise<unknown> {
  const guarded = getWordPressDeps().invokeSiteToolGuarded;
  if (typeof guarded !== "function") throw new Error(SITE_TOOL_GUARDED_UNSUPPORTED_REFUSAL);
  const annotations = guardAnnotations(row.rawAnnotations);
  if (typeof row.serverId !== "string" || row.serverId.length === 0 || annotations === null) {
    throw new Error(SITE_TOOL_LISTED_ROW_REFUSAL);
  }
  const readOnly = hint(annotations, "readOnlyHint", "readonly");
  const call: GuardedSiteToolCallInput = {
    toolName: input.toolName,
    args: input.args,
    ...(input.instanceId !== undefined ? { instanceId: input.instanceId } : {}),
    serverId: row.serverId,
    expectedRawAnnotations: annotations,
    ...(readOnly !== undefined ? { expectedClass: "read" as const } : {}),
  };
  try {
    return await guarded(call);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "catalog_entry_changed") throw new Error(SITE_TOOL_CATALOG_CHANGED_REFUSAL, { cause: error });
    if (code === "catalog_entry_not_read") throw new Error(SITE_TOOL_READ_ONLY_REFUSAL, { cause: error });
    if (code === "guarded_server_id_required") throw new Error(SITE_TOOL_LISTED_ROW_REFUSAL, { cause: error });
    if (code === "guarded_call_required") throw new Error(SITE_TOOL_GUARDED_UNSUPPORTED_REFUSAL, { cause: error });
    throw error;
  }
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
      // cinatra#3745: a read needs the host's guarded method. Presence is
      // decided first, from the host service at call time
      // (`siteToolGuardSupported`); without it the tool is denied before the
      // catalog is read or anything else is called on the host.
      const deps = getWordPressDeps();
      if (
        typeof deps.invokeSiteToolGuarded !== "function" ||
        typeof deps.siteToolGuardSupported !== "function" ||
        deps.siteToolGuardSupported() !== true
      ) {
        throw new Error(SITE_TOOL_GUARDED_UNSUPPORTED_REFUSAL);
      }
      const row = await readRow(input);
      if (row === null) throw new Error(SITE_TOOL_READ_ONLY_REFUSAL);
      return callGuardedRead(input, row);
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
