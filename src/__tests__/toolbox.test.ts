// Verifies the first-party WordPress external-MCP toolbox (manifest-discovered
// builder) in its S0 (cinatra#2015) guarded state:
//
//   - `createWordPressExternalMcpToolbox().buildTools` is pinned to `[]` in
//     EVERY configuration — the hard default-off guard that only S4
//     (trusted-site mode, cinatra#2019) replaces with the real per-instance
//     opt-in gate. S4 flips these pins deliberately; nothing else may.
//   - `buildTrustedSiteToolSet` (the construction S4 will wire behind that
//     gate) keeps every underlying behavior pinned so the S4 flip cannot
//     resurrect rotten code: per-instance authorization, private-URL policy,
//     probe gating, Basic-auth header construction, immutable naming, and the
//     current approval vocabulary.
//
// Instance settings, the cached mcp-adapter probe, the endpoint resolution,
// and the private-URL policy come through the host-bound deps (wired in
// src/lib/register-transport-connectors.ts; stubbed here).

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Buffer } from "node:buffer";

import {
  registerWordPressConnector,
  _resetWordPressDepsForTests,
  type WordPressMcpInstance,
} from "../deps";
import {
  buildTrustedSiteToolSet,
  createWordPressExternalMcpToolbox,
  wordpressToolboxServerLabel,
} from "../mcp/toolbox";

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
    buildWordPressBasicAuthHeader: vi.fn(async () => ({ Authorization: "Basic test" })),
    createDraft: vi.fn(),
    readPostStatus: vi.fn(),
    listPublishedPosts: vi.fn(async () => ({ items: [], total: 0 })),
    listPublishedPages: vi.fn(async () => ({ items: [], total: 0 })),
    deletePost: vi.fn(async () => ({ deleted: true })),
    uploadMedia: vi.fn(),
    updateDraftMeta: vi.fn(),
    // cinatra#409 per-instance `use` authority gate — the trusted-site tool
    // set gates EACH instance through this before emitting its credentials.
    // Default stub allows; tests override to deny.
    requireInstanceWriteAuthority,
  });
});

afterEach(() => {
  _resetWordPressDepsForTests();
});

// ---------------------------------------------------------------------------
// S0 hard guard (cinatra#2015) — flipped ONLY by S4 (cinatra#2019)
// ---------------------------------------------------------------------------

describe("createWordPressExternalMcpToolbox().buildTools — S0 hard guard", () => {
  it("emits ZERO entries with no instances configured", async () => {
    listMcpInstances.mockReturnValue([]);
    expect(await createWordPressExternalMcpToolbox().buildTools("openai")).toEqual([]);
  });

  it("emits ZERO entries even in the maximal configuration (instances present, authorized, adapter registered)", async () => {
    // This is the configuration that WOULD inject before S0: reachable public
    // instance, per-instance authority allows, probe registered. The guard
    // must still emit nothing — repairing the approval vocabulary must not
    // revive unrestricted native injection before the S4 opt-in gate exists.
    listMcpInstances.mockReturnValue([inst("a"), inst("b")]);
    requireInstanceWriteAuthority.mockResolvedValue(undefined);
    probeMcpAdapter.mockResolvedValue("registered");

    expect(await createWordPressExternalMcpToolbox().buildTools("openai")).toEqual([]);

    // The guard sits BEFORE any per-instance work: no enumeration, no
    // authority resolution, no probe, no credential ever touched.
    expect(listMcpInstances).not.toHaveBeenCalled();
    expect(requireInstanceWriteAuthority).not.toHaveBeenCalled();
    expect(probeMcpAdapter).not.toHaveBeenCalled();
  });

  it("emits ZERO entries for every provider argument", async () => {
    listMcpInstances.mockReturnValue([inst("a")]);
    for (const provider of ["openai", "anthropic", "google", ""]) {
      expect(await createWordPressExternalMcpToolbox().buildTools(provider)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// The trusted-site tool set S4 wires behind its opt-in gate — kept fully
// pinned here so the flip cannot resurrect rotten code.
// ---------------------------------------------------------------------------

describe("buildTrustedSiteToolSet (S4-gated construction)", () => {
  it("returns [] when no instances configured", async () => {
    listMcpInstances.mockReturnValue([]);
    expect(await buildTrustedSiteToolSet("openai")).toEqual([]);
  });

  it("skips private URLs (localhost) — never returned to LLM", async () => {
    listMcpInstances.mockReturnValue([inst("a", "http://localhost:8081")]);
    expect(await buildTrustedSiteToolSet("openai")).toEqual([]);
    expect(probeMcpAdapter).not.toHaveBeenCalled();
  });

  it("skips instances whose mcp-adapter probe is not 'registered'", async () => {
    listMcpInstances.mockReturnValue([inst("a"), inst("b")]);
    probeMcpAdapter.mockResolvedValueOnce("not_installed").mockResolvedValueOnce("registered");

    const result = await buildTrustedSiteToolSet("openai");

    expect(result).toHaveLength(1);
    expect(result[0].serverLabel).toBe("wordpress-b");
  });

  it("emits one MCP server tool per reachable instance with Basic auth + query-string endpoint", async () => {
    const a = inst("a");
    listMcpInstances.mockReturnValue([a]);

    const result = await buildTrustedSiteToolSet("openai");

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
      approval: "auto_execute",
    });
  });

  it("returns [] and never throws when deps are unavailable", async () => {
    _resetWordPressDepsForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await buildTrustedSiteToolSet("openai");

    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // === Approval vocabulary (cinatra#2015 deliverable 1) ===
  describe("approval vocabulary", () => {
    it("emits the CURRENT vocabulary: approval 'auto_execute', and never the retired requireApproval key", async () => {
      // The old entry carried the retired `requireApproval` token, which the
      // host sanitizer drops fail-closed — the toolbox injected NOTHING. The
      // repaired entry uses the current vocabulary. auto_execute is correct
      // for this path: S4 injects only the descriptor-verified trusted-READ
      // set; writes go through the governed invoker (M1) with its own audit
      // and destructive confirmation, never through provider-direct injection.
      listMcpInstances.mockReturnValue([inst("a")]);
      const result = await buildTrustedSiteToolSet("openai");
      expect(result).toHaveLength(1);
      expect(result[0].approval).toBe("auto_execute");
      expect("requireApproval" in result[0]).toBe(false);
    });
  });

  // === Immutable naming (cinatra#2015 deliverable 5) ===
  describe("immutable toolbox naming", () => {
    it("pins the label format wordpress-${instance.id}", () => {
      expect(wordpressToolboxServerLabel("abc-123")).toBe("wordpress-abc-123");
    });

    it("the emitted tool uses exactly the pinned label helper", async () => {
      listMcpInstances.mockReturnValue([inst("pin-me")]);
      const result = await buildTrustedSiteToolSet("openai");
      expect(result).toHaveLength(1);
      expect(result[0].serverLabel).toBe(wordpressToolboxServerLabel("pin-me"));
    });
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

      const result = await buildTrustedSiteToolSet("openai");

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

      const result = await buildTrustedSiteToolSet("openai");

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

      const result = await buildTrustedSiteToolSet("openai");

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

      const result = await buildTrustedSiteToolSet("openai", {
        userId: "",
        organizationId: "",
      });

      expect(result).toEqual([]);
      expect(requireInstanceWriteAuthority).not.toHaveBeenCalled();
    });
  });
});
