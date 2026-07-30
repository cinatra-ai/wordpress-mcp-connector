// @vitest-environment jsdom
/**
 * Site tools & access card (cinatra-ai/cinatra#2022 S7).
 *
 * Covers the three pieces on one card: the discovered-server health matrix,
 * the per-pipeline readiness badges (a presentational MIRROR of the host
 * policy evaluator — deny absolute, `open` allows non-denied, `restricted`
 * allows only the allow list), and the staged tool-selection editor whose
 * every save is a FULL-record replace through the stubbed server action.
 * Also pins the header-badge derivation that replaces the old static
 * "Connected" text with real probe health.
 *
 * Renders the REAL client component (raw `react-dom/client` + `act`, no
 * testing-library) — only the `manage`-gated server action is stubbed.
 * Mirrors wordpress-trusted-site-card.test.tsx's pattern.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../setup-actions", () => ({
  setWordPressInstanceToolPolicyAction: vi.fn(),
}));

import {
  DEFAULT_CATALOG_SERVER_ID,
  PIPELINE_REQUIREMENTS,
  WordPressSiteToolsCard,
  deriveSiteConnectionBadge,
  evaluatePipelineReadiness,
  isRefAllowed,
  type WordPressSiteToolsCardProps,
} from "../wordpress-site-tools-card";
import type { InstanceToolPolicyView, SiteServerHealthRow } from "../deps";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

const DEFAULT_SERVER_HEALTHY: SiteServerHealthRow = {
  serverId: DEFAULT_CATALOG_SERVER_ID,
  source: "default",
  status: "enrolled",
  label: null,
  serverVersion: "0.5.0",
  restPath: "/mcp/mcp-adapter-default-server",
  lastStatus: "registered",
  lastStatusAt: "2026-07-30T00:00:00.000Z",
};

const RESTRICTED_EMPTY: InstanceToolPolicyView = {
  instanceId: "inst-1",
  mode: "restricted",
  allow: [],
  deny: [],
};

/** Every ability any pipeline needs, allowed on the default server. */
const ALL_PIPELINE_REFS = PIPELINE_REQUIREMENTS.flatMap((p) => p.refs).filter(
  (ref, i, all) => all.findIndex((r) => r.serverId === ref.serverId && r.name === ref.name) === i,
);

const FULLY_ALLOWED: InstanceToolPolicyView = {
  ...RESTRICTED_EMPTY,
  allow: ALL_PIPELINE_REFS,
};

const baseProps: WordPressSiteToolsCardProps = {
  instanceId: "inst-1",
  instanceName: "Marketing blog",
  policy: RESTRICTED_EMPTY,
  servers: [DEFAULT_SERVER_HEALTHY],
};

async function renderCard(
  overrides: Partial<WordPressSiteToolsCardProps> = {},
): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(<WordPressSiteToolsCard {...baseProps} {...overrides} />);
  });
  return container;
}

function buttonByText(container: HTMLElement, re: RegExp): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((b) =>
    re.test(b.textContent ?? ""),
  ) as HTMLButtonElement | undefined;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
}

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// Pure helpers — the presentational mirror of the host evaluator.
// ---------------------------------------------------------------------------

describe("isRefAllowed — mirrors the host truth table", () => {
  const ref = { serverId: DEFAULT_CATALOG_SERVER_ID, name: "ewpa/update-post" };

  it("restricted: only allow-listed refs pass", () => {
    expect(isRefAllowed(RESTRICTED_EMPTY, ref)).toBe(false);
    expect(isRefAllowed({ ...RESTRICTED_EMPTY, allow: [ref] }, ref)).toBe(true);
  });

  it("open: everything not denied passes", () => {
    expect(isRefAllowed({ ...RESTRICTED_EMPTY, mode: "open" }, ref)).toBe(true);
  });

  it("deny precedence is absolute in BOTH modes", () => {
    expect(isRefAllowed({ ...RESTRICTED_EMPTY, mode: "open", deny: [ref] }, ref)).toBe(false);
    expect(isRefAllowed({ ...RESTRICTED_EMPTY, allow: [ref], deny: [ref] }, ref)).toBe(false);
  });

  it("matching is on the FULL {serverId, name} pair, never a bare name", () => {
    expect(
      isRefAllowed(
        { ...RESTRICTED_EMPTY, allow: [{ serverId: "some-other-server", name: ref.name }] },
        ref,
      ),
    ).toBe(false);
  });
});

describe("evaluatePipelineReadiness", () => {
  const refs = PIPELINE_REQUIREMENTS[0].refs;

  it("null policy (older host) → unknown, never a guessed green", () => {
    expect(evaluatePipelineReadiness(null, [DEFAULT_SERVER_HEALTHY], refs)).toEqual({
      state: "unknown",
    });
  });

  it("missing refs → policy_blocked with exactly the missing set", () => {
    const verdict = evaluatePipelineReadiness(RESTRICTED_EMPTY, [DEFAULT_SERVER_HEALTHY], refs);
    expect(verdict.state).toBe("policy_blocked");
    expect(verdict.state === "policy_blocked" && verdict.missing).toEqual(refs);
  });

  it("all allowed + healthy default server → ready", () => {
    expect(evaluatePipelineReadiness(FULLY_ALLOWED, [DEFAULT_SERVER_HEALTHY], refs)).toEqual({
      state: "ready",
    });
  });

  it("all allowed but default server known-unhealthy → server_unhealthy", () => {
    const verdict = evaluatePipelineReadiness(
      FULLY_ALLOWED,
      [{ ...DEFAULT_SERVER_HEALTHY, lastStatus: "auth_error" }],
      refs,
    );
    expect(verdict).toEqual({ state: "server_unhealthy", health: "auth_error" });
  });

  it("no server surface (null) or never-probed default → policy verdict stands", () => {
    expect(evaluatePipelineReadiness(FULLY_ALLOWED, null, refs)).toEqual({ state: "ready" });
    expect(
      evaluatePipelineReadiness(
        FULLY_ALLOWED,
        [{ ...DEFAULT_SERVER_HEALTHY, lastStatus: null }],
        refs,
      ),
    ).toEqual({ state: "ready" });
  });
});

describe("deriveSiteConnectionBadge — the static 'Connected' badge replacement", () => {
  it("null rows (no health surface on this host) keep the legacy label", () => {
    expect(deriveSiteConnectionBadge(null)).toEqual({ variant: "success", label: "Connected" });
  });

  it("an enrolled registered server → Connected (success)", () => {
    expect(deriveSiteConnectionBadge([DEFAULT_SERVER_HEALTHY])).toEqual({
      variant: "success",
      label: "Connected",
    });
  });

  it("no enrolled rows at all → an honest non-success state", () => {
    expect(deriveSiteConnectionBadge([])).toEqual({
      variant: "secondary",
      label: "No MCP servers enrolled",
    });
    expect(
      deriveSiteConnectionBadge([{ ...DEFAULT_SERVER_HEALTHY, status: "retired" }]),
    ).toEqual({ variant: "secondary", label: "No MCP servers enrolled" });
  });

  it("enrolled but never probed → health-unverified, not a false green", () => {
    expect(deriveSiteConnectionBadge([{ ...DEFAULT_SERVER_HEALTHY, lastStatus: null }])).toEqual({
      variant: "secondary",
      label: "Connected — health unverified",
    });
  });

  it("enrolled with a failing probe → warning with the mapped label", () => {
    expect(
      deriveSiteConnectionBadge([{ ...DEFAULT_SERVER_HEALTHY, lastStatus: "auth_error" }]),
    ).toEqual({ variant: "warning", label: "Authentication error" });
  });
});

// ---------------------------------------------------------------------------
// Render — the card's three sections and their skew states.
// ---------------------------------------------------------------------------

describe("render — skew states are explicit, never silent", () => {
  it("policy null → the selection surface says so; the card itself still renders", async () => {
    const container = await renderCard({ policy: null });
    expect(container.querySelector('[data-testid="site-tools-card"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="site-tools-selection-unavailable"]'),
    ).not.toBeNull();
  });

  it("servers null → the matrix says the health surface is unavailable", async () => {
    const container = await renderCard({ servers: null });
    expect(container.querySelector('[data-testid="site-tools-servers"]')?.textContent).toContain(
      "not available on this Cinatra version",
    );
  });

  it("restricted+empty (the post-#2232 default) → 'No tools allowed' + the empty-allow note", async () => {
    const container = await renderCard();
    expect(container.textContent).toContain("No tools allowed");
    expect(container.querySelector('[data-testid="site-tools-empty-allow"]')).not.toBeNull();
  });

  it("server rows render with mapped health labels", async () => {
    const container = await renderCard({
      servers: [
        DEFAULT_SERVER_HEALTHY,
        {
          ...DEFAULT_SERVER_HEALTHY,
          serverId: "custom--s-abc123",
          source: "manual",
          label: "Custom search server",
          lastStatus: "unreachable",
        },
      ],
    });
    const rows = container.querySelectorAll('[data-testid="site-tools-server-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Available");
    expect(rows[1].textContent).toContain("Custom search server");
    expect(rows[1].textContent).toContain("Unreachable");
  });
});

describe("render — per-pipeline readiness", () => {
  it("restricted+empty → every pipeline is Blocked with its missing count", async () => {
    const container = await renderCard();
    for (const pipeline of PIPELINE_REQUIREMENTS) {
      const row = container.querySelector(`[data-testid="site-tools-pipeline-${pipeline.key}"]`);
      expect(row?.textContent).toContain("Blocked");
      expect(row?.textContent).toContain(String(pipeline.refs.length));
    }
  });

  it("fully allowed + healthy server → every pipeline is Ready", async () => {
    const container = await renderCard({ policy: FULLY_ALLOWED });
    for (const pipeline of PIPELINE_REQUIREMENTS) {
      const row = container.querySelector(`[data-testid="site-tools-pipeline-${pipeline.key}"]`);
      expect(row?.textContent).toContain("Ready");
    }
  });

  it("a blocked pipeline offers the one-click fix as a FULL-record replace (missing refs appended)", async () => {
    const container = await renderCard();
    const row = container.querySelector('[data-testid="site-tools-pipeline-blog-publishing"]');
    const policyInput = row?.querySelector('input[name="policy"]') as HTMLInputElement | null;
    expect(policyInput).not.toBeNull();
    const submitted = JSON.parse(policyInput!.value) as {
      mode: string;
      allow: Array<{ serverId: string; name: string }>;
    };
    expect(submitted.mode).toBe("restricted");
    expect(submitted.allow).toEqual(
      expect.arrayContaining([
        { serverId: DEFAULT_CATALOG_SERVER_ID, name: "ewpa/create-post" },
        { serverId: DEFAULT_CATALOG_SERVER_ID, name: "ewpa/update-post-meta" },
        { serverId: DEFAULT_CATALOG_SERVER_ID, name: "ewpa/get-posts" },
      ]),
    );
  });
});

describe("tool-selection editor — staged edits, full-record save", () => {
  it("removing a staged allow entry updates the list and arms Save", async () => {
    const container = await renderCard({ policy: FULLY_ALLOWED });
    expect(
      container.querySelectorAll('[data-testid="site-tools-allow-entry"]').length,
    ).toBe(ALL_PIPELINE_REFS.length);

    const firstRemove = buttonByText(container, /^remove$/i);
    expect(firstRemove).toBeDefined();
    await click(firstRemove!);

    expect(
      container.querySelectorAll('[data-testid="site-tools-allow-entry"]').length,
    ).toBe(ALL_PIPELINE_REFS.length - 1);

    const save = buttonByText(container, /save tool selection/i);
    expect(save).toBeDefined();
    expect(save!.disabled).toBe(false);

    // The save form's hidden payload is the staged FULL record.
    const form = save!.closest("form");
    const policyInput = form?.querySelector('input[name="policy"]') as HTMLInputElement | null;
    const submitted = JSON.parse(policyInput!.value) as { allow: unknown[] };
    expect(submitted.allow).toHaveLength(ALL_PIPELINE_REFS.length - 1);
  });

  it("Save stays disabled while the staged record equals the persisted one", async () => {
    const container = await renderCard({ policy: FULLY_ALLOWED });
    const save = buttonByText(container, /save tool selection/i);
    expect(save!.disabled).toBe(true);
  });

  it("switching to 'All site tools' shows the open-mode warning and arms Save", async () => {
    const container = await renderCard();
    await click(buttonByText(container, /all site tools/i)!);
    expect(container.querySelector('[data-testid="site-tools-open-warning"]')).not.toBeNull();
    expect(buttonByText(container, /save tool selection/i)!.disabled).toBe(false);
  });

  it("the mode switch is a consistent toggle-button GROUP (role=group + aria-pressed) — never a radiogroup with pressed children", async () => {
    const container = await renderCard();
    const group = container.querySelector('[role="group"][aria-label="Tool access mode"]');
    expect(group).not.toBeNull();
    expect(container.querySelector('[role="radiogroup"]')).toBeNull();
    const pressed = Array.from(group!.querySelectorAll("button")).map((b) =>
      b.getAttribute("aria-pressed"),
    );
    expect(pressed).toEqual(["true", "false"]); // restricted selected by default
  });

  it("the one-click pipeline fix disables while the editor holds unsaved changes (staged edits are never silently discarded)", async () => {
    const container = await renderCard();
    const quickFixButton = () =>
      container
        .querySelector('[data-testid="site-tools-pipeline-blog-publishing"]')!
        .querySelector("button") as HTMLButtonElement;
    expect(quickFixButton().disabled).toBe(false);
    expect(container.querySelector('[data-testid="site-tools-quick-fix-dirty"]')).toBeNull();

    // Any staged edit (here: the mode switch) makes the editor dirty …
    await click(buttonByText(container, /all site tools/i)!);

    // … and every pipeline quick-fix goes disabled with the explanatory hint,
    // instead of submitting the PERSISTED record over the staged edits.
    expect(quickFixButton().disabled).toBe(true);
    expect(
      container.querySelector('[data-testid="site-tools-quick-fix-dirty"]'),
    ).not.toBeNull();
  });

  it("the Add button is disabled until a tool name is entered", async () => {
    const container = await renderCard();
    const add = buttonByText(container, /^add$/i);
    expect(add).toBeDefined();
    expect(add!.disabled).toBe(true);
  });

  it("deny entries render with their always-blocked framing", async () => {
    const container = await renderCard({
      policy: {
        ...FULLY_ALLOWED,
        deny: [{ serverId: DEFAULT_CATALOG_SERVER_ID, name: "ewpa/delete-post" }],
      },
    });
    const denyList = container.querySelector('[data-testid="site-tools-deny-list"]');
    expect(denyList?.textContent).toContain("ewpa/delete-post");
    expect(denyList?.textContent).toContain("always blocked");
  });
});
