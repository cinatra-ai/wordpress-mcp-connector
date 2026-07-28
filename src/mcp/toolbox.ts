import "server-only";

// First-party WordPress external-MCP toolbox.
//
// Discovered through the generated extension manifest: the package declares
// `cinatra.providesExternalMcpToolbox: true` and the manifest generator records
// this module's factory as a slug-keyed loader entry, so the host's LLM
// toolbox-injection path resolves it WITHOUT importing this package by name.
//
// TRUSTED-SITE MODE (cinatra#2019 S4) — this module is the real per-instance
// opt-in gate that replaces the S0 hard default-off guard (cinatra#2015). The
// flip is CONJUNCTIVE and fail-closed at every layer; an entry is emitted for
// an instance only when ALL of the following hold, in order:
//
//   1. The host passed a build context and `context.surface === "chat"` —
//      agent runs, the public-site widget principal, session assembly, an
//      unknown surface, and an ABSENT context (a host that predates the SDK
//      `buildTools(provider, context?)` widening) all emit NOTHING. When the
//      context carries a `connectorInstancePin`, only the pinned instance is
//      ever considered (a pure narrowing filter — it can only shrink).
//   2. The existing per-instance boundary gates pass, unchanged from the
//      pre-flip construction: private/local URLs are skipped, the
//      host-resolved per-instance `use` authority allows THIS actor on THIS
//      instance (throw → skip), and the cached mcp-adapter probe reports
//      `registered`.
//   3. The HOST grants injection for the instance:
//      `deps.buildNativeReadInjection({instanceId, surface})` resolves a
//      non-null `{serverId, allowedTools}`. The host owns the entire trust
//      computation (opt-in row + consent-stamp exactness, ambient-actor
//      authority, enrolled-catalog snapshots, duplicate-anywhere rule,
//      descriptor/fingerprint verification, the surface re-refusal) — none of
//      it crosses to the connector. An unbound member (a deps binding or host
//      that predates S4), a null grant, a non-default `serverId` (v1 injects
//      the default adapter server ONLY), and a malformed/empty `allowedTools`
//      list all skip the instance. The governed invoker path (M1) is never
//      affected — this gate can only ADD a narrowed read surface, never hide
//      a tool.
//
// On today's pinned community stack the host's descriptor-verified set is
// EMPTY by capture (the default adapter server is triad-only), so even a
// fully opted-in instance emits nothing — the machinery ships dark and the
// first real emission requires a future, capture-gated descriptor-population
// change host-side.
//
// Instance settings, the cached reachability probe, URL policy (private-URL
// skip + the query-string endpoint form that works without pretty permalinks),
// and the injection decision are host-bound through the connector deps — this
// module carries no `@/` or non-SDK `@cinatra-ai/*` import. The Basic auth
// header is built here from the instance's existing Application Password
// credentials (the same scheme the REST client uses).

import { Buffer } from "node:buffer";
import type {
  ExtensionExternalMcpTool,
  ExtensionExternalMcpToolbox,
  ExtensionToolboxBuildContext,
} from "@cinatra-ai/sdk-extensions";
import {
  getWordPressDeps,
  type NativeReadInjectionBuildResult,
  type WordPressMcpInstance,
} from "../deps";

/** HTTP Basic auth header from a WP instance's Application Password creds. */
function buildBasicAuthHeader(instance: WordPressMcpInstance): string {
  const credentials = `${instance.username}:${instance.applicationPassword}`;
  const encoded = Buffer.from(credentials, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

/**
 * Connector-side pin of the host catalog's DEFAULT adapter-server id (the
 * host's `CATALOG_DEFAULT_SERVER_ID`, cinatra#2018 S3). A cross-repo literal
 * by design: the host verifies against — and grants for — exactly this id,
 * and v1 of trusted-site mode emits for it ONLY.
 */
export const WORDPRESS_DEFAULT_CATALOG_SERVER_ID = "mcp-adapter-default";

/** The host's enrolled-server id prefix (`SERVER_ID_PREFIX`, cinatra#2018 S3):
 * every non-default enrolled server id is `wps-` + a stable 16-hex digest
 * chunk — never an ordinal — so label suffixes derived from it are
 * reproducible across environments and enrollment order. */
const ENROLLED_SERVER_ID_PREFIX = "wps-";

/**
 * The connector key this connector's instances live under host-side (the
 * host maps the static kind "wordpress" to the package id itself — see the
 * write-authority deps note). Used ONLY to match a host-built
 * `connectorInstancePin` against this connector; never sent anywhere.
 */
const WORDPRESS_CONNECTOR_KEY = "wordpress";

/**
 * Immutable toolbox server naming (pinned, cinatra#2015; extended #2019 S4).
 * The DEFAULT adapter server keeps the byte-exact grandfathered label
 * `wordpress-${instance.id}` — later gateway slices key channel governance
 * (per-instance authority, audit, destructive confirmation) on this label, so
 * renaming it orphans that governance; the format is pinned by test and never
 * derived elsewhere. A non-default enrolled server (never emitted by v1 —
 * the rule ships unit-pinned for the day one is authorized) appends a stable
 * per-server suffix derived from the host's opaque enrolled-server id:
 * `wordpress-${instanceId}--s-${serverId minus the "wps-" prefix}`.
 */
export function wordpressToolboxServerLabel(instanceId: string, serverId?: string): string {
  if (serverId === undefined || serverId === WORDPRESS_DEFAULT_CATALOG_SERVER_ID) {
    return `wordpress-${instanceId}`;
  }
  const suffix = serverId.startsWith(ENROLLED_SERVER_ID_PREFIX)
    ? serverId.slice(ENROLLED_SERVER_ID_PREFIX.length)
    : serverId;
  return `wordpress-${instanceId}--s-${suffix}`;
}

export function createWordPressExternalMcpToolbox(): ExtensionExternalMcpToolbox {
  return {
    async buildTools(_provider, context): Promise<ExtensionExternalMcpTool[]> {
      return buildTrustedSiteTools(context);
    },
  };
}

/**
 * The trusted-site-mode construction behind `buildTools` (absorbs the former
 * test-only `buildTrustedSiteToolSet`; every pre-flip boundary behavior is
 * preserved unchanged — see the inline AUTH BOUNDARY notes).
 */
async function buildTrustedSiteTools(
  context?: ExtensionToolboxBuildContext,
): Promise<ExtensionExternalMcpTool[]> {
  try {
    // SURFACE GATE (cinatra#2019 D5) — before ANY per-instance work. Only the
    // workspace-chat surface may emit; an absent context means the host (or
    // call site) predates the SDK context widening and MUST stay dark — the
    // pre-S4 behavior. The host member below re-refuses non-"chat" surfaces
    // independently, so a bug in either layer alone cannot widen the matrix.
    if (!context || context.surface !== "chat") {
      return [];
    }

    const deps = getWordPressDeps();

    // Skew gate, layer 1: a deps binding that predates the S4 surface (an
    // old host's STATIC transport binding, or a partial test stub) lacks
    // this member entirely — no grant can exist, so return before the
    // per-instance loop (no authority/probe side effects for nothing).
    // Layer 2 lives host-side: the connector's own register.ts ALWAYS binds
    // a lazy wrapper, so on a newer host that merely predates the HOST
    // member the loop below still runs and every per-instance decision
    // resolves null — same zero emission, one audited authority pass per
    // instance (the register suite pins that wrapper skew path).
    if (typeof deps.buildNativeReadInjection !== "function") {
      return [];
    }

    const instances = deps.listMcpInstances();
    if (!instances || instances.length === 0) return [];

    // Run-pin narrowing (cinatra#2019 D4): a pin restricts consideration to
    // exactly the pinned instance — a pin for another connector matches
    // nothing. Purely subtractive; it can never add or widen.
    const pin = context.connectorInstancePin;

    const tools: ExtensionExternalMcpTool[] = [];
    for (const instance of instances) {
      if (pin && (pin.connectorKey !== WORDPRESS_CONNECTOR_KEY || pin.instanceId !== instance.id)) {
        continue;
      }

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
      // derives the trusted actor from its ambient trusted stores (NEVER tool
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

      // THE S4 GATE: ask the host for this instance's injection grant. Only
      // instances that survived every boundary gate above reach this call,
      // and the call carries ONLY non-identity coordinates. Null/throw →
      // skip (mode off, consent stale, empty verified set, unverifiable
      // catalog — the connector never learns which; M1 stays available).
      let grant: NativeReadInjectionBuildResult | null;
      try {
        grant = await deps.buildNativeReadInjection({
          instanceId: instance.id,
          surface: context.surface,
        });
      } catch (err) {
        console.warn(
          `[connector-wordpress-mcp] native read-injection decision failed for instance ${instance.id} — skipping`,
          err instanceof Error ? err.message : String(err),
        );
        continue;
      }
      if (!grant) continue;

      // v1 emits for the DEFAULT adapter server only: the endpoint resolver
      // below builds the default server's URL, so a grant for any other
      // enrolled server cannot be routed yet — skip it fail-closed (the
      // label suffix rule already ships for the day this is authorized).
      if (grant.serverId !== WORDPRESS_DEFAULT_CATALOG_SERVER_ID) {
        console.warn(
          `[connector-wordpress-mcp] native read-injection grant for non-default server "${grant.serverId}" on instance ${instance.id} — v1 injects the default adapter server only, skipping`,
        );
        continue;
      }

      // A grant's allowedTools is a NON-EMPTY exact name list by contract
      // (the host returns null instead of an empty grant). Re-verify here so
      // an entry with a null/empty/malformed allowlist is unrepresentable
      // from this side too — `allowedTools: null` (= the full site catalog)
      // must never be emittable again.
      if (
        !Array.isArray(grant.allowedTools) ||
        grant.allowedTools.length === 0 ||
        grant.allowedTools.some((name) => typeof name !== "string" || name.length === 0)
      ) {
        console.warn(
          `[connector-wordpress-mcp] malformed native read-injection allowlist for instance ${instance.id} — skipping`,
        );
        continue;
      }

      // The host resolves the query-string endpoint form since pretty
      // permalinks may not be enabled — it works in all WP configurations.
      tools.push({
        type: "mcp",
        serverLabel: wordpressToolboxServerLabel(instance.id, grant.serverId),
        serverUrl: deps.resolveMcpServerUrl(instance.siteUrl),
        headers: { Authorization: buildBasicAuthHeader(instance) },
        serverDescription: `WordPress site ${instance.name} (${instance.siteUrl}) — MCP adapter`,
        // The gateway governs the CHANNEL, never the catalog (cinatra#2013):
        // the site's full catalog stays listable through the governed invoker
        // (M1). What reaches the model provider natively is EXACTLY the
        // host-verified trusted-READ allowlist — reads auto-execute under the
        // current approval vocabulary. Writes never travel this path: they go
        // through the governed invoker with its own audit and destructive
        // confirmation.
        allowedTools: [...grant.allowedTools],
        approval: "auto_execute",
        // The mcp-adapter speaks Streamable HTTP — declare it so the host
        // injection layer never has to treat this server as "unknown".
        transport: "streamable-http",
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
}
