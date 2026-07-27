"use client";

// Per-site "Trusted-site mode" opt-in card (cinatra#2019).
//
// Trusted-site mode is the per-instance, default-OFF opt-in that lets a
// connected site's small descriptor-verified TRUSTED-READ set reach the model
// provider through native injection. Enabling it shares real risk (see the
// disclosure below), so enabling / re-acknowledging always flows through an
// explicit confirmation that renders the residual-risk disclosure first.
//
// The card is presentational for state it receives from the server (the current
// opt-in mode + a dry-run preview of what would inject on the site's CURRENT
// advertised catalog) and delegates every mutation to the `manage`-gated
// `setWordPressTrustedSiteModeAction` server action. It sends ONLY the instance
// id + the target mode: the host stamps the acknowledged disclosure /
// descriptor-set version from its own shipped constants, so this card never
// supplies or forges a version or hash.
//
// Skew: `policy === null` means the host does not expose trusted-site mode at all
// (an older Cinatra) → the card renders an explicit unavailable note. `explain
// === null` means the host exposes the opt-in but not the dry-run preview → the
// card states the preview is unavailable and shows the static empty-set note.

import { useEffect, useState } from "react";

import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { setWordPressTrustedSiteModeAction } from "./setup-actions";
import type {
  NativeReadInjectionExplain,
  NativeReadInjectionPolicyView,
} from "./deps";

/**
 * The versioned residual-risk disclosure shown before enabling or
 * re-acknowledging trusted-site mode. Rendered for acknowledgement ONLY — the
 * host is the source of truth for what was acknowledged and stamps its own
 * shipped version on enable, so the card never sends this version (or any hash)
 * back to the host. Populating the trusted-read set later ships a fresh version
 * and disclosure, which turns existing acknowledgements stale until re-confirmed.
 */
export const TRUSTED_SITE_DISCLOSURE_V1 = {
  version: "v1",
  text:
    "Cinatra verifies what this site advertises, never what its code executes. " +
    "With trusted-site mode on, descriptor-verified read tools run directly at " +
    "the model provider, and the site's connection credential (its Application " +
    "Password) is shared with the provider to make those calls — a same-site " +
    "plugin could swap the implementation behind a verified read without " +
    "detection, and the credential authorizes whatever the connected user's role " +
    "allows. Enable only for sites whose plugin code you trust, keep the connected " +
    "user least-privilege, and rotate the Application Password if you later " +
    "withdraw this trust.",
} as const;

export type WordPressTrustedSiteCardProps = {
  instanceId: string;
  instanceName: string;
  /** `null` ⇒ the host does not expose trusted-site mode (feature unavailable). */
  policy: NativeReadInjectionPolicyView | null;
  /** `null` ⇒ the host does not expose the dry-run preview (older host). */
  explain: NativeReadInjectionExplain | null;
};

export function WordPressTrustedSiteCard({
  instanceId,
  instanceName,
  policy,
  explain,
}: WordPressTrustedSiteCardProps) {
  const [ceremonyOpen, setCeremonyOpen] = useState(false);

  const mode = policy?.mode ?? "off";
  const isOn = mode === "trusted_site";
  const consentStale = Boolean(policy?.consentStale ?? explain?.consentStale);
  // The enable / re-acknowledge path is live whenever the site is off OR its
  // consent went stale (nothing injects while stale until re-acknowledged).
  const needsAck = !isOn || consentStale;

  // Collapse the confirmation whenever the persisted state round-trips through
  // the server (enable / disable / re-acknowledge) so a stale disclosure panel
  // never lingers or re-opens unbidden after a mode change.
  useEffect(() => {
    setCeremonyOpen(false);
  }, [mode, consentStale]);

  if (!policy) {
    return (
      <div
        data-testid="trusted-site-unavailable"
        className="mt-4 rounded-panel border border-dashed border-line px-4 py-3"
      >
        <p className="text-[13px] font-semibold text-foreground">Trusted-site mode</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Not available on this Cinatra version. No tools are injected for this site.
        </p>
      </div>
    );
  }

  const previewAvailable = explain !== null;
  const verifiedCount = explain?.verifiedNames.length ?? 0;
  const previewText = previewAvailable
    ? verifiedCount === 0
      ? "No tools qualify for direct injection yet."
      : `${verifiedCount} ${verifiedCount === 1 ? "tool qualifies" : "tools qualify"} for direct injection.`
    : "Preview unavailable on this Cinatra version — no tools are injected.";

  const triggerLabel = consentStale ? "Review and re-acknowledge" : "Enable trusted-site mode";
  const confirmLabel = consentStale ? "Re-acknowledge and keep on" : "Confirm and enable";

  return (
    <div
      data-testid="trusted-site-card"
      className="mt-4 rounded-panel border border-line bg-surface px-4 py-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-foreground">Trusted-site mode</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Let this site&apos;s descriptor-verified read tools run directly at the model
            provider. Off by default; writes always stay on Cinatra&apos;s governed path.
          </p>
        </div>
        <div className="flex flex-none items-center gap-2">
          {isOn ? <Badge variant="success">On</Badge> : <Badge variant="secondary">Off</Badge>}
          {consentStale ? <Badge variant="warning">Re-acknowledge required</Badge> : null}
        </div>
      </div>

      {/* Live preview — derived from the dry-run count, never hardcoded. */}
      <p data-testid="trusted-site-preview" className="mt-3 text-xs text-muted-foreground">
        {previewText}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {isOn ? (
          <form action={setWordPressTrustedSiteModeAction}>
            <Input type="hidden" name="instanceId" value={instanceId} />
            <Input type="hidden" name="mode" value="off" />
            <Button type="submit" formNoValidate variant="outline">
              Disable
            </Button>
          </form>
        ) : null}
        {needsAck && !ceremonyOpen ? (
          <Button type="button" variant="outline" onClick={() => setCeremonyOpen(true)}>
            {triggerLabel}
          </Button>
        ) : null}
      </div>

      {ceremonyOpen && needsAck ? (
        <div
          data-testid="trusted-site-disclosure"
          className="mt-3 rounded-card border border-warning/30 bg-warning/5 px-4 py-3"
        >
          <p className="text-[13px] font-semibold text-foreground">
            Before you enable — read this (disclosure {TRUSTED_SITE_DISCLOSURE_V1.version})
          </p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {TRUSTED_SITE_DISCLOSURE_V1.text}
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <form action={setWordPressTrustedSiteModeAction}>
              <Input type="hidden" name="instanceId" value={instanceId} />
              <Input type="hidden" name="mode" value="trusted_site" />
              <Button type="submit" formNoValidate>
                {confirmLabel}
              </Button>
            </form>
            <Button type="button" variant="ghost" onClick={() => setCeremonyOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
