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

/** Post read shape (host `readWordPressPost` return). */
export type WordPressPostRead = {
  id: number;
  status: string;
  title: string;
  content: string;
  excerpt: string;
  slug?: string;
  link?: string;
  featured_media?: number;
  categories?: number[];
  tags?: number[];
  adminUrl: string;
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
  // ---- post/media content surface (`@cinatra-ai/host:wordpress-content`,
  //      cinatra#172 Stage H3). Host-side Basic-auth resolution (Nango on the
  //      row's credential binding) runs inside each member. The WRITERS
  //      (createDraft/deletePost/uploadMedia/updateDraftMeta/updatePost) are
  //      only ever reached through the host's MCP dispatch + actor gating —
  //      the identical posture the static imports carried. ----
  /** WRITER — create a draft post on the instance. */
  createDraft: (input: {
    instance: WordPressMcpInstance;
    payload: WordPressWritableDraftPayload;
  }) => Promise<{ wordpressPostId: number; publicUrl?: string; adminUrl: string }>;
  /** Read one post (edit context; `postType: "page"` routes to /pages). */
  readPost: (input: {
    instance: WordPressMcpInstance;
    wordpressPostId: number;
    postType?: string;
  }) => Promise<WordPressPostRead>;
  /** Read one post's publish status. */
  readPostStatus: (input: {
    instance: WordPressMcpInstance;
    wordpressPostId: number;
  }) => Promise<{ id: number; status: string; adminUrl: string; publicUrl?: string }>;
  /** List published posts (metadata-only, offset-paginated). */
  listPublishedPosts: (
    instance: WordPressMcpInstance,
    options?: { offset?: number; limit?: number },
  ) => Promise<{
    items: Array<{ id: number; title: string; status: string; date: string; url: string }>;
    total: number;
  }>;
  /** WRITER — delete a post on the instance. */
  deletePost: (input: {
    instance: WordPressMcpInstance;
    wordpressPostId: number;
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
  /** WRITER — top-level field updates (title/content/excerpt/status/meta). */
  updatePost: (input: {
    instance: WordPressMcpInstance;
    wordpressPostId: number;
    postType?: string;
    fields: {
      title?: string;
      content?: string;
      excerpt?: string;
      status?: "publish" | "future" | "draft" | "pending" | "private";
      meta?: Record<string, unknown>;
    };
  }) => Promise<{
    id: number;
    status: string;
    title: string;
    content: string;
    excerpt: string;
    adminUrl: string;
  }>;
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
