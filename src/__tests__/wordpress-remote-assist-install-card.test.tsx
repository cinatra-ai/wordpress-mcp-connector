// @vitest-environment jsdom
/**
 * Remote-assist catalog-plugin install card (cinatra-ai/cinatra#2021 S6/delta).
 *
 * WordPress's own `install_plugins` REST capability check is the SOLE
 * authority on whether this action succeeds — this card only ever routes an
 * explicit click to that check and renders its outcome verbatim. These tests
 * assert (1) skew-safety when the deps member is unbound, (2) the form can
 * NEVER carry any field but the instance id (the structural guarantee that
 * this action can't be redirected at a different plugin), and (3) all three
 * outcome states render distinctly (installed / forbidden / error) — never
 * nothing, and never a generic crash.
 *
 * Renders the REAL client component (raw `react-dom/client` + `act`, no
 * testing-library) — only the `manage`-gated server action is stubbed.
 * Mirrors the render pattern in wordpress-trusted-site-card.test.tsx.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { installCatalogPluginRemoteAction } = vi.hoisted(() => ({
  installCatalogPluginRemoteAction: vi.fn(),
}));

vi.mock("../setup-actions", () => ({
  installCatalogPluginRemoteAction,
}));

import {
  WordPressRemoteAssistInstallCard,
  type WordPressRemoteAssistInstallCardProps,
} from "../wordpress-remote-assist-install-card";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

const baseProps: WordPressRemoteAssistInstallCardProps = {
  instanceId: "inst-1",
  available: true,
};

async function renderCard(
  overrides: Partial<WordPressRemoteAssistInstallCardProps> = {},
): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(<WordPressRemoteAssistInstallCard {...baseProps} {...overrides} />);
  });
  return container;
}

function buttonByText(container: HTMLElement, re: RegExp): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((b) => re.test(b.textContent ?? "")) as
    | HTMLButtonElement
    | undefined;
}

async function clickAndFlush(el: HTMLElement) {
  await act(async () => {
    el.click();
    // Flush the useActionState transition (the mocked action resolves
    // immediately, but the state commit lands a microtask later).
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
});

describe("WordPressRemoteAssistInstallCard — skew-safety + form shape", () => {
  it("states the feature is unavailable and renders NO form/button on an older connector build", async () => {
    const container = await renderCard({ available: false });

    expect(container.textContent).toContain("Not available on this Cinatra version.");
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });

  it("the form carries ONLY the instance id — no slug/URL field exists anywhere on this card", async () => {
    const container = await renderCard();

    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    const inputs = Array.from(form!.querySelectorAll("input"));
    expect(inputs).toHaveLength(1);
    expect(inputs[0].name).toBe("instanceId");
    expect(inputs[0].value).toBe("inst-1");
    expect(inputs[0].type).toBe("hidden");
  });

  it("renders the install button, never triggered automatically (no action call before a click)", async () => {
    await renderCard();
    expect(installCatalogPluginRemoteAction).not.toHaveBeenCalled();
  });
});

describe("WordPressRemoteAssistInstallCard — outcome rendering (never nothing)", () => {
  it("installed: shows the Installed badge + the reported plugin id and status", async () => {
    installCatalogPluginRemoteAction.mockResolvedValueOnce({
      outcome: "installed",
      status: 201,
      plugin: "enable-abilities-for-mcp/enable-abilities-for-mcp.php",
    });
    const container = await renderCard();

    const button = buttonByText(container, /install enable abilities for mcp/i)!;
    expect(button).toBeTruthy();
    await clickAndFlush(button);

    expect(installCatalogPluginRemoteAction).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="remote-assist-success"]')).not.toBeNull();
    expect(container.textContent).toContain("enable-abilities-for-mcp/enable-abilities-for-mcp.php");
    expect(container.textContent).toContain("Installed");
    expect(container.querySelector('[data-testid="remote-assist-forbidden"]')).toBeNull();
    expect(container.querySelector('[data-testid="remote-assist-error"]')).toBeNull();
  });

  it("forbidden: surfaces the honest 'can't install plugins' message, not a generic error", async () => {
    installCatalogPluginRemoteAction.mockResolvedValueOnce({ outcome: "forbidden", status: 403 });
    const container = await renderCard();

    await clickAndFlush(buttonByText(container, /install/i)!);

    const forbidden = container.querySelector('[data-testid="remote-assist-forbidden"]');
    expect(forbidden).not.toBeNull();
    expect(forbidden!.textContent).toContain("can't install plugins");
    expect(forbidden!.getAttribute("role")).toBe("alert");
    expect(container.querySelector('[data-testid="remote-assist-success"]')).toBeNull();
    // The remediation offered is the manual wp-admin path ONLY — the copy must
    // never invite reconnecting a more-privileged user (no credential
    // prompting, no retry-as-someone-else).
    expect(forbidden!.textContent).not.toMatch(/connect a (different |new )?user/i);
    expect(forbidden!.textContent).toContain("wp-admin");
  });

  it("error: renders the WordPress message VERBATIM (never invented copy)", async () => {
    installCatalogPluginRemoteAction.mockResolvedValueOnce({
      outcome: "error",
      status: 404,
      wpCode: "rest_plugin_not_found",
      wpMessage: "Plugin not found in the WordPress.org plugin directory.",
    });
    const container = await renderCard();

    await clickAndFlush(buttonByText(container, /install/i)!);

    const error = container.querySelector('[data-testid="remote-assist-error"]');
    expect(error).not.toBeNull();
    expect(error!.textContent).toBe("Plugin not found in the WordPress.org plugin directory.");
  });
});
