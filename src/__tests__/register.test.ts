// `register(ctx)` shape — the Stage 3 transport-DI inversion plus the
// cinatra#172 Stage H3 extension: the connector binds its host deps slot
// itself (always-bind since the post-cutover sweep, lazy per-call
// host-service resolution) over mcp-pagination, content-editor-dispatch, the
// EXTENDED `@cinatra-ai/host:wordpress-mcp` (connection/instance-admin reads)
// and the NEW `@cinatra-ai/host:wordpress-content` (post/media CRUD).
// Leaf-graph pin: the entry imports ONLY ./deps. Slot-timing coverage
// (cinatra#172 finding 8): the slot is populated AT ACTIVATION — before the
// settings page / MCP handlers resolve it — and an unbound slot fails LOUD
// naming the package and the registration step.

import { describe, expect, it, vi, beforeEach } from "vitest";

import { register } from "../register";
import {
  getWordPressDeps,
  listInstancesSorted,
  registerWordPressConnector,
  _resetWordPressDepsForTests,
} from "../deps";

function activateWithServices(impls: Record<string, unknown>) {
  const resolveProviders = vi.fn((capability: string) =>
    impls[capability] !== undefined
      ? [{ packageName: "@cinatra-ai/host", impl: impls[capability] }]
      : [],
  );
  const ctx = {
    capabilities: { registerProvider: () => {}, resolveProviders },
  } as never;
  register(ctx);
  return { resolveProviders };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetWordPressDepsForTests();
});

describe("register(ctx) — transport-DI deps binding (Stage 3)", () => {
  it("binds the deps slot when absent, resolving host services LAZILY at call time", async () => {
    const decodeCursor = vi.fn(() => 3);
    const deleteInstance = vi.fn(async () => {});
    const { resolveProviders } = activateWithServices({
      "@cinatra-ai/host:mcp-pagination": { decodeCursor, buildListPage: vi.fn() },
      "@cinatra-ai/host:wordpress-mcp": {
        listInstances: vi.fn(() => []),
        probeAdapter: vi.fn(),
        resolveServerUrl: vi.fn(),
        isPrivateUrl: vi.fn(),
        deleteInstance,
      },
    });
    // No host-service resolution happened at registration (probe-safe).
    expect(resolveProviders).not.toHaveBeenCalled();
    expect(getWordPressDeps().decodeCursor("x")).toBe(3);
    await getWordPressDeps().deleteInstance("id-1");
    expect(deleteInstance).toHaveBeenCalledWith("id-1");
  });

  it("REPLACES a pre-bound deps slot (always-bind — a hot-update digest swap re-binds fresh resolvers)", () => {
    const sentinel = vi.fn(() => 42);
    registerWordPressConnector({ decodeCursor: sentinel } as never);
    activateWithServices({ "@cinatra-ai/host:mcp-pagination": { decodeCursor: () => 0 } });
    expect(getWordPressDeps().decodeCursor("x")).toBe(0);
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("binds the connection-admin + content members LAZILY against wordpress-mcp AND wordpress-content (cinatra#172 Stage H3)", async () => {
    const getAPIStatus = vi.fn(() => ({ status: "connected" as const, detail: "1 instance" }));
    const createDraft = vi.fn(async () => ({ wordpressPostId: 10, adminUrl: "a" }));
    const readPostStatus = vi.fn(async () => ({ id: 10, status: "draft", adminUrl: "a" }));
    const listPublishedPosts = vi.fn(async () => ({ items: [], total: 0 }));
    const listPublishedPages = vi.fn(async () => ({ items: [], total: 0 }));
    const deletePost = vi.fn(async () => ({ deleted: true }));
    const uploadMedia = vi.fn(async () => ({ mediaId: 7 }));
    const updateDraftMeta = vi.fn(async () => ({ id: 10 }));
    const { resolveProviders } = activateWithServices({
      "@cinatra-ai/host:wordpress-mcp": {
        listInstances: vi.fn(() => []),
        probeAdapter: vi.fn(),
        resolveServerUrl: vi.fn(),
        isPrivateUrl: vi.fn(),
        deleteInstance: vi.fn(),
        getAPIStatus,
      },
      "@cinatra-ai/host:wordpress-content": {
        createDraft,
        readPostStatus,
        listPublishedPosts,
        listPublishedPages,
        deletePost,
        uploadMedia,
        updateDraftMeta,
      },
    });
    // Slot bound at activation, BEFORE any settings-page render / MCP handler
    // resolves it — and with NO host-service resolution yet (probe-safe).
    expect(resolveProviders).not.toHaveBeenCalled();

    expect(getWordPressDeps().getApiStatus()).toEqual({ status: "connected", detail: "1 instance" });

    const instance = { id: "wp-1", name: "S", siteUrl: "https://wp.example", username: "u", applicationPassword: "p" };
    const payload = { title: "T", content: "C", excerpt: "", status: "draft" as const };
    await expect(getWordPressDeps().createDraft({ instance, payload })).resolves.toMatchObject({
      wordpressPostId: 10,
    });
    expect(createDraft).toHaveBeenCalledWith({ instance, payload });

    await expect(getWordPressDeps().readPostStatus({ instance, wordpressPostId: 10 })).resolves.toEqual({
      id: 10,
      status: "draft",
      adminUrl: "a",
    });

    await expect(
      getWordPressDeps().listPublishedPosts(instance, { offset: 0, limit: 10 }),
    ).resolves.toEqual({ items: [], total: 0 });
    expect(listPublishedPosts).toHaveBeenCalledWith(instance, { offset: 0, limit: 10 });

    await expect(
      getWordPressDeps().listPublishedPages(instance, { offset: 0, limit: 10 }),
    ).resolves.toEqual({ items: [], total: 0 });
    expect(listPublishedPages).toHaveBeenCalledWith(instance, { offset: 0, limit: 10 });

    await expect(getWordPressDeps().deletePost({ instance, wordpressPostId: 10 })).resolves.toEqual({
      deleted: true,
    });

    const media = { instance, imageBase64: "QUJD", imageMimeType: "image/png", title: "img" };
    await expect(getWordPressDeps().uploadMedia(media)).resolves.toEqual({ mediaId: 7 });
    expect(uploadMedia).toHaveBeenCalledWith(media);

    await expect(
      getWordPressDeps().updateDraftMeta({ instance, wordpressPostId: 10, meta: { k: "v" } }),
    ).resolves.toEqual({ id: 10 });

    // In-admin readPost/updatePost were RETIRED in cinatra#1214 S1 (the
    // get/update reroute to callWordPressMcp); the deps slot no longer binds
    // them. The auth seam the MCP client uses IS bound (from the connector's
    // own client) — a lazy function, resolved on call.
    expect(typeof getWordPressDeps().buildWordPressBasicAuthHeader).toBe("function");

    expect(getAPIStatus).toHaveBeenCalledTimes(1);
  });

  it("requireInstanceWriteAuthority binds the host instance-write-authority service for KIND 'wordpress' and forwards only instanceId+primitiveName (cinatra#409)", async () => {
    const requireWrite = vi.fn(async () => {});
    const selectForConnector = vi.fn((_kind: string) => ({ requireWrite }));
    activateWithServices({
      // The REAL host capability id + shape (HostInstanceWriteAuthorityService):
      // selectForConnector(kind).requireWrite({ instanceId, primitiveName }).
      "@cinatra-ai/host:instance-write-authority": { selectForConnector },
    });
    await expect(
      getWordPressDeps().requireInstanceWriteAuthority({
        instanceId: "wp-1",
        primitiveName: "wordpress_post_update",
      }),
    ).resolves.toBeUndefined();
    // The connector names ONLY its own static kind — never a package id.
    expect(selectForConnector).toHaveBeenCalledWith("wordpress");
    // It forwards ONLY the non-identity coordinates; the host derives the
    // trusted actor itself (never from the connector).
    expect(requireWrite).toHaveBeenCalledWith({
      instanceId: "wp-1",
      primitiveName: "wordpress_post_update",
    });
  });

  it("requireInstanceWriteAuthority FAILS LOUD on an old host that did not publish the instance-write-authority service (cinatra#409 fail-closed)", async () => {
    // No @cinatra-ai/host:instance-write-authority provider registered.
    activateWithServices({});
    await expect(
      getWordPressDeps().requireInstanceWriteAuthority({
        instanceId: "wp-1",
        primitiveName: "wordpress_post_update",
      }),
    ).rejects.toThrow(/host service "@cinatra-ai\/host:instance-write-authority" is not registered/);
  });

  it("listInstancesSorted orders most-recently-updated first (host listWordPressInstances ordering)", () => {
    activateWithServices({
      "@cinatra-ai/host:wordpress-mcp": {
        listInstances: () => [
          { id: "old", updatedAt: "2026-01-01T00:00:00Z" },
          { id: "new", updatedAt: "2026-03-01T00:00:00Z" },
          { id: "mid", updatedAt: "2026-02-01T00:00:00Z" },
        ],
        probeAdapter: vi.fn(),
        resolveServerUrl: vi.fn(),
        isPrivateUrl: vi.fn(),
        deleteInstance: vi.fn(),
        getAPIStatus: vi.fn(),
      },
    });
    expect(listInstancesSorted().map((i) => i.id)).toEqual(["new", "mid", "old"]);
  });

  it("fails LOUD (descriptive) on a missing host service at call time", () => {
    activateWithServices({});
    expect(() => getWordPressDeps().listMcpInstances()).toThrow(
      /host service "@cinatra-ai\/host:wordpress-mcp" is not registered/,
    );
    expect(() => getWordPressDeps().decodeCursor("x")).toThrow(
      /host service "@cinatra-ai\/host:mcp-pagination" is not registered/,
    );
    // The connection-admin read rides the same wordpress-mcp service (H3)…
    expect(() => getWordPressDeps().getApiStatus()).toThrow(
      /host service "@cinatra-ai\/host:wordpress-mcp" is not registered/,
    );
    // …while the content CRUD rides the SEPARATE wordpress-content service.
    expect(() =>
      getWordPressDeps().createDraft({
        instance: { id: "i", name: "n", siteUrl: "s", username: "u", applicationPassword: "p" },
        payload: { title: "", content: "", excerpt: "", status: "draft" },
      }),
    ).toThrow(/host service "@cinatra-ai\/host:wordpress-content" is not registered/);
  });

  it("fails LOUD with the package name + registration step when the SLOT itself is unbound", () => {
    // No register(ctx) ran at all (e.g. a settings-page bundle resolving the
    // slot before activation): the getter must name the package and the
    // missing registration step.
    expect(() => getWordPressDeps()).toThrow(
      /@cinatra-ai\/wordpress-mcp-connector: host runtime deps not registered[\s\S]*registerWordPressConnector/,
    );
  });
});

describe("register(ctx) — relocated WordPress client provider-flip (cinatra#975 Wave 3)", () => {
  function activateCapturing(impls: Record<string, unknown> = {}) {
    const registerProvider = vi.fn();
    const resolveProviders = vi.fn((capability: string) =>
      impls[capability] !== undefined
        ? [{ packageName: "@cinatra-ai/host", impl: impls[capability] }]
        : [],
    );
    const ctx = {
      capabilities: { registerProvider, resolveProviders },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as never;
    register(ctx);
    return { registerProvider, resolveProviders };
  }

  function registeredImpl(registerProvider: ReturnType<typeof vi.fn>, capability: string) {
    const call = registerProvider.mock.calls.find(([id]) => id === capability);
    expect(call, `provider registration for ${capability}`).toBeDefined();
    const [, provider] = call as [string, { packageName: string; impl: Record<string, unknown> }];
    expect(provider.packageName).toBe("@cinatra-ai/wordpress-mcp-connector");
    return provider.impl;
  }

  it("registers the connector-owned client under the SAME host ids (wordpress-content + wordpress-mcp) with NO resolution at activation (probe-safe)", () => {
    const { registerProvider, resolveProviders } = activateCapturing();
    // The Wave-2 widget-auth registration is unchanged and rides along.
    registeredImpl(registerProvider, "@cinatra-ai/host:wordpress-widget-auth");

    const content = registeredImpl(registerProvider, "@cinatra-ai/host:wordpress-content");
    // The existing HostWordPressContentService member set MINUS the in-admin
    // readPost/updatePost, which cinatra#1214 S1 RETIRED (the get/update reroute
    // to the MCP client — the client no longer has readWordPressPost/
    // updateWordPressPost to back them).
    for (const member of [
      "createDraft", "readPostStatus", "listPublishedPosts",
      "listPublishedPages", "deletePost", "uploadMedia", "updateDraftMeta",
    ]) {
      expect(typeof content[member], `wordpress-content.${member}`).toBe("function");
    }
    expect(content.readPost, "wordpress-content.readPost retired (S1)").toBeUndefined();
    expect(content.updatePost, "wordpress-content.updatePost retired (S1)").toBeUndefined();

    const admin = registeredImpl(registerProvider, "@cinatra-ai/host:wordpress-mcp");
    // Client-backed contract members…
    for (const member of ["listInstances", "getAPIStatus", "getAPISettings", "readInstanceById", "deleteInstance"]) {
      expect(typeof admin[member], `wordpress-mcp.${member}`).toBe("function");
    }
    expect(typeof (admin.webhookSubscriptions as Record<string, unknown>).list).toBe("function");
    expect(typeof (admin.webhookSubscriptions as Record<string, unknown>).register).toBe("function");
    expect(typeof (admin.webhookSubscriptions as Record<string, unknown>).remove).toBe("function");
    // …plus the ADDITIVE relocated-client members (core export names) the
    // core-eviction follow-up re-points to.
    for (const member of [
      "validateWordPressInstanceConnection", "saveWordPressInstance",
      "saveWordPressInstanceFromNangoConnection", "persistLocalDevWordPressInstanceUnvalidated",
      "setWordPressInstanceBlogConnector", "saveWordPressLoggingSettings",
      "getWordPressLoggingSettings", "listWordPressInstances", "readLatestPublishedWordPressPost",
    ]) {
      expect(typeof admin[member], `wordpress-mcp.${member}`).toBe("function");
    }
    // EXPLICIT NON-MEMBERS: probes/url-policy/actor-scoped listing/dev-mode
    // guards stay HOST-published (this slice relocates only wordpress-api.ts).
    for (const member of ["probeAdapter", "resolveServerUrl", "resolveEndpoint", "isPrivateUrl", "listAuthorizedInstances", "devSaveInstance", "devPersistLocalInstanceUnvalidated", "devInvalidateProbeCache"]) {
      expect(admin[member], `wordpress-mcp.${member} must stay host-side`).toBeUndefined();
    }

    // Probe-safe: building the client + impls resolved NOTHING.
    expect(resolveProviders).not.toHaveBeenCalled();
  });

  it("the registered client provider serves calls through the published capabilities (connector-config-backed read)", () => {
    const { registerProvider } = activateCapturing({
      "@cinatra-ai/host:connector-config": {
        read: <T,>(_id: string, fallback: T): T => fallback,
        write: () => {},
      },
    });
    const admin = registeredImpl(registerProvider, "@cinatra-ai/host:wordpress-mcp");
    expect((admin.getAPIStatus as () => { status: string })().status).toBe("not_connected");
  });

  it("the deps slot PREFERS the host-published provider over the connector's own same-id registration (no self-shadow)", () => {
    const hostGetAPIStatus = vi.fn(() => ({ status: "connected" as const, detail: "host" }));
    const resolveProviders = vi.fn((capability: string) => {
      if (capability !== "@cinatra-ai/host:wordpress-mcp") return [];
      return [
        // Deliberately list the SELF-registered provider FIRST — the deps
        // resolver must still pick the host's.
        { packageName: "@cinatra-ai/wordpress-mcp-connector", impl: { getAPIStatus: vi.fn() } },
        { packageName: "@cinatra-ai/host", impl: { getAPIStatus: hostGetAPIStatus } },
      ];
    });
    const ctx = {
      capabilities: { registerProvider: vi.fn(), resolveProviders },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as never;
    register(ctx);
    expect(getWordPressDeps().getApiStatus()).toEqual({ status: "connected", detail: "host" });
    expect(hostGetAPIStatus).toHaveBeenCalledTimes(1);
  });
});
