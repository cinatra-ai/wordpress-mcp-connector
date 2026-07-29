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

import type {
  SiteToolCallInput,
  SiteToolsListInput,
  SiteToolsListPage,
} from "@cinatra-ai/sdk-extensions";

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

// ---------------------------------------------------------------------------
// S5 CMS content-review seam (cinatra#2043, epic #2037 S5 — the CONNECTOR half).
//
// The CORE half (#2082, on cinatra main) shipped `captureCmsContentSnapshot`
// (the one-Tx snapshot substrate + produced event + `cms_snapshot_targets`
// apply-binding) and `recordCmsApplyVerification` (the read-back verifier bound
// to the STORED scope manifest). Both are host-internal `@/lib` / `@cinatra-ai/`
// server modules — the connector can NEVER import them (the `@/` alias does not
// resolve in the standalone package build, the whole reason for this deps-DI
// slot). So the host publishes a small `@cinatra-ai/host:cms-review` capability
// wrapping the three core seams, and `register.ts` binds it into this OPTIONAL
// `cmsReview` member.
//
// FENCE / SKEW POSTURE — byte-identity when off: the member is OPTIONAL. A host
// that predates S5 (or a standalone build) leaves it UNBOUND → the write path is
// byte-identical to pre-S5 (equivalent to the review fence being OFF). When bound
// the connector still consults `isReviewActive()` (the host's
// `isLifecycleReviewOrchestrationActive()` fence, DEFAULT-OFF) on every write:
// false → byte-identical pass-through, no capture, no extra fetch; true → the
// staged content write is CAPTURED and HELD before it can reach WordPress.
//
// IDENTITY: the connector passes ONLY the non-identity write coordinates (the
// pointer, the proposed content, the scope manifest, the resource + operation
// ids). The host derives org / run / actor from the active MCP request frame
// (exactly as `requireInstanceWriteAuthority` does) — identity is NEVER connector
// input.
// ---------------------------------------------------------------------------

/** The closed set of field paths the review authorizes the apply to change.
 * Stored on `cms_snapshot_targets.scope_manifest`; read BACK by the verifier so
 * the apply can never widen what the capture-time review fixed. */
export type CmsReviewScopeManifest = { paths: string[] };

/** The external-pointer identity of the CMS target being staged (the objects
 * `connector-ref` pointer shape the core capture reshapes via
 * `buildConnectorRefSnapshotArtifact`). Bare identity only — never the body. */
export type CmsReviewPointer = {
  url: string;
  connectorId: string;
  externalId: string;
  resolvedMimeType: string;
  state: "linked" | "stale" | "dangling";
  title?: string;
  excerpt?: string;
  remoteVersion?: string;
};

/** The resolved PROPOSED content the connector stages (exactly one of text /
 * bytesBase64 — the CMS field serialization is text). */
export type CmsReviewResolvedContent = {
  mime: string;
  text?: string;
  bytesBase64?: string;
  sizeBytes?: number;
  title?: string;
};

/** The non-identity coordinates of a staged CMS content write the connector
 * hands the host capture seam. */
export type CmsReviewCaptureInput = {
  pointer: CmsReviewPointer;
  /** The PROPOSED post state (the review target the human approves). */
  resolved: CmsReviewResolvedContent;
  /** ISO capture timestamp (audit/correlation). */
  capturedAt: string;
  scopeManifest: CmsReviewScopeManifest;
  /** The connector instance the write targets. */
  connectorInstance: string;
  /** `"post"` | `"page"` — the CMS resource class. */
  resourceType: string;
  /** The WordPress post/page id the write targets. */
  cmsResourceId: string;
  /** A CAS anchor over the CURRENT remote content (fetched before capture). */
  baseRemoteRevisionRef: string | null;
  /** Idempotency key on `cms_snapshot_targets` (unique) — a re-drive of the same
   * proposal reuses the same target row (the outbox-apply substrate). */
  operationId: string;
  title?: string;
};

/** The snapshot identity a capture returns — the review/verification pin. */
export type CmsReviewCaptureResult = {
  artifactId: string;
  snapshotRevisionId: string;
  snapshotTargetId: string;
  operationId: string;
  producedEventId: string | null;
};

/** Disposition of a captured staged write's external effect, disposition-aware
 * (a plain held/not-held cannot tell approve from reject — both are "not held",
 * but a rejected effect must NEVER be applied). Host binds it over
 * `isArtifactEffectHeld` + the gate's terminal disposition:
 *   - `held`     — the review gate is pending (or a repair is in flight); HOLD.
 *   - `approved` — the gate resolved `approve`; the effect is released → APPLY.
 *   - `rejected` — the gate resolved `reject`; the effect is tombstoned → REFUSE.
 *   - `ungated`  — the org lattice permitted the effect without a gate → APPLY.
 *   - `unknown`  — no capture / indeterminate → fail-closed REFUSE. */
export type CmsReviewDisposition = "held" | "approved" | "rejected" | "ungated" | "unknown";

/** The gate a captured staged write is holding on (for surfacing + the read-back
 * binding). */
export type CmsReviewGateRef = { gateId: string; runId: string } | null;

/** Post-apply read-back input — the connector re-reads the applied WordPress
 * content and hands the host the flat field map; the host re-captures + projects
 * + calls `recordCmsApplyVerification` against the STORED scope manifest. */
export type CmsReviewReadbackInput = {
  operationId: string;
  gateId: string;
  runId: string;
  /** The applied (post-apply) field values re-read from WordPress. */
  postApplyFields: Record<string, string>;
};

export type CmsReviewReadbackResult = {
  ok: boolean;
  outcome?: "verified" | "drifted" | "unmet";
  outOfScope?: string[];
  code?: string;
  error?: string;
};

/**
 * The host-bound S5 CMS content-review seam. OPTIONAL — unbound on a pre-S5 /
 * standalone host, where the write path stays byte-identical (fence OFF).
 */
export type CmsReviewSeam = {
  /** The host review-orchestration fence (`isLifecycleReviewOrchestrationActive()`,
   * DEFAULT-OFF). False → the connector write path is byte-identical to pre-S5. */
  isReviewActive: () => boolean;
  /** Capture the proposed CMS content as a held, gate-able review target (one Tx:
   * snapshot substrate + produced event + apply binding). Operation-idempotent on
   * `operationId` (a re-drive returns the existing binding without re-minting). */
  captureStagedWrite: (input: CmsReviewCaptureInput) => Promise<CmsReviewCaptureResult>;
  /** The disposition of a captured staged write's external effect (see
   * `CmsReviewDisposition`) — the connector's apply gate. */
  resolveDisposition: (input: {
    artifactId: string;
    snapshotRevisionId: string;
  }) => Promise<{ disposition: CmsReviewDisposition; gate: CmsReviewGateRef }>;
  /** Record the post-apply read-back verification against the STORED scope
   * manifest → `verified` / `drifted` / `unmet`. */
  recordApplyVerification: (input: CmsReviewReadbackInput) => Promise<CmsReviewReadbackResult>;
};

// ---------------------------------------------------------------------------
// Trusted-site mode — per-instance native read-injection opt-in (cinatra#2019).
//
// Trusted-site mode is the per-instance, default-OFF opt-in that lets the small
// descriptor-verified TRUSTED-READ set of a connected site reach the model
// provider through NATIVE injection (the provider calls those reads by name at
// runtime) instead of only through Cinatra's governed invoker. It is a strict
// SUBTRACTIVE eligibility computation that never denies or hides a governed
// tool; writes always stay on the governed path.
//
// The policy read/write + the dry-run preview are HOST-computed and published on
// the `@cinatra-ai/host:wordpress-mcp` service (the descriptor set, the
// fingerprint verifier, and the opt-in store all live host-side and never cross
// to the connector). The three members below are the connector's view of that
// surface; they are OPTIONAL for skew (a host — or a deps binding — that predates
// the surface leaves them unbound / resolves null) so the settings card renders
// the feature as unavailable rather than crashing, exactly like `invokeSiteTool`.
// ---------------------------------------------------------------------------

/** Per-instance trusted-site opt-in mode. `off` (also the absent-row default)
 * injects nothing; `trusted_site` opts the instance into native injection of the
 * descriptor-verified trusted-read set. */
export type NativeReadInjectionMode = "off" | "trusted_site";

/** The settings card's view of an instance's opt-in state. `consentStale` is
 * true when the row is `trusted_site` but the acknowledged disclosure / descriptor
 * set no longer matches what the host currently ships — the card then requires a
 * fresh acknowledgement before injection can resume (nothing injects while
 * stale). */
export type NativeReadInjectionPolicyView = {
  mode: NativeReadInjectionMode;
  consentStale?: boolean;
};

/** One wire-tool the verifier rejected, with a stable machine reason — surfaced
 * so an empty verified set is explainable to the admin. */
export type NativeReadInjectionEjection = { name: string; reason: string };

/** Dry-run preview of the trusted-read set for an instance against its CURRENT
 * advertised catalog. Carries no credentials and has no side effects (no audit);
 * used only to render the settings card's live preview. */
export type NativeReadInjectionExplain = {
  mode: NativeReadInjectionMode;
  consentStale: boolean;
  /** Wire-tool names that currently pass every verification conjunct. */
  verifiedNames: string[];
  ejected: NativeReadInjectionEjection[];
};

// ---------------------------------------------------------------------------
// Connected-site metadata — least-privilege warning (cinatra#2021 S6).
//
// The last-accepted, typed site metadata for a connected instance (WP/PHP
// version, plugin versions, the connected Application-Password user's role,
// permalink structure) — HOST-computed and published on the
// `@cinatra-ai/host:wordpress-mcp` service (`resolveConnectedSiteMetadata`,
// cinatra's `src/lib/connector-instance-site-metadata.ts`). The connector never
// reads the underlying store directly.
//
// DELIBERATE TRI-STATE, never a plain nullable: the host member never resolves
// null/undefined for "no signal" — a site that has never reported, or whose
// last report failed to parse, is `{status:"unknown", reason:...}`,
// structurally distinct from `{status:"known", ...}`. A binary present/absent
// shape would let "no signal" collapse into whatever a caller treats as the
// falsy default — the exact "silence reads as safety" failure this member
// exists to rule out for the least-privilege warning card
// (`wordpress-least-privilege-card.tsx`), which renders one of Administrator /
// Unknown / Non-administrator for EVERY instance, never nothing.
// ---------------------------------------------------------------------------

/** One connected instance's last-accepted site report. */
export type ConnectedSiteMetadataKnown = {
  status: "known";
  wpVersion: string;
  phpVersion: string;
  adapterVersion: string | null;
  abilitiesPluginVersion: string | null;
  /** The connected Application-Password user's primary role NAME (e.g.
   * `"administrator"`). Surfacing only — never an authorization input; and a
   * role NAME does not catch a custom role granting equivalent capabilities
   * under a different name (stated in the card's own copy, not just here). */
  connectedUserRole: string;
  permalinkStructure: "pretty" | "plain";
  receivedAt: string;
};
/** No signal, discriminated by WHY: `no_inventory` — the instance has never had
 * a report accepted (an older/uninstalled companion plugin, or the intake
 * route simply hasn't run for it yet) — INCLUDING when this host doesn't
 * publish `resolveConnectedSiteMetadata` at all (an older Cinatra; the deps
 * adapter in register.ts degrades to this same reason, never to a crash or a
 * silently-absent card). `unparseable` — a report exists but failed the
 * host's lenient re-parse (a legacy/malformed/future-shaped blob). Both render
 * the SAME neutral caution in the card — the distinction is copy-only, never a
 * trust signal. */
export type ConnectedSiteMetadataUnknown = {
  status: "unknown";
  reason: "no_inventory" | "unparseable";
};
export type ConnectedSiteMetadata = ConnectedSiteMetadataKnown | ConnectedSiteMetadataUnknown;

/** The host surface an external-MCP toolbox build is being assembled for —
 * structurally identical to the SDK `ExtensionToolboxBuildContext["surface"]`
 * union (cinatra#2019 S4). Only `"chat"` may ever emit native injection; the
 * host member re-refuses every other value independently of the toolbox's own
 * short-circuit (dual-layer surface enforcement). */
export type NativeReadInjectionSurface = "chat" | "agent_run" | "public_site_widget" | "session";

/** Input of {@link WordPressConnectorDeps.buildNativeReadInjection}. Carries
 * ONLY the non-identity coordinates — the host derives the trusted actor from
 * its ambient stores and the connector key from this connector's verified
 * package identity, never from these arguments. */
export type NativeReadInjectionBuildInput = {
  instanceId: string;
  surface: NativeReadInjectionSurface;
};

/** A host-verified native read-injection grant for one instance. By contract
 * `allowedTools` is a NON-EMPTY list of exact wire-tool names (the host returns
 * `null` instead of an empty grant, so an entry with a null/empty allowlist is
 * unrepresentable end-to-end) and `serverId` names the enrolled catalog server
 * the names were verified against (v1: always the default adapter server). */
export type NativeReadInjectionBuildResult = {
  serverId: string;
  allowedTools: string[];
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
  // ---- governed connector-instance invoker (cinatra#2017 S2; host-bound) ----
  /**
   * GOVERNED SITE-TOOL CALL — the connector half of the S2 governed invoker
   * (Plane C). `wordpress_site_tool_call` forwards its parsed coordinates here;
   * the host capability (`@cinatra-ai/host:connector-instance-invoker`) runs the
   * full authz → policy → classify → hook → execute → audit order and returns the
   * tool's unwrapped result.
   *
   * HOST-DERIVED IDENTITY (M6 / R2-B1): this dep carries NO `connectorKey` and NO
   * `kind` — the host derives `connectorKey` from THIS connector's verified
   * `packageName` inside the published capability, and derives the trusted actor
   * from the active MCP request frame. The connector passes only the non-identity
   * coordinates (`toolName`, `args`, optional `instanceId` / `serverId`); it can
   * neither assert nor select connector identity or caller identity.
   *
   * FAIL-CLOSED / SHIP-DARK: bound in `register.ts` by resolving the invoker
   * capability fail-loud (the identical posture the write-authority gate uses,
   * register.ts). A host that has not published the invoker (the destination-first
   * window before the core PR lands) makes this dep THROW on call rather than run
   * — and no live model surface reaches it in S2 anyway (delegated deny-by-default
   * + no agent-run allowlist), so the primitives stay dark until the S7 cutover.
   *
   * OPTIONAL for skew (matching `cmsReview` / `resolveWidgetActor`): a deps binding
   * that predates this member leaves it UNBOUND. The handler then DENIES with a
   * descriptive fail-closed error (never calls an ungoverned path) — so an old /
   * partial binding fails closed rather than crashing opaquely.
   */
  invokeSiteTool?: (input: SiteToolCallInput) => Promise<unknown>;
  /**
   * GOVERNED CATALOG LISTING — backs `wordpress_site_tools_list`. Same host-derived
   * identity + fail-closed posture as `invokeSiteTool`. The host runs the SAME pin
   * + live per-instance USE authority gate BEFORE any catalog read (codex B2), so
   * an unauthorized list yields a typed error, never a catalog. Returns the frozen
   * `tools_list` contract page (§3.5 + §10-A2): rows with schema, annotations,
   * derived class, policy status, cache age, and a revision-pinned cursor. OPTIONAL
   * for skew (same posture as `invokeSiteTool`).
   */
  listSiteTools?: (input: SiteToolsListInput) => Promise<SiteToolsListPage>;
  // ---- S5 CMS content-review seam (cinatra#2043; host-bound; OPTIONAL) ----
  /**
   * The S5 review-before-publish seam (see `CmsReviewSeam`). OPTIONAL: unbound on
   * a pre-S5 / standalone host → the staged content-write path is byte-identical
   * to pre-S5 (equivalent to the review fence being OFF). When bound, every
   * staged content write consults `isReviewActive()`; while the fence is ON the
   * write is captured as an immutable review target and HELD before it can reach
   * WordPress, and only an approved gate releases the apply. The host derives
   * org/run/actor from the MCP request frame — the connector passes only the
   * non-identity write coordinates.
   */
  cmsReview?: CmsReviewSeam;
  // ---- trusted-site native read-injection opt-in (cinatra#2019; host-bound; OPTIONAL) ----
  /**
   * Read the per-instance trusted-site opt-in state. Resolves `null` when the
   * host publication does not expose the trusted-site surface (a Cinatra version
   * that predates it) — the settings card then renders the feature as
   * unavailable. On a supporting host an absent row resolves `{mode:"off"}`.
   * OPTIONAL for skew (a deps binding that predates this member leaves it unbound).
   */
  readNativeInjectionPolicy?: (instanceId: string) => Promise<NativeReadInjectionPolicyView | null>;
  /**
   * Set the per-instance trusted-site opt-in mode. The caller chooses ONLY the
   * mode — the host stamps the acknowledged disclosure + descriptor-set version
   * from its OWN shipped constants at write time, so a connector or UI can never
   * assert or forge the acknowledged content. Org-admin-gated host-side (throws
   * on deny). OPTIONAL for skew.
   */
  setNativeInjectionMode?: (input: { instanceId: string; mode: NativeReadInjectionMode }) => Promise<void>;
  /**
   * Org-admin-gated DRY-RUN preview of the trusted-read set for an instance (no
   * credentials, no side effects, no audit) — the settings card's live-preview
   * source. Resolves `null` when the host does not expose the preview (an older
   * host); the card then states the preview is unavailable. OPTIONAL for skew.
   */
  explainNativeReadInjection?: (input: { instanceId: string }) => Promise<NativeReadInjectionExplain | null>;
  /**
   * HOST-COMPUTED native read-injection decision for ONE instance — the S4
   * trusted-site-mode gate the external-MCP toolbox consults per surviving
   * instance (cinatra#2019). The host owns the entire trust computation:
   * per-instance opt-in row (+ consent-stamp exactness), ambient-actor USE
   * authority, the post-enrollment catalog snapshots, the duplicate-anywhere
   * rule, and descriptor/fingerprint verification. None of that state crosses
   * to the connector — the member resolves to a grant (`{serverId,
   * allowedTools}`) or `null`, and `null` ALWAYS means "emit nothing for this
   * instance" (mode off, consent stale, refused surface, unverifiable catalog,
   * or an empty verified set alike — the connector never learns which; the
   * settings card's preview uses `explainNativeReadInjection` for that).
   *
   * FAIL-CLOSED / SKEW: OPTIONAL — unbound (a deps binding that predates this
   * member) or resolving `null` on a host that predates the surface both leave
   * the toolbox emitting nothing (M1 stays the only path). The host member
   * additionally re-refuses any `surface !== "chat"` independently of the
   * toolbox's own short-circuit, so a single-layer bug cannot widen the
   * surface matrix.
   */
  buildNativeReadInjection?: (
    input: NativeReadInjectionBuildInput,
  ) => Promise<NativeReadInjectionBuildResult | null>;
  /**
   * Resolve one instance's connected-site metadata (cinatra#2021 S6, D8) — the
   * least-privilege warning card's ONLY data source. Unlike
   * `readNativeInjectionPolicy` (which resolves `null` for "host doesn't
   * support this"), this member NEVER resolves null/undefined: it always
   * returns the discriminated `ConnectedSiteMetadata` tri-state, and the
   * register.ts adapter degrades an absent host member to
   * `{status:"unknown", reason:"no_inventory"}` — the same shape a
   * genuinely-silent site produces — rather than to null, so a skewed (older)
   * host can never make this member disappear into an optional the card could
   * `??`-collapse into silence. OPTIONAL here only for the same skew-binding
   * reason every other member in this block is (a deps object built by
   * something other than THIS repo's register.ts, e.g. a hand-built test
   * stub, may omit it) — register.ts's own binding always assigns it.
   */
  resolveConnectedSiteMetadata?: (instanceId: string) => Promise<ConnectedSiteMetadata>;
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
