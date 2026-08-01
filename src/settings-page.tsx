import Link from "next/link";
import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
// The connector setup PAGE shell — renders the page header AND content in the
// SAME centered Wide column (max-w-3xl · 768px), so the header's left edge
// aligns with the content frame (app-connectors.html §II).
import { ConnectorSetupPage } from "@cinatra-ai/sdk-ui/connector-setup-page";
// The shared two-column Setup body — wider left = configuration fields,
// narrower right = the connection(s) status card (§II).
import { ConnectorSetupColumns } from "@cinatra-ai/sdk-ui/connector-setup-columns";
// Shared design-system Tabs primitive (cinatra-ai/cinatra#1103) — own subpath
// only, deliberately NOT re-exported from `/marketplace` (route-graph
// ratchet). TabsListRow pairs the tablist with the etched section rule so the
// composition is never hand-rolled.
import { Tabs, TabsListRow, TabsTrigger, TabsContent } from "@cinatra-ai/sdk-ui/tabs";
import { Badge } from "./components/ui/badge";
// Instance/status reads come from the host-bound deps slot (the extended
// `@cinatra-ai/host:wordpress-mcp` service) — no `@/lib/wordpress-api` import
// (cinatra#172 Stage H3).
import {
  getWordPressDeps,
  listInstancesSorted,
  type ConnectedSiteMetadata,
  type InstanceToolPolicyView,
  type NativeReadInjectionExplain,
  type NativeReadInjectionPolicyView,
  type SiteServerHealthRow,
  type WordPressMcpInstance,
} from "./deps";
import { deleteWordPressInstanceAction } from "./setup-actions";
import { WordPressNangoConnectCard } from "./wordpress-nango-connect-card";
import { WordPressTrustedSiteCard } from "./wordpress-trusted-site-card";
import { WordPressLeastPrivilegeCard } from "./wordpress-least-privilege-card";
import { WordPressRemoteAssistInstallCard } from "./wordpress-remote-assist-install-card";
import { WordPressSiteToolsCard } from "./wordpress-site-tools-card";
// This page is a SERVER component. `deriveSiteConnectionBadge` MUST come from
// the directive-free health module, never from the `"use client"` card: under
// RSC every export of a client module is a client reference, so calling one
// here throws at render and the whole Connections tab shows the error
// boundary. Pinned by settings-page-boundary.test.ts.
import { deriveSiteConnectionBadge } from "./wordpress-site-tools-health";

// Per-instance trusted-site opt-in state resolved server-side for the settings
// card (cinatra#2019). `policy === null` ⇒ the host does not expose the surface;
// `explain === null` ⇒ it exposes the opt-in but not the dry-run preview. Reads
// are best-effort: any error (an older host, or the host-side org-admin gate on
// the preview) degrades to null so the settings page never crashes.
type TrustedSiteState = {
  policy: NativeReadInjectionPolicyView | null;
  explain: NativeReadInjectionExplain | null;
};

async function loadTrustedSiteState(
  instances: WordPressMcpInstance[],
): Promise<Map<string, TrustedSiteState>> {
  const deps = getWordPressDeps();
  const entries = await Promise.all(
    instances.map(async (instance): Promise<[string, TrustedSiteState]> => {
      let policy: NativeReadInjectionPolicyView | null = null;
      let explain: NativeReadInjectionExplain | null = null;
      try {
        policy = (await deps.readNativeInjectionPolicy?.(instance.id)) ?? null;
      } catch {
        policy = null;
      }
      try {
        explain = (await deps.explainNativeReadInjection?.({ instanceId: instance.id })) ?? null;
      } catch {
        explain = null;
      }
      return [instance.id, { policy, explain }];
    }),
  );
  return new Map(entries);
}

// Per-instance connected-site metadata resolved server-side for the
// least-privilege warning card (cinatra#2021 S6). UNLIKE `loadTrustedSiteState`
// above, this never resolves to a null/missing entry for an instance — the
// tri-state itself models "no signal" as `{status:"unknown", reason:...}`, so
// an unexpected error here degrades to that SAME honest-unknown shape (never
// to an absent map entry the card could render as nothing).
async function loadSiteMetadataState(
  instances: WordPressMcpInstance[],
): Promise<Map<string, ConnectedSiteMetadata>> {
  const deps = getWordPressDeps();
  const entries = await Promise.all(
    instances.map(async (instance): Promise<[string, ConnectedSiteMetadata]> => {
      let metadata: ConnectedSiteMetadata;
      try {
        metadata = (await deps.resolveConnectedSiteMetadata?.(instance.id)) ?? {
          status: "unknown",
          reason: "no_inventory",
        };
      } catch {
        metadata = { status: "unknown", reason: "no_inventory" };
      }
      return [instance.id, metadata];
    }),
  );
  return new Map(entries);
}

// Per-instance tool-access state for the "Site tools & access" card
// (cinatra-ai/cinatra#2022 S7): the persisted tool policy (the record the
// governed invoker enforces — since cinatra#2232 an instance without one has
// NOTHING allowed on any surface) and the discovered-server health matrix.
// Best-effort like `loadTrustedSiteState`: an older host (either member
// unbound / resolving null) or a host-side refusal degrades to null and the
// card renders that state explicitly — the settings page never crashes.
type ToolAccessState = {
  policy: InstanceToolPolicyView | null;
  servers: SiteServerHealthRow[] | null;
};

async function loadToolAccessState(
  instances: WordPressMcpInstance[],
): Promise<Map<string, ToolAccessState>> {
  const deps = getWordPressDeps();
  const entries = await Promise.all(
    instances.map(async (instance): Promise<[string, ToolAccessState]> => {
      let policy: InstanceToolPolicyView | null = null;
      let servers: SiteServerHealthRow[] | null = null;
      try {
        policy = (await deps.readInstanceToolPolicy?.({ instanceId: instance.id })) ?? null;
      } catch {
        policy = null;
      }
      try {
        servers = (await deps.listInstanceServers?.(instance.id)) ?? null;
      } catch {
        servers = null;
      }
      return [instance.id, { policy, servers }];
    }),
  );
  return new Map(entries);
}

// Nango frontend config + connection-service status are read from the injected
// host port `ctx.nango.*` (host-port inversion), so the connector carries no
// `@cinatra-ai/nango-connector` import. The host builds the grant-aware ctx and
// passes it (the dispatch route + the legacy plugins-registry mount both do).
export async function WordPressSettingsPage(props: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
  ctx: ExtensionHostContext;
}) {
  const { ctx } = props;
  const instances = listInstancesSorted();
  const nangoFrontendConfig = (await ctx.nango.getFrontendConfig?.()) ?? {};
  const nangoStatus = (await ctx.nango.getStatus?.()) ?? { status: "not_connected" as const };
  const trustedSite = await loadTrustedSiteState(instances);
  const siteMetadata = await loadSiteMetadataState(instances);
  const toolAccess = await loadToolAccessState(instances);
  // cinatra#2021 S6/delta — remote-assist catalog-plugin install. Skew-safe:
  // a connector build that predates the deps member renders the card's
  // explicit "not available" state rather than a button that would only
  // ever fail when clicked.
  const remoteAssistAvailable = typeof getWordPressDeps().installCatalogPluginRemote === "function";

  return (
    // Standard connector-setup PAGE chrome. This is a MULTI connection
    // connector — each WordPress site is its own Nango connection — so per
    // §II "Multiple connections" the connection state lives in the Setup
    // tab's "Connections status" card + the Connections tab, not a single
    // header badge. `divider={false}` — the section rule is the tab row's
    // etched rule.
    <ConnectorSetupPage
      title="WordPress MCP"
      description="Connect one or more self-hosted WordPress instances so Cinatra can create formatted blog post drafts directly in each site's admin area."
      divider={false}
      className="flex flex-col gap-6 pb-8"
    >
      <Tabs defaultValue="setup" className="w-full">
        <TabsListRow aria-label="WordPress MCP connector setup">
          <TabsTrigger value="setup">Setup</TabsTrigger>
          <TabsTrigger value="connections">Connections</TabsTrigger>
          {/* Help is RESERVED and ALWAYS LAST (§II). */}
          <TabsTrigger value="help">Help</TabsTrigger>
        </TabsListRow>

        {/* SETUP — the multi-connection two-column body. Stays Wide. The left
            column ADDS a connection (no per-row Disconnect here — that lives
            on the Connections tab, per §II "the form is never wrapped in its
            own card … the form adds a connection rather than editing the
            one"). */}
        <TabsContent value="setup" forceMount className="mt-6 data-[state=inactive]:hidden">
          <ConnectorSetupColumns
            conformanceId="connector-multi-setup"
            state="ready"
            fields={
              <div className="flex flex-col gap-6">
                <WordPressNangoConnectCard
                  nangoFrontendConfig={nangoFrontendConfig}
                  connectionServiceReady={nangoStatus.status === "connected"}
                />
              </div>
            }
            aside={
              // Connections status card (§II "Multiple connections"): ONE
              // count badge per status in play (only "Connected" applies here
              // — a configured instance has no separately-tracked
              // "Disconnected" state), no Check.
              <div className="soft-panel rounded-panel px-4 py-4">
                <p className="border-b border-line pb-2.5 text-[13px] font-semibold text-foreground">
                  Connections status
                </p>
                <div className="mt-3.5 flex flex-wrap gap-2">
                  {instances.length > 0 ? (
                    <Badge variant="success">{instances.length} Connected</Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">No connections yet.</span>
                  )}
                </div>
                <p className="mt-3.5 text-xs text-muted-foreground">
                  See the <span className="font-medium text-foreground">Connections</span> tab for the full list.
                </p>
              </div>
            }
          />
        </TabsContent>

        {/* CONNECTIONS — every configured site stacked as its own card (§II
            "Multiple connections" · Connections tab). This is the structural
            multi-connection tab (not a custom configuration tab), so it stays
            at the Wide column like Setup — the Narrow width is for Help and
            other custom config tabs (codex convergence, PR #70). */}
        <TabsContent value="connections" forceMount className="mt-6 w-full data-[state=inactive]:hidden">
          <WordPressConnectionsSection
            instances={instances}
            trustedSite={trustedSite}
            siteMetadata={siteMetadata}
            toolAccess={toolAccess}
            remoteAssistAvailable={remoteAssistAvailable}
          />
        </TabsContent>

        {/* Help — reserved, always LAST, read-only (no form, no Save): the
            setup how-to narrowed to the §II Narrow content width, flush-left
            beneath the tabs. */}
        <TabsContent value="help" forceMount className="mt-6 w-full max-w-xl data-[state=inactive]:hidden">
          <section className="flex w-full flex-col gap-3">
            <h2 className="text-base font-semibold text-foreground">Setup instructions</h2>
            <ol className="ml-5 mt-3 list-decimal text-sm text-muted-foreground [&>li+li]:mt-2">
              <li>
                Install the <code>wordpress/mcp-adapter</code> plugin on each self-hosted WordPress
                site you want to connect.
              </li>
              <li>
                In WordPress, go to Users &gt; Profile &gt; Application Passwords and generate a new
                application password for the admin account Cinatra should use.
              </li>
              <li>
                On the <strong>Setup</strong> tab, enter the site&apos;s domain and click{" "}
                <strong>Connect site</strong>, then provide the WordPress username and the application
                password in the connection flow.
              </li>
              <li>
                Once connected, the site appears on the <strong>Connections</strong> tab and becomes
                available to Cinatra agents for reading posts and creating drafts.
              </li>
              <li>
                Sites on a private or local URL stay visible here but are skipped from the external
                MCP toolbox — use a public URL or a tunnel to make them reachable by agents.
              </li>
            </ol>
          </section>
        </TabsContent>
      </Tabs>
    </ConnectorSetupPage>
  );
}

function WordPressConnectionsSection({
  instances,
  trustedSite,
  siteMetadata,
  toolAccess,
  remoteAssistAvailable,
}: {
  instances: WordPressMcpInstance[];
  trustedSite: Map<string, TrustedSiteState>;
  siteMetadata: Map<string, ConnectedSiteMetadata>;
  toolAccess: Map<string, ToolAccessState>;
  remoteAssistAvailable: boolean;
}) {
  return (
    // Card-less tab frame (§II "the form is never wrapped in its own card");
    // each connection keeps its own stacked record card.
    <section className="flex flex-col gap-4">
      {instances.length === 0 ? (
        <div className="soft-panel rounded-card border border-dashed border-line px-5 py-5 text-sm text-muted-foreground">
          No WordPress instances configured yet. Add one from the Setup tab.
        </div>
      ) : (
        <div className="grid gap-4">
          {instances.map((instance) => {
            const access = toolAccess.get(instance.id) ?? { policy: null, servers: null };
            // cinatra-ai/cinatra#2022 S7 — the header badge derives from the
            // site's real per-server probe health (the old static "Connected"
            // text survives only on hosts that expose no health surface).
            const connectionBadge = deriveSiteConnectionBadge(access.servers);
            return (
            <article
              key={instance.id}
              className="rounded-card border border-line bg-surface px-5 py-5 shadow-[0_1px_3px_rgba(21,33,58,0.06)]"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[15px] font-bold text-foreground">{instance.name}</h3>
                    <Badge variant={connectionBadge.variant}>{connectionBadge.label}</Badge>
                  </div>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{instance.siteUrl}</p>
                  <p className="mt-1 text-xs uppercase tracking-[0.2em] text-muted-foreground">
                    Username: {instance.username}
                  </p>
                </div>
                <div className="flex flex-none flex-wrap gap-3">
                  <Button asChild variant="outline">
                    <Link href={`${instance.siteUrl}/wp-admin/`} target="_blank" rel="noreferrer">
                      Open admin
                    </Link>
                  </Button>
                  <form action={deleteWordPressInstanceAction}>
                    <Input type="hidden" name="instanceId" value={instance.id} />
                    <Button
                      type="submit"
                      formNoValidate
                      variant="outline"
                      className="border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15"
                    >
                      Disconnect
                    </Button>
                  </form>
                </div>
              </div>
              <WordPressLeastPrivilegeCard
                metadata={
                  siteMetadata.get(instance.id) ?? { status: "unknown", reason: "no_inventory" }
                }
              />
              <WordPressTrustedSiteCard
                instanceId={instance.id}
                instanceName={instance.name}
                policy={trustedSite.get(instance.id)?.policy ?? null}
                explain={trustedSite.get(instance.id)?.explain ?? null}
              />
              {/* cinatra-ai/cinatra#2022 S7 — discovered servers + health,
                  per-pipeline readiness, and the per-site tool selection (the
                  self-service re-enable path after the cinatra#2232 default
                  flip). Renders after the warning/disclosure cards, before
                  the remote-assist action card. */}
              <WordPressSiteToolsCard
                instanceId={instance.id}
                instanceName={instance.name}
                policy={access.policy}
                servers={access.servers}
              />
              {/* cinatra#2021 S6/delta — a SEPARATE card from the
                  least-privilege and trusted-site cards above (own file, own
                  state, own server action); the action card renders last so
                  the disclosure/warning surfaces always read before it. */}
              <WordPressRemoteAssistInstallCard
                instanceId={instance.id}
                available={remoteAssistAvailable}
              />
            </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
