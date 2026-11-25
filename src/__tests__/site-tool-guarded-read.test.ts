// cinatra#3745: the read tool relies on the catalog row it listed, so it calls
// the host's GUARDED method (`invokeSiteToolGuarded`), which runs the tool only
// when the row the host resolves now is the row the connector checked. A host
// with the guarded method refuses an `invokeSiteTool` call that carries a guard
// field, and a host without it ignores the field, so the read tool never sends
// one through `invokeSiteTool` and never falls back to it. The write tool and
// the review-gated helper keep the unguarded call and send no guard field.
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SiteToolRow, SiteToolsListPage } from "@cinatra-ai/sdk-extensions";

import {
  createWordPressPrimitiveHandlers,
  SITE_TOOL_READ_ONLY_REFUSAL,
  SITE_TOOL_CATALOG_CHANGED_REFUSAL,
  SITE_TOOL_LISTED_ROW_REFUSAL,
} from "@cinatra-ai/wordpress-mcp-connector/mcp-handlers";
import { register } from "../register";
import {
  getWordPressDeps,
  registerWordPressConnector,
  _resetWordPressDepsForTests,
  SITE_TOOL_GUARDED_UNSUPPORTED_REFUSAL,
  type WordPressConnectorDeps,
  type WordPressMcpInstance,
} from "../deps";

const invokeSiteToolMock = vi.fn(async (_input: unknown): Promise<unknown> => ({ ok: "unguarded" }));
const invokeSiteToolGuardedMock = vi.fn(async (_input: unknown): Promise<unknown> => ({ ok: "guarded" }));
const listSiteToolsMock = vi.fn(
  async (_input: unknown): Promise<SiteToolsListPage> => ({ tools: [], catalogRevision: "rev-1" }),
);

function readRowOf(name: string, serverId = "srv-1"): SiteToolRow {
  return {
    name,
    serverId,
    inputSchema: {},
    rawAnnotations: { readOnlyHint: true, title: "Read" },
    derivedClass: "read",
    policyStatus: "allowed",
    cacheAgeMs: 0,
    catalogRevision: "rev-1",
  };
}

function unannotatedRowOf(name: string, serverId: string): SiteToolRow {
  return { ...readRowOf(name, serverId), rawAnnotations: {}, derivedClass: "write" };
}

function hostError(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: "InvokerError", code });
}

function bind(extra: Partial<WordPressConnectorDeps> = {}) {
  registerWordPressConnector({
    invokeSiteTool: invokeSiteToolMock,
    invokeSiteToolGuarded: invokeSiteToolGuardedMock,
    siteToolGuardSupported: () => true,
    listSiteTools: listSiteToolsMock,
    ...extra,
  } as unknown as WordPressConnectorDeps);
}

const call = (name: string, input: unknown) =>
  (createWordPressPrimitiveHandlers() as any)[name]({
    primitiveName: name,
    input,
    actor: { actorType: "model", source: "agent" },
    mode: "agentic",
  });
const read = (input: unknown) => call("wordpress_site_tool_call", input);
const write = (input: unknown) => call("wordpress_site_tool_write", input);

beforeEach(() => {
  _resetWordPressDepsForTests();
  invokeSiteToolMock.mockReset().mockResolvedValue({ ok: "unguarded" });
  invokeSiteToolGuardedMock.mockReset().mockResolvedValue({ ok: "guarded" });
  listSiteToolsMock.mockReset().mockResolvedValue({ tools: [], catalogRevision: "rev-1" });
});

describe("the read tool calls the guarded method with the listed row (cinatra#3745)", () => {
  it("sends exactly the listed row's server, annotations and the read class, and never invokeSiteTool", async () => {
    bind();
    listSiteToolsMock.mockResolvedValueOnce({ tools: [readRowOf("core/get-site-info")], catalogRevision: "rev-1" });
    await expect(read({ toolName: "core/get-site-info", args: { a: 1 }, instanceId: "wp-1" })).resolves.toEqual({
      ok: "guarded",
    });
    expect(invokeSiteToolGuardedMock).toHaveBeenCalledTimes(1);
    expect(invokeSiteToolGuardedMock).toHaveBeenCalledWith({
      toolName: "core/get-site-info",
      args: { a: 1 },
      instanceId: "wp-1",
      serverId: "srv-1",
      expectedRawAnnotations: { readOnlyHint: true, title: "Read" },
      expectedClass: "read",
    });
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  it("omits instanceId when the call has none", async () => {
    bind();
    listSiteToolsMock.mockResolvedValueOnce({ tools: [readRowOf("core/get-site-info")], catalogRevision: "rev-1" });
    await read({ toolName: "core/get-site-info" });
    expect(invokeSiteToolGuardedMock).toHaveBeenCalledWith({
      toolName: "core/get-site-info",
      args: {},
      serverId: "srv-1",
      expectedRawAnnotations: { readOnlyHint: true, title: "Read" },
      expectedClass: "read",
    });
  });

  it("an unannotated known ewpa read on the default server keeps the annotation guard and sends no class", async () => {
    // The host's own classifier calls an unannotated row "write", so a read
    // class assertion would refuse every unannotated ewpa read. The annotation
    // guard ({} on the same server) still refuses a row that changed.
    bind();
    listSiteToolsMock.mockResolvedValueOnce({
      tools: [unannotatedRowOf("ewpa/get-post", "mcp-adapter-default")],
      catalogRevision: "rev-1",
    });
    await read({ toolName: "ewpa/get-post", args: { post_id: 42 }, instanceId: "wp-1" });
    expect(invokeSiteToolGuardedMock).toHaveBeenCalledWith({
      toolName: "ewpa/get-post",
      args: { post_id: 42 },
      instanceId: "wp-1",
      serverId: "mcp-adapter-default",
      expectedRawAnnotations: {},
    });
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  it("deps without the guarded method: denied with the fixed message, nothing listed or called", async () => {
    bind({ invokeSiteToolGuarded: undefined });
    await expect(read({ toolName: "core/get-site-info", instanceId: "wp-1" })).rejects.toThrow(
      SITE_TOOL_GUARDED_UNSUPPORTED_REFUSAL,
    );
    expect(listSiteToolsMock).not.toHaveBeenCalled();
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  it("catalog_entry_changed from the host becomes the tool's refusal; nothing else is called", async () => {
    bind();
    listSiteToolsMock.mockResolvedValueOnce({ tools: [readRowOf("core/get-site-info")], catalogRevision: "rev-1" });
    invokeSiteToolGuardedMock.mockRejectedValueOnce(hostError("catalog_entry_changed", "host words"));
    await expect(read({ toolName: "core/get-site-info", instanceId: "wp-1" })).rejects.toThrow(
      SITE_TOOL_CATALOG_CHANGED_REFUSAL,
    );
    expect(invokeSiteToolGuardedMock).toHaveBeenCalledTimes(1);
    expect(listSiteToolsMock).toHaveBeenCalledTimes(1);
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  it("catalog_entry_not_read from the host (not a read, or a class it does not know) becomes the read-only refusal", async () => {
    bind();
    listSiteToolsMock.mockResolvedValueOnce({ tools: [readRowOf("core/get-site-info")], catalogRevision: "rev-1" });
    invokeSiteToolGuardedMock.mockRejectedValueOnce(hostError("catalog_entry_not_read", "host words"));
    await expect(read({ toolName: "core/get-site-info", instanceId: "wp-1" })).rejects.toThrow(
      SITE_TOOL_READ_ONLY_REFUSAL,
    );
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  it("guarded_call_required from the host becomes the unsupported-host refusal", async () => {
    bind();
    listSiteToolsMock.mockResolvedValueOnce({ tools: [readRowOf("core/get-site-info")], catalogRevision: "rev-1" });
    invokeSiteToolGuardedMock.mockRejectedValueOnce(hostError("guarded_call_required", "host words"));
    await expect(read({ toolName: "core/get-site-info", instanceId: "wp-1" })).rejects.toThrow(
      SITE_TOOL_GUARDED_UNSUPPORTED_REFUSAL,
    );
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  it("any other host error passes on unchanged", async () => {
    bind();
    listSiteToolsMock.mockResolvedValueOnce({ tools: [readRowOf("core/get-site-info")], catalogRevision: "rev-1" });
    const siteError = hostError("tool_error", "the site said no");
    invokeSiteToolGuardedMock.mockRejectedValueOnce(siteError);
    await expect(read({ toolName: "core/get-site-info", instanceId: "wp-1" })).rejects.toBe(siteError);
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });
});

describe("the write road sends no guard field (cinatra#3745)", () => {
  it("the write tool calls invokeSiteTool without a guard field, even when the input carries one", async () => {
    bind();
    await write({
      toolName: "ewpa/create-post",
      args: { title: "T" },
      instanceId: "wp-1",
      serverId: "srv-1",
      expectedRawAnnotations: { readOnlyHint: true },
      expectedClass: "read",
    });
    expect(invokeSiteToolMock).toHaveBeenCalledWith({
      toolName: "ewpa/create-post",
      args: { title: "T" },
      instanceId: "wp-1",
      serverId: "srv-1",
    });
    const sent = invokeSiteToolMock.mock.calls[0]![0] as Record<string, unknown>;
    expect("expectedRawAnnotations" in sent).toBe(false);
    expect("expectedClass" in sent).toBe(false);
    expect(invokeSiteToolGuardedMock).not.toHaveBeenCalled();
  });

  it("the review-gated post update helper calls invokeSiteTool without a guard field", async () => {
    const instance: WordPressMcpInstance = {
      id: "site-1",
      siteUrl: "https://example.com",
      username: "u",
      applicationPassword: "p",
      name: "Site 1",
      createdAt: "",
      updatedAt: "",
    };
    bind({
      listMcpInstances: () => [instance],
      requireInstanceWriteAuthority: vi.fn(async () => {}),
    } as Partial<WordPressConnectorDeps>);
    await write({
      toolName: "ewpa/update-post",
      args: { post_id: 7, title: "T" },
      instanceId: "site-1",
      expectedRawAnnotations: {},
    });
    expect(invokeSiteToolMock).toHaveBeenCalledWith({
      toolName: "ewpa/update-post",
      args: { post_id: 7, title: "T" },
      instanceId: "site-1",
    });
    const sent = invokeSiteToolMock.mock.calls[0]![0] as Record<string, unknown>;
    expect("expectedRawAnnotations" in sent).toBe(false);
    expect("expectedClass" in sent).toBe(false);
    expect(invokeSiteToolGuardedMock).not.toHaveBeenCalled();
  });
});

describe("register(ctx) binds the guarded method with an inline presence test (cinatra#3745)", () => {
  function activate(invoker: Record<string, unknown>) {
    const ctx = {
      capabilities: {
        registerProvider: () => {},
        resolveProviders: (capability: string) =>
          capability === "@cinatra-ai/host:connector-instance-invoker"
            ? [{ packageName: "@cinatra-ai/host", impl: invoker }]
            : [],
      },
    } as never;
    register(ctx);
  }

  const guardedInput = {
    toolName: "core/get-site-info",
    args: {},
    serverId: "srv-1",
    expectedRawAnnotations: { readOnlyHint: true },
    expectedClass: "read" as const,
  };

  it("a host without invokeSiteToolGuarded: the guarded dep is denied and nothing is sent", async () => {
    const hostInvokeSiteTool = vi.fn(async () => ({}));
    activate({ invokeSiteTool: hostInvokeSiteTool, listSiteTools: vi.fn() });
    const guarded = getWordPressDeps().invokeSiteToolGuarded;
    expect(typeof guarded).toBe("function");
    await expect(guarded!(guardedInput)).rejects.toThrow(SITE_TOOL_GUARDED_UNSUPPORTED_REFUSAL);
    expect(hostInvokeSiteTool).not.toHaveBeenCalled();
  });

  it("a host with invokeSiteToolGuarded: the input reaches it unchanged and invokeSiteTool is not called", async () => {
    const hostInvokeSiteTool = vi.fn(async () => ({}));
    const hostGuarded = vi.fn(async () => ({ ran: true }));
    activate({ invokeSiteTool: hostInvokeSiteTool, invokeSiteToolGuarded: hostGuarded, listSiteTools: vi.fn() });
    await expect(getWordPressDeps().invokeSiteToolGuarded!(guardedInput)).resolves.toEqual({ ran: true });
    expect(hostGuarded).toHaveBeenCalledWith(guardedInput);
    expect(hostInvokeSiteTool).not.toHaveBeenCalled();
  });

  it("an old host end to end: the read tool is denied and NOTHING is called on the host, the catalog included", async () => {
    const hostInvokeSiteTool = vi.fn(async () => ({}));
    const hostList = vi.fn(async () => ({ tools: [readRowOf("core/get-site-info")], catalogRevision: "rev-1" }));
    activate({ invokeSiteTool: hostInvokeSiteTool, listSiteTools: hostList });
    await expect(read({ toolName: "core/get-site-info", instanceId: "wp-1" })).rejects.toThrow(
      SITE_TOOL_GUARDED_UNSUPPORTED_REFUSAL,
    );
    expect(hostList).not.toHaveBeenCalled();
    expect(hostInvokeSiteTool).not.toHaveBeenCalled();
  });

  it("an old host whose catalog listing fails still answers the fixed unsupported-host refusal", async () => {
    const hostInvokeSiteTool = vi.fn(async () => ({}));
    const hostList = vi.fn(async () => {
      throw new Error("catalog unavailable");
    });
    activate({ invokeSiteTool: hostInvokeSiteTool, listSiteTools: hostList });
    await expect(read({ toolName: "core/get-site-info", instanceId: "wp-1" })).rejects.toThrow(
      SITE_TOOL_GUARDED_UNSUPPORTED_REFUSAL,
    );
    expect(hostList).not.toHaveBeenCalled();
  });

  it("a supported host whose catalog listing fails reports the listing failure", async () => {
    const hostInvokeSiteTool = vi.fn(async () => ({}));
    const hostGuarded = vi.fn(async () => ({}));
    const hostList = vi.fn(async () => {
      throw new Error("catalog unavailable");
    });
    activate({ invokeSiteTool: hostInvokeSiteTool, invokeSiteToolGuarded: hostGuarded, listSiteTools: hostList });
    await expect(read({ toolName: "core/get-site-info", instanceId: "wp-1" })).rejects.toThrow("catalog unavailable");
    expect(hostGuarded).not.toHaveBeenCalled();
    expect(hostInvokeSiteTool).not.toHaveBeenCalled();
  });

  it("presence is read from the host service at call time, on every call", async () => {
    const invoker: Record<string, unknown> = { invokeSiteTool: vi.fn(), listSiteTools: vi.fn() };
    activate(invoker);
    const probe = getWordPressDeps().siteToolGuardSupported;
    expect(typeof probe).toBe("function");
    expect(probe!()).toBe(false);
    invoker.invokeSiteToolGuarded = vi.fn();
    expect(probe!()).toBe(true);
  });
});

describe("the read tool checks host support first and sends only a usable listed row (cinatra#3745)", () => {
  it("a host that reports no guard support: refused, nothing listed or called", async () => {
    bind({ siteToolGuardSupported: () => false });
    await expect(read({ toolName: "core/get-site-info", instanceId: "wp-1" })).rejects.toThrow(
      SITE_TOOL_GUARDED_UNSUPPORTED_REFUSAL,
    );
    expect(listSiteToolsMock).not.toHaveBeenCalled();
    expect(invokeSiteToolGuardedMock).not.toHaveBeenCalled();
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  it("deps without the support probe: refused, nothing listed or called", async () => {
    bind({ siteToolGuardSupported: undefined });
    await expect(read({ toolName: "core/get-site-info", instanceId: "wp-1" })).rejects.toThrow(
      SITE_TOOL_GUARDED_UNSUPPORTED_REFUSAL,
    );
    expect(listSiteToolsMock).not.toHaveBeenCalled();
    expect(invokeSiteToolGuardedMock).not.toHaveBeenCalled();
  });

  it("a listed row with no server id is refused before the call", async () => {
    bind();
    listSiteToolsMock.mockResolvedValueOnce({
      tools: [{ ...readRowOf("core/get-site-info"), serverId: "" }],
      catalogRevision: "rev-1",
    });
    await expect(read({ toolName: "core/get-site-info", instanceId: "wp-1" })).rejects.toThrow(
      SITE_TOOL_LISTED_ROW_REFUSAL,
    );
    expect(invokeSiteToolGuardedMock).not.toHaveBeenCalled();
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  it("an unannotated row with no annotations field sends a plain {}", async () => {
    bind();
    const { rawAnnotations: _omit, ...bare } = unannotatedRowOf("ewpa/get-post", "mcp-adapter-default");
    listSiteToolsMock.mockResolvedValueOnce({ tools: [bare as SiteToolRow], catalogRevision: "rev-1" });
    await read({ toolName: "ewpa/get-post", args: { post_id: 1 }, instanceId: "wp-1" });
    const sent = invokeSiteToolGuardedMock.mock.calls[0]![0] as { expectedRawAnnotations: unknown };
    expect(sent.expectedRawAnnotations).toEqual({});
    expect(Object.getPrototypeOf(sent.expectedRawAnnotations)).toBe(Object.prototype);
  });

  it.each([
    ["a Map", new Map([["readOnlyHint", true]])],
    ["a class instance", new (class Annotations { readOnlyHint = true })()],
    ["a plain object with a nested Date", { readOnlyHint: true, at: new Date(0) }],
    ["a plain object with a Map inside an array", { readOnlyHint: true, list: [new Map()] }],
  ])("annotations that are %s are refused before the call", async (_label, rawAnnotations) => {
    bind();
    listSiteToolsMock.mockResolvedValueOnce({
      tools: [{ ...readRowOf("core/get-site-info"), rawAnnotations: rawAnnotations as never }],
      catalogRevision: "rev-1",
    });
    await expect(read({ toolName: "core/get-site-info", instanceId: "wp-1" })).rejects.toThrow();
    expect(invokeSiteToolGuardedMock).not.toHaveBeenCalled();
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  it("guarded_server_id_required from the host becomes a plain refusal", async () => {
    bind();
    listSiteToolsMock.mockResolvedValueOnce({ tools: [readRowOf("core/get-site-info")], catalogRevision: "rev-1" });
    invokeSiteToolGuardedMock.mockRejectedValueOnce(hostError("guarded_server_id_required", "host words"));
    await expect(read({ toolName: "core/get-site-info", instanceId: "wp-1" })).rejects.toThrow(
      SITE_TOOL_LISTED_ROW_REFUSAL,
    );
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });
});
