"use client";

// Remote-assist catalog-plugin install action (cinatra#2021 S6/delta) — the
// ONE piece of this program that lets Cinatra itself trigger a WRITE on the
// connected site's own WordPress install, using the stored Application
// Password. Renders alongside the least-privilege warning card on the same
// per-instance Connections-tab surface, but is its OWN separate file/card —
// it never reads or renders the warning card's state, keeping the two
// pieces' diffs disjoint.
//
// AUTHORITY: WordPress's OWN `install_plugins` REST capability check on the
// connected site is the SOLE authority on whether this action may proceed.
// This card never pre-flights or infers that capability from anything
// Cinatra stores. A 403 is surfaced honestly — "your WordPress user can't
// install plugins" — never retried, never an invitation to reconnect as a
// different user, never a silent fallback. The only plugin this action can
// ever target is the hardcoded wordpress.org catalog slug
// (`enable-abilities-for-mcp`): there is no slug/URL input anywhere on this
// card, in its form, or in the server action it posts to.
//
// Off by default in the sense that it is a manual, explicit, per-click
// action — never triggered automatically, never on a schedule, never as a
// side effect of viewing this page.

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { installCatalogPluginRemoteAction } from "./setup-actions";
import type { InstallCatalogPluginOutcome } from "./deps";

/** Display name only (never the wire slug) — the wire slug is hardcoded
 * connector-side in `deps.ts`/`lib/wordpress-client.ts`, never here. */
const CATALOG_PLUGIN_DISPLAY_NAME = "Enable Abilities for MCP";

export type WordPressRemoteAssistInstallCardProps = {
  instanceId: string;
  /**
   * `false` ⇒ the connector build this Cinatra host is running predates the
   * `installCatalogPluginRemote` deps member (skew) — the card states the
   * feature is unavailable rather than rendering a button that would only
   * ever fail when clicked.
   */
  available: boolean;
};

export function WordPressRemoteAssistInstallCard({
  instanceId,
  available,
}: WordPressRemoteAssistInstallCardProps) {
  const [result, formAction] = useActionState<InstallCatalogPluginOutcome | null, FormData>(
    async (_prev, formData) => installCatalogPluginRemoteAction(formData),
    null,
  );

  return (
    <div
      data-testid="remote-assist-install-card"
      className="mt-4 rounded-panel border border-line bg-surface px-4 py-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-foreground">Remote-assist plugin install</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Ask this site to install {CATALOG_PLUGIN_DISPLAY_NAME} from the WordPress.org plugin
            directory, using the connected Application Password. Installed inactive — activating it
            is always a separate, manual step in this site&apos;s wp-admin. WordPress&apos;s own
            permission check on the connected user decides whether this can succeed.
          </p>
        </div>
        {result?.outcome === "installed" ? <Badge variant="success">Installed</Badge> : null}
      </div>

      {!available ? (
        <p className="mt-3 text-xs text-muted-foreground">Not available on this Cinatra version.</p>
      ) : (
        <>
          <form action={formAction} className="mt-3">
            <Input type="hidden" name="instanceId" value={instanceId} />
            <RemoteAssistSubmit />
          </form>

          {result?.outcome === "installed" ? (
            <p data-testid="remote-assist-success" className="mt-3 text-xs text-muted-foreground">
              Installed {result.plugin} (WordPress reported HTTP {result.status}). Activate it from
              this site&apos;s wp-admin Plugins screen when you&apos;re ready.
            </p>
          ) : null}
          {result?.outcome === "forbidden" ? (
            // The 403 is surfaced truthfully and terminally: no retry, no
            // credential prompt, and — deliberately — no suggestion to
            // reconnect a more-privileged user, which would cut against this
            // program's own least-privilege posture. The manual wp-admin path
            // (performed by someone who already holds the capability on the
            // site itself) is the only remediation offered.
            <p
              data-testid="remote-assist-forbidden"
              className="mt-3 text-xs text-destructive"
              role="alert"
            >
              Your connected WordPress user can&apos;t install plugins. Install{" "}
              {CATALOG_PLUGIN_DISPLAY_NAME} manually from this site&apos;s wp-admin Plugins screen, or
              ask a site administrator to do it there.
            </p>
          ) : null}
          {result?.outcome === "error" ? (
            <p data-testid="remote-assist-error" className="mt-3 text-xs text-destructive" role="alert">
              {result.wpMessage}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function RemoteAssistSubmit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} variant="outline">
      {pending ? "Installing…" : `Install ${CATALOG_PLUGIN_DISPLAY_NAME}`}
    </Button>
  );
}
