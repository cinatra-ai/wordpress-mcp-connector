// VENDORED host-capability contract for the governed connector-instance invoker
// (cinatra#2017 S2, gateway PR-1 — the CONNECTOR half).
//
// WHY VENDORED (codex B3 — compilability, destination-first merge order):
// PR-1 (this connector change) merges BEFORE the core PR that ships the invoker
// and publishes the shared TYPE-ONLY contract on `@cinatra-ai/sdk-extensions`
// (the `connectorInstanceInvoker` capability member + the invoker/list types,
// core slice K1). If this file imported that shared symbol, the connector would
// reference a member its installed `@cinatra-ai/sdk-extensions` does NOT yet
// export — a BUILD-time break (runtime fail-loud alone does not cover the
// connector's own compile/CI). So PR-1 vendors a LOCAL structural mirror of the
// two connector-facing methods plus the capability-id string constant, and
// imports NOTHING new from the SDK. The follow-up connector PR (C3, merges THIRD
// after core lands + publishes the contract) swaps this file's re-exports for the
// shared `@cinatra-ai/sdk-extensions` import — a pure type/import swap, no
// behavior change, because the vendored shapes are structurally identical.
//
// SECURITY SHAPE (M6 / R2-B1): the connector-facing methods carry NO
// `connectorKey` and NO `kind` selector. `connectorKey` is derived HOST-SIDE from
// the verified calling-connector `packageName` inside the published host
// capability — there is no connector-visible selector to mis-name. Identity
// (actor) is likewise host-derived from the active MCP request frame; the
// connector passes only the non-identity call coordinates.

/**
 * The host capability id the connector resolves through `hostService(ctx, …)` to
 * reach the governed invoker. Connector-generic (the core API is keyed by the
 * host-derived `connectorKey`), hence NOT `wordpress-`-prefixed. Kept as a local
 * `const` string so the connector inlines the literal without importing the
 * SDK's typed capability member (which only lands in the later core PR).
 *
 * MUST stay byte-identical to the core-published id (core slices K1/K9) and to
 * the SDK constant the C3 follow-up swaps in.
 */
export const LOCAL_CONNECTOR_INSTANCE_INVOKER_CAP =
  "@cinatra-ai/host:connector-instance-invoker" as const;

/**
 * Input to a single governed site-tool call (the `wordpress_site_tool_call`
 * primitive's forwarded coordinates). NO `connectorKey` / `kind` (M6).
 */
export type SiteToolCallInput = {
  /**
   * The tool to invoke. On a triad-only server this is the INNER ability id,
   * which may carry a slash (e.g. `ewpa/create-post`, `core/get-site-info`).
   */
  toolName: string;
  /**
   * Arguments forwarded to the resolved tool's advertised schema UNMODIFIED
   * (§3.7). An empty object is a valid no-arg call (e.g. a discover-style tool).
   */
  args: Record<string, unknown>;
  /**
   * Target connected-site instance. OPTIONAL: required only when the caller's
   * session is not pinned to a single instance (org scope). When the actor
   * carries a signed instance pin, an omitted value resolves to the pinned id
   * host-side; a supplied value must equal the pin or the host rejects it.
   */
  instanceId?: string;
  /**
   * Target MCP server. OPTIONAL: required only when `toolName` is non-unique
   * across the instance's enrolled servers. An OPAQUE, host-owned identity
   * (§10-A1) — never endpoint- or name-derived; the connector forwards it
   * verbatim and never mints one.
   */
  serverId?: string;
};

/**
 * Input to the governed `tools_list` surface (the `wordpress_site_tools_list`
 * primitive's forwarded coordinates). NO `connectorKey` / `kind` (M6). The host
 * runs the SAME pin + live per-instance USE authority gate BEFORE any catalog
 * read (codex B2), so an unauthorized list yields a typed error, never a catalog.
 */
export type SiteToolsListInput = {
  /** Target instance — OPTIONAL, same pin semantics as `SiteToolCallInput`. */
  instanceId?: string;
  /** Target server — OPTIONAL opaque host-owned id (§10-A1), forwarded verbatim. */
  serverId?: string;
  /**
   * Revision-pinned pagination cursor (§3.5). A cursor minted against one catalog
   * snapshot pages consistently over it; a stale cursor is rejected host-side.
   */
  cursor?: string;
};

/** Classifier verdict for a listed tool — advisory only (destructive > write >
 * read, §3.4); never gates availability. */
export type SiteToolDerivedClass = "read" | "write" | "destructive";

/** Per-instance policy verdict for a listed tool (§2.6). In `restricted` mode a
 * denied tool is still LISTED and MARKED — the list is never shortened (§3.5). */
export type SiteToolPolicyStatus = "allowed" | "denied";

/**
 * One row of the governed `tools_list` (§3.5 frozen contract + §10-A2). Every
 * field is host-composed and pass-through verbatim; the connector never rewrites
 * a row.
 */
export type SiteToolRow = {
  /** Tool / ability id (slash-bearing on triad servers, §3.1). */
  name: string;
  /** STABLE, OPAQUE, host-owned server identity (§10-A1) — NOT endpoint-, URL-,
   * or normalized-name-derived. The stable sort key is `(serverId, name)`. */
  serverId: string;
  /** JSON Schema for the tool's arguments, verbatim from the site (A2, required —
   * gives a caller the schema needed to call an arbitrary tool). */
  inputSchema: unknown;
  /** JSON Schema for the tool's result, when the site supplies one (A2). */
  outputSchema?: unknown;
  /** Human-readable label, verbatim (A2). */
  label?: string;
  /** Human-readable description, verbatim (A2). */
  description?: string;
  /** Raw MCP annotation hints as carried by the site (advisory input, §3.4).
   * PRESENT on every row per the §3.5 frozen contract — an unannotated tool
   * carries `{}` (report-never-drop), never an omitted field. */
  rawAnnotations: Record<string, unknown>;
  /** Classifier verdict (advisory, §3.4). */
  derivedClass: SiteToolDerivedClass;
  /** Per-instance policy verdict for this row (§2.6). */
  policyStatus: SiteToolPolicyStatus;
  /** Age of the cached catalog snapshot in ms (§3.3/§3.5). */
  cacheAgeMs: number;
  /** The catalog snapshot revision this row was composed from (§3.5). */
  catalogRevision: string;
};

/**
 * A page of the governed `tools_list`. Uncapped pagination, no total ceiling
 * (§3.5): an absent `nextCursor` marks the last page.
 */
export type SiteToolsListPage = {
  tools: SiteToolRow[];
  /** Revision-pinned cursor for the next page (§3.5); absent = last page. */
  nextCursor?: string;
  /** The snapshot revision these rows were paged against (§3.5). */
  catalogRevision: string;
};

/**
 * The connector-facing shape of the governed invoker host capability. Resolved
 * via `hostService<LocalConnectorInstanceInvokerShape>(ctx,
 * LOCAL_CONNECTOR_INSTANCE_INVOKER_CAP)`. A MINIMAL structural mirror of the two
 * methods the connector uses — the host binds a connector-SCOPED guard whose
 * `connectorKey` is already derived from this connector's verified `packageName`
 * (M6), so neither method takes a `connectorKey` / `kind` argument.
 */
export type LocalConnectorInstanceInvokerShape = {
  /** Governed single-tool call → the tool's unwrapped result (structuredContent
   * preferred; typed errors thrown on failure). */
  invokeSiteTool: (input: SiteToolCallInput) => Promise<unknown>;
  /** Governed catalog listing (gate runs BEFORE any catalog read, B2). */
  listSiteTools: (input: SiteToolsListInput) => Promise<SiteToolsListPage>;
};
