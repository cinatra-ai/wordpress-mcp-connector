import { describe, expect, it, vi, beforeEach } from "vitest";

// S5 delegated-widget OBO reconstruction (cinatra S5-W1 §5 G3/G4) — the
// CONNECTOR-side subset of the T1-T8 negative-test contract.
//
// `wordpress_content_editor_run` reads the trusted `public_site_widget`
// delegated actor the host derives from the MCP request frame (the
// `resolveWidgetActor` deps seam — NEVER tool input). When present it must:
//   (a) FAIL-CLOSED assert the tool-arg instanceId === the actor's server-pinned
//       instance (`instance_pin_mismatch`);
//   (b) build actorOverride {runBy, orgId, instanceId, sourceType:
//       "public_site_widget"} and thread it into dispatchContentEditor;
//   (c) on a widget delegation MISSING the pinned fields, THROW (no dispatch);
//   (d) on the normal (non-widget) path, dispatch byte-identically to today
//       (no actorOverride key).

import { createWordPressPrimitiveHandlers } from "@cinatra-ai/wordpress-mcp-connector/mcp-handlers";
import {
  registerWordPressConnector,
  _resetWordPressDepsForTests,
  type WidgetActorContext,
} from "../deps";

const dispatchContentEditorMock = vi.fn(
  async (_input: {
    agentUrl: string;
    payload: unknown;
    timeoutMs: number;
    actorOverride?: unknown;
  }) => '{"postId":"14","changes":[]}',
);

function registerStubDeps(resolveWidgetActor?: () => WidgetActorContext | null) {
  registerWordPressConnector({
    decodeCursor: () => 0,
    buildListPage: (items, total) => ({ items, total }),
    dispatchContentEditor: dispatchContentEditorMock,
    ...(resolveWidgetActor ? { resolveWidgetActor } : {}),
    deleteInstance: vi.fn(async () => {}),
    listMcpInstances: () => [],
    probeMcpAdapter: async () => "registered" as const,
    resolveMcpServerUrl: (siteUrl: string) => siteUrl,
    isPrivateUrl: () => false,
    getApiStatus: () => ({ status: "not_connected" as const, detail: "" }),
    buildWordPressBasicAuthHeader: vi.fn(async () => ({ Authorization: "Basic test" })),
    createDraft: vi.fn(),
    readPostStatus: vi.fn(),
    listPublishedPosts: vi.fn(async () => ({ items: [], total: 0 })),
    listPublishedPages: vi.fn(async () => ({ items: [], total: 0 })),
    deletePost: vi.fn(async () => ({ deleted: true })),
    uploadMedia: vi.fn(),
    updateDraftMeta: vi.fn(),
    requireInstanceWriteAuthority: vi.fn(async () => {}),
  });
}

const WIDGET_ACTOR: WidgetActorContext = {
  delegation: "public_site_widget",
  runBy: "user-77",
  orgId: "org-9",
  instanceId: "site-1",
};

function callRun(input: Record<string, unknown>) {
  const handlers = createWordPressPrimitiveHandlers();
  return (handlers as any).wordpress_content_editor_run({
    primitiveName: "wordpress_content_editor_run",
    input,
    actor: { actorType: "model", source: "agent" },
    mode: "agentic",
  });
}

describe("wordpress_content_editor_run — S5 delegated-widget OBO", () => {
  beforeEach(() => {
    _resetWordPressDepsForTests();
    dispatchContentEditorMock.mockReset();
    dispatchContentEditorMock.mockResolvedValue('{"postId":"14","changes":[]}');
  });

  it("widget path: builds the pinned actorOverride and threads it into dispatch", async () => {
    registerStubDeps(() => WIDGET_ACTOR);
    await callRun({ instanceId: "site-1", postId: 14, instructions: "Update title" });

    expect(dispatchContentEditorMock).toHaveBeenCalledTimes(1);
    const arg = dispatchContentEditorMock.mock.calls[0][0];
    expect(arg.actorOverride).toEqual({
      runBy: "user-77",
      orgId: "org-9",
      instanceId: "site-1",
      sourceType: "public_site_widget",
    });
  });

  it("instance pin (G3): tool-arg instanceId != pinned instance → instance_pin_mismatch, no dispatch", async () => {
    registerStubDeps(() => ({ ...WIDGET_ACTOR, instanceId: "site-1" }));
    await expect(
      callRun({ instanceId: "site-EVIL", postId: 14, instructions: "x" }),
    ).rejects.toThrow(/instance_pin_mismatch/);
    expect(dispatchContentEditorMock).not.toHaveBeenCalled();
  });

  it("missing override fields on a widget call → fail-closed throw, no dispatch", async () => {
    registerStubDeps(() => ({ ...WIDGET_ACTOR, runBy: "" }));
    await expect(
      callRun({ instanceId: "site-1", postId: 14, instructions: "x" }),
    ).rejects.toThrow(/missing the pinned actor fields/);
    expect(dispatchContentEditorMock).not.toHaveBeenCalled();
  });

  it("non-widget path (resolver returns null): dispatch carries NO actorOverride", async () => {
    registerStubDeps(() => null);
    await callRun({ instanceId: "site-1", postId: 14, instructions: "x" });

    expect(dispatchContentEditorMock).toHaveBeenCalledTimes(1);
    const arg = dispatchContentEditorMock.mock.calls[0][0];
    expect("actorOverride" in arg).toBe(false);
  });

  it("skew (resolver unbound): dispatch carries NO actorOverride (byte-identical)", async () => {
    registerStubDeps(); // no resolveWidgetActor bound
    await callRun({ instanceId: "site-1", postId: 14, instructions: "x" });

    expect(dispatchContentEditorMock).toHaveBeenCalledTimes(1);
    const arg = dispatchContentEditorMock.mock.calls[0][0];
    expect("actorOverride" in arg).toBe(false);
  });
});
