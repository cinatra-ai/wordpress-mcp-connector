// The WordPress REST vendor client — RELOCATED out of cinatra core
// (`src/lib/wordpress-api.ts`, cinatra#975 Wave 3: the vendor-publish-direction
// inversion, epic #978). This connector now OWNS the client; `register(ctx)`
// registers it back under the SAME host capability ids core publishes today
// (`@cinatra-ai/host:wordpress-content` + `@cinatra-ai/host:wordpress-mcp` —
// the provider FLIP), so the follow-up core-eviction PR can delete the core
// module and lazily resolve this provider at every former import site (the
// Wave-2 widget-auth precedent, wordpress-mcp-connector#56 / cinatra#1066).
//
// BEHAVIOR IS A FAITHFUL PORT of the core module. Host-only imports map to
// published capabilities / host ports, resolved LAZILY at call time
// (fail-loud when unresolved — never a silent no-op):
//   - `@/lib/database` connector-config blob      -> `@cinatra-ai/host:connector-config`
//   - `@/lib/nango-system` (credentials/import/…) -> the `nango-system` capability
//     (a RESERVED system capability — resolvable because this connector is
//     first-party; `CINATRA_NANGO_PROVIDER_CONFIG_KEYS` becomes the surface's
//     `providerConfigKeys` member)
//   - `@/lib/instance-connection-actor` seam      -> `@cinatra-ai/host:instance-connection-gate`
//     (cinatra#1077 — gate decision/audit/actor/identity storage STAY host-side;
//     authz stays core). The audit `source: "wordpress-api"` label is PRESERVED
//     EXACTLY (audit-source label parity).
//   - `node:fs` request/response log files        -> `ctx.logger.capture(...)`
//     (cinatra#981; extensions may not import `node:fs`, cinatra#979). The
//     capture CHANNEL is "wordpress-api"; the enabled/disabled gate stays the
//     same persisted `loggingEnabled` flag; string bodies keep the `{ raw }`
//     normalization. On a pre-#981 host (no `capture` member) an entry is
//     skipped — the same degradation as the flag being off, never a blocked
//     API call.
//   - `@/lib/fetch-with-timeout`                  -> the PURE COPY in
//     `./fetch-with-timeout` (no host state).
//
// EXPLICIT NON-MEMBERS kept host-side (this slice relocates ONLY
// `wordpress-api.ts`): the mcp-adapter probes/endpoint resolution
// (`@/lib/wordpress-mcp-connection`), the neutral `url-policy`, the
// actor-scoped instance listers + write authority (`@/lib/authz` — authz stays
// core), and the actor-gated credential-resolver path (`ActorContext` never
// crosses the extension boundary — see the #1077 contract note).
//
// SECRET BOUNDARY unchanged: application passwords / Nango credentials are
// never written to a log entry (the port keeps the core module's exact log
// bodies, which already excluded them).

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";
import { fetchWithTimeout } from "./fetch-with-timeout";

const PACKAGE_NAME = "@cinatra-ai/wordpress-mcp-connector";

/** The `ctx.logger.capture` channel the relocated client logs under (the
 * pre-relocation on-disk name `data/logs/wordpress-api` — the host's #981
 * capture layout nests it under the extension data root instead). */
export const WORDPRESS_API_CAPTURE_CHANNEL = "wordpress-api";

// ---------------------------------------------------------------------------
// Relocated public types (byte-identical to the core module's exports).
// ---------------------------------------------------------------------------

export type WordPressInstanceSettings = {
  id: string;
  name: string;
  siteUrl: string;
  username: string;
  applicationPassword: string;
  providerConfigKey?: string;
  connectionId?: string;
  lastValidatedAt?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Opt-in site-specific blog-connector binding. When unset, the
   * @cinatra-ai/blog-connector facade routes WordPress publishes
   * through the generic `defaultBlogConnector`. When set, the facade routes
   * through the named connector — the bundled site connector that registered
   * under that id (e.g. one carrying a site-specific page-builder layout).
   *
   * Persisted as part of the `connector_config:wordpress` JSON blob — no
   * schema migration. Both `saveWordPressInstance` and
   * `saveWordPressInstanceFromNangoConnection` preserve this field across
   * edit + reconnect-via-Nango flows.
   */
  blogConnectorId?: string;
  /**
   * Multi-tenant install→org binding (cinatra#274). Captured from the
   * configuring admin's session at save time:
   *   • orgId — the admin's active organization id,
   *   • runBy — the admin's user id (the OBO write actor for this install).
   * Resolved by `resolveContentEditorIdentityForInstance` so a host-initiated
   * content-editor write executes as THIS install's org/user instead of the
   * single-tenant default. Persisted as part of the wordpress
   * connector_config JSON blob — no schema migration. Both
   * `saveWordPressInstance` and `saveWordPressInstanceFromNangoConnection`
   * preserve these across edit + reconnect-via-Nango flows. Undefined on rows
   * saved before this change (pre-binding) and on session-less dev-auto-setup
   * persists — the resolver then falls back to single-tenant identity.
   */
  orgId?: string;
  runBy?: string;
};

type WordPressAPISettings = {
  instances: WordPressInstanceSettings[];
  loggingEnabled?: boolean;
};

type WordPressPostRecord = {
  id: number;
  link?: string;
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
  date?: string;
  title?: {
    raw?: string;
    rendered?: string;
  };
  content?: {
    raw?: string;
    rendered?: string;
  };
  excerpt?: {
    raw?: string;
    rendered?: string;
  };
  status?: string;
};

export type WordPressPostStatusRecord = {
  id: number;
  status: string;
  adminUrl: string;
  publicUrl?: string;
};

export type WordPressWritablePostPayload = {
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

type WordPressCreateDraftPayload = {
  title: string;
  content: string;
  excerpt: string;
  status: "draft";
  featured_media?: number;
};

export type WordPressPostListItem = {
  id: number;
  title: string;
  status: string;
  date: string;
  url: string;
};

export type WordPressWebhookSubscription = {
  id: string;
  event_type: string;
  target_url: string;
  post_types: string[];
  created_at: string;
};

// ---------------------------------------------------------------------------
// Local STRUCTURAL shapes of the host services this client resolves (the
// host-peer value-import ban: host services arrive as DATA through
// `ctx.capabilities`; the shapes are local so the connector compiles against
// ANY host SDK it can meet during skew).
// ---------------------------------------------------------------------------

/** The generic host connector-config KV service (`@cinatra-ai/host:connector-config`). */
type HostConnectorConfigShape = {
  read<T>(connectorId: string, fallback: T): T;
  write(connectorId: string, value: unknown): void;
};

/** The members of the `nango-system` capability surface this client uses
 * (structural subset of the SDK `NangoSystemSurface`). */
type NangoSystemShape = {
  isNangoConfigured(): boolean;
  /** The connector-authored provider-config key map (the former
   * `CINATRA_NANGO_PROVIDER_CONFIG_KEYS` const import). */
  providerConfigKeys: Readonly<Record<string, string>>;
  ensureNangoIntegration(input: {
    provider: string;
    providerConfigKey: string;
    displayName: string;
  }): Promise<unknown>;
  importNangoConnection(input: {
    connectorKey?: string;
    providerConfigKey: string;
    connectionId: string;
    credentials: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    endUser?: { id: string; email?: string; display_name?: string };
    tags?: Record<string, string>;
  }): Promise<unknown>;
  getNangoConnection(
    providerConfigKey: string,
    connectionId: string,
    options?: { forceRefresh?: boolean; refreshToken?: boolean },
  ): Promise<unknown>;
  getNangoCredentials(
    providerConfigKey: string,
    connectionId: string,
    options?: { forceRefresh?: boolean },
  ): Promise<unknown>;
  deleteNangoConnection(providerConfigKey: string, connectionId: string): Promise<void>;
};

/** The per-instance connection use-gate seam
 * (`@cinatra-ai/host:instance-connection-gate`, cinatra#1077). Gate decision,
 * audit rows, actor construction and identity storage stay HOST-side. */
type InstanceConnectionGateShape = {
  resolveOrSeedInstanceIdentity(input: {
    connectorKey: string;
    connectionId: string;
    binding?: { orgId?: string; runBy?: string };
  }): Promise<{ identityResolved: boolean }>;
  enforceInstanceConnectionUse(input: {
    connectorKey: string;
    connectionId: string;
    binding?: { orgId?: string; runBy?: string };
    source: string;
    runId?: string;
  }): Promise<{ gated: boolean }>;
};

// ---------------------------------------------------------------------------
// The client surface. Member names are EXACTLY the core module's export names
// so the follow-up core-eviction PR re-points mechanically.
// ---------------------------------------------------------------------------

export type WordPressClient = {
  getWordPressAPISettings(): WordPressAPISettings;
  getWordPressLoggingSettings(): { enabled: boolean; directory: string };
  getWordPressAPIStatus(): { status: "connected" | "not_connected"; detail: string };
  readWordPressInstanceById(instanceId: string): WordPressInstanceSettings | null;
  validateWordPressInstanceConnection(input: {
    siteUrl: string;
    username: string;
    applicationPassword: string;
  }): Promise<{ siteUrl: string; detectedSiteTitle?: string; detectedUserName?: string }>;
  saveWordPressInstance(input: {
    id?: string;
    siteUrl: string;
    username: string;
    applicationPassword?: string;
    blogConnectorId?: string;
    orgId?: string;
    runBy?: string;
  }): Promise<WordPressInstanceSettings>;
  persistLocalDevWordPressInstanceUnvalidated(input: {
    id?: string;
    siteUrl: string;
    username: string;
    applicationPassword: string;
    name?: string;
  }): Promise<WordPressInstanceSettings>;
  saveWordPressInstanceFromNangoConnection(input: {
    siteUrl: string;
    providerConfigKey: string;
    connectionId: string;
  }): Promise<WordPressInstanceSettings>;
  deleteWordPressInstance(instanceId: string): Promise<void>;
  setWordPressInstanceBlogConnector(instanceId: string, connectorId: string): void;
  saveWordPressLoggingSettings(enabled: boolean): Promise<void>;
  listWordPressInstances(): Promise<WordPressInstanceSettings[]>;
  readLatestPublishedWordPressPost(instance: WordPressInstanceSettings): Promise<{
    apiResponse: WordPressPostRecord;
    writableTemplate: WordPressWritablePostPayload;
  } | null>;
  listPublishedWordPressPosts(
    instance: WordPressInstanceSettings,
    options?: { offset?: number; limit?: number },
  ): Promise<{ items: WordPressPostListItem[]; total: number }>;
  listPublishedWordPressPages(
    instance: WordPressInstanceSettings,
    options?: { offset?: number; limit?: number },
  ): Promise<{ items: WordPressPostListItem[]; total: number }>;
  createWordPressDraft(input: {
    instance: WordPressInstanceSettings;
    payload: WordPressWritablePostPayload;
  }): Promise<{ wordpressPostId: number; publicUrl?: string; adminUrl: string }>;
  readWordPressPostStatus(input: {
    instance: WordPressInstanceSettings;
    wordpressPostId: number;
    postType?: string;
  }): Promise<WordPressPostStatusRecord>;
  deleteWordPressPost(input: {
    instance: WordPressInstanceSettings;
    wordpressPostId: number;
    postType?: string;
  }): Promise<{ deleted: boolean; previousStatus?: string }>;
  updateWordPressDraftMeta(input: {
    instance: WordPressInstanceSettings;
    wordpressPostId: number;
    meta: Record<string, unknown>;
  }): Promise<unknown>;
  /**
   * Resolve the Application-Password Basic auth for an instance (Nango
   * credential + the #1077 instance-connection use-gate + audit
   * `source:"wordpress-api"`). Exposed for the in-admin MCP content client's
   * auth seam (cinatra#1214 S1, bound as `buildWordPressBasicAuthHeader`) so the
   * in-admin get/update authenticate the MCP content server with the SAME
   * credential + use-gate + audit the direct REST client used. The carve-out
   * REST members call the same internal resolver.
   *
   * NOTE (cinatra#1214 S1): the direct-REST `readWordPressPost` /
   * `updateWordPressPost` helpers were DELETED — the in-admin get/update reroute
   * to the site's MCP integration (`callWordPressMcp`). No production caller
   * used those helpers outside the two in-admin primitives (org-wide grep).
   */
  resolveWordPressBasicAuth(instance: WordPressInstanceSettings): Promise<{
    username: string;
    applicationPassword: string;
    authHeader: string;
  }>;
  uploadWordPressMedia(input: {
    instance: WordPressInstanceSettings;
    imageBase64: string;
    imageMimeType: string;
    title: string;
  }): Promise<{ mediaId: number; sourceUrl?: string }>;
  listWordPressWebhookSubscriptions(
    instance: Pick<WordPressInstanceSettings, "siteUrl" | "username" | "applicationPassword">,
  ): Promise<WordPressWebhookSubscription[]>;
  registerWordPressWebhookSubscription(
    instance: Pick<WordPressInstanceSettings, "siteUrl" | "username" | "applicationPassword">,
    subscription: { event_type: string; target_url: string; post_types?: string[] },
  ): Promise<WordPressWebhookSubscription>;
  deleteWordPressWebhookSubscription(
    instance: Pick<WordPressInstanceSettings, "siteUrl" | "username" | "applicationPassword">,
    subscriptionId: string,
  ): Promise<void>;
};

/**
 * Build the connector-owned WordPress client. Construction does NO host-service
 * resolution and NO I/O (probe-safe — the loader's hot-update probe may build
 * it); every member resolves its host capability LAZILY at call time and
 * FAILS LOUD when one is unresolved (a missing host service must surface as a
 * descriptive error, never a silent fallback).
 */
export function createWordPressClient(ctx: ExtensionHostContext): WordPressClient {
  function hostService<T>(capability: string): T {
    // Prefer a provider registered by ANOTHER package (the host / the nango
    // gateway). This connector registers ITSELF under the wordpress ids in
    // `register(ctx)`, so a bare `[0]` could self-resolve; the client's own
    // upstream services are never self-registered, but keep the filter for
    // uniformity with `register.ts`'s hardened resolver.
    const providers = ctx.capabilities.resolveProviders(capability);
    const provider = providers.find((p) => p.packageName !== PACKAGE_NAME) ?? providers[0];
    if (!provider) {
      throw new Error(
        `${PACKAGE_NAME}: host service "${capability}" is not registered — ` +
          `the host boot wiring / owning system extension must activate before WordPress client calls.`,
      );
    }
    return provider.impl as T;
  }

  const connectorConfig = () =>
    hostService<HostConnectorConfigShape>("@cinatra-ai/host:connector-config");
  const nango = () => hostService<NangoSystemShape>("nango-system");
  const connectionGate = () =>
    hostService<InstanceConnectionGateShape>("@cinatra-ai/host:instance-connection-gate");

  function readSettings() {
    return connectorConfig().read<WordPressAPISettings>("wordpress", { instances: [] });
  }

  function writeSettings(value: WordPressAPISettings) {
    connectorConfig().write("wordpress", value);
  }

  function isWordPressLoggingEnabled() {
    return readSettings().loggingEnabled !== false;
  }

  /**
   * Request/response capture — the port of the core module's
   * `writeWordPressLogFile` (`data/logs/wordpress-api/<ts>__<label>__<kind>.json`)
   * onto the #981 host capture channel. Same enabled gate (the persisted
   * `loggingEnabled` flag), same `{ raw }` normalization for string bodies,
   * same label/kind filename semantics (the host builds the identical
   * `<timestamp>__<label>__<kind>.json` name and owns rotation/retention).
   * Entry bodies are already secret-free (the core module never logged
   * passwords/credentials); a pre-#981 host without `capture` skips the entry.
   */
  async function writeWordPressLogFile(input: {
    label: string;
    kind: "request" | "response";
    body: unknown;
  }) {
    if (!isWordPressLoggingEnabled()) {
      return;
    }
    const capture = ctx.logger.capture;
    if (!capture) {
      return;
    }
    const content = typeof input.body === "string" ? { raw: input.body } : input.body;
    await capture.call(ctx.logger, WORDPRESS_API_CAPTURE_CHANNEL, {
      label: input.label,
      kind: input.kind,
      body: content,
    });
  }

  function normalizeSiteUrl(value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
      return "";
    }

    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

    try {
      const url = new URL(withProtocol);
      url.pathname = url.pathname.replace(/\/+$/, "");
      url.hash = "";
      url.search = "";
      return url.toString().replace(/\/$/, "");
    } catch {
      return withProtocol.replace(/\/+$/, "");
    }
  }

  function buildAuthHeader(
    instance: Pick<WordPressInstanceSettings, "username" | "applicationPassword">,
  ) {
    return `Basic ${Buffer.from(`${instance.username}:${instance.applicationPassword}`).toString("base64")}`;
  }

  async function resolveWordPressBasicAuth(instance: WordPressInstanceSettings) {
    if (!nango().isNangoConfigured()) {
      throw new Error("Configure Nango first so WordPress API requests can authenticate through Nango.");
    }

    if (!instance.providerConfigKey || !instance.connectionId) {
      throw new Error("This WordPress instance is missing its Nango connection.");
    }

    // Owner-aware resolver routing (cinatra#967, W3 residue of #952/#953):
    // resolve (self-heal seeding when absent) the instance's identity row and
    // gate + audit this credential use through the W2 use-gate, with the
    // configuring admin (or an org-bound InternalWorker) threaded as the
    // acting actor. An instance whose identity cannot be resolved/seeded at
    // all (no {orgId, runBy} binding and no single-tenant default) falls back
    // to the pre-#967 ungated read — never a new regression. Across the
    // #1077 capability the semantics are IDENTICAL: a deny THROWS fail-closed
    // (awaited here), `{ gated: false }` is the import-era `null` fallback.
    // The audit `source` label stays EXACTLY "wordpress-api" (label parity).
    await connectionGate().enforceInstanceConnectionUse({
      connectorKey: "wordpress",
      connectionId: instance.connectionId,
      binding: { orgId: instance.orgId, runBy: instance.runBy },
      source: "wordpress-api",
    });

    const credentials = await resolveWordPressNangoCredentials(
      instance.providerConfigKey,
      instance.connectionId,
    );
    if (!credentials) {
      throw new Error("Unable to load the WordPress credentials from Nango.");
    }

    return {
      username: credentials.username,
      applicationPassword: credentials.password,
      authHeader: buildAuthHeader({
        username: credentials.username,
        applicationPassword: credentials.password,
      }),
    };
  }

  async function resolveWordPressNangoCredentials(providerConfigKey: string, connectionId: string) {
    const tokenCredentials = await nango().getNangoCredentials(providerConfigKey, connectionId);
    if (
      tokenCredentials &&
      typeof tokenCredentials === "object" &&
      "username" in tokenCredentials &&
      typeof tokenCredentials.username === "string" &&
      "password" in tokenCredentials &&
      typeof tokenCredentials.password === "string"
    ) {
      return {
        username: tokenCredentials.username,
        password: tokenCredentials.password,
      };
    }

    const connection = await nango().getNangoConnection(providerConfigKey, connectionId, {
      forceRefresh: false,
      refreshToken: false,
    });
    const connectionCredentials = (connection as
      | {
          credentials?: {
            type?: string;
            username?: string;
            password?: string;
          };
        }
      | null)?.credentials;

    if (
      connectionCredentials?.type === "BASIC" &&
      typeof connectionCredentials.username === "string" &&
      typeof connectionCredentials.password === "string"
    ) {
      return {
        username: connectionCredentials.username,
        password: connectionCredentials.password,
      };
    }

    return null;
  }

  function buildRESTBase(siteUrl: string) {
    const normalized = normalizeSiteUrl(siteUrl);
    return `${normalized}/index.php?rest_route=/wp/v2`;
  }

  function buildRESTEndpoint(siteUrl: string, route: string, params?: URLSearchParams) {
    const endpoint = new URL(buildRESTBase(siteUrl));
    const normalizedRoute = route.startsWith("/") ? route : `/${route}`;
    endpoint.searchParams.set("rest_route", `/wp/v2${normalizedRoute}`);

    if (params) {
      for (const [key, value] of params.entries()) {
        endpoint.searchParams.set(key, value);
      }
    }

    return endpoint.toString();
  }

  function extractRenderedText(value?: { raw?: string; rendered?: string }) {
    return value?.raw?.trim() || value?.rendered?.trim() || "";
  }

  function getWordPressAPISettings() {
    const settings = readSettings();
    return {
      instances: Array.isArray(settings.instances)
        ? settings.instances
            .map((instance) => ({
              id: String(instance.id ?? ""),
              name: String(instance.name ?? "").trim(),
              siteUrl: normalizeSiteUrl(String(instance.siteUrl ?? "")),
              username: String(instance.username ?? "").trim(),
              applicationPassword: String(instance.applicationPassword ?? "").trim(),
              providerConfigKey: typeof instance.providerConfigKey === "string" ? instance.providerConfigKey.trim() || undefined : undefined,
              connectionId: typeof instance.connectionId === "string" ? instance.connectionId.trim() || undefined : undefined,
              lastValidatedAt: typeof instance.lastValidatedAt === "string" ? instance.lastValidatedAt : undefined,
              createdAt: typeof instance.createdAt === "string" ? instance.createdAt : new Date().toISOString(),
              updatedAt: typeof instance.updatedAt === "string" ? instance.updatedAt : new Date().toISOString(),
              // Optional vendor-scoped blog-connector binding.
              // Persisted as part of the wordpress connector_config JSON blob.
              blogConnectorId: typeof instance.blogConnectorId === "string" ? instance.blogConnectorId.trim() || undefined : undefined,
              // Optional multi-tenant install→org binding (cinatra#274).
              orgId: typeof instance.orgId === "string" ? instance.orgId.trim() || undefined : undefined,
              runBy: typeof instance.runBy === "string" ? instance.runBy.trim() || undefined : undefined,
            }))
            .filter((instance) => instance.id && instance.name && instance.siteUrl && instance.username && instance.applicationPassword)
        : [],
      loggingEnabled: settings.loggingEnabled ?? true,
    } satisfies WordPressAPISettings;
  }

  function getWordPressLoggingSettings() {
    const settings = getWordPressAPISettings();
    return {
      enabled: settings.loggingEnabled !== false,
      // The former `WORDPRESS_API_LOG_DIRECTORY` (`data/logs/wordpress-api`
      // under the host cwd). Post-#981 the HOST owns the capture directory;
      // this is the read-only display value. "" on a pre-#981 host.
      directory: ctx.logger.captureDirectory?.(WORDPRESS_API_CAPTURE_CHANNEL) ?? "",
    };
  }

  function getWordPressAPIStatus() {
    const settings = getWordPressAPISettings();
    if (settings.instances.length > 0) {
      return {
        status: "connected" as const,
        detail:
          settings.instances.length === 1
            ? "1 WordPress instance is configured."
            : `${settings.instances.length} WordPress instances are configured.`,
      };
    }

    return {
      status: "not_connected" as const,
      detail: "Add one or more WordPress instances to publish blog post drafts.",
    };
  }

  function readWordPressInstanceById(instanceId: string) {
    return getWordPressAPISettings().instances.find((instance) => instance.id === instanceId) ?? null;
  }

  async function validateWordPressInstanceConnection(input: {
    siteUrl: string;
    username: string;
    applicationPassword: string;
  }) {
    const siteUrl = normalizeSiteUrl(input.siteUrl);
    const authHeader = buildAuthHeader({
      username: input.username,
      applicationPassword: input.applicationPassword,
    });

    await writeWordPressLogFile({
      label: "wordpress-users-me",
      kind: "request",
      body: {
        endpoint: buildRESTEndpoint(siteUrl, "/users/me", new URLSearchParams({ context: "edit" })),
        method: "GET",
        siteUrl,
        username: input.username,
      },
    });
    const userResponse = await fetchWithTimeout(buildRESTEndpoint(siteUrl, "/users/me", new URLSearchParams({ context: "edit" })), {
      method: "GET",
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    const userPayload = (await userResponse.json().catch(() => null)) as { name?: string; error?: { message?: string }; message?: string } | null;
    await writeWordPressLogFile({
      label: "wordpress-users-me",
      kind: "response",
      body: {
        status: userResponse.status,
        body: userPayload,
      },
    });
    if (!userResponse.ok) {
      const code =
        userPayload && typeof userPayload === "object" && "code" in userPayload && typeof userPayload.code === "string"
          ? userPayload.code
          : undefined;

      if (userResponse.status === 401 && code === "rest_not_logged_in") {
        throw new Error(
          "Nango connected successfully, but WordPress rejected the authenticated API request. Check that the WordPress username and application password are correct and that the server forwards the Authorization header to WordPress.",
        );
      }

      throw new Error(userPayload?.message || userPayload?.error?.message || "Unable to validate the WordPress connection.");
    }

    // Second probe: the core `wp/v2/settings` route. This proves the
    // application-password authenticates with `manage_options` (the route's
    // permission_callback) AND yields the real site title for `detectedSiteTitle`
    // — preserving the validation INTENT (reachable AND authenticates AND the
    // right WP instance). The earlier `wp/v2/administration` route this replaced
    // is registered by neither WordPress core nor the cinatra plugin, so it 404'd
    // in every environment and broke the save. We request `_fields=title` so the
    // response carries ONLY the title; `wp/v2/settings` otherwise returns site
    // PII (e.g. the admin email), and this validation logs response bodies.
    const settingsParams = new URLSearchParams({ _fields: "title" });
    await writeWordPressLogFile({
      label: "wordpress-settings",
      kind: "request",
      body: {
        // PII boundary: do not record the username in the diagnostic log.
        endpoint: buildRESTEndpoint(siteUrl, "/settings", settingsParams),
        method: "GET",
        siteUrl,
      },
    });
    const settingsResponse = await fetchWithTimeout(buildRESTEndpoint(siteUrl, "/settings", settingsParams), {
      method: "GET",
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    const settingsPayload = (await settingsResponse.json().catch(() => null)) as { title?: string; error?: { message?: string }; message?: string } | null;
    await writeWordPressLogFile({
      label: "wordpress-settings",
      kind: "response",
      body: {
        status: settingsResponse.status,
        // Log ONLY the title; `wp/v2/settings` returns site PII (admin email,
        // etc.) even though we requested `_fields=title`, so never persist the
        // raw body into the diagnostic log.
        body: { title: typeof settingsPayload?.title === "string" ? settingsPayload.title : undefined },
      },
    });
    if (!settingsResponse.ok) {
      if (settingsResponse.status === 401 || settingsResponse.status === 403) {
        throw new Error(
          "WordPress authenticated the user but rejected the site-settings request. The application password must belong to a user with administrator (manage_options) capability.",
        );
      }
      throw new Error(settingsPayload?.message || settingsPayload?.error?.message || "Unable to retrieve the WordPress site title.");
    }

    return {
      siteUrl,
      detectedSiteTitle:
        typeof settingsPayload?.title === "string" && settingsPayload.title.trim() ? settingsPayload.title.trim() : undefined,
      detectedUserName: typeof userPayload?.name === "string" && userPayload.name.trim() ? userPayload.name.trim() : undefined,
    };
  }

  async function saveWordPressInstance(input: {
    id?: string;
    siteUrl: string;
    username: string;
    applicationPassword?: string;
    /**
     * Optional override for the site-specific blog-connector binding. When
     * omitted, the existing instance's value is preserved (the
     * field round-trips through edit-save without callers having to re-pass it).
     */
    blogConnectorId?: string;
    /**
     * Multi-tenant install→org binding (cinatra#274), captured from the
     * configuring admin's session by `saveWordPressInstanceAction`. When omitted
     * (e.g. session-less dev-auto-setup), the existing instance's values are
     * preserved on edit, and left undefined on a new row — the resolver then
     * falls back to single-tenant identity. NEVER overwrites an existing binding
     * with undefined.
     */
    orgId?: string;
    runBy?: string;
  }) {
    const current = getWordPressAPISettings();
    const existing = input.id ? current.instances.find((instance) => instance.id === input.id) : null;
    const applicationPassword = input.applicationPassword?.trim() || existing?.applicationPassword || "";

    if (!applicationPassword) {
      throw new Error("Enter an application password to continue.");
    }

    const validated = await validateWordPressInstanceConnection({
      siteUrl: input.siteUrl,
      username: input.username.trim(),
      applicationPassword,
    });

    const timestamp = new Date().toISOString();
    const instanceId = input.id?.trim() || randomUUID();
    const nextBlogConnectorId =
      input.blogConnectorId !== undefined
        ? (input.blogConnectorId.trim() || undefined)
        : existing?.blogConnectorId;
    // Multi-tenant install→org binding (cinatra#274). Treat {orgId, runBy} as an
    // ATOMIC unit: only adopt the supplied binding when BOTH are present (never
    // mix a new runBy with a stale orgId, e.g. a session with no active org);
    // otherwise preserve the existing pair unchanged. A new row with an
    // incomplete supplied binding simply has no binding.
    const suppliedBinding =
      input.orgId?.trim() && input.runBy?.trim()
        ? { orgId: input.orgId.trim(), runBy: input.runBy.trim() }
        : undefined;
    const nextOrgId = suppliedBinding?.orgId ?? existing?.orgId;
    const nextRunBy = suppliedBinding?.runBy ?? existing?.runBy;
    const nextInstance: WordPressInstanceSettings = {
      id: instanceId,
      name: validated.detectedSiteTitle || validated.siteUrl,
      siteUrl: validated.siteUrl,
      username: input.username.trim(),
      applicationPassword,
      providerConfigKey: existing?.providerConfigKey ?? nango().providerConfigKeys.wordpress,
      connectionId: existing?.connectionId ?? instanceId,
      lastValidatedAt: timestamp,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      // Preserve site-specific blog-connector binding across edit-save (when
      // caller doesn't pass an override, inherit from existing). Without this,
      // the JSON-blob save path would silently drop the field on every edit.
      blogConnectorId: nextBlogConnectorId,
      // Multi-tenant install→org binding (cinatra#274), persisted atomically (see
      // suppliedBinding above): a complete supplied pair sets it; otherwise the
      // existing pair is inherited unchanged so an edit-without-session never
      // drops — nor half-overwrites — a captured binding.
      orgId: nextOrgId,
      runBy: nextRunBy,
    };

    writeSettings({
      loggingEnabled: current.loggingEnabled ?? true,
      instances: existing
        ? current.instances.map((instance) => (instance.id === nextInstance.id ? nextInstance : instance))
        : [nextInstance, ...current.instances],
    });

    await syncWordPressInstanceToNango(nextInstance).catch((err) => {
      // Best-effort Nango sync — the local instance row + the browser→cinatra
      // widget path do not depend on it, so a sync failure must not block the
      // save. But do NOT swallow SILENTLY: a Nango auth/format failure (e.g. a
      // `401 invalid_secret_key_format` from a misconfigured dev secret) would
      // otherwise surface only as a generic "credential unavailable" at write
      // time, masking the real cause. Log a host-owned label + the error message
      // (Axios messages are status-only — NEVER the credential).
      console.warn(
        "[wordpress-api] Nango credential sync failed — WordPress MCP writes will 401 until the credential is stored:",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    });

    return nextInstance;
  }

  /**
   * LOCAL-DEV-ONLY recovery persist for `dev-auto-setup`.
   *
   * `saveWordPressInstance` re-validates over the network before it persists —
   * it `GET`s `wp/v2/users/me` AND `wp/v2/settings`. The validation can still
   * throw on a local dev first wire (e.g. the credential is not yet propagated),
   * so the FIRST wire never lands a configured instance row,
   * which in turn blocks `dev-auto-setup` from pushing the browser widget config
   * (`cinatra_url`/`cinatra_api_key`/`cinatra_instance_id`). The browser→cinatra
   * widget direction does NOT depend on the cinatra→WP application-password being
   * fully validated, so this helper lets `dev-auto-setup` persist a COMPLETE
   * instance row from a locally minted application password WITHOUT the network
   * validation, then best-effort syncs Nango. The reuse-boot reconcile
   * (`ensureWordPressAppPasswordReconciled`) re-probes + re-validates on the next
   * boot, so `lastValidatedAt` is intentionally left unset here (no false
   * attribution).
   *
   * HARD-GATED to localhost: this NON-VALIDATING persist refuses any non-local
   * site URL. It must never become a general production affordance. (The host's
   * published `devPersistLocalInstanceUnvalidated` member ADDITIONALLY refuses
   * outside development mode — that host-side defense-in-depth stays with the
   * host publication.)
   *
   * SECRET BOUNDARY: never logs the username/application password.
   */
  async function persistLocalDevWordPressInstanceUnvalidated(input: {
    id?: string;
    siteUrl: string;
    username: string;
    applicationPassword: string;
    name?: string;
  }): Promise<WordPressInstanceSettings> {
    const siteUrl = normalizeSiteUrl(input.siteUrl);
    const host = (() => {
      try {
        return new URL(siteUrl).hostname.toLowerCase();
      } catch {
        return "";
      }
    })();
    if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
      throw new Error("Unvalidated WordPress instance persistence is local-dev only.");
    }

    const applicationPassword = input.applicationPassword.trim();
    if (!applicationPassword) {
      throw new Error("Enter an application password to continue.");
    }
    const username = input.username.trim();
    if (!username) {
      throw new Error("Enter a WordPress username to continue.");
    }

    const current = getWordPressAPISettings();
    const existing = input.id
      ? current.instances.find((instance) => instance.id === input.id)
      : current.instances.find((instance) => instance.siteUrl === siteUrl);

    const timestamp = new Date().toISOString();
    const instanceId = input.id?.trim() || existing?.id || randomUUID();
    const nextInstance: WordPressInstanceSettings = {
      id: instanceId,
      name: input.name?.trim() || existing?.name || siteUrl,
      siteUrl,
      username,
      applicationPassword,
      providerConfigKey: existing?.providerConfigKey ?? nango().providerConfigKeys.wordpress,
      connectionId: existing?.connectionId ?? instanceId,
      // lastValidatedAt intentionally omitted — this row was NOT network-validated.
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      blogConnectorId: existing?.blogConnectorId,
      // Preserve any existing multi-tenant install→org binding (cinatra#274).
      // This recovery persist has no session, so it never sets a new binding.
      orgId: existing?.orgId,
      runBy: existing?.runBy,
    };

    writeSettings({
      loggingEnabled: current.loggingEnabled ?? true,
      instances: existing
        ? current.instances.map((instance) => (instance.id === nextInstance.id ? nextInstance : instance))
        : [nextInstance, ...current.instances.filter((instance) => instance.siteUrl !== nextInstance.siteUrl)],
    });

    // Best-effort: let content writes resolve auth through Nango. Never throws.
    await syncWordPressInstanceToNango(nextInstance).catch((err) => {
      // Best-effort Nango sync — the local instance row + the browser→cinatra
      // widget path do not depend on it, so a sync failure must not block the
      // save. But do NOT swallow SILENTLY: a Nango auth/format failure (e.g. a
      // `401 invalid_secret_key_format` from a misconfigured dev secret) would
      // otherwise surface only as a generic "credential unavailable" at write
      // time, masking the real cause. Log a host-owned label + the error message
      // (Axios messages are status-only — NEVER the credential).
      console.warn(
        "[wordpress-api] Nango credential sync failed — WordPress MCP writes will 401 until the credential is stored:",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    });

    return nextInstance;
  }

  async function saveWordPressInstanceFromNangoConnection(input: {
    siteUrl: string;
    providerConfigKey: string;
    connectionId: string;
  }) {
    const current = getWordPressAPISettings();
    const existing = current.instances.find((instance) => instance.connectionId === input.connectionId);

    // NOT gated here (codex round-1 finding, reverting an earlier round-0
    // over-fix). This function is the host materializer the generic
    // `/api/nango/connections/save` route invokes DURING
    // `handleNangoConnectionSaveRequest`, BEFORE that route's own POST-save
    // `registerSavedConnectionIdentity` call registers the REAL session
    // {userId, activeOrganizationId} (and its PRE-save foreign-identity guard
    // already rejects a request that targets a connection registered to a
    // DIFFERENT owner/org). Gating here — even threading `existing`'s binding —
    // would self-heal-seed an identity from the single-tenant FALLBACK owner
    // whenever no identity row exists yet (a brand-new connection, or an old
    // pre-cinatra#274 row with no captured binding), racing the route's own
    // real-session registration that runs right after and conflicting with it
    // (a spurious 409 on a legitimate first save/reconnect). This call path is
    // ALREADY fully authorized by that surrounding route machinery — it is not
    // part of the w3-residue this module exists to close. Only
    // `resolveWordPressBasicAuth` (the content-editor read/write flows, which
    // genuinely bypass that route) gates in this file.
    const credentials = await resolveWordPressNangoCredentials(input.providerConfigKey, input.connectionId);

    if (!credentials) {
      throw new Error("Unable to load the WordPress credentials from Nango.");
    }

    const validated = await validateWordPressInstanceConnection({
      siteUrl: input.siteUrl,
      username: credentials.username,
      applicationPassword: credentials.password,
    });
    const timestamp = new Date().toISOString();
    const nextInstance: WordPressInstanceSettings = {
      id: existing?.id ?? randomUUID(),
      name: validated.detectedSiteTitle || validated.siteUrl,
      siteUrl: validated.siteUrl,
      username: credentials.username,
      applicationPassword: credentials.password,
      providerConfigKey: input.providerConfigKey,
      connectionId: input.connectionId,
      lastValidatedAt: timestamp,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      // Nango re-save path NEVER receives blogConnectorId (Nango knows nothing
      // about Cinatra's connector bindings). Preserve the existing value
      // unconditionally; otherwise a disconnect→reconnect flow would silently
      // drop the operator's site-connector binding and re-route the live site to
      // the generic path.
      blogConnectorId: existing?.blogConnectorId,
      // Same rationale for the multi-tenant install→org binding (cinatra#274):
      // Nango carries no Cinatra identity, so a reconnect must preserve the
      // existing {orgId, runBy} unconditionally rather than drop it.
      orgId: existing?.orgId,
      runBy: existing?.runBy,
    };

    writeSettings({
      loggingEnabled: current.loggingEnabled ?? true,
      instances: existing
        ? current.instances.map((instance) => (instance.id === nextInstance.id ? nextInstance : instance))
        : [nextInstance, ...current.instances.filter((instance) => instance.siteUrl !== nextInstance.siteUrl)],
    });

    return nextInstance;
  }

  async function deleteWordPressInstance(instanceId: string) {
    const current = getWordPressAPISettings();
    const existing = current.instances.find((instance) => instance.id === instanceId);
    if (existing?.providerConfigKey && existing.connectionId) {
      await nango().deleteNangoConnection(existing.providerConfigKey, existing.connectionId);
    }
    writeSettings({
      loggingEnabled: current.loggingEnabled ?? true,
      instances: current.instances.filter((instance) => instance.id !== instanceId),
    });
  }

  /**
   * Focused setter for the per-instance blog-connector binding. The full
   * `saveWordPressInstance` requires the
   * application password (and re-validates the connection over the network),
   * so the WordPress connection UI's connector-selector cannot reuse it.
   * This writes the `connector_config:wordpress` blob DIRECTLY (same
   * lossless JSON-blob storage; no schema migration, no network call).
   * Pass `connectorId === ""` (or "default") to clear the binding back to
   * the generic path.
   */
  function setWordPressInstanceBlogConnector(instanceId: string, connectorId: string): void {
    const current = getWordPressAPISettings();
    const normalized = connectorId.trim();
    const next =
      normalized && normalized !== "default" ? normalized : undefined;
    let found = false;
    const instances = current.instances.map((instance) => {
      if (instance.id !== instanceId) return instance;
      found = true;
      return { ...instance, blogConnectorId: next };
    });
    if (!found) {
      throw new Error(`WordPress instance "${instanceId}" not found.`);
    }
    writeSettings({
      loggingEnabled: current.loggingEnabled ?? true,
      instances,
    });
  }

  async function saveWordPressLoggingSettings(enabled: boolean) {
    writeSettings({
      ...readSettings(),
      loggingEnabled: enabled,
    });
  }

  async function listWordPressInstances() {
    return getWordPressAPISettings().instances.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async function readLatestPublishedWordPressPost(instance: WordPressInstanceSettings) {
    const auth = await resolveWordPressBasicAuth(instance);
    const params = new URLSearchParams({
      context: "edit",
      status: "publish",
      per_page: "1",
      orderby: "date",
      order: "desc",
    });
    await writeWordPressLogFile({
      label: "wordpress-latest-post",
      kind: "request",
      body: {
        endpoint: buildRESTEndpoint(instance.siteUrl, "/posts", params),
        method: "GET",
        siteUrl: instance.siteUrl,
        username: auth.username,
      },
    });
    const response = await fetchWithTimeout(buildRESTEndpoint(instance.siteUrl, "/posts", params), {
      method: "GET",
      headers: {
        Authorization: auth.authHeader,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    const payload = (await response.json().catch(() => null)) as Array<WordPressPostRecord> | { message?: string } | null;
    await writeWordPressLogFile({
      label: "wordpress-latest-post",
      kind: "response",
      body: {
        status: response.status,
        body: payload,
      },
    });
    if (!response.ok) {
      const message = !Array.isArray(payload) && payload?.message ? payload.message : "Unable to load the latest published WordPress post.";
      throw new Error(message);
    }

    const post = Array.isArray(payload) ? payload[0] : undefined;
    if (!post) {
      return null;
    }

    return {
      apiResponse: post,
      writableTemplate: buildWritableWordPressPostPayload(post),
    };
  }

  // ---------------------------------------------------------------------------
  // List published posts / pages — metadata-only, cursor-paginated
  // ---------------------------------------------------------------------------

  /**
   * Shared metadata-only, offset-paginated published-content lister. Posts and
   * pages differ ONLY by the REST collection route (`/posts` vs `/pages`) and
   * the capture label — the query params, the `x-wp-total` pagination read, and
   * the `{ id, title, status, date, url }` projection are identical. The
   * `listPublishedWordPressPosts` / `listPublishedWordPressPages` members are
   * thin wrappers so each stays a distinct, self-describing client method (and
   * the pages primitive routes to `/wp/v2/pages`, mirroring the read/update
   * post-type routing).
   */
  async function listPublishedWordPressContent(
    instance: WordPressInstanceSettings,
    options: { offset?: number; limit?: number },
    collection: { route: "/posts" | "/pages"; label: string; noun: string },
  ): Promise<{ items: WordPressPostListItem[]; total: number }> {
    const auth = await resolveWordPressBasicAuth(instance);
    const limit = Math.max(1, Math.min(100, options.limit ?? 10));
    const offset = Math.max(0, options.offset ?? 0);
    const params = new URLSearchParams({
      context: "edit",
      status: "publish",
      per_page: String(limit),
      offset: String(offset),
      orderby: "date",
      order: "desc",
      _fields: "id,title,status,date,link",
    });
    await writeWordPressLogFile({
      label: collection.label,
      kind: "request",
      body: {
        endpoint: buildRESTEndpoint(instance.siteUrl, collection.route, params),
        method: "GET",
        siteUrl: instance.siteUrl,
        username: auth.username,
        offset,
        limit,
      },
    });
    const response = await fetchWithTimeout(buildRESTEndpoint(instance.siteUrl, collection.route, params), {
      method: "GET",
      headers: {
        Authorization: auth.authHeader,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    const payload = (await response.json().catch(() => null)) as Array<WordPressPostRecord> | { message?: string } | null;
    const totalHeader = response.headers.get("x-wp-total");
    const total = totalHeader ? parseInt(totalHeader, 10) : 0;
    await writeWordPressLogFile({
      label: collection.label,
      kind: "response",
      body: { status: response.status, total, count: Array.isArray(payload) ? payload.length : 0 },
    });
    if (!response.ok) {
      const message = !Array.isArray(payload) && payload?.message
        ? payload.message
        : `Unable to list WordPress ${collection.noun}.`;
      throw new Error(message);
    }

    const rows = Array.isArray(payload) ? payload : [];
    const items: WordPressPostListItem[] = rows.map((post) => ({
      id: typeof post.id === "number" ? post.id : 0,
      title: extractRenderedText(post.title),
      status: typeof post.status === "string" ? post.status : "publish",
      date: typeof post.date === "string" ? post.date : "",
      url: typeof post.link === "string" ? post.link : "",
    }));
    return { items, total: Number.isFinite(total) ? total : items.length };
  }

  async function listPublishedWordPressPosts(
    instance: WordPressInstanceSettings,
    options: { offset?: number; limit?: number } = {},
  ): Promise<{ items: WordPressPostListItem[]; total: number }> {
    return listPublishedWordPressContent(instance, options, {
      route: "/posts",
      label: "wordpress-posts-list",
      noun: "posts",
    });
  }

  async function listPublishedWordPressPages(
    instance: WordPressInstanceSettings,
    options: { offset?: number; limit?: number } = {},
  ): Promise<{ items: WordPressPostListItem[]; total: number }> {
    return listPublishedWordPressContent(instance, options, {
      route: "/pages",
      label: "wordpress-pages-list",
      noun: "pages",
    });
  }

  function buildWritableWordPressPostPayload(post?: WordPressPostRecord | null): WordPressWritablePostPayload {
    return {
      title: extractRenderedText(post?.title),
      content: extractRenderedText(post?.content),
      excerpt: extractRenderedText(post?.excerpt),
      status: "draft",
      slug: typeof post?.slug === "string" && post.slug.trim() ? post.slug : undefined,
      author: typeof post?.author === "number" ? post.author : undefined,
      comment_status: post?.comment_status,
      ping_status: post?.ping_status,
      format: typeof post?.format === "string" && post.format.trim() ? post.format : undefined,
      sticky: typeof post?.sticky === "boolean" ? post.sticky : undefined,
      template: typeof post?.template === "string" && post.template.trim() ? post.template : undefined,
      categories: Array.isArray(post?.categories) ? post.categories.filter((value): value is number => typeof value === "number") : undefined,
      tags: Array.isArray(post?.tags) ? post.tags.filter((value): value is number => typeof value === "number") : undefined,
      meta: post?.meta && typeof post.meta === "object" ? post.meta : undefined,
      featured_media: typeof post?.featured_media === "number" ? post.featured_media : undefined,
    };
  }

  function buildCreateDraftPayload(payload: WordPressWritablePostPayload): WordPressCreateDraftPayload {
    return {
      title: payload.title,
      content: payload.content,
      excerpt: payload.excerpt,
      status: "draft",
      featured_media: typeof payload.featured_media === "number" ? payload.featured_media : undefined,
    };
  }

  async function createWordPressDraft(input: {
    instance: WordPressInstanceSettings;
    payload: WordPressWritablePostPayload;
  }) {
    const auth = await resolveWordPressBasicAuth(input.instance);
    const createPayload = buildCreateDraftPayload(input.payload);
    await writeWordPressLogFile({
      label: "wordpress-create-draft",
      kind: "request",
      body: {
        endpoint: buildRESTEndpoint(input.instance.siteUrl, "/posts"),
        method: "POST",
        siteUrl: input.instance.siteUrl,
        username: auth.username,
        body: createPayload,
      },
    });
    const response = await fetchWithTimeout(buildRESTEndpoint(input.instance.siteUrl, "/posts"), {
      method: "POST",
      headers: {
        Authorization: auth.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(createPayload),
      cache: "no-store",
    });

    const payload = (await response.json().catch(() => null)) as { id?: number; link?: string; message?: string } | null;
    await writeWordPressLogFile({
      label: "wordpress-create-draft",
      kind: "response",
      body: {
        status: response.status,
        body: payload,
      },
    });
    if (!response.ok || !payload?.id) {
      throw new Error(payload?.message || "Unable to create the WordPress draft.");
    }

    return {
      wordpressPostId: payload.id,
      publicUrl: payload.link,
      adminUrl: `${normalizeSiteUrl(input.instance.siteUrl)}/wp-admin/post.php?post=${payload.id}&action=edit`,
    };
  }

  async function readWordPressPostStatus(input: {
    instance: WordPressInstanceSettings;
    wordpressPostId: number;
    postType?: string;
  }) {
    const auth = await resolveWordPressBasicAuth(input.instance);
    // Pages live under /pages/{id}; posts under /posts/{id} (mirror the
    // read/update post-type routing so status is correct for pages).
    const restPath = input.postType === "page"
      ? `/pages/${input.wordpressPostId}`
      : `/posts/${input.wordpressPostId}`;
    await writeWordPressLogFile({
      label: "wordpress-post-status",
      kind: "request",
      body: {
        endpoint: buildRESTEndpoint(input.instance.siteUrl, restPath, new URLSearchParams({ context: "edit" })),
        method: "GET",
        siteUrl: input.instance.siteUrl,
        username: auth.username,
      },
    });

    const response = await fetchWithTimeout(
      buildRESTEndpoint(input.instance.siteUrl, restPath, new URLSearchParams({ context: "edit" })),
      {
        method: "GET",
        headers: {
          Authorization: auth.authHeader,
          Accept: "application/json",
        },
        cache: "no-store",
      },
    );

    const payload = (await response.json().catch(() => null)) as (WordPressPostRecord & { message?: string; code?: string }) | null;
    await writeWordPressLogFile({
      label: "wordpress-post-status",
      kind: "response",
      body: {
        status: response.status,
        body: payload,
      },
    });

    if (response.status === 404 || payload?.code === "rest_post_invalid_id") {
      return {
        id: input.wordpressPostId,
        status: "deleted",
        adminUrl: `${normalizeSiteUrl(input.instance.siteUrl)}/wp-admin/post.php?post=${input.wordpressPostId}&action=edit`,
        publicUrl: undefined,
      } satisfies WordPressPostStatusRecord;
    }

    if (!response.ok || !payload?.id) {
      throw new Error(payload?.message || "Unable to check the WordPress post status.");
    }

    return {
      id: payload.id,
      status: typeof payload.status === "string" && payload.status.trim() ? payload.status : "unknown",
      adminUrl: `${normalizeSiteUrl(input.instance.siteUrl)}/wp-admin/post.php?post=${payload.id}&action=edit`,
      publicUrl: payload.status === "publish" && typeof payload.link === "string" && payload.link.trim() ? payload.link : undefined,
    } satisfies WordPressPostStatusRecord;
  }

  async function deleteWordPressPost(input: {
    instance: WordPressInstanceSettings;
    wordpressPostId: number;
    postType?: string;
  }) {
    const auth = await resolveWordPressBasicAuth(input.instance);
    // Pages live under /pages/{id}; posts under /posts/{id} (mirror the
    // read/update post-type routing so the delete targets the right collection).
    const restPath = input.postType === "page"
      ? `/pages/${input.wordpressPostId}`
      : `/posts/${input.wordpressPostId}`;
    await writeWordPressLogFile({
      label: "wordpress-delete-post",
      kind: "request",
      body: {
        endpoint: buildRESTEndpoint(input.instance.siteUrl, restPath),
        method: "DELETE",
        siteUrl: input.instance.siteUrl,
        username: auth.username,
      },
    });

    const response = await fetchWithTimeout(buildRESTEndpoint(input.instance.siteUrl, restPath), {
      method: "DELETE",
      headers: {
        Authorization: auth.authHeader,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    const payload = (await response.json().catch(() => null)) as { deleted?: boolean; previous?: WordPressPostRecord; message?: string } | null;
    await writeWordPressLogFile({
      label: "wordpress-delete-post",
      kind: "response",
      body: {
        status: response.status,
        body: payload,
      },
    });

    if (!response.ok) {
      throw new Error(payload?.message || "Unable to delete the WordPress post.");
    }

    return {
      deleted: payload?.deleted === true,
      previousStatus: typeof payload?.previous?.status === "string" ? payload.previous.status : undefined,
    };
  }

  async function updateWordPressDraftMeta(input: {
    instance: WordPressInstanceSettings;
    wordpressPostId: number;
    meta: Record<string, unknown>;
  }) {
    const auth = await resolveWordPressBasicAuth(input.instance);
    await writeWordPressLogFile({
      label: "wordpress-update-draft-meta",
      kind: "request",
      body: {
        endpoint: buildRESTEndpoint(input.instance.siteUrl, `/posts/${input.wordpressPostId}`),
        method: "POST",
        siteUrl: input.instance.siteUrl,
        username: auth.username,
        body: {
          meta: input.meta,
        },
      },
    });

    const response = await fetchWithTimeout(buildRESTEndpoint(input.instance.siteUrl, `/posts/${input.wordpressPostId}`), {
      method: "POST",
      headers: {
        Authorization: auth.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        meta: input.meta,
      }),
      cache: "no-store",
    });

    const payload = (await response.json().catch(() => null)) as { id?: number; message?: string } | null;
    await writeWordPressLogFile({
      label: "wordpress-update-draft-meta",
      kind: "response",
      body: {
        status: response.status,
        body: payload,
      },
    });

    if (!response.ok || !payload?.id) {
      throw new Error(payload?.message || "Unable to update the WordPress draft template metadata.");
    }

    return payload;
  }

  // cinatra#1214 S1 — the direct-REST in-admin get/update helpers
  // (`updateWordPressPost` → `POST /wp/v2/(posts|pages)/{id}` and
  // `readWordPressPost` → `GET /wp/v2/(posts|pages)/{id}?context=edit`) were
  // DELETED. The in-admin `wordpress_post_get` / `wordpress_post_update`
  // primitives now reach WordPress content ONLY through the site's MCP
  // integration (`callWordPressMcp` → the plugin's `cinatra-post-get` /
  // `cinatra-post-update` tools), so no direct `/wp/v2/*` egress with a stored
  // credential remains on the in-admin path. The carve-out members
  // (createDraft / uploadMedia / updateDraftMeta / deletePost / readPostStatus /
  // listPublished*) keep their direct-REST path per the design §C carve-out.
  // `resolveWordPressBasicAuth` is now ALSO exposed (below, in the return) as
  // the MCP client's Basic-auth seam.

  function inferFileExtension(mimeType: string) {
    switch (mimeType) {
      case "image/png":
        return "png";
      case "image/webp":
        return "webp";
      case "image/gif":
        return "gif";
      default:
        return "jpg";
    }
  }

  async function uploadWordPressMedia(input: {
    instance: WordPressInstanceSettings;
    imageBase64: string;
    imageMimeType: string;
    title: string;
  }) {
    const auth = await resolveWordPressBasicAuth(input.instance);
    const filenameBase = input.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "blog-post-image";
    const filename = `${filenameBase}.${inferFileExtension(input.imageMimeType)}`;
    await writeWordPressLogFile({
      label: "wordpress-upload-media",
      kind: "request",
      body: {
        endpoint: buildRESTEndpoint(input.instance.siteUrl, "/media"),
        method: "POST",
        siteUrl: input.instance.siteUrl,
        username: auth.username,
        fileName: filename,
        mimeType: input.imageMimeType,
      },
    });
    const response = await fetchWithTimeout(buildRESTEndpoint(input.instance.siteUrl, "/media"), {
      method: "POST",
      headers: {
        Authorization: auth.authHeader,
        "Content-Type": input.imageMimeType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        Accept: "application/json",
      },
      body: Buffer.from(input.imageBase64, "base64"),
      cache: "no-store",
    });

    const payload = (await response.json().catch(() => null)) as { id?: number; source_url?: string; message?: string } | null;
    await writeWordPressLogFile({
      label: "wordpress-upload-media",
      kind: "response",
      body: {
        status: response.status,
        body: payload,
      },
    });
    if (!response.ok || !payload?.id) {
      throw new Error(payload?.message || "Unable to upload the featured image to WordPress.");
    }

    return {
      mediaId: payload.id,
      sourceUrl: payload.source_url,
    };
  }

  async function syncWordPressInstanceToNango(instance: WordPressInstanceSettings) {
    if (!nango().isNangoConfigured()) {
      return;
    }

    await nango().ensureNangoIntegration({
      provider: "private-api-basic",
      providerConfigKey: instance.providerConfigKey ?? nango().providerConfigKeys.wordpress,
      displayName: "WordPress API",
    });

    await nango().importNangoConnection({
      connectorKey: "wordpress",
      providerConfigKey: instance.providerConfigKey ?? nango().providerConfigKeys.wordpress,
      connectionId: instance.connectionId ?? instance.id,
      credentials: {
        type: "BASIC",
        username: instance.username,
        password: instance.applicationPassword,
      },
      metadata: {
        siteUrl: instance.siteUrl,
      },
      endUser: {
        id: instance.id,
        display_name: instance.name,
      },
      tags: {
        site_url: instance.siteUrl,
      },
    });

    // Instance-import seam (cinatra#967, W3 residue): seed the connection's
    // identity row NOW, at save time, so a new/reconnected instance is never
    // left to rely solely on the read-time self-heal in
    // `resolveWordPressBasicAuth`. Best-effort — a seeding failure (e.g. no
    // resolvable owner) must never block the save; the read-time gate
    // self-heals or falls back to the ungated legacy path exactly the same way.
    await connectionGate()
      .resolveOrSeedInstanceIdentity({
        connectorKey: "wordpress",
        connectionId: instance.connectionId ?? instance.id,
        binding: { orgId: instance.orgId, runBy: instance.runBy },
      })
      .catch((err) => {
        console.warn(
          "[wordpress-api] instance identity seeding failed (non-blocking):",
          err instanceof Error ? err.message : String(err),
        );
        return null;
      });
  }

  // ---------------------------------------------------------------------------
  // cinatra/v1/webhooks subscription client
  // Uses DIRECT Basic auth (instance.username + instance.applicationPassword),
  // NOT resolveWordPressBasicAuth(), because this must work in environments
  // without Nango configured.
  // URL form uses index.php?rest_route= so it works without pretty permalinks
  // (Pitfall 3).
  // ---------------------------------------------------------------------------

  // Builds the endpoint URL in index.php?rest_route=/cinatra/v1/webhooks form
  // (and /cinatra/v1/webhooks/{id} for single subscriptions) so it works on
  // WordPress sites without pretty permalinks enabled.
  function buildCinatraWebhooksEndpoint(siteUrl: string, subscriptionId?: string) {
    const normalized = normalizeSiteUrl(siteUrl);
    const route = subscriptionId
      ? `/cinatra/v1/webhooks/${encodeURIComponent(subscriptionId)}`
      : `/cinatra/v1/webhooks`;
    return `${normalized}/index.php?rest_route=${route}`;
  }

  function buildDirectBasicAuthHeader(
    instance: Pick<WordPressInstanceSettings, "username" | "applicationPassword">,
  ) {
    return `Basic ${Buffer.from(`${instance.username}:${instance.applicationPassword}`).toString("base64")}`;
  }

  async function listWordPressWebhookSubscriptions(
    instance: Pick<WordPressInstanceSettings, "siteUrl" | "username" | "applicationPassword">,
  ): Promise<WordPressWebhookSubscription[]> {
    const endpoint = buildCinatraWebhooksEndpoint(instance.siteUrl);
    const response = await fetchWithTimeout(endpoint, {
      method: "GET",
      headers: {
        Authorization: buildDirectBasicAuthHeader(instance),
        Accept: "application/json",
      },
      cache: "no-store",
    });

    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && "error" in payload && typeof (payload as { error: unknown }).error === "string"
          ? (payload as { error: string }).error
          : `WordPress returned HTTP ${response.status} while listing webhook subscriptions.`;
      throw new Error(message);
    }

    if (!Array.isArray(payload)) {
      return [];
    }
    return payload.filter(
      (item): item is WordPressWebhookSubscription =>
        !!item &&
        typeof item === "object" &&
        typeof (item as { id?: unknown }).id === "string" &&
        typeof (item as { event_type?: unknown }).event_type === "string" &&
        typeof (item as { target_url?: unknown }).target_url === "string",
    );
  }

  async function registerWordPressWebhookSubscription(
    instance: Pick<WordPressInstanceSettings, "siteUrl" | "username" | "applicationPassword">,
    subscription: {
      event_type: string;
      target_url: string;
      post_types?: string[];
    },
  ): Promise<WordPressWebhookSubscription> {
    const endpoint = buildCinatraWebhooksEndpoint(instance.siteUrl);
    const response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: {
        Authorization: buildDirectBasicAuthHeader(instance),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        event_type: subscription.event_type,
        target_url: subscription.target_url,
        post_types: subscription.post_types ?? [],
      }),
      cache: "no-store",
    });

    const payload = (await response.json().catch(() => null)) as unknown;

    // 201 = newly created, 409 = already existed — both are "success" from Cinatra's POV.
    if (response.status === 201 || response.status === 409) {
      if (
        payload &&
        typeof payload === "object" &&
        typeof (payload as { id?: unknown }).id === "string"
      ) {
        return payload as WordPressWebhookSubscription;
      }
      throw new Error("WordPress accepted the subscription but returned an unexpected body.");
    }

    const message =
      payload && typeof payload === "object" && "error" in payload && typeof (payload as { error: unknown }).error === "string"
        ? (payload as { error: string }).error
        : `WordPress returned HTTP ${response.status} while registering the webhook subscription.`;
    throw new Error(message);
  }

  async function deleteWordPressWebhookSubscription(
    instance: Pick<WordPressInstanceSettings, "siteUrl" | "username" | "applicationPassword">,
    subscriptionId: string,
  ): Promise<void> {
    const endpoint = buildCinatraWebhooksEndpoint(instance.siteUrl, subscriptionId);
    const response = await fetchWithTimeout(endpoint, {
      method: "DELETE",
      headers: {
        Authorization: buildDirectBasicAuthHeader(instance),
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (response.status === 404) {
      // Idempotent — treat already-gone as success.
      return;
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as unknown;
      const message =
        payload && typeof payload === "object" && "error" in payload && typeof (payload as { error: unknown }).error === "string"
          ? (payload as { error: string }).error
          : `WordPress returned HTTP ${response.status} while deleting the webhook subscription.`;
      throw new Error(message);
    }
  }

  return {
    getWordPressAPISettings,
    getWordPressLoggingSettings,
    getWordPressAPIStatus,
    readWordPressInstanceById,
    validateWordPressInstanceConnection,
    saveWordPressInstance,
    persistLocalDevWordPressInstanceUnvalidated,
    saveWordPressInstanceFromNangoConnection,
    deleteWordPressInstance,
    setWordPressInstanceBlogConnector,
    saveWordPressLoggingSettings,
    listWordPressInstances,
    readLatestPublishedWordPressPost,
    listPublishedWordPressPosts,
    listPublishedWordPressPages,
    createWordPressDraft,
    readWordPressPostStatus,
    deleteWordPressPost,
    updateWordPressDraftMeta,
    resolveWordPressBasicAuth,
    uploadWordPressMedia,
    listWordPressWebhookSubscriptions,
    registerWordPressWebhookSubscription,
    deleteWordPressWebhookSubscription,
  };
}
