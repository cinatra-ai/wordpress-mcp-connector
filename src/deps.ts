// Host DI singleton for WordPress connector runtime dependencies.
//
// The deps slot is anchored on `globalThis` via a namespaced+versioned Symbol so
// the boot-time registration and the runtime callers — which live in
// SEPARATELY-COMPILED Next.js bundles (the /connectors page, the connector
// settings page, the relocated "use server" setup-actions) that do NOT import
// the registrar — resolve the SAME slot. A plain module-local binding would
// leave those bundles' instance unregistered → getWordPressDeps() would throw.
// (Same reason as the SDK action-guard + apollo/apify/gemini deps.)
//
// Host-shared surfaces delivered here (no non-SDK `@cinatra-ai/*` code edge):
//   - decodeCursor/buildListPage — `@/lib/mcp-pagination` (host-shared utility).
//   - dispatchContentEditor      — the wordpress-content-editor A2A dispatch
//                                  (host owns the `@cinatra-ai/a2a` client +
//                                  `@cinatra-ai/llm` bearer token + history walk).
//                                  SAME shape as the drupal connector's seam so
//                                  the host can bind ONE shared helper.
//   - deleteInstance             — instance hard-delete (the relocated
//                                  `deleteWordPressInstanceAction` admin op; the
//                                  host owns the `@/lib/wordpress-api` edge).

type ListPage<T> = { items: T[]; total: number; nextCursor?: string };

/**
 * Blocking A2A dispatch to the wordpress-content-editor WayFlow agent. The host
 * owns the `@cinatra-ai/a2a` client, the `@cinatra-ai/llm` bearer-token mint, and
 * the `task.history` walk (the connector never sees an A2A `Task`). Returns the
 * raw agent text reply; the connector code-fence-strips + JSON.parses it.
 *
 * SHARED with the drupal connector — bind ONE host helper for both.
 */
export type DispatchContentEditorInput = {
  /** Resolved A2A agent URL (host reads the per-connector env override). */
  agentUrl: string;
  /** Opaque JSON-serializable payload forwarded as the A2A message text. */
  payload: unknown;
  /** Blocking budget (ms); aligned with the /chat blocking budget (300_000). */
  timeoutMs: number;
  /**
   * npm package name of the content-editor agent (cinatra#246). The host uses
   * it to resolve the agent template and pre-create a real `agent_run` row
   * bound to the deployment's identity, so the downstream `/api/mcp` CMS write
   * is authorized through the production agent-run OBO path (not the dev-admin
   * bypass). Always `@cinatra-ai/wordpress-agent` for this connector.
   */
  packageName: string;
  /**
   * S5 delegated-widget OBO override (cinatra public-site-widget path). Set by
   * `wordpress_content_editor_run` ONLY when the active turn is driven by a
   * trusted `public_site_widget` delegated actor (§5 G1/G4 of the S5-W1
   * OBO-widget-principal design). When present, the host binding MUST forward it
   * verbatim to `dispatchContentEditorViaA2A` so the carrier `agent_run` is
   * created AS THE END USER (`runBy`) against the SERVER-PINNED `instanceId`,
   * with `sourceType:"public_site_widget"` stamped so the downstream bridge
   * suppresses the platform-admin bypass and the CMS write authorizes on the
   * per-instance write-authority gate — never install/single-tenant/anonymous
   * identity, no privilege widening. ABSENT on the normal (non-widget) agent
   * path → the dispatch is byte-identical to today (production agent-run OBO). */
  actorOverride?: WidgetActorOverride;
};

/**
 * The delegated-widget OBO override the content-editor dispatch carries on the
 * `public_site_widget` path. Field-for-field the shape the host dispatch seam
 * (`src/lib/host-content-editor-dispatch.ts`, cinatra#408) already accepts, so
 * the host binding threads it straight through with no re-mapping:
 *   • `runBy`      — the authenticated END-USER id (never the install identity).
 *   • `orgId`      — the widget user's org scope.
 *   • `instanceId` — the SERVER-PINNED canonical instance (verified-origin
 *                    re-pin); the write target, never a model-forgeable value.
 *   • `sourceType` — fixed `"public_site_widget"` discriminator.
 */
export type WidgetActorOverride = {
  runBy: string;
  orgId: string;
  instanceId: string;
  sourceType: "public_site_widget";
};

/**
 * Trusted delegated-widget actor context for the ACTIVE MCP request frame
 * (cinatra S5-W1). Resolved host-side from the SAME trusted frame
 * `requireInstanceWriteAuthority` reads (`resolveExtensionActorContext()`),
 * NEVER from connector tool input or the SDK `request.actor` field.
 */
export type WidgetActorContext = {
  /** Fixed discriminator — this turn is a `public_site_widget` delegation. A
   * non-null context is ALWAYS a widget-delegated call by construction. */
  delegation: "public_site_widget";
  /** Authenticated END-USER id (the carrier run's `runBy`). */
  runBy: string;
  /** Org scope (the `cwu_` claim; never session-derived). */
  orgId: string;
  /** SERVER-PINNED canonical instance (verified-origin re-pin). The model's
   * tool-arg `instanceId` MUST equal this or the write is refused. */
  instanceId: string;
};

/**
 * The instance fields the external-MCP toolbox needs (structural subset of the
 * host's `WordPressInstanceSettings` — `@/lib/wordpress-api` stays host-side).
 * The Nango binding + row metadata are OPTIONAL for skew (host rows always
 * carry them) so this connector compiles against ANY host it can meet; the
 * content surface threads the SAME row back to the host, which resolves Basic
 * auth through the row's Nango binding host-side (cinatra#172 Stage H3).
 */
export type WordPressMcpInstance = {
  id: string;
  name: string;
  siteUrl: string;
  username: string;
  applicationPassword: string;
  /** Nango credential binding (host rows always carry these; optional for skew). */
  providerConfigKey?: string;
  connectionId?: string;
  /** Row metadata (host rows always carry these; optional for skew). */
  lastValidatedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Opt-in site-specific blog-connector binding (host-persisted). */
  blogConnectorId?: string;
};

/**
 * Public (redacted) projection of a WordPress instance for READ/LIST
 * primitives. NEVER carries `applicationPassword` or the Nango credential
 * binding (`providerConfigKey`/`connectionId`) — those are secret/credential
 * material that read-capable callers (incl. LLM tool paths) must never receive.
 * The `wordpress_instances_list` read handler returns this shape; write
 * primitives keep using the full `WordPressMcpInstance` row host-side.
 */
export type WordPressMcpPublicInstance = {
  id: string;
  name: string;
  siteUrl: string;
  username: string;
  lastValidatedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  blogConnectorId?: string;
};

/** Aggregate connector status (host `getWordPressAPIStatus` shape). */
export type WordPressApiStatus = {
  status: "connected" | "not_connected";
  detail: string;
};

/** Draft-create payload (structural mirror of the host's
 * `WordPressWritablePostPayload` — status is pinned to "draft"). */
export type WordPressWritableDraftPayload = {
  title: string;
  content: string;
  excerpt: string;
  status: "draft";
  slug?: string;
  author?: number;
  comment_status?: "open" | "closed";
  ping_status?: "open" | "closed";
  format?: string;
  sticky?: boolean;
  template?: string;
  categories?: number[];
  tags?: number[];
  meta?: Record<string, unknown>;
  featured_media?: number;
};

/** Probe verdict for a WP mcp-adapter endpoint (host-bound cached probe). */
export type WordPressMcpProbeStatus = "registered" | "not_installed" | "auth_error" | "unreachable";

/**
 * Per-user / per-connector-instance write-authority gate input (cinatra#409).
 *
 * The handler passes ONLY the non-identity coordinates of the write: which
 * `instanceId` the write targets and which `primitiveName` is being invoked.
 * THE CALLER IDENTITY IS NEVER PASSED HERE — the host implementation derives the
 * trusted actor (`userId`/subject = the carrier run's `runBy`, `orgId`,
 * `orgRole`, `platformRole`, `sourceType`) host-side from the active MCP request
 * frame (`mcpRequestContextStorage` via `extension-host-actor.ts`), so a
 * connector can never assert or forge identity through tool input.
 */
export type RequireInstanceWriteAuthorityInput = {
  /** The instance the write targets (the tool INPUT argument naming WHICH
   * instance). The host checks the trusted user holds the required `use` right
   * ON THIS instance via `requireConnectorAuthority(<pkg>, actor, {mode:"use",
   * instanceId})`; `enforceConnectorPolicy` keys on `actor.organizationId`, so a
   * different-org instance denies (no grant for that org's verified actor). */
  instanceId: string;
  /** The write primitive name, for the audit row only (never an authz input). */
  primitiveName: string;
};

export interface WordPressConnectorDeps {
  decodeCursor: (cursor?: string) => number;
  buildListPage: <T>(items: T[], total: number, offset: number, limit: number) => ListPage<T>;
  /** Host-owned A2A dispatch to the wordpress-content-editor agent. */
  dispatchContentEditor: (input: DispatchContentEditorInput) => Promise<string>;
  /**
   * S5 delegated-widget OBO seam (cinatra S5-W1). Resolves the trusted
   * `public_site_widget` delegated actor for the ACTIVE MCP request frame, or
   * `null` on the normal (non-widget) agent path. Host-derived ONLY — the SAME
   * trusted request frame `requireInstanceWriteAuthority` reads
   * (`resolveExtensionActorContext()`), NEVER connector tool input or the SDK
   * `request.actor` field.
   *
   * `wordpress_content_editor_run` consumes it: when it returns a
   * `public_site_widget` context the handler (a) FAIL-CLOSED asserts the model's
   * tool-arg `instanceId` === the pinned `instanceId` (`instance_pin_mismatch`)
   * — closing the model-chosen-instance loosening the LLM+MCP hop introduces —
   * and (b) reconstructs `actorOverride {runBy, orgId, instanceId, sourceType:
   * "public_site_widget"}` from THIS trusted actor (never route/tool state) and
   * threads it into `dispatchContentEditor`.
   *
   * OPTIONAL for skew: a pre-S5 host that never mints a widget delegation leaves
   * this UNBOUND; the handler's `?.() ?? null` then yields the non-widget path,
   * byte-identical to today. CONTRACT: the CORE WAVE that introduces the
   * `public_site_widget` MCP delegation MUST bind this resolver in the SAME
   * change — otherwise a widget-delegated turn would silently run under the
   * install identity instead of the end user (a parity gap, not a loosening).
   */
  resolveWidgetActor?: () => WidgetActorContext | null;
  /**
   * OPTIONAL per-deployment override for the content-editor A2A agent URL.
   * Bound by `register.ts` to the `settings` host port (key
   * `content_editor_a2a_url`) — connector code never reads `process.env`
   * (boundary rule, cinatra#978). Resolves `null` when no override is
   * configured; the handler then uses its static default URL. OPTIONAL for
   * skew: a deps binding that predates this member falls back the same way.
   */
  resolveContentEditorAgentUrl?: () => Promise<string | null>;
  /** Host-owned instance hard-delete (`@/lib/wordpress-api` deleteWordPressInstance). */
  deleteInstance: (id: string) => Promise<void>;
  // ---- external-MCP toolbox surfaces (host-bound; consumed by src/mcp/toolbox.ts) ----
  /** Configured WP instances (host `@/lib/wordpress-api` settings). */
  listMcpInstances: () => WordPressMcpInstance[];
  /** Cached mcp-adapter reachability probe for one instance (host-bound). */
  probeMcpAdapter: (instance: WordPressMcpInstance) => Promise<WordPressMcpProbeStatus>;
  /** Injectable MCP endpoint URL for a site (host owns the route constant). */
  resolveMcpServerUrl: (siteUrl: string) => string;
  /** True for private/local URLs external LLM providers cannot reach. */
  isPrivateUrl: (url: string) => boolean;
  // ---- connection/instance-admin reads (`@cinatra-ai/host:wordpress-mcp`,
  //      cinatra#172 Stage H3 — `@/lib/wordpress-api` stays host-side) ----
  /** Aggregate status for the `wordpress_status` primitive (host-bound). */
  getApiStatus: () => WordPressApiStatus;
  // ---- in-admin MCP content-client auth seam (cinatra#1214 S1) ----
  /**
   * Resolve the WordPress Application-Password Basic auth header for the site's
   * MCP content server, HOST-SIDE through the connector's relocated client
   * (`resolveWordPressBasicAuth` → Nango credential + the #1077
   * instance-connection use-gate + audit `source:"wordpress-api"`). Consumed by
   * `callWordPressMcp` (src/lib/wordpress-mcp-client.ts) so the in-admin
   * read/update reach WordPress ONLY through its MCP integration, using the SAME
   * credential + use-gate + audit semantics the direct REST client used — only
   * the transport changes. THROWS fail-closed on a use-gate deny or a missing
   * credential; the resolved password never crosses back to the connector (only
   * the ready-to-send `Authorization` header does).
   */
  buildWordPressBasicAuthHeader: (input: {
    instance: WordPressMcpInstance;
  }) => Promise<{ Authorization: string }>;
  // ---- post/media content surface (`@cinatra-ai/host:wordpress-content`,
  //      cinatra#172 Stage H3). Host-side Basic-auth resolution (Nango on the
  //      row's credential binding) runs inside each member. The WRITERS
  //      (createDraft/deletePost/uploadMedia/updateDraftMeta) are only ever
  //      reached through the host's MCP dispatch + actor gating — the identical
  //      posture the static imports carried. (The in-admin `readPost`/`updatePost`
  //      members were RETIRED in cinatra#1214 S1 — the get/update reroute to the
  //      MCP client; see `buildWordPressBasicAuthHeader` above.) ----
  /** WRITER — create a draft post on the instance. */
  createDraft: (input: {
    instance: WordPressMcpInstance;
    payload: WordPressWritableDraftPayload;
  }) => Promise<{ wordpressPostId: number; publicUrl?: string; adminUrl: string }>;
  /** Read one post's publish status (`postType: "page"` routes to /pages/{id}). */
  readPostStatus: (input: {
    instance: WordPressMcpInstance;
    wordpressPostId: number;
    postType?: string;
  }) => Promise<{ id: number; status: string; adminUrl: string; publicUrl?: string }>;
  /** List published posts (metadata-only, offset-paginated). */
  listPublishedPosts: (
    instance: WordPressMcpInstance,
    options?: { offset?: number; limit?: number },
  ) => Promise<{
    items: Array<{ id: number; title: string; status: string; date: string; url: string }>;
    total: number;
  }>;
  /** List published pages (metadata-only, offset-paginated; routes to /pages). */
  listPublishedPages: (
    instance: WordPressMcpInstance,
    options?: { offset?: number; limit?: number },
  ) => Promise<{
    items: Array<{ id: number; title: string; status: string; date: string; url: string }>;
    total: number;
  }>;
  /** WRITER — delete a post on the instance (`postType: "page"` routes to /pages/{id}). */
  deletePost: (input: {
    instance: WordPressMcpInstance;
    wordpressPostId: number;
    postType?: string;
  }) => Promise<{ deleted: boolean; previousStatus?: string }>;
  /** WRITER — upload media (featured images). */
  uploadMedia: (input: {
    instance: WordPressMcpInstance;
    imageBase64: string;
    imageMimeType: string;
    title: string;
  }) => Promise<{ mediaId: number; sourceUrl?: string }>;
  /** WRITER — meta-only post update; returns the raw WP post record. */
  updateDraftMeta: (input: {
    instance: WordPressMcpInstance;
    wordpressPostId: number;
    meta: Record<string, unknown>;
  }) => Promise<unknown>;
  // ---- per-user write-authority gate (cinatra#409; host-bound) ----
  /**
   * WRITE AUTHZ — per-user / per-connector-instance entitlement gate. EVERY
   * WordPress write primitive (`wordpress_post_update`,
   * `wordpress_post_update_meta`, `wordpress_post_create_draft`,
   * `wordpress_post_delete`, `wordpress_media_upload`) MUST `await` this BEFORE
   * dispatching the write to its host writer. It THROWS on deny; resolving
   * without throwing is the only "allow".
   *
   * Host-side the impl: (a) resolves the trusted actor from the active MCP
   * request frame (`resolveExtensionActorContext()` / `resolveExtensionActorSummary()`
   * — NEVER from connector tool input); (b) DENIES (throws) if it cannot resolve
   * a `userId`+`orgId` (null actor → fail-closed, no synthetic/anonymous write);
   * (c) calls `requireConnectorAuthority("@cinatra-ai/wordpress-mcp-connector",
   * actor, {mode:"use", instanceId})` and throws on deny; (d) for the
   * `public_site_widget` source the platform-admin bypass is NOT honored
   * (already true post-#408 because `resolveAgentRunMcpActor` suppresses
   * platform_admin on that path); (e) emits the per-decision audit row. The
   * package id the policy evaluates is HOST-BOUND (the host maps the connector's
   * static KIND "wordpress" to the package id via `selectForConnector`, and
   * THROWS on an unknown kind), never caller input.
   *
   * FAIL-CLOSED CONTRACT: this dep is the handler's only authorization. If it is
   * UNBOUND on an old host (`getWordPressDeps().requireInstanceWriteAuthority`
   * absent) the writer MUST throw rather than write — see the handler guard. It
   * is declared REQUIRED here; the handler additionally guards `typeof !==
   * "function"` defensively so a skewed/partial binding still fails closed.
   */
  requireInstanceWriteAuthority: (
    input: RequireInstanceWriteAuthorityInput,
  ) => Promise<void>;
}

const WORDPRESS_DEPS_KEY = Symbol.for("@cinatra-ai/wordpress-mcp-connector:host-deps/v1");
type DepsHolder = { [k: symbol]: WordPressConnectorDeps | null | undefined };
const _holder = globalThis as unknown as DepsHolder;

/**
 * Wire the runtime deps. Bound by the connector's own `register(ctx)` at
 * activation (transport-DI inversion, cinatra#151 Stage 3) — and, on hosts
 * that predate the cutover, statically at boot by the host's transport
 * binder. Re-calling replaces — tests swap stubs.
 */
export function registerWordPressConnector(deps: WordPressConnectorDeps): void {
  _holder[WORDPRESS_DEPS_KEY] = deps;
}


export function getWordPressDeps(): WordPressConnectorDeps {
  const deps = _holder[WORDPRESS_DEPS_KEY];
  if (!deps) {
    throw new Error(
      "@cinatra-ai/wordpress-mcp-connector: host runtime deps not registered. " +
        "Call registerWordPressConnector(deps) at boot.",
    );
  }
  return deps;
}

/** @internal test-only. */
export function _resetWordPressDepsForTests(): void {
  _holder[WORDPRESS_DEPS_KEY] = null;
}

/**
 * Most-recently-updated-first view of the deps slot's `listMcpInstances` rows
 * (shared by the settings page and the MCP handlers). Replicates the host
 * `listWordPressInstances` ordering (`updatedAt` desc) connector-side — the
 * host service exposes the raw settings rows (cinatra#172 Stage H3).
 */
export function listInstancesSorted(): WordPressMcpInstance[] {
  return [...getWordPressDeps().listMcpInstances()].sort((l, r) =>
    (r.updatedAt ?? "").localeCompare(l.updatedAt ?? ""),
  );
}
