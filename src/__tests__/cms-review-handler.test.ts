import { describe, expect, it, vi, beforeEach } from "vitest";

import { createWordPressPrimitiveHandlers } from "@cinatra-ai/wordpress-mcp-connector/mcp-handlers";
import {
  registerWordPressConnector,
  _resetWordPressDepsForTests,
  type WordPressConnectorDeps,
  type WordPressMcpInstance,
  type CmsReviewSeam,
} from "../deps";

// The in-admin get/update reroute to the MCP client (cinatra#1214 S1) — mocked so
// these handler tests assert the MCP tool calls, not a live transport.
vi.mock("../lib/wordpress-mcp-client", () => ({
  callWordPressMcp: vi.fn(),
  CINATRA_POST_GET_TOOL: "cinatra-post-get",
  CINATRA_POST_UPDATE_TOOL: "cinatra-post-update",
  CINATRA_POST_STATUS_TOOL: "cinatra-post-status",
  CINATRA_POSTS_LIST_TOOL: "cinatra-posts-list",
  CINATRA_POST_DELETE_TOOL: "cinatra-post-delete",
  CINATRA_MEDIA_UPLOAD_TOOL: "cinatra-media-upload",
  CINATRA_POST_CREATE_DRAFT_TOOL: "cinatra-post-create-draft",
  CINATRA_POST_UPDATE_META_TOOL: "cinatra-post-update-meta",
}));
import { callWordPressMcp } from "../lib/wordpress-mcp-client";

const listMcpInstancesMock = vi.fn((): WordPressMcpInstance[] => [
  {
    id: "site-1",
    siteUrl: "https://example.com",
    username: "u",
    applicationPassword: "p",
    name: "Site 1",
    createdAt: "",
    updatedAt: "",
  },
]);

function registerStubDeps(extra: Partial<WordPressConnectorDeps> = {}) {
  registerWordPressConnector({
    decodeCursor: (cursor?: string) => (cursor ? Number(cursor) || 0 : 0),
    buildListPage: (items, total, offset, limit) => ({ items, total }),
    dispatchContentEditor: vi.fn(async () => "{}"),
    deleteInstance: vi.fn(async () => {}),
    listMcpInstances: listMcpInstancesMock,
    probeMcpAdapter: async () => "registered" as const,
    resolveMcpServerUrl: (siteUrl: string) => siteUrl,
    isPrivateUrl: () => false,
    getApiStatus: vi.fn(() => ({ status: "not_connected" as const, detail: "" })),
    buildWordPressBasicAuthHeader: vi.fn(async () => ({ Authorization: "Basic test" })),
    createDraft: vi.fn(),
    readPostStatus: vi.fn(),
    listPublishedPosts: vi.fn(async () => ({ items: [], total: 0 })),
    listPublishedPages: vi.fn(async () => ({ items: [], total: 0 })),
    deletePost: vi.fn(async () => ({ deleted: true })),
    uploadMedia: vi.fn(),
    updateDraftMeta: vi.fn(),
    requireInstanceWriteAuthority: vi.fn(async () => {}),
    ...extra,
  });
}

/** Route the single callWordPressMcp mock by tool name: cinatra-post-get returns
 * the current post; cinatra-post-update echoes an applied post. */
function routeMcpByTool(current: Record<string, unknown>) {
  vi.mocked(callWordPressMcp).mockImplementation(async (_instance, tool, args) => {
    if (tool === "cinatra-post-get") {
      return { id: 42, status: "publish", title: "Old title", content: "<p>Old body</p>", excerpt: "old", ...current };
    }
    // cinatra-post-update echoes the applied fields back.
    return { id: 42, status: "publish", ...(args as Record<string, unknown>) };
  });
}

function makeSeam(overrides: Partial<CmsReviewSeam> = {}): CmsReviewSeam {
  return {
    isReviewActive: () => true,
    captureStagedWrite: vi.fn(async (input) => ({
      artifactId: "art-1",
      snapshotRevisionId: "rev-1",
      snapshotTargetId: "tgt-1",
      operationId: input.operationId,
      producedEventId: "evt-1",
    })),
    resolveDisposition: vi.fn(async () => ({ disposition: "held" as const, gate: { gateId: "gate-1", runId: "run-1" } })),
    recordApplyVerification: vi.fn(async () => ({ ok: true, outcome: "verified" as const })),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetWordPressDepsForTests();
});

describe("wordpress_post_update — S5 review trigger", () => {
  it("FENCE OFF (no cmsReview seam): byte-identical — applies via cinatra-post-update, no capture", async () => {
    registerStubDeps(); // cmsReview unbound
    routeMcpByTool({});
    const handlers = createWordPressPrimitiveHandlers();
    const res = (await (handlers as any).wordpress_post_update({
      primitiveName: "wordpress_post_update",
      input: { instanceId: "site-1", postId: 42, title: "New title" },
    })) as Record<string, unknown>;
    // The write reached WordPress (the update tool was called).
    const updateCalls = vi.mocked(callWordPressMcp).mock.calls.filter((c) => c[1] === "cinatra-post-update");
    expect(updateCalls).toHaveLength(1);
    expect((res as any).status).not.toBe("pending_review");
  });

  it("FENCE OFF (seam bound, isReviewActive false): byte-identical, no get/capture", async () => {
    const seam = makeSeam({ isReviewActive: () => false });
    registerStubDeps({ cmsReview: seam });
    routeMcpByTool({});
    const handlers = createWordPressPrimitiveHandlers();
    await (handlers as any).wordpress_post_update({
      primitiveName: "wordpress_post_update",
      input: { instanceId: "site-1", postId: 42, title: "New title" },
    });
    // No pre-write current fetch (byte-identical hot path).
    const getCalls = vi.mocked(callWordPressMcp).mock.calls.filter((c) => c[1] === "cinatra-post-get");
    expect(getCalls).toHaveLength(0);
    expect(seam.captureStagedWrite).not.toHaveBeenCalled();
    const updateCalls = vi.mocked(callWordPressMcp).mock.calls.filter((c) => c[1] === "cinatra-post-update");
    expect(updateCalls).toHaveLength(1);
  });

  it("FENCE ON, gate held: captures the proposed content + manifest and HOLDS — WordPress unchanged", async () => {
    const seam = makeSeam();
    registerStubDeps({ cmsReview: seam });
    routeMcpByTool({});
    const handlers = createWordPressPrimitiveHandlers();
    const res = (await (handlers as any).wordpress_post_update({
      primitiveName: "wordpress_post_update",
      input: { instanceId: "site-1", postId: 42, title: "New title", content: "<p>New body</p>" },
    })) as Record<string, unknown>;
    // Held descriptor returned; the effect is NOT applied.
    expect((res as any).status).toBe("pending_review");
    expect((res as any).applied).toBe(false);
    // The capture got the proposed content + the changed-paths scope manifest.
    expect(seam.captureStagedWrite).toHaveBeenCalledTimes(1);
    const capArg = vi.mocked(seam.captureStagedWrite).mock.calls[0]![0];
    expect(capArg.scopeManifest.paths).toEqual(["title", "content"]);
    expect(capArg.resolved.text).toContain("New title");
    // CRITICAL: the update tool was NEVER called — WordPress content unchanged.
    const updateCalls = vi.mocked(callWordPressMcp).mock.calls.filter((c) => c[1] === "cinatra-post-update");
    expect(updateCalls).toHaveLength(0);
  });

  it("FENCE ON, gate approved: applies the write AND records read-back verification", async () => {
    const seam = makeSeam({
      resolveDisposition: vi.fn(async () => ({ disposition: "approved" as const, gate: { gateId: "gate-1", runId: "run-1" } })),
    });
    registerStubDeps({ cmsReview: seam });
    routeMcpByTool({});
    const handlers = createWordPressPrimitiveHandlers();
    const res = (await (handlers as any).wordpress_post_update({
      primitiveName: "wordpress_post_update",
      input: { instanceId: "site-1", postId: 42, title: "New title" },
    })) as Record<string, unknown>;
    // The write reached WordPress.
    const updateCalls = vi.mocked(callWordPressMcp).mock.calls.filter((c) => c[1] === "cinatra-post-update");
    expect(updateCalls).toHaveLength(1);
    // Read-back verification recorded.
    expect(seam.recordApplyVerification).toHaveBeenCalledTimes(1);
    expect((res as any).review).toBeDefined();
    expect((res as any).review.outcome).toBe("verified");
  });

  it("FENCE ON, gate rejected: refuses — the write never reaches WordPress", async () => {
    const seam = makeSeam({
      resolveDisposition: vi.fn(async () => ({ disposition: "rejected" as const, gate: { gateId: "gate-1", runId: "run-1" } })),
    });
    registerStubDeps({ cmsReview: seam });
    routeMcpByTool({});
    const handlers = createWordPressPrimitiveHandlers();
    await expect(
      (handlers as any).wordpress_post_update({
        primitiveName: "wordpress_post_update",
        input: { instanceId: "site-1", postId: 42, title: "New title" },
      }),
    ).rejects.toThrow(/rejected/i);
    const updateCalls = vi.mocked(callWordPressMcp).mock.calls.filter((c) => c[1] === "cinatra-post-update");
    expect(updateCalls).toHaveLength(0);
  });
});
