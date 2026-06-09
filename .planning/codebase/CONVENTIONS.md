# Coding Conventions

**Analysis Date:** 2026-06-09

## Naming Patterns

**Files:**
- `kebab-case.ts` / `kebab-case.tsx` for all source files: `src/mcp/handlers.ts`, `src/widget-chat-tool.ts`, `src/setup-actions.ts`, `src/wordpress-nango-connect-card.tsx`
- Test files mirror source names under `src/__tests__/`: `handlers.test.ts`, `widget-chat-tool.test.ts`, `content-editor-run.test.ts`
- Component UI files match their component name in kebab-case: `src/components/ui/input-group.tsx`, `src/components/ui/badge.tsx`

**Functions:**
- `camelCase` for all functions: `createWordPressPrimitiveHandlers`, `registerWordPressConnector`, `getWordPressDeps`, `stripCodeFences`
- Factory functions prefixed with `create`: `createWordPressPrimitiveHandlers()`, `createWordPressWidgetChatTool()`
- Getter functions prefixed with `get`: `getWordPressDeps()`
- Registration functions prefixed with `register`: `registerWordPressConnector()`
- Test-only resets prefixed with `_reset` and suffixed with `ForTests`: `_resetWordPressDepsForTests()`

**Variables:**
- `camelCase` for local variables and parameters
- Mock variables suffixed with `Mock`: `dispatchContentEditorMock`, `updateWordPressPostMock`, `listWordPressInstancesMock`
- Constants in `SCREAMING_SNAKE_CASE` for env vars and symbols: `WP_CONTENT_EDITOR_A2A_URL`, `WORDPRESS_DEPS_KEY`

**Types / Interfaces:**
- `PascalCase` interfaces: `WordPressConnectorDeps`, `DispatchContentEditorInput`, `ListPage<T>`
- Type aliases in `PascalCase`: `DepsHolder`
- Zod schemas named with `Schema` suffix in `camelCase`: `instanceIdSchema`, `contentEditorRunSchema`, `postUpdateSchema`

## Code Style

**Formatting:**
- No Prettier or ESLint config detected in the repo root. Formatting is inferred from source files.
- 2-space indentation throughout TypeScript/TSX files
- Trailing commas in multi-line function arguments and object literals
- Single quotes for string literals; template literals used for interpolation
- Semicolons omitted in most places (inferred from `verbatimModuleSyntax` + bundler module resolution)

**TypeScript:**
- `strict: true` in `tsconfig.json` with `noImplicitAny: false` (allows gradual typing)
- `verbatimModuleSyntax: true` — `import type` used for type-only imports
- `isolatedModules: true` — each file must be independently compilable
- Target `ES2023`, module `ESNext`, `moduleResolution: bundler`
- Generics used for `ListPage<T>` and factory return types

## Import Organization

**Order (observed in `src/mcp/handlers.ts`, `src/deps.ts`):**
1. External packages (`zod`, `@cinatra-ai/sdk-extensions`)
2. Internal `@/lib/*` path-aliased imports (host-side utilities)
3. Local relative imports (`../deps`, `./handlers`)

**Path Aliases:**
- `@/` resolves to the host repo's `src/` directory (configured in `vitest.config.ts` via alias)
- Package self-reference via `@cinatra-ai/wordpress-mcp-connector/mcp-handlers` and `@cinatra-ai/wordpress-mcp-connector/widget-chat-tool` — resolved to `src/mcp/handlers.ts` and `src/widget-chat-tool.ts` in vitest config

## Error Handling

**Patterns:**
- Zod schema `.parse()` / `.parseAsync()` used for input validation — throws `ZodError` on invalid input; tests assert `.rejects.toThrow()` for schema violations
- Explicit runtime `throw new Error(...)` for business invariant violations (e.g., all meta values empty, deps not registered)
- Error messages are lowercase with regex-matchable phrases: `"all submitted meta values were empty"`, `"host runtime deps not registered"`
- No custom Error subclasses detected; plain `Error` objects throughout
- Async handlers reject with `ZodError` or `Error` — callers expected to catch

## Dependency Injection

**Pattern:**
- Host-side deps wired via `globalThis` Symbol singleton (see `src/deps.ts`)
- Symbol namespaced and versioned: `Symbol.for("@cinatra-ai/wordpress-mcp-connector:host-deps/v1")`
- `registerWordPressConnector(deps)` called once at boot; tests call `_resetWordPressDepsForTests()` in `beforeEach` and re-register stubs
- DI exists to prevent connector code from importing host-owned packages (`@cinatra-ai/a2a`, `@cinatra-ai/llm`)

## Zod Schema Conventions

**Patterns observed in `src/mcp/handlers.ts`:**
- Schemas exported as `const` named exports (e.g., `export const contentEditorRunSchema`)
- `z.coerce.number()` used when callers (widgets) may send string IDs
- `.describe()` on fields that need LLM-facing documentation
- `.refine()` for cross-field validation (e.g., at least one editable field present)
- `.default()` used for optional fields with known defaults (`postType`, `postStatus`, `excerpt`)

## Comments

**When to Comment:**
- Block comments above functions/types explain non-obvious design decisions, DI rationale, and host-vs-connector boundaries
- Inline comments explain Zod coercion edge cases, security overrides, and regex behavior
- Test files use numbered contract comments: `// W1:`, `// W2:` etc. to document the behavioral contract being tested
- `// ---------------------------------------------------------------------------` dividers separate describe blocks in test files
- `@internal` JSDoc tag used for test-only exports: `/** @internal test-only. */`

## Module Design

**Exports:**
- Named exports only — no default exports detected
- Public API surface is narrow: `createWordPressPrimitiveHandlers`, `createWordPressWidgetChatTool`, `registerWordPressConnector`, `getWordPressDeps`, `_resetWordPressDepsForTests`
- Zod schemas exported for host-side reuse

**Barrel Files:**
- `src/index.ts` serves as the package entry point (`"main": "./src/index.ts"` in `package.json`)
- `src/mcp/module.ts` and `src/mcp/registry.ts` provide MCP-specific aggregation

## Security

**Pattern:**
- Widget tool (`src/widget-chat-tool.ts`) forcibly overrides LLM-supplied `instanceId` and `postId` with server-side context values — documented as a security contract (test W2)
- Context always wins over user/LLM input for security-sensitive identifiers

---

*Convention analysis: 2026-06-09*
