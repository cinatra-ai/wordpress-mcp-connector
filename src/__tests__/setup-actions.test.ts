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

import { installCatalogPluginRemoteAction } from "../setup-actions";
import {
  registerWordPressConnector,
  _resetWordPressDepsForTests,
  type InstallCatalogPluginOutcome,
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
