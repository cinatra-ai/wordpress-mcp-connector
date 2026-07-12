// @vitest-environment jsdom
/**
 * connector-setup-tabs (wordpress-mcp-connector#70): the settings page wraps
 * its content in the shared `@cinatra-ai/sdk-ui/tabs` primitive — Setup ·
 * Connections · Help, with Help always last (design/specs/app-connectors.html
 * §II "Multiple connections" — this connector holds many WordPress site
 * connections, one per Nango-connected instance).
 *
 * Renders the REAL async server component (`WordPressSettingsPage`) through
 * the REAL `@cinatra-ai/sdk-ui` Tabs primitive (not mocked) — only the
 * connector's own host-bound deps/actions and the Nango connect-card (already
 * covered by its own test file) are stubbed. Mirrors the
 * `wordpress-nango-connect-card.test.tsx` render pattern: raw
 * `react-dom/client` + `act`, no testing-library dependency added.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";

const { listInstancesSorted } = vi.hoisted(() => ({
  listInstancesSorted: vi.fn(),
}));

vi.mock("../deps", () => ({
  listInstancesSorted,
}));

vi.mock("../setup-actions", () => ({
  deleteWordPressInstanceAction: vi.fn(),
}));

// The connect-card's own behaviour (Nango session, toast-on-error, …) is
// covered by wordpress-nango-connect-card.test.tsx; here it is a stand-in so
// this test stays scoped to the tab structure/content-mapping/a11y contract.
vi.mock("../wordpress-nango-connect-card", () => ({
  WordPressNangoConnectCard: () => (
    <div data-testid="connect-card-stub">Connect site</div>
  ),
}));

import { WordPressSettingsPage } from "../settings-page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mountedRoots: Root[] = [];

// Radix Tabs activates on `mousedown` (+ `onFocus` in the default "automatic"
// activation mode), not a bare synthetic `click` — mirrors the native pointer
// pipeline a real browser click produces.
function clickTab(el: HTMLElement) {
  el.dispatchEvent(
    new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
  );
  el.click();
}

const fakeCtx = {
  nango: {
    getFrontendConfig: async () => ({ apiURL: "https://api.nango.dev" }),
    getStatus: async () => ({ status: "connected" as const }),
  },
} as unknown as ExtensionHostContext;

function oneInstance() {
  return [
    {
      id: "inst-1",
      name: "Marketing blog",
      siteUrl: "https://blog.example.com",
      username: "cinatra-bot",
      applicationPassword: "secret",
    },
  ];
}

async function renderSettingsPage(container: HTMLDivElement) {
  const element = await WordPressSettingsPage({ ctx: fakeCtx });
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(element);
  });
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  listInstancesSorted.mockReturnValue(oneInstance());
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
});

describe("WordPressSettingsPage — connector-setup-tabs (#70)", () => {
  it("renders exactly Setup, Connections, Help — in that order, Help last", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    await renderSettingsPage(container);

    const tabs = Array.from(container.querySelectorAll('[role="tab"]'));
    expect(tabs.map((t) => t.textContent)).toEqual([
      "Setup",
      "Connections",
      "Help",
    ]);
  });

  it("uses the shared design-system tablist (role=tablist with an aria-label) — no hand-rolled tab chrome", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    await renderSettingsPage(container);

    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist).not.toBeNull();
    expect(tablist!.getAttribute("aria-label")).toBe(
      "WordPress MCP connector setup",
    );
  });

  it("maps each tab to its own content: Setup → connect form, Connections → the instance list, Help → read-only how-to", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    await renderSettingsPage(container);

    const tabs = Array.from(container.querySelectorAll('[role="tab"]'));
    const panels = Array.from(container.querySelectorAll('[role="tabpanel"]'));
    expect(panels).toHaveLength(3);

    // Radix wires each trigger's `aria-controls` to its panel's `id` — assert
    // the content-mapping contract structurally, not by DOM order.
    for (const tab of tabs) {
      const controlsId = tab.getAttribute("aria-controls");
      const panel = panels.find((p) => p.id === controlsId);
      expect(panel, `no panel found for tab "${tab.textContent}"`).toBeTruthy();
    }

    const setupTab = tabs.find((t) => t.textContent === "Setup")!;
    const connectionsTab = tabs.find((t) => t.textContent === "Connections")!;
    const helpTab = tabs.find((t) => t.textContent === "Help")!;

    const setupPanel = panels.find(
      (p) => p.id === setupTab.getAttribute("aria-controls"),
    )!;
    const connectionsPanel = panels.find(
      (p) => p.id === connectionsTab.getAttribute("aria-controls"),
    )!;
    const helpPanel = panels.find(
      (p) => p.id === helpTab.getAttribute("aria-controls"),
    )!;

    expect(setupPanel.textContent).toContain("Connect site");
    expect(setupPanel.textContent).toContain("Connections status");
    expect(setupPanel.textContent).not.toContain("Setup instructions");

    expect(connectionsPanel.textContent).toContain("Marketing blog");
    expect(connectionsPanel.textContent).toContain("blog.example.com");
    expect(connectionsPanel.textContent).not.toContain("Setup instructions");

    expect(helpPanel.textContent).toContain("Setup instructions");
    // Help is read-only — no form/Save action in its content.
    expect(helpPanel.querySelector("form")).toBeNull();
    expect(helpPanel.querySelector("button")).toBeNull();
  });

  it("a11y: Setup is selected by default; clicking a tab flips the selected + visible state (no page reload)", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    await renderSettingsPage(container);

    const tabs = () => Array.from(container.querySelectorAll('[role="tab"]'));
    const setupTab = () => tabs().find((t) => t.textContent === "Setup")!;
    const connectionsTab = () =>
      tabs().find((t) => t.textContent === "Connections")!;

    expect(setupTab().getAttribute("aria-selected")).toBe("true");
    expect(connectionsTab().getAttribute("aria-selected")).toBe("false");

    await act(async () => {
      clickTab(connectionsTab() as HTMLElement);
    });

    expect(connectionsTab().getAttribute("aria-selected")).toBe("true");
    expect(setupTab().getAttribute("aria-selected")).toBe("false");

    const connectionsPanel = container.querySelector(
      `#${connectionsTab().getAttribute("aria-controls")}`,
    )!;
    expect(connectionsPanel.getAttribute("data-state")).toBe("active");
  });

  it("a11y: keyboard roving-tabindex — ArrowRight from Setup moves focus + selection to Connections", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    await renderSettingsPage(container);

    const tabs = () => Array.from(container.querySelectorAll('[role="tab"]'));
    const setupTab = () => tabs().find((t) => t.textContent === "Setup")! as HTMLElement;
    const connectionsTab = () =>
      tabs().find((t) => t.textContent === "Connections")! as HTMLElement;

    setupTab().focus();
    expect(document.activeElement).toBe(setupTab());

    await act(async () => {
      setupTab().dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }),
      );
      // Radix's roving-focus + automatic-activation-on-focus updates land in a
      // microtask after the keydown dispatch resolves.
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(connectionsTab());
    expect(connectionsTab().getAttribute("aria-selected")).toBe("true");
  });

  it("empty state: renders 'No connections yet' / 'Add one from the Setup tab' with no instance cards", async () => {
    listInstancesSorted.mockReturnValue([]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    await renderSettingsPage(container);

    expect(container.textContent).toContain("No connections yet.");
    expect(container.textContent).toContain(
      "No WordPress instances configured yet. Add one from the Setup tab.",
    );
  });
});
