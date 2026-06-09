# Testing Patterns

**Analysis Date:** 2026-06-09

## Test Framework

**Runner:**
- Vitest (version from `package.json` devDependencies — not pinned, resolved by host monorepo)
- Config: `vitest.config.ts` at repo root

**Assertion Library:**
- Vitest built-in (`expect`) — no separate chai or jest-expect import

**Run Commands:**
```bash
npm test          # Run all tests (vitest)
npx vitest        # Direct vitest invocation
npx vitest --run  # Single-pass (CI mode)
```

## Test File Organization

**Location:**
- All tests co-located under `src/__tests__/` (separate from source, within `src/`)

**Naming:**
- `<feature>.test.ts` pattern: `handlers.test.ts`, `widget-chat-tool.test.ts`, `content-editor-run.test.ts`

**Structure:**
```
src/
  __tests__/
    handlers.test.ts              # MCP primitive handler behavioral tests
    content-editor-run.test.ts    # content_editor_run dispatch-reply handling
    widget-chat-tool.test.ts      # Widget chat tool factory + security contract
```

## Test Structure

**Suite Organization:**
```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";

describe("feature_name", () => {
  let handlers: ReturnType<typeof createWordPressPrimitiveHandlers>;

  beforeEach(() => {
    _resetWordPressDepsForTests();
    registerStubDeps();
    handlers = createWordPressPrimitiveHandlers();
    someMock.mockReset();
  });

  it("describes the behavior contract", async () => {
    // arrange, act, assert
  });
});
```

**Patterns:**
- `beforeEach` resets DI deps and re-registers stubs before every test
- `mockReset()` called on each mock in `beforeEach` to prevent cross-test contamination
- Tests access handler functions via `(handlers as any).handler_name(...)` because handlers are keyed by string — the `as any` cast is intentional and documented
- Behavioral contracts in `widget-chat-tool.test.ts` are labeled `W1`–`W5` with comments

## Mocking

**Framework:** Vitest `vi.mock`, `vi.fn`, `vi.hoisted`

**Patterns:**
```typescript
// Hoisted stubs — created before vi.mock factories run
const { dispatchContentEditorMock } = vi.hoisted(() => ({
  dispatchContentEditorMock: vi.fn(
    async (_input: { agentUrl: string; payload: unknown; timeoutMs: number }) => "{}",
  ),
}));

// Module-level mock replacing the entire module
vi.mock("@/lib/wordpress-api", () => ({
  listWordPressInstances: listWordPressInstancesMock,
  updateWordPressPost: updateWordPressPostMock,
  // ... all named exports mocked explicitly
}));
```

**`vi.hoisted` usage:**
- Used when mock factories need to close over stub `vi.fn()` references
- All stubs that mock factories reference MUST be created via `vi.hoisted` (Vitest hoisting rule)
- Pattern documented in `src/__tests__/handlers.test.ts` with an explanatory comment

**What to Mock:**
- All `@/lib/wordpress-api` functions (host-side DB/API — not available in connector test environment)
- `getWordPressDeps()` indirectly via `registerWordPressConnector` stub registration
- The `dispatchContentEditor` dep injected via `registerStubDeps()` helper

**What NOT to Mock:**
- Connector handler logic itself (tested end-to-end through `createWordPressPrimitiveHandlers()`)
- Zod schemas (validated through real handler invocation)

## Dependency Injection in Tests

**Pattern:**
```typescript
function registerStubDeps() {
  registerWordPressConnector({
    decodeCursor: (cursor?: string) => (cursor ? Number(cursor) || 0 : 0),
    buildListPage: (items, total, offset, limit) => ({
      items,
      total,
      nextCursor: offset + limit < total ? String(offset + limit) : undefined,
    }),
    dispatchContentEditor: dispatchContentEditorMock,
    deleteInstance: vi.fn(async () => {}),
  });
}
```
- `_resetWordPressDepsForTests()` clears the `globalThis` Symbol slot
- `registerStubDeps()` is a local helper defined per test file to wire fresh stubs
- Tests can override specific mock return values using `mockResolvedValue` after registration

## Vitest Config Specifics

**Config file:** `vitest.config.ts`

**Key settings:**
- `test.environment: "node"` — no jsdom, pure Node
- `test.include: ["src/__tests__/**/*.test.ts"]`
- `test.exclude: ["**/node_modules/**"]`

**Aliases configured for test resolution:**
- `server-only` → stub at `tests/__stubs__/server-only.ts` (in host monorepo root)
- `@cinatra-ai/wordpress-mcp-connector/mcp-handlers` → `src/mcp/handlers.ts`
- `@cinatra-ai/wordpress-mcp-connector/widget-chat-tool` → `src/widget-chat-tool.ts`
- `@/` → host monorepo `src/` directory (resolves host-side `@/lib/wordpress-api` etc.)

Note: Tests depend on host monorepo paths (`../../..` from repo root to find stubs and `@/` aliases). The test suite is designed to run from within the monorepo context, not standalone.

## Fixtures and Factories

**Test Data:**
```typescript
// Inline factory returning a minimal WordPress instance object
listWordPressInstancesMock.mockResolvedValue([{
  id: "site-1",
  siteUrl: "https://example.com",
  username: "u",
  applicationPassword: "p",
  name: "Site 1",
  createdAt: "",
  updatedAt: "",
}]);
```

**Location:**
- No separate fixture files — all test data defined inline within `beforeEach` or `mockResolvedValue` calls
- `dispatchContentEditorMock.mockResolvedValue(...)` used to inject specific JSON payloads per test

## Coverage

**Requirements:** Not enforced — no `coverage` threshold configuration detected in `vitest.config.ts`

**View Coverage:**
```bash
npx vitest --coverage
```

## Test Types

**Unit Tests:**
- Handler behavior: Zod schema validation, input coercion, field routing, guard conditions
- Widget tool factory: shape contract, security override, default behavior

**Integration Tests:**
- Handler-to-dep boundary: tests call real `createWordPressPrimitiveHandlers()` with stub deps, exercising the full handler path through DI resolution

**E2E Tests:**
- Not used in this package

## Common Patterns

**Async Testing:**
```typescript
it("dispatches with correct agentUrl", async () => {
  await (handlers as any).wordpress_content_editor_run({
    primitiveName: "wordpress_content_editor_run",
    input: { instanceId: "site-1", postId: 10, instructions: "edit" },
    actor: { actorType: "model", source: "agent" },
    mode: "agentic",
  });
  expect(dispatchContentEditorMock).toHaveBeenCalledWith(
    expect.objectContaining({ agentUrl: "http://localhost:3021" }),
  );
});
```

**Error Testing:**
```typescript
it("rejects invalid input via zod schema", async () => {
  await expect(
    (handlers as any).wordpress_post_update({
      primitiveName: "wordpress_post_update",
      input: { instanceId: "", postId: 10, title: "X" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    }),
  ).rejects.toThrow();
});
```

**Negative Assertion Pattern (from `handlers.test.ts`):**
- Use `expect(call.meta).toEqual({ ... })` to pin the FULL shape, not just individual properties
- Combine with `expect(call.meta).not.toHaveProperty("key")` to explicitly assert filtered keys are absent
- This guards against accidental pass-through of filtered values

---

*Testing analysis: 2026-06-09*
