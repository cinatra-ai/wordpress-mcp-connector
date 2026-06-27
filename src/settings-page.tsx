import Link from "next/link";
import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Input } from "./components/ui/input";
import { Main, PageHeader, PageContent } from "@cinatra-ai/sdk-ui/marketplace";
// Instance/status reads come from the host-bound deps slot (the extended
// `@cinatra-ai/host:wordpress-mcp` service) — no `@/lib/wordpress-api` import
// (cinatra#172 Stage H3).
import { getWordPressDeps, listInstancesSorted } from "./deps";
import { deleteWordPressInstanceAction } from "./setup-actions";
import { WordPressNangoConnectCard } from "./wordpress-nango-connect-card";

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
  const status = getWordPressDeps().getApiStatus();
  const nangoFrontendConfig = (await ctx.nango.getFrontendConfig?.()) ?? {};
  const nangoStatus = (await ctx.nango.getStatus?.()) ?? { status: "not_connected" as const };

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="WordPress MCP"
        description="Connect one or more self-hosted WordPress instances so Cinatra can create formatted blog post drafts directly in each site's admin area."
        actions={
          <Badge variant={status.status === "connected" ? "default" : "secondary"}>
            {status.status === "connected" ? `${instances.length} connected` : "Setup required"}
          </Badge>
        }
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <WordPressNangoConnectCard
          nangoFrontendConfig={nangoFrontendConfig}
          connectionServiceReady={nangoStatus.status === "connected"}
        />

        <div className="grid gap-4">
          {instances.length === 0 ? (
            <div className="soft-panel rounded-card border border-dashed border-line px-5 py-5 text-sm text-muted-foreground">
              No WordPress instances configured yet.
            </div>
          ) : (
            instances.map((instance) => (
              <article key={instance.id} className="soft-panel rounded-card px-5 py-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h3 className="text-lg font-semibold text-foreground">{instance.name}</h3>
                    <p className="mt-2 text-sm text-muted-foreground">{instance.siteUrl}</p>
                    <p className="mt-1 text-xs uppercase tracking-[0.2em] text-muted-foreground">Username: {instance.username}</p>
                  </div>
                  <div className="flex flex-wrap gap-3">
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
                        Remove
                      </Button>
                    </form>
                  </div>
                </div>
              </article>
            ))
          )}
        </div>
      </PageContent>
    </Main>
  );
}
