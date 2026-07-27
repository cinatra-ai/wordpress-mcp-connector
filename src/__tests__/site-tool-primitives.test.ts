// cinatra#2017 S2 (gateway PR-1, CONNECTOR half) — the governed connector-instance
// invoker primitives: wordpress_site_tool_call / wordpress_site_tools_list.
//
// These are thin, connector-owned entry points to the governed invoker (Plane C):
// schema-parse → call the host invoker capability via the deps slot. This suite
// pins the security-load-bearing contract:
//   • connectorKey / kind are NOT connector-facing (M6) — the shapes carry none and
//     an injected connectorKey/kind is stripped by the schema, never forwarded;
//   • no actor is read from tool input (§2.4) — identity is host-derived;
//   • args are forwarded UNMODIFIED (§3.7);
//   • fail-loud when the invoker capability is unbound;
//   • the connector types the invoker against the shared @cinatra-ai/sdk-extensions
//     contract (cinatra#2017 S2, C3 swap) and inlines the host-fenced capability id;
//   • the tools_list row carries the schema-bearing fields (§10-A2) and an
//     OPAQUE host-owned serverId (§10-A1).
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { createWordPressPrimitiveHandlers } from "@cinatra-ai/wordpress-mcp-connector/mcp-handlers";
import { registerWordPressPrimitives } from "../mcp/registry";
import {
  registerWordPressConnector,
  getWordPressDeps,
  _resetWordPressDepsForTests,
  type WordPressConnectorDeps,
} from "../deps";
import { register } from "../register";
import type {
  HostConnectorInstanceInvokerService,
  SiteToolRow,
  SiteToolsListPage,
} from "@cinatra-ai/sdk-extensions";

// The governed-invoker capability id. The SDK keeps the id host-fenced (an
// extension inlines the literal), so register.ts inlines it directly; these
// tests mirror that same literal.
const CONNECTOR_INSTANCE_INVOKER_CAP = "@cinatra-ai/host:connector-instance-invoker";

// ---------------------------------------------------------------------------
// Handler behavior — mocked invoker capability on the deps slot.
// ---------------------------------------------------------------------------
const invokeSiteToolMock = vi.fn(async (_input: unknown): Promise<unknown> => ({ ok: true }));
const listSiteToolsMock = vi.fn(
  async (_input: unknown): Promise<SiteToolsListPage> => ({ tools: [], catalogRevision: "rev-1" }),
);

// Only the two invoker members are exercised by these handlers; a cast keeps the
// stub focused (the handlers read nothing else from the slot).
function registerInvokerDeps(overrides: Partial<WordPressConnectorDeps> = {}) {
  registerWordPressConnector({
    invokeSiteTool: invokeSiteToolMock,
    listSiteTools: listSiteToolsMock,
    ...overrides,
  } as WordPressConnectorDeps);
}

const MODEL_ACTOR = { actorType: "model", source: "agent" } as const;

describe("wordpress_site_tool_call — governed invoker primitive", () => {
  let handlers: ReturnType<typeof createWordPressPrimitiveHandlers>;
  beforeEach(() => {
    _resetWordPressDepsForTests();
    invokeSiteToolMock.mockReset().mockResolvedValue({ ok: true });
    listSiteToolsMock.mockReset().mockResolvedValue({ tools: [], catalogRevision: "rev-1" });
    registerInvokerDeps();
    handlers = createWordPressPrimitiveHandlers();
  });

  const call = (input: unknown) =>
    (handlers as any).wordpress_site_tool_call({
      primitiveName: "wordpress_site_tool_call",
      input,
      actor: MODEL_ACTOR,
      mode: "agentic",
    });

  it("is registered as a handler key", () => {
    expect(typeof (handlers as any).wordpress_site_tool_call).toBe("function");
  });

  it("forwards toolName + args VERBATIM to the host invoker and returns its result", async () => {
    invokeSiteToolMock.mockResolvedValueOnce({ postId: 99 });
    const result = await call({ toolName: "core/get-site-info", args: { verbose: true } });
    expect(invokeSiteToolMock).toHaveBeenCalledWith({
      toolName: "core/get-site-info",
      args: { verbose: true },
    });
    expect(result).toEqual({ postId: 99 });
  });

  it("defaults args to {} when omitted (a no-argument tool is callable)", async () => {
    await call({ toolName: "core/discover" });
    expect(invokeSiteToolMock).toHaveBeenCalledWith({ toolName: "core/discover", args: {} });
  });

  it("threads instanceId + serverId through when supplied", async () => {
    await call({ toolName: "ewpa/create-post", args: { title: "T" }, instanceId: "wp-1", serverId: "mcp-adapter-default" });
    expect(invokeSiteToolMock).toHaveBeenCalledWith({
      toolName: "ewpa/create-post",
      args: { title: "T" },
      instanceId: "wp-1",
      serverId: "mcp-adapter-default",
    });
  });

  it("omits absent optionals (never forwards an explicit undefined instanceId/serverId)", async () => {
    await call({ toolName: "core/ping", args: {} });
    const forwarded = invokeSiteToolMock.mock.calls[0][0] as Record<string, unknown>;
    expect(forwarded).not.toHaveProperty("instanceId");
    expect(forwarded).not.toHaveProperty("serverId");
  });

  // M6 / R2-B1 — connectorKey and kind are NOT connector-facing. An injected
  // connectorKey/kind must be STRIPPED by the schema and never reach the invoker.
  it("STRIPS an injected connectorKey / kind — never forwards connector identity (M6)", async () => {
    await call({
      toolName: "core/get-site-info",
      args: {},
      connectorKey: "drupal",
      kind: "drupal",
    });
    const forwarded = invokeSiteToolMock.mock.calls[0][0] as Record<string, unknown>;
    expect(forwarded).not.toHaveProperty("connectorKey");
    expect(forwarded).not.toHaveProperty("kind");
    expect(forwarded).toEqual({ toolName: "core/get-site-info", args: {} });
  });

  // §2.4 — identity is host-derived; the handler never reads request.actor. A
  // malicious actor payload carrying a connectorKey must not leak into the call.
  it("reads NO actor from the request — a forged actor.connectorKey is ignored (§2.4)", async () => {
    await (handlers as any).wordpress_site_tool_call({
      primitiveName: "wordpress_site_tool_call",
      input: { toolName: "core/ping", args: {} },
      actor: { actorType: "model", source: "agent", connectorKey: "drupal", userId: "attacker" },
      mode: "agentic",
    });
    const forwarded = invokeSiteToolMock.mock.calls[0][0] as Record<string, unknown>;
    expect(forwarded).toEqual({ toolName: "core/ping", args: {} });
    expect(JSON.stringify(forwarded)).not.toContain("attacker");
  });

  it("rejects an empty toolName via the schema", async () => {
    await expect(call({ toolName: "", args: {} })).rejects.toThrow();
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  it("rejects a non-object args via the schema", async () => {
    await expect(call({ toolName: "core/ping", args: "not-an-object" })).rejects.toThrow();
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  // FAIL-CLOSED: an unbound invoker member (skewed/partial deps slot) DENIES
  // descriptively — the primitive never reaches WordPress off the governed channel.
  it("FAILS LOUD when the invoker capability is unbound (no ungoverned call)", async () => {
    _resetWordPressDepsForTests();
    registerInvokerDeps({ invokeSiteTool: undefined });
    const h = createWordPressPrimitiveHandlers();
    await expect(
      (h as any).wordpress_site_tool_call({
        primitiveName: "wordpress_site_tool_call",
        input: { toolName: "core/ping", args: {} },
        actor: MODEL_ACTOR,
        mode: "agentic",
      }),
    ).rejects.toThrow(/governed connector-instance invoker is unavailable|connector-instance-invoker unbound/);
  });
});

describe("wordpress_site_tools_list — governed list primitive", () => {
  let handlers: ReturnType<typeof createWordPressPrimitiveHandlers>;
  beforeEach(() => {
    _resetWordPressDepsForTests();
    invokeSiteToolMock.mockReset().mockResolvedValue({ ok: true });
    listSiteToolsMock.mockReset().mockResolvedValue({ tools: [], catalogRevision: "rev-1" });
    registerInvokerDeps();
    handlers = createWordPressPrimitiveHandlers();
  });

  const call = (input: unknown) =>
    (handlers as any).wordpress_site_tools_list({
      primitiveName: "wordpress_site_tools_list",
      input,
      actor: MODEL_ACTOR,
      mode: "agentic",
    });

  it("is registered as a handler key", () => {
    expect(typeof (handlers as any).wordpress_site_tools_list).toBe("function");
  });

  it("returns the governed list page from the host list surface", async () => {
    const page: SiteToolsListPage = {
      tools: [
        {
          name: "core/get-site-info",
          serverId: "mcp-adapter-default",
          inputSchema: { type: "object", properties: {} },
          rawAnnotations: {},
          derivedClass: "read",
          policyStatus: "allowed",
          cacheAgeMs: 12,
          catalogRevision: "rev-7",
        },
      ],
      nextCursor: "cursor-2",
      catalogRevision: "rev-7",
    };
    listSiteToolsMock.mockResolvedValueOnce(page);
    const result = await call({});
    expect(result).toEqual(page);
  });

  it("forwards instanceId / serverId / cursor through, omitting absent optionals", async () => {
    await call({ instanceId: "wp-1", cursor: "c-1" });
    expect(listSiteToolsMock).toHaveBeenCalledWith({ instanceId: "wp-1", cursor: "c-1" });
    const forwarded = listSiteToolsMock.mock.calls[0][0] as Record<string, unknown>;
    expect(forwarded).not.toHaveProperty("serverId");
  });

  it("STRIPS an injected connectorKey / kind (M6)", async () => {
    await call({ instanceId: "wp-1", connectorKey: "drupal", kind: "drupal" });
    const forwarded = listSiteToolsMock.mock.calls[0][0] as Record<string, unknown>;
    expect(forwarded).toEqual({ instanceId: "wp-1" });
  });

  it("FAILS LOUD when the invoker capability is unbound (no catalog off-channel)", async () => {
    _resetWordPressDepsForTests();
    registerInvokerDeps({ listSiteTools: undefined });
    const h = createWordPressPrimitiveHandlers();
    await expect(
      (h as any).wordpress_site_tools_list({
        primitiveName: "wordpress_site_tools_list",
        input: {},
        actor: MODEL_ACTOR,
        mode: "agentic",
      }),
    ).rejects.toThrow(/governed connector-instance invoker is unavailable|connector-instance-invoker unbound/);
    expect(listSiteToolsMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// registry — both primitives are model-visible (registered), relay still omitted.
// ---------------------------------------------------------------------------
describe("registerWordPressPrimitives — the S2 gateway primitives are registered", () => {
  it("registers wordpress_site_tool_call and wordpress_site_tools_list", () => {
    const registered: string[] = [];
    const server = {
      registerTool: (name: string) => registered.push(name),
    } as unknown as Parameters<typeof registerWordPressPrimitives>[0];
    registerWordPressPrimitives(server);
    expect(registered).toContain("wordpress_site_tool_call");
    expect(registered).toContain("wordpress_site_tools_list");
    // Regression: the content-editor relay stays OFF the MCP surface (cinatra#246).
    expect(registered).not.toContain("wordpress_content_editor_run");
  });
});

// ---------------------------------------------------------------------------
// register(ctx) — the invoker deps bind to the VENDORED capability id, fail-loud.
// ---------------------------------------------------------------------------
describe("register(ctx) — governed-invoker capability binding (cinatra#2017 S2)", () => {
  function activateWithServices(impls: Record<string, unknown>) {
    const resolveProviders = vi.fn((capability: string) =>
      impls[capability] !== undefined
        ? [{ packageName: "@cinatra-ai/host", impl: impls[capability] }]
        : [],
    );
    const ctx = {
      capabilities: { registerProvider: () => {}, resolveProviders },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as never;
    register(ctx);
    return { resolveProviders };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    _resetWordPressDepsForTests();
  });

  it("binds invokeSiteTool / listSiteTools against the governed capability id and forwards VERBATIM (no connectorKey/kind added)", async () => {
    const invokeSiteTool = vi.fn(async () => ({ done: true }));
    const listSiteTools = vi.fn(async () => ({ tools: [], catalogRevision: "r" }));
    const { resolveProviders } = activateWithServices({
      [CONNECTOR_INSTANCE_INVOKER_CAP]: { invokeSiteTool, listSiteTools },
    });
    // Probe-safe: no resolution happened at registration.
    expect(resolveProviders).not.toHaveBeenCalled();

    await expect(
      getWordPressDeps().invokeSiteTool!({ toolName: "core/ping", args: {} }),
    ).resolves.toEqual({ done: true });
    // The connector-facing dep forwards exactly what it was given — the host derives
    // connectorKey from the verified packageName; nothing is added connector-side.
    expect(invokeSiteTool).toHaveBeenCalledWith({ toolName: "core/ping", args: {} });

    await getWordPressDeps().listSiteTools!({ instanceId: "wp-1" });
    expect(listSiteTools).toHaveBeenCalledWith({ instanceId: "wp-1" });
  });

  it("FAILS LOUD (descriptive) when the invoker capability is not registered", async () => {
    activateWithServices({}); // no @cinatra-ai/host:connector-instance-invoker
    await expect(
      getWordPressDeps().invokeSiteTool!({ toolName: "core/ping", args: {} }),
    ).rejects.toThrow(/host service "@cinatra-ai\/host:connector-instance-invoker" is not registered/);
    await expect(
      getWordPressDeps().listSiteTools!({}),
    ).rejects.toThrow(/host service "@cinatra-ai\/host:connector-instance-invoker" is not registered/);
  });
});

// ---------------------------------------------------------------------------
// SDK invoker contract (cinatra#2017 S2, C3 swap + §10-A1/A2) — the connector
// consumes the shared @cinatra-ai/sdk-extensions surface.
// ---------------------------------------------------------------------------
describe("SDK invoker contract (cinatra#2017 S2, C3) — shared @cinatra-ai/sdk-extensions surface", () => {
  it("pins the inlined capability-id literal to the design literal", () => {
    expect(CONNECTOR_INSTANCE_INVOKER_CAP).toBe("@cinatra-ai/host:connector-instance-invoker");
  });

  it("the shared invoker shape is structurally usable (compile + runtime construction)", async () => {
    // A conforming impl assigns to the shared SDK type — the proof that the
    // connector types the capability against the canonical published contract.
    const impl: HostConnectorInstanceInvokerService = {
      invokeSiteTool: async () => ({ ok: true }),
      listSiteTools: async () => ({ tools: [], catalogRevision: "r" }),
    };
    await expect(impl.invokeSiteTool({ toolName: "t", args: {} })).resolves.toEqual({ ok: true });
    await expect(impl.listSiteTools({})).resolves.toEqual({ tools: [], catalogRevision: "r" });
  });

  it("the tools_list row carries the schema-bearing fields (§10-A2) on an OPAQUE serverId (§10-A1)", () => {
    // §10-A2: inputSchema (required) + outputSchema? + label? + description? are
    // part of the frozen row. §10-A1: serverId is the host-owned opaque constant
    // "mcp-adapter-default" — never endpoint-derived; the connector treats it as an
    // opaque string. This constructs a fully-populated row against the shared SDK type.
    const row: SiteToolRow = {
      name: "ewpa/create-post",
      serverId: "mcp-adapter-default",
      inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      outputSchema: { type: "object" },
      label: "Create post",
      description: "Create a WordPress post",
      rawAnnotations: { destructive: "false" },
      derivedClass: "write",
      policyStatus: "allowed",
      cacheAgeMs: 0,
      catalogRevision: "rev-1",
    };
    expect(row.inputSchema).toBeDefined();
    expect(row.serverId).toBe("mcp-adapter-default");
    expect(row).toMatchObject({ outputSchema: expect.anything(), label: "Create post", description: expect.anything() });
  });

  // Static guard — the C3 swap: core landed + published the contract, so the
  // connector now CONSUMES it from @cinatra-ai/sdk-extensions. The vendored mirror
  // is gone; the capability id stays an inlined literal (the SDK keeps the id
  // host-fenced — an extension inlines it, never imports the constant).
  describe("static: the invoker contract is consumed from the SDK (C3 swap)", () => {
    const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
    const registerSrc = read("../register.ts");
    const depsSrc = read("../deps.ts");

    it("the vendored invoker-contract module is deleted", () => {
      expect(existsSync(new URL("../mcp/invoker-contract.ts", import.meta.url))).toBe(false);
    });

    it("register.ts types the invoker against the SDK contract, inlines the cap id, and drops the vendored module", () => {
      expect(registerSrc).toContain("from \"@cinatra-ai/sdk-extensions\"");
      expect(registerSrc).toContain("HostConnectorInstanceInvokerService");
      expect(registerSrc).toContain("\"@cinatra-ai/host:connector-instance-invoker\"");
      expect(registerSrc).not.toContain("./mcp/invoker-contract");
    });

    it("deps.ts imports the invoker input/output types from the SDK, not the vendored module", () => {
      expect(depsSrc).toContain("from \"@cinatra-ai/sdk-extensions\"");
      expect(depsSrc).toContain("SiteToolCallInput");
      expect(depsSrc).not.toContain("./mcp/invoker-contract");
    });
  });
});
