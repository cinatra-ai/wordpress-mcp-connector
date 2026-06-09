# Codebase Structure

**Analysis Date:** 2026-06-09

## Directory Layout

```
wordpress-mcp-connector/
├── cinatra/                  # Cinatra platform manifests
│   ├── mcp.json              # MCP transport config + primitive list
│   └── plugin.json           # Plugin metadata
├── skills/                   # Agent skill definitions
│   └── wordpress-widget-chat/
│       └── SKILL.md          # System prompt for in-CMS widget chat agent
├── src/                      # All TypeScript source
│   ├── __tests__/            # Vitest test files
│   │   ├── content-editor-run.test.ts
│   │   ├── handlers.test.ts
│   │   └── widget-chat-tool.test.ts
│   ├── components/           # Shared UI primitives
│   │   └── ui/
│   │       ├── badge.tsx
│   │       ├── button.tsx
│   │       ├── input-group.tsx
│   │       ├── input.tsx
│   │       └── textarea.tsx
│   ├── mcp/                  # MCP tool layer
│   │   ├── handlers.ts       # Tool handler implementations + Zod schemas
│   │   ├── module.ts         # Module factory (createWordPressModule)
│   │   └── registry.ts       # Tool registration + TOOL_META descriptions
│   ├── deps.ts               # DI seam (globalThis Symbol, WordPressConnectorDeps)
│   ├── index.ts              # Package entry point (re-exports)
│   ├── lib/
│   │   └── utils.ts          # cn() Tailwind class utility
│   ├── settings-page.tsx     # Server component: connector admin UI
│   ├── setup-actions.ts      # "use server" delete action
│   ├── widget-chat-tool.ts   # LLM function-tool for in-CMS widget
│   └── wordpress-nango-connect-card.tsx  # Client component: Nango OAuth flow
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── release.yml
├── .npmrc
├── AGENTS.md                 # Connector-level agent guidance
├── LICENSE
├── README.md
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Directory Purposes

**`src/mcp/`:**
- Purpose: All MCP protocol logic — tool schemas, handlers, and server registration
- Contains: `handlers.ts` (core logic, Zod schemas), `registry.ts` (tool metadata + `server.registerTool` calls), `module.ts` (factory shim)
- Key files: `src/mcp/handlers.ts`, `src/mcp/registry.ts`

**`src/components/ui/`:**
- Purpose: Shared Radix UI + Tailwind component primitives used by the settings page and connect card
- Contains: badge, button, input, input-group, textarea components
- Key files: `src/components/ui/button.tsx`, `src/components/ui/badge.tsx`

**`src/__tests__/`:**
- Purpose: Vitest unit tests for handlers and widget chat tool
- Contains: co-located test files — one per primary module
- Key files: `src/__tests__/handlers.test.ts`, `src/__tests__/widget-chat-tool.test.ts`, `src/__tests__/content-editor-run.test.ts`

**`cinatra/`:**
- Purpose: Platform manifest files consumed by the Cinatra host
- Contains: `mcp.json` (HTTP transport base URL + primitive name list), `plugin.json` (connector metadata)
- Key files: `cinatra/mcp.json`

**`skills/`:**
- Purpose: Agent skill definitions (system prompts) packaged with the connector
- Contains: `wordpress-widget-chat/SKILL.md` — the agent prompt for the in-CMS sidebar chat widget

## Key File Locations

**Entry Points:**
- `src/index.ts`: Package root; re-exports all public surfaces (components, MCP factories, DI registration, server action)
- `src/mcp/module.ts`: `createWordPressModule()` — used by host's MCP server boot

**Configuration:**
- `cinatra/mcp.json`: MCP HTTP transport config and primitive whitelist
- `tsconfig.json`: TypeScript config
- `vitest.config.ts`: Test runner config
- `package.json`: Package metadata, cinatra connector manifest (`cinatra` field)

**Core Logic:**
- `src/mcp/handlers.ts`: All MCP tool handler functions and Zod input schemas
- `src/mcp/registry.ts`: Tool registration loop + human-readable tool descriptions (`TOOL_META`)
- `src/deps.ts`: DI singleton — the architectural boundary between connector and host

**UI / Admin:**
- `src/settings-page.tsx`: `WordPressSettingsPage` server component
- `src/wordpress-nango-connect-card.tsx`: `WordPressNangoConnectCard` client component
- `src/setup-actions.ts`: `deleteWordPressInstanceAction` ("use server")

**Widget Chat:**
- `src/widget-chat-tool.ts`: `createWordPressWidgetChatTool` — builds the LLM function-tool with identity pinning
- `skills/wordpress-widget-chat/SKILL.md`: System prompt governing when to call vs. converse

**Testing:**
- `src/__tests__/handlers.test.ts`: MCP handler unit tests
- `src/__tests__/widget-chat-tool.test.ts`: Widget chat tool unit tests
- `src/__tests__/content-editor-run.test.ts`: `wordpress_content_editor_run` handler tests

## Naming Conventions

**Files:**
- kebab-case for all source files: `widget-chat-tool.ts`, `wordpress-nango-connect-card.tsx`, `setup-actions.ts`
- Test files mirror the module under test with `.test.ts` suffix, placed in `src/__tests__/`

**Directories:**
- kebab-case: `wordpress-widget-chat/`, `components/ui/`

**Exports / Functions:**
- `create*` prefix for factories: `createWordPressModule`, `createWordPressPrimitiveHandlers`, `createWordPressWidgetChatTool`
- `register*` prefix for side-effectful registration: `registerWordPressPrimitives`, `registerWordPressConnector`
- `get*` prefix for DI accessors: `getWordPressDeps`
- `*Action` suffix for Next.js server actions: `deleteWordPressInstanceAction`
- `*Schema` suffix for Zod schemas: `createDraftSchema`, `postUpdateSchema`

**MCP Tool Names:**
- Snake-case with `wordpress_` prefix: `wordpress_post_update`, `wordpress_content_editor_run`

## Where to Add New Code

**New MCP tool:**
1. Add Zod input schema to `src/mcp/handlers.ts` (export it)
2. Add handler function inside `createWordPressPrimitiveHandlers()` return object in `src/mcp/handlers.ts`
3. Add entry to `TOOL_META` in `src/mcp/registry.ts` with description + inputSchema
4. If it should be exposed over HTTP MCP transport, add the tool name to `cinatra/mcp.json` `primitives` array
5. Add tests in `src/__tests__/`

**New host-provided capability (new dep):**
1. Add method to `WordPressConnectorDeps` interface in `src/deps.ts`
2. Call `getWordPressDeps().newMethod(...)` in the handler
3. Host calls `registerWordPressConnector({ ..., newMethod })` at boot

**New UI component (primitive):**
- Implementation: `src/components/ui/<component-name>.tsx`

**New admin page section:**
- Extend `src/settings-page.tsx`; server actions go in `src/setup-actions.ts`

**New agent skill:**
- Add subdirectory under `skills/` with a `SKILL.md`

## Special Directories

**`.planning/`:**
- Purpose: GSD planning documents
- Generated: No (human/agent authored)
- Committed: Yes (planning artifacts)

**`.github/`:**
- Purpose: CI/CD workflow definitions
- Generated: No
- Committed: Yes

---

*Structure analysis: 2026-06-09*
