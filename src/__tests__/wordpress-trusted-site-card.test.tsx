// @vitest-environment jsdom
/**
 * Trusted-site mode opt-in card (cinatra-ai/cinatra#2019).
 *
 * The per-site card renders the current opt-in state + a live dry-run preview,
 * and gates enabling / re-acknowledging behind an explicit confirmation that
 * shows the versioned residual-risk disclosure first. Renders the REAL client
 * component (raw `react-dom/client` + `act`, no testing-library) — only the
 * `manage`-gated server action is stubbed. Mirrors the render pattern in
 * settings-page-tabs.test.tsx / wordpress-nango-connect-card.test.tsx.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../setup-actions", () => ({
  setWordPressTrustedSiteModeAction: vi.fn(),
}));

import {
  TRUSTED_SITE_DISCLOSURE_V1,
  WordPressTrustedSiteCard,
  type WordPressTrustedSiteCardProps,
} from "../wordpress-trusted-site-card";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

const baseProps: WordPressTrustedSiteCardProps = {
  instanceId: "inst-1",
  instanceName: "Marketing blog",
  policy: { mode: "off" },
  explain: { mode: "off", consentStale: false, verifiedNames: [], ejected: [] },
};

async function renderCard(
  overrides: Partial<WordPressTrustedSiteCardProps> = {},
): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(<WordPressTrustedSiteCard {...baseProps} {...overrides} />);
  });
  return container;
}

function buttonByText(container: HTMLElement, re: RegExp): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((b) => re.test(b.textContent ?? "")) as
    | HTMLButtonElement
    | undefined;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
}

/** name→value of the hidden inputs inside the form that owns the given button.
 * Reads the DOM `.value` property (React sets the property, not the `value`
 * attribute, for a controlled input). */
function formHiddenInputs(button: HTMLButtonElement): Record<string, string> {
  const form = button.closest("form");
  const out: Record<string, string> = {};
  for (const input of Array.from(form?.querySelectorAll("input") ?? [])) {
    out[input.name] = input.value;
  }
  return out;
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

describe("WordPressTrustedSiteCard — default-off + disclosure ceremony", () => {
  it("defaults to Off, shows no disclosure until the admin clicks enable", async () => {
    const container = await renderCard();

    expect(container.querySelector('[data-testid="trusted-site-card"]')).not.toBeNull();
    expect(container.textContent).toContain("Off");
    // The disclosure is NOT rendered up front — it appears only after the
    // explicit enable click.
    expect(container.querySelector('[data-testid="trusted-site-disclosure"]')).toBeNull();
    expect(container.textContent).not.toContain(TRUSTED_SITE_DISCLOSURE_V1.text);
  });

  it("renders the versioned residual-risk disclosure (incl. the credential sentence) before enabling", async () => {
    const container = await renderCard();

    const enable = buttonByText(container, /enable trusted-site mode/i);
    expect(enable).toBeTruthy();
    await click(enable!);

    const disclosure = container.querySelector('[data-testid="trusted-site-disclosure"]');
    expect(disclosure).not.toBeNull();
    // The disclosure version is rendered (so a future version bump is visible to
    // the admin acknowledging it).
    expect(disclosure!.textContent).toContain(`disclosure ${TRUSTED_SITE_DISCLOSURE_V1.version}`);
    // The full versioned copy — including the credential-sharing sentence — is shown.
    expect(disclosure!.textContent).toContain(TRUSTED_SITE_DISCLOSURE_V1.text);
    expect(disclosure!.textContent).toMatch(/Application Password.*shared with the provider/s);

    // Confirming submits the opt-in as trusted_site for THIS instance — the card
    // sends only the mode (the host stamps the acknowledged version/hash).
    const confirm = buttonByText(container, /confirm and enable/i);
    expect(confirm).toBeTruthy();
    expect(formHiddenInputs(confirm!)).toEqual({ instanceId: "inst-1", mode: "trusted_site" });
  });

  it("hides the disclosure again when the ceremony is cancelled", async () => {
    const container = await renderCard();
    await click(buttonByText(container, /enable trusted-site mode/i)!);
    expect(container.querySelector('[data-testid="trusted-site-disclosure"]')).not.toBeNull();

    await click(buttonByText(container, /cancel/i)!);
    expect(container.querySelector('[data-testid="trusted-site-disclosure"]')).toBeNull();
  });
});

describe("WordPressTrustedSiteCard — live preview (never hardcoded)", () => {
  it("shows the empty-qualify line when the dry-run verifies zero tools", async () => {
    const container = await renderCard({
      explain: { mode: "off", consentStale: false, verifiedNames: [], ejected: [] },
    });
    const preview = container.querySelector('[data-testid="trusted-site-preview"]');
    expect(preview!.textContent).toBe("No tools qualify for direct injection yet.");
  });

  it("shows a live count when the dry-run verifies tools (derived, not hardcoded)", async () => {
    const container = await renderCard({
      policy: { mode: "trusted_site" },
      explain: {
        mode: "trusted_site",
        consentStale: false,
        verifiedNames: ["site-get-post", "site-get-page"],
        ejected: [],
      },
    });
    const preview = container.querySelector('[data-testid="trusted-site-preview"]');
    expect(preview!.textContent).toBe("2 tools qualify for direct injection.");
  });

  it("singularizes the live count for exactly one verified tool", async () => {
    const container = await renderCard({
      policy: { mode: "trusted_site" },
      explain: {
        mode: "trusted_site",
        consentStale: false,
        verifiedNames: ["site-get-post"],
        ejected: [],
      },
    });
    expect(
      container.querySelector('[data-testid="trusted-site-preview"]')!.textContent,
    ).toBe("1 tool qualifies for direct injection.");
  });

  it("states the preview is unavailable when the host exposes no dry-run (older host)", async () => {
    const container = await renderCard({ policy: { mode: "off" }, explain: null });
    expect(
      container.querySelector('[data-testid="trusted-site-preview"]')!.textContent,
    ).toContain("Preview unavailable");
  });
});

describe("WordPressTrustedSiteCard — enabled + consent-stale re-acknowledge flow", () => {
  it("when on and fresh, offers Disable (mode=off) and no re-acknowledge prompt", async () => {
    const container = await renderCard({
      policy: { mode: "trusted_site", consentStale: false },
      explain: { mode: "trusted_site", consentStale: false, verifiedNames: [], ejected: [] },
    });

    expect(container.textContent).toContain("On");
    expect(container.textContent).not.toContain("Re-acknowledge required");
    const disable = buttonByText(container, /^disable$/i);
    expect(disable).toBeTruthy();
    expect(formHiddenInputs(disable!)).toEqual({ instanceId: "inst-1", mode: "off" });
    expect(buttonByText(container, /re-acknowledge/i)).toBeUndefined();
  });

  it("surfaces a stale consent as a re-acknowledge flow that re-stamps via a fresh disclosure", async () => {
    const container = await renderCard({
      policy: { mode: "trusted_site", consentStale: true },
      explain: { mode: "trusted_site", consentStale: true, verifiedNames: [], ejected: [] },
    });

    // The stale state is called out, and the ceremony is required again.
    expect(container.textContent).toContain("Re-acknowledge required");
    const review = buttonByText(container, /review and re-acknowledge/i);
    expect(review).toBeTruthy();
    expect(container.querySelector('[data-testid="trusted-site-disclosure"]')).toBeNull();

    await click(review!);

    const disclosure = container.querySelector('[data-testid="trusted-site-disclosure"]');
    expect(disclosure).not.toBeNull();
    expect(disclosure!.textContent).toContain(`disclosure ${TRUSTED_SITE_DISCLOSURE_V1.version}`);

    // Re-acknowledging re-writes trusted_site (the host re-stamps the fresh version).
    const keepOn = buttonByText(container, /re-acknowledge and keep on/i);
    expect(keepOn).toBeTruthy();
    expect(formHiddenInputs(keepOn!)).toEqual({ instanceId: "inst-1", mode: "trusted_site" });
  });
});

describe("WordPressTrustedSiteCard — host without trusted-site support", () => {
  it("renders an explicit unavailable note when the host exposes no opt-in surface", async () => {
    const container = await renderCard({ policy: null, explain: null });

    expect(container.querySelector('[data-testid="trusted-site-unavailable"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="trusted-site-card"]')).toBeNull();
    expect(container.textContent).toContain("Not available on this Cinatra version");
    // No enable control on an unsupported host.
    expect(buttonByText(container, /enable trusted-site mode/i)).toBeUndefined();
  });
});
