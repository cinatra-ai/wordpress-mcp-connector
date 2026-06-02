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
