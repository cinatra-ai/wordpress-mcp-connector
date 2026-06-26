import "server-only";

// First-party WordPress external-MCP toolbox.
//
// Discovered through the generated extension manifest: the package declares
// `cinatra.providesExternalMcpToolbox: true` and the manifest generator records
// this module's factory as a slug-keyed loader entry, so the host's LLM
// toolbox-injection path resolves it WITHOUT importing this package by name.
//
// One MCP server tool per configured WordPress instance where the
// WordPress/mcp-adapter plugin is reachable. Instance settings, the cached
// reachability probe, and URL policy (private-URL skip + the query-string
// endpoint form that works without pretty permalinks) are host-bound through
// the connector deps — this module carries no `@/` or non-SDK `@cinatra-ai/*`
// import. The Basic auth header is built here from the instance's existing
// Application Password credentials (the same scheme the REST client uses).

import { Buffer } from "node:buffer";
import type {
  ExtensionExternalMcpTool,
  ExtensionExternalMcpToolbox,
} from "@cinatra-ai/sdk-extensions";
import { getWordPressDeps, type WordPressMcpInstance } from "../deps";

/** HTTP Basic auth header from a WP instance's Application Password creds. */
function buildBasicAuthHeader(instance: WordPressMcpInstance): string {
  const credentials = `${instance.username}:${instance.applicationPassword}`;
  const encoded = Buffer.from(credentials, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

/**
 * Minimal, connector-local structural view of the host-resolved actor (NEVER an
 * SDK import, NEVER LLM/tool input — the host resolves it trusted-side from the
 * active MCP request frame). The host's external-MCP injection paths do not yet
 * pass this (the SDK `buildTools(provider)` contract widening lands in a separate
 * host lane); this connector accepts it forward-compatibly so a
 * widened host can hand a superset without a further connector change.
 *
 * AUTH BOUNDARY (CWE-862/863): the absence of this arg is NOT authorization. Per-instance
 * authority is enforced below via the host-resolved `requireInstanceWriteAuthority`
 * gate regardless of whether this arg is present — so a non-widened host still
 * fails closed (no actor frame → the gate throws → the instance is dropped).
 */
type WordPressToolboxActor = {
  userId?: string;
  organizationId?: string;
};

export function createWordPressExternalMcpToolbox(): ExtensionExternalMcpToolbox {
  return {
    async buildTools(
      _provider: string,
      actor?: WordPressToolboxActor,
    ): Promise<ExtensionExternalMcpTool[]> {
      try {
        // Forward-compat: if a widened host DID pass an actor frame but it is
        // incomplete (no trusted user/org), fail closed — never emit creds.
        if (actor !== undefined && (!actor.userId || !actor.organizationId)) {
          return [];
        }

        const deps = getWordPressDeps();
        const instances = deps.listMcpInstances();
        if (!instances || instances.length === 0) return [];

        const tools: ExtensionExternalMcpTool[] = [];
        for (const instance of instances) {
          // Private/local URLs are reachable by Cinatra but not by external
          // LLM providers. Skip them here — they still show status badges in
          // the administration UI.
          if (deps.isPrivateUrl(instance.siteUrl)) {
            console.log(
              `[connector-wordpress-mcp] ${instance.siteUrl} is a private URL — skipping MCP tool injection (not reachable by LLM provider)`,
            );
            continue;
          }

          // AUTHORIZATION BOUNDARY (CWE-862/863). `listMcpInstances()` returns EVERY
          // configured instance org-wide; emitting a credentialed MCP server for
          // each one made another tenant's WordPress Application Password usable
          // through any chat path that injects external MCP tools (a connector
          // confused deputy). Gate EACH instance through the host-resolved
          // per-instance `use` authority (cinatra#409 machinery): the host
          // derives the trusted actor from the active MCP request frame
          // (mcpRequestContextStorage → resolveExtensionActorContext, NEVER tool
          // input) and THROWS unless that actor holds `use` on THIS instance.
          // FAIL CLOSED: no actor frame, cross-tenant instance, or any error all
          // throw → the instance is dropped before its creds are ever emitted.
          try {
            await deps.requireInstanceWriteAuthority({
              instanceId: instance.id,
              primitiveName: "wordpress_external_mcp_toolbox_inject",
            });
          } catch {
            console.log(
              `[connector-wordpress-mcp] actor not authorized to use instance ${instance.id} — skipping MCP tool injection`,
            );
            continue;
          }

          const status = await deps.probeMcpAdapter(instance);
          if (status !== "registered") {
            console.log(
              `[connector-wordpress-mcp] mcp-adapter status "${status}" for ${instance.siteUrl} — skipping`,
            );
            continue;
          }

          // The host resolves the query-string endpoint form since pretty
          // permalinks may not be enabled — it works in all WP configurations.
          tools.push({
            type: "mcp",
            serverLabel: `wordpress-${instance.id}`,
            serverUrl: deps.resolveMcpServerUrl(instance.siteUrl),
            headers: { Authorization: buildBasicAuthHeader(instance) },
            serverDescription: `WordPress site ${instance.name} (${instance.siteUrl}) — MCP adapter`,
            // Tool names are served by the external WordPress/mcp-adapter plugin
            // (not enumerable in this repo, version-dependent) so a static
            // name allowlist would be unauthoritative guesswork that could break
            // the authorized read path. Instead require approval for any
            // state-mutating (write) tool so writes are never auto-executed —
            // reads stay auto-approved.
            allowedTools: null,
            requireApproval: "read-only",
          });
        }
        return tools;
      } catch (err) {
        console.warn(
          "[connector-wordpress-mcp] external-MCP toolbox build failed — skipping injection",
          err instanceof Error ? err.message : String(err),
        );
        return [];
      }
    },
  };
}
