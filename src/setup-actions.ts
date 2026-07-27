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
import { getWordPressDeps } from "./deps";

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
