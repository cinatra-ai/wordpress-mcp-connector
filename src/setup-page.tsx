// Dispatch-route entry.
import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";
import { WordPressSettingsPage } from "./settings-page";

type ConnectorSetupPageProps = {
  packageId: string;
  slug: string;
  searchParams: Record<string, string | string[] | undefined>;
  // The dispatch route builds the grant-aware host ctx and passes it; the
  // settings page reads Nango via `ctx.nango.*` (host-port inversion).
  ctx: ExtensionHostContext;
};

export default async function WordPressConnectorSetupPage({
  searchParams,
  ctx,
}: ConnectorSetupPageProps) {
  return WordPressSettingsPage({ searchParams: Promise.resolve(searchParams), ctx });
}
