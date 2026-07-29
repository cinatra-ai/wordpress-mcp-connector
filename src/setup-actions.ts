"use server";

// WordPress instance server action — relocated from the central
// `@cinatra-ai/connectors` host hub into the connector itself as part of the
// SDK-only decouple. Gated by the SDK's `requireExtensionAction(pkg, "manage")` — an
// instance hard-delete is an admin op (the hub copy used `requireAdminSession()`;
// the SDK action guard is the host-bound equivalent — org_owner/org_admin/
// platform_admin, fail-closed). The guard runs FIRST; the actual delete runs
// through the connector's injected `deleteInstance` dep (the host owns the
// `@/lib/wordpress-api` edge), so there is NO `@/lib/*` import here.

import { requireExtensionAction } from "@cinatra-ai/sdk-extensions";
import { getWordPressDeps, type InstallCatalogPluginOutcome } from "./deps";

const WORDPRESS_PACKAGE_ID = "@cinatra-ai/wordpress-mcp-connector";

export async function deleteWordPressInstanceAction(formData: FormData) {
  await requireExtensionAction(WORDPRESS_PACKAGE_ID, "manage");

  const instanceId = String(formData.get("instanceId") ?? "").trim();
  if (!instanceId) {
    throw new Error("Missing WordPress instance id.");
  }

  await getWordPressDeps().deleteInstance(instanceId);
}

// cinatra#2019 trusted-site mode — set a WordPress instance's per-site
// native-read-injection opt-in. `manage`-gated like the delete op (org-admin,
// fail-closed), and gated a SECOND time host-side inside the setter. The form
// carries ONLY the instance id and the target mode: the host stamps the
// acknowledged disclosure + descriptor-set version from its OWN shipped
// constants, so the connector can never assert or forge the acknowledged
// content. Re-acknowledging a stale consent is the same call with
// `mode:"trusted_site"` — the host re-stamps.
export async function setWordPressTrustedSiteModeAction(formData: FormData) {
  await requireExtensionAction(WORDPRESS_PACKAGE_ID, "manage");

  const instanceId = String(formData.get("instanceId") ?? "").trim();
  if (!instanceId) {
    throw new Error("Missing WordPress instance id.");
  }

  const mode = String(formData.get("mode") ?? "").trim();
  if (mode !== "off" && mode !== "trusted_site") {
    throw new Error("Invalid trusted-site mode.");
  }

  const deps = getWordPressDeps();
  if (typeof deps.setNativeInjectionMode !== "function") {
    throw new Error(
      "This Cinatra version does not support trusted-site mode.",
    );
  }

  await deps.setNativeInjectionMode({ instanceId, mode });
}

// cinatra#2021 S6/delta — remote-assist catalog-plugin install. `manage`-gated
// like every other admin op on this surface (org_owner/org_admin/
// platform_admin, fail-closed) — but that gate is NOT the authority on whether
// the install itself may proceed. WordPress's OWN `install_plugins` REST
// capability check on the connected site's user is the sole authority; this
// action's job is only to route an explicit admin click to that real check
// and return its outcome untouched, never to pre-approve or retry it. The
// form carries ONLY the instance id — there is no slug/URL input anywhere on
// this path, so it can never be redirected at any plugin other than the
// hardcoded wordpress.org catalog slug the deps member installs (never the
// GitHub-only MCP Adapter, which this REST route cannot install regardless).
//
// Returns the typed outcome (rather than throwing) so the calling card can
// render "installed" / "your WordPress user can't install plugins" / "WordPress
// said: <message>" inline — a plain throw would only surface the FIRST of
// those honestly; the other two need the real WordPress response, not a
// generic error page.
export async function installCatalogPluginRemoteAction(
  formData: FormData,
): Promise<InstallCatalogPluginOutcome> {
  await requireExtensionAction(WORDPRESS_PACKAGE_ID, "manage");

  const instanceId = String(formData.get("instanceId") ?? "").trim();
  if (!instanceId) {
    // Typed outcome, not a throw: this action's contract is that EVERY
    // post-authorization failure resolves a renderable result — a
    // crafted/degenerate form must not crash the settings UI. (The manage
    // gate above still throws on deny: an unauthorized caller gets no typed
    // channel at all.)
    return {
      outcome: "error",
      status: 0,
      wpMessage: "Missing WordPress instance id.",
    };
  }

  const deps = getWordPressDeps();
  if (typeof deps.installCatalogPluginRemote !== "function") {
    return {
      outcome: "error",
      status: 0,
      wpMessage: "This Cinatra version does not support remote-assist plugin installs.",
    };
  }

  return deps.installCatalogPluginRemote(instanceId);
}
