// The wordpress connector's `register(ctx)` server entry.
//
// Transport-DI inversion (cinatra#151 Stage 3): the host no longer statically
// imports `registerWordPressConnector` — this entry binds the connector's
// host deps AT ACTIVATION by adapting the per-concern host services published
// in the capability registry (`@cinatra-ai/host:*` — mcp-pagination,
// content-editor-dispatch, wordpress-mcp). Every adapter member resolves its
// host service LAZILY at call time, so activation order against the host's
// boot imports never matters.
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
  return {
    decodeCursor: (cursor) => pagination().decodeCursor(cursor),
    buildListPage: <T,>(items: T[], total: number, offset: number, limit: number) =>
      pagination().buildListPage(items, total, offset, limit),
    dispatchContentEditor: (input) => contentEditor().dispatch(input),
    deleteInstance: (id) => wordpressMcp().deleteInstance(id),
    listMcpInstances: () => wordpressMcp().listInstances(),
    probeMcpAdapter: (instance) => wordpressMcp().probeAdapter(instance),
    resolveMcpServerUrl: (siteUrl) => wordpressMcp().resolveServerUrl(siteUrl),
    isPrivateUrl: (url) => wordpressMcp().isPrivateUrl(url),
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
