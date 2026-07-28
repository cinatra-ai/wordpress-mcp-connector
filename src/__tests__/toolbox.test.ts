// Verifies the first-party WordPress external-MCP toolbox (manifest-discovered
// builder) in its S4 trusted-site-mode state (cinatra#2019 — the flip that
// replaced the S0 hard default-off guard, cinatra#2015):
//
//   - `createWordPressExternalMcpToolbox().buildTools` emits ONLY when the
//     host-built context says `surface: "chat"` AND the host's per-instance
//     native read-injection member grants — an absent context (a host that
//     predates the SDK `buildTools(provider, context?)` widening), a non-chat
//     surface, an unbound member (a pre-S4 host), a null grant (mode off /
//     consent stale / empty verified set), a non-default serverId, and a
//     malformed allowlist ALL emit nothing. The pre-flip boundary gates
//     (per-instance authorization, private-URL policy, probe gating,
//     Basic-auth header construction, immutable naming, approval vocabulary)
//     are preserved unchanged and stay pinned here.
//   - `allowedTools: null` (the full site catalog) is unrepresentable: every
//     emitted entry carries EXACTLY the host-granted non-empty name list.
//
// Instance settings, the cached mcp-adapter probe, the endpoint resolution,
// the private-URL policy, and the injection decision come through the
// host-bound deps (wired in src/register.ts; stubbed here).

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Buffer } from "node:buffer";

import {
  registerWordPressConnector,
  _resetWordPressDepsForTests,
  type NativeReadInjectionBuildInput,
  type NativeReadInjectionBuildResult,
  type WordPressMcpInstance,
} from "../deps";
import {
  createWordPressExternalMcpToolbox,
  wordpressToolboxServerLabel,
  WORDPRESS_DEFAULT_CATALOG_SERVER_ID,
} from "../mcp/toolbox";

const listMcpInstances = vi.fn<() => WordPressMcpInstance[]>(() => []);
const probeMcpAdapter = vi.fn();
const requireInstanceWriteAuthority = vi.fn(async (_input: {
  instanceId: string;
  primitiveName: string;
}) => {});
const buildNativeReadInjection = vi.fn<
  (input: NativeReadInjectionBuildInput) => Promise<NativeReadInjectionBuildResult | null>
>(async () => null);

const inst = (id: string, siteUrl?: string): WordPressMcpInstance => ({
  id,
  name: `Site ${id}`,
  siteUrl: siteUrl ?? `https://site-${id}.example.com`,
  username: `admin-${id}`,
  applicationPassword: `pass-${id}`,
});

const expectedBasicHeader = (instance: WordPressMcpInstance) =>
  `Basic ${Buffer.from(`${instance.username}:${instance.applicationPassword}`, "utf8").toString("base64")}`;

/** A host-verified grant for the default adapter server. */
const grantFor = (allowedTools: string[]): NativeReadInjectionBuildResult => ({
  serverId: WORDPRESS_DEFAULT_CATALOG_SERVER_ID,
  allowedTools,
});

const CHAT = { surface: "chat" } as const;

const buildDeps = () => ({
  decodeCursor: () => 0,
  buildListPage: <T,>(items: T[], total: number) => ({ items, total }),
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
  // cinatra#2019 S4 — the host's per-instance injection decision. Default
  // stub grants NOTHING (null = mode off / consent stale / empty verified
  // set); emission tests override with an explicit grant.
  buildNativeReadInjection,
});

beforeEach(() => {
  vi.clearAllMocks();
  probeMcpAdapter.mockResolvedValue("registered");
  buildNativeReadInjection.mockResolvedValue(null);
  registerWordPressConnector(buildDeps());
});

afterEach(() => {
  _resetWordPressDepsForTests();
});

// ---------------------------------------------------------------------------
// Surface gate (cinatra#2019 D5) — the flip's outermost fail-closed layer.
// An absent context reproduces the pre-S4 dark toolbox byte-for-byte: a host
// that predates the SDK context widening can never inject.
// ---------------------------------------------------------------------------

describe("buildTools — surface gate", () => {
  it("emits ZERO entries with NO context even in the maximal configuration (instances present, authorized, adapter registered, host grants)", async () => {
    listMcpInstances.mockReturnValue([inst("a"), inst("b")]);
    requireInstanceWriteAuthority.mockResolvedValue(undefined);
    probeMcpAdapter.mockResolvedValue("registered");
    buildNativeReadInjection.mockResolvedValue(grantFor(["ewpa-get-post"]));

    expect(await createWordPressExternalMcpToolbox().buildTools("openai")).toEqual([]);

    // The gate sits BEFORE any per-instance work: no enumeration, no
    // authority resolution, no probe, no host decision, no credential
    // ever touched.
    expect(listMcpInstances).not.toHaveBeenCalled();
    expect(requireInstanceWriteAuthority).not.toHaveBeenCalled();
    expect(probeMcpAdapter).not.toHaveBeenCalled();
    expect(buildNativeReadInjection).not.toHaveBeenCalled();
  });

  it.each(["agent_run", "public_site_widget", "session"] as const)(
    "emits ZERO entries for surface %s (M1 stays the only path)",
    async (surface) => {
      listMcpInstances.mockReturnValue([inst("a")]);
      buildNativeReadInjection.mockResolvedValue(grantFor(["ewpa-get-post"]));

      expect(
        await createWordPressExternalMcpToolbox().buildTools("openai", { surface }),
      ).toEqual([]);
      expect(listMcpInstances).not.toHaveBeenCalled();
      expect(buildNativeReadInjection).not.toHaveBeenCalled();
    },
  );

  it("emits ZERO entries for an unknown surface value (fail-closed, never fall through)", async () => {
    listMcpInstances.mockReturnValue([inst("a")]);
    buildNativeReadInjection.mockResolvedValue(grantFor(["ewpa-get-post"]));

    const bogus = { surface: "totally-new-surface" } as unknown as Parameters<
      ReturnType<typeof createWordPressExternalMcpToolbox>["buildTools"]
    >[1];
    expect(await createWordPressExternalMcpToolbox().buildTools("openai", bogus)).toEqual([]);
    expect(buildNativeReadInjection).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Default-off (cinatra#2019 acceptance row 1): with the host granting nothing
// (mode off/absent, consent stale, or an empty verified set — the member
// resolves null for all of them), the toolbox emits nothing in EVERY
// configuration and for every provider.
// ---------------------------------------------------------------------------

describe("buildTools — default-off (host grants nothing)", () => {
  it("emits ZERO entries in the maximal configuration when the member resolves null", async () => {
    listMcpInstances.mockReturnValue([inst("a"), inst("b")]);
    requireInstanceWriteAuthority.mockResolvedValue(undefined);
    probeMcpAdapter.mockResolvedValue("registered");
    buildNativeReadInjection.mockResolvedValue(null);

    expect(await createWordPressExternalMcpToolbox().buildTools("openai", CHAT)).toEqual([]);
    // The decision ran for each surviving instance — and denied.
    expect(buildNativeReadInjection).toHaveBeenCalledTimes(2);
  });

  it("emits ZERO entries for every provider argument", async () => {
    listMcpInstances.mockReturnValue([inst("a")]);
    for (const provider of ["openai", "anthropic", "google", ""]) {
      expect(await createWordPressExternalMcpToolbox().buildTools(provider, CHAT)).toEqual([]);
    }
  });

  it("emits ZERO entries — with NO authority/probe side effects — when the DEPS BINDING lacks the member (an old host's static transport binding)", async () => {
    // NOTE the production skew split: the connector's own register.ts always
    // binds a lazy wrapper, so a post-cutover host that merely predates the
    // HOST-side member takes the per-instance null path above instead (the
    // register suite pins that wrapper). This early return covers bindings
    // that predate the member entirely.
    listMcpInstances.mockReturnValue([inst("a")]);
    registerWordPressConnector({ ...buildDeps(), buildNativeReadInjection: undefined });

    expect(await createWordPressExternalMcpToolbox().buildTools("openai", CHAT)).toEqual([]);
    // No grant can exist, so no per-instance work runs at all: no authority
    // audit rows, no probes, on a binding that cannot grant anyway.
    expect(listMcpInstances).not.toHaveBeenCalled();
    expect(requireInstanceWriteAuthority).not.toHaveBeenCalled();
    expect(probeMcpAdapter).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Opt-in emission: the host grant is rendered verbatim — exact allowlist,
// pinned label, Basic auth, query-string endpoint, current approval
// vocabulary, declared transport.
// ---------------------------------------------------------------------------

describe("buildTools — opt-in emission", () => {
  it("emits one MCP server tool carrying EXACTLY the host-granted allowlist", async () => {
    const a = inst("a");
    listMcpInstances.mockReturnValue([a]);
    buildNativeReadInjection.mockResolvedValue(grantFor(["ewpa-get-post", "core-get-site-info"]));

    const result = await createWordPressExternalMcpToolbox().buildTools("openai", CHAT);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "mcp",
      serverLabel: "wordpress-a",
      serverUrl:
        "https://site-a.example.com/index.php?rest_route=/mcp/mcp-adapter-default-server",
      headers: { Authorization: expectedBasicHeader(a) },
      serverDescription:
        "WordPress site Site a (https://site-a.example.com) — MCP adapter",
      allowedTools: ["ewpa-get-post", "core-get-site-info"],
      approval: "auto_execute",
      transport: "streamable-http",
    });
  });

  it("never emits `allowedTools: null` — the full-catalog form is unrepresentable", async () => {
    listMcpInstances.mockReturnValue([inst("a")]);
    buildNativeReadInjection.mockResolvedValue(grantFor(["ewpa-get-post"]));

    const result = await createWordPressExternalMcpToolbox().buildTools("openai", CHAT);

    expect(result).toHaveLength(1);
    expect(Array.isArray(result[0].allowedTools)).toBe(true);
    expect(result[0].allowedTools).toEqual(["ewpa-get-post"]);
  });

  it("calls the member with EXACTLY the non-identity coordinates {instanceId, surface} — no provider, no actor", async () => {
    listMcpInstances.mockReturnValue([inst("a")]);
    buildNativeReadInjection.mockResolvedValue(grantFor(["ewpa-get-post"]));

    await createWordPressExternalMcpToolbox().buildTools("openai", CHAT);

    expect(buildNativeReadInjection).toHaveBeenCalledTimes(1);
    expect(buildNativeReadInjection).toHaveBeenCalledWith({ instanceId: "a", surface: "chat" });
  });

  it("skips ONLY the null-granted instance — siblings with grants still emit", async () => {
    listMcpInstances.mockReturnValue([inst("a"), inst("b")]);
    buildNativeReadInjection.mockImplementation(async ({ instanceId }) =>
      instanceId === "b" ? grantFor(["ewpa-get-post"]) : null,
    );

    const result = await createWordPressExternalMcpToolbox().buildTools("openai", CHAT);

    expect(result).toHaveLength(1);
    expect(result[0].serverLabel).toBe("wordpress-b");
  });

  it("skips the instance — and never throws — when the member REJECTS; siblings still emit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    listMcpInstances.mockReturnValue([inst("a"), inst("b")]);
    buildNativeReadInjection.mockImplementation(async ({ instanceId }) => {
      if (instanceId === "a") throw new Error("host decision failed");
      return grantFor(["ewpa-get-post"]);
    });

    const result = await createWordPressExternalMcpToolbox().buildTools("openai", CHAT);

    expect(result).toHaveLength(1);
    expect(result[0].serverLabel).toBe("wordpress-b");
    warn.mockRestore();
  });

  it("skips a grant whose allowlist is EMPTY (an empty-allowlist entry is unrepresentable end-to-end)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    listMcpInstances.mockReturnValue([inst("a")]);
    buildNativeReadInjection.mockResolvedValue(grantFor([]));

    expect(await createWordPressExternalMcpToolbox().buildTools("openai", CHAT)).toEqual([]);
    warn.mockRestore();
  });

  it("skips a grant whose allowlist is malformed (non-string / empty names)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    listMcpInstances.mockReturnValue([inst("a")]);
    buildNativeReadInjection.mockResolvedValue({
      serverId: WORDPRESS_DEFAULT_CATALOG_SERVER_ID,
      allowedTools: ["ok", ""] as string[],
    });

    expect(await createWordPressExternalMcpToolbox().buildTools("openai", CHAT)).toEqual([]);
    warn.mockRestore();
  });

  it("skips a grant whose allowlist is NOT an array (a bad host response of allowedTools: null can never re-open the full catalog)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    listMcpInstances.mockReturnValue([inst("a")]);
    buildNativeReadInjection.mockResolvedValue({
      serverId: WORDPRESS_DEFAULT_CATALOG_SERVER_ID,
      allowedTools: null as unknown as string[],
    });

    expect(await createWordPressExternalMcpToolbox().buildTools("openai", CHAT)).toEqual([]);
    warn.mockRestore();
  });

  it("skips a grant for a NON-DEFAULT server — v1 injects the default adapter server only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    listMcpInstances.mockReturnValue([inst("a")]);
    buildNativeReadInjection.mockResolvedValue({
      serverId: "wps-0123456789abcdef",
      allowedTools: ["fixturelabs-note-get"],
    });

    expect(await createWordPressExternalMcpToolbox().buildTools("openai", CHAT)).toEqual([]);
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Run-pin narrowing (cinatra#2019 D4): a host-built connectorInstancePin
// restricts consideration to exactly the pinned instance. Purely subtractive.
// (No live chat surface carries a pin today — the filter ships now so a
// future run-surface decision cannot widen by omission.)
// ---------------------------------------------------------------------------

describe("buildTools — connectorInstancePin narrowing", () => {
  it("considers ONLY the pinned instance", async () => {
    listMcpInstances.mockReturnValue([inst("a"), inst("b")]);
    buildNativeReadInjection.mockResolvedValue(grantFor(["ewpa-get-post"]));

    const result = await createWordPressExternalMcpToolbox().buildTools("openai", {
      surface: "chat",
      connectorInstancePin: { connectorKey: "wordpress", instanceId: "b" },
    });

    expect(result).toHaveLength(1);
    expect(result[0].serverLabel).toBe("wordpress-b");
    expect(buildNativeReadInjection).toHaveBeenCalledTimes(1);
    expect(buildNativeReadInjection).toHaveBeenCalledWith({ instanceId: "b", surface: "chat" });
    // The unpinned instance is dropped BEFORE any per-instance work.
    expect(requireInstanceWriteAuthority).toHaveBeenCalledTimes(1);
  });

  it("a pin for ANOTHER connector matches nothing — emits ZERO entries", async () => {
    listMcpInstances.mockReturnValue([inst("a")]);
    buildNativeReadInjection.mockResolvedValue(grantFor(["ewpa-get-post"]));

    const result = await createWordPressExternalMcpToolbox().buildTools("openai", {
      surface: "chat",
      connectorInstancePin: { connectorKey: "drupal", instanceId: "a" },
    });

    expect(result).toEqual([]);
    expect(buildNativeReadInjection).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Pre-flip boundary gates — preserved unchanged from the S0-era construction
// (none of the pinned semantics dropped).
// ---------------------------------------------------------------------------

describe("buildTools — boundary gates (preserved)", () => {
  it("returns [] when no instances configured", async () => {
    listMcpInstances.mockReturnValue([]);
    expect(await createWordPressExternalMcpToolbox().buildTools("openai", CHAT)).toEqual([]);
  });

  it("skips private URLs (localhost) — never returned to LLM, probe and decision never run", async () => {
    listMcpInstances.mockReturnValue([inst("a", "http://localhost:8081")]);
    buildNativeReadInjection.mockResolvedValue(grantFor(["ewpa-get-post"]));

    expect(await createWordPressExternalMcpToolbox().buildTools("openai", CHAT)).toEqual([]);
    expect(probeMcpAdapter).not.toHaveBeenCalled();
    expect(buildNativeReadInjection).not.toHaveBeenCalled();
  });

  it("skips instances whose mcp-adapter probe is not 'registered'", async () => {
    listMcpInstances.mockReturnValue([inst("a"), inst("b")]);
    probeMcpAdapter.mockResolvedValueOnce("not_installed").mockResolvedValueOnce("registered");
    buildNativeReadInjection.mockResolvedValue(grantFor(["ewpa-get-post"]));

    const result = await createWordPressExternalMcpToolbox().buildTools("openai", CHAT);

    expect(result).toHaveLength(1);
    expect(result[0].serverLabel).toBe("wordpress-b");
    // The host decision runs only for instances that survived the probe.
    expect(buildNativeReadInjection).toHaveBeenCalledTimes(1);
    expect(buildNativeReadInjection).toHaveBeenCalledWith({ instanceId: "b", surface: "chat" });
  });

  it("returns [] and never throws when deps are unavailable", async () => {
    _resetWordPressDepsForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await createWordPressExternalMcpToolbox().buildTools("openai", CHAT);

    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Approval vocabulary (cinatra#2015 deliverable 1 — preserved)
// ---------------------------------------------------------------------------

describe("approval vocabulary", () => {
  it("emits the CURRENT vocabulary: approval 'auto_execute', and never the retired requireApproval key", async () => {
    // auto_execute is correct for this path: only the host's descriptor-
    // verified trusted-READ set is injected; writes go through the governed
    // invoker (M1) with its own audit and destructive confirmation, never
    // through provider-direct injection.
    listMcpInstances.mockReturnValue([inst("a")]);
    buildNativeReadInjection.mockResolvedValue(grantFor(["ewpa-get-post"]));

    const result = await createWordPressExternalMcpToolbox().buildTools("openai", CHAT);

    expect(result).toHaveLength(1);
    expect(result[0].approval).toBe("auto_execute");
    expect("requireApproval" in result[0]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Immutable naming (cinatra#2015 deliverable 5; suffix rule cinatra#2019 D8)
// ---------------------------------------------------------------------------

describe("immutable toolbox naming", () => {
  it("pins the DEFAULT-server label format wordpress-${instance.id} byte-exact", () => {
    expect(wordpressToolboxServerLabel("abc-123")).toBe("wordpress-abc-123");
    expect(wordpressToolboxServerLabel("abc-123", WORDPRESS_DEFAULT_CATALOG_SERVER_ID)).toBe(
      "wordpress-abc-123",
    );
    expect(WORDPRESS_DEFAULT_CATALOG_SERVER_ID).toBe("mcp-adapter-default");
  });

  it("pins the per-server suffix rule: the enrolled serverId minus its 'wps-' prefix, ordinal-free and deterministic", () => {
    expect(wordpressToolboxServerLabel("i", "wps-0123456789abcdef")).toBe(
      "wordpress-i--s-0123456789abcdef",
    );
    // Deterministic: derived purely from (instanceId, serverId) — repeat
    // calls (any enumeration order) yield the identical label.
    expect(wordpressToolboxServerLabel("i", "wps-0123456789abcdef")).toBe(
      wordpressToolboxServerLabel("i", "wps-0123456789abcdef"),
    );
    // A foreign id without the enrolled prefix stays whole (still stable,
    // still collision-free) — such a server is never emitted by v1 anyway.
    expect(wordpressToolboxServerLabel("i", "other-id")).toBe("wordpress-i--s-other-id");
  });

  it("the emitted tool uses exactly the pinned label helper", async () => {
    listMcpInstances.mockReturnValue([inst("pin-me")]);
    buildNativeReadInjection.mockResolvedValue(grantFor(["ewpa-get-post"]));

    const result = await createWordPressExternalMcpToolbox().buildTools("openai", CHAT);

    expect(result).toHaveLength(1);
    expect(result[0].serverLabel).toBe(wordpressToolboxServerLabel("pin-me"));
  });
});

// ---------------------------------------------------------------------------
// Authorization regression coverage — preserved unchanged.
// (CWE-862/863): the external-MCP toolbox enumerated EVERY org-wide instance
// and emitted a credentialed MCP server (WP Application Password) for each,
// with no per-actor/per-tenant authorization — a connector confused deputy
// letting any chat path use another tenant's WordPress credentials. The fix
// gates each instance through the host-resolved per-instance `use` authority
// (`requireInstanceWriteAuthority`) and fails closed on any deny/missing actor.
// ---------------------------------------------------------------------------

describe("authorization", () => {
  it("NEGATIVE — fails closed when the actor cannot use the instance (no actor frame / deny)", async () => {
    // Host-side authority throws (no resolvable actor, or actor lacks `use`).
    listMcpInstances.mockReturnValue([inst("a"), inst("b")]);
    requireInstanceWriteAuthority.mockRejectedValue(new Error("not authorized"));
    buildNativeReadInjection.mockResolvedValue(grantFor(["ewpa-get-post"]));

    const result = await createWordPressExternalMcpToolbox().buildTools("openai", CHAT);

    // No credentialed MCP server is emitted for ANY instance — the cross-actor
    // / no-actor unauthorized path injects nothing.
    expect(result).toEqual([]);
    // And neither the WP adapter probe nor the host decision is ever reached
    // for denied instances — authorization gates BEFORE any per-instance work.
    expect(probeMcpAdapter).not.toHaveBeenCalled();
    expect(buildNativeReadInjection).not.toHaveBeenCalled();
  });

  it("NEGATIVE — denies cross-tenant instances, emits only the authorized actor's own", async () => {
    // org A's actor: authority allows instance "a-owned", denies "b-other-org".
    const owned = inst("a-owned");
    const otherOrg = inst("b-other-org");
    listMcpInstances.mockReturnValue([owned, otherOrg]);
    requireInstanceWriteAuthority.mockImplementation(async ({ instanceId }) => {
      if (instanceId === "b-other-org") throw new Error("cross-tenant: no use grant for this org");
    });
    buildNativeReadInjection.mockResolvedValue(grantFor(["ewpa-get-post"]));

    const result = await createWordPressExternalMcpToolbox().buildTools("openai", CHAT);

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
    buildNativeReadInjection.mockResolvedValue(grantFor(["ewpa-get-post"]));

    const result = await createWordPressExternalMcpToolbox().buildTools("openai", CHAT);

    expect(result).toHaveLength(1);
    expect(result[0].serverLabel).toBe("wordpress-a");
    expect(result[0].headers).toEqual({ Authorization: expectedBasicHeader(a) });
    expect(requireInstanceWriteAuthority).toHaveBeenCalledWith({
      instanceId: "a",
      primitiveName: "wordpress_external_mcp_toolbox_inject",
    });
  });
});
