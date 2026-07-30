/**
 * WordPress instance server actions (setup-actions.ts). Direct unit coverage
 * for `installCatalogPluginRemoteAction` (cinatra#2021 S6/delta) — the
 * highest-consequence action in this file (it lets Cinatra trigger a WRITE on
 * the connected site). `requireExtensionAction` is mocked at the module
 * boundary (the SAME "manage" org-admin gate every other action here uses);
 * the deps slot is exercised through the REAL `registerWordPressConnector` /
 * `_resetWordPressDepsForTests` pair (not a module mock) so this test proves
 * the actual wiring between the action and the deps member, not a stub of it.
 *
 * These tests attack the escalation / confused-deputy legs named in the
 * design: can a caller ever smuggle a different plugin slug through the form,
 * can the gate be bypassed, and does an unbound (skewed) deps member degrade
 * to a typed error rather than a crash.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireExtensionAction } = vi.hoisted(() => ({
  requireExtensionAction: vi.fn(async () => {}),
}));

vi.mock("@cinatra-ai/sdk-extensions", () => ({
  requireExtensionAction,
}));

import {
  installCatalogPluginRemoteAction,
  setWordPressInstanceToolPolicyAction,
} from "../setup-actions";
import {
  registerWordPressConnector,
  _resetWordPressDepsForTests,
  type InstallCatalogPluginOutcome,
  type InstanceToolPolicyView,
} from "../deps";

const WORDPRESS_PACKAGE_ID = "@cinatra-ai/wordpress-mcp-connector";

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    fd.set(key, value);
  }
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireExtensionAction.mockResolvedValue(undefined);
});

afterEach(() => {
  _resetWordPressDepsForTests();
});

describe("installCatalogPluginRemoteAction — manage-gated, hardcoded-target, no escalation path", () => {
  it("gates with the SAME manage scope as every other admin op on this surface, BEFORE touching the deps slot", async () => {
    const installCatalogPluginRemote = vi.fn(
      async (): Promise<InstallCatalogPluginOutcome> => ({
        outcome: "installed",
        status: 201,
        plugin: "enable-abilities-for-mcp/enable-abilities-for-mcp.php",
      }),
    );
    registerWordPressConnector({ installCatalogPluginRemote } as never);

    await installCatalogPluginRemoteAction(formData({ instanceId: "inst-1" }));

    expect(requireExtensionAction).toHaveBeenCalledWith(WORDPRESS_PACKAGE_ID, "manage");
    expect(installCatalogPluginRemote).toHaveBeenCalledWith("inst-1");
  });

  it("a manage-gate DENY throws BEFORE the deps member is ever called", async () => {
    requireExtensionAction.mockRejectedValueOnce(new Error("not an org admin"));
    const installCatalogPluginRemote = vi.fn();
    registerWordPressConnector({ installCatalogPluginRemote } as never);

    await expect(
      installCatalogPluginRemoteAction(formData({ instanceId: "inst-1" })),
    ).rejects.toThrowError("not an org admin");
    expect(installCatalogPluginRemote).not.toHaveBeenCalled();
  });

  it("a missing instanceId resolves a typed error outcome — never a throw a crafted form could crash the UI with — without ever resolving the deps slot", async () => {
    _resetWordPressDepsForTests();
    const result = await installCatalogPluginRemoteAction(formData({}));
    expect(result).toEqual({
      outcome: "error",
      status: 0,
      wpMessage: "Missing WordPress instance id.",
    });
  });

  it("forwards ONLY the instance id — an extra 'slug' field on the form has NO effect (confused-deputy guard)", async () => {
    const installCatalogPluginRemote = vi.fn(
      async (): Promise<InstallCatalogPluginOutcome> => ({
        outcome: "installed",
        status: 201,
        plugin: "enable-abilities-for-mcp/enable-abilities-for-mcp.php",
      }),
    );
    registerWordPressConnector({ installCatalogPluginRemote } as never);

    // A crafted form trying to smuggle a different plugin target — the action
    // has no code path that reads any field but instanceId.
    await installCatalogPluginRemoteAction(
      formData({ instanceId: "inst-1", slug: "some-other-plugin", plugin: "evil/evil.php" }),
    );

    expect(installCatalogPluginRemote).toHaveBeenCalledTimes(1);
    expect(installCatalogPluginRemote).toHaveBeenCalledWith("inst-1");
  });

  it("an unbound deps member (older connector build) resolves a typed 'error' outcome, never throws", async () => {
    registerWordPressConnector({} as never);

    const result = await installCatalogPluginRemoteAction(formData({ instanceId: "inst-1" }));

    expect(result).toEqual({
      outcome: "error",
      status: 0,
      wpMessage: "This Cinatra version does not support remote-assist plugin installs.",
    });
  });

  it("surfaces a `forbidden` outcome from the deps member VERBATIM (never retried, never re-interpreted)", async () => {
    const installCatalogPluginRemote = vi.fn(
      async (): Promise<InstallCatalogPluginOutcome> => ({ outcome: "forbidden", status: 403 }),
    );
    registerWordPressConnector({ installCatalogPluginRemote } as never);

    const result = await installCatalogPluginRemoteAction(formData({ instanceId: "inst-1" }));

    expect(result).toEqual({ outcome: "forbidden", status: 403 });
    expect(installCatalogPluginRemote).toHaveBeenCalledTimes(1);
  });
});

// cinatra-ai/cinatra#2022 S7 — the tool-selection save action: the same
// manage gate + typed-outcome contract as the remote-assist action above,
// plus shape-strict payload validation (the host seam re-validates — this is
// defense in depth, not the enforcement point) and the FULL-record replace
// semantics the card relies on (never a delta).
describe("setWordPressInstanceToolPolicyAction — manage-gated, shape-strict, full-record replace", () => {
  const PERSISTED: InstanceToolPolicyView = {
    instanceId: "inst-1",
    mode: "restricted",
    allow: [{ serverId: "mcp-adapter-default", name: "ewpa/update-post" }],
    deny: [],
  };

  function policyField(policy: unknown): string {
    return JSON.stringify(policy);
  }

  it("gates with manage BEFORE touching the deps slot, then forwards the FULL validated record", async () => {
    const setInstanceToolPolicy = vi.fn(async (): Promise<InstanceToolPolicyView> => PERSISTED);
    registerWordPressConnector({ setInstanceToolPolicy } as never);

    const result = await setWordPressInstanceToolPolicyAction(
      formData({
        instanceId: "inst-1",
        policy: policyField({
          mode: "restricted",
          allow: [{ serverId: "mcp-adapter-default", name: " ewpa/update-post " }],
          deny: [],
        }),
      }),
    );

    expect(requireExtensionAction).toHaveBeenCalledWith(WORDPRESS_PACKAGE_ID, "manage");
    // Entries are trimmed; an empty deny list is omitted, not sent as [].
    expect(setInstanceToolPolicy).toHaveBeenCalledWith({
      instanceId: "inst-1",
      mode: "restricted",
      allow: [{ serverId: "mcp-adapter-default", name: "ewpa/update-post" }],
    });
    expect(result).toEqual({ ok: true, policy: PERSISTED });
  });

  it("a manage-gate DENY throws BEFORE the deps member is ever called", async () => {
    requireExtensionAction.mockRejectedValueOnce(new Error("not an org admin"));
    const setInstanceToolPolicy = vi.fn();
    registerWordPressConnector({ setInstanceToolPolicy } as never);

    await expect(
      setWordPressInstanceToolPolicyAction(
        formData({ instanceId: "inst-1", policy: policyField({ mode: "open" }) }),
      ),
    ).rejects.toThrowError("not an org admin");
    expect(setInstanceToolPolicy).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing instanceId", { policy: policyField({ mode: "open" }) }],
    ["an unparseable policy payload", { instanceId: "inst-1", policy: "{not json" }],
    ["an unknown mode", { instanceId: "inst-1", policy: policyField({ mode: "everything" }) }],
    [
      "a malformed allow entry",
      {
        instanceId: "inst-1",
        policy: policyField({ mode: "restricted", allow: ["ewpa/update-post"] }),
      },
    ],
    [
      "a blank serverId",
      {
        instanceId: "inst-1",
        policy: policyField({
          mode: "restricted",
          allow: [{ serverId: "  ", name: "ewpa/update-post" }],
        }),
      },
    ],
  ] as const)(
    "%s resolves a typed refusal — nothing forwarded, nothing thrown",
    async (_label, fields) => {
      const setInstanceToolPolicy = vi.fn();
      registerWordPressConnector({ setInstanceToolPolicy } as never);

      const result = await setWordPressInstanceToolPolicyAction(
        formData(fields as Record<string, string>),
      );

      expect(result).toMatchObject({ ok: false });
      expect(setInstanceToolPolicy).not.toHaveBeenCalled();
    },
  );

  it("an unbound deps member (host predates the seam) resolves a typed refusal, never throws", async () => {
    registerWordPressConnector({} as never);

    const result = await setWordPressInstanceToolPolicyAction(
      formData({ instanceId: "inst-1", policy: policyField({ mode: "open" }) }),
    );

    expect(result).toEqual({
      ok: false,
      message: "This Cinatra version does not support per-site tool selection.",
    });
  });

  it("a host-side refusal maps to ONE opaque message — no internals, no existence oracle leak", async () => {
    const setInstanceToolPolicy = vi.fn(async () => {
      throw new Error("instance row not found in org table xyz");
    });
    registerWordPressConnector({ setInstanceToolPolicy } as never);

    const result = await setWordPressInstanceToolPolicyAction(
      formData({ instanceId: "inst-1", policy: policyField({ mode: "open" }) }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).not.toContain("org table");
  });
});
