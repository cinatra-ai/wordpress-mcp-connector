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
};

/**
 * The instance fields the external-MCP toolbox needs (structural subset of the
 * host's `WordPressInstanceSettings` — `@/lib/wordpress-api` stays host-side).
 */
export type WordPressMcpInstance = {
  id: string;
  name: string;
  siteUrl: string;
  username: string;
  applicationPassword: string;
};

/** Probe verdict for a WP mcp-adapter endpoint (host-bound cached probe). */
export type WordPressMcpProbeStatus = "registered" | "not_installed" | "auth_error" | "unreachable";

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
