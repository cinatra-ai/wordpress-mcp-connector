// cinatra#3745 (owner decision 1234 A): a flow step reads the page and writes
// the reviewed change without a model. The host serves a connector tool to such
// a step when the tool's registration declares `passthroughStep`:
//   - `wordpress_site_tool_write` declares "publishing" (served only to a
//     publishing step whose card a person released) and keeps `outward: {}`;
//   - `wordpress_site_tool_call` declares nothing yet: a "read" declaration
//     waits until the host enforces the read class at execution.
// A flow template renders its arguments as text, so both tools also take the
// ability's arguments as JSON text (`argsJson`).
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SiteToolRow, SiteToolsListPage } from "@cinatra-ai/sdk-extensions";

import {
  createWordPressPrimitiveHandlers,
  SITE_TOOL_ARGS_BOTH_REFUSAL,
  SITE_TOOL_ARGS_JSON_MAX_BYTES,
  SITE_TOOL_ARGS_JSON_REFUSAL,
  SITE_TOOL_ARGS_JSON_TOO_LARGE_REFUSAL,
  SITE_TOOL_CATALOG_CHANGED_REFUSAL,
  SITE_TOOL_READ_ONLY_REFUSAL,
} from "@cinatra-ai/wordpress-mcp-connector/mcp-handlers";
import { registerWordPressPrimitives } from "../mcp/registry";
import { registerWordPressConnector, _resetWordPressDepsForTests, type WordPressConnectorDeps } from "../deps";

const invokeSiteToolMock = vi.fn(async (_input: unknown): Promise<unknown> => ({ ok: true }));
const invokeSiteToolGuardedMock = vi.fn(async (_input: unknown): Promise<unknown> => ({ ok: true }));
const listSiteToolsMock = vi.fn(
  async (_input: unknown): Promise<SiteToolsListPage> => ({ tools: [], catalogRevision: "rev-1" }),
);

const DEFAULT_SERVER = "mcp-adapter-default";

function row(
  name: string,
  derivedClass: SiteToolRow["derivedClass"],
  rawAnnotations: Record<string, unknown> = {},
  serverId = "srv-1",
): SiteToolRow {
  return {
    name,
    serverId,
    inputSchema: {},
    rawAnnotations,
    derivedClass,
    policyStatus: "allowed",
    cacheAgeMs: 0,
    catalogRevision: "rev-1",
  };
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

describe("passthrough step declarations and JSON text arguments (cinatra#3745)", () => {
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
      listMcpInstances: () => [
        { id: "wp-1", siteUrl: "https://example.com", username: "u", applicationPassword: "p", name: "Site 1", createdAt: "", updatedAt: "" },
      ],
    } as unknown as WordPressConnectorDeps);
    handlers = createWordPressPrimitiveHandlers();
  });

  const call = (tool: "wordpress_site_tool_call" | "wordpress_site_tool_write", input: unknown) =>
    (handlers as any)[tool]({
      primitiveName: tool,
      input,
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
  const read = (input: unknown) => call("wordpress_site_tool_call", input);
  const write = (input: unknown) => call("wordpress_site_tool_write", input);

  describe("registry declarations", () => {
    it("declares no passthroughStep and nothing outward on the read tool", () => {
      const config = registeredConfigs().get("wordpress_site_tool_call")!;
      expect("passthroughStep" in config).toBe(false);
      expect("outward" in config).toBe(false);
    });

    it("declares passthroughStep \"publishing\" on the write tool and keeps outward: {}", () => {
      const config = registeredConfigs().get("wordpress_site_tool_write")!;
      expect(config.passthroughStep).toBe("publishing");
      expect(config.outward).toEqual({});
    });

    it("declares passthroughStep only on the write tool", () => {
      const declared = [...registeredConfigs()]
        .filter(([, config]) => "passthroughStep" in config)
        .map(([name, config]) => [name, config.passthroughStep]);
      expect(declared).toEqual([["wordpress_site_tool_write", "publishing"]]);
    });

    it("declares \"read\" on no registration", () => {
      for (const [, config] of registeredConfigs()) expect(config.passthroughStep).not.toBe("read");
    });
  });

  describe("argsJson", () => {
    it("the read tool accepts the arguments as JSON text and forwards the parsed object", async () => {
      listSiteToolsMock.mockResolvedValueOnce({
        tools: [row("cinatra/post-read", "read", { readonly: true, destructive: false })],
        catalogRevision: "rev-1",
      });
      await read({ toolName: "cinatra/post-read", argsJson: '{"post_id":42}', instanceId: "wp-1" });
      expect(invokeSiteToolGuardedMock).toHaveBeenCalledWith({
        toolName: "cinatra/post-read",
        args: { post_id: 42 },
        instanceId: "wp-1",
        serverId: "srv-1",
        expectedRawAnnotations: { readonly: true, destructive: false },
        expectedClass: "read",
      });
      expect(invokeSiteToolMock).not.toHaveBeenCalled();
    });

    it("the write tool accepts the arguments as JSON text and forwards the parsed object", async () => {
      const args = {
        post_id: 42,
        if_unmodified_since: "2026-11-25 10:00:00",
        expected: { title: "T", content: "<p>a</p>", excerpt: "", status: "draft", row_token: "a".repeat(64) },
        content: "<p>b</p>",
      };
      await write({ toolName: "cinatra/post-update-if-unchanged", argsJson: JSON.stringify(args), instanceId: "wp-1" });
      expect(listSiteToolsMock).not.toHaveBeenCalled();
      expect(invokeSiteToolMock).toHaveBeenCalledWith({
        toolName: "cinatra/post-update-if-unchanged",
        args,
        instanceId: "wp-1",
      });
    });

    it("the write tool forwards the plugin's row_token unchanged and returns its refusal results as they are", async () => {
      // The connector does not check this ability's arguments or results: the
      // plugin refuses a missing or malformed expected.row_token itself.
      const policyConflict = {
        success: false,
        code: "site_policy_conflict",
        message: "A site filter wanted to change a column this save does not write.",
        data: { changed: ["post_name"] },
      };
      invokeSiteToolMock.mockResolvedValueOnce(policyConflict);
      const token = "0123456789abcdef".repeat(4);
      const argsJson =
        '{"post_id":7,"if_unmodified_since":"2026-11-25 10:00:00","content":"<p>b</p>",' +
        `"expected":{"title":"T","content":"<p>a</p>","excerpt":"","status":"publish","row_token":"${token}"}}`;
      const result = await write({ toolName: "cinatra/post-update-if-unchanged", argsJson, instanceId: "wp-1" });
      const forwarded = invokeSiteToolMock.mock.calls[0]![0] as { args: { expected: Record<string, unknown> } };
      expect(forwarded.args.expected.row_token).toBe(token);
      expect(result).toEqual(policyConflict);
    });

    it("the post update argument checks also apply to arguments given as JSON text", async () => {
      await expect(
        write({ toolName: "ewpa/update-post", argsJson: '{"post_id":1,"slug":"x"}', instanceId: "wp-1" }),
      ).rejects.toThrow(/outside the content-review scope/);
      expect(invokeSiteToolMock).not.toHaveBeenCalled();
    });

    it.each(["wordpress_site_tool_call", "wordpress_site_tool_write"] as const)(
      "%s refuses args and argsJson together",
      async (tool) => {
        await expect(
          call(tool, { toolName: "core/get-site-info", args: {}, argsJson: "{}", instanceId: "wp-1" }),
        ).rejects.toThrow(SITE_TOOL_ARGS_BOTH_REFUSAL);
        expect(invokeSiteToolMock).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["text that is not JSON", '{"post_id": 42, secret-value'],
      ["a JSON array", "[1,2]"],
      ["a JSON string", '"secret-value"'],
      ["JSON null", "null"],
      ["a JSON number", "42"],
    ])("refuses %s with the fixed message that never echoes the text", async (_label, argsJson) => {
      for (const tool of ["wordpress_site_tool_call", "wordpress_site_tool_write"] as const) {
        const error = await call(tool, { toolName: "core/get-site-info", argsJson, instanceId: "wp-1" }).catch(
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(SITE_TOOL_ARGS_JSON_REFUSAL);
        expect((error as Error).message).not.toContain("secret-value");
      }
      expect(invokeSiteToolMock).not.toHaveBeenCalled();
    });

    it("bounds the JSON text at 256 KiB, counted in UTF-8 bytes", async () => {
      expect(SITE_TOOL_ARGS_JSON_MAX_BYTES).toBe(262_144);
      const pad = (bytes: number) => `{"content":"${"a".repeat(bytes - 14)}"}`;
      expect(new TextEncoder().encode(pad(SITE_TOOL_ARGS_JSON_MAX_BYTES)).length).toBe(SITE_TOOL_ARGS_JSON_MAX_BYTES);

      await write({ toolName: "x/save", argsJson: pad(SITE_TOOL_ARGS_JSON_MAX_BYTES), instanceId: "wp-1" });
      expect(invokeSiteToolMock).toHaveBeenCalledTimes(1);

      await expect(
        write({ toolName: "x/save", argsJson: pad(SITE_TOOL_ARGS_JSON_MAX_BYTES + 1), instanceId: "wp-1" }),
      ).rejects.toThrow(SITE_TOOL_ARGS_JSON_TOO_LARGE_REFUSAL);
      // Multi-byte characters count by their UTF-8 length, not by string length.
      const multiByte = `{"content":"${"é".repeat(SITE_TOOL_ARGS_JSON_MAX_BYTES / 2)}"}`;
      expect(multiByte.length).toBeLessThan(SITE_TOOL_ARGS_JSON_MAX_BYTES);
      await expect(write({ toolName: "x/save", argsJson: multiByte, instanceId: "wp-1" })).rejects.toThrow(
        SITE_TOOL_ARGS_JSON_TOO_LARGE_REFUSAL,
      );
      expect(invokeSiteToolMock).toHaveBeenCalledTimes(1);
    });

    it("the object form is unchanged: omitted args still forward as {}", async () => {
      await write({ toolName: "x/ping", instanceId: "wp-1" });
      expect(invokeSiteToolMock).toHaveBeenCalledWith({ toolName: "x/ping", args: {}, instanceId: "wp-1" });
    });

    it("never forwards argsJson itself to the invoker", async () => {
      await write({ toolName: "x/save", argsJson: '{"a":1}', instanceId: "wp-1" });
      const forwarded = invokeSiteToolMock.mock.calls[0]![0] as Record<string, unknown>;
      expect("argsJson" in forwarded).toBe(false);
    });
  });

  describe("the read tool never reaches a writing ability", () => {
    // The read exemption is decided on the catalog row of the server that will
    // run the call, never on the ability name alone.
    const readOnly = { readOnlyHint: true, destructiveHint: false };

    it("refuses a known read name that a second enrolled server exposes as a writer, and forwards nothing", async () => {
      listSiteToolsMock.mockResolvedValueOnce({
        tools: [row("ewpa/get-post", "write", { readOnlyHint: false }, "wps-other")],
        catalogRevision: "rev-1",
      });
      await expect(
        read({ toolName: "ewpa/get-post", argsJson: '{"post_id":1}', instanceId: "wp-1", serverId: "wps-other" }),
      ).rejects.toThrow(SITE_TOOL_READ_ONLY_REFUSAL);
      expect(listSiteToolsMock).toHaveBeenCalledWith({ instanceId: "wp-1", serverId: "wps-other" });
      expect(invokeSiteToolGuardedMock).not.toHaveBeenCalled();
    });

    it("refuses a known read name that a second server exposes as destructive, even with a read-only hint", async () => {
      listSiteToolsMock.mockResolvedValueOnce({
        tools: [row("ewpa/get-post", "destructive", { readOnlyHint: true, destructiveHint: true }, "wps-other")],
        catalogRevision: "rev-1",
      });
      await expect(
        read({ toolName: "ewpa/get-post", args: { post_id: 1 }, instanceId: "wp-1", serverId: "wps-other" }),
      ).rejects.toThrow(SITE_TOOL_READ_ONLY_REFUSAL);
      expect(invokeSiteToolGuardedMock).not.toHaveBeenCalled();
    });

    it("refuses a known read name the default server reads but a second server writes, when no server is named", async () => {
      listSiteToolsMock.mockResolvedValueOnce({
        tools: [
          row("ewpa/get-post", "write", {}, DEFAULT_SERVER),
          row("ewpa/get-post", "write", { readOnlyHint: false }, "wps-other"),
        ],
        catalogRevision: "rev-1",
      });
      await expect(read({ toolName: "ewpa/get-post", args: { post_id: 1 }, instanceId: "wp-1" })).rejects.toThrow(
        SITE_TOOL_READ_ONLY_REFUSAL,
      );
      expect(invokeSiteToolGuardedMock).not.toHaveBeenCalled();
    });

    it("refuses a row whose stored annotations carry a destructive hint, whatever its class says", async () => {
      listSiteToolsMock.mockResolvedValueOnce({
        tools: [row("cinatra/post-read", "read", { readonly: true, destructive: true }, DEFAULT_SERVER)],
        catalogRevision: "rev-1",
      });
      await expect(read({ toolName: "cinatra/post-read", args: { post_id: 1 }, instanceId: "wp-1" })).rejects.toThrow(
        SITE_TOOL_READ_ONLY_REFUSAL,
      );
      expect(invokeSiteToolGuardedMock).not.toHaveBeenCalled();
    });

    it("refuses a known read name with no catalog row, and forwards nothing", async () => {
      listSiteToolsMock.mockResolvedValueOnce({ tools: [], catalogRevision: "rev-1" });
      await expect(read({ toolName: "cinatra/post-read", args: { post_id: 1 }, instanceId: "wp-1" })).rejects.toThrow(
        SITE_TOOL_READ_ONLY_REFUSAL,
      );
      expect(invokeSiteToolGuardedMock).not.toHaveBeenCalled();
    });

    it("refuses when the only row of the name belongs to another server than the one named", async () => {
      listSiteToolsMock.mockResolvedValueOnce({
        tools: [row("cinatra/post-read", "read", readOnly, DEFAULT_SERVER)],
        catalogRevision: "rev-1",
      });
      await expect(
        read({ toolName: "cinatra/post-read", args: { post_id: 1 }, instanceId: "wp-1", serverId: "wps-other" }),
      ).rejects.toThrow(SITE_TOOL_READ_ONLY_REFUSAL);
      expect(invokeSiteToolGuardedMock).not.toHaveBeenCalled();
    });

    it("refuses an ability the catalog lists as read when its name is not a known read", async () => {
      listSiteToolsMock.mockResolvedValueOnce({ tools: [row("x/note-get", "read", readOnly)], catalogRevision: "rev-1" });
      await expect(read({ toolName: "x/note-get", instanceId: "wp-1" })).rejects.toThrow(SITE_TOOL_READ_ONLY_REFUSAL);
      expect(invokeSiteToolGuardedMock).not.toHaveBeenCalled();
    });

    it("serves the genuine read and pins the call to the server whose row was read", async () => {
      listSiteToolsMock.mockResolvedValueOnce({
        tools: [row("cinatra/post-read", "read", readOnly, DEFAULT_SERVER)],
        catalogRevision: "rev-1",
      });
      await read({ toolName: "cinatra/post-read", argsJson: '{"post_id":42}', instanceId: "wp-1" });
      expect(invokeSiteToolGuardedMock).toHaveBeenCalledWith({
        toolName: "cinatra/post-read",
        args: { post_id: 42 },
        instanceId: "wp-1",
        serverId: DEFAULT_SERVER,
        expectedRawAnnotations: readOnly,
        expectedClass: "read",
      });
      expect(invokeSiteToolMock).not.toHaveBeenCalled();
    });

    it("serves an unannotated known ewpa read only on the default adapter server", async () => {
      listSiteToolsMock.mockResolvedValueOnce({ tools: [row("ewpa/get-post", "write", {}, DEFAULT_SERVER)], catalogRevision: "rev-1" });
      await read({ toolName: "ewpa/get-post", args: { post_id: 42 }, instanceId: "wp-1" });
      expect(invokeSiteToolGuardedMock).toHaveBeenCalledWith({
        toolName: "ewpa/get-post",
        args: { post_id: 42 },
        instanceId: "wp-1",
        serverId: DEFAULT_SERVER,
        expectedRawAnnotations: {},
      });
      invokeSiteToolGuardedMock.mockClear();
      listSiteToolsMock.mockResolvedValueOnce({ tools: [row("ewpa/get-post", "write", {}, "wps-other")], catalogRevision: "rev-1" });
      await expect(read({ toolName: "ewpa/get-post", args: { post_id: 42 }, instanceId: "wp-1" })).rejects.toThrow(
        SITE_TOOL_READ_ONLY_REFUSAL,
      );
      expect(invokeSiteToolGuardedMock).not.toHaveBeenCalled();
    });

    it("sends the annotations of the row it validated with the guarded call", async () => {
      const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
      listSiteToolsMock.mockResolvedValueOnce({
        tools: [row("cinatra/post-read", "read", annotations, DEFAULT_SERVER)],
        catalogRevision: "rev-1",
      });
      await read({ toolName: "cinatra/post-read", args: { post_id: 3 }, instanceId: "wp-1" });
      expect(invokeSiteToolGuardedMock).toHaveBeenCalledWith({
        toolName: "cinatra/post-read",
        args: { post_id: 3 },
        instanceId: "wp-1",
        serverId: DEFAULT_SERVER,
        expectedRawAnnotations: annotations,
        expectedClass: "read",
      });
    });

    it("reads the catalog again on every call: a row that turned into a write is refused on the next call", async () => {
      listSiteToolsMock
        .mockResolvedValueOnce({ tools: [row("cinatra/post-read", "read", readOnly, DEFAULT_SERVER)], catalogRevision: "rev-1" })
        .mockResolvedValueOnce({
          tools: [row("cinatra/post-read", "write", { readOnlyHint: false }, DEFAULT_SERVER)],
          catalogRevision: "rev-2",
        });
      await read({ toolName: "cinatra/post-read", args: { post_id: 3 }, instanceId: "wp-1" });
      await expect(read({ toolName: "cinatra/post-read", args: { post_id: 3 }, instanceId: "wp-1" })).rejects.toThrow(
        SITE_TOOL_READ_ONLY_REFUSAL,
      );
      expect(listSiteToolsMock).toHaveBeenCalledTimes(2);
      expect(invokeSiteToolGuardedMock).toHaveBeenCalledTimes(1);
    });

    it("the publishing tool is unchanged: it lists no catalog and adds no server", async () => {
      await write({ toolName: "ewpa/get-post", args: { post_id: 1 }, instanceId: "wp-1" });
      expect(listSiteToolsMock).not.toHaveBeenCalled();
      expect(invokeSiteToolMock).toHaveBeenCalledWith({ toolName: "ewpa/get-post", args: { post_id: 1 }, instanceId: "wp-1" });
    });

    it("refuses the plugin's guarded update ability, which the catalog marks destructive", async () => {
      listSiteToolsMock.mockResolvedValueOnce({
        tools: [row("cinatra/post-update-if-unchanged", "destructive", { readonly: false, destructive: true })],
        catalogRevision: "rev-1",
      });
      await expect(
        read({ toolName: "cinatra/post-update-if-unchanged", argsJson: '{"post_id":1}', instanceId: "wp-1" }),
      ).rejects.toThrow(SITE_TOOL_READ_ONLY_REFUSAL);
      expect(invokeSiteToolGuardedMock).not.toHaveBeenCalled();
    });

    it("refuses a known read whose row has no read-only annotation (the host lists it as write)", async () => {
      listSiteToolsMock.mockResolvedValueOnce({
        tools: [row("core/get-site-info", "write", {}, DEFAULT_SERVER)],
        catalogRevision: "rev-1",
      });
      await expect(read({ toolName: "core/get-site-info", argsJson: "{}", instanceId: "wp-1" })).rejects.toThrow(
        SITE_TOOL_READ_ONLY_REFUSAL,
      );
      expect(invokeSiteToolGuardedMock).not.toHaveBeenCalled();
    });

    it("refuses when the catalog cannot be read", async () => {
      listSiteToolsMock.mockRejectedValueOnce(new Error("catalog unavailable"));
      await expect(read({ toolName: "cinatra/post-read", argsJson: "{}", instanceId: "wp-1" })).rejects.toThrow(
        "catalog unavailable",
      );
      expect(invokeSiteToolGuardedMock).not.toHaveBeenCalled();
    });

    it("never calls the unguarded method for a read", async () => {
      listSiteToolsMock.mockResolvedValueOnce({ tools: [row("cinatra/post-read", "read", readOnly)], catalogRevision: "rev-1" });
      await read({ toolName: "cinatra/post-read", args: { post_id: 1 }, instanceId: "wp-1" });
      expect(invokeSiteToolGuardedMock).toHaveBeenCalledTimes(1);
      expect(invokeSiteToolMock).not.toHaveBeenCalled();
    });
  });

  // The read check is not atomic with the listing: the host resolves the call
  // against its own snapshot. The guarded call carries the validated row's
  // annotations, and the host refuses a row that changed (catalog_entry_changed).
  describe("a row that changes between the listing and the call", () => {
    function changeAfterListing(live: { rawAnnotations: Record<string, unknown> }) {
      listSiteToolsMock.mockImplementationOnce(async () => {
        const page = {
          tools: [row("cinatra/post-read", "read", { ...live.rawAnnotations }, DEFAULT_SERVER)],
          catalogRevision: "rev-1",
        };
        live.rawAnnotations = { readOnlyHint: false };
        return page;
      });
    }

    it("the call carries the annotations of the row that was validated, not of the changed row", async () => {
      changeAfterListing({ rawAnnotations: { readOnlyHint: true } });
      await read({ toolName: "cinatra/post-read", args: { post_id: 3 }, instanceId: "wp-1" });
      const sent = invokeSiteToolGuardedMock.mock.calls[0]![0] as { expectedRawAnnotations?: unknown };
      expect(sent.expectedRawAnnotations).toEqual({ readOnlyHint: true });
    });

    it("a host that finds the row changed refuses, and the read tool returns its refusal", async () => {
      const live = { rawAnnotations: { readOnlyHint: true } as Record<string, unknown> };
      changeAfterListing(live);
      invokeSiteToolGuardedMock.mockRejectedValueOnce(
        Object.assign(new Error("changed"), { name: "InvokerError", code: "catalog_entry_changed" }),
      );
      await expect(read({ toolName: "cinatra/post-read", args: { post_id: 3 }, instanceId: "wp-1" })).rejects.toThrow(
        SITE_TOOL_CATALOG_CHANGED_REFUSAL,
      );
      expect(live.rawAnnotations).toEqual({ readOnlyHint: false });
      expect(invokeSiteToolGuardedMock).toHaveBeenCalledTimes(1);
      expect(invokeSiteToolMock).not.toHaveBeenCalled();
    });
  });
});
