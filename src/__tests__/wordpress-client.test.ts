// The relocated WordPress REST vendor client (cinatra#975 Wave 3 — the
// vendor-publish-direction inversion, epic #978). These tests pin the
// BEHAVIOR-PARITY invariants of the port out of core `src/lib/wordpress-api.ts`:
//   - host deps resolve LAZILY per call and FAIL LOUD when unresolved;
//   - the per-instance connection use-gate runs before EVERY Nango-authed
//     call with the EXACT import-era audit coordinates (`source:
//     "wordpress-api"`) and a deny propagates fail-closed (no fetch);
//   - the nango-save materializer path stays UNGATED (parity with the core
//     module's codex-reviewed comment);
//   - request/response logging routes through the #981 `ctx.logger.capture`
//     channel ("wordpress-api"), gated by the SAME persisted `loggingEnabled`
//     flag, and NEVER carries the application password / Nango credential;
//   - the webhook-subscription client keeps DIRECT Basic auth (no Nango) and
//     its 201/409-success + 404-idempotent-delete semantics;
//   - the local-dev unvalidated persist keeps its loopback hard-gate.

import { Buffer } from "node:buffer";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWordPressClient, WORDPRESS_API_CAPTURE_CHANNEL } from "../lib/wordpress-client";

type ProviderMap = Record<string, unknown>;

function buildCtx(impls: ProviderMap, opts: { captureDirectory?: string } = {}) {
  const capture = vi.fn(async () => {});
  const captureDirectory = vi.fn(() => opts.captureDirectory ?? "/data-root/logs/wp/wordpress-api");
  const resolveProviders = vi.fn((capability: string) =>
    impls[capability] !== undefined
      ? [{ packageName: "@cinatra-ai/host", impl: impls[capability] }]
      : [],
  );
  const ctx = {
    capabilities: { registerProvider: vi.fn(), resolveProviders },
    logger: {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      capture,
      captureDirectory,
    },
  } as never;
  return { ctx, capture, captureDirectory, resolveProviders };
}

/** In-memory connector-config capability (the host `connector-config` shape). */
function buildConfigStore(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  return {
    store,
    impl: {
      read: <T,>(connectorId: string, fallback: T): T =>
        (connectorId in store ? (store[connectorId] as T) : fallback),
      write: (connectorId: string, value: unknown) => {
        store[connectorId] = value;
      },
    },
  };
}

function buildNango(overrides: Record<string, unknown> = {}) {
  return {
    isNangoConfigured: vi.fn(() => true),
    providerConfigKeys: { wordpress: "cinatra-wordpress" },
    ensureNangoIntegration: vi.fn(async () => ({})),
    importNangoConnection: vi.fn(async () => ({})),
    getNangoConnection: vi.fn(async () => null),
    getNangoCredentials: vi.fn(async () => ({ username: "wp-admin", password: "app-pass-1" })),
    deleteNangoConnection: vi.fn(async () => {}),
    ...overrides,
  };
}

function buildGate(overrides: Record<string, unknown> = {}) {
  return {
    resolveOrSeedInstanceIdentity: vi.fn(async () => ({ identityResolved: true })),
    enforceInstanceConnectionUse: vi.fn(async () => ({ gated: true })),
    ...overrides,
  };
}

const INSTANCE = {
  id: "inst-1",
  name: "Site One",
  siteUrl: "https://site.example",
  username: "wp-admin",
  applicationPassword: "app-pass-1",
  providerConfigKey: "cinatra-wordpress",
  connectionId: "inst-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  orgId: "org-1",
  runBy: "user-1",
};

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("createWordPressClient — lazy resolution + fail-loud", () => {
  it("does NO host-service resolution at construction (probe-safe)", () => {
    const { ctx, resolveProviders } = buildCtx({});
    createWordPressClient(ctx);
    expect(resolveProviders).not.toHaveBeenCalled();
  });

  it("fails LOUD (names the capability) when connector-config is unresolved", () => {
    const { ctx } = buildCtx({});
    const client = createWordPressClient(ctx);
    expect(() => client.getWordPressAPISettings()).toThrowError(
      /@cinatra-ai\/host:connector-config.*not registered/,
    );
  });
});

describe("settings/status reads (connector-config-backed)", () => {
  it("normalizes rows and drops incomplete ones — the core getWordPressAPISettings behavior", () => {
    const config = buildConfigStore({
      wordpress: {
        instances: [
          { ...INSTANCE, siteUrl: "site.example/" },
          { id: "broken", name: "", siteUrl: "x", username: "u", applicationPassword: "p" },
        ],
      },
    });
    const { ctx } = buildCtx({ "@cinatra-ai/host:connector-config": config.impl });
    const client = createWordPressClient(ctx);
    const settings = client.getWordPressAPISettings();
    expect(settings.instances).toHaveLength(1);
    expect(settings.instances[0]).toMatchObject({
      id: "inst-1",
      siteUrl: "https://site.example",
      orgId: "org-1",
      runBy: "user-1",
    });
    expect(settings.loggingEnabled).toBe(true);
    expect(client.getWordPressAPIStatus()).toEqual({
      status: "connected",
      detail: "1 WordPress instance is configured.",
    });
    expect(client.readWordPressInstanceById("inst-1")?.name).toBe("Site One");
    expect(client.readWordPressInstanceById("nope")).toBeNull();
  });

  it("reports not_connected with the exact core detail copy when no instance is configured", () => {
    const config = buildConfigStore();
    const { ctx } = buildCtx({ "@cinatra-ai/host:connector-config": config.impl });
    const client = createWordPressClient(ctx);
    expect(client.getWordPressAPIStatus()).toEqual({
      status: "not_connected",
      detail: "Add one or more WordPress instances to publish blog post drafts.",
    });
  });

  it("exposes the #981 capture directory as the logging-settings directory", () => {
    const config = buildConfigStore();
    const { ctx, captureDirectory } = buildCtx(
      { "@cinatra-ai/host:connector-config": config.impl },
      { captureDirectory: "/managed/logs/pkg/wordpress-api" },
    );
    const client = createWordPressClient(ctx);
    expect(client.getWordPressLoggingSettings()).toEqual({
      enabled: true,
      directory: "/managed/logs/pkg/wordpress-api",
    });
    expect(captureDirectory).toHaveBeenCalledWith(WORDPRESS_API_CAPTURE_CHANNEL);
  });

  it("setWordPressInstanceBlogConnector throws on an unknown instance and persists a clear/set", () => {
    const config = buildConfigStore({ wordpress: { instances: [INSTANCE] } });
    const { ctx } = buildCtx({ "@cinatra-ai/host:connector-config": config.impl });
    const client = createWordPressClient(ctx);
    expect(() => client.setWordPressInstanceBlogConnector("missing", "x")).toThrowError(
      'WordPress instance "missing" not found.',
    );
    client.setWordPressInstanceBlogConnector("inst-1", "site-connector-a");
    expect(client.readWordPressInstanceById("inst-1")?.blogConnectorId).toBe("site-connector-a");
    client.setWordPressInstanceBlogConnector("inst-1", "default");
    expect(client.readWordPressInstanceById("inst-1")?.blogConnectorId).toBeUndefined();
  });
});

describe("Nango-authed content path — use-gate + credential resolution + capture", () => {
  it("createWordPressDraft: gates with the EXACT import-era audit coordinates, then writes with Nango Basic auth", async () => {
    const config = buildConfigStore({ wordpress: { instances: [INSTANCE] } });
    const nango = buildNango();
    const gate = buildGate();
    const { ctx, capture } = buildCtx({
      "@cinatra-ai/host:connector-config": config.impl,
      "nango-system": nango,
      "@cinatra-ai/host:instance-connection-gate": gate,
    });
    const client = createWordPressClient(ctx);
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 42, link: "https://site.example/?p=42" }, { status: 201 }));

    const result = await client.createWordPressDraft({
      instance: INSTANCE,
      payload: {
        title: "T", content: "C", excerpt: "E", status: "draft",
        slug: "never-sent", featured_media: 7,
      },
    });

    // Audit-source label parity: the exact core coordinates.
    expect(gate.enforceInstanceConnectionUse).toHaveBeenCalledWith({
      connectorKey: "wordpress",
      connectionId: "inst-1",
      binding: { orgId: "org-1", runBy: "user-1" },
      source: "wordpress-api",
    });
    expect(nango.getNangoCredentials).toHaveBeenCalledWith("cinatra-wordpress", "inst-1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://site.example/index.php?rest_route=%2Fwp%2Fv2%2Fposts");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("wp-admin:app-pass-1").toString("base64")}`,
    );
    // The create payload is the STRIPPED draft subset (no slug).
    expect(JSON.parse(init.body as string)).toEqual({
      title: "T", content: "C", excerpt: "E", status: "draft", featured_media: 7,
    });
    expect(result).toEqual({
      wordpressPostId: 42,
      publicUrl: "https://site.example/?p=42",
      adminUrl: "https://site.example/wp-admin/post.php?post=42&action=edit",
    });

    // Request/response capture on the "wordpress-api" channel — and no secret
    // material in any entry body.
    expect(capture).toHaveBeenCalledWith(
      WORDPRESS_API_CAPTURE_CHANNEL,
      expect.objectContaining({ label: "wordpress-create-draft", kind: "request" }),
    );
    expect(capture).toHaveBeenCalledWith(
      WORDPRESS_API_CAPTURE_CHANNEL,
      expect.objectContaining({ label: "wordpress-create-draft", kind: "response" }),
    );
    for (const call of capture.mock.calls as unknown[][]) {
      expect(JSON.stringify(call)).not.toContain("app-pass-1");
    }
  });

  it("a use-gate DENY propagates fail-closed — no WordPress request is made", async () => {
    const config = buildConfigStore({ wordpress: { instances: [INSTANCE] } });
    const gate = buildGate({
      enforceInstanceConnectionUse: vi.fn(async () => {
        throw new Error("connection use denied");
      }),
    });
    const { ctx } = buildCtx({
      "@cinatra-ai/host:connector-config": config.impl,
      "nango-system": buildNango(),
      "@cinatra-ai/host:instance-connection-gate": gate,
    });
    const client = createWordPressClient(ctx);
    await expect(
      client.readWordPressPostStatus({ instance: INSTANCE, wordpressPostId: 1 }),
    ).rejects.toThrowError("connection use denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips capture when the persisted loggingEnabled flag is false (same gate as the core module)", async () => {
    const config = buildConfigStore({
      wordpress: { instances: [INSTANCE], loggingEnabled: false },
    });
    const { ctx, capture } = buildCtx({
      "@cinatra-ai/host:connector-config": config.impl,
      "nango-system": buildNango(),
      "@cinatra-ai/host:instance-connection-gate": buildGate(),
    });
    const client = createWordPressClient(ctx);
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 9, status: "draft" }));
    await client.readWordPressPostStatus({ instance: INSTANCE, wordpressPostId: 9 });
    expect(capture).not.toHaveBeenCalled();
  });
});

describe("saveWordPressInstanceFromNangoConnection — the UNGATED materializer path", () => {
  it("never calls the use-gate (route machinery owns authorization) and preserves existing bindings", async () => {
    const existing = { ...INSTANCE, blogConnectorId: "site-connector-a" };
    const config = buildConfigStore({ wordpress: { instances: [existing] } });
    const nango = buildNango();
    const gate = buildGate();
    const { ctx } = buildCtx({
      "@cinatra-ai/host:connector-config": config.impl,
      "nango-system": nango,
      "@cinatra-ai/host:instance-connection-gate": gate,
    });
    const client = createWordPressClient(ctx);
    // Validation probes: /users/me then /settings.
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ name: "WP Admin" }))
      .mockResolvedValueOnce(jsonResponse({ title: "Site One Renamed" }));

    const saved = await client.saveWordPressInstanceFromNangoConnection({
      siteUrl: "https://site.example",
      providerConfigKey: "cinatra-wordpress",
      connectionId: "inst-1",
    });

    expect(gate.enforceInstanceConnectionUse).not.toHaveBeenCalled();
    expect(saved).toMatchObject({
      id: "inst-1",
      name: "Site One Renamed",
      blogConnectorId: "site-connector-a",
      orgId: "org-1",
      runBy: "user-1",
    });
    const persisted = client.readWordPressInstanceById("inst-1");
    expect(persisted?.name).toBe("Site One Renamed");
  });
});

describe("deleteWordPressInstance", () => {
  it("removes the Nango connection for a bound row, then drops the row", async () => {
    const config = buildConfigStore({ wordpress: { instances: [INSTANCE] } });
    const nango = buildNango();
    const { ctx } = buildCtx({
      "@cinatra-ai/host:connector-config": config.impl,
      "nango-system": nango,
    });
    const client = createWordPressClient(ctx);
    await client.deleteWordPressInstance("inst-1");
    expect(nango.deleteNangoConnection).toHaveBeenCalledWith("cinatra-wordpress", "inst-1");
    expect(client.getWordPressAPISettings().instances).toHaveLength(0);
  });
});

describe("cinatra/v1/webhooks subscription client — DIRECT Basic auth, no Nango", () => {
  const creds = { siteUrl: "https://site.example", username: "wp-admin", applicationPassword: "app-pass-1" };

  it("register treats 409 (already existed) as success and never touches nango/gate", async () => {
    const { ctx, resolveProviders } = buildCtx({});
    const client = createWordPressClient(ctx);
    const sub = { id: "s1", event_type: "post_published", target_url: "https://cb", post_types: [], created_at: "t" };
    fetchMock.mockResolvedValueOnce(jsonResponse(sub, { status: 409 }));
    const result = await client.registerWordPressWebhookSubscription(creds, {
      event_type: "post_published",
      target_url: "https://cb",
    });
    expect(result).toEqual(sub);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://site.example/index.php?rest_route=/cinatra/v1/webhooks");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("wp-admin:app-pass-1").toString("base64")}`,
    );
    // Direct Basic auth path: NO capability resolution at all.
    expect(resolveProviders).not.toHaveBeenCalled();
  });

  it("delete treats 404 as idempotent success", async () => {
    const { ctx } = buildCtx({});
    const client = createWordPressClient(ctx);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(client.deleteWordPressWebhookSubscription(creds, "s1")).resolves.toBeUndefined();
  });
});

describe("persistLocalDevWordPressInstanceUnvalidated — loopback hard-gate", () => {
  it("refuses a non-local site URL before touching any host service", async () => {
    const { ctx, resolveProviders } = buildCtx({});
    const client = createWordPressClient(ctx);
    await expect(
      client.persistLocalDevWordPressInstanceUnvalidated({
        siteUrl: "https://prod.example",
        username: "u",
        applicationPassword: "p",
      }),
    ).rejects.toThrowError("Unvalidated WordPress instance persistence is local-dev only.");
    expect(resolveProviders).not.toHaveBeenCalled();
  });

  it("persists a loopback row (no lastValidatedAt) and seeds the identity best-effort", async () => {
    const config = buildConfigStore();
    const nango = buildNango();
    const gate = buildGate();
    const { ctx } = buildCtx({
      "@cinatra-ai/host:connector-config": config.impl,
      "nango-system": nango,
      "@cinatra-ai/host:instance-connection-gate": gate,
    });
    const client = createWordPressClient(ctx);
    const row = await client.persistLocalDevWordPressInstanceUnvalidated({
      siteUrl: "http://localhost:8080",
      username: "dev",
      applicationPassword: "dev-pass",
    });
    expect(row.lastValidatedAt).toBeUndefined();
    expect(row.providerConfigKey).toBe("cinatra-wordpress");
    expect(nango.importNangoConnection).toHaveBeenCalledWith(
      expect.objectContaining({ connectorKey: "wordpress", connectionId: row.id }),
    );
    expect(gate.resolveOrSeedInstanceIdentity).toHaveBeenCalledWith({
      connectorKey: "wordpress",
      connectionId: row.id,
      binding: { orgId: undefined, runBy: undefined },
    });
    expect(client.readWordPressInstanceById(row.id)?.username).toBe("dev");
  });
});
