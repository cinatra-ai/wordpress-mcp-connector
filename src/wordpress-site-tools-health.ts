// Pure, render-agnostic health derivation for the "Site tools & access"
// surface.
//
// WHY THIS MODULE EXISTS. `wordpress-site-tools-card.tsx` carries a
// `"use client"` directive, and under React Server Components EVERY export of
// a client module is a client REFERENCE — not the value. The SERVER component
// `settings-page.tsx` calls `deriveSiteConnectionBadge(...)` while rendering
// the per-connection header badge, so importing it from the card made the
// whole Connections tab throw at render time (a runtime-only fault: the build
// stays green):
//
//   Attempted to call deriveSiteConnectionBadge() from the server but
//   deriveSiteConnectionBadge is on the client.
//
// Keeping the derivation in a module with NO directive lets the server page
// and the client card share one implementation.

import type { SiteServerHealthRow } from "./deps";

/** Human labels for the host's probe classification. Any unrecognised value
 * (forward skew) falls back to the raw string — rendered, never a crash. */
const HEALTH_LABELS: Record<string, string> = {
  registered: "Available",
  not_installed: "Adapter not installed",
  auth_error: "Authentication error",
  unreachable: "Unreachable",
  catalog_unavailable: "Catalog unavailable",
};

export function healthLabel(status: string | null): string {
  if (status === null) return "Not checked yet";
  return HEALTH_LABELS[status] ?? status;
}

export type SiteConnectionBadge = {
  variant: "success" | "secondary" | "warning";
  label: string;
};

/** The per-connection header badge, derived from real probe health instead of
 * the old static "Connected" text. `null` rows (a host without the enrollment
 * surface) keep the legacy meaning — the credential is saved — unchanged. */
export function deriveSiteConnectionBadge(
  servers: SiteServerHealthRow[] | null,
): SiteConnectionBadge {
  if (servers === null) return { variant: "success", label: "Connected" };
  const enrolled = servers.filter((row) => row.status === "enrolled");
  if (enrolled.length === 0) return { variant: "secondary", label: "No MCP servers enrolled" };
  if (enrolled.some((row) => row.lastStatus === "registered")) {
    return { variant: "success", label: "Connected" };
  }
  if (enrolled.every((row) => row.lastStatus === null)) {
    return { variant: "secondary", label: "Connected — health unverified" };
  }
  const worst = enrolled.find((row) => row.lastStatus !== null && row.lastStatus !== "registered");
  return { variant: "warning", label: healthLabel(worst?.lastStatus ?? null) };
}
