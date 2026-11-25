// cinatra#3745: a tool that writes or publishes on a person's behalf declares
// `outward` on its registration, so the host holds each call of it in an agent
// run for the person's recorded decision. The declaration is per registration,
// not per call, so the site's catalog is split in two:
//   - `wordpress_site_tool_call` is READ-ONLY. It forwards an ability only when
//     it is a known read AND its one catalog row, on the server that will run
//     it, says read-only; every other ability is refused with one fixed
//     message, before the invoker.
//   - `wordpress_site_tool_write` forwards any ability and declares `outward: {}`
//     (its inputs carry no stored item with a revision, so no subject).
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SiteToolRow, SiteToolsListPage } from "@cinatra-ai/sdk-extensions";

import {
  createWordPressPrimitiveHandlers,
  SITE_TOOL_READ_ONLY_REFUSAL,
} from "@cinatra-ai/wordpress-mcp-connector/mcp-handlers";
import { registerWordPressPrimitives } from "../mcp/registry";
import { registerWordPressConnector, _resetWordPressDepsForTests, type WordPressConnectorDeps } from "../deps";

const invokeSiteToolMock = vi.fn(async (_input: unknown): Promise<unknown> => ({ ok: true }));
const invokeSiteToolGuardedMock = vi.fn(async (_input: unknown): Promise<unknown> => ({ ok: true }));
const listSiteToolsMock = vi.fn(
  async (_input: unknown): Promise<SiteToolsListPage> => ({ tools: [], catalogRevision: "rev-1" }),
);

function row(name: string, derivedClass: SiteToolRow["derivedClass"], serverId = "srv-1"): SiteToolRow {
  return {
    name,
    serverId,
    inputSchema: {},
    rawAnnotations: derivedClass === "read" ? { readOnlyHint: true } : {},
    derivedClass,
    policyStatus: "allowed",
    cacheAgeMs: 0,
    catalogRevision: "rev-1",
  };
}

// One catalog page; `next` is the paging token of the following page, absent on the last page.
function catalogPage(tools: SiteToolRow[], next?: string): SiteToolsListPage {
  return { tools, ...(next !== undefined ? { nextCursor: next } : {}), catalogRevision: "rev-1" };
}

function registeredConfigs(): Map<string, Record<string, unknown>> {
  const configs = new Map<string, Record<string, unknown>>();
  const server = {
    registerTool: (name: string, config: Record<string, unknown>) => {
      configs.set(name, config);
    },
  } as unknown as Parameters<typeof registerWordPressPrimitives>[0];
  registerWordPressPrimitives(server);
  return configs;
}

describe("the site tools split into a read proxy and an outward write tool (cinatra#3745)", () => {
  let handlers: ReturnType<typeof createWordPressPrimitiveHandlers>;
  beforeEach(() => {
    _resetWordPressDepsForTests();
    invokeSiteToolMock.mockReset().mockResolvedValue({ ok: true });
    invokeSiteToolGuardedMock.mockReset().mockResolvedValue({ ok: true });
    listSiteToolsMock.mockReset().mockResolvedValue({ tools: [], catalogRevision: "rev-1" });
    registerWordPressConnector({
      invokeSiteTool: invokeSiteToolMock,
      invokeSiteToolGuarded: invokeSiteToolGuardedMock,
      siteToolGuardSupported: () => true,
      listSiteTools: listSiteToolsMock,
    } as unknown as WordPressConnectorDeps);
    handlers = createWordPressPrimitiveHandlers();
  });

  const read = (input: unknown) =>
    (handlers as any).wordpress_site_tool_call({
      primitiveName: "wordpress_site_tool_call",
      input,
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
  const write = (input: unknown) =>
    (handlers as any).wordpress_site_tool_write({
      primitiveName: "wordpress_site_tool_write",
      input,
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });

  it("registers wordpress_site_tool_write with outward: {}", () => {
    const config = registeredConfigs().get("wordpress_site_tool_write");
    expect(config).toBeDefined();
    expect("outward" in config!).toBe(true);
    expect(config!.outward).toEqual({});
  });

  it("declares outward on wordpress_site_tool_write only", () => {
    const configs = registeredConfigs();
    expect([...configs.keys()].sort()).toEqual([
      "wordpress_site_tool_call",
      "wordpress_site_tool_write",
      "wordpress_site_tools_list",
    ]);
    const declared = [...configs].filter(([, config]) => "outward" in config).map(([name]) => name);
    expect(declared).toEqual(["wordpress_site_tool_write"]);
  });

  it("the read proxy forwards a known read ability after reading its catalog row, pinned to that server", async () => {
    listSiteToolsMock.mockResolvedValueOnce(catalogPage([row("ewpa/get-post", "write", "mcp-adapter-default")]));
    await read({ toolName: "ewpa/get-post", args: { post_id: 42 }, instanceId: "wp-1" });
    expect(listSiteToolsMock).toHaveBeenCalledWith({ instanceId: "wp-1" });
    expect(invokeSiteToolGuardedMock).toHaveBeenCalledWith({
      toolName: "ewpa/get-post",
      args: { post_id: 42 },
      instanceId: "wp-1",
      serverId: "mcp-adapter-default",
      expectedRawAnnotations: {},
    });
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  it("the read proxy forwards a known read the catalog lists as read, paging to find it", async () => {
    listSiteToolsMock
      .mockResolvedValueOnce({ tools: [row("x/other", "write")], nextCursor: "c-2", catalogRevision: "rev-1" })
      .mockResolvedValueOnce({ tools: [row("core/get-site-info", "read")], catalogRevision: "rev-1" });
    await read({ toolName: "core/get-site-info", instanceId: "wp-1" });
    expect(listSiteToolsMock).toHaveBeenNthCalledWith(2, { instanceId: "wp-1", cursor: "c-2" });
    expect(invokeSiteToolGuardedMock).toHaveBeenCalledWith({
      toolName: "core/get-site-info",
      args: {},
      instanceId: "wp-1",
      serverId: "srv-1",
      expectedRawAnnotations: { readOnlyHint: true },
      expectedClass: "read",
    });
  });

  it.each([
    ["a write row", [row("x/note-set", "write")], "x/note-set"],
    ["a destructive row", [row("x/note-delete", "destructive")], "x/note-delete"],
    ["a known read with a write row", [row("core/get-site-info", "write")], "core/get-site-info"],
    ["a known read with a destructive row", [row("core/get-site-info", "destructive")], "core/get-site-info"],
    [
      "a name read on one server and write on another",
      [row("core/get-site-info", "read"), row("core/get-site-info", "write", "srv-2")],
      "core/get-site-info",
    ],
    ["a known read missing from the catalog", [], "core/get-site-info"],
    ["an ability missing from the catalog", [], "x/unknown"],
  ])("the read proxy refuses %s with the fixed refusal and never calls the invoker", async (_label, tools, toolName) => {
    listSiteToolsMock.mockResolvedValueOnce({ tools, catalogRevision: "rev-1" });
    await expect(read({ toolName, args: {}, instanceId: "wp-1" })).rejects.toThrow(SITE_TOOL_READ_ONLY_REFUSAL);
    expect(invokeSiteToolGuardedMock).not.toHaveBeenCalled();
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  it("the read proxy refuses the post update and create abilities even when the catalog says read", async () => {
    for (const toolName of ["ewpa/update-post", "ewpa/create-post"]) {
      listSiteToolsMock.mockResolvedValueOnce({ tools: [row(toolName, "read")], catalogRevision: "rev-1" });
      await expect(read({ toolName, args: { post_id: 1, title: "T" }, instanceId: "wp-1" })).rejects.toThrow(
        SITE_TOOL_READ_ONLY_REFUSAL,
      );
    }
    expect(invokeSiteToolGuardedMock).not.toHaveBeenCalled();
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  it("the read proxy refuses when the catalog listing is unbound or never ends", async () => {
    listSiteToolsMock.mockResolvedValue({ tools: [row("core/get-site-info", "read")], nextCursor: "again", catalogRevision: "rev-1" });
    await expect(read({ toolName: "core/get-site-info", instanceId: "wp-1" })).rejects.toThrow(SITE_TOOL_READ_ONLY_REFUSAL);
    _resetWordPressDepsForTests();
    registerWordPressConnector({
      invokeSiteTool: invokeSiteToolMock,
      invokeSiteToolGuarded: invokeSiteToolGuardedMock,
      siteToolGuardSupported: () => true,
    } as unknown as WordPressConnectorDeps);
    await expect(
      (createWordPressPrimitiveHandlers() as any).wordpress_site_tool_call({
        primitiveName: "wordpress_site_tool_call",
        input: { toolName: "core/get-site-info", instanceId: "wp-1" },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      }),
    ).rejects.toThrow(SITE_TOOL_READ_ONLY_REFUSAL);
    expect(invokeSiteToolGuardedMock).not.toHaveBeenCalled();
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  it("the read proxy passes on a listing error and never calls the invoker", async () => {
    listSiteToolsMock.mockRejectedValueOnce(new Error("catalog unavailable"));
    await expect(read({ toolName: "core/get-site-info", instanceId: "wp-1" })).rejects.toThrow("catalog unavailable");
    expect(invokeSiteToolGuardedMock).not.toHaveBeenCalled();
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  it("the read proxy refuses a read row on one page followed by a write row of the same name on a later page", async () => {
    listSiteToolsMock
      .mockResolvedValueOnce(catalogPage([row("core/get-site-info", "read")], "c-2"))
      .mockResolvedValueOnce(catalogPage([row("core/get-site-info", "write", "srv-2")]));
    await expect(read({ toolName: "core/get-site-info", instanceId: "wp-1" })).rejects.toThrow(SITE_TOOL_READ_ONLY_REFUSAL);
    expect(invokeSiteToolGuardedMock).not.toHaveBeenCalled();
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  it("the read proxy reads at most 20 catalog pages: a read row on the 20th page is forwarded", async () => {
    for (let page = 1; page < 20; page++) {
      listSiteToolsMock.mockResolvedValueOnce(catalogPage([], `c-${page + 1}`));
    }
    listSiteToolsMock.mockResolvedValueOnce(catalogPage([row("core/get-site-info", "read")]));
    await read({ toolName: "core/get-site-info", instanceId: "wp-1" });
    expect(listSiteToolsMock).toHaveBeenCalledTimes(20);
    expect(invokeSiteToolGuardedMock).toHaveBeenCalledTimes(1);
  });

  it("the read proxy refuses when the 20th catalog page still has a next page", async () => {
    for (let page = 1; page <= 20; page++) {
      listSiteToolsMock.mockResolvedValueOnce(catalogPage(page === 20 ? [row("core/get-site-info", "read")] : [], `c-${page + 1}`));
    }
    await expect(read({ toolName: "core/get-site-info", instanceId: "wp-1" })).rejects.toThrow(SITE_TOOL_READ_ONLY_REFUSAL);
    expect(listSiteToolsMock).toHaveBeenCalledTimes(20);
    expect(invokeSiteToolGuardedMock).not.toHaveBeenCalled();
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  it("the write tool forwards a write ability verbatim without listing the catalog", async () => {
    await write({ toolName: "ewpa/create-post", args: { title: "T", status: "publish" }, instanceId: "wp-1" });
    expect(listSiteToolsMock).not.toHaveBeenCalled();
    expect(invokeSiteToolMock).toHaveBeenCalledWith({
      toolName: "ewpa/create-post",
      args: { title: "T", status: "publish" },
      instanceId: "wp-1",
    });
  });
});
