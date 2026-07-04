// Verifies the first-party WordPress external-MCP toolbox (manifest-discovered
// builder). Instance settings, the cached mcp-adapter probe, the endpoint
// resolution, and the private-URL policy come through the host-bound deps
// (wired in src/lib/register-transport-connectors.ts; stubbed here). The
// Basic auth header is built in this extension from the instance credentials.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Buffer } from "node:buffer";

import {
  registerWordPressConnector,
  _resetWordPressDepsForTests,
  type WordPressMcpInstance,
} from "../deps";
import { createWordPressExternalMcpToolbox } from "../mcp/toolbox";

const listMcpInstances = vi.fn<() => WordPressMcpInstance[]>(() => []);
const probeMcpAdapter = vi.fn();
const requireInstanceWriteAuthority = vi.fn(async (_input: {
  instanceId: string;
  primitiveName: string;
}) => {});

const inst = (id: string, siteUrl?: string): WordPressMcpInstance => ({
  id,
  name: `Site ${id}`,
  siteUrl: siteUrl ?? `https://site-${id}.example.com`,
  username: `admin-${id}`,
  applicationPassword: `pass-${id}`,
});

const expectedBasicHeader = (instance: WordPressMcpInstance) =>
  `Basic ${Buffer.from(`${instance.username}:${instance.applicationPassword}`, "utf8").toString("base64")}`;

beforeEach(() => {
  vi.clearAllMocks();
  probeMcpAdapter.mockResolvedValue("registered");
  registerWordPressConnector({
    decodeCursor: () => 0,
    buildListPage: (items, total) => ({ items, total }),
    dispatchContentEditor: vi.fn(async () => ""),
    deleteInstance: vi.fn(async () => {}),
    listMcpInstances,
    probeMcpAdapter,
    resolveMcpServerUrl: (siteUrl: string) =>
      `${siteUrl.replace(/\/+$/, "")}/index.php?rest_route=/mcp/mcp-adapter-default-server`,
    isPrivateUrl: (url: string) => /localhost|127\.0\.0\.1|::1/.test(url),
    // Connection/instance-admin + content surface (cinatra#172 Stage H3 —
    // unused by the toolbox's code paths).
    getApiStatus: () => ({ status: "not_connected" as const, detail: "" }),
    createDraft: vi.fn(),
    readPost: vi.fn(),
    readPostStatus: vi.fn(),
    listPublishedPosts: vi.fn(async () => ({ items: [], total: 0 })),
    deletePost: vi.fn(async () => ({ deleted: true })),
    uploadMedia: vi.fn(),
    updateDraftMeta: vi.fn(),
    updatePost: vi.fn(),
    // cinatra#409 per-instance `use` authority gate — the external-MCP toolbox
    // now gates EACH instance through this before emitting its credentials.
    // Default stub allows; tests override to deny.
    requireInstanceWriteAuthority,
  });
});

afterEach(() => {
  _resetWordPressDepsForTests();
});

describe("createWordPressExternalMcpToolbox().buildTools", () => {
  it("returns [] when no instances configured", async () => {
    listMcpInstances.mockReturnValue([]);
    expect(await createWordPressExternalMcpToolbox().buildTools("openai")).toEqual([]);
  });

  it("skips private URLs (localhost) — never returned to LLM", async () => {
    listMcpInstances.mockReturnValue([inst("a", "http://localhost:8081")]);
    expect(await createWordPressExternalMcpToolbox().buildTools("openai")).toEqual([]);
    expect(probeMcpAdapter).not.toHaveBeenCalled();
  });

  it("skips instances whose mcp-adapter probe is not 'registered'", async () => {
    listMcpInstances.mockReturnValue([inst("a"), inst("b")]);
    probeMcpAdapter.mockResolvedValueOnce("not_installed").mockResolvedValueOnce("registered");

    const result = await createWordPressExternalMcpToolbox().buildTools("openai");

    expect(result).toHaveLength(1);
    expect(result[0].serverLabel).toBe("wordpress-b");
  });

  it("emits one MCP server tool per reachable instance with Basic auth + query-string endpoint", async () => {
    const a = inst("a");
    listMcpInstances.mockReturnValue([a]);

    const result = await createWordPressExternalMcpToolbox().buildTools("openai");

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "mcp",
      serverLabel: "wordpress-a",
      serverUrl:
        "https://site-a.example.com/index.php?rest_route=/mcp/mcp-adapter-default-server",
      headers: { Authorization: expectedBasicHeader(a) },
      serverDescription:
        "WordPress site Site a (https://site-a.example.com) — MCP adapter",
      allowedTools: null,
      // Writes require approval (was "never") — see the
      // dedicated requireApproval regression test below.
      requireApproval: "read-only",
    });
  });

  it("returns [] and never throws when deps are unavailable", async () => {
    _resetWordPressDepsForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await createWordPressExternalMcpToolbox().buildTools("openai");

    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("emitted tool gates writes — requireApproval is 'read-only', not 'never'", async () => {
    // WP mcp-adapter tool names are not enumerable (external plugin) so we gate
    // writes by approval semantics, not by an unauthoritative static allowlist.
    // A state-mutating tool must never be auto-approved.
    listMcpInstances.mockReturnValue([inst("a")]);
    const result = await createWordPressExternalMcpToolbox().buildTools("openai");
    expect(result).toHaveLength(1);
    expect(result[0].requireApproval).toBe("read-only");
    expect(result[0].requireApproval).not.toBe("never");
  });

  // === Authorization regression coverage ===
  // (CWE-862/863): the external-MCP toolbox enumerated EVERY org-wide instance
  // and emitted a credentialed MCP server (WP Application Password) for each,
  // with no per-actor/per-tenant authorization — a connector confused deputy
  // letting any chat path use another tenant's WordPress credentials. The fix
  // gates each instance through the host-resolved per-instance `use` authority
  // (`requireInstanceWriteAuthority`) and fails closed on any deny/missing actor.
  describe("authorization", () => {
    it("NEGATIVE — fails closed when the actor cannot use the instance (no actor frame / deny)", async () => {
      // Host-side authority throws (no resolvable actor, or actor lacks `use`).
      listMcpInstances.mockReturnValue([inst("a"), inst("b")]);
      requireInstanceWriteAuthority.mockRejectedValue(new Error("not authorized"));

      const result = await createWordPressExternalMcpToolbox().buildTools("openai");

      // No credentialed MCP server is emitted for ANY instance — the cross-actor
      // / no-actor unauthorized path injects nothing.
      expect(result).toEqual([]);
      // And the WP adapter probe is never even reached for denied instances —
      // authorization gates BEFORE any per-instance work.
      expect(probeMcpAdapter).not.toHaveBeenCalled();
    });

    it("NEGATIVE — denies cross-tenant instances, emits only the authorized actor's own", async () => {
      // org A's actor: authority allows instance "a-owned", denies "b-other-org".
      const owned = inst("a-owned");
      const otherOrg = inst("b-other-org");
      listMcpInstances.mockReturnValue([owned, otherOrg]);
      requireInstanceWriteAuthority.mockImplementation(async ({ instanceId }) => {
        if (instanceId === "b-other-org") throw new Error("cross-tenant: no use grant for this org");
      });

      const result = await createWordPressExternalMcpToolbox().buildTools("openai");

      // Only the instance the actor is authorized to use is exposed; the other
      // tenant's credentials are never emitted.
      expect(result).toHaveLength(1);
      expect(result[0].serverLabel).toBe("wordpress-a-owned");
    });

    it("POSITIVE — the authorized actor path still emits the instance's MCP tool", async () => {
      // Authority resolves without throwing for the authorized actor → the
      // intended authorized path is preserved.
      const a = inst("a");
      listMcpInstances.mockReturnValue([a]);
      requireInstanceWriteAuthority.mockResolvedValue(undefined);

      const result = await createWordPressExternalMcpToolbox().buildTools("openai");

      expect(result).toHaveLength(1);
      expect(result[0].serverLabel).toBe("wordpress-a");
      expect(result[0].headers).toEqual({ Authorization: expectedBasicHeader(a) });
      expect(requireInstanceWriteAuthority).toHaveBeenCalledWith({
        instanceId: "a",
        primitiveName: "wordpress_external_mcp_toolbox_inject",
      });
    });

    it("NEGATIVE — fails closed when a widened host passes an incomplete actor frame", async () => {
      // Forward-compat: if the (future) widened host passes an actor object that
      // lacks a trusted userId/orgId, emit nothing — never fall back to org-wide.
      listMcpInstances.mockReturnValue([inst("a")]);
      requireInstanceWriteAuthority.mockResolvedValue(undefined);

      // The SDK contract is still the narrow `buildTools(provider)`; the widened
      // actor-frame parameter is connector-local forward-compat (see
      // WordPressToolboxActor in ../mcp/toolbox), so call through the widened shape.
      const buildTools = createWordPressExternalMcpToolbox().buildTools as (
        provider: string,
        actor?: { userId?: string; organizationId?: string },
      ) => Promise<unknown[]>;
      const result = await buildTools("openai", {
        userId: "",
        organizationId: "",
      });

      expect(result).toEqual([]);
      expect(requireInstanceWriteAuthority).not.toHaveBeenCalled();
    });
  });
});
