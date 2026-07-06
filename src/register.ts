// The wordpress connector's `register(ctx)` server entry.
//
// Transport-DI inversion (cinatra#151 Stage 3): the host no longer statically
// imports `registerWordPressConnector` — this entry binds the connector's
// host deps AT ACTIVATION by adapting the per-concern host services published
// in the capability registry (`@cinatra-ai/host:*` — mcp-pagination,
// content-editor-dispatch, wordpress-mcp, and — cinatra#172 Stage H3 — the
// post/media content surface wordpress-content). Every adapter member resolves
// its host service LAZILY at call time, so activation order against the
// host's boot imports never matters.
//
// Registration-only (no I/O) — safe under required-extension-activation's
// prod-boot arming, and probe-safe (the hot-update probe's `resolveProviders`
// reads stay live, so a probe-bound deps slot resolves identically to an
// activation-bound one). Imports stay LEAF-only (`./deps`): the package index
// re-exports React components that must stay OUT of the serverEntry graph.
//
// SDK imports here are TYPE-ONLY (host-peer value-import ban): the host
// services arrive as DATA through `ctx.capabilities`; the capability ids are
// inlined string literals; the NEW per-concern service shapes are local
// structural types so the connector compiles against ANY host SDK it can
// meet during skew.

import { randomBytes, randomUUID } from "node:crypto";

import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";
import { registerWordPressConnector, type WordPressConnectorDeps } from "./deps";
import {
  createWordPressClient,
  type WordPressClient,
  type WordPressInstanceSettings,
} from "./lib/wordpress-client";

const PACKAGE_NAME = "@cinatra-ai/wordpress-mcp-connector";

// Local STRUCTURAL shapes of the per-concern host services this connector
// adapts into its deps slot.
type HostMcpPaginationShape = {
  decodeCursor: WordPressConnectorDeps["decodeCursor"];
  buildListPage: WordPressConnectorDeps["buildListPage"];
};
type HostContentEditorDispatchShape = {
  dispatch: WordPressConnectorDeps["dispatchContentEditor"];
};
type HostWordPressMcpShape = {
  listInstances: WordPressConnectorDeps["listMcpInstances"];
  probeAdapter: WordPressConnectorDeps["probeMcpAdapter"];
  resolveServerUrl: WordPressConnectorDeps["resolveMcpServerUrl"];
  isPrivateUrl: WordPressConnectorDeps["isPrivateUrl"];
  deleteInstance: WordPressConnectorDeps["deleteInstance"];
  // Connection/instance-admin read (cinatra#172 Stage H3).
  getAPIStatus: WordPressConnectorDeps["getApiStatus"];
};
// Post/media content surface (cinatra#172 Stage H3) — the host publishes it
// under a SEPARATE capability id from the connection-focused wordpress-mcp
// service so connection admin and content CRUD never evolve under one id.
type HostWordPressContentShape = {
  createDraft: WordPressConnectorDeps["createDraft"];
  readPost: WordPressConnectorDeps["readPost"];
  readPostStatus: WordPressConnectorDeps["readPostStatus"];
  listPublishedPosts: WordPressConnectorDeps["listPublishedPosts"];
  deletePost: WordPressConnectorDeps["deletePost"];
  uploadMedia: WordPressConnectorDeps["uploadMedia"];
  updateDraftMeta: WordPressConnectorDeps["updateDraftMeta"];
  updatePost: WordPressConnectorDeps["updatePost"];
};
// Per-user / per-connector-instance WRITE-authority host service (cinatra#409).
// The host publishes ONE shared `instance-write-authority` service
// (`HostInstanceWriteAuthorityService`, capability id below). The host binds an
// impl that derives the trusted actor from the active MCP request frame
// (mcpRequestContextStorage), DENIES fail-closed when no userId+orgId resolve,
// then enforces (1) PER-INSTANCE org-binding == the trusted actor's org (so a
// forged/cross-org instanceId is denied) and (2) the connector-package
// requireConnectorAuthority policy. `selectForConnector(kind)` maps the
// connector KIND to BOTH the package id and the instance reader HOST-SIDE — the
// connector names only its OWN static kind ("wordpress"), never a package id or
// another caller-chosen selector. The host THROWS on an unknown kind, so the
// package whose policy is evaluated is always host-controlled, never caller
// input. `requireWrite` resolves void on allow / throws on deny; the connector
// forwards only instanceId+primitiveName, identity is NEVER connector-supplied.
type HostInstanceWriteAuthorityShape = {
  selectForConnector(kind: string): {
    requireWrite: (input: { instanceId: string; primitiveName: string; sourceType?: string }) => Promise<void>;
  };
};

/** Lazy per-concern host-service resolution (fail-loud on a missing service —
 * the host boot wiring publishes these before any connector call runs).
 * Prefers a provider registered by ANOTHER package: since cinatra#975 Wave 3
 * this connector ALSO registers itself under the wordpress-mcp /
 * wordpress-content ids (the relocated client, provider-flip below), so a bare
 * `[0]` could self-resolve depending on registration order. The host's own
 * publication stays the deps-slot source until the core-eviction follow-up;
 * the `?? providers[0]` fallback keeps deps working on a post-eviction host
 * where only this connector's provider remains. */
function hostService<T>(ctx: ExtensionHostContext, capability: string): T {
  const providers = ctx.capabilities.resolveProviders(capability);
  const provider = providers.find((p) => p.packageName !== PACKAGE_NAME) ?? providers[0];
  if (!provider) {
    throw new Error(
      `${PACKAGE_NAME}: host service "${capability}" is not registered — ` +
        `the host boot wiring (register-host-connector-services) must run before connector calls.`,
    );
  }
  return provider.impl as T;
}

/** Build the host-bound deps from the per-concern host services. Every member
 * resolves LAZILY at call time — constructing this object does no I/O and no
 * resolution (probe-safe). */
function buildHostBoundDeps(ctx: ExtensionHostContext): WordPressConnectorDeps {
  const pagination = () => hostService<HostMcpPaginationShape>(ctx, "@cinatra-ai/host:mcp-pagination");
  const contentEditor = () =>
    hostService<HostContentEditorDispatchShape>(ctx, "@cinatra-ai/host:content-editor-dispatch");
  const wordpressMcp = () => hostService<HostWordPressMcpShape>(ctx, "@cinatra-ai/host:wordpress-mcp");
  const wordpressContent = () =>
    hostService<HostWordPressContentShape>(ctx, "@cinatra-ai/host:wordpress-content");
  // cinatra#409 — resolved lazily at call time; fail-loud if the host did not
  // publish it (an old host) so the writer denies rather than writes unguarded.
  const writeAuthority = () =>
    hostService<HostInstanceWriteAuthorityShape>(ctx, "@cinatra-ai/host:instance-write-authority");
  return {
    decodeCursor: (cursor) => pagination().decodeCursor(cursor),
    buildListPage: <T,>(items: T[], total: number, offset: number, limit: number) =>
      pagination().buildListPage(items, total, offset, limit),
    dispatchContentEditor: (input) => contentEditor().dispatch(input),
    // Boundary fix (cinatra#978): the content-editor A2A URL override arrives
    // through the granted `settings` host port (key "content_editor_a2a_url"),
    // never from a direct process.env read in connector code. A host that
    // cannot serve the port (skew) degrades to `null` → the handler's static
    // default URL, the same posture as an unset override.
    resolveContentEditorAgentUrl: async () => {
      try {
        const value = await ctx.settings.get<string>("content_editor_a2a_url");
        return typeof value === "string" && value.length > 0 ? value : null;
      } catch {
        return null;
      }
    },
    deleteInstance: (id) => wordpressMcp().deleteInstance(id),
    listMcpInstances: () => wordpressMcp().listInstances(),
    probeMcpAdapter: (instance) => wordpressMcp().probeAdapter(instance),
    resolveMcpServerUrl: (siteUrl) => wordpressMcp().resolveServerUrl(siteUrl),
    isPrivateUrl: (url) => wordpressMcp().isPrivateUrl(url),
    // Connection/instance-admin read (cinatra#172 Stage H3).
    getApiStatus: () => wordpressMcp().getAPIStatus(),
    // Post/media content surface (cinatra#172 Stage H3). The WRITERS are only
    // ever reached through the host's MCP dispatch + actor gating (see the
    // host service's TRUST note; posture identical to the static imports).
    createDraft: (input) => wordpressContent().createDraft(input),
    readPost: (input) => wordpressContent().readPost(input),
    readPostStatus: (input) => wordpressContent().readPostStatus(input),
    listPublishedPosts: (instance, options) => wordpressContent().listPublishedPosts(instance, options),
    deletePost: (input) => wordpressContent().deletePost(input),
    uploadMedia: (input) => wordpressContent().uploadMedia(input),
    updateDraftMeta: (input) => wordpressContent().updateDraftMeta(input),
    updatePost: (input) => wordpressContent().updatePost(input),
    // cinatra#409 — per-user write authorization. Binds to the connector's OWN
    // static KIND ("wordpress") — the host maps it to BOTH the package id and the
    // instance reader; the connector forwards only instanceId+primitiveName, and
    // the host impl derives the trusted actor from the MCP request frame and
    // throws on deny / null actor (fail-closed). If the host service is absent
    // (old host), hostService() throws → here the throw surfaces as a REJECTED
    // promise (async member) so the awaiting writer denies (never writes
    // unguarded), the same as a real deny. The kind is host-allowlist-validated,
    // never caller-supplied.
    requireInstanceWriteAuthority: async (input) =>
      writeAuthority().selectForConnector("wordpress").requireWrite(input),
  };
}

// The generic host connector-config KV service
// (`@cinatra-ai/host:connector-config`) — the per-connector key/value store the
// host publishes. The widget-auth store (below) persists through it.
type HostConnectorConfigShape = {
  read<T>(connectorId: string, fallback: T): T;
  write(connectorId: string, value: unknown): void;
};

// --- widget auth-config store (cinatra#975 Wave 2 — vendor-publish-direction
// inversion, epic #978) -------------------------------------------------------
// This connector now OWNS the widget-auth store: it INVERTED out of core
// (`@/lib/wordpress-widget-auth`) and is registered as the
// `@cinatra-ai/host:wordpress-widget-auth` capability (in register() below). The
// store persists the UUID-pair widget api key + webhook secret under
// `connector_config:wordpress_widget_auth` THROUGH the host connector-config
// capability. read/generate are SYNC — behavior-identical to the former core
// store. The request-time origin/token/CORS validation is unchanged: it lives in
// the host's generic widget-stream auth (via the cinatra.widgetStream.auth
// manifest entry), NOT here; only the AUTH-CONFIG storage + minting moved.
const WIDGET_AUTH_CONFIG_KEY = "wordpress_widget_auth";

type WidgetAuthConfig = {
  apiKey: string;
  webhookSecret: string;
  generatedAt: string;
};

type WordPressWidgetAuthProvider = {
  read(): WidgetAuthConfig | null;
  /** WRITER — mint + persist a fresh key + webhook secret (invalidates the old). */
  generate(): WidgetAuthConfig;
};

/** Build the widget-auth store impl this connector registers. Every member
 * resolves the host connector-config capability LAZILY at call time (no
 * resolution at construction — probe-safe), then reads/writes the single config
 * row. Fail-loud: a host that never published connector-config throws through
 * hostService(). */
function buildWidgetAuthProvider(ctx: ExtensionHostContext): WordPressWidgetAuthProvider {
  const connectorConfig = () =>
    hostService<HostConnectorConfigShape>(ctx, "@cinatra-ai/host:connector-config");
  return {
    read: () => connectorConfig().read<WidgetAuthConfig | null>(WIDGET_AUTH_CONFIG_KEY, null),
    generate: () => {
      const config: WidgetAuthConfig = {
        apiKey: `${randomUUID()}-${randomUUID()}`,
        webhookSecret: randomBytes(32).toString("hex"),
        generatedAt: new Date().toISOString(),
      };
      connectorConfig().write(WIDGET_AUTH_CONFIG_KEY, config);
      return config;
    },
  };
}

// --- relocated WordPress REST vendor client (cinatra#975 Wave 3 —
// vendor-publish-direction inversion, epic #978) ------------------------------
// This connector now OWNS the core `src/lib/wordpress-api.ts` client
// (`./lib/wordpress-client`) and registers it back under the SAME two host
// capability ids core publishes today — the provider FLIP (the Wave-2
// widget-auth precedent, #56 / cinatra#1066). Until the core-eviction
// follow-up merges, the host's own publication keeps serving consumers (both
// providers coexist in the registry, keyed by packageName); afterwards core
// resolves THIS provider (pinned to the manifest-derived owner) at every
// former `@/lib/wordpress-api` import site.
//
// SPLIT BY CONCERN, mirroring the host's publication exactly:
//   - `@cinatra-ai/host:wordpress-content` — the post/media CONTENT surface
//     (the full existing `HostWordPressContentService` member set).
//   - `@cinatra-ai/host:wordpress-mcp` — the connection/instance-admin
//     members the client backs, PLUS the additive client members core's
//     former import sites need (save/validate/logging/latest-post/
//     nango-materialize/dev-persist), named EXACTLY like the core exports so
//     the eviction re-point is mechanical. Additive members are resolved
//     STRUCTURALLY by consumers (the HostExternalMcpRegistrySetupSurface
//     precedent) — no packages/sdk-extensions change.
//
// EXPLICIT NON-MEMBERS (stay host-published on the wordpress-mcp id): the
// mcp-adapter probes / endpoint resolution / url-policy
// (`@/lib/wordpress-mcp-connection` — not this slice), the actor-scoped
// `listAuthorizedInstances` + write authority (authz stays core, #975), and
// the dev-MODE guard on the `dev*` members (`assertDevSetupHostOnly` is
// host-side defense-in-depth; the client's dev persist keeps its intrinsic
// loopback hard-gate).

/** The wordpress-content instance-row input (structural mirror of the SDK
 * `WordPressInstanceRowShape` — row timestamps OPTIONAL for skew). */
type WordPressContentInstanceInput = Omit<WordPressInstanceSettings, "createdAt" | "updatedAt"> & {
  createdAt?: string;
  updatedAt?: string;
};

/** Contract rows keep timestamps OPTIONAL for skew while the client requires
 * them — host rows always carry them, so the epoch fallback only guards
 * hand-built rows from a skewed companion (byte-for-byte the host's
 * `asWordPressInstanceRow` adapter in register-host-connector-services.ts). */
function asWordPressInstanceRow(instance: WordPressContentInstanceInput): WordPressInstanceSettings {
  return {
    ...instance,
    createdAt: instance.createdAt ?? new Date(0).toISOString(),
    updatedAt: instance.updatedAt ?? new Date(0).toISOString(),
  };
}

/** The `@cinatra-ai/host:wordpress-content` provider impl — the full existing
 * contract member set, backed by the connector-owned client. */
function buildWordPressContentProvider(client: WordPressClient) {
  return {
    createDraft: (input: { instance: WordPressContentInstanceInput; payload: Parameters<WordPressClient["createWordPressDraft"]>[0]["payload"] }) =>
      client.createWordPressDraft({ instance: asWordPressInstanceRow(input.instance), payload: input.payload }),
    readPost: (input: { instance: WordPressContentInstanceInput; wordpressPostId: number; postType?: string }) =>
      client.readWordPressPost({
        instance: asWordPressInstanceRow(input.instance),
        wordpressPostId: input.wordpressPostId,
        postType: input.postType,
      }),
    readPostStatus: (input: { instance: WordPressContentInstanceInput; wordpressPostId: number }) =>
      client.readWordPressPostStatus({
        instance: asWordPressInstanceRow(input.instance),
        wordpressPostId: input.wordpressPostId,
      }),
    listPublishedPosts: (
      instance: WordPressContentInstanceInput,
      options?: { offset?: number; limit?: number },
    ) => client.listPublishedWordPressPosts(asWordPressInstanceRow(instance), options),
    deletePost: (input: { instance: WordPressContentInstanceInput; wordpressPostId: number }) =>
      client.deleteWordPressPost({
        instance: asWordPressInstanceRow(input.instance),
        wordpressPostId: input.wordpressPostId,
      }),
    uploadMedia: (input: {
      instance: WordPressContentInstanceInput;
      imageBase64: string;
      imageMimeType: string;
      title: string;
    }) => client.uploadWordPressMedia({ ...input, instance: asWordPressInstanceRow(input.instance) }),
    updateDraftMeta: (input: {
      instance: WordPressContentInstanceInput;
      wordpressPostId: number;
      meta: Record<string, unknown>;
    }) =>
      client.updateWordPressDraftMeta({
        instance: asWordPressInstanceRow(input.instance),
        wordpressPostId: input.wordpressPostId,
        meta: input.meta,
      }),
    updatePost: (input: {
      instance: WordPressContentInstanceInput;
      wordpressPostId: number;
      postType?: string;
      fields: Parameters<WordPressClient["updateWordPressPost"]>[0]["fields"];
    }) =>
      client.updateWordPressPost({
        instance: asWordPressInstanceRow(input.instance),
        wordpressPostId: input.wordpressPostId,
        postType: input.postType,
        fields: input.fields,
      }),
  };
}

/** The `@cinatra-ai/host:wordpress-mcp` provider impl — the client-backed
 * connection/instance-admin members (contract names) + the ADDITIVE full-client
 * members (core export names) the core-eviction follow-up re-points to. */
function buildWordPressInstanceAdminProvider(client: WordPressClient) {
  return {
    // --- client-backed contract members (`HostWordPressMcpService` names) ---
    listInstances: () => client.getWordPressAPISettings().instances,
    getAPIStatus: () => client.getWordPressAPIStatus(),
    getAPISettings: () => client.getWordPressAPISettings(),
    readInstanceById: (id: string) => client.readWordPressInstanceById(id),
    // Instance hard-delete. Wrapped to discard any return (contract is
    // Promise<void>) — identical to the host publication's wrapper.
    deleteInstance: async (id: string) => {
      await client.deleteWordPressInstance(id);
    },
    webhookSubscriptions: {
      list: client.listWordPressWebhookSubscriptions,
      register: client.registerWordPressWebhookSubscription,
      remove: client.deleteWordPressWebhookSubscription,
    },
    // --- additive relocated-client members (core `@/lib/wordpress-api`
    //     export names; consumed structurally by the eviction follow-up) ---
    validateWordPressInstanceConnection: client.validateWordPressInstanceConnection,
    saveWordPressInstance: client.saveWordPressInstance,
    saveWordPressInstanceFromNangoConnection: client.saveWordPressInstanceFromNangoConnection,
    persistLocalDevWordPressInstanceUnvalidated: client.persistLocalDevWordPressInstanceUnvalidated,
    setWordPressInstanceBlogConnector: client.setWordPressInstanceBlogConnector,
    saveWordPressLoggingSettings: client.saveWordPressLoggingSettings,
    getWordPressLoggingSettings: client.getWordPressLoggingSettings,
    listWordPressInstances: client.listWordPressInstances,
    readLatestPublishedWordPressPost: client.readLatestPublishedWordPressPost,
  };
}

export function register(ctx: ExtensionHostContext): void {
  // Transport-DI inversion: bind the host deps slot. Always-bind (the
  // bind-if-absent skew guard was swept once every host this connector can
  // meet is post-cutover): re-activation — incl. a hot-update digest swap —
  // re-binds fresh lazy resolvers, so a stale deps object can never outlive
  // its digest.
  registerWordPressConnector(buildHostBoundDeps(ctx));

  // cinatra#975 Wave 2 — register the connector-owned widget-auth store as the
  // `@cinatra-ai/host:wordpress-widget-auth` capability. The publish direction
  // inverted: the host no longer implements/publishes it; core's connect/token +
  // wordpress-webhook surfaces AND this connector's own dev-setup hook resolve
  // it lazily from the registry. Building the impl does no host-service
  // resolution (probe-safe) — read/generate resolve connector-config at call time.
  ctx.capabilities.registerProvider("@cinatra-ai/host:wordpress-widget-auth", {
    packageName: PACKAGE_NAME,
    impl: buildWidgetAuthProvider(ctx),
  });

  // cinatra#975 Wave 3 — register the connector-owned WordPress REST client
  // (the relocated core `@/lib/wordpress-api`) under the SAME two ids the host
  // publishes today (see the module comment above the provider builders).
  // Building the client + both impls does NO host-service resolution and NO
  // I/O (probe-safe); every member resolves connector-config / nango-system /
  // instance-connection-gate lazily at call time and fails loud when one is
  // unresolved. Until the core-eviction follow-up, the host's own publication
  // keeps serving consumers — these providers coexist keyed by packageName.
  const wordpressClient = createWordPressClient(ctx);
  ctx.capabilities.registerProvider("@cinatra-ai/host:wordpress-content", {
    packageName: PACKAGE_NAME,
    impl: buildWordPressContentProvider(wordpressClient),
  });
  ctx.capabilities.registerProvider("@cinatra-ai/host:wordpress-mcp", {
    packageName: PACKAGE_NAME,
    impl: buildWordPressInstanceAdminProvider(wordpressClient),
  });
}
