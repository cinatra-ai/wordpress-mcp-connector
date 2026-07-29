"use client";

// Least-privilege connected-user warning card (cinatra#2021 S6, design D6/D8).
//
// Reads the tri-state `ConnectedSiteMetadata` (resolved host-side by
// `resolveConnectedSiteMetadata`, cinatra's `connector-instance-site-metadata.ts`)
// and renders EXACTLY one of three states, every time — never nothing:
//
//   - Administrator (loud warning) — the connected Application-Password user's
//     reported role is exactly `"administrator"`.
//   - Non-administrator (informational/ok) — a role was reported and it isn't
//     `"administrator"`.
//   - Unknown (neutral caution) — no report has ever been accepted for this
//     instance, its last report failed to parse, OR the connector is talking to
//     an older Cinatra that doesn't expose this member at all. All three
//     collapse to the SAME rendered caution (`register.ts` degrades the
//     absent-host-member case to the identical `no_inventory` shape a
//     genuinely-silent site produces) — the point being that "no signal" is
//     never allowed to read as "verified safe."
//
// This directly rules out "silence as safety": a binary "warn only if
// administrator, else render nothing" design would make a site that never
// reports (or reports something malformed) indistinguishable from "verified
// non-administrator." There is no code path in this component that renders an
// empty/absent card.

import { Badge } from "./components/ui/badge";
import type { ConnectedSiteMetadata } from "./deps";

/** Shown whenever a role NAME is actually being relied on (the known states) —
 * the contract reports a role NAME, not a capability set, so a custom role
 * granting equivalent access under a different name would not be caught. */
const HONEST_LIMIT_NOTE =
  "This reflects the ROLE NAME the site reports, not a capability check — a custom role granting equivalent access under a different name would not be caught here.";

type Tone = "danger" | "caution" | "ok";

export type SiteRoleDescriptor = {
  tone: Tone;
  badgeLabel: string;
  title: string;
  body: string;
  showHonestLimit: boolean;
};

/**
 * Pure render-mapping from the tri-state to the card's copy. Exported so the
 * switch's exhaustiveness can be unit-tested directly (an `as`-cast past the
 * type system should still land in the `default` branch below and render the
 * SAME neutral caution as `unknown` — never something that reads as "clear").
 */
export function describeConnectedSiteRole(metadata: ConnectedSiteMetadata): SiteRoleDescriptor {
  switch (metadata.status) {
    case "known": {
      if (metadata.connectedUserRole === "administrator") {
        return {
          tone: "danger",
          badgeLabel: "Administrator",
          title: "Connected as an Administrator",
          body:
            "The connected WordPress user is an Administrator. This gives the assistant far more " +
            "reach than it needs (e.g. installing plugins or running arbitrary code snippets is " +
            "reachable through this credential once its abilities are enrolled). Connect a " +
            "dedicated, least-privilege user instead.",
          showHonestLimit: true,
        };
      }
      return {
        tone: "ok",
        badgeLabel: metadata.connectedUserRole,
        title: "Connected user is not an Administrator",
        body: `The connected WordPress user's reported role is "${metadata.connectedUserRole}" — not Administrator.`,
        showHonestLimit: true,
      };
    }
    case "unknown": {
      return {
        tone: "caution",
        badgeLabel: "Unknown",
        title: "Connected user's role — unknown",
        body:
          metadata.reason === "unparseable"
            ? "This site's last report couldn't be read — install/update the companion plugin or wait for its next check-in to see this."
            : "This site hasn't reported its connected user's role yet — install/update the companion plugin or wait for its next check-in to see this.",
        showHonestLimit: false,
      };
    }
    default: {
      // Exhaustiveness guard: a future unsafe cast/`as any` that bypasses the
      // discriminated union's static exhaustiveness is still CAUGHT here — it
      // renders the SAME neutral caution as `unknown`, never silently falling
      // through to "no card" or to a state that reads as clear/safe.
      const _exhaustive: never = metadata;
      void _exhaustive;
      return {
        tone: "caution",
        badgeLabel: "Unknown",
        title: "Connected user's role — unknown",
        body: "Couldn't determine this site's connected role from its last report — treating this as unknown, not as clear.",
        showHonestLimit: false,
      };
    }
  }
}

const BADGE_VARIANT: Record<Tone, "destructive" | "warning" | "success"> = {
  danger: "destructive",
  caution: "warning",
  ok: "success",
};

const PANEL_CLASS: Record<Tone, string> = {
  danger: "border-destructive/30 bg-destructive/5",
  caution: "border-warning/30 bg-warning/5",
  ok: "border-line bg-surface",
};

export type WordPressLeastPrivilegeCardProps = {
  metadata: ConnectedSiteMetadata;
};

export function WordPressLeastPrivilegeCard({ metadata }: WordPressLeastPrivilegeCardProps) {
  const descriptor = describeConnectedSiteRole(metadata);

  return (
    <div
      data-testid="least-privilege-card"
      data-tone={descriptor.tone}
      className={`mt-3 rounded-card border px-4 py-3 ${PANEL_CLASS[descriptor.tone]}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-[13px] font-semibold text-foreground">{descriptor.title}</p>
        <Badge variant={BADGE_VARIANT[descriptor.tone]}>{descriptor.badgeLabel}</Badge>
      </div>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{descriptor.body}</p>
      {descriptor.showHonestLimit ? (
        <p className="mt-2 text-[11px] leading-5 text-muted-foreground/80">{HONEST_LIMIT_NOTE}</p>
      ) : null}
    </div>
  );
}
