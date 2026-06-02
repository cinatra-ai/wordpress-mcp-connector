// Settings-page consumers use
// `@cinatra-ai/wordpress-mcp-connector/settings-page` directly.
export { WordPressNangoConnectCard } from "./wordpress-nango-connect-card";
export { createWordPressModule } from "./mcp/module";
export { registerWordPressPrimitives } from "./mcp/registry";
export { createWordPressPrimitiveHandlers } from "./mcp/handlers";
export { createWordPressWidgetChatTool, type WordPressWidgetContext } from "./widget-chat-tool";


// DI host-coupling escape.
export { registerWordPressConnector } from "./deps";
export type { WordPressConnectorDeps, DispatchContentEditorInput } from "./deps";

// The connector's manage-gated instance-delete "use server" action, re-exported
// so the legacy host page (`src/app/connectors/wordpress/page.tsx`) imports it
// from this single connector entry alongside WordPressNangoConnectCard — keeping
// cinatra core's reference to this connector at ONE occurrence (IoC —
// core-extension instance-coupling gate) while sharing ONE manage-gated delete
// path with the dispatch-route settings page.
//
// BOUNDARY: this index mixes a "use client" component (WordPressNangoConnectCard)
// with a "use server" action re-export, which is sound ONLY because every
// consumer of this package root is a SERVER module today (verified; `next build`
// compiles). Do NOT import this package root from a "use client" file — that
// would pull the server action into a client bundle. Client code must import the
// card from its own module path, not the index.
export { deleteWordPressInstanceAction } from "./setup-actions";
