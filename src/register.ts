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

import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";
import { registerWordPressConnector, type WordPressConnectorDeps } from "./deps";

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
 * the host boot wiring publishes these before any connector call runs). */
function hostService<T>(ctx: ExtensionHostContext, capability: string): T {
  const provider = ctx.capabilities.resolveProviders(capability)[0];
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

export function register(ctx: ExtensionHostContext): void {
  // Transport-DI inversion: bind the host deps slot. Always-bind (the
  // bind-if-absent skew guard was swept once every host this connector can
  // meet is post-cutover): re-activation — incl. a hot-update digest swap —
  // re-binds fresh lazy resolvers, so a stale deps object can never outlive
  // its digest.
  registerWordPressConnector(buildHostBoundDeps(ctx));
}
