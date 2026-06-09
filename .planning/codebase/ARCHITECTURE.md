<!-- refreshed: 2026-06-09 -->
# Architecture

**Analysis Date:** 2026-06-09

## System Overview

```text
┌─────────────────────────────────────────────────────────────────────┐
│                    Host Application (Next.js)                        │
│  Imports connector as npm package                                    │
│  Provides: wordpress-api, A2A client, pagination, auth              │
└───────────┬────────────────────────┬────────────────────────────────┘
            │ DI via globalThis Symbol│ imports connector exports
            ▼                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│           @cinatra-ai/wordpress-mcp-connector (this package)         │
│                                                                      │
│  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────┐   │
│  │  MCP Layer      │  │  Widget Chat     │  │  UI Components   │   │
│  │  `src/mcp/`     │  │  `src/widget-    │  │  `src/settings-  │   │
│  │                 │  │   chat-tool.ts`  │  │   page.tsx`      │   │
│  │  registry.ts    │  │                  │  │  `src/wordpress- │   │
│  │  handlers.ts    │  │                  │  │  nango-connect-  │   │
│  │  module.ts      │  │                  │  │  card.tsx`       │   │
│  └────────┬────────┘  └────────┬─────────┘  └──────────────────┘   │
│           │                   │                                      │
│           └──────────┬────────┘                                      │
│                      ▼                                               │
│          ┌───────────────────────┐                                   │
│          │   DI Seam (deps.ts)   │                                   │
│          │   globalThis Symbol   │                                   │
│          └───────────────────────┘                                   │
└─────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────┐
│  External / Host-owned                                               │
│  @/lib/wordpress-api  (REST calls to self-hosted WP instances)       │
│  wayflow-wordpress-content-editor (A2A agent on port 3021)          │
│  Nango (OAuth credential broker)                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| MCP Registry | Registers all WordPress MCP tools on the server, maps tool name → schema + description | `src/mcp/registry.ts` |
| MCP Handlers | Implements tool handler logic: validates input (Zod), resolves instance, calls host API | `src/mcp/handlers.ts` |
| MCP Module | Thin factory wrapping registry — entry for the host's module system | `src/mcp/module.ts` |
| DI Seam | `globalThis`-Symbol-anchored singleton holding host-provided runtime deps | `src/deps.ts` |
| Widget Chat Tool | Builds the LLM function-tool for the in-CMS chat widget; enforces server-side identity pinning | `src/widget-chat-tool.ts` |
| Settings Page | Server component rendering the connector admin page (instances list, Nango connect card) | `src/settings-page.tsx` |
| Nango Connect Card | Client component for the Nango OAuth connection flow | `src/wordpress-nango-connect-card.tsx` |
| Setup Actions | "use server" action for instance hard-delete, gated by `requireExtensionAction` | `src/setup-actions.ts` |
| UI Primitives | Shared Radix/Tailwind UI components (badge, button, input, textarea) | `src/components/ui/` |

## Pattern Overview

**Overall:** Inversion-of-Control connector package

**Key Characteristics:**
- This package is a pure npm connector — it contains no runtime server and no `@/lib/*` host imports in production code paths.
- All host-specific APIs (wordpress-api, A2A client, pagination, auth) are injected at boot via `registerWordPressConnector(deps)` stored on a `globalThis` Symbol (`@cinatra-ai/wordpress-mcp-connector:host-deps/v1`).
- The MCP tool surface is a static list of named primitives; each handler is a function in `createWordPressPrimitiveHandlers()`.
- The `cinatra.mcp.json` manifest declares which primitives are exposed over the HTTP transport endpoint.

## Layers

**MCP Tool Layer:**
- Purpose: Define and serve WordPress MCP tools to the Cinatra agent runtime
- Location: `src/mcp/`
- Contains: Tool schemas (Zod), handler implementations, server registration
- Depends on: `src/deps.ts` (for pagination and A2A dispatch), `@/lib/wordpress-api` (host-provided at runtime via path alias)
- Used by: Cinatra host's MCP server boot path

**DI / Dependency Injection Layer:**
- Purpose: Decouple connector from host module graph across separately-compiled Next.js bundles
- Location: `src/deps.ts`
- Contains: `WordPressConnectorDeps` interface, `registerWordPressConnector`, `getWordPressDeps`, globalThis Symbol anchor
- Depends on: Nothing (pure TypeScript types + globalThis)
- Used by: `src/mcp/handlers.ts`, `src/setup-actions.ts`, `src/widget-chat-tool.ts`

**Widget Chat Tool Layer:**
- Purpose: Provide the in-CMS widget chat LLM function-tool with server-side identity pinning (security hardening T-190-01)
- Location: `src/widget-chat-tool.ts`
- Contains: `createWordPressWidgetChatTool`, `WordPressWidgetContext` type
- Depends on: `src/mcp/handlers.ts`
- Used by: Host's widget chat route

**UI Layer:**
- Purpose: React Server/Client components for connector administration
- Location: `src/settings-page.tsx`, `src/wordpress-nango-connect-card.tsx`, `src/components/ui/`
- Contains: Settings page, Nango connect card, primitive UI components
- Depends on: `@cinatra-ai/sdk-ui`, `@cinatra-ai/sdk-extensions`, Radix UI, Tailwind
- Used by: Host app's connector admin routes

**Server Actions Layer:**
- Purpose: "use server" admin operations gated behind permission checks
- Location: `src/setup-actions.ts`
- Contains: `deleteWordPressInstanceAction`
- Depends on: `@cinatra-ai/sdk-extensions` (`requireExtensionAction`), `src/deps.ts`
- Used by: Host's legacy connector page and settings page

## Data Flow

### MCP Tool Call (e.g., `wordpress_post_update`)

1. Cinatra agent runtime calls tool via HTTP MCP transport (`cinatra/mcp.json` → `${CINATRA_BASE_URL}/api/mcp`)
2. `registerWordPressPrimitives` in `src/mcp/registry.ts` dispatches to the named handler
3. Handler in `src/mcp/handlers.ts` validates input with Zod (`postUpdateSchema`)
4. Handler resolves WordPress instance via `listWordPressInstances()` (host `@/lib/wordpress-api`)
5. Handler calls the appropriate API function (`updateWordPressPost`) with the resolved instance
6. Result is JSON-serialized and returned as `ExtensionMcpToolResult` with `content` + `structuredContent`

### Widget Chat Edit Flow

1. User sends message in in-CMS WordPress sidebar widget
2. Host chat route provides `WordPressWidgetContext` (server-trusted `instanceId`, `postId`, `postType`, `postStatus`)
3. `createWordPressWidgetChatTool` builds LLM tool; schema exposes only `instructions` — identity fields are NOT LLM-controllable
4. LLM calls `wordpress_content_editor_run` with only `instructions`
5. `execute()` overrides identity from context and calls handler
6. Handler calls `getWordPressDeps().dispatchContentEditor(...)` → A2A HTTP call to wayflow-wordpress-content-editor agent (port 3021, or `WP_CONTENT_EDITOR_A2A_URL` env override)
7. Handler strips code fences and JSON-parses agent response; returns `{ postId, changes }` or `{ result: text }`

### Demote-Then-Edit Pattern (published posts)

1. `wordpress_content_editor_run` is called for a post with `postStatus: "publish"`
2. The A2A content-editor agent issues `wordpress_post_update` with `{ status: "draft", title, content }` in one call
3. This demotes the live post to draft and applies edits atomically
4. Previous live revision is preserved in WordPress's revision history

**State Management:**
- No in-process state. All persistent state is in WordPress (via REST API) and Nango (OAuth credentials). The `globalThis` DI slot is boot-time-written, read-only at runtime.

## Key Abstractions

**`WordPressConnectorDeps` interface:**
- Purpose: Contract between connector and host; the connector never imports host internals directly
- Location: `src/deps.ts`
- Pattern: Dependency injection via `globalThis` Symbol (versioned: `/v1`) to survive separate Next.js bundle compilation

**`createWordPressPrimitiveHandlers()` factory:**
- Purpose: Returns a `const` record mapping tool name → async handler function
- Location: `src/mcp/handlers.ts`
- Pattern: Each handler validates with Zod, resolves instance, calls host API, returns plain JS value

**Zod schemas (exported):**
- Purpose: Single source of truth for input validation across both MCP registry and widget chat tool
- Examples: `createDraftSchema`, `postUpdateSchema`, `contentEditorRunSchema` in `src/mcp/handlers.ts`
- Pattern: Schemas are exported and reused in `src/mcp/registry.ts` for `TOOL_META` and in `src/widget-chat-tool.ts`

**`cinatra/mcp.json` manifest:**
- Purpose: Declares which primitives are exposed over the HTTP MCP transport (subset — excludes `wordpress_content_editor_run` and `wordpress_post_update` from the transport manifest)
- Location: `cinatra/mcp.json`

## Entry Points

**Package root:**
- Location: `src/index.ts`
- Triggers: Host imports `@cinatra-ai/wordpress-mcp-connector`
- Responsibilities: Re-exports all connector public surfaces; mixes "use client" component with "use server" action re-export (safe only because all consumers are server modules)

**MCP module:**
- Location: `src/mcp/module.ts` → `createWordPressModule()`
- Triggers: Host's MCP server boot
- Responsibilities: Returns `{ registerCapabilities }` for the host's connector registry loop

**Settings page:**
- Location: `src/settings-page.tsx` → `WordPressSettingsPage`
- Triggers: Host renders connector admin route
- Responsibilities: Fetches instances + status, renders Nango connect card and instance list

## Architectural Constraints

- **Bundle boundary:** `src/index.ts` MUST NOT be imported from a "use client" file — it re-exports a "use server" action (`deleteWordPressInstanceAction`).
- **Host API access:** The connector MUST NOT import `@/lib/*` host modules directly. All host APIs are injected via `registerWordPressConnector(deps)`.
- **Global state:** One `globalThis` Symbol slot (`@cinatra-ai/wordpress-mcp-connector:host-deps/v1`) holds the DI singleton. Written once at boot, never mutated at runtime (tests use `_resetWordPressDepsForTests()`).
- **Circular imports:** None detected.
- **Security (T-190-01):** Widget chat tool forcibly overrides `instanceId` and `postId` from server context; LLM schema intentionally omits these fields to prevent prompt-injection identity substitution.
- **Threading:** Node.js event loop. No worker threads.

## Anti-Patterns

### Importing host path aliases directly in connector code

**What happens:** `src/mcp/handlers.ts` imports from `@/lib/wordpress-api` (a path alias) — this is the host's internal library.
**Why it's wrong:** It creates a hard coupling to the host's module graph, breaking when the connector is used outside that host or in a different bundle context.
**Do this instead:** Add `deleteInstance` and direct API calls to `WordPressConnectorDeps` and inject them via `registerWordPressConnector`, matching the pattern already used for `dispatchContentEditor` and `deleteInstance`.

### Importing `src/index.ts` from client components

**What happens:** `src/index.ts` re-exports `deleteWordPressInstanceAction` ("use server").
**Why it's wrong:** Importing this file from any "use client" module pulls the server action into the client bundle, causing a Next.js build error.
**Do this instead:** Client code must import the connect card directly from its module path (`src/wordpress-nango-connect-card`), not from the package root.

## Error Handling

**Strategy:** Throw `Error` with descriptive messages; no custom error classes.

**Patterns:**
- Instance not found: `throw new Error("WordPress instance not found.")`
- Empty meta: `throw new Error("No meta fields provided.")` / `"All submitted meta values were empty strings..."`
- Missing DI registration: `getWordPressDeps()` throws with actionable boot instruction
- A2A response parse failure: caught with try/catch; falls back to `{ result: text }`

## Cross-Cutting Concerns

**Logging:** Not detected — no logging framework in this package. The host is responsible for logging.
**Validation:** Zod schemas at every handler entry point; exported for reuse across MCP registry and widget chat.
**Authentication:** Delegated to host via `requireExtensionAction` (SDK action guard) for admin ops; WordPress credentials are resolved by host `@/lib/wordpress-api` via Nango.

---

*Architecture analysis: 2026-06-09*
