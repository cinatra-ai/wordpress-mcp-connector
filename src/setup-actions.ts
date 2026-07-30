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
import {
  getWordPressDeps,
  type InstallCatalogPluginOutcome,
  type InstanceToolPolicyMode,
  type SetInstanceToolPolicyOutcome,
  type SiteToolPolicyRef,
} from "./deps";

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

// cinatra-ai/cinatra#2022 S7 — replace a WordPress instance's per-site tool
// selection (which of the site's own MCP tools Cinatra may call for it).
// `manage`-gated like every sibling action here, and gated a SECOND time
// host-side inside the setter (org-admin on the instance's OWNING org,
// resolved from the persisted row — never from this form). The form carries
// the instance id and ONE `policy` field: a JSON document of the FULL desired
// record `{mode, allow, deny}` — never a delta, so a stale card can never
// half-apply an edit on top of state it hasn't seen. Validation here is
// shape-strict and mirrors the host seam's own rules (unknown modes and
// malformed `{serverId, name}` entries are refused before any call), so a
// crafted form fails as a rendered refusal, not a crash — and the host seam
// re-validates regardless (defense in depth, connector input is never
// trusted).
const TOOL_POLICY_MAX_REFS_PER_LIST = 500;

function parseToolPolicyRefList(value: unknown): SiteToolPolicyRef[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > TOOL_POLICY_MAX_REFS_PER_LIST) return null;
  const refs: SiteToolPolicyRef[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const raw = entry as Record<string, unknown>;
    const serverId = typeof raw.serverId === "string" ? raw.serverId.trim() : "";
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!serverId || !name) return null;
    refs.push({ serverId, name });
  }
  return refs;
}

export async function setWordPressInstanceToolPolicyAction(
  formData: FormData,
): Promise<SetInstanceToolPolicyOutcome> {
  await requireExtensionAction(WORDPRESS_PACKAGE_ID, "manage");

  const instanceId = String(formData.get("instanceId") ?? "").trim();
  if (!instanceId) {
    // Typed outcome, not a throw (the remote-assist contract): every
    // post-authorization failure resolves a renderable result.
    return { ok: false, message: "Missing WordPress instance id." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(formData.get("policy") ?? ""));
  } catch {
    return { ok: false, message: "Invalid tool-selection payload." };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, message: "Invalid tool-selection payload." };
  }
  const record = parsed as Record<string, unknown>;
  const mode = record.mode;
  if (mode !== "open" && mode !== "restricted") {
    return { ok: false, message: "Invalid tool-selection mode." };
  }
  const allow = parseToolPolicyRefList(record.allow);
  const deny = parseToolPolicyRefList(record.deny);
  if (allow === null || deny === null) {
    return { ok: false, message: "Invalid tool entries in the tool selection." };
  }

  const deps = getWordPressDeps();
  if (typeof deps.setInstanceToolPolicy !== "function") {
    return {
      ok: false,
      message: "This Cinatra version does not support per-site tool selection.",
    };
  }

  try {
    const policy = await deps.setInstanceToolPolicy({
      instanceId,
      mode: mode as InstanceToolPolicyMode,
      ...(allow.length > 0 ? { allow } : {}),
      ...(deny.length > 0 ? { deny } : {}),
    });
    return { ok: true, policy };
  } catch {
    // The host refusal is deliberately opaque (no instance-existence oracle);
    // mirror that here — one honest, generic refusal message, no internals.
    return {
      ok: false,
      message:
        "Saving the tool selection was refused. You need to be an admin of the organization that owns this site.",
    };
  }
}
