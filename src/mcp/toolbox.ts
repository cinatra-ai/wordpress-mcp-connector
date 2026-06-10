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

export function createWordPressExternalMcpToolbox(): ExtensionExternalMcpToolbox {
  return {
    async buildTools(_provider: string): Promise<ExtensionExternalMcpTool[]> {
      try {
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
            allowedTools: null,
            requireApproval: "never",
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
