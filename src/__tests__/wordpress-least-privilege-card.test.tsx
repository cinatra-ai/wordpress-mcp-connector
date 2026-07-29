// @vitest-environment jsdom
/**
 * Least-privilege warning card (cinatra-ai/cinatra#2021 S6, design D6/D8).
 *
 * The card reads the tri-state `ConnectedSiteMetadata` and renders EXACTLY one
 * of Administrator / Non-administrator / Unknown, every time — never nothing.
 * This is the direct regression test against "silence as safety": a binary
 * "warn only if administrator, else render nothing" design would let a site
 * that never reports (or reports something malformed) read as indistinguishable
 * from "verified non-administrator." Every test in the "never renders nothing"
 * describe block below asserts the card's own testid is present — including
 * for a value that bypasses the discriminated union's static exhaustiveness
 * via an unsafe cast, which is the switch-exhaustiveness hardening this suite
 * also covers.
 *
 * Renders the REAL client component (raw `react-dom/client` + `act`, no
 * testing-library) — mirrors wordpress-trusted-site-card.test.tsx's pattern.
 * No host deps to stub here: this card is pure/presentational (its only input
 * is the `metadata` prop), so there is nothing to mock.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  WordPressLeastPrivilegeCard,
  describeConnectedSiteRole,
} from "../wordpress-least-privilege-card";
import type { ConnectedSiteMetadata } from "../deps";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

async function renderCard(metadata: ConnectedSiteMetadata): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(<WordPressLeastPrivilegeCard metadata={metadata} />);
  });
  return container;
}

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
});

const KNOWN_ADMIN: ConnectedSiteMetadata = {
  status: "known",
  wpVersion: "6.9",
  phpVersion: "8.2",
  adapterVersion: "1.0.0",
  abilitiesPluginVersion: "1.0.0",
  connectedUserRole: "administrator",
  permalinkStructure: "pretty",
  receivedAt: "2026-07-01T00:00:00.000Z",
};

const KNOWN_EDITOR: ConnectedSiteMetadata = {
  ...KNOWN_ADMIN,
  connectedUserRole: "editor",
};

const UNKNOWN_NO_INVENTORY: ConnectedSiteMetadata = {
  status: "unknown",
  reason: "no_inventory",
};

const UNKNOWN_UNPARSEABLE: ConnectedSiteMetadata = {
  status: "unknown",
  reason: "unparseable",
};

/** A value that bypasses the discriminated union's static exhaustiveness — the
 * shape a future unsafe cast (`as any`) could produce at runtime even though
 * TypeScript would reject it statically. */
const UNRECOGNIZED_STATUS = { status: "revoked" } as unknown as ConnectedSiteMetadata;

function cardEl(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-testid="least-privilege-card"]');
  expect(el, "card must always render — never nothing").not.toBeNull();
  return el as HTMLElement;
}

describe("WordPressLeastPrivilegeCard — Administrator (loud warning)", () => {
  it("renders the loud Administrator warning with the exact reach-callout copy", async () => {
    const container = await renderCard(KNOWN_ADMIN);
    const card = cardEl(container);

    expect(card.getAttribute("data-tone")).toBe("danger");
    expect(card.textContent).toContain("Administrator");
    expect(card.textContent).toContain(
      "This gives the assistant far more reach than it needs",
    );
    expect(card.textContent).toContain("Connect a dedicated, least-privilege user instead.");
  });

  it("includes the honest role-name-only limit note", async () => {
    const container = await renderCard(KNOWN_ADMIN);
    expect(cardEl(container).textContent).toContain(
      "This reflects the ROLE NAME the site reports, not a capability check",
    );
  });
});

describe("WordPressLeastPrivilegeCard — Non-administrator (informational/ok)", () => {
  it("renders the reported role informationally, not as a warning", async () => {
    const container = await renderCard(KNOWN_EDITOR);
    const card = cardEl(container);

    expect(card.getAttribute("data-tone")).toBe("ok");
    expect(card.textContent).toContain("editor");
    expect(card.textContent).toContain("not Administrator");
    expect(card.textContent).not.toContain("Connect a dedicated, least-privilege user instead.");
  });

  it("still includes the honest role-name-only limit note (a role name IS being relied on)", async () => {
    const container = await renderCard(KNOWN_EDITOR);
    expect(cardEl(container).textContent).toContain(
      "This reflects the ROLE NAME the site reports, not a capability check",
    );
  });
});

describe("WordPressLeastPrivilegeCard — Unknown (neutral caution, never renders as safe)", () => {
  it("names 'no inventory yet' distinctly from a parse failure", async () => {
    const container = await renderCard(UNKNOWN_NO_INVENTORY);
    const card = cardEl(container);

    expect(card.getAttribute("data-tone")).toBe("caution");
    expect(card.textContent).toContain("hasn't reported its connected user's role yet");
  });

  it("names a parse failure distinctly from 'no inventory yet'", async () => {
    const container = await renderCard(UNKNOWN_UNPARSEABLE);
    const card = cardEl(container);

    expect(card.getAttribute("data-tone")).toBe("caution");
    expect(card.textContent).toContain("last report couldn't be read");
  });

  it("does NOT show the role-name-only limit note when no role was actually reported", async () => {
    const container = await renderCard(UNKNOWN_NO_INVENTORY);
    expect(cardEl(container).textContent).not.toContain("ROLE NAME");
  });

  it("never renders anything that could read as 'verified non-administrator' (no success/ok tone)", async () => {
    const container = await renderCard(UNKNOWN_NO_INVENTORY);
    expect(cardEl(container).getAttribute("data-tone")).not.toBe("ok");
  });
});

describe("WordPressLeastPrivilegeCard — never renders nothing (D6/D8 core invariant)", () => {
  it.each([
    ["known/administrator", KNOWN_ADMIN],
    ["known/non-administrator", KNOWN_EDITOR],
    ["unknown/no_inventory", UNKNOWN_NO_INVENTORY],
    ["unknown/unparseable", UNKNOWN_UNPARSEABLE],
  ] as const)("renders a non-empty card for %s", async (_label, metadata) => {
    const container = await renderCard(metadata);
    const card = cardEl(container);
    expect(card.textContent?.trim().length).toBeGreaterThan(0);
  });

  it("switch-exhaustiveness hardening: an unrecognized status still renders — as caution, never as clear", async () => {
    const container = await renderCard(UNRECOGNIZED_STATUS);
    const card = cardEl(container);

    // CAUGHT at the render boundary, not silently dropped and not rendered as
    // if it were a known-safe / known-administrator state.
    expect(card.getAttribute("data-tone")).toBe("caution");
    expect(card.getAttribute("data-tone")).not.toBe("ok");
    expect(card.getAttribute("data-tone")).not.toBe("danger");
    expect(card.textContent).toContain("treating this as unknown, not as clear");
  });
});

describe("describeConnectedSiteRole — pure switch-exhaustiveness unit coverage", () => {
  it("maps every known discriminant to its own tone", () => {
    expect(describeConnectedSiteRole(KNOWN_ADMIN).tone).toBe("danger");
    expect(describeConnectedSiteRole(KNOWN_EDITOR).tone).toBe("ok");
    expect(describeConnectedSiteRole(UNKNOWN_NO_INVENTORY).tone).toBe("caution");
    expect(describeConnectedSiteRole(UNKNOWN_UNPARSEABLE).tone).toBe("caution");
  });

  it("an unsafe-cast value past the discriminated union falls through to the default `never` arm — caution, not a throw, not a crash", () => {
    const descriptor = describeConnectedSiteRole(UNRECOGNIZED_STATUS);
    expect(descriptor.tone).toBe("caution");
    expect(descriptor.badgeLabel).toBe("Unknown");
  });
});
