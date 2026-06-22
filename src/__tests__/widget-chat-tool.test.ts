import { describe, expect, it, vi, beforeEach } from "vitest";

// createWordPressWidgetChatTool factory tests.
//
// Behavior contract:
//   W1: Returned LlmFunctionTool has the expected shape — name, required, description.
//   W2: Security override — LLM-supplied instanceId/postId are dropped; context wins.
//   W3: instructions string is passed through unchanged.
//   W4: Missing context fields default to "" (no undefined leakage).
//   W5: Handler return shape { postId, changes } passes back from execute() unchanged.

import { createWordPressWidgetChatTool } from "../widget-chat-tool";
import {
  registerWordPressConnector,
  _resetWordPressDepsForTests,
} from "../deps";

// The content-editor A2A dispatch lives HOST-SIDE behind
// `getWordPressDeps().dispatchContentEditor`; it receives `{ agentUrl, payload,
// timeoutMs }` and returns the agent reply TEXT. The widget tool drives the
// connector handler, so we assert on the `payload` passed to the dispatch.
const dispatchContentEditorMock = vi.fn(
  async (_input: { agentUrl: string; payload: unknown; timeoutMs: number }) => "",
);

function registerStubDeps() {
  registerWordPressConnector({
    decodeCursor: () => 0,
    buildListPage: (items, total) => ({ items, total }),
    dispatchContentEditor: dispatchContentEditorMock,
    deleteInstance: vi.fn(async () => {}),
    // External-MCP toolbox surfaces (unused by this suite's code paths).
    listMcpInstances: () => [],
    probeMcpAdapter: async () => "registered" as const,
    resolveMcpServerUrl: (siteUrl: string) => siteUrl,
    isPrivateUrl: () => false,
    // Connection/instance-admin + content surface (cinatra#172 Stage H3 —
    // unused by this suite's code paths).
    getApiStatus: () => ({ status: "not_connected" as const, detail: "" }),
    createDraft: vi.fn(),
    readPost: vi.fn(),
    readPostStatus: vi.fn(),
    listPublishedPosts: vi.fn(async () => ({ items: [], total: 0 })),
    deletePost: vi.fn(async () => ({ deleted: true })),
    uploadMedia: vi.fn(),
    updateDraftMeta: vi.fn(),
    updatePost: vi.fn(),
    // cinatra#409 write-authority gate — the widget tool drives the
    // wordpress_content_editor_run RELAY (a DISPATCH, not a direct writer), so
    // this gate is unused on this suite's code path.
    requireInstanceWriteAuthority: vi.fn(async () => {}),
  });
}

function extractDispatchedInput(mockCall: any): Record<string, unknown> {
  // dispatchContentEditor receives `{ agentUrl, payload, timeoutMs }`; the
  // validated handler input is `payload`.
  return mockCall.payload as Record<string, unknown>;
}

describe("createWordPressWidgetChatTool", () => {
  beforeEach(() => {
    _resetWordPressDepsForTests();
    registerStubDeps();
    dispatchContentEditorMock.mockReset();
    dispatchContentEditorMock.mockResolvedValue(
      '{"postId":24,"changes":[{"field":"post_title","before":"a","after":"b"}]}',
    );
  });

  it("W1: returns an LlmFunctionTool with the expected shape", () => {
    const tool = createWordPressWidgetChatTool({ context: { instanceId: "wp-1", postId: "7" } });
    expect(tool.name).toBe("wordpress_content_editor_run");
    expect(tool.parameters.required).toEqual(["instructions"]);
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.description).toMatch(/postId/);
    expect(tool.description).toMatch(/changes/);
  });

  it("W2: forcibly overrides LLM-supplied instanceId and postId with context values", async () => {
    const tool = createWordPressWidgetChatTool({
      context: { instanceId: "wp-1", postId: "7", postType: "post", postStatus: "publish" },
    });
    await tool.execute({ instanceId: "ATTACKER", postId: "999", instructions: "rename it" });
    expect(dispatchContentEditorMock).toHaveBeenCalledTimes(1);
    const dispatched = extractDispatchedInput(dispatchContentEditorMock.mock.calls[0][0]);
    expect(dispatched.instanceId).toBe("wp-1");
    // The wrapper writes postId: String(context.postId ?? "") — i.e. "7" — but the
    // handler's zod schema (z.coerce.number()) coerces this to 7 (number) BEFORE
    // JSON.stringify into the dispatched envelope. So the dispatched value is 7,
    // not "7". Accept either string-7 or number-7 — what matters is value identity:
    // it MUST be the context's "7", never the attacker's "999".
    expect(dispatched.postId == 7).toBe(true);
    expect(dispatched.postId).not.toBe("999");
    expect(dispatched.postId).not.toBe(999);
    expect(dispatched.instanceId).not.toBe("ATTACKER");
  });

  it("W3: forwards the user instructions unchanged to the handler", async () => {
    const tool = createWordPressWidgetChatTool({ context: { instanceId: "wp-1", postId: "7" } });
    await tool.execute({ instructions: "change title to X" });
    const dispatched = extractDispatchedInput(dispatchContentEditorMock.mock.calls[0][0]);
    expect(dispatched.instructions).toBe("change title to X");
  });

  it("W4: defaults missing context fields to empty strings (no undefined leakage)", async () => {
    // The WP handler's zod schema requires instanceId.min(1) and postId positive integer.
    // When context is {} the wrapper produces input { instanceId: "", postId: "", ... }
    // — non-undefined empty strings. zod rejects with "too_small" / coerce-number-failure
    // messages (distinct from "received undefined" / "invalid_type"), proving the
    // override layer installed string defaults rather than letting undefined leak.
    const tool = createWordPressWidgetChatTool({ context: {} });
    let caught: unknown = null;
    try {
      await tool.execute({ instructions: "x" });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(dispatchContentEditorMock).not.toHaveBeenCalled();
    const message = caught instanceof Error ? caught.message : String(caught);
    // Negative: must NOT be a "received undefined" / generic invalid_type leak —
    // those would indicate undefined leaked through the override layer.
    expect(message.toLowerCase()).not.toMatch(/received undefined/);
    // Positive: either instanceId hits "too_small" (string len 0 from "") or postId
    // hits a coerce failure (z.coerce.number() of "" → 0, then .positive() fails).
    // Both prove a STRING was passed instead of undefined.
    expect(message).toMatch(/too_small|>=1 characters|too small|positive|greater than 0/i);
  });

  it("W5: returns the handler result unchanged", async () => {
    const tool = createWordPressWidgetChatTool({ context: { instanceId: "wp-1", postId: "7" } });
    const result = (await tool.execute({ instructions: "x" })) as { postId: number; changes: unknown[] };
    expect(result.postId).toBe(24);
    expect(result.changes).toEqual([{ field: "post_title", before: "a", after: "b" }]);
  });
});
